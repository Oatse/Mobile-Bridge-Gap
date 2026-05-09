/**
 * Shared utilities for depth calibration scripts.
 * Extracted to keep the main calibration script manageable.
 *
 * Updated to support percentile-based analysis matching
 * the production depthAnalysis.ts implementation.
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { resolve, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { existsSync, statSync, readdirSync } from "fs";

// ─── Paths ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..");
export const MODEL_FILE = resolve(
  PROJECT_ROOT, "models", "Depth-Anything-V2-Metric-Indoor-Small-hf",
  "depth_anything_v2_metric_indoor_small.onnx"
);

// ─── Preprocessing Config ───────────────────────────────────────────────────

export const PREPROCESS = {
  inputSize: 518,
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
  rescaleFactor: 0.00392156862745098,
};

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// ─── Region Bounds (matches production 9-region system) ─────────────────────

export const REGION_BOUNDS: Record<string, [number, number, number, number]> = {
  lower_center: [0.30, 0.70, 0.70, 1.00],
  center:       [0.30, 0.70, 0.40, 0.70],
  lower_left:   [0.00, 0.30, 0.70, 1.00],
  lower_right:  [0.70, 1.00, 0.70, 1.00],
  left:         [0.00, 0.30, 0.40, 0.70],
  right:        [0.70, 1.00, 0.40, 0.70],
  upper_center: [0.30, 0.70, 0.00, 0.40],
  upper_left:   [0.00, 0.30, 0.00, 0.40],
  upper_right:  [0.70, 1.00, 0.00, 0.40],
};

/** Priority weights matching production REGION_CONFIGS */
export const REGION_PRIORITIES: Record<string, number> = {
  lower_center: 1.0,
  center: 0.85,
  lower_left: 0.75,
  lower_right: 0.75,
  left: 0.5,
  right: 0.5,
  upper_center: 0.3,
  upper_left: 0.2,
  upper_right: 0.2,
};

/** Safety-relevant regions (can trigger obstacle warnings) */
export const SAFETY_REGIONS = new Set([
  "lower_center", "center", "lower_left", "lower_right", "left", "right",
]);

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProximityLevel = "sangat_dekat" | "dekat" | "sedang" | "jauh";

export interface RegionResult {
  region: string;
  mean: number;
  min: number;
  max: number;
  std: number;
  p5: number;
  p10: number;
  obstacleRatio: number;
  proximity: ProximityLevel;
  /** Proximity based on p5 instead of mean */
  p5Proximity: ProximityLevel;
  priority: number;
  hasObstacle: boolean;
}

export interface Thresholds {
  sangat_dekat: number;
  dekat: number;
  sedang: number;
}

export interface TimingBreakdown {
  preprocessMs: number;
  inferenceMs: number;
  analysisMs: number;
  totalMs: number;
}

export interface ObstacleDetection {
  region: string;
  depthM: number;
  proximity: ProximityLevel;
  priority: number;
  score: number;
  distanceBucket: string;
}

export interface ImageCalibrationResult {
  filename: string;
  success: boolean;
  error?: string;
  timing?: TimingBreakdown;
  global?: { min: number; max: number; mean: number; range: number };
  regions?: RegionResult[];
  closestRegion?: string;
  warningRegion?: string | null;
  /** Nearest obstacle from percentile-based detection */
  nearestObstacle?: ObstacleDetection | null;
  expectedM?: number;
  deviation?: number;
  assistiveNarration?: string;
  memory?: { rss: string; heap: string };
  /** Debug: mean-based vs percentile-based comparison */
  comparison?: {
    meanProximity: ProximityLevel;
    percentileProximity: ProximityLevel;
    meanDepth: number;
    percentileDepth: number;
    changed: boolean;
  };
}

