/**
 * Semantic depth analysis for metric indoor model.
 * Converts raw metric depth maps into human-readable proximity warnings.
 *
 * ARCHITECTURE:
 * The depth map is divided into 9 priority-weighted assistive regions.
 * Each region gets percentile-based depth analysis instead of mean-only.
 * The nearest meaningful obstacle is prioritized for assistive narration.
 *
 * KEY DESIGN DECISION:
 * Mean depth suppresses small nearby obstacles (e.g., scissors on floor).
 * Percentile-based analysis (p5) captures obstacles occupying ≥5% of a region,
 * while noise protection (obstacle ratio threshold) filters spurious detections.
 *
 * IMPORTANT:
 * - This system uses Depth-Anything-V2-Metric-Indoor-Small
 * - Output values represent APPROXIMATE meters (not exact measurements)
 * - Lower depth values = closer objects (metric convention)
 * - Do NOT claim centimeter-level accuracy
 * - Use bucketed language: "sekitar 1 meter", NOT "1.14 meter"
 */

import {
  DEPTH_PROXIMITY_THRESHOLDS,
  DEPTH_MAX_DEPTH_M,
  DEPTH_OBSTACLE_MIN_RATIO,
  DEPTH_ANALYSIS_PERCENTILE,
} from "../../utils/constants";
import { log } from "../../utils/logger";
import type {
  ProximityLevel,
  DepthRegion,
  RegionDepth,
  DepthAnalysisResult,
  ObstacleAlert,
  NavigationScore,
  PathOccupancy,
} from "./types";
import { PROXIMITY_LABELS } from "./types";

// ─── Region Definitions ─────────────────────────────────────────────────────

/**
 * 9 assistive regions with priority weights for indoor navigation.
 *
 * Bounds are [xStart, xEnd, yStart, yEnd] as fractions of width/height.
 * Priority weights reflect safety relevance:
 * - Lower regions detect floor-level hazards (tripping, stepping)
 * - Center regions detect forward-path obstacles
 * - Upper regions are informational only (ceiling, background)
 */
interface RegionConfig {
  bounds: [number, number, number, number];
  priority: number;
}

const REGION_CONFIGS: Record<DepthRegion, RegionConfig> = {
  // VERY HIGH PRIORITY — floor directly ahead
  lower_center: { bounds: [0.30, 0.70, 0.70, 1.00], priority: 1.0 },
  // HIGH PRIORITY — primary walking zone
  center:       { bounds: [0.30, 0.70, 0.40, 0.70], priority: 0.85 },
  // MEDIUM PRIORITY — floor sides
  lower_left:   { bounds: [0.00, 0.30, 0.70, 1.00], priority: 0.75 },
  lower_right:  { bounds: [0.70, 1.00, 0.70, 1.00], priority: 0.75 },
  // MEDIUM-LOW PRIORITY — side awareness
  left:         { bounds: [0.00, 0.30, 0.40, 0.70], priority: 0.5 },
  right:        { bounds: [0.70, 1.00, 0.40, 0.70], priority: 0.5 },
  // LOW PRIORITY — background/ceiling
  upper_center: { bounds: [0.30, 0.70, 0.00, 0.40], priority: 0.3 },
  upper_left:   { bounds: [0.00, 0.30, 0.00, 0.40], priority: 0.2 },
  upper_right:  { bounds: [0.70, 1.00, 0.00, 0.40], priority: 0.2 },
};

/**
 * Only these regions can trigger safety warnings.
 * Upper regions are excluded to avoid false alerts from ceilings/walls.
 */
const SAFETY_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_center", "center", "lower_left", "lower_right", "left", "right",
]);

// ─── Warning Phrase Pools ───────────────────────────────────────────────────

/**
 * Obstacle-first warning phrases organized by region position and proximity.
 * Uses natural, assistive Indonesian with approximate distance language.
 */
