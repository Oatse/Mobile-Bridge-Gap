/**
 * POST /describe route handler.
 * Receives image + userCommand, runs parallel inference (Gemma + Depth), returns fused description.
 *
 * Execution strategy:
 * - Gemma inference (GPU via LM Studio) and Depth inference (CPU via ONNX) run in PARALLEL
 * - Depth failure is non-fatal — falls back to Gemma-only response
 * - Gemma failure uses existing error handling
 * - Depth estimation can be disabled entirely via ENABLE_DEPTH_ESTIMATION=false
 * - Temporal stabilization runs as synchronous post-processing after fusion
 */

import { Elysia, t } from "elysia";
import { validateImage, validateUserCommand } from "../utils/validation";
import { buildPromptFromCommand, sanitizeResponse } from "../services/promptBuilder";
import { analyzeImage } from "../services/lmStudio";
import { estimateDepth } from "../services/depth/depthInference";
import { fuseGemmaWithDepth, extractObjectIdentity } from "../services/depth/responseFusion";
import { FALLBACK_RESPONSE, ENABLE_DEPTH_ESTIMATION } from "../utils/constants";
import { log } from "../utils/logger";
import type { DescribeResponse, ErrorResponse } from "../types";
import type { DepthAnalysisResult } from "../services/depth/types";
import { stabilizeResponse } from "../services/depth/temporalStabilizer";

// ─── Route Handler ──────────────────────────────────────────────────────────

export const describeRoute = new Elysia().post(
  "/describe",
  async ({ body }): Promise<DescribeResponse | ErrorResponse> => {
    const startTime = performance.now();
    const { image, userCommand } = body;

    // Validate image
    const imageValidation = validateImage(image);
    if (!imageValidation.valid) {
      log.warn("Image validation failed", { error: imageValidation.error });
      return {
        success: false,
        error: imageValidation.error!,
      } satisfies ErrorResponse;
    }

    // Validate and sanitize user command
    const sanitizedCommand = validateUserCommand(userCommand);

    // Build context-aware prompt from user command
    const effectiveCommand =
      sanitizedCommand ?? "deskripsikan lingkungan di depan saya";
    const prompt = buildPromptFromCommand(effectiveCommand);

    log.info("Processing describe request", {
      hasCommand: !!sanitizedCommand,
      command: effectiveCommand.slice(0, 80),
      depthEnabled: ENABLE_DEPTH_ESTIMATION,
    });

    // Read image buffer once — shared between Gemma and Depth pipelines
    const imageBuffer = Buffer.from(await image.arrayBuffer());

    // Run inference via LM Studio (Gemma) + Depth estimation in PARALLEL
    try {
      const [gemmaSettled, depthSettled] = await Promise.allSettled([
        analyzeImage(image, prompt),
        ENABLE_DEPTH_ESTIMATION
          ? estimateDepth(imageBuffer)
          : Promise.resolve(null),
      ]);

      // Extract Gemma result — failure is fatal (throws)
      if (gemmaSettled.status === "rejected") {
        throw gemmaSettled.reason;
      }
      const rawDescription = gemmaSettled.value;

      // Extract depth result — failure is non-fatal (null)
      let depthResult: DepthAnalysisResult | null = null;
      if (depthSettled.status === "fulfilled") {
        depthResult = depthSettled.value;
      } else {
        log.warn("Depth inference failed during parallel execution", {
          error: depthSettled.reason instanceof Error
            ? depthSettled.reason.message
            : String(depthSettled.reason),
        });
      }

      // Sanitize Gemma response for accessibility
      const sanitizedDescription = sanitizeResponse(rawDescription);

      // Fuse Gemma description with depth proximity data
      const { description: fusedDescription, depth } = fuseGemmaWithDepth(sanitizedDescription, depthResult);

      // Temporal stabilization — synchronous post-processing (<3ms)
      const stabilized = stabilizeResponse(
        fusedDescription,
        sanitizedDescription,
        depthResult
      );

      // Use stabilized description if narration is allowed, otherwise use previous stable
      const finalDescription = stabilized.shouldNarrate
        ? stabilized.description
        : stabilized.description; // stability layer already handles fallback

      const durationMs = performance.now() - startTime;
      log.request("POST", "/describe", durationMs, 200);
      log.info("Response stabilized", {
        hasDepth: !!depth,
        proximity: depth?.proximity ?? "unavailable",
        shouldNarrate: stabilized.shouldNarrate,
        severity: stabilized.severity,
        stabilizedObject: stabilized.stabilizedObject ?? "(none)",
        confidence: stabilized.confidence.totalScore.toFixed(3),
        stabilizationMs: stabilized.stabilizationMs.toFixed(1),
        totalMs: durationMs.toFixed(0),
      });

      return {
        success: true,
        description: finalDescription,
        ...(depth && { depth }),
      } satisfies DescribeResponse;
    } catch (error) {
      const durationMs = performance.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : FALLBACK_RESPONSE;

      log.error("Inference failed", {
        error: errorMessage,
        durationMs: durationMs.toFixed(0),
      });
      log.request("POST", "/describe", durationMs, 500);

      return {
        success: false,
        error: errorMessage,
      } satisfies ErrorResponse;
    }
  },
  {
    body: t.Object({
      image: t.File(),
      userCommand: t.Optional(t.String()),
    }),
  }
);
