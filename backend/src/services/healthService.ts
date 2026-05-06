/**
 * Health service — provides live status of backend, LM Studio, and model.
 * Used by GET /health endpoint.
 */

import type { HealthStatus, ServiceStatus } from "../types";
import { verifyModelReady } from "./modelManager";

/**
 * Performs a live health check of all system components.
 * Never throws — always returns a status object.
 */
export async function getHealthStatus(): Promise<HealthStatus> {
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
