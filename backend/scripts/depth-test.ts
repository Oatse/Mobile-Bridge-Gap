/**
 * Standalone depth estimation test script.
 * Validates that the Depth-Anything-V2-Metric-Indoor-Small model loads
 * and runs inference correctly BEFORE integrating into the /describe endpoint.
 *
 * Uses onnxruntime-node directly (matches production implementation).
 *
 * Usage:
 *   bun run scripts/depth-test.ts <image-path>
 *
 * Example:
 *   bun run scripts/depth-test.ts scripts/test-image.png
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";

// ─── Resolve paths ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const MODEL_FILE = resolve(
  projectRoot,
  "models",
  "Depth-Anything-V2-Metric-Indoor-Small-hf",
  "depth_anything_v2_metric_indoor_small.onnx"
);

// ─── Preprocessing config (matches preprocessor_config.json) ────────────────

const PREPROCESS = {
  inputSize: 518,
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
  rescaleFactor: 0.00392156862745098,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatMemory(): string {
  const mem = process.memoryUsage();
  return `RSS: ${formatBytes(mem.rss)}, Heap: ${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)}`;
}

// ─── Preprocessing ──────────────────────────────────────────────────────────

async function preprocessImage(imageBuffer: Buffer): Promise<{
  tensor: ort.Tensor;
  width: number;
  height: number;
}> {
  const { inputSize, mean, std, rescaleFactor } = PREPROCESS;

  const { data, info } = await sharp(imageBuffer)
    .resize(inputSize, inputSize, { fit: "cover", position: "centre" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = 3;
  const pixelCount = width * height;

  const tensorData = new Float32Array(channels * pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const rIdx = i * 3;
    const r = (data[rIdx]! * rescaleFactor - mean[0]) / std[0];
    const g = (data[rIdx + 1]! * rescaleFactor - mean[1]) / std[1];
    const b = (data[rIdx + 2]! * rescaleFactor - mean[2]) / std[2];

    tensorData[i] = r;
    tensorData[pixelCount + i] = g;
    tensorData[2 * pixelCount + i] = b;
  }

  const tensor = new ort.Tensor("float32", tensorData, [1, channels, height, width]);
  return { tensor, width, height };
}

// ─── Main Test ──────────────────────────────────────────────────────────────

async function runDepthTest(): Promise<void> {
  const imagePath = process.argv[2];

  if (!imagePath) {
    console.error("❌ Usage: bun run scripts/depth-test.ts <image-path>");
    console.error("   Example: bun run scripts/depth-test.ts scripts/test-image.png");
    process.exit(1);
  }

  const resolvedPath = resolve(process.cwd(), imagePath);

  if (!existsSync(resolvedPath)) {
    console.error(`❌ Image file not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MBG Depth Estimation Test — Metric Indoor (onnxruntime-node)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📁 Model: ${MODEL_FILE}`);
  console.log(`📷 Image: ${resolvedPath}`);
  console.log(`💾 Memory (before): ${formatMemory()}`);
  console.log("───────────────────────────────────────────────────────────");

  // Step 1: Create ONNX session
  console.log("\n🔄 Loading depth model...");
  const loadStart = performance.now();

  let session: ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(MODEL_FILE, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      executionMode: "parallel",
      interOpNumThreads: 2,
      intraOpNumThreads: 2,
    });
  } catch (error) {
    console.error("❌ Failed to load depth model:", error);
    process.exit(1);
  }

  const loadTimeMs = performance.now() - loadStart;
  console.log(`✅ Model loaded in ${loadTimeMs.toFixed(0)}ms`);
  console.log(`   Input: ${session.inputNames.join(", ")}`);
  console.log(`   Output: ${session.outputNames.join(", ")}`);
  console.log(`💾 Memory (after load): ${formatMemory()}`);

  // Step 2: Read and preprocess image
  console.log("\n🔄 Preprocessing image...");
  const imageBuffer = readFileSync(resolvedPath);
  console.log(`📷 Image size: ${formatBytes(imageBuffer.length)}`);

  const preprocessStart = performance.now();
  const { tensor } = await preprocessImage(imageBuffer);
  const preprocessMs = performance.now() - preprocessStart;
  console.log(`✅ Preprocessed in ${preprocessMs.toFixed(0)}ms`);
  console.log(`   Tensor shape: [${tensor.dims.join(", ")}]`);

  // Step 3: Run cold inference
  console.log("\n🔄 Running depth inference (cold)...");
  const coldStart = performance.now();

  let output: ort.InferenceSession.ReturnType;
  try {
    output = await session.run({ pixel_values: tensor });
  } catch (error) {
    console.error("❌ Depth inference failed:", error);
    process.exit(1);
  }

  const coldMs = performance.now() - coldStart;
  console.log(`✅ Cold inference: ${coldMs.toFixed(0)}ms`);

  // Step 4: Analyze output
  const depthOutput = output.predicted_depth!;
  const depthData = depthOutput.data as Float32Array;
  const dims = depthOutput.dims;
  const outHeight = Number(dims[dims.length - 2]);
  const outWidth = Number(dims[dims.length - 1]);

  console.log(`\n📊 Depth map: ${outWidth}x${outHeight} (${depthData.length} values)`);

  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < depthData.length; i++) {
    const val = depthData[i]!;
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
  }
  const mean = sum / depthData.length;

  console.log(`   Min: ${min.toFixed(4)}m`);
  console.log(`   Max: ${max.toFixed(4)}m`);
  console.log(`   Mean: ${mean.toFixed(4)}m`);
  console.log(`   Range: ${(max - min).toFixed(4)}m`);

  // Step 5: Run semantic analysis
  console.log("\n🔄 Running semantic analysis...");
  const { analyzeDepthMap } = await import("../src/services/depth/depthAnalysis");
  const analysis = analyzeDepthMap(depthData, outWidth, outHeight, coldMs);

  console.log(`\n📊 Semantic Analysis Results:`);
  console.log(`   Overall proximity: ${analysis.proximity}`);
  console.log(`   Warning: ${analysis.warning ?? "(none — path clear)"}`);
  console.log(`   Processing time: ${analysis.processingMs.toFixed(0)}ms`);
  console.log(`\n   Regions:`);
  for (const region of analysis.regions) {
    console.log(`     ${region.region}: ${region.proximity} (est. ${region.estimatedDistanceM.toFixed(3)}m)`);
  }

  // Step 6: Warm inference
  console.log("\n🔄 Running second inference (warm cache)...");
  const warmPreStart = performance.now();
  const { tensor: warmTensor } = await preprocessImage(imageBuffer);
  const warmPreMs = performance.now() - warmPreStart;

  const warmInferStart = performance.now();
  await session.run({ pixel_values: warmTensor });
  const warmInferMs = performance.now() - warmInferStart;
  console.log(`✅ Warm preprocess: ${warmPreMs.toFixed(0)}ms, inference: ${warmInferMs.toFixed(0)}ms`);

  // Step 7: Summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Test Summary");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`   Model load:         ${loadTimeMs.toFixed(0)}ms`);
  console.log(`   Preprocess:         ${preprocessMs.toFixed(0)}ms`);
  console.log(`   Cold inference:     ${coldMs.toFixed(0)}ms`);
  console.log(`   Warm preprocess:    ${warmPreMs.toFixed(0)}ms`);
  console.log(`   Warm inference:     ${warmInferMs.toFixed(0)}ms`);
  console.log(`   Total (cold):       ${(preprocessMs + coldMs).toFixed(0)}ms`);
  console.log(`   Total (warm):       ${(warmPreMs + warmInferMs).toFixed(0)}ms`);
  console.log(`   Memory (final):     ${formatMemory()}`);
  console.log(`   Proximity:          ${analysis.proximity}`);
  console.log(`   Warning:            ${analysis.warning ?? "none"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("\n✅ All depth estimation tests passed!");
}

// Run
runDepthTest().catch((error) => {
  console.error("❌ Test failed with unexpected error:", error);
  process.exit(1);
});
