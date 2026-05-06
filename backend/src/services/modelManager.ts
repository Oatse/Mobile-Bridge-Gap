/**
 * Model Manager — handles LM Studio model availability and verification.
 * Uses the native REST API: GET /api/v1/models
 */

import type { LMStudioModel, LMStudioModelsResponse } from "../types";
import { LM_STUDIO_URL, LM_STUDIO_MODEL } from "../utils/constants";
import { log } from "../utils/logger";

/** Result of a full model readiness check */
export interface ModelReadiness {
  connected: boolean;
  modelFound: boolean;
  modelLoaded: boolean;
  visionCapable: boolean;
  modelKey: string;
  displayName?: string;
}

/**
 * Checks if LM Studio is reachable by pinging the models endpoint.
 */
export async function checkConnectivity(): Promise<boolean> {
  try {
    const response = await fetch(`${LM_STUDIO_URL}/api/v1/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetches all available models from LM Studio.
 * Returns empty array on failure.
 */
export async function getAvailableModels(): Promise<LMStudioModel[]> {
  try {
    const response = await fetch(`${LM_STUDIO_URL}/api/v1/models`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      log.error("Failed to fetch models", { status: response.status });
      return [];
    }

    const data = (await response.json()) as LMStudioModelsResponse;
    return data.models ?? [];
  } catch (error) {
    log.error("Cannot reach LM Studio for model list", {
      url: LM_STUDIO_URL,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Finds a specific model by key. Supports partial matching
 * since model keys in LM Studio can vary by quantization variant.
 */
export function findModel(
  models: LMStudioModel[],
  targetKey: string
): LMStudioModel | undefined {
  // Exact match first
  const exact = models.find((m) => m.key === targetKey);
  if (exact) return exact;

  // Partial match (model key contains target or vice versa)
  const normalized = targetKey.toLowerCase();
  return models.find(
    (m) =>
      m.key.toLowerCase().includes(normalized) ||
      normalized.includes(m.key.toLowerCase())
  );
}

/**
 * Checks if a model has active loaded instances.
 */
export function isModelLoaded(model: LMStudioModel): boolean {
  return model.loaded_instances.length > 0;
}

/**
 * Checks if a model supports vision input.
 */
export function isVisionCapable(model: LMStudioModel): boolean {
  return model.capabilities?.vision === true;
}

/**
 * Performs a complete model readiness verification.
 * Called at startup and by the health service.
 */
export async function verifyModelReady(): Promise<ModelReadiness> {
  const result: ModelReadiness = {
    connected: false,
    modelFound: false,
    modelLoaded: false,
    visionCapable: false,
    modelKey: LM_STUDIO_MODEL,
  };

  // Step 1: Check connectivity
  const models = await getAvailableModels();
  if (models.length === 0) {
    // Could be disconnected or no models available
    result.connected = await checkConnectivity();
    return result;
  }
  result.connected = true;

  // Step 2: Find target model
  const model = findModel(models, LM_STUDIO_MODEL);
  if (!model) {
    log.warn("Target model not found in LM Studio", {
      target: LM_STUDIO_MODEL,
      available: models.filter((m) => m.type === "llm").map((m) => m.key),
    });
    return result;
  }
  result.modelFound = true;
  result.displayName = model.display_name;

  // Step 3: Check if loaded
  result.modelLoaded = isModelLoaded(model);
  if (!result.modelLoaded) {
    log.warn("Target model found but not loaded", {
      model: model.key,
      displayName: model.display_name,
    });
  }

  // Step 4: Check vision capability
  result.visionCapable = isVisionCapable(model);
  if (!result.visionCapable) {
    log.warn("Target model does not support vision", {
      model: model.key,
      capabilities: model.capabilities,
    });
  }

  return result;
}

/**
 * Logs a human-readable startup status based on model readiness.
 */
export function logReadinessStatus(readiness: ModelReadiness): void {
  if (!readiness.connected) {
    log.error("LM Studio is not reachable", { url: LM_STUDIO_URL });
    log.warn("Backend will start, but inference will fail until LM Studio is running");
    return;
  }

  if (!readiness.modelFound) {
    log.error("Target model not found", { model: readiness.modelKey });
    log.warn("Load the model in LM Studio before using the /describe endpoint");
    return;
  }

  if (!readiness.modelLoaded) {
    log.warn("Model found but not loaded in LM Studio", {
      model: readiness.modelKey,
    });
    log.warn("Load the model in LM Studio to enable inference");
    return;
  }

  if (!readiness.visionCapable) {
    log.warn("Model loaded but does not support vision", {
      model: readiness.modelKey,
    });
    return;
  }

  log.info("Model ready for inference", {
    model: readiness.modelKey,
    displayName: readiness.displayName,
  });
}
