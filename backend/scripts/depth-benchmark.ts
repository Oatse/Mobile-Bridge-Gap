/**
 * Multi-resolution depth estimation benchmark script.
 * Tests the Depth-Anything-V2-Metric-Indoor-Small model at multiple resolutions.
 *
 * For each resolution:
 * - 1 cold inference + 3 warm inferences
 * - Measures: preprocessing, inference, total latency
 * - Measures: memory usage (RSS, heap)
 * - Logs raw metric output ranges (min/max/mean meters)
 * - Compares semantic analysis quality across resolutions
 *
 * Usage:
 *   bun run scripts/depth-benchmark.ts <image-path>
 *
 * Example:
 *   bun run scripts/depth-benchmark.ts scripts/test-image.png
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, writeFileSync } from "fs";

// ─── Resolve paths ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const MODEL_FILE = resolve(
  projectRoot,
  "models",
  "Depth-Anything-V2-Metric-Indoor-Small-hf",
  "depth_anything_v2_metric_indoor_small.onnx"
);

// ─── Preprocessing config ───────────────────────────────────────────────────

const PREPROCESS = {
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
  rescaleFactor: 0.00392156862745098,
};

/**
 * Resolutions to benchmark.
 * The metric indoor DPT model REQUIRES 518×518 input (positional embeddings
 * enforce fixed tensor dimensions). Other resolutions cause ONNX broadcast errors.
 */
const RESOLUTIONS = [518] as const;

/** Number of warm inference runs per resolution */
const WARM_RUNS = 3;

// ─── Types ──────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  resolution: number;
  coldPreprocessMs: number;
  coldInferenceMs: number;
  coldTotalMs: number;
  warmPreprocessMs: number[];
  warmInferenceMs: number[];
  warmAvgPreprocessMs: number;
  warmAvgInferenceMs: number;
  warmAvgTotalMs: number;
  outputSize: string;
  memoryRss: string;
  memoryHeap: string;
  rawMinMeters: number;
  rawMaxMeters: number;
  rawMeanMeters: number;
  proximity: string;
  warning: string | null;
  regions: Array<{ region: string; proximity: string; meanDepth: number; estimatedDistanceM: number }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatMemory(): { rss: string; heap: string } {
  const mem = process.memoryUsage();
  return {
    rss: formatBytes(mem.rss),
    heap: `${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)}`,
  };
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function getDepthStats(data: Float32Array): { min: number; max: number; mean: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / data.length };
}

// ─── Preprocessing ──────────────────────────────────────────────────────────

