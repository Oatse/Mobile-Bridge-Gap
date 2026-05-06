/**
 * Health service — provides live status of backend, LM Studio, and model.
 * Used by GET /health endpoint.
 * Includes a cache to prevent excessive LM Studio polling.
 */

import type { HealthStatus, ServiceStatus } from "../types";
import { verifyModelReady } from "./modelManager";

// ─── Health Cache ───────────────────────────────────────────────────────────

/** Cache TTL in milliseconds — health status is reused within this window */
const HEALTH_CACHE_TTL_MS = 5_000;

let cachedStatus: HealthStatus | null = null;
let cacheTimestamp = 0;

/**
 * Performs a live health check of all system components.
 * Returns cached result if called within the TTL window.
 * Never throws — always returns a status object.
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  // Return cached result if still fresh
  const now = Date.now();
  if (cachedStatus && now - cacheTimestamp < HEALTH_CACHE_TTL_MS) {
    return { ...cachedStatus, timestamp: new Date().toISOString() };
  }

  const status: HealthStatus = {
    backend: "ok",
    lmStudio: "error",
    model: "error",
    timestamp: new Date().toISOString(),
  };

  try {
    const readiness = await verifyModelReady();

    // LM Studio connectivity
    status.lmStudio = readiness.connected ? "ok" : "error";

    // Model status
    if (readiness.modelLoaded && readiness.visionCapable) {
      status.model = "ok";
      status.modelKey = readiness.modelKey;
    } else if (readiness.modelFound) {
      status.model = "degraded";
      status.modelKey = readiness.modelKey;
    }
  } catch {
    // Health check should never crash — return error statuses
    status.lmStudio = "error";
    status.model = "error";
  }

  // Update cache
  cachedStatus = status;
  cacheTimestamp = now;

  return status;
}

/**
 * Returns an HTTP status code based on health status.
 * 200 = all ok, 503 = degraded or error on critical services.
 */
export function healthStatusToHttpCode(status: HealthStatus): number {
  if (status.lmStudio === "ok" && status.model === "ok") {
    return 200;
  }
  return 503;
}