export interface CLIOptions {
  inputPath: string;
  isBatch: boolean;
  thresholds: Thresholds;
  isCustomThresholds: boolean;
  metadataPath: string | null;
  metadata: Record<string, number> | null;
  validate: boolean;
  debug: boolean;
  recommend: boolean;
  outputPath: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMemory(): { rss: string; heap: string } {
  const mem = process.memoryUsage();
  return { rss: formatBytes(mem.rss), heap: `${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)}` };
}

export function classifyDepth(depthMeters: number, thresholds: Thresholds): ProximityLevel {
  if (depthMeters < thresholds.sangat_dekat) return "sangat_dekat";
  if (depthMeters < thresholds.dekat) return "dekat";
  if (depthMeters < thresholds.sedang) return "sedang";
  return "jauh";
}

export function depthToDistanceBucket(depthMeters: number): string {
  if (depthMeters < 0.5) return "kurang dari setengah meter";
  if (depthMeters < 0.75) return "sekitar setengah meter";
  if (depthMeters < 1.25) return "sekitar 1 meter";
  if (depthMeters < 1.75) return "sekitar 1 setengah meter";
  if (depthMeters < 2.5) return "sekitar 2 meter";
  if (depthMeters < 3.5) return "sekitar 3 meter";
  return "beberapa meter";
}

// ─── Preprocessing ──────────────────────────────────────────────────────────

export async function preprocessImage(imageBuffer: Buffer): Promise<{
  tensor: ort.Tensor; width: number; height: number;
}> {
  const { inputSize, mean, std, rescaleFactor } = PREPROCESS;
  const { data, info } = await sharp(imageBuffer)
    .resize(inputSize, inputSize, { fit: "cover", position: "centre" })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const pixelCount = width * height;
  const tensorData = new Float32Array(3 * pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const rIdx = i * 3;
    tensorData[i] = (data[rIdx]! * rescaleFactor - mean[0]) / std[0];
    tensorData[pixelCount + i] = (data[rIdx + 1]! * rescaleFactor - mean[1]) / std[1];
    tensorData[2 * pixelCount + i] = (data[rIdx + 2]! * rescaleFactor - mean[2]) / std[2];
  }

  return { tensor: new ort.Tensor("float32", tensorData, [1, 3, height, width]), width, height };
}

// ─── Region Analysis (with percentile support) ─────────────────────────────

const MAX_DEPTH_M = 20;
const DEFAULT_PERCENTILE = 5;
const DEFAULT_OBSTACLE_MIN_RATIO = 0.005;

export function getRegionStats(
  depthData: Float32Array, width: number, height: number,
  bounds: [number, number, number, number],
  thresholds?: Thresholds
): { mean: number; min: number; max: number; std: number; p5: number; p10: number; obstacleRatio: number } {
  const [xS, xE, yS, yE] = bounds;
  const x0 = Math.floor(xS * width), x1 = Math.floor(xE * width);
  const y0 = Math.floor(yS * height), y1 = Math.floor(yE * height);
  const values: number[] = [];

  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      values.push(Math.max(0, Math.min(depthData[y * width + x]!, MAX_DEPTH_M)));

  if (values.length === 0) {
    return { mean: MAX_DEPTH_M, min: MAX_DEPTH_M, max: MAX_DEPTH_M, std: 0, p5: MAX_DEPTH_M, p10: MAX_DEPTH_M, obstacleRatio: 0 };
  }

  // Sort for percentile extraction
  values.sort((a, b) => a - b);
  const n = values.length;

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const min = values[0]!;
  const max = values[n - 1]!;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);

  const p5Idx = Math.min(Math.floor(n * DEFAULT_PERCENTILE / 100), n - 1);
  const p10Idx = Math.min(Math.floor(n * 0.10), n - 1);
  const p5 = values[p5Idx]!;
  const p10 = values[p10Idx]!;

  // Obstacle ratio: fraction below "dekat" threshold
  const dekatThreshold = thresholds?.dekat ?? 1.0;
  let closeCount = 0;
  for (let i = 0; i < n; i++) {
    if (values[i]! < dekatThreshold) closeCount++;
  }

  return { mean, min, max, std, p5, p10, obstacleRatio: closeCount / n };
}

/**
 * Detects nearest obstacle using priority-weighted percentile analysis.
 * Matches production detectNearestObstacle() logic.
 */
export function detectNearestObstacle(
  regions: RegionResult[],
  thresholds: Thresholds,
  obstacleMinRatio: number = DEFAULT_OBSTACLE_MIN_RATIO
): ObstacleDetection | null {
  let best: ObstacleDetection | null = null;
  let bestScore = 0;

  for (const r of regions) {
    if (!SAFETY_REGIONS.has(r.region)) continue;
    if (r.obstacleRatio < obstacleMinRatio) continue;

    const p5Proximity = classifyDepth(r.p5, thresholds);
    if (p5Proximity === "jauh") continue;

    const score = (1 / Math.max(r.p5, 0.1)) * r.priority;
    if (score > bestScore) {
      bestScore = score;
      best = {
        region: r.region,
        depthM: r.p5,
        proximity: p5Proximity,
        priority: r.priority,
        score,
        distanceBucket: depthToDistanceBucket(r.p5),
      };
    }
  }

  return best;
}

// ─── Histogram ──────────────────────────────────────────────────────────────

