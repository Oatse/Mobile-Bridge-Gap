/**
 * Depth estimation threshold calibration script.
 * Runs depth analysis on a test image and shows detailed depth values
 * for empirical threshold tuning.
 *
 * Features:
 * - Per-region raw normalized depth values
 * - Text-based depth histogram
 * - Proximity classification with current thresholds
 * - Optional alternative threshold testing via CLI
 * - Structured output for thesis documentation
 *
 * Usage:
 *   bun run scripts/depth-calibration.ts <image-path>
 *   bun run scripts/depth-calibration.ts <image-path> --thresholds 0.20,0.40,0.65
 *
 * Example:
 *   bun run scripts/depth-calibration.ts scripts/test-image.png
 *   bun run scripts/depth-calibration.ts scripts/test-image.png --thresholds 0.20,0.40,0.65
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, writeFileSync } from "fs";

// ─── Resolve paths ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const MODEL_FILE = resolve(
  projectRoot,
  "models",
  "depth-anything-v2-small",
  "onnx",
  "model.onnx"
);

// ─── Default thresholds (from constants.ts) ─────────────────────────────────

const DEFAULT_THRESHOLDS = {
  sangat_dekat: 0.25,
  dekat: 0.45,
  sedang: 0.70,
};

// ─── Preprocessing config ───────────────────────────────────────────────────

const PREPROCESS = {
  inputSize: 518,
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
  rescaleFactor: 0.00392156862745098,
};

// ─── Region bounds (mirrors depthAnalysis.ts) ───────────────────────────────

const REGION_BOUNDS: Record<string, [number, number, number, number]> = {
  center: [0.30, 0.70, 0.40, 1.00],
  left: [0.00, 0.30, 0.40, 1.00],
  right: [0.70, 1.00, 0.40, 1.00],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

type ProximityLevel = "sangat_dekat" | "dekat" | "sedang" | "jauh";

function classifyDepth(
  meanDepth: number,
  thresholds: typeof DEFAULT_THRESHOLDS
): ProximityLevel {
  if (meanDepth < thresholds.sangat_dekat) return "sangat_dekat";
  if (meanDepth < thresholds.dekat) return "dekat";
  if (meanDepth < thresholds.sedang) return "sedang";
  return "jauh";
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

// ─── Depth Map Analysis ─────────────────────────────────────────────────────

function normalizeDepthMap(depthData: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < depthData.length; i++) {
    const val = depthData[i]!;
    if (val < min) min = val;
    if (val > max) max = val;
  }

  const range = max - min;
  if (range === 0) return new Float32Array(depthData.length).fill(0.5);

  const normalized = new Float32Array(depthData.length);
  for (let i = 0; i < depthData.length; i++) {
    normalized[i] = 1 - (depthData[i]! - min) / range;
  }
  return normalized;
}

function getRegionStats(
  normalizedMap: Float32Array,
  width: number,
  height: number,
  bounds: [number, number, number, number]
): { mean: number; min: number; max: number; std: number } {
  const [xStart, xEnd, yStart, yEnd] = bounds;
  const x0 = Math.floor(xStart * width);
  const x1 = Math.floor(xEnd * width);
  const y0 = Math.floor(yStart * height);
  const y1 = Math.floor(yEnd * height);

  const values: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      values.push(normalizedMap[y * width + x]!);
    }
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);

  return { mean, min, max, std };
}

/**
 * Generates a text-based histogram of depth values.
 */
function generateHistogram(normalizedMap: Float32Array, bins: number = 10): string {
  const counts = new Array(bins).fill(0) as number[];
  const binWidth = 1.0 / bins;

  for (let i = 0; i < normalizedMap.length; i++) {
    const bin = Math.min(Math.floor(normalizedMap[i]! / binWidth), bins - 1);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }

  const maxCount = Math.max(...counts);
  const barWidth = 40;
  const lines: string[] = [];

  for (let i = 0; i < bins; i++) {
    const rangeStart = (i * binWidth).toFixed(2);
    const rangeEnd = ((i + 1) * binWidth).toFixed(2);
    const barLength = Math.round((counts[i]! / maxCount) * barWidth);
    const bar = "█".repeat(barLength);
    const pct = ((counts[i]! / normalizedMap.length) * 100).toFixed(1);
    lines.push(`  ${rangeStart}-${rangeEnd} |${bar} ${pct}%`);
  }

  return lines.join("\n");
}

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

