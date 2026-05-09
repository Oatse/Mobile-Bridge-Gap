/**
 * Temporal memory buffer for frame-to-frame semantic stabilization.
 *
 * PURPOSE:
 * VLMs produce different object labels for the same physical object across
 * consecutive frames. This module stores recent frame semantics and uses
 * majority voting with exponential decay to stabilize object identities.
 *
 * DESIGN:
 * - Singleton rolling buffer of last N frames (configurable)
 * - Majority vote on object identity within the same spatial region
 * - Exponential decay weighting: recent frames have higher influence
 * - Automatic expiration of stale frames (scene change detection)
 * - All operations are synchronous in-memory — no I/O, no async
 *
 * LATENCY: <0.5ms per stabilization call (array ops on 5 elements)
 */

import {
  TEMPORAL_BUFFER_SIZE,
  TEMPORAL_EXPIRY_MS,
  TEMPORAL_DECAY_FACTOR,
} from "../../utils/constants";
import { log } from "../../utils/logger";
import type { FrameRecord, DepthRegion, ProximityLevel, OccupancySeverity } from "./types";

// ─── Singleton Buffer ───────────────────────────────────────────────────────

/** The rolling buffer of recent frame records */
const frameBuffer: FrameRecord[] = [];

/** Last stabilized object identity (for continuity preference) */
let lastStabilizedObject: string | null = null;

/** Last stabilized region */
let lastStabilizedRegion: DepthRegion | null = null;

// ─── Buffer Management ──────────────────────────────────────────────────────

/**
 * Purges expired frames from the buffer based on timestamp.
 * Called automatically before every read operation.
 */
function purgeExpiredFrames(): void {
  const now = performance.now();
  const cutoff = now - TEMPORAL_EXPIRY_MS;

  // Remove from front (oldest) until we find a non-expired frame
  while (frameBuffer.length > 0 && frameBuffer[0]!.timestamp < cutoff) {
    frameBuffer.shift();
  }
}

/**
 * Pushes a new frame record into the temporal buffer.
 * Automatically manages buffer size and expiration.
 *
 * @param record - The semantic data extracted from the current frame
 */
export function pushFrame(record: FrameRecord): void {
  purgeExpiredFrames();

  frameBuffer.push(record);

  // Enforce maximum buffer size (drop oldest)
  while (frameBuffer.length > TEMPORAL_BUFFER_SIZE) {
    frameBuffer.shift();
  }

  log.debug("Temporal buffer updated", {
    bufferSize: frameBuffer.length,
    latestObject: record.objectIdentity ?? "(none)",
    latestRegion: record.region ?? "(none)",
  });
}

/**
 * Returns the current buffer contents (read-only snapshot).
 * Purges expired frames first.
 */
export function getRecentFrames(): readonly FrameRecord[] {
  purgeExpiredFrames();
  return frameBuffer;
}

/**
 * Returns the number of valid (non-expired) frames in the buffer.
 */
export function getBufferSize(): number {
  purgeExpiredFrames();
  return frameBuffer.length;
}

/**
 * Clears the entire temporal buffer.
 * Used when a scene change is detected or system resets.
 */
export function clearBuffer(): void {
  frameBuffer.length = 0;
  lastStabilizedObject = null;
  lastStabilizedRegion = null;
  log.debug("Temporal buffer cleared");
}

// ─── Majority Voting ────────────────────────────────────────────────────────

/**
 * Computes exponential decay weights for the buffer.
 * Most recent frame gets weight 1.0, each older frame decays by TEMPORAL_DECAY_FACTOR.
 *
 * Example (5 frames, decay=0.6):
 * weights = [0.1296, 0.216, 0.36, 0.6, 1.0]
 */
function computeDecayWeights(count: number): number[] {
  const weights: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    // i=0 is oldest, i=count-1 is newest
    weights[i] = Math.pow(TEMPORAL_DECAY_FACTOR, count - 1 - i);
  }
  return weights;
}

/**
 * Performs weighted majority voting on object identities across recent frames.
 *
 * Algorithm:
 * 1. Filter frames to those matching the target region (or any region if null)
 * 2. Weight each frame's vote by exponential decay (newer = heavier)
 * 3. Aggregate votes per unique object identity
 * 4. Apply continuity bonus: if the previous stabilized identity matches,
 *    add a 0.3 boost (prevents oscillation on tied votes)
 * 5. Return the identity with the highest weighted vote
 *
 * @param currentObject - The object extracted from the current frame
 * @param currentRegion - The region of the current detection
 * @returns The stabilized object identity after majority voting
 */