const OBSTACLE_PHRASES: Record<string, readonly string[]> = {
  // Floor-level obstacles — use semantic categories, not generic "objek"
  "floor_sangat_dekat": [
    "Perhatian, ada halangan sangat dekat di lantai depan Anda",
    "Hati-hati, penghalang di lantai sangat dekat di depan",
    "Ada benda kecil sangat dekat di lantai, kurang dari setengah meter",
  ],
  "floor_dekat": [
    "Ada halangan di lantai depan Anda, sekitar 1 meter",
    "Penghalang di lantai depan, sekitar 1 meter",
    "Terdapat benda kecil di lantai depan Anda, sekitar 1 meter",
  ],
  "floor_sedang": [
    "Ada halangan di lantai depan, sekitar 2 meter",
    "Terdapat penghalang di lantai depan, sekitar 2 meter",
  ],

  // Center walking zone — emphasize path blockage
  "center_sangat_dekat": [
    "Halangan sangat dekat di jalur depan, kurang dari setengah meter",
    "Ada penghalang sangat dekat di jalur depan Anda",
    "Furnitur sangat dekat tepat di jalur depan, hati-hati",
  ],
  "center_dekat": [
    "Halangan sekitar 1 meter di jalur depan",
    "Ada penghalang dekat di jalur depan Anda, sekitar 1 meter",
    "Furnitur terdeteksi dekat di jalur depan",
  ],
  "center_sedang": [
    "Ada halangan sekitar 2 meter di jalur depan",
    "Penghalang terdeteksi di jalur depan, sekitar 2 meter",
  ],

  // Side obstacles — use position-aware language
  "left_sangat_dekat": [
    "Halangan sangat dekat di sisi kiri",
    "Penghalang sangat dekat di kiri Anda",
  ],
  "left_dekat": [
    "Halangan sekitar 1 meter di sisi kiri",
    "Ada penghalang dekat di sisi kiri",
  ],
  "right_sangat_dekat": [
    "Halangan sangat dekat di sisi kanan",
    "Penghalang sangat dekat di kanan Anda",
  ],
  "right_dekat": [
    "Halangan sekitar 1 meter di sisi kanan",
    "Ada penghalang dekat di sisi kanan",
  ],
};

// ─── Depth Map Processing ───────────────────────────────────────────────────

/**
 * Clamps depth values to valid range and handles edge cases.
 * The metric model may output values outside 0-max_depth range.
 */
function clampDepth(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > DEPTH_MAX_DEPTH_M) return DEPTH_MAX_DEPTH_M;
  return value;
}

/**
 * Computes comprehensive depth statistics for a spatial region.
 * Returns mean, percentiles (p5, p10), min, std, and obstacle ratio.
 *
 * Key improvement over previous mean-only approach:
 * - p5 captures small nearby obstacles that barely affect the mean
 * - obstacleRatio indicates what fraction of the region has "close" depth
 * - Both together enable reliable obstacle detection with noise protection
 */
