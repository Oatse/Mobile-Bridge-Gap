/**
 * Application constants and configuration.
 * Values can be overridden via environment variables.
 */

// ─── Server ─────────────────────────────────────────────────────────────────

/** Server port */
export const PORT = Number(process.env.PORT) || 3000;

// ─── LM Studio ──────────────────────────────────────────────────────────────

/** LM Studio API base URL */
export const LM_STUDIO_URL =
  process.env.LM_STUDIO_URL || "http://localhost:1234";

/** LM Studio model identifier (matches the `key` field from /api/v1/models) */
export const LM_STUDIO_MODEL =
  process.env.LM_STUDIO_MODEL || "gemma-4-e4b-it";

// ─── Inference ──────────────────────────────────────────────────────────────

/** Maximum request timeout for LM Studio inference (ms) */
export const INFERENCE_TIMEOUT_MS =
  Number(process.env.INFERENCE_TIMEOUT_MS) || 30_000;

/** Maximum tokens the model should generate — keep short for assistive responses */
export const MAX_OUTPUT_TOKENS =
  Number(process.env.MAX_OUTPUT_TOKENS) || 200;

/** Temperature for inference — lower = more deterministic, better for safety-critical output */
export const INFERENCE_TEMPERATURE = 0.2;

// ─── Image Processing ───────────────────────────────────────────────────────

/** Maximum allowed image size in bytes (5 MB) */
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

/** Target dimension for image resizing before inference */
export const IMAGE_MAX_DIMENSION =
  Number(process.env.IMAGE_MAX_DIMENSION) || 384;

/** JPEG compression quality for resized images (0-100) */
export const IMAGE_QUALITY = 80;

/** Allowed image MIME types */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** File signature magic bytes for image type verification */
export const IMAGE_MAGIC_BYTES: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": [0x52, 0x49, 0x46, 0x46], // "RIFF" header
};

// ─── Validation ─────────────────────────────────────────────────────────────

/** Maximum user command length */
export const MAX_COMMAND_LENGTH = 500;

/** Trigger keyword for voice commands */
export const TRIGGER_KEYWORD = "MBG";

/** Maximum request body size in bytes (6 MB — slightly above image limit for multipart overhead) */
export const MAX_BODY_SIZE_BYTES = 6 * 1024 * 1024;

// ─── Responses ──────────────────────────────────────────────────────────────

/** Fallback response when inference fails */
export const FALLBACK_RESPONSE =
  "Maaf, saya tidak dapat menganalisis gambar saat ini. Silakan coba lagi.";

// ─── System Prompt ──────────────────────────────────────────────────────────

/**
 * System prompt for the AI model.
 * English prompt yields better instruction-following from most vision models.
 * The model is instructed to respond in Indonesian.
 */
export const SYSTEM_PROMPT = `You are an assistive AI system for visually impaired users.

Your task:
- Describe nearby obstacles and objects
- Identify dangerous objects or hazards
- Identify nearby people and their position
- Describe safe walking directions

Rules:
- ALWAYS respond in Indonesian (Bahasa Indonesia)
- Keep responses to maximum 2 short sentences
- Prioritize safety-critical information first
- Use simple, clear language
- Describe object positions relative to the user (kiri, kanan, depan, belakang)
- DO NOT use artistic or aesthetic descriptions
- DO NOT describe colors, materials, or decorative details unless safety-relevant
- DO NOT mention that you are looking at an "image" — describe as if seeing directly
- DO NOT make assumptions about things not visible

Good example: "Terdapat kursi di depan Anda. Jalur kanan lebih aman untuk berjalan."
Bad example: "Terdapat ruangan modern dengan nuansa hangat dan pencahayaan estetik."`;

// ─── Depth Estimation ───────────────────────────────────────────────────────

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Master toggle for depth estimation — set to false to disable entirely */
export const ENABLE_DEPTH_ESTIMATION =
  (process.env.ENABLE_DEPTH_ESTIMATION ?? "true").trim().toLowerCase() !== "false";

/**
 * Depth model input resolution (square).
 * Lower = faster inference, potentially less spatial detail.
 * Benchmark results (warm avg): 518→2365ms, 384→1221ms, 256→542ms.
 * 256 chosen as default: 4.36x faster, negligible quality loss for assistive use.
 * Override via env: DEPTH_INPUT_SIZE=518 for full resolution.
 */
export const DEPTH_INPUT_SIZE =
  Number(process.env.DEPTH_INPUT_SIZE) || 256;

/** Toggle verbose depth debug logging (preprocessing, inference, region values) */
export const DEPTH_DEBUG_LOGGING =
  (process.env.DEPTH_DEBUG_LOGGING ?? "false").trim().toLowerCase() === "true";

/** Depth model identifier — matches the folder name under models/ */
export const DEPTH_MODEL_ID = "depth-anything-v2-small";

/** Absolute path to the models directory for local ONNX loading */
export const DEPTH_MODEL_PATH = resolve(__dirname, "..", "..", "models");

/** Maximum timeout for depth inference (ms) — safety net */
export const DEPTH_INFERENCE_TIMEOUT_MS =
  Number(process.env.DEPTH_INFERENCE_TIMEOUT_MS) || 10_000;

/**
 * Proximity thresholds for depth classification.
 * Values are normalized depth (0 = closest, 1 = farthest).
 * Objects with depth below the threshold are classified at that level.
 */
export const DEPTH_PROXIMITY_THRESHOLDS = {
  sangat_dekat: 0.25, // Very close — urgent obstacle warning
  dekat: 0.45,        // Close — nearby obstacle
  sedang: 0.70,       // Medium distance — awareness only
  // > 0.70 = "jauh" (far)
} as const;
