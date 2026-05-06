/**
 * LM Studio native API communication service.
 * Uses POST /api/v1/chat — the native LM Studio endpoint.
 * Handles image optimization, inference, and response extraction.
 */

import sharp from "sharp";
import type { LMStudioChatRequest, LMStudioChatResponse, LMStudioInputItem } from "../types";
import { InferenceError } from "../types";
import {
  LM_STUDIO_URL,
  LM_STUDIO_MODEL,
  INFERENCE_TIMEOUT_MS,
  SYSTEM_PROMPT,
  FALLBACK_RESPONSE,
  MAX_OUTPUT_TOKENS,
  INFERENCE_TEMPERATURE,
  IMAGE_MAX_DIMENSION,
  IMAGE_QUALITY,
} from "../utils/constants";
import { validateMagicBytes } from "../utils/validation";
import { log } from "../utils/logger";

// ─── Concurrency Lock ──────────────────────────────────────────────────────

/**
 * Lightweight inference semaphore.
 * Only one inference request is allowed at a time to prevent GPU OOM
 * and cascade-timeout on the single local LM Studio instance.
 */
let inferenceInProgress = false;

// ─── Image Processing ───────────────────────────────────────────────────────

/**
 * Optimizes an image for inference: resize + compress + convert to JPEG.
 * Returns a base64 data URL ready for the native API.
 * Uses sharp's pipeline to minimize intermediate buffer copies.
 */
async function optimizeImage(image: File): Promise<string> {
  const buffer = Buffer.from(await image.arrayBuffer());

  // Validate magic bytes before processing
  if (!validateMagicBytes(buffer.buffer, image.type)) {
    throw new InferenceError("File gambar tidak valid atau rusak. Header file tidak sesuai dengan tipe yang dideklarasikan.");
  }

  const optimized = await sharp(buffer)
    .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
      fit: "inside",         // Maintain aspect ratio, fit within bounds
      withoutEnlargement: true, // Don't upscale small images
    })
    .jpeg({ quality: IMAGE_QUALITY })
    .toBuffer();

  const base64 = optimized.toString("base64");

  log.info("Image optimized", {
    originalSize: `${(image.size / 1024).toFixed(0)}KB`,
    optimizedSize: `${(optimized.length / 1024).toFixed(0)}KB`,
    reduction: `${((1 - optimized.length / image.size) * 100).toFixed(0)}%`,
  });

  return `data:image/jpeg;base64,${base64}`;
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Validates that a parsed JSON object has the expected shape
 * of a LMStudioChatResponse. Returns false if structure is invalid.
 */
function isValidChatResponse(data: unknown): data is LMStudioChatResponse {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.output) && typeof obj.stats === "object" && obj.stats !== null;
}

/**
 * Extracts the text message content from a native API response.
 * Handles missing/empty output gracefully.
 */
function extractResponseContent(response: LMStudioChatResponse): string | null {
  if (!response.output || !Array.isArray(response.output)) {
    return null;
  }

  // Find the first message-type output item
  const messageItem = response.output.find((item) => item.type === "message");

  if (!messageItem || messageItem.type !== "message") {
    return null;
  }

  const content = messageItem.content?.trim();
  return content && content.length > 0 ? content : null;
}

/**
 * Logs inference performance stats from the native API response.
 * Guarded against null/undefined numeric fields to prevent crashes.
 */
function logInferenceStats(
  response: LMStudioChatResponse,
  totalDurationMs: number
): void {
  const { stats } = response;
  if (!stats) return;

  log.info("Inference complete", {
    totalDurationMs: totalDurationMs.toFixed(0),
    inputTokens: stats.input_tokens ?? 0,
    outputTokens: stats.total_output_tokens ?? 0,
    tokensPerSecond: typeof stats.tokens_per_second === "number"
      ? stats.tokens_per_second.toFixed(1)
      : "N/A",
    timeToFirstToken: typeof stats.time_to_first_token_seconds === "number"
      ? `${stats.time_to_first_token_seconds.toFixed(2)}s`
      : "N/A",
    ...(typeof stats.model_load_time_seconds === "number" && {
      modelLoadTime: `${stats.model_load_time_seconds.toFixed(2)}s`,
    }),
  });
}

// ─── Main Inference Function ────────────────────────────────────────────────