function getRegionDepthStats(
  depthData: Float32Array,
  width: number,
  height: number,
  bounds: [number, number, number, number]
): {
  mean: number;
  p5: number;
  p10: number;
  min: number;
  std: number;
  obstacleRatio: number;
} {
  const [xStart, xEnd, yStart, yEnd] = bounds;
  const x0 = Math.floor(xStart * width);
  const x1 = Math.floor(xEnd * width);
  const y0 = Math.floor(yStart * height);
  const y1 = Math.floor(yEnd * height);

  // Collect all clamped depth values in the region
  const values: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      values.push(clampDepth(depthData[y * width + x]!));
    }
  }

  if (values.length === 0) {
    return { mean: DEPTH_MAX_DEPTH_M, p5: DEPTH_MAX_DEPTH_M, p10: DEPTH_MAX_DEPTH_M, min: DEPTH_MAX_DEPTH_M, std: 0, obstacleRatio: 0 };
  }

  // Sort ascending for percentile extraction
  values.sort((a, b) => a - b);

  const n = values.length;
  const min = values[0]!;
  const p5Idx = Math.floor(n * DEPTH_ANALYSIS_PERCENTILE / 100);
  const p10Idx = Math.floor(n * 0.10);
  const p5 = values[Math.min(p5Idx, n - 1)]!;
  const p10 = values[Math.min(p10Idx, n - 1)]!;

  // Mean and std
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i]!;
  const mean = sum / n;

  let sqSum = 0;
  for (let i = 0; i < n; i++) sqSum += (values[i]! - mean) ** 2;
  const std = Math.sqrt(sqSum / n);

  // Obstacle ratio: fraction of pixels below "dekat" threshold (1.0m)
  let closeCount = 0;
  for (let i = 0; i < n; i++) {
    if (values[i]! < DEPTH_PROXIMITY_THRESHOLDS.dekat) closeCount++;
  }
  const obstacleRatio = closeCount / n;

  return { mean, p5, p10, min, std, obstacleRatio };
}

/**
 * Maps an estimated meter depth value to a semantic proximity level.
 * Lower meter value = closer object = more urgent.
 */
function depthToProximity(depthMeters: number): ProximityLevel {
  if (depthMeters < DEPTH_PROXIMITY_THRESHOLDS.sangat_dekat) return "sangat_dekat";
  if (depthMeters < DEPTH_PROXIMITY_THRESHOLDS.dekat) return "dekat";
  if (depthMeters < DEPTH_PROXIMITY_THRESHOLDS.sedang) return "sedang";
  return "jauh";
}

/**
 * Maps depth to an approximate distance bucket string for narration.
 */
function depthToDistanceBucket(depthMeters: number): string {
  if (depthMeters < 0.5) return "kurang dari setengah meter";
  if (depthMeters < 0.75) return "sekitar setengah meter";
  if (depthMeters < 1.25) return "sekitar 1 meter";
  if (depthMeters < 1.75) return "sekitar 1 setengah meter";
  if (depthMeters < 2.5) return "sekitar 2 meter";
  if (depthMeters < 3.5) return "sekitar 3 meter";
  return "beberapa meter";
}

// ─── Navigation Scoring ─────────────────────────────────────────────────────

/** Regions considered floor-level (receive floor-contact score boost) */
const FLOOR_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_center", "lower_left", "lower_right",
]);

/** Regions on the direct center walking path (receive center-path boost) */
const CENTER_PATH_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_center", "center",
]);

/**
 * Calculates a multi-factor navigation importance score for an obstacle.
 *
 * Factors:
 * - distanceScore: 1/depth — closer objects score higher
 * - regionScore: region priority weight (from REGION_CONFIGS)
 * - sizeScore: obstacleRatio × 2 — larger obstacles block more path
 * - floorContactScore: +0.3 for lower_* regions (floor hazards)
 * - centerPathScore: +0.2 for center/lower_center (direct path)
 */
function calculateNavigationScore(
  region: DepthRegion,
  depthM: number,
  priority: number,
  obstacleRatio: number
): NavigationScore {
  const distanceScore = 1 / Math.max(depthM, 0.1);
  const regionScore = priority;
  const sizeScore = Math.min(obstacleRatio * 2, 1.0);
  const floorContactScore = FLOOR_REGIONS.has(region) ? 0.3 : 0;
  const centerPathScore = CENTER_PATH_REGIONS.has(region) ? 0.2 : 0;

  // Weighted combination: distance is most important, then region, then size
  const totalScore =
    distanceScore * 0.4 +
    regionScore * 0.25 +
    sizeScore * 0.15 +
    floorContactScore * 0.1 +
    centerPathScore * 0.1;

  return {
    distanceScore,
    regionScore,
    sizeScore,
    floorContactScore,
    centerPathScore,
    totalScore,
  };
}

// ─── Path Occupancy Analysis ────────────────────────────────────────────────

