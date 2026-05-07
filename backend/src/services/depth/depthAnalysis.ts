/**
 * Semantic depth analysis.
 * Converts raw depth maps into human-readable proximity warnings.
 *
 * The depth map is divided into spatial regions (center, left, right).
 * Each region gets a proximity level based on normalized depth values.
 * The center region is prioritized as the primary forward-facing area.
 *
 * IMPORTANT:
 * - This system performs RELATIVE monocular depth estimation only
 * - Values represent relative proximity, NOT metric distances
 * - Lower depth values = closer objects, higher = farther objects
 */

import {
  DEPTH_PROXIMITY_THRESHOLDS,
} from "../../utils/constants";
import { log } from "../../utils/logger";
import type {
  ProximityLevel,
  DepthRegion,
  RegionDepth,
  DepthAnalysisResult,
} from "./types";
import { PROXIMITY_LABELS } from "./types";

// ─── Region Definitions ─────────────────────────────────────────────────────

/**
 * Defines spatial regions as fractional bounding boxes of the depth map.
 * Values are [xStart, xEnd, yStart, yEnd] as fractions of width/height.
 *
 * Center = middle 40% horizontally, lower 60% vertically (primary walking zone)
 * Left/Right = side 30% horizontally, lower 60% vertically
 */
const REGION_BOUNDS: Record<DepthRegion, [number, number, number, number]> = {
  center: [0.30, 0.70, 0.40, 1.00],
  left:   [0.00, 0.30, 0.40, 1.00],
  right:  [0.70, 1.00, 0.40, 1.00],
};

// ─── Warning Phrase Pools ───────────────────────────────────────────────────

/**
 * Varied phrasing pools for region-aware warnings.
 * Avoids robotic repetition by cycling through natural phrases.
 * Index selection is deterministic based on region depth values.
 */
const CENTER_SANGAT_DEKAT_PHRASES = [
  "Objek sangat dekat di depan",
  "Ada halangan sangat dekat di depan Anda",
  "Objek sangat dekat tepat di depan",
] as const;

const CENTER_DEKAT_PHRASES = [
  "Halangan dekat di depan",
  "Ada objek dekat di depan Anda",
  "Halangan terdeteksi dekat di depan",
] as const;

const SIDE_SANGAT_DEKAT_PHRASES: Record<"left" | "right", readonly string[]> = {
  left: [
    "Objek sangat dekat di kiri",
    "Halangan sangat dekat di sisi kiri",
  ],
  right: [
    "Objek sangat dekat di kanan",
    "Halangan sangat dekat di sisi kanan",
  ],
};

const SIDE_DEKAT_PHRASES: Record<"left" | "right", readonly string[]> = {
  left: [
    "Halangan dekat di kiri",
    "Ada objek dekat di sisi kiri",
  ],
  right: [
    "Halangan dekat di kanan",
    "Ada objek dekat di sisi kanan",
  ],
};

// ─── Depth Map Processing ───────────────────────────────────────────────────

/**
 * Normalizes depth values to 0-1 range.
 * After normalization: 0 = closest, 1 = farthest.
 *
 * Note: Depth-Anything outputs relative depth where lower = farther.
 * We invert this so lower values mean CLOSER objects (more intuitive for
 * proximity warnings).
 */
function normalizeDepthMap(depthData: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < depthData.length; i++) {
    const val = depthData[i]!;
    if (val < min) min = val;
    if (val > max) max = val;
  }

  const range = max - min;
  if (range === 0) {
    // Uniform depth — return all 0.5 (medium distance)
    return new Float32Array(depthData.length).fill(0.5);
  }

  const normalized = new Float32Array(depthData.length);
  for (let i = 0; i < depthData.length; i++) {
    // Invert: Depth-Anything raw output has higher = closer
    // After inversion: 0 = closest, 1 = farthest
    normalized[i] = 1 - (depthData[i]! - min) / range;
  }

  log.debug("Depth map normalization", {
    rawMin: min.toFixed(4),
    rawMax: max.toFixed(4),
    rawRange: range.toFixed(4),
  });

  return normalized;
}

/**
 * Extracts the mean depth for a spatial region of the depth map.
 */
function getRegionMeanDepth(
  normalizedMap: Float32Array,
  width: number,
  height: number,
  bounds: [number, number, number, number]
): number {
  const [xStart, xEnd, yStart, yEnd] = bounds;
  const x0 = Math.floor(xStart * width);
  const x1 = Math.floor(xEnd * width);
  const y0 = Math.floor(yStart * height);
  const y1 = Math.floor(yEnd * height);

  let sum = 0;
  let count = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * width + x;
      sum += normalizedMap[idx]!;
      count++;
    }
  }

  return count > 0 ? sum / count : 0.5;
}

/**
 * Maps a normalized depth value (0 = closest, 1 = farthest)
 * to a semantic proximity level.
 */
