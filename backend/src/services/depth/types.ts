/**
 * Type definitions for the depth estimation service.
 * Used across depthModel, depthInference, and depthAnalysis modules.
 */

// ─── Proximity Levels ───────────────────────────────────────────────────────

/**
 * Semantic proximity categories for relative depth estimation.
 * These are NOT metric distances — they represent relative proximity only.
 */
export type ProximityLevel = "sangat_dekat" | "dekat" | "sedang" | "jauh";

/** Human-readable Indonesian labels for each proximity level */
export const PROXIMITY_LABELS: Record<ProximityLevel, string> = {
  sangat_dekat: "sangat dekat",
  dekat: "dekat",
  sedang: "jarak sedang",
  jauh: "jauh",
} as const;

// ─── Region Analysis ────────────────────────────────────────────────────────

/** Spatial region identifiers for depth map analysis */
export type DepthRegion = "center" | "left" | "right";

/** Depth analysis result for a single spatial region */
export interface RegionDepth {
  region: DepthRegion;
  proximity: ProximityLevel;
  /** Normalized mean depth value (0 = closest, 1 = farthest) */
  meanDepth: number;
}

// ─── Inference Results ──────────────────────────────────────────────────────

/** Raw depth inference output (internal use only — never sent to frontend) */
export interface DepthInferenceResult {
  /** Flattened depth map values (normalized 0-1) */
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
  /** Indonesian proximity warning message */
  warning: string | null;
  /** Per-region depth breakdown */
  regions: RegionDepth[];
  /** Total processing time (inference + analysis) in ms */
  processingMs: number;
}

/** Lightweight depth info for API response (subset of DepthAnalysisResult) */
export interface DepthInfo {
  proximity: string;
  warning: string | null;
}
