/**
 * Type definitions for the depth estimation service.
 * Used across depthModel, depthInference, and depthAnalysis modules.
 *
 * IMPORTANT:
 * This system uses Depth-Anything-V2-Metric-Indoor-Small for
 * APPROXIMATE monocular metric depth estimation.
 * Values represent estimated meters, NOT exact measurements.
 */

// ─── Proximity Levels ───────────────────────────────────────────────────────

/**
 * Semantic proximity categories for metric depth estimation.
 * Based on approximate meter thresholds from the metric indoor model.
 */
export type ProximityLevel = "sangat_dekat" | "dekat" | "sedang" | "jauh";

/**
 * Human-readable Indonesian labels for each proximity level.
 * Uses approximate distance language — avoids false precision.
 */
export const PROXIMITY_LABELS: Record<ProximityLevel, string> = {
  sangat_dekat: "sangat dekat",
  dekat: "sekitar 1 meter",
  sedang: "sekitar 2 meter",
  jauh: "beberapa meter",
} as const;

// ─── Region Analysis ────────────────────────────────────────────────────────

/**
 * Expanded spatial region identifiers for assistive depth map analysis.
 * 9 regions provide better navigation relevance than the original 3.
 *
 * Priority order for assistive navigation:
 * - lower_center: floor directly ahead (tripping hazards)
 * - center: primary walking zone
 * - lower_left / lower_right: floor obstacles on sides
 * - left / right: side awareness
 * - upper_center: hanging obstacles (shelves, signs)
 * - upper_left / upper_right: background/ceiling (lowest priority)
 */
export type DepthRegion =
  | "lower_center"
  | "center"
  | "lower_left"
  | "lower_right"
  | "left"
  | "right"
  | "upper_left"
  | "upper_center"
  | "upper_right";

/** Depth analysis result for a single spatial region */
export interface RegionDepth {
  region: DepthRegion;
  proximity: ProximityLevel;
  /** Mean depth value in estimated meters (lower = closer) */
  meanDepth: number;
  /** 5th percentile depth — captures nearby small obstacles */
  p5Depth: number;
  /** 10th percentile depth — slightly more conservative obstacle indicator */
  p10Depth: number;
  /** Estimated distance in meters (uses p5 for obstacle-aware estimation) */
  estimatedDistanceM: number;
  /** Fraction of pixels in this region below the "dekat" threshold */
  obstacleRatio: number;
  /** Priority weight for assistive navigation (1.0 = highest) */
  priority: number;
}

// ─── Navigation Scoring ─────────────────────────────────────────────────────

/**
 * Multi-factor navigation importance score for obstacle prioritization.
 * Combines spatial, size, and positional factors into a single ranking score.
 *
 * Used to determine what gets narrated first and with what urgency.
 */
export interface NavigationScore {
  /** Urgency from proximity: 1/depth — closer = higher */
  distanceScore: number;
  /** Region priority weight (1.0 = floor center, 0.2 = upper corners) */
  regionScore: number;
  /** Obstacle coverage: obstacleRatio × 2 — larger = more blocking */
  sizeScore: number;
  /** +0.3 boost for lower_* regions (floor-level hazards) */
  floorContactScore: number;
  /** +0.2 boost for center/lower_center (direct walking path) */
  centerPathScore: number;
  /** Weighted combination of all factors */
  totalScore: number;
}

// ─── Path Occupancy ─────────────────────────────────────────────────────────

/**
 * Path occupancy analysis result — determines if walking directions are blocked.
 * Used to generate navigation guidance ("sisi kiri lebih aman").
 */
export interface PathOccupancy {
  /** Whether center walking path (lower_center + center) has obstacles */
  centerPathBlocked: boolean;
  /** Whether left path (lower_left + left) appears clear */
  leftPathClear: boolean;
  /** Whether right path (lower_right + right) appears clear */
  rightPathClear: boolean;
  /** Recommended safest direction for walking */
  safestDirection: "depan" | "kiri" | "kanan" | "tidak ada";
  /** Indonesian summary sentence for path safety */
  summary: string;
}

// ─── Obstacle Alert ─────────────────────────────────────────────────────────

/**
 * Represents a detected nearby obstacle from percentile-based analysis.
 * Used for nearest-obstacle prioritization in assistive narration.
 */
export interface ObstacleAlert {
  /** Which region detected the obstacle */
  region: DepthRegion;
  /** Estimated obstacle depth in meters (from p5 percentile) */
  depthM: number;
  /** Proximity classification of the obstacle */
  proximity: ProximityLevel;
  /** Priority weight of the region (higher = more safety-relevant) */
  priority: number;
  /** Human-readable approximate distance bucket */
  distanceBucket: string;
  /** Obstacle score: (1/depth) × priority — higher = more urgent */
  score: number;
  /** Multi-factor navigation importance score */
  navigationScore: NavigationScore;
}