export function generateHistogram(depthData: Float32Array, maxRange: number = 10): string {
  const bins = 10;
  const counts = new Array(bins).fill(0) as number[];
  const binWidth = maxRange / bins;

  for (let i = 0; i < depthData.length; i++) {
    const v = Math.max(0, Math.min(depthData[i]!, maxRange));
    counts[Math.min(Math.floor(v / binWidth), bins - 1)]!++;
  }

  const maxCount = Math.max(...counts);
  return counts.map((c, i) => {
    const s = (i * binWidth).toFixed(1), e = ((i + 1) * binWidth).toFixed(1);
    const bar = "█".repeat(Math.round((c / maxCount) * 40));
    return `  ${s}m-${e}m |${bar} ${((c / depthData.length) * 100).toFixed(1)}%`;
  }).join("\n");
}

// ─── Debug Visualization ────────────────────────────────────────────────────

export function generateAsciiDepthGrid(
  depthData: Float32Array, width: number, height: number, thresholds: Thresholds
): string {
  const gridW = 16, gridH = 12;
  const lines: string[] = ["  ASCII Depth Grid (downsampled):"];
  lines.push("  " + "─".repeat(gridW * 5 + 2));

  for (let gy = 0; gy < gridH; gy++) {
    let row = "  │";
    for (let gx = 0; gx < gridW; gx++) {
      const sy = Math.floor((gy / gridH) * height);
      const sx = Math.floor((gx / gridW) * width);
      const d = depthData[sy * width + sx]!;
      const sym = d < thresholds.sangat_dekat ? "!" : d < thresholds.dekat ? "*" : d < thresholds.sedang ? "·" : " ";
      row += `${d.toFixed(1)}${sym}`;
      if (gx < gridW - 1) row += " ";
    }
    lines.push(row + "│");
  }

  lines.push("  " + "─".repeat(gridW * 5 + 2));
  lines.push("  Legend: ! = sangat_dekat  * = dekat  · = sedang  (space) = jauh");
  return lines.join("\n");
}

// ─── CLI Parsing ────────────────────────────────────────────────────────────

export function parseCLI(argv: string[], defaultThresholds: Thresholds): CLIOptions {
  const inputPath = argv[2];
  if (!inputPath) {
    console.error("❌ Usage: bun run depth-calibrate <image-or-directory> [options]");
    console.error("   Options: --thresholds 0.5,1.0,2.0  --metadata <json>  --validate  --debug  --recommend  --output <file>");
    process.exit(1);
  }

  const resolved = resolve(process.cwd(), inputPath);
  if (!existsSync(resolved)) {
    console.error(`❌ Path not found: ${resolved}`);
    process.exit(1);
  }

  const isBatch = statSync(resolved).isDirectory();
  const flagIdx = (f: string) => argv.indexOf(f);
  const flagVal = (f: string) => {
    const i = flagIdx(f);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1]! : null;
  };

  // Thresholds
  let thresholds = { ...defaultThresholds };
  const isCustomThresholds = flagIdx("--thresholds") !== -1;
  if (isCustomThresholds) {
    const vals = (flagVal("--thresholds") ?? "").split(",").map(Number);
    if (vals.length !== 3 || vals.some(isNaN)) {
      console.error("❌ Invalid --thresholds. Expected: 0.5,1.0,2.0");
      process.exit(1);
    }
    thresholds = { sangat_dekat: vals[0]!, dekat: vals[1]!, sedang: vals[2]! };
  }

  // Metadata
  let metadata: Record<string, number> | null = null;
  const metadataPath = flagVal("--metadata");
  if (metadataPath) {
    const mp = resolve(process.cwd(), metadataPath);
    if (!existsSync(mp)) {
      console.error(`❌ Metadata file not found: ${mp}`);
      process.exit(1);
    }
    try {
      const { readFileSync } = require("fs");
      const raw = JSON.parse(readFileSync(mp, "utf-8"));
      metadata = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith("_") && typeof v === "number") metadata[k] = v;
      }
    } catch {
      console.error("❌ Failed to parse metadata JSON");
      process.exit(1);
    }
  }

  const outputPath = flagVal("--output")
    ? resolve(process.cwd(), flagVal("--output")!)
    : resolve(PROJECT_ROOT, "scripts", "calibration-results.json");

  return {
    inputPath: resolved,
    isBatch,
    thresholds,
    isCustomThresholds,
    metadataPath,
    metadata,
    validate: flagIdx("--validate") !== -1,
    debug: flagIdx("--debug") !== -1,
    recommend: flagIdx("--recommend") !== -1,
    outputPath,
  };
}

// ─── File Discovery ─────────────────────────────────────────────────────────

export function discoverImages(dirPath: string): string[] {
  return readdirSync(dirPath)
    .filter(f => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort()
    .map(f => resolve(dirPath, f));
}
