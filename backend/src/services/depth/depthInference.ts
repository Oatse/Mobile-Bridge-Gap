/**
 * Depth inference execution using onnxruntime-node.
 * Handles image preprocessing, ONNX tensor creation, and inference.
 *
 * Preprocessing pipeline:
 * 1. Decode image → resize to configured input size (default 518x518)
 * 2. Extract raw RGB pixel data
 * 3. Normalize with ImageNet mean/std
 * 4. Reshape to NCHW format (batch, channels, height, width)
 * 5. Run ONNX inference
 *
 * IMPORTANT:
 * - Uses sharp for image preprocessing (already a project dependency)
 * - Failures are caught and returned as null — never thrown
 * - Depth inference is supplementary; it must not break the primary Gemma pipeline
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { getDepthSession, isDepthModelReady, PREPROCESS_CONFIG } from "./depthModel";
import { analyzeDepthMap } from "./depthAnalysis";
import { DEPTH_INFERENCE_TIMEOUT_MS, ENABLE_DEPTH_ESTIMATION } from "../../utils/constants";
import { log } from "../../utils/logger";
import type { DepthAnalysisResult } from "./types";

// ─── Image Preprocessing ────────────────────────────────────────────────────

/**
 * Preprocesses an image buffer into a normalized NCHW float32 tensor
 * suitable for the Depth-Anything-V2 model.
 *
 * Steps:
 * 1. Resize to configured input size (via DEPTH_INPUT_SIZE env var)
 * 2. Extract raw RGB bytes
 * 3. Rescale to [0, 1] range
 * 4. Normalize with ImageNet mean/std
 * 5. Reorder from HWC to NCHW layout
 */
async function preprocessImage(imageBuffer: Buffer): Promise<{
  tensor: ort.Tensor;
  width: number;
  height: number;
}> {
  const { inputSize, mean, std, rescaleFactor } = PREPROCESS_CONFIG;

  // Resize image to model input size and extract raw RGB pixels
  const { data, info } = await sharp(imageBuffer)
    .resize(inputSize, inputSize, {
      fit: "cover",
      position: "centre",
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = 3;
  const pixelCount = width * height;

  // Create NCHW float32 tensor
  // Shape: [1, 3, height, width]
  const tensorData = new Float32Array(channels * pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const rIdx = i * 3;
    // Rescale to [0, 1] then normalize with ImageNet stats
    const r = (data[rIdx]! * rescaleFactor - mean[0]) / std[0];
    const g = (data[rIdx + 1]! * rescaleFactor - mean[1]) / std[1];
    const b = (data[rIdx + 2]! * rescaleFactor - mean[2]) / std[2];

    // NCHW layout: all R values, then all G, then all B
    tensorData[i] = r;                    // Channel 0 (R)
    tensorData[pixelCount + i] = g;       // Channel 1 (G)
    tensorData[2 * pixelCount + i] = b;   // Channel 2 (B)
  }

  const tensor = new ort.Tensor("float32", tensorData, [1, channels, height, width]);

  return { tensor, width, height };
}

// ─── Main Inference ─────────────────────────────────────────────────────────

/**
 * Runs depth estimation on an image buffer and returns semantic analysis.
 * Returns null on any failure — never throws.
 *
 * @param imageBuffer - Raw image buffer from the uploaded file
 * @returns Semantic depth analysis result, or null if inference fails
 */
export async function estimateDepth(
  imageBuffer: Buffer
): Promise<DepthAnalysisResult | null> {
  const startTime = performance.now();

  // Guard: depth estimation disabled
  if (!ENABLE_DEPTH_ESTIMATION) {
    log.debug("Depth inference skipped — disabled via ENABLE_DEPTH_ESTIMATION");
    return null;
  }

  // Guard: model not loaded
  if (!isDepthModelReady()) {
    log.warn("Depth inference skipped — model not loaded");
    return null;
  }

  const session = getDepthSession();
  if (!session) {
    log.warn("Depth inference skipped — session unavailable");
    return null;
  }

  try {
    // Step 1: Preprocess image
    const preprocessStart = performance.now();
    const { tensor, width, height } = await preprocessImage(imageBuffer);
    const preprocessMs = performance.now() - preprocessStart;

    log.debug("Depth preprocessing complete", {
      inputSize: PREPROCESS_CONFIG.inputSize,
      tensorShape: `[1, 3, ${height}, ${width}]`,
      preprocessMs: preprocessMs.toFixed(1),
    });

    // Step 2: Run ONNX inference with timeout
    const inferenceStart = performance.now();

    const feeds: Record<string, ort.Tensor> = {
      pixel_values: tensor,
    };

    const inferencePromise = session.run(feeds);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Depth inference timed out")),
        DEPTH_INFERENCE_TIMEOUT_MS
      )
    );

    const results = await Promise.race([inferencePromise, timeoutPromise]);
    const inferenceMs = performance.now() - inferenceStart;

    // Step 3: Extract depth map from output
    const depthOutput = results.predicted_depth;
    if (!depthOutput) {
      log.error("Depth model returned no predicted_depth output");
      return null;
    }

    const depthData = depthOutput.data as Float32Array;
    const outputDims = depthOutput.dims;
    const outHeight = Number(outputDims[outputDims.length - 2]);
    const outWidth = Number(outputDims[outputDims.length - 1]);

    log.info("Depth inference complete", {
      preprocessMs: preprocessMs.toFixed(0),
      inferenceMs: inferenceMs.toFixed(0),
      mapSize: `${outWidth}x${outHeight}`,
    });

    log.debug("Depth inference timing breakdown", {
      preprocessMs: preprocessMs.toFixed(1),
      inferenceMs: inferenceMs.toFixed(1),
      totalInferenceMs: (preprocessMs + inferenceMs).toFixed(1),
      inputResolution: `${PREPROCESS_CONFIG.inputSize}x${PREPROCESS_CONFIG.inputSize}`,
      outputResolution: `${outWidth}x${outHeight}`,
    });

    // Step 4: Run semantic analysis
    const totalInferenceMs = preprocessMs + inferenceMs;
    const analysisResult = analyzeDepthMap(
      depthData,
      outWidth,
      outHeight,
      totalInferenceMs
    );

    const totalMs = performance.now() - startTime;
    log.info("Depth analysis complete", {
      proximity: analysisResult.proximity,
      warning: analysisResult.warning ?? "none",
      totalMs: totalMs.toFixed(0),
    });

    log.debug("Depth region details", {
      regions: analysisResult.regions.map((r) => ({
        region: r.region,
        proximity: r.proximity,
        meanDepth: r.meanDepth.toFixed(4),
      })),
    });

    return analysisResult;
  } catch (error) {
    const durationMs = performance.now() - startTime;
    log.error("Depth inference failed", {
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs.toFixed(0),
    });

    // Return null — depth failure must not affect the primary pipeline
    return null;
  }
}