// ─── Inference Results ──────────────────────────────────────────────────────

/** Raw depth inference output (internal use only — never sent to frontend) */
export interface DepthInferenceResult {
  /** Flattened depth map values in estimated meters */
  depthMap: Float32Array;
  /** Width of the depth map */
  width: number;
  /** Height of the depth map */
  height: number;
  /** Inference duration in milliseconds */
  inferenceMs: number;
}

// ─── Analysis Results ───────────────────────────────────────────────────────

/** Semantic depth analysis result — safe to include in API responses */
export interface DepthAnalysisResult {
  /** Overall proximity in the center/forward-facing region */
  proximity: ProximityLevel;
  /** Indonesian proximity warning message with approximate distance */
  warning: string | null;
  /** Per-region depth breakdown (expanded 9-region system) */
  regions: RegionDepth[];
  /** Nearest detected obstacle (null if path clear) */
  nearestObstacle: ObstacleAlert | null;
  /** Path occupancy analysis for navigation guidance */
  pathOccupancy: PathOccupancy;
  /** Total processing time (inference + analysis) in ms */
  processingMs: number;
  /** Debug statistics for calibration and testing */
  debugStats?: {
    /** Global scene mean depth */
    globalMeanDepth: number;
    /** Nearest obstacle used p5 vs mean for classification */
    classificationMethod: "percentile" | "mean";
    /** Obstacle detection details per region */
    regionDetails: Array<{
      region: string;
      meanDepth: number;
      p5Depth: number;
      obstacleRatio: number;
      hasObstacle: boolean;
    }>;
  };
}

/** Lightweight depth info for API response (subset of DepthAnalysisResult) */
export interface DepthInfo {
  proximity: string;
  warning: string | null;
}

// ─── Temporal Stability Types ───────────────────────────────────────────────

/**
 * Occupancy severity levels — replaces binary blocked/clear.
 * Ordered from safest to most dangerous for numeric comparison.
 */
export type OccupancySeverity =
  | "clear"
  | "partially_blocked"
  | "narrow"
  | "blocked"
  | "dangerous";

/** Numeric severity values for comparison (higher = more dangerous) */
export const SEVERITY_VALUES: Record<OccupancySeverity, number> = {
  clear: 0,
  partially_blocked: 1,
  narrow: 2,
  blocked: 3,
  dangerous: 4,
} as const;

/**
 * A single frame's extracted semantic data for temporal tracking.
 * Lightweight record — contains only what's needed for stabilization.
 */
export interface FrameRecord {
  /** Extracted object identity from Gemma output (null if no object identified) */
  objectIdentity: string | null;
  /** Primary region where the object was detected */
  region: DepthRegion | null;
  /** Proximity level of the nearest obstacle */
  proximity: ProximityLevel;
  /** Estimated depth in meters of the nearest obstacle */
  depthM: number;
  /** Path occupancy severity for this frame */
  severity: OccupancySeverity;
  /** The fused description produced for this frame */
  fusedDescription: string;
  /** Timestamp when this frame was processed */
  timestamp: number;
}

/**
 * Multi-factor confidence score for an extracted object identity.
 * Each factor contributes a weighted portion to the total score.
 */
export interface ObjectConfidence {
  /** Fraction of recent frames agreeing on this identity (0-1) */
  temporalAgreement: number;
  /** Whether the object type is plausible in the detected region (0-1) */
  regionPlausibility: number;
  /** Consistency of depth readings across frames (0-1) */
  depthConsistency: number;
  /** Semantic plausibility: object-in-context reasonableness (0-1) */
  semanticPlausibility: number;
  /** Whether the object is in the known objects list (0 or 1) */
  knownObjectMatch: number;
  /** Weighted total confidence score (0-1) */
  totalScore: number;
}

/**
 * Fine-grained directional navigation advice.
 * Replaces robotic "kiri aman / kanan aman" with natural Indonesian phrases.
 */
export interface DirectionalAdvice {
  /** The recommended navigation phrase in Indonesian */
  phrase: string;
  /** Relative free-space estimate: -1.0 = all left, 0 = center, 1.0 = all right */
  bias: number;
  /** Whether this advice differs meaningfully from the previous frame */
  changed: boolean;
}

/**
 * The stabilized response output after temporal processing.
 * This is what the user ultimately receives via TTS.
 */
export interface StabilizedResponse {
  /** The final stabilized description for the user */
  description: string;
  /** Whether this response should be narrated (false = suppressed) */
  shouldNarrate: boolean;
  /** The object identity after stabilization (may differ from raw extraction) */
  stabilizedObject: string | null;
  /** Confidence score for the stabilized object identity */
  confidence: ObjectConfidence;
  /** Path occupancy severity */
  severity: OccupancySeverity;
  /** Directional navigation advice */
  direction: DirectionalAdvice;
  /** Processing time for the temporal stabilization layer (ms) */
  stabilizationMs: number;
}

