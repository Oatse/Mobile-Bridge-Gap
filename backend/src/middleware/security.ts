/**
 * Lightweight security middleware for MBG backend.
 * Provides API token authentication and rate limiting
 * when the backend is exposed via Cloudflare Tunnel.
 *
 * Design: Single Elysia plugin, no external dependencies.
 * - API token check on protected routes (/describe)
 * - In-memory sliding-window rate limiter per IP
 * - Request source detection (tunnel vs local)
 */

import { Elysia } from "elysia";
import { API_TOKEN, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, IS_PRODUCTION } from "../utils/constants";
import { log } from "../utils/logger";

// ─── Rate Limiter (in-memory) ───────────────────────────────────────────────

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitStore = new Map<string, RateLimitEntry>();

/** Periodic cleanup of expired entries to prevent memory leak */
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, entry] of rateLimitStore) {
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    if (entry.timestamps.length === 0) {
      rateLimitStore.delete(ip);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Check rate limit for a given IP.
 * Returns true if the request is allowed, false if rate-limited.
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let entry = rateLimitStore.get(ip);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitStore.set(ip, entry);
  }

  // Purge expired timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (entry.timestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.timestamps.push(now);
  return true;
}

/**
 * Extract client IP from request headers.
 * Prefers Cloudflare's Cf-Connecting-IP (set by tunnel), falls back to X-Forwarded-For.
 */
function getClientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Detect if the request arrived through Cloudflare Tunnel.
 */
function isTunnelRequest(headers: Headers): boolean {
  return headers.has("cf-connecting-ip") || headers.has("cf-ray");
}

// ─── Public Routes (no token required) ──────────────────────────────────────

/** Routes that bypass API token authentication */
const PUBLIC_PATHS = new Set(["/health"]);

// ─── Elysia Plugin ─────────────────────────────────────────────────────────

export const securityMiddleware = new Elysia({ name: "security" })
  .onRequest(({ request, set }) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const headers = request.headers;
    const clientIp = getClientIp(headers);
    const viaTunnel = isTunnelRequest(headers);

    // Skip preflight OPTIONS requests entirely
    if (method === "OPTIONS") return;

    // ── Rate Limiting ──────────────────────────────────────────────────
    if (!checkRateLimit(clientIp)) {
      log.warn("Rate limit exceeded", { ip: clientIp, path, viaTunnel });
      set.status = 429;
      return {
        success: false,
        error: "Terlalu banyak permintaan. Silakan tunggu sebentar.",
      };
    }

    // ── API Token Authentication ───────────────────────────────────────
    // Only enforce if API_TOKEN is configured (non-empty)
    if (API_TOKEN && !PUBLIC_PATHS.has(path)) {
      const providedToken = headers.get("x-api-key");

      if (!providedToken || providedToken !== API_TOKEN) {
        log.warn("Unauthorized request — invalid or missing API token", {
          ip: clientIp,
          path,
          viaTunnel,
          hasToken: !!providedToken,
        });
        set.status = 401;
        return {
          success: false,
          error: "Akses tidak diizinkan.",
        };
      }
    }

    // ── Tunnel Request Logging (production only) ───────────────────────
    if (viaTunnel && IS_PRODUCTION) {
      log.tunnel(path, clientIp);
    }
  });
