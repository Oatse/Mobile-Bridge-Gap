/**
 * Response fusion layer for combining Gemma scene descriptions with depth analysis.
 *
 * Responsibilities:
 * - Merge Gemma understanding with depth proximity warnings
 * - Prioritize safety-critical information
 * - Avoid awkward phrasing, duplication, and contradictions
 * - Produce natural-sounding Indonesian assistive responses
 *
 * Design principles:
 * - Deterministic rule-based fusion (no LLM post-processing)
 * - Safety-first: proximity warnings override descriptive richness
 * - Region-aware: left/right/center awareness in output
 * - Failsafe: text sanitation catches edge cases
 */

import type { DepthAnalysisResult } from "./types";
import { PROXIMITY_LABELS, type ProximityLevel } from "./types";
import type { DepthInfo } from "../../types";
import { log } from "../../utils/logger";

// ─── Fusion Constants ───────────────────────────────────────────────────────

/** Safety prefix for urgent proximity warnings */
const SAFETY_PREFIX = "Perhatian, ";

/**
 * Proximity levels that trigger safety-first response mode.
 * When center region is at these levels, warning clarity takes priority.
 */
const SAFETY_CRITICAL_LEVELS: ReadonlySet<ProximityLevel> = new Set([
  "sangat_dekat",
  "dekat",
]);

// ─── Text Sanitation ────────────────────────────────────────────────────────

/**
 * Sanitizes fused text to prevent awkward or broken output.
 *
 * Rules:
 * 1. Remove consecutive duplicate words (e.g., "kursi dekat kursi" → "kursi dekat")
 * 2. Remove double punctuation (e.g., ".." → ".")
 * 3. Normalize whitespace
 * 4. Ensure proper sentence ending
 */
function sanitizeFusedText(text: string): string {
  let result = text;

  // Remove consecutive duplicate words (case-insensitive)
  result = result.replace(/\b(\w+)\s+\1\b/gi, "$1");

  // Remove double punctuation
  result = result.replace(/([.!?])\1+/g, "$1");
  result = result.replace(/\.\s*\./g, ".");

  // Normalize whitespace
  result = result.replace(/\s{2,}/g, " ").trim();

  // Ensure proper ending punctuation
  if (result && !/[.!?]$/.test(result)) {
    result += ".";
  }

  return result;
}

/**
 * Detects contradictory safety statements in text.
 * Returns true if text contains both "safe" and "danger" indicators.
 */
function hasContradiction(text: string): boolean {
  const safeIndicators = ["aman", "terbuka", "bebas", "kosong"];
  const dangerIndicators = ["bahaya", "halangan", "sangat dekat", "hati-hati", "perhatian"];

  const hasSafe = safeIndicators.some((w) => text.toLowerCase().includes(w));
  const hasDanger = dangerIndicators.some((w) => text.toLowerCase().includes(w));

  return hasSafe && hasDanger;
}

// ─── Fusion Logic ───────────────────────────────────────────────────────────

/**
 * Determines if a depth result requires safety-first response mode.
 * Safety mode prepends a warning and prioritizes warning clarity.
 */
function isSafetyCritical(depthResult: DepthAnalysisResult): boolean {
  return SAFETY_CRITICAL_LEVELS.has(depthResult.proximity);
}

/**
 * Attempts to inject proximity context into a Gemma description
 * by replacing "di depan" with proximity-qualified "di depan".
 *
 * Returns null if injection is not applicable.
 */
function tryInjectProximity(
  description: string,
  depthResult: DepthAnalysisResult
): string | null {
  const proximityLabel = PROXIMITY_LABELS[depthResult.proximity];

  // Only inject if Gemma mentions "di depan" without existing proximity qualifier
  const hasFrontMention = description.includes("di depan");
  const hasExistingProximity =
    description.includes("dekat") ||
    description.includes("jauh") ||
    description.includes("sangat dekat");

  if (!hasFrontMention || hasExistingProximity) {
    return null;
  }

  // Only inject for close/very close proximity
  if (!SAFETY_CRITICAL_LEVELS.has(depthResult.proximity)) {
    return null;
  }

  return description.replace("di depan", `${proximityLabel} di depan`);
}

/**
 * Builds a safety-prefixed response when center proximity is critical.
 * Prepends "Perhatian, " to the warning for urgency.
 */
