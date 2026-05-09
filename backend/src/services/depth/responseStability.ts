/**
 * Response stability rules for narration suppression and escalation.
 *
 * PURPOSE:
 * Prevents narration spam, contradictory guidance, and rapid label changes.
 * Only allows new narration when danger meaningfully increases or the scene
 * genuinely changes.
 *
 * RULES:
 * 1. Cooldown: identical narration suppressed within NARRATION_COOLDOWN_MS
 * 2. Escalation-only: new warning only if severity increased or object changed
 * 3. Spam filter: drop repeated same-content responses
 * 4. De-escalation: shorter confirmation when danger decreases
 * 5. Change threshold: require meaningful semantic difference
 *
 * LATENCY: <0.2ms (string comparison + timestamp checks)
 */

import {
  NARRATION_COOLDOWN_MS,
  STABILITY_CHANGE_THRESHOLD,
} from "../../utils/constants";
import { log } from "../../utils/logger";
import type { OccupancySeverity } from "./types";
import { SEVERITY_VALUES } from "./types";

// ─── Previous State ─────────────────────────────────────────────────────────

/** Last narrated description (for duplicate detection) */
let lastNarratedDescription: string = "";

/** Timestamp of last narration */
let lastNarrationTime: number = 0;

/** Last severity level (for escalation detection) */
let lastSeverity: OccupancySeverity = "clear";

/** Last object identity narrated */
let lastNarratedObject: string | null = null;

// ─── Similarity Scoring ─────────────────────────────────────────────────────

/**
 * Computes a simple word-overlap similarity between two strings.
 * Returns 0.0 (completely different) to 1.0 (identical).
 *
 * Uses Jaccard similarity on word sets — fast and sufficient for
 * short Indonesian sentences.
 */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── Escalation Detection ───────────────────────────────────────────────────

/**
 * Determines if the current frame represents an escalation in danger.
 *
 * Escalation means: severity increased, or a new closer obstacle appeared,
 * or the object identity changed meaningfully.
 */
function isEscalation(
  currentSeverity: OccupancySeverity,
  currentObject: string | null
): boolean {
  const currentValue = SEVERITY_VALUES[currentSeverity];
  const previousValue = SEVERITY_VALUES[lastSeverity];

  // Severity increased
  if (currentValue > previousValue) return true;

  // Object changed (new obstacle appeared)
  if (currentObject && currentObject !== lastNarratedObject) {
    // Only count as escalation if severity is non-trivial
    if (currentValue >= SEVERITY_VALUES["partially_blocked"]) return true;
  }

  return false;
}

/**
 * Determines if the current frame represents a de-escalation.
 * Used to produce shorter confirmation messages.
 */
function isDeescalation(currentSeverity: OccupancySeverity): boolean {
  const currentValue = SEVERITY_VALUES[currentSeverity];
  const previousValue = SEVERITY_VALUES[lastSeverity];
  return currentValue < previousValue && previousValue >= SEVERITY_VALUES["blocked"];
}

// ─── Main Stability Check ───────────────────────────────────────────────────

/**
 * Result of the stability check.
 */
export interface StabilityDecision {
  /** Whether this response should be narrated to the user */
  shouldNarrate: boolean;
  /** The description to narrate (may be modified for de-escalation) */
  description: string;
  /** Reason for the decision (for debug logging) */
  reason: string;
}

/**
 * Evaluates whether a new narration should be produced.
 *
 * Decision logic (in priority order):
 * 1. First ever narration → always narrate
 * 2. Cooldown active + same content → suppress
 * 3. Escalation detected → always narrate (safety-first)
 * 4. De-escalation → narrate shorter confirmation
 * 5. High similarity to last narration → suppress
 * 6. Otherwise → narrate
 *
 * @param description - The candidate description to narrate
 * @param severity - Current occupancy severity
 * @param stabilizedObject - The stabilized object identity
 * @returns Decision on whether and what to narrate
 */
export function evaluateStability(
  description: string,
  severity: OccupancySeverity,
  stabilizedObject: string | null
): StabilityDecision {
  const now = performance.now();
  const timeSinceLastMs = now - lastNarrationTime;

  // Rule 1: First narration — always pass through
  if (lastNarrationTime === 0) {
    updateState(description, severity, stabilizedObject, now);
    return { shouldNarrate: true, description, reason: "first_narration" };
  }

  // Rule 2: Escalation — always narrate (safety-first, overrides cooldown)
  if (isEscalation(severity, stabilizedObject)) {
    updateState(description, severity, stabilizedObject, now);
    log.debug("Stability: escalation detected", {
      previousSeverity: lastSeverity,
      currentSeverity: severity,
      previousObject: lastNarratedObject,
      currentObject: stabilizedObject,
    });
    return { shouldNarrate: true, description, reason: "escalation" };
  }

  // Rule 3: Cooldown active — check similarity
  if (timeSinceLastMs < NARRATION_COOLDOWN_MS) {
    const similarity = computeSimilarity(description, lastNarratedDescription);
    if (similarity > (1 - STABILITY_CHANGE_THRESHOLD)) {
      log.debug("Stability: suppressed (cooldown + similar)", {
        similarity: similarity.toFixed(3),
        cooldownRemaining: (NARRATION_COOLDOWN_MS - timeSinceLastMs).toFixed(0),
      });
      return { shouldNarrate: false, description: lastNarratedDescription, reason: "cooldown_similar" };
    }
  }

  // Rule 4: De-escalation — shorter confirmation
  if (isDeescalation(severity)) {
    const shortDesc = buildDeescalationMessage(severity);
    updateState(shortDesc, severity, stabilizedObject, now);
    log.debug("Stability: de-escalation confirmation", {
      previousSeverity: lastSeverity,
      currentSeverity: severity,
    });
    return { shouldNarrate: true, description: shortDesc, reason: "deescalation" };
  }

  // Rule 5: High similarity to last narration — suppress
  const similarity = computeSimilarity(description, lastNarratedDescription);
  if (similarity > (1 - STABILITY_CHANGE_THRESHOLD)) {
    log.debug("Stability: suppressed (high similarity)", {
      similarity: similarity.toFixed(3),
    });
    return { shouldNarrate: false, description: lastNarratedDescription, reason: "high_similarity" };
  }

  // Rule 6: Meaningful change — narrate
  updateState(description, severity, stabilizedObject, now);
  return { shouldNarrate: true, description, reason: "meaningful_change" };
}

// ─── State Management ───────────────────────────────────────────────────────

function updateState(
  description: string,
  severity: OccupancySeverity,
  object: string | null,
  timestamp: number
): void {
  lastNarratedDescription = description;
  lastNarrationTime = timestamp;
  lastSeverity = severity;
  lastNarratedObject = object;
}

/**
 * Builds a short de-escalation confirmation message.
 */
function buildDeescalationMessage(severity: OccupancySeverity): string {
  switch (severity) {
    case "clear": return "Jalur sudah aman.";
    case "partially_blocked": return "Jalur mulai terbuka.";
    case "narrow": return "Jalur masih sempit.";
    default: return "Situasi berubah.";
  }
}

/**
 * Resets all stability state (for testing or scene changes).
 */
export function resetStabilityState(): void {
  lastNarratedDescription = "";
  lastNarrationTime = 0;
  lastSeverity = "clear";
  lastNarratedObject = null;
}