/**
 * Analyzes whether the main walking directions are blocked or clear.
 * Uses obstacle detection results from all safety regions.
 *
 * A direction is "blocked" if any of its constituent regions has a
 * nearby obstacle (p5 proximity ≠ "jauh" AND obstacle ratio above threshold).
 */
function analyzePathOccupancy(regions: RegionDepth[]): PathOccupancy {
  // Helper: check if a region has a meaningful close obstacle
  const hasObstacle = (regionName: DepthRegion): boolean => {
    const r = regions.find((x) => x.region === regionName);
    if (!r) return false;
    return r.obstacleRatio >= DEPTH_OBSTACLE_MIN_RATIO && depthToProximity(r.p5Depth) !== "jauh";
  };

  const centerPathBlocked =
    hasObstacle("lower_center") || hasObstacle("center");
  const leftPathClear =
    !hasObstacle("lower_left") && !hasObstacle("left");
  const rightPathClear =
    !hasObstacle("lower_right") && !hasObstacle("right");

  // Determine safest direction
  let safestDirection: PathOccupancy["safestDirection"];
  let summary: string;

  if (!centerPathBlocked) {
    safestDirection = "depan";
    summary = "Jalur depan relatif aman.";
  } else if (leftPathClear && rightPathClear) {
    // Center blocked, both sides clear — prefer left (pedestrian convention)
    safestDirection = "kiri";
    summary = "Jalur depan terhalang. Sisi kiri dan kanan tampak aman.";
  } else if (leftPathClear) {
    safestDirection = "kiri";
    summary = "Jalur depan terhalang. Sisi kiri tampak lebih aman.";
  } else if (rightPathClear) {
    safestDirection = "kanan";
    summary = "Jalur depan terhalang. Sisi kanan tampak lebih aman.";
  } else {
    safestDirection = "tidak ada";
    summary = "Perhatian, halangan di beberapa arah. Berjalan dengan sangat hati-hati.";
  }

  return { centerPathBlocked, leftPathClear, rightPathClear, safestDirection, summary };
}

// ─── Obstacle Detection ─────────────────────────────────────────────────────

/**
 * Detects the nearest meaningful obstacle across all safety-relevant regions.
 *
 * Algorithm:
 * 1. For each safety region, compute p5 depth (5th percentile)
 * 2. Require obstacle ratio > DEPTH_OBSTACLE_MIN_RATIO (noise protection)
 * 3. Calculate navigation importance score (multi-factor)
 * 4. Return the highest-scoring region as the nearest obstacle
 *
 * Navigation score factors: distance urgency, region priority, obstacle size,
 * floor-contact bonus, center-path bonus.
 */
function detectNearestObstacle(
  regions: RegionDepth[]
): ObstacleAlert | null {
  let bestAlert: ObstacleAlert | null = null;
  let bestScore = 0;

  for (const region of regions) {
    // Skip non-safety regions (upper background)
    if (!SAFETY_REGIONS.has(region.region)) continue;

    // Noise protection: require minimum obstacle ratio
    if (region.obstacleRatio < DEPTH_OBSTACLE_MIN_RATIO) continue;

    // Use p5 for obstacle depth estimation
    const effectiveDepth = region.p5Depth;
    const proximity = depthToProximity(effectiveDepth);

    // Only alert for "sangat_dekat", "dekat", or "sedang" obstacles
    if (proximity === "jauh") continue;

    // Calculate multi-factor navigation importance score
    const navigationScore = calculateNavigationScore(
      region.region,
      effectiveDepth,
      region.priority,
      region.obstacleRatio
    );

    // Legacy score for backward compatibility
    const score = (1 / Math.max(effectiveDepth, 0.1)) * region.priority;

    if (navigationScore.totalScore > bestScore) {
      bestScore = navigationScore.totalScore;
      bestAlert = {
        region: region.region,
        depthM: effectiveDepth,
        proximity,
        priority: region.priority,
        distanceBucket: depthToDistanceBucket(effectiveDepth),
        score,
        navigationScore,
      };
    }
  }

  return bestAlert;
}