function depthToProximity(meanDepth: number): ProximityLevel {
  if (meanDepth < DEPTH_PROXIMITY_THRESHOLDS.sangat_dekat) return "sangat_dekat";
  if (meanDepth < DEPTH_PROXIMITY_THRESHOLDS.dekat) return "dekat";
  if (meanDepth < DEPTH_PROXIMITY_THRESHOLDS.sedang) return "sedang";
  return "jauh";
}

// ─── Warning Generation ─────────────────────────────────────────────────────

/**
 * Selects a phrase from a pool deterministically based on depth value.
 * Ensures consistent output for the same input (no randomness).
 */
function selectPhrase(phrases: readonly string[], depthValue: number): string {
  // Use depth value fractional part to deterministically pick a phrase
  const index = Math.floor(Math.abs(depthValue * 1000)) % phrases.length;
  return phrases[index]!;
}

/**
 * Generates an Indonesian proximity warning based on region analysis.
 * Uses varied phrasing pools to avoid robotic repetition.
 * Returns null if the path appears clear.
 */
function generateWarning(regions: RegionDepth[]): string | null {
  const center = regions.find((r) => r.region === "center");
  const left = regions.find((r) => r.region === "left");
  const right = regions.find((r) => r.region === "right");

  // Priority 1: Very close object in center (highest urgency)
  if (center && center.proximity === "sangat_dekat") {
    return selectPhrase(CENTER_SANGAT_DEKAT_PHRASES, center.meanDepth);
  }

  // Priority 2: Close object in center
  if (center && center.proximity === "dekat") {
    return selectPhrase(CENTER_DEKAT_PHRASES, center.meanDepth);
  }

  // Priority 3: Very close object on sides
  const sideWarnings: string[] = [];
  if (left && left.proximity === "sangat_dekat") {
    sideWarnings.push(selectPhrase(SIDE_SANGAT_DEKAT_PHRASES.left, left.meanDepth));
  }
  if (right && right.proximity === "sangat_dekat") {
    sideWarnings.push(selectPhrase(SIDE_SANGAT_DEKAT_PHRASES.right, right.meanDepth));
  }
  if (sideWarnings.length > 0) {
    return sideWarnings.join(", ");
  }

  // Priority 4: Close objects on sides
  if (left && left.proximity === "dekat") {
    sideWarnings.push(selectPhrase(SIDE_DEKAT_PHRASES.left, left.meanDepth));
  }
  if (right && right.proximity === "dekat") {
    sideWarnings.push(selectPhrase(SIDE_DEKAT_PHRASES.right, right.meanDepth));
  }
  if (sideWarnings.length > 0) {
    return sideWarnings.join(", ");
  }

  // Path appears relatively clear
  if (center && (center.proximity === "sedang" || center.proximity === "jauh")) {
    return null; // No warning needed — path is clear
  }

  return null;
}

// ─── Main Analysis Function ─────────────────────────────────────────────────

/**
 * Converts a raw depth map into semantic proximity analysis.
 * This is the main entry point for depth interpretation.
 *
 * @param depthData - Raw depth values from the model
 * @param width - Depth map width
 * @param height - Depth map height
 * @param inferenceMs - Time taken for depth inference
 * @returns Semantic depth analysis with proximity levels and warnings
 */
export function analyzeDepthMap(
  depthData: Float32Array,
  width: number,
  height: number,
  inferenceMs: number
): DepthAnalysisResult {
  const analysisStart = performance.now();

  // Step 1: Normalize depth values to 0-1 range
  const normalized = normalizeDepthMap(depthData);

  // Step 2: Analyze each spatial region
  const regions: RegionDepth[] = (
    Object.entries(REGION_BOUNDS) as [DepthRegion, [number, number, number, number]][]
  ).map(([region, bounds]) => {
    const meanDepth = getRegionMeanDepth(normalized, width, height, bounds);
    const proximity = depthToProximity(meanDepth);

    log.debug(`Region [${region}]`, {
      meanDepth: meanDepth.toFixed(4),
      proximity,
      thresholds: {
        sangat_dekat: DEPTH_PROXIMITY_THRESHOLDS.sangat_dekat,
        dekat: DEPTH_PROXIMITY_THRESHOLDS.dekat,
        sedang: DEPTH_PROXIMITY_THRESHOLDS.sedang,
      },
    });

    return {
      region,
      proximity,
      meanDepth,
    };
  });

  // Step 3: Determine overall proximity (based on center region)
  const centerRegion = regions.find((r) => r.region === "center");
  const overallProximity: ProximityLevel = centerRegion?.proximity ?? "sedang";

  // Step 4: Generate warning message
  const warning = generateWarning(regions);

  const analysisMs = performance.now() - analysisStart;

  log.debug("Depth analysis summary", {
    overallProximity,
    warning: warning ?? "(path clear)",
    analysisMs: analysisMs.toFixed(2),
  });

  return {
    proximity: overallProximity,
    warning,
    regions,
    processingMs: inferenceMs + analysisMs,
  };
}