export function stabilizeObjectIdentity(
  currentObject: string | null,
  currentRegion: DepthRegion | null
): string | null {
  purgeExpiredFrames();

  // Not enough history — pass through current identity
  if (frameBuffer.length < 2) {
    lastStabilizedObject = currentObject;
    lastStabilizedRegion = currentRegion;
    return currentObject;
  }

  // Collect all object identities from buffer (plus current frame)
  const allIdentities: Array<{ identity: string | null; weight: number }> = [];
  const weights = computeDecayWeights(frameBuffer.length);

  for (let i = 0; i < frameBuffer.length; i++) {
    const frame = frameBuffer[i]!;

    // Only consider frames from the same or adjacent region
    if (currentRegion && frame.region && !isAdjacentRegion(currentRegion, frame.region)) {
      continue;
    }

    allIdentities.push({ identity: frame.objectIdentity, weight: weights[i]! });
  }

  // Add current frame with highest weight
  allIdentities.push({ identity: currentObject, weight: 1.0 });

  // Aggregate weighted votes per identity
  const voteMap = new Map<string, number>();
  let nullVotes = 0;

  for (const { identity, weight } of allIdentities) {
    if (identity === null) {
      nullVotes += weight;
      continue;
    }
    const key = identity.toLowerCase();
    voteMap.set(key, (voteMap.get(key) ?? 0) + weight);
  }

  // Apply continuity bonus to last stabilized identity
  if (lastStabilizedObject) {
    const lastKey = lastStabilizedObject.toLowerCase();
    if (voteMap.has(lastKey)) {
      voteMap.set(lastKey, voteMap.get(lastKey)! + 0.3);
    }
  }

  // Find the identity with highest weighted vote
  let bestIdentity: string | null = null;
  let bestVote = nullVotes; // null starts with its accumulated weight

  for (const [identity, vote] of voteMap) {
    if (vote > bestVote) {
      bestVote = vote;
      bestIdentity = identity;
    }
  }

  // Update last stabilized state
  lastStabilizedObject = bestIdentity;
  lastStabilizedRegion = currentRegion;

  log.debug("Temporal majority vote", {
    currentObject,
    stabilizedObject: bestIdentity,
    voteCount: voteMap.size,
    bufferSize: frameBuffer.length,
    continuityApplied: lastStabilizedObject !== null,
  });

  return bestIdentity;
}

// ─── Region Adjacency ───────────────────────────────────────────────────────

/**
 * Region adjacency map for spatial continuity checks.
 * Adjacent regions are physically neighboring in the 3×3 grid.
 */
const ADJACENT_REGIONS: Record<DepthRegion, readonly DepthRegion[]> = {
  upper_left:   ["upper_center", "left", "center"],
  upper_center: ["upper_left", "upper_right", "center", "left", "right"],
  upper_right:  ["upper_center", "right", "center"],
  left:         ["upper_left", "center", "lower_left"],
  center:       ["upper_center", "left", "right", "lower_center", "upper_left", "upper_right", "lower_left", "lower_right"],
  right:        ["upper_right", "center", "lower_right"],
  lower_left:   ["left", "center", "lower_center"],
  lower_center: ["lower_left", "lower_right", "center", "left", "right"],
  lower_right:  ["right", "center", "lower_center"],
};

/**
 * Checks whether two regions are adjacent (or the same).
 */
function isAdjacentRegion(a: DepthRegion, b: DepthRegion): boolean {
  if (a === b) return true;
  return ADJACENT_REGIONS[a]?.includes(b) ?? false;
}

// ─── Depth Consistency ──────────────────────────────────────────────────────

/**
 * Computes depth consistency across recent frames.
 * Returns a 0-1 score where 1.0 means perfectly stable depth readings.
 *
 * Uses coefficient of variation (std/mean) to measure stability.
 * Low variation = high consistency.
 */
export function computeDepthConsistency(): number {
  purgeExpiredFrames();

  if (frameBuffer.length < 2) return 0.5; // neutral with no history

  const depths = frameBuffer.map((f) => f.depthM).filter((d) => d > 0);
  if (depths.length < 2) return 0.5;

  // Compute mean
  let sum = 0;
  for (const d of depths) sum += d;
  const mean = sum / depths.length;

  if (mean < 0.01) return 0.5; // avoid division by near-zero

  // Compute standard deviation
  let sqSum = 0;
  for (const d of depths) sqSum += (d - mean) ** 2;
  const std = Math.sqrt(sqSum / depths.length);

  // Coefficient of variation → consistency score
  // CV < 0.1 → very consistent (score ~1.0)
  // CV > 0.5 → very inconsistent (score ~0.0)
  const cv = std / mean;
  return Math.max(0, Math.min(1, 1 - cv * 2));
}

/**
 * Returns the last stabilized object identity.
 * Useful for continuity checks in other modules.
 */
export function getLastStabilizedObject(): string | null {
  return lastStabilizedObject;
}

/**
 * Returns the last stabilized region.
 */
export function getLastStabilizedRegion(): DepthRegion | null {
  return lastStabilizedRegion;
}
