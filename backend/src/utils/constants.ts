/**
 * Application constants and configuration.
 * Values can be overridden via environment variables.
 */

// ─── Environment ────────────────────────────────────────────────────────────

/** Current environment mode */
export const NODE_ENV = process.env.NODE_ENV || "development";

/** Whether the server is running in production (tunnel) mode */
export const IS_PRODUCTION = NODE_ENV === "production";

// ─── Server ─────────────────────────────────────────────────────────────────

/** Server port */
export const PORT = Number(process.env.PORT) || 3000;

// ─── Security ───────────────────────────────────────────────────────────────

/**
 * API token for authenticating requests through the tunnel.
 * If empty, token authentication is disabled (local dev mode).
 * Set via API_TOKEN env var for production usage.
 */
export const API_TOKEN = process.env.API_TOKEN || "";

/** Public-facing production URL (used for CORS and logging) */
export const PRODUCTION_URL =
  process.env.PRODUCTION_URL || "https://api.mbridgegap.my.id";

// ─── Rate Limiting ──────────────────────────────────────────────────────────

/** Maximum requests per IP within the rate limit window */
export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30;

/** Rate limit sliding window duration (ms) */
export const RATE_LIMIT_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;

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
  Number(process.env.IMAGE_MAX_DIMENSION) || 512;

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
export const SYSTEM_PROMPT = `You are an assistive navigation AI for visually impaired users.

PRIMARY ROLE: Describe what you ACTUALLY SEE to help a person who cannot see navigate safely.

ENTITY PRIORITY (highest first):
1. PEOPLE — Always mention any person you see (child, adult, elderly). State their position and activity if visible. People are the MOST important entity for navigation awareness.
2. Floor-level hazards — objects on the floor, cables, stairs, holes, wet surfaces
3. Dangerous objects — sharp items, broken glass, exposed wires
4. Path-blocking obstacles — furniture, large objects in the walking path
5. Side obstacles — objects to the left or right
6. Scene context — only if path is clear and space remains

OBJECT NAMING:
- Name each entity by its SPECIFIC identity (e.g., kursi, meja, anak, tablet, boneka)
- Prefer specific names over generic categories
- If uncertain: "terlihat seperti [nama]"
- Do NOT list objects that are NOT visible
- Do NOT enumerate a checklist of possible objects

POSITION FORMAT:
- Use: di depan, di kiri, di kanan, di lantai depan, di jalur depan
- Include approximate distance when confident: "sekitar 1 meter di depan"

PATH SAFETY:
- End with path assessment: is the forward path clear or blocked?
- If blocked, suggest the safest direction

IGNORE completely:
- Aesthetic descriptions (pencahayaan, nuansa, gaya, dekorasi)
- Color/material details (unless safety-relevant: "lantai basah")
- Room atmosphere or decorative elements

Rules:
- ALWAYS respond in Indonesian (Bahasa Indonesia)
- Maximum 2 short sentences
- Prioritize safety-critical information first
- DO NOT mention "image", "gambar", or "foto"
- DO NOT use decorative language

Good: "Ada seorang anak menggunakan tablet di tempat tidur. Jalur depan relatif aman."
Good: "Terdapat kursi di jalur depan sekitar 1 meter. Sisi kanan lebih aman untuk dilewati."
Bad: "Tidak terlihat kursi, meja, lemari, sofa, rak, kipas, televisi, tas, sepatu, botol."
Bad: "Terdapat ruangan modern dengan nuansa hangat dan pencahayaan estetik."`;

// ─── Depth Estimation ───────────────────────────────────────────────────────

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Master toggle for depth estimation — set to false to disable entirely */
export const ENABLE_DEPTH_ESTIMATION =
  (process.env.ENABLE_DEPTH_ESTIMATION ?? "true").trim().toLowerCase() !== "false";

/**
 * Depth model input resolution (square).
 * The metric indoor model REQUIRES 518×518 input resolution.
 * Unlike the previous relative model, this DPT architecture has positional
 * embeddings that enforce specific tensor dimensions. Non-518 inputs cause
 * ONNX broadcast dimension errors at inference time.
 *
 * DO NOT override this value — it is an architectural constraint.
 */
export const DEPTH_INPUT_SIZE = 518;