/**
 * Sends an image and assistive prompt to LM Studio for inference.
 * Uses the native REST API: POST /api/v1/chat
 *
 * Includes:
 * - Concurrency lock (1 request at a time)
 * - Image optimization before inference
 * - Timeout via AbortController
 * - Safe JSON parsing with shape validation
 * - Typed error handling via InferenceError
 *
 * @param image - The uploaded image file
 * @param prompt - The context-aware assistive prompt
 * @returns The AI-generated description string
 * @throws InferenceError for known application errors
 * @throws Error with FALLBACK_RESPONSE for unexpected failures
 */
export async function analyzeImage(
  image: File,
  prompt: string
): Promise<string> {
  // Concurrency guard — reject if another inference is already running
  if (inferenceInProgress) {
    throw new InferenceError(
      "Server sedang memproses permintaan lain. Silakan tunggu beberapa saat."
    );
  }

  inferenceInProgress = true;
  const startTime = performance.now();

  try {
    // Step 1: Optimize image
    const dataUrl = await optimizeImage(image);

    // Step 2: Build native API input
    const input: LMStudioInputItem[] = [
      { type: "text", content: prompt },
      { type: "image", data_url: dataUrl },
    ];

    const requestBody: LMStudioChatRequest = {
      model: LM_STUDIO_MODEL,
      input,
      system_prompt: SYSTEM_PROMPT,
      temperature: INFERENCE_TEMPERATURE,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false, // No need to store assistive chats
    };

    // Step 3: Send to LM Studio with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

    try {
      log.info("Sending inference request", {
        model: LM_STUDIO_MODEL,
        promptLength: prompt.length,
      });

      const response = await fetch(`${LM_STUDIO_URL}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        log.error("LM Studio returned error", {
          status: response.status,
          body: errorText.slice(0, 200),
        });
        throw new InferenceError(
          `Gagal mendapatkan respons dari AI (status ${response.status}).`
        );
      }

      // Step 4: Parse response — safely handle non-JSON responses
      let rawData: unknown;
      try {
        rawData = await response.json();
      } catch {
        log.error("LM Studio returned non-JSON response");
        throw new InferenceError(
          "Respons dari AI tidak dapat diproses. Format respons tidak valid."
        );
      }

      // Validate response shape before using
      if (!isValidChatResponse(rawData)) {
        log.error("LM Studio response has unexpected shape", {
          keys: typeof rawData === "object" && rawData !== null
            ? Object.keys(rawData).join(", ")
            : typeof rawData,
        });
        throw new InferenceError(
          "Respons dari AI memiliki format yang tidak dikenali."
        );
      }

      const data = rawData;
      const totalDurationMs = performance.now() - startTime;

      // Log performance stats (safe — guarded against null fields)
      logInferenceStats(data, totalDurationMs);

      // Step 5: Extract content
      const content = extractResponseContent(data);
      if (!content) {
        log.warn("LM Studio returned empty content", {
          outputTypes: data.output.map((item) => item.type).join(", "),
        });
        return FALLBACK_RESPONSE;
      }

      return content;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const durationMs = performance.now() - startTime;

    // Re-throw known InferenceErrors as-is
    if (error instanceof InferenceError) {
      log.error("Inference failed", {
        error: error.message,
        durationMs: durationMs.toFixed(0),
      });
      throw error;
    }

    // Timeout
    if (error instanceof DOMException && error.name === "AbortError") {
      log.error("Inference timed out", {
        timeoutMs: INFERENCE_TIMEOUT_MS,
        elapsedMs: durationMs.toFixed(0),
      });
      throw new InferenceError(
        "Inferensi AI melebihi batas waktu. Silakan coba lagi."
      );
    }

    // Connection failure
    if (
      error instanceof TypeError &&
      (error.message.includes("fetch") || error.message.includes("connect"))
    ) {
      log.error("Cannot connect to LM Studio", {
        url: LM_STUDIO_URL,
        error: error.message,
      });
      throw new InferenceError(
        "Tidak dapat terhubung ke server AI. Pastikan LM Studio berjalan."
      );
    }

    // Unexpected errors
    log.error("Unexpected inference error", {
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs.toFixed(0),
    });
    throw new Error(FALLBACK_RESPONSE);
  } finally {
    inferenceInProgress = false;
  }
}
