/**
 * Fine-grained directional navigation guidance.
 *
 * PURPOSE:
 * Replaces robotic "kiri aman / kanan aman" with natural Indonesian navigation
 * phrases like "sedikit ke kanan", "agak ke kiri", "jalur tengah sempit".
 *
 * ALGORITHM:
 * 1. Estimate obstacle centroid from region obstacle ratios
 * 2. Compute relative free-space on each side
 * 3. Generate directional phrase based on free-space bias
 * 4. Apply hysteresis to prevent direction oscillation
 *
 * LATENCY: <0.2ms (arithmetic on pre-computed region data)
 */

import { log } from "../../utils/logger";
import type { RegionDepth, DepthRegion, DirectionalAdvice, OccupancySeverity } from "./types";

// ─── Previous State (hysteresis) ────────────────────────────────────────────

let previousBias: number = 0;
let previousPhrase: string = "";

/** Minimum bias difference to trigger a direction change (prevents oscillation) */
const HYSTERESIS_THRESHOLD = 0.15;

// ─── Free-Space Estimation ──────────────────────────────────────────────────

/**
 * Computes the "clearance score" for a set of regions.
 * Higher score = more free space = safer to walk through.
 *
 * Uses inverse obstacle ratio weighted by region priority.
 * A region with 0% obstacles and high priority scores highest.
 */
function computeClearance(regions: RegionDepth[], targetRegions: ReadonlySet<DepthRegion>): number {
  const relevant = regions.filter((r) => targetRegions.has(r.region));
  if (relevant.length === 0) return 0;

  let totalClearance = 0;
  let totalWeight = 0;

  for (const r of relevant) {
    const clearance = (1 - r.obstacleRatio) * (1 / Math.max(r.p5Depth, 0.1));
    // Invert: more depth = more space = safer, but we want nearby-clearance
    // Actually: high obstacleRatio = blocked. Low = clear.
    const freeSpace = 1 - Math.min(r.obstacleRatio * 5, 1); // amplify ratio
    totalClearance += freeSpace * r.priority;
    totalWeight += r.priority;
  }

  return totalWeight > 0 ? totalClearance / totalWeight : 0;
}

// ─── Region Sets ────────────────────────────────────────────────────────────

const LEFT_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_left", "left", "upper_left",
]);

const RIGHT_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_right", "right", "upper_right",
]);

const CENTER_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_center", "center", "upper_center",
]);

// ─── Phrase Generation ──────────────────────────────────────────────────────

/**
 * Generates a natural Indonesian navigation phrase based on the free-space bias.
 *
 * bias < -0.4: strong left recommendation
 * bias -0.4 to -0.15: slight left recommendation
 * bias -0.15 to 0.15: center/straight
 * bias 0.15 to 0.4: slight right recommendation
 * bias > 0.4: strong right recommendation
 */
function generatePhrase(bias: number, severity: OccupancySeverity): string {
  // Clear path — no directional advice needed
  if (severity === "clear") {
    return "Tetap lurus, jalur aman.";
  }

  // Dangerous — urgent directional advice
  if (severity === "dangerous") {
    if (bias < -0.15) return "Hindari depan, arahkan ke kiri.";
    if (bias > 0.15) return "Hindari depan, arahkan ke kanan.";
    return "Perhatian, halangan di beberapa arah.";
  }

  // Directional guidance based on bias
  if (bias < -0.4) return "Sisi kiri lebih aman untuk dilewati.";
  if (bias < -0.15) return "Sedikit ke kiri, jalur lebih terbuka.";
  if (bias > 0.4) return "Sisi kanan lebih aman untuk dilewati.";
  if (bias > 0.15) return "Sedikit ke kanan, jalur lebih terbuka.";

  // Center is viable
  if (severity === "narrow") return "Jalur tengah sempit, berjalan hati-hati.";
  if (severity === "partially_blocked") return "Jalur depan sedikit terhalang, tetap waspada.";

  return "Tetap lurus.";
}

// ─── Main Guidance Function ─────────────────────────────────────────────────

/**
 * Computes fine-grained directional navigation advice.
 *
 * @param regions - The 9-region depth analysis results
 * @param severity - The current occupancy severity level
 * @returns DirectionalAdvice with phrase, bias, and change flag
 */
export function computeDirectionalAdvice(
  regions: RegionDepth[],
  severity: OccupancySeverity
): DirectionalAdvice {
  // Compute clearance for each side
  const leftClearance = computeClearance(regions, LEFT_REGIONS);
  const rightClearance = computeClearance(regions, RIGHT_REGIONS);
  const centerClearance = computeClearance(regions, CENTER_REGIONS);

  // Compute bias: negative = prefer left, positive = prefer right
  // Range: approximately -1.0 to 1.0
  const totalClearance = leftClearance + rightClearance + 0.001; // avoid div by zero
  let rawBias = (rightClearance - leftClearance) / totalClearance;

  // Dampen bias if center is very clear (no need for side advice)
  if (centerClearance > 0.8 && severity === "clear") {
    rawBias = rawBias * 0.3; // reduce directional pull when center is open
  }

  // Apply hysteresis: don't change direction if difference is marginal
  let effectiveBias = rawBias;
  const biasDelta = Math.abs(rawBias - previousBias);
  if (biasDelta < HYSTERESIS_THRESHOLD) {
    effectiveBias = previousBias; // keep previous direction
  }

  // Generate phrase
  const phrase = generatePhrase(effectiveBias, severity);

  // Determine if advice changed meaningfully
  const changed = phrase !== previousPhrase;

  // Update state
  previousBias = effectiveBias;
  previousPhrase = phrase;

  log.debug("Directional guidance", {
    leftClearance: leftClearance.toFixed(3),
    rightClearance: rightClearance.toFixed(3),
    centerClearance: centerClearance.toFixed(3),
    rawBias: rawBias.toFixed(3),
    effectiveBias: effectiveBias.toFixed(3),
    phrase,
    changed,
  });

  return { phrase, bias: effectiveBias, changed };
}

/**
 * Resets the directional state (for testing or scene changes).
 */
export function resetDirectionalState(): void {
  previousBias = 0;
  previousPhrase = "";
}
