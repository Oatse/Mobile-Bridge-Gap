/**
 * Occupancy severity scoring for path analysis.
 *
 * PURPOSE:
 * Replaces binary "blocked/clear" with a 5-level gradient:
 * clear → partially_blocked → narrow → blocked → dangerous
 *
 * Uses: obstacle ratio, center overlap, proximity, region coverage count.
 *
 * LATENCY: <0.2ms (arithmetic on region data already computed)
 */

import { log } from "../../utils/logger";
import type {
  RegionDepth,
  DepthRegion,
  OccupancySeverity,
} from "./types";
import { DEPTH_OBSTACLE_MIN_RATIO } from "../../utils/constants";

// ─── Severity Thresholds ────────────────────────────────────────────────────

/** Center coverage fraction thresholds */
const PARTIAL_BLOCKED_THRESHOLD = 0.10; // >10% center coverage
const NARROW_THRESHOLD = 0.30;          // >30% but gap exists
const BLOCKED_THRESHOLD = 0.60;         // >60% center coverage
const DANGEROUS_DEPTH_M = 0.5;          // obstacle within 0.5m

// ─── Region Sets ────────────────────────────────────────────────────────────

const CENTER_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_center", "center",
]);

const SIDE_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_left", "lower_right", "left", "right",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Checks if a region has a meaningful obstacle.
 */
function hasObstacle(region: RegionDepth): boolean {
  return region.obstacleRatio >= DEPTH_OBSTACLE_MIN_RATIO && region.p5Depth < 2.0;
}

/**
 * Gets the average obstacle ratio across center path regions.
 */
function getCenterCoverage(regions: RegionDepth[]): number {
  const centerRegions = regions.filter((r) => CENTER_REGIONS.has(r.region));
  if (centerRegions.length === 0) return 0;

  let totalRatio = 0;
  for (const r of centerRegions) totalRatio += r.obstacleRatio;
  return totalRatio / centerRegions.length;
}

/**
 * Counts how many side regions have obstacles.
 */
function getSideObstacleCount(regions: RegionDepth[]): number {
  return regions.filter((r) => SIDE_REGIONS.has(r.region) && hasObstacle(r)).length;
}

/**
 * Gets the minimum depth across center regions (closest obstacle).
 */
function getMinCenterDepth(regions: RegionDepth[]): number {
  const centerRegions = regions.filter((r) => CENTER_REGIONS.has(r.region));
  if (centerRegions.length === 0) return 20; // max depth

  let minDepth = 20;
  for (const r of centerRegions) {
    if (r.p5Depth < minDepth) minDepth = r.p5Depth;
  }
  return minDepth;
}

// ─── Main Severity Assessment ───────────────────────────────────────────────

/**
 * Computes the occupancy severity level for the current scene.
 *
 * Severity levels:
 * - clear: No obstacles in path regions
 * - partially_blocked: Small edge intrusion (<30% center coverage)
 * - narrow: Both sides have obstacles but center gap exists
 * - blocked: >60% center coverage by obstacles
 * - dangerous: Multiple close obstacles OR very close + blocked
 *
 * @param regions - The 9-region depth analysis results
 * @returns The computed severity level
 */
export function assessSeverity(regions: RegionDepth[]): OccupancySeverity {
  const centerCoverage = getCenterCoverage(regions);
  const sideObstacles = getSideObstacleCount(regions);
  const minCenterDepth = getMinCenterDepth(regions);
  const centerHasObstacle = regions
    .filter((r) => CENTER_REGIONS.has(r.region))
    .some(hasObstacle);

  // DANGEROUS: very close obstacle + blocked, or obstacles from multiple directions
  if (minCenterDepth < DANGEROUS_DEPTH_M && centerCoverage > PARTIAL_BLOCKED_THRESHOLD) {
    log.debug("Severity: dangerous", { minCenterDepth, centerCoverage, sideObstacles });
    return "dangerous";
  }
  if (centerHasObstacle && sideObstacles >= 3) {
    log.debug("Severity: dangerous (multi-directional)", { sideObstacles });
    return "dangerous";
  }

  // BLOCKED: high center coverage
  if (centerCoverage >= BLOCKED_THRESHOLD) {
    log.debug("Severity: blocked", { centerCoverage });
    return "blocked";
  }

  // NARROW: center partially blocked AND both sides have obstacles
  const leftBlocked = regions
    .filter((r) => r.region === "lower_left" || r.region === "left")
    .some(hasObstacle);
  const rightBlocked = regions
    .filter((r) => r.region === "lower_right" || r.region === "right")
    .some(hasObstacle);

  if (centerCoverage >= NARROW_THRESHOLD || (leftBlocked && rightBlocked)) {
    log.debug("Severity: narrow", { centerCoverage, leftBlocked, rightBlocked });
    return "narrow";
  }

  // PARTIALLY BLOCKED: small center intrusion
  if (centerCoverage >= PARTIAL_BLOCKED_THRESHOLD || centerHasObstacle) {
    log.debug("Severity: partially_blocked", { centerCoverage });
    return "partially_blocked";
  }

  // CLEAR: no meaningful obstacles in path
  return "clear";
}

// ─── Severity-Aware Phrases ─────────────────────────────────────────────────

/**
 * Indonesian severity phrases for narration.
 */
const SEVERITY_PHRASES: Record<OccupancySeverity, string> = {
  clear: "Jalur depan relatif aman.",
  partially_blocked: "Jalur depan sedikit terhalang.",
  narrow: "Jalur tengah sempit, berjalan hati-hati.",
  blocked: "Jalur depan terhalang.",
  dangerous: "Perhatian, beberapa halangan di sekitar. Berjalan sangat hati-hati.",
};

/**
 * Returns the Indonesian phrase for a given severity level.
 */
export function getSeverityPhrase(severity: OccupancySeverity): string {
  return SEVERITY_PHRASES[severity];
}