/** Toggle verbose depth debug logging (preprocessing, inference, region values) */
export const DEPTH_DEBUG_LOGGING =
  (process.env.DEPTH_DEBUG_LOGGING ?? "false").trim().toLowerCase() === "true";

/** Depth model identifier — matches the folder name under models/ */
export const DEPTH_MODEL_ID = "Depth-Anything-V2-Metric-Indoor-Small-hf";

/** ONNX model filename inside the model directory */
export const DEPTH_ONNX_FILENAME = "depth_anything_v2_metric_indoor_small.onnx";

/** Absolute path to the models directory for local ONNX loading */
export const DEPTH_MODEL_PATH = resolve(__dirname, "..", "..", "models");

/** Maximum timeout for depth inference (ms) — safety net */
export const DEPTH_INFERENCE_TIMEOUT_MS =
  Number(process.env.DEPTH_INFERENCE_TIMEOUT_MS) || 10_000;

/**
 * Maximum depth range of the metric model (from config.json max_depth).
 * Values beyond this are clipped to max_depth by the model.
 */
export const DEPTH_MAX_DEPTH_M = 20;

/**
 * Proximity thresholds for depth classification.
 * Values are in METERS (approximate, from the metric indoor model).
 * Objects with estimated depth below the threshold are classified at that level.
 *
 * IMPORTANT: These are initial values. Must be empirically calibrated
 * against known indoor scenes (chair at 0.5m, table at 1m, hallway at 2m+).
 */
export const DEPTH_PROXIMITY_THRESHOLDS = {
  sangat_dekat: 0.5,  // < 0.5m — urgent obstacle warning
  dekat: 1.0,         // < 1.0m — close obstacle
  sedang: 2.0,        // < 2.0m — medium distance awareness
  // > 2.0m = "jauh" (far)
} as const;

/**
 * Minimum fraction of region pixels that must show "close" depth
 * to count as a real obstacle (noise protection).
 *
 * 0.005 = 0.5% of region pixels. Below this, depth anomalies
 * are likely noise or edge artifacts, not real obstacles.
 */
export const DEPTH_OBSTACLE_MIN_RATIO = 0.005;

/**
 * Percentile to use for obstacle detection.
 * p5 = 5th percentile captures small objects (~5% of region area)
 * while filtering single-pixel noise spikes.
 *
 * Lower values (p1, p3) = more sensitive, more false positives.
 * Higher values (p10, p25) = more conservative, may miss small objects.
 */
export const DEPTH_ANALYSIS_PERCENTILE = 5;

// ─── Temporal Stability ─────────────────────────────────────────────────────

/**
 * Number of recent frames to retain in the temporal memory buffer.
 * Higher values increase stability but add latency to adapting to real scene changes.
 * 5 frames ≈ 5-10 seconds of history at typical request rates.
 */
export const TEMPORAL_BUFFER_SIZE = 5;

/**
 * Maximum age (ms) before a frame record expires from the buffer.
 * After this duration, the frame is considered stale and purged.
 * 10 seconds allows for typical walking pace scene transitions.
 */
export const TEMPORAL_EXPIRY_MS = 10_000;

/**
 * Confidence threshold for direct object naming.
 * At or above this: "kursi" (direct, confident)
 */
export const CONFIDENCE_HIGH_THRESHOLD = 0.7;

/**
 * Confidence threshold for hedged object naming.
 * Between MEDIUM and HIGH: "terlihat seperti kursi" (hedged)
 * Below MEDIUM: "halangan" (generic fallback)
 */
export const CONFIDENCE_MEDIUM_THRESHOLD = 0.4;

/**
 * Minimum time (ms) between identical narration outputs.
 * Prevents "narration spam" when the scene is stable.
 * 2 seconds matches comfortable TTS pacing.
 */
export const NARRATION_COOLDOWN_MS = 2_000;

/**
 * Minimum semantic difference (0-1) required to trigger a new narration.
 * Below this threshold, the new output is considered "same" as previous.
 * 0.3 allows meaningful changes through while suppressing label jitter.
 */
export const STABILITY_CHANGE_THRESHOLD = 0.3;

/**
 * Weight multiplier for exponential decay across temporal frames.
 * Frame[n] weight = TEMPORAL_DECAY_FACTOR ^ (bufferSize - 1 - n)
 * 0.6 means each older frame is worth 60% of the newer one.
 */
export const TEMPORAL_DECAY_FACTOR = 0.6;