// ─── Warning Generation ─────────────────────────────────────────────────────

/**
 * Selects a phrase from a pool deterministically based on depth value.
 * Ensures consistent output for the same input (no randomness).
 */
function selectPhrase(phrases: readonly string[], depthValue: number): string {
  const index = Math.floor(Math.abs(depthValue * 1000)) % phrases.length;
  return phrases[index]!;
}

/**
 * Maps a region to a phrase category key for OBSTACLE_PHRASES lookup.
 */
function getRegionPhraseCategory(region: DepthRegion): string {
  if (region === "lower_center" || region === "lower_left" || region === "lower_right") {
    return "floor";
  }
  if (region === "left") return "left";
  if (region === "right") return "right";
  return "center";
}

/**
 * Generates an Indonesian proximity warning based on obstacle-first analysis.
 *
 * Priority order:
 * 1. Nearest obstacle alert (from percentile analysis) — if found
 * 2. General walking-path awareness (from mean-based center check)
 * 3. Null if path appears clear
 */
function generateWarning(
  regions: RegionDepth[],
  nearestObstacle: ObstacleAlert | null
): string | null {
  // Priority 1: Nearest obstacle detected via percentile analysis
  if (nearestObstacle) {
    const category = getRegionPhraseCategory(nearestObstacle.region);
    const phraseKey = `${category}_${nearestObstacle.proximity}`;
    const phrases = OBSTACLE_PHRASES[phraseKey];

    if (phrases && phrases.length > 0) {
      return selectPhrase(phrases, nearestObstacle.depthM);
    }

    // Fallback: generic obstacle warning with position
    const positionMap: Partial<Record<DepthRegion, string>> = {
      lower_center: "di lantai depan",
      center: "di depan",
      lower_left: "di lantai kiri",
      lower_right: "di lantai kanan",
      left: "di sisi kiri",
      right: "di sisi kanan",
    };
    const position = positionMap[nearestObstacle.region] ?? "di depan";
    return `Halangan ${PROXIMITY_LABELS[nearestObstacle.proximity]} ${position}`;
  }

  // Priority 2: Check if any safety region has mean-based close proximity
  // (catches large obstacles that affect the mean significantly)
  const centerRegions = regions.filter(
    (r) => (r.region === "lower_center" || r.region === "center") && r.proximity !== "jauh"
  );
  if (centerRegions.length > 0) {
    const closest = centerRegions.sort((a, b) => a.meanDepth - b.meanDepth)[0]!;
    if (closest.proximity === "sedang") {
      const phrases = OBSTACLE_PHRASES["center_sedang"];
      if (phrases) return selectPhrase(phrases, closest.meanDepth);
    }
  }

  // Path appears clear
  return null;
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Logs raw depth statistics for diagnostic and calibration purposes.
 */
function logDepthStatistics(depthData: Float32Array): number {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (let i = 0; i < depthData.length; i++) {
    const val = depthData[i]!;
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
  }

  const mean = sum / depthData.length;

  log.debug("Metric depth raw statistics", {
    minMeters: min.toFixed(3),
    maxMeters: max.toFixed(3),
    meanMeters: mean.toFixed(3),
    pixelCount: depthData.length,
  });

  return mean;
}

// ─── Main Analysis Function ─────────────────────────────────────────────────

/**
 * Converts a raw metric depth map into semantic proximity analysis
 * with percentile-based obstacle prioritization.
 *
 * This is the main entry point for depth interpretation.
 *
 * For the metric indoor model:
 * - Raw values are in approximate meters (lower = closer)
 * - No normalization/inversion needed
 * - Thresholds are in meters (0.5m, 1.0m, 2.0m)
 *
 * Key improvement: uses p5 percentile for obstacle detection instead of mean.
 * This ensures small nearby objects (e.g., scissors on floor) are detected
 * even when the scene-wide average depth is large.
 *
 * @param depthData - Raw depth values from the metric model (in meters)
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

  // Log raw depth statistics and get global mean for scene context
  const globalMeanDepth = logDepthStatistics(depthData);

  // Analyze each spatial region with percentile statistics
  const regions: RegionDepth[] = (
    Object.entries(REGION_CONFIGS) as [DepthRegion, RegionConfig][]
  ).map(([region, config]) => {
    const stats = getRegionDepthStats(depthData, width, height, config.bounds);

    // Use p5 for proximity classification (obstacle-aware)
    // Fall back to mean if obstacle ratio is too low (noise protection)
    const effectiveDepth = stats.obstacleRatio >= DEPTH_OBSTACLE_MIN_RATIO
      ? stats.p5
      : stats.mean;
    const proximity = depthToProximity(effectiveDepth);

    log.debug(`Region [${region}]`, {
      meanM: stats.mean.toFixed(3),
      p5M: stats.p5.toFixed(3),
      p10M: stats.p10.toFixed(3),
      minM: stats.min.toFixed(3),
      obstacleRatio: (stats.obstacleRatio * 100).toFixed(2) + "%",
      effectiveDepth: effectiveDepth.toFixed(3),
      proximity,
      priority: config.priority,
    });

    return {
      region,
      proximity,
      meanDepth: stats.mean,
      p5Depth: stats.p5,
      p10Depth: stats.p10,
      estimatedDistanceM: effectiveDepth,
      obstacleRatio: stats.obstacleRatio,
      priority: config.priority,
    };
  });

  // Detect nearest meaningful obstacle using navigation-scored percentile analysis
  const nearestObstacle = detectNearestObstacle(regions);

  // Analyze path occupancy for navigation guidance
  const pathOccupancy = analyzePathOccupancy(regions);

  // Determine overall proximity:
  // If obstacle detected → use obstacle proximity (safety-first)
  // Otherwise → use center region mean proximity (scene-level)
  const overallProximity: ProximityLevel = nearestObstacle
    ? nearestObstacle.proximity
    : (regions.find((r) => r.region === "lower_center")?.proximity ??
       regions.find((r) => r.region === "center")?.proximity ??
       "sedang");

  // Generate warning message with obstacle-first prioritization
  const warning = generateWarning(regions, nearestObstacle);

  const analysisMs = performance.now() - analysisStart;

  // Build debug stats for calibration scripts
  const debugStats = {
    globalMeanDepth,
    classificationMethod: (nearestObstacle ? "percentile" : "mean") as "percentile" | "mean",
    regionDetails: regions.map((r) => ({
      region: r.region,
      meanDepth: r.meanDepth,
      p5Depth: r.p5Depth,
      obstacleRatio: r.obstacleRatio,
      hasObstacle: r.obstacleRatio >= DEPTH_OBSTACLE_MIN_RATIO && depthToProximity(r.p5Depth) !== "jauh",
    })),
  };

  log.debug("Depth analysis summary", {
    overallProximity,
    label: PROXIMITY_LABELS[overallProximity],
    nearestObstacle: nearestObstacle
      ? `${nearestObstacle.region} @ ${nearestObstacle.depthM.toFixed(3)}m (${nearestObstacle.proximity}) navScore=${nearestObstacle.navigationScore.totalScore.toFixed(3)}`
      : "(none)",
    pathOccupancy: pathOccupancy.summary,
    classificationMethod: debugStats.classificationMethod,
    warning: warning ?? "(path clear)",
    analysisMs: analysisMs.toFixed(2),
  });

  return {
    proximity: overallProximity,
    warning,
    regions,
    nearestObstacle,
    pathOccupancy,
    processingMs: inferenceMs + analysisMs,
    debugStats,
  };
}
