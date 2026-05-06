/**
 * POST /describe route handler.
 * Receives image + userCommand, runs inference, returns sanitized description.
 */

import { Elysia, t } from "elysia";
import { validateImage, validateUserCommand } from "../utils/validation";
import { buildPromptFromCommand, sanitizeResponse } from "../services/promptBuilder";
import { analyzeImage } from "../services/lmStudio";
import { FALLBACK_RESPONSE } from "../utils/constants";
import { log } from "../utils/logger";
import type { DescribeResponse, ErrorResponse } from "../types";

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
    });

    // Run inference via LM Studio
    try {
      const rawDescription = await analyzeImage(image, prompt);

      // Sanitize response for accessibility
      const description = sanitizeResponse(rawDescription);

      const durationMs = performance.now() - startTime;
      log.request("POST", "/describe", durationMs, 200);

      return {
        success: true,
        description,
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