function buildSafetyResponse(
  gemmaDescription: string,
  depthResult: DepthAnalysisResult
): string {
  const warning = depthResult.warning;
  if (!warning) return gemmaDescription;

  // If Gemma already contains safety-critical phrasing, don't duplicate
  if (
    gemmaDescription.toLowerCase().includes("perhatian") ||
    gemmaDescription.toLowerCase().includes("hati-hati")
  ) {
    // Just append depth context as a clause
    const trimmed = gemmaDescription.replace(/[.!?]\s*$/, "");
    return `${trimmed}. ${warning}.`;
  }

  // For sangat_dekat: urgent prefix
  if (depthResult.proximity === "sangat_dekat") {
    const trimmed = gemmaDescription.replace(/[.!?]\s*$/, "");
    return `${SAFETY_PREFIX}${warning.toLowerCase()}. ${trimmed}.`;
  }

  // For dekat: inject proximity or append
  const injected = tryInjectProximity(gemmaDescription, depthResult);
  if (injected) {
    return injected;
  }

  // Fallback: append warning as separate clause
  const trimmed = gemmaDescription.replace(/[.!?]\s*$/, "");
  return `${trimmed}. ${warning}.`;
}

/**
 * Builds a standard (non-safety-critical) enriched response.
 * Adds depth context without urgency framing.
 */
function buildEnrichedResponse(
  gemmaDescription: string,
  depthResult: DepthAnalysisResult
): string {
  // No warning = no enrichment needed
  if (!depthResult.warning) {
    return gemmaDescription;
  }

  // Try proximity injection first
  const injected = tryInjectProximity(gemmaDescription, depthResult);
  if (injected) {
    return injected;
  }

  // Append warning as separate clause
  const proximityLabel = PROXIMITY_LABELS[depthResult.proximity];
  if (!gemmaDescription.includes(proximityLabel)) {
    const trimmed = gemmaDescription.replace(/[.!?]\s*$/, "");
    return `${trimmed}. ${depthResult.warning}.`;
  }

  return gemmaDescription;
}

// ─── Main Fusion API ────────────────────────────────────────────────────────

/**
 * Fuses a Gemma scene description with depth proximity analysis.
 *
 * Fusion rules (priority order):
 * 1. If no depth result → return Gemma description unchanged
 * 2. If safety-critical proximity → prepend warning, prioritize clarity
 * 3. If depth has warning → inject or append proximity context
 * 4. If no warning (path clear) → return Gemma description unchanged
 *
 * Text sanitation is applied to the final output to catch:
 * - Duplicate words
 * - Contradictory statements
 * - Double punctuation
 *
 * @param gemmaDescription - Sanitized scene description from Gemma model
 * @param depthResult - Semantic depth analysis result (or null if unavailable)
 * @returns Fused description and optional depth metadata
 */
export function fuseGemmaWithDepth(
  gemmaDescription: string,
  depthResult: DepthAnalysisResult | null
): { description: string; depth: DepthInfo | undefined } {
  // No depth data — return Gemma response as-is
  if (!depthResult) {
    return { description: gemmaDescription, depth: undefined };
  }

  const depthInfo: DepthInfo = {
    proximity: PROXIMITY_LABELS[depthResult.proximity],
    warning: depthResult.warning,
  };

  // No warning from depth — path appears clear, no enrichment needed
  if (!depthResult.warning) {
    log.debug("Fusion: no depth warning, returning Gemma response unchanged");
    return { description: gemmaDescription, depth: depthInfo };
  }

  // Determine fusion strategy
  let fused: string;

  if (isSafetyCritical(depthResult)) {
    log.debug("Fusion: safety-critical mode", {
      proximity: depthResult.proximity,
      warning: depthResult.warning,
    });
    fused = buildSafetyResponse(gemmaDescription, depthResult);
  } else {
    log.debug("Fusion: standard enrichment mode", {
      proximity: depthResult.proximity,
      warning: depthResult.warning,
    });
    fused = buildEnrichedResponse(gemmaDescription, depthResult);
  }

  // Detect contradictions — if found, prefer the safety-critical version
  if (hasContradiction(fused)) {
    log.debug("Fusion: contradiction detected, using depth warning only");
    const trimmed = gemmaDescription.replace(/[.!?]\s*$/, "");
    fused = `${trimmed}. ${depthResult.warning}.`;
  }

  // Apply text sanitation
  fused = sanitizeFusedText(fused);

  log.debug("Fusion result", {
    original: gemmaDescription.slice(0, 80),
    fused: fused.slice(0, 100),
    strategy: isSafetyCritical(depthResult) ? "safety" : "enrichment",
  });

  return { description: fused, depth: depthInfo };
}
