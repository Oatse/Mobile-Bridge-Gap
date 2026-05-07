/**
 * MBG Backend — Entry Point
 * Lightweight ElysiaJS server for AI-assisted vision.
 * Uses LM Studio native REST API for inference.
 */

import { Elysia } from "elysia";
import { cors } from "@elysia/cors";
import { describeRoute } from "./routes/describe";
import { getHealthStatus, healthStatusToHttpCode } from "./services/healthService";
import { verifyModelReady, logReadinessStatus } from "./services/modelManager";
import { preloadDepthModel } from "./services/depth/depthModel";
import { PORT, LM_STUDIO_URL, MAX_BODY_SIZE_BYTES, ENABLE_DEPTH_ESTIMATION, DEPTH_INPUT_SIZE } from "./utils/constants";
import { log } from "./utils/logger";

// ─── Startup Verification ───────────────────────────────────────────────────

async function runStartupChecks(): Promise<void> {
  log.startup("Running startup checks...");

  // Verify LM Studio model readiness
  const readiness = await verifyModelReady();
  logReadinessStatus(readiness);

  // Preload depth estimation model (non-fatal — server starts regardless)
  if (ENABLE_DEPTH_ESTIMATION) {
    log.startup(`Preloading depth estimation model (input: ${DEPTH_INPUT_SIZE}x${DEPTH_INPUT_SIZE})...`);
    await preloadDepthModel();
  } else {
    log.startup("Depth estimation DISABLED via ENABLE_DEPTH_ESTIMATION=false");
  }
}

// ─── App Setup ──────────────────────────────────────────────────────────────

const app = new Elysia()
  .use(
    cors({
      origin: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    })
  )
  // Global error handler — standardized error responses
  .onError(({ error, code, set }) => {
    if (code === "VALIDATION") {
      set.status = 422;
      return {
        success: false,
        error: "Data permintaan tidak valid. Pastikan gambar dikirimkan.",
      };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return {
        success: false,
        error: "Endpoint tidak ditemukan.",
      };
    }

    // Body parse failure (malformed data, unsupported content type, etc.)
    if (code === "PARSE") {
      set.status = 400;
      return {
        success: false,
        error: "Format permintaan tidak valid.",
      };
    }

    log.error("Unhandled error", {
      code,
      message: error instanceof Error ? error.message : String(error),
    });

    set.status = 500;
    return {
      success: false,
      error: "Terjadi kesalahan pada server. Silakan coba lagi.",
    };
  })
  // Health endpoint — live status check
  .get("/health", async ({ set }) => {
    const status = await getHealthStatus();
    set.status = healthStatusToHttpCode(status);
    return status;
  })
  // Describe endpoint — main inference route
  .use(describeRoute)
  .listen({
    hostname: "0.0.0.0",
    port: PORT,
    maxRequestBodySize: MAX_BODY_SIZE_BYTES,
  });

// ─── Startup Logging ────────────────────────────────────────────────────────

log.startup(`MBG Backend running on http://0.0.0.0:${PORT}`);
log.startup(`LM Studio endpoint: ${LM_STUDIO_URL}`);
log.startup(`POST /describe — send image + userCommand`);
log.startup(`GET  /health    — live system health check`);

// Run startup checks (non-blocking — server starts regardless)
runStartupChecks().catch((error) => {
  log.error("Startup checks failed", {
    error: error instanceof Error ? error.message : String(error),
  });
});
