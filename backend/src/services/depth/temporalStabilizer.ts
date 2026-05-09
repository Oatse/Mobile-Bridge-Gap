/**
 * Temporal stabilizer — orchestrator that combines all stability modules.
 *
 * PURPOSE:
 * Single entry point that runs the full stabilization pipeline:
 * 1. Extract object identity from fused description
 * 2. Push frame data into temporal memory buffer
 * 3. Stabilize object identity via majority voting
 * 4. Score semantic confidence
 * 5. Assess occupancy severity
 * 6. Compute directional guidance
 * 7. Apply response stability rules
 * 8. Return stabilized response
 *
 * This module is the ONLY integration point for describe.ts.
 * All sub-modules are internal implementation details.
 *
 * FAIL-SAFE: If any stabilization step errors, falls back to raw fused output.
 * LATENCY: <3ms total (all synchronous in-memory operations)
 */

import { log } from "../../utils/logger";
import type {
  DepthAnalysisResult,
  FrameRecord,
  StabilizedResponse,
  OccupancySeverity,
} from "./types";
import { extractObjectIdentity } from "./responseFusion";
import { pushFrame, stabilizeObjectIdentity } from "./temporalMemory";
import { scoreConfidence, applyConfidenceNaming } from "./semanticConfidence";
import { assessSeverity, getSeverityPhrase } from "./occupancySeverity";
import { computeDirectionalAdvice } from "./directionalGuidance";
import { evaluateStability } from "./responseStability";

// ─── Default Confidence (for fallback) ──────────────────────────────────────

const DEFAULT_CONFIDENCE = {
  temporalAgreement: 0,
  regionPlausibility: 0.5,
  depthConsistency: 0.5,
  semanticPlausibility: 0.5,
  knownObjectMatch: 0,
  totalScore: 0.5,
};

// ─── Main Stabilization Pipeline ────────────────────────────────────────────

/**
 * Runs the full temporal stabilization pipeline on a fused response.
 *
 * @param fusedDescription - The description after fuseGemmaWithDepth()
 * @param rawGemmaText - The raw sanitized Gemma output (for identity extraction)
 * @param depthResult - The depth analysis result (null if depth unavailable)
 * @returns StabilizedResponse with all stability metadata
 */
export function stabilizeResponse(
  fusedDescription: string,
  rawGemmaText: string,
  depthResult: DepthAnalysisResult | null
): StabilizedResponse {
  const startTime = performance.now();

  try {
    // Step 1: Extract object identity from raw Gemma text
    const rawObject = extractObjectIdentity(rawGemmaText);
    const region = depthResult?.nearestObstacle?.region ?? null;
    const proximity = depthResult?.proximity ?? "jauh";
    const depthM = depthResult?.nearestObstacle?.depthM ?? 20;

    // Step 2: Assess occupancy severity (replaces binary blocked/clear)
    const severity: OccupancySeverity = depthResult
      ? assessSeverity(depthResult.regions)
      : "clear";

    // Step 3: Push current frame into temporal memory
    const frameRecord: FrameRecord = {
      objectIdentity: rawObject,
      region,
      proximity: proximity as FrameRecord["proximity"],
      depthM,
      severity,
      fusedDescription,
      timestamp: performance.now(),
    };
    pushFrame(frameRecord);

    // Step 4: Stabilize object identity via majority voting
    const stabilizedObject = stabilizeObjectIdentity(rawObject, region);

    // Step 5: Score semantic confidence
    const confidence = scoreConfidence(stabilizedObject, region);

    // Step 6: Apply confidence-based naming
    const confidenceAdjustedName = applyConfidenceNaming(stabilizedObject, confidence);

    // Step 7: Compute directional guidance
    const direction = depthResult
      ? computeDirectionalAdvice(depthResult.regions, severity)
      : { phrase: "Tetap lurus.", bias: 0, changed: false };

    // Step 8: Build stabilized description
    let stabilizedDescription = fusedDescription;

    // Replace object name in description if stabilization changed it
    if (rawObject && stabilizedObject && rawObject !== stabilizedObject) {
      stabilizedDescription = stabilizedDescription.replace(
        new RegExp(escapeRegex(rawObject), "gi"),
        confidenceAdjustedName
      );
    }

    // If confidence is medium, inject hedging language
    if (rawObject && stabilizedObject && rawObject === stabilizedObject
      && confidence.totalScore < 0.7 && confidence.totalScore >= 0.4) {
      // Only hedge if the name appears directly (not already hedged)
      if (!stabilizedDescription.includes("terlihat seperti")) {
        stabilizedDescription = stabilizedDescription.replace(
          new RegExp(`(?:ada|terdapat)\\s+${escapeRegex(stabilizedObject)}`, "gi"),
          `terlihat seperti ${stabilizedObject}`
        );
      }
    }

    // Replace severity phrase if directional advice is available and meaningful
    if (direction.changed && severity !== "clear") {
      // Append directional advice if not already present
      const hasDirection =
        stabilizedDescription.includes("ke kiri") ||
        stabilizedDescription.includes("ke kanan") ||
        stabilizedDescription.includes("tetap lurus");

      if (!hasDirection) {
        const trimmed = stabilizedDescription.replace(/[.!?]\s*$/, "");
        stabilizedDescription = `${trimmed}. ${direction.phrase}`;
      }
    }

    // Step 9: Apply response stability rules
    const stability = evaluateStability(
      stabilizedDescription,
      severity,
      stabilizedObject
    );

    const stabilizationMs = performance.now() - startTime;

    log.debug("Temporal stabilization complete", {
      rawObject: rawObject ?? "(none)",
      stabilizedObject: stabilizedObject ?? "(none)",
      confidenceName: confidenceAdjustedName,
      confidence: confidence.totalScore.toFixed(3),
      severity,
      shouldNarrate: stability.shouldNarrate,
      reason: stability.reason,
      stabilizationMs: stabilizationMs.toFixed(2),
    });

    return {
      description: stability.description,
      shouldNarrate: stability.shouldNarrate,
      stabilizedObject,
      confidence,
      severity,
      direction,
      stabilizationMs,
    };

  } catch (error) {
    // FAIL-SAFE: if stabilization errors, fall back to raw fused output
    const stabilizationMs = performance.now() - startTime;
    log.warn("Temporal stabilization failed, using raw fused output", {
      error: error instanceof Error ? error.message : String(error),
      stabilizationMs: stabilizationMs.toFixed(2),
    });

    return {
      description: fusedDescription,
      shouldNarrate: true,
      stabilizedObject: null,
      confidence: DEFAULT_CONFIDENCE,
      severity: "clear",
      direction: { phrase: "Tetap lurus.", bias: 0, changed: false },
      stabilizationMs,
    };
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Escapes special regex characters in a string for use in RegExp constructor.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
