/**
 * Depth model singleton loader.
 * Loads Depth-Anything-V2-Metric-Indoor-Small ONNX model ONCE during startup.
 * Uses onnxruntime-node for native CPU inference (avoids VRAM contention with LM Studio).
 *
 * IMPORTANT:
 * - No remote model downloads — loads from local filesystem only
 * - Model loaded from backend/models/ directory
 * - Singleton pattern — session created once, reused for all requests
 * - CPU execution only — avoids VRAM contention with LM Studio
 * - Metric indoor model outputs approximate depth in meters (0–20m range)
 */

import * as ort from "onnxruntime-node";
import { resolve } from "path";
import { existsSync } from "fs";
import { DEPTH_MODEL_ID, DEPTH_MODEL_PATH, DEPTH_INPUT_SIZE, DEPTH_ONNX_FILENAME } from "../../utils/constants";
import { log } from "../../utils/logger";

// ─── Model Configuration ────────────────────────────────────────────────────

/** Full path to the ONNX model file */
const MODEL_FILE = resolve(
  DEPTH_MODEL_PATH,
  DEPTH_MODEL_ID,
  DEPTH_ONNX_FILENAME
);

/**
 * Preprocessing parameters from preprocessor_config.json.
 * These must match the model's expected input normalization.
 */
export const PREPROCESS_CONFIG = {
  /** Target input size for the model (configurable via DEPTH_INPUT_SIZE env var) */
  inputSize: DEPTH_INPUT_SIZE,
  /** ImageNet mean values for normalization (RGB) */
  mean: [0.485, 0.456, 0.406] as const,
  /** ImageNet std values for normalization (RGB) */
  std: [0.229, 0.224, 0.225] as const,
  /** Rescale factor (1/255) */
  rescaleFactor: 0.00392156862745098,
} as const;

// ─── Singleton Session ──────────────────────────────────────────────────────

let session: ort.InferenceSession | null = null;
let loadError: string | null = null;
let isLoading = false;

/**
 * Loads the ONNX inference session.
 * Called once during startup. Subsequent calls return immediately.
 */
export async function preloadDepthModel(): Promise<void> {
  if (session) {
    log.info("Depth model already loaded, skipping");
    return;
  }

  if (isLoading) {
    log.warn("Depth model is already loading, skipping duplicate call");
    return;
  }

  isLoading = true;
  const startTime = performance.now();

  try {
    // Verify model file exists
    if (!existsSync(MODEL_FILE)) {
      throw new Error(`Model file not found: ${MODEL_FILE}`);
    }

    log.startup(`Loading depth model: ${DEPTH_MODEL_ID}`);
    log.startup(`Model file: ${MODEL_FILE}`);

    // Create ONNX Runtime session with CPU execution
    session = await ort.InferenceSession.create(MODEL_FILE, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      // Enable parallel execution for better multi-core utilization
      executionMode: "parallel",
      // Limit thread count to avoid starving other processes
      interOpNumThreads: 2,
      intraOpNumThreads: 2,
    });

    const loadTimeMs = performance.now() - startTime;
    loadError = null;

    log.startup(`Depth model loaded successfully in ${loadTimeMs.toFixed(0)}ms`);
    log.startup(`  Input: ${session.inputNames.join(", ")}`);
    log.startup(`  Output: ${session.outputNames.join(", ")}`);
  } catch (error) {
    const loadTimeMs = performance.now() - startTime;
    loadError = error instanceof Error ? error.message : String(error);

    log.error("Failed to load depth model", {
      error: loadError,
      modelFile: MODEL_FILE,
      durationMs: loadTimeMs.toFixed(0),
    });

    // Don't throw — depth is supplementary, not critical
    session = null;
  } finally {
    isLoading = false;
  }
}

/**
 * Returns the cached ONNX inference session.
 * Returns null if the model failed to load or hasn't been loaded yet.
 */
export function getDepthSession(): ort.InferenceSession | null {
  return session;
}

/**
 * Returns whether the depth model is loaded and ready for inference.
 */
export function isDepthModelReady(): boolean {
  return session !== null;
}

/**
 * Returns the last error message from model loading, if any.
 */
export function getDepthModelError(): string | null {
  return loadError;
}
