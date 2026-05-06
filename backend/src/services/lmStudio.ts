/**
 * LM Studio native API communication service.
 * Uses POST /api/v1/chat — the native LM Studio endpoint.
 * Handles image optimization, inference, and response extraction.
 */

import sharp from "sharp";
import type { LMStudioChatRequest, LMStudioChatResponse, LMStudioInputItem } from "../types";
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

/**
 * Optimizes an image for inference: resize + compress + convert to JPEG.
 * Returns a base64 data URL ready for the native API.
 */
async function optimizeImage(image: File): Promise<string> {
  const buffer = await image.arrayBuffer();

  // Validate magic bytes before processing
  if (!validateMagicBytes(buffer, image.type)) {
    throw new Error("File gambar tidak valid atau rusak. Header file tidak sesuai dengan tipe yang dideklarasikan.");
  }

  const optimized = await sharp(Buffer.from(buffer))
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
 */
function logInferenceStats(
  response: LMStudioChatResponse,
  totalDurationMs: number
): void {
  const { stats } = response;
  log.info("Inference complete", {
    totalDurationMs: totalDurationMs.toFixed(0),
    inputTokens: stats.input_tokens,
    outputTokens: stats.total_output_tokens,
    tokensPerSecond: stats.tokens_per_second.toFixed(1),
    timeToFirstToken: `${stats.time_to_first_token_seconds.toFixed(2)}s`,
    ...(stats.model_load_time_seconds !== undefined && {
      modelLoadTime: `${stats.model_load_time_seconds.toFixed(2)}s`,
    }),
  });
}

/**
 * Sends an image and assistive prompt to LM Studio for inference.
 * Uses the native REST API: POST /api/v1/chat
 *
 * @param image - The uploaded image file
 * @param prompt - The context-aware assistive prompt
 * @returns The AI-generated description string
 * @throws Error if LM Studio is unreachable, times out, or returns invalid data
 */
export async function analyzeImage(
  image: File,
  prompt: string
): Promise<string> {
  const startTime = performance.now();

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
      throw new Error(
        `Gagal mendapatkan respons dari AI (status ${response.status}).`
      );
    }

    // Step 4: Parse response
    const data = (await response.json()) as LMStudioChatResponse;
    const totalDurationMs = performance.now() - startTime;

    // Log performance stats
    if (data.stats) {
      logInferenceStats(data, totalDurationMs);
    }

    // Step 5: Extract content
    const content = extractResponseContent(data);
    if (!content) {
      log.warn("LM Studio returned empty content", {
        output: JSON.stringify(data.output).slice(0, 200),
      });
      return FALLBACK_RESPONSE;
    }

    return content;
  } catch (error) {
    const durationMs = performance.now() - startTime;

    // Timeout
    if (error instanceof DOMException && error.name === "AbortError") {
      log.error("Inference timed out", {
        timeoutMs: INFERENCE_TIMEOUT_MS,
        elapsedMs: durationMs.toFixed(0),
      });
      throw new Error(
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
      throw new Error(
        "Tidak dapat terhubung ke server AI. Pastikan LM Studio berjalan."
      );
    }

    // Re-throw known application errors
    if (error instanceof Error && error.message.startsWith("Gagal")) {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith("File gambar")) {
      throw error;
    }

    // Unexpected errors
    log.error("Unexpected inference error", {
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs.toFixed(0),
    });
    throw new Error(FALLBACK_RESPONSE);
  } finally {
    clearTimeout(timeoutId);
  }
}