function parseThresholds(args: string[]): typeof DEFAULT_THRESHOLDS {
  const thresholdsIdx = args.indexOf("--thresholds");
  if (thresholdsIdx === -1 || thresholdsIdx + 1 >= args.length) {
    return DEFAULT_THRESHOLDS;
  }

  const values = args[thresholdsIdx + 1]!.split(",").map(Number);
  if (values.length !== 3 || values.some(isNaN)) {
    console.error("❌ Invalid thresholds format. Expected: 0.25,0.45,0.70");
    process.exit(1);
  }

  return {
    sangat_dekat: values[0]!,
    dekat: values[1]!,
    sedang: values[2]!,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function runCalibration(): Promise<void> {
  const imagePath = process.argv[2];

  if (!imagePath) {
    console.error("❌ Usage: bun run scripts/depth-calibration.ts <image-path> [--thresholds 0.25,0.45,0.70]");
    process.exit(1);
  }

  const resolvedPath = resolve(process.cwd(), imagePath);
  if (!existsSync(resolvedPath)) {
    console.error(`❌ Image file not found: ${resolvedPath}`);
    process.exit(1);
  }

  const thresholds = parseThresholds(process.argv);
  const isCustomThresholds = process.argv.includes("--thresholds");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MBG Depth Estimation — Threshold Calibration");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📷 Image: ${basename(resolvedPath)}`);
  console.log(`📐 Thresholds: sangat_dekat=${thresholds.sangat_dekat}, dekat=${thresholds.dekat}, sedang=${thresholds.sedang}`);
  if (isCustomThresholds) {
    console.log(`   (custom thresholds provided)`);
  }

  // Load model
  console.log("\n🔄 Loading model...");
  const session = await ort.InferenceSession.create(MODEL_FILE, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    executionMode: "parallel",
    interOpNumThreads: 2,
    intraOpNumThreads: 2,
  });
  console.log("✅ Model loaded");

  // Run inference
  const imageBuffer = readFileSync(resolvedPath);
  const { tensor } = await preprocessImage(imageBuffer);

  console.log("🔄 Running inference...");
  const inferStart = performance.now();
  const output = await session.run({ pixel_values: tensor });
  const inferenceMs = performance.now() - inferStart;
  console.log(`✅ Inference complete: ${inferenceMs.toFixed(0)}ms`);

  // Extract and normalize depth map
  const depthOutput = output.predicted_depth!;
  const depthData = depthOutput.data as Float32Array;
  const dims = depthOutput.dims;
  const outHeight = Number(dims[dims.length - 2]);
  const outWidth = Number(dims[dims.length - 1]);

  const normalized = normalizeDepthMap(depthData);

  // ─── Global Statistics ────────────────────────────────────────────────
  console.log("\n──── Global Depth Map Statistics ────");
  console.log(`  Dimensions: ${outWidth}×${outHeight} (${normalized.length} values)`);

  let gMin = Infinity, gMax = -Infinity, gSum = 0;
  for (let i = 0; i < normalized.length; i++) {
    const v = normalized[i]!;
    if (v < gMin) gMin = v;
    if (v > gMax) gMax = v;
    gSum += v;
  }
  const gMean = gSum / normalized.length;
  console.log(`  Min: ${gMin.toFixed(4)}`);
  console.log(`  Max: ${gMax.toFixed(4)}`);
  console.log(`  Mean: ${gMean.toFixed(4)}`);

  // ─── Histogram ────────────────────────────────────────────────────────
  console.log("\n──── Depth Distribution Histogram ────");
  console.log("  (0.0 = closest, 1.0 = farthest)");
  console.log(generateHistogram(normalized));

  // ─── Per-Region Analysis ──────────────────────────────────────────────
  console.log("\n──── Per-Region Analysis ────");
  console.log(`  Thresholds: sangat_dekat < ${thresholds.sangat_dekat}, dekat < ${thresholds.dekat}, sedang < ${thresholds.sedang}, else jauh`);

  const regionResults: Array<{
    region: string;
    mean: number;
    min: number;
    max: number;
    std: number;
    proximity: ProximityLevel;
  }> = [];

  for (const [regionName, bounds] of Object.entries(REGION_BOUNDS)) {
    const stats = getRegionStats(normalized, outWidth, outHeight, bounds);
    const proximity = classifyDepth(stats.mean, thresholds);

    regionResults.push({
      region: regionName,
      ...stats,
      proximity,
    });

    console.log(`\n  [${regionName.toUpperCase()}]`);
    console.log(`    Mean depth:  ${stats.mean.toFixed(4)}`);
    console.log(`    Min depth:   ${stats.min.toFixed(4)}`);
    console.log(`    Max depth:   ${stats.max.toFixed(4)}`);
    console.log(`    Std dev:     ${stats.std.toFixed(4)}`);
    console.log(`    Proximity:   ${proximity}`);
  }

  // ─── Threshold Sensitivity Analysis ───────────────────────────────────
  console.log("\n──── Threshold Sensitivity (What-If) ────");
  console.log("  Showing how proximity changes with different threshold sets:\n");

  const alternativeThresholds = [
    { label: "Aggressive", sangat_dekat: 0.30, dekat: 0.50, sedang: 0.75 },
    { label: "Current   ", ...thresholds },
    { label: "Conserv.  ", sangat_dekat: 0.20, dekat: 0.40, sedang: 0.65 },
    { label: "Tight     ", sangat_dekat: 0.15, dekat: 0.35, sedang: 0.60 },
  ];

  const sensitivityHeader = "  | Threshold Set | sangat_dekat | dekat | sedang | Center → | Left → | Right → |";
  const sensitivityDiv = "  |---------------|-------------|-------|--------|----------|--------|---------|";
  console.log(sensitivityHeader);
  console.log(sensitivityDiv);

  for (const alt of alternativeThresholds) {
    const centerMean = regionResults.find((r) => r.region === "center")!.mean;
    const leftMean = regionResults.find((r) => r.region === "left")!.mean;
    const rightMean = regionResults.find((r) => r.region === "right")!.mean;

    const centerProx = classifyDepth(centerMean, alt);
    const leftProx = classifyDepth(leftMean, alt);
    const rightProx = classifyDepth(rightMean, alt);

    console.log(`  | ${alt.label} | ${alt.sangat_dekat.toFixed(2)}        | ${alt.dekat.toFixed(2)}  | ${alt.sedang.toFixed(2)}   | ${centerProx.padEnd(8)} | ${leftProx.padEnd(6)} | ${rightProx.padEnd(7)} |`);
  }

  // ─── Save Results ─────────────────────────────────────────────────────
  const outputPath = resolve(projectRoot, "scripts", "calibration-results.json");
  const jsonResults = {
    timestamp: new Date().toISOString(),
    image: basename(resolvedPath),
    thresholds,
    inferenceMs,
    depthMapSize: `${outWidth}×${outHeight}`,
    global: { min: gMin, max: gMax, mean: gMean },
    regions: regionResults,
  };
  writeFileSync(outputPath, JSON.stringify(jsonResults, null, 2));
  console.log(`\n📊 Results saved to: ${outputPath}`);

  // ─── Thesis Documentation ─────────────────────────────────────────────
  console.log("\n──── For Thesis Documentation ────");
  console.log(`Image: ${basename(resolvedPath)}`);
  console.log(`Resolution: ${PREPROCESS.inputSize}×${PREPROCESS.inputSize}`);
  console.log(`Inference time: ${inferenceMs.toFixed(0)}ms`);
  console.log(`Thresholds: [${thresholds.sangat_dekat}, ${thresholds.dekat}, ${thresholds.sedang}]`);
  for (const r of regionResults) {
    console.log(`Region ${r.region}: mean=${r.mean.toFixed(4)}, proximity=${r.proximity}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Calibration Complete");
  console.log("═══════════════════════════════════════════════════════════");
}

runCalibration().catch((error) => {
  console.error("❌ Calibration failed:", error);
  process.exit(1);
});