async function preprocessImage(
  imageBuffer: Buffer,
  inputSize: number
): Promise<{
  tensor: ort.Tensor;
  width: number;
  height: number;
}> {
  const { mean, std, rescaleFactor } = PREPROCESS;

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

// ─── Benchmark Runner ───────────────────────────────────────────────────────

async function benchmarkResolution(
  session: ort.InferenceSession,
  imageBuffer: Buffer,
  inputSize: number
): Promise<BenchmarkResult> {
  console.log(`\n──── Resolution: ${inputSize}×${inputSize} ────`);

  // Cold run
  const coldPreStart = performance.now();
  const { tensor: coldTensor } = await preprocessImage(imageBuffer, inputSize);
  const coldPreprocessMs = performance.now() - coldPreStart;

  const coldInferStart = performance.now();
  const coldOutput = await session.run({ pixel_values: coldTensor });
  const coldInferenceMs = performance.now() - coldInferStart;
  const coldTotalMs = coldPreprocessMs + coldInferenceMs;

  console.log(`  Cold: preprocess=${coldPreprocessMs.toFixed(0)}ms, inference=${coldInferenceMs.toFixed(0)}ms, total=${coldTotalMs.toFixed(0)}ms`);

  // Warm runs
  const warmPreprocessMs: number[] = [];
  const warmInferenceMs: number[] = [];

  for (let i = 0; i < WARM_RUNS; i++) {
    const preStart = performance.now();
    const { tensor: warmTensor } = await preprocessImage(imageBuffer, inputSize);
    warmPreprocessMs.push(performance.now() - preStart);

    const inferStart = performance.now();
    await session.run({ pixel_values: warmTensor });
    warmInferenceMs.push(performance.now() - inferStart);
  }

  const warmAvgPreprocessMs = avg(warmPreprocessMs);
  const warmAvgInferenceMs = avg(warmInferenceMs);
  const warmAvgTotalMs = warmAvgPreprocessMs + warmAvgInferenceMs;

  console.log(`  Warm (avg ${WARM_RUNS} runs): preprocess=${warmAvgPreprocessMs.toFixed(0)}ms, inference=${warmAvgInferenceMs.toFixed(0)}ms, total=${warmAvgTotalMs.toFixed(0)}ms`);

  // Extract depth output
  const depthOutput = coldOutput.predicted_depth!;
  const depthData = depthOutput.data as Float32Array;
  const dims = depthOutput.dims;
  const outHeight = Number(dims[dims.length - 2]);
  const outWidth = Number(dims[dims.length - 1]);

  // Raw metric statistics
  const stats = getDepthStats(depthData);
  console.log(`  Raw metric range: min=${stats.min.toFixed(3)}m, max=${stats.max.toFixed(3)}m, mean=${stats.mean.toFixed(3)}m`);

  // Semantic analysis
  const { analyzeDepthMap } = await import("../src/services/depth/depthAnalysis");
  const analysis = analyzeDepthMap(depthData, outWidth, outHeight, coldTotalMs);

  console.log(`  Output: ${outWidth}×${outHeight}`);
  console.log(`  Proximity: ${analysis.proximity}`);
  console.log(`  Warning: ${analysis.warning ?? "(none — path clear)"}`);
  for (const region of analysis.regions) {
    console.log(`    ${region.region}: ${region.proximity} (est. ${region.estimatedDistanceM.toFixed(3)}m)`);
  }

  const mem = formatMemory();
  console.log(`  Memory: RSS=${mem.rss}, Heap=${mem.heap}`);

  return {
    resolution: inputSize,
    coldPreprocessMs,
    coldInferenceMs,
    coldTotalMs,
    warmPreprocessMs,
    warmInferenceMs,
    warmAvgPreprocessMs,
    warmAvgInferenceMs,
    warmAvgTotalMs,
    outputSize: `${outWidth}×${outHeight}`,
    memoryRss: mem.rss,
    memoryHeap: mem.heap,
    rawMinMeters: stats.min,
    rawMaxMeters: stats.max,
    rawMeanMeters: stats.mean,
    proximity: analysis.proximity,
    warning: analysis.warning,
    regions: analysis.regions.map((r) => ({
      region: r.region,
      proximity: r.proximity,
      meanDepth: r.meanDepth,
      estimatedDistanceM: r.estimatedDistanceM,
    })),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function runBenchmark(): Promise<void> {
  const imagePath = process.argv[2];

  if (!imagePath) {
    console.error("❌ Usage: bun run scripts/depth-benchmark.ts <image-path>");
    process.exit(1);
  }

  const resolvedPath = resolve(process.cwd(), imagePath);

  if (!existsSync(resolvedPath)) {
    console.error(`❌ Image file not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MBG Depth Estimation — Metric Indoor Benchmark");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📁 Model: Depth-Anything-V2-Metric-Indoor-Small`);
  console.log(`📁 ONNX:  ${MODEL_FILE}`);
  console.log(`📷 Image: ${resolvedPath}`);
  console.log(`🔄 Resolutions: ${RESOLUTIONS.join(", ")}`);
  console.log(`🔁 Warm runs per resolution: ${WARM_RUNS}`);

  // Load model once
  console.log("\n🔄 Loading metric depth model...");
  const loadStart = performance.now();
  const session = await ort.InferenceSession.create(MODEL_FILE, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    executionMode: "parallel",
    interOpNumThreads: 2,
    intraOpNumThreads: 2,
  });
  const loadTimeMs = performance.now() - loadStart;
  console.log(`✅ Model loaded in ${loadTimeMs.toFixed(0)}ms`);
  console.log(`   Inputs: ${session.inputNames.join(", ")}`);
  console.log(`   Outputs: ${session.outputNames.join(", ")}`);

  const imageBuffer = readFileSync(resolvedPath);
  console.log(`📷 Image size: ${formatBytes(imageBuffer.length)}`);

  // Run benchmarks for each resolution
  const results: BenchmarkResult[] = [];
  for (const resolution of RESOLUTIONS) {
    const result = await benchmarkResolution(session, imageBuffer, resolution);
    results.push(result);
  }

  // ─── Comparison Table ─────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  COMPARISON TABLE");
  console.log("═══════════════════════════════════════════════════════════");

  const header = "| Resolution | Cold Pre | Cold Infer | Cold Total | Warm Pre | Warm Infer | Warm Total | Output | Min(m) | Max(m) | Proximity | Warning |";
  const divider = "|------------|----------|------------|------------|----------|------------|------------|--------|--------|--------|-----------|---------|";

  console.log(header);
  console.log(divider);

  for (const r of results) {
    const row = [
      `${r.resolution}×${r.resolution}`,
      `${r.coldPreprocessMs.toFixed(0)}ms`,
      `${r.coldInferenceMs.toFixed(0)}ms`,
      `${r.coldTotalMs.toFixed(0)}ms`,
      `${r.warmAvgPreprocessMs.toFixed(0)}ms`,
      `${r.warmAvgInferenceMs.toFixed(0)}ms`,
      `${r.warmAvgTotalMs.toFixed(0)}ms`,
      r.outputSize,
      r.rawMinMeters.toFixed(2),
      r.rawMaxMeters.toFixed(2),
      r.proximity,
      r.warning?.slice(0, 25) ?? "(clear)",
    ];
    console.log(`| ${row.join(" | ")} |`);
  }

  // Speedup analysis
  const baseline = results[0]!;
  console.log("\n──── Speedup vs Baseline (518×518) ────");
  for (const r of results.slice(1)) {
    const speedup = baseline.warmAvgTotalMs / r.warmAvgTotalMs;
    console.log(`  ${r.resolution}×${r.resolution}: ${speedup.toFixed(2)}x faster (warm total)`);
  }

  // Quality comparison
  console.log("\n──── Metric Quality Comparison ────");
  for (const r of results) {
    const matchesBaseline = r.proximity === baseline.proximity;
    const warningMatch = r.warning === baseline.warning;
    console.log(`  ${r.resolution}×${r.resolution}: proximity=${r.proximity} ${matchesBaseline ? "✅" : "⚠️"}, warning=${warningMatch ? "matches" : "DIFFERS"}`);
    for (const region of r.regions) {
      const baseRegion = baseline.regions.find((br) => br.region === region.region);
      const depthDiff = baseRegion ? Math.abs(region.estimatedDistanceM - baseRegion.estimatedDistanceM) : 0;
      console.log(`    ${region.region}: ${region.proximity} (est. ${region.estimatedDistanceM.toFixed(3)}m, drift: ${depthDiff.toFixed(3)}m)`);
    }
  }

  // Save JSON results
  const outputPath = resolve(projectRoot, "scripts", "benchmark-results.json");
  const jsonResults = {
    timestamp: new Date().toISOString(),
    model: "Depth-Anything-V2-Metric-Indoor-Small",
    modelType: "metric_indoor",
    image: resolvedPath,
    modelLoadMs: loadTimeMs,
    results,
  };
  writeFileSync(outputPath, JSON.stringify(jsonResults, null, 2));
  console.log(`\n📊 Results saved to: ${outputPath}`);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Benchmark Complete");
  console.log("═══════════════════════════════════════════════════════════");
}

runBenchmark().catch((error) => {
  console.error("❌ Benchmark failed:", error);
  process.exit(1);
});
