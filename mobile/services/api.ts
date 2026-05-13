/**
 * API service for communicating with the MBG backend.
 * Sends image + user command to POST /describe.
 *
 * Uses React Native's built-in `fetch` for multipart uploads.
 * Axios has known issues with RN's FormData + {uri,type,name} pattern
 * that cause ERR_NETWORK before the request even leaves the device.
 *
 * Includes retry logic with exponential backoff and connectivity
 * pre-check to handle transient mobile network failures gracefully.
 */

import { API_BASE_URL, API_TIMEOUT_MS, API_TOKEN, API_MODE } from "../constants/config";
import type { DescribeResponse } from "../types";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of retry attempts for transient network failures */
const MAX_RETRIES = API_MODE === "tunnel" ? 3 : 2;

/** Base delay between retries in ms (doubles each attempt) */
const RETRY_BASE_DELAY_MS = 1_000;

/** Timeout for the lightweight health check ping (ms) */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate that an image URI looks usable for multipart upload.
 * Must start with file:// or content:// to be a valid local resource.
 */
function validateImageUri(uri: string): boolean {
  return (
    typeof uri === "string" &&
    uri.length > 10 &&
    (uri.startsWith("file://") || uri.startsWith("content://"))
  );
}

/**
 * Check if the backend is reachable by pinging /health.
 * Returns true if the server responds (any status), false if unreachable.
 */
async function isBackendReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (API_TOKEN) {
      headers["X-API-Key"] = API_TOKEN;
    }

    const response = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeoutId);
    console.log("[MBG:API] Health check passed", { status: response.status, mode: API_MODE });
    return true;
  } catch (error) {
    clearTimeout(timeoutId);
    console.warn("[MBG:API] Health check failed", {
      message: error instanceof Error ? error.message : String(error),
      target: `${API_BASE_URL}/health`,
      mode: API_MODE,
    });
    return false;
  }
}

/**
 * Wait for a specified duration (used between retries).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if an error is a transient network issue worth retrying.
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const retryableMessages = [
    "Network request failed",
    "Failed to connect",
    "Unable to resolve host",
    "Connection refused",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENETUNREACH",
    "timeout",
  ];

  return retryableMessages.some(
    (msg) =>
      error.message.includes(msg) ||
      (error.cause instanceof Error && error.cause.message.includes(msg))
  );
}

/**
 * Log comprehensive error details for debugging network failures.
 */
function logErrorDetails(label: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(`[MBG:API] ${label}`, {
      name: error.name,
      message: error.message,
      cause: error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message }
        : error.cause ?? "none",
      stack: error.stack?.split("\n").slice(0, 3).join(" | ") ?? "no stack",
    });
  } else {
    console.error(`[MBG:API] ${label}`, { raw: String(error) });
  }
}

// ─── Main API Function ──────────────────────────────────────────────────────

/**
 * Send an image and user command to the backend for AI analysis.
 *
 * Includes retry logic with exponential backoff for transient network errors.
 * Before retrying, validates backend reachability via /health endpoint.
 *
 * @param imageUri - Local file URI of the compressed image (must be file:// or content://)
 * @param userCommand - The user's voice command text
 * @returns Typed DescribeResponse from the backend
 * @throws Error with user-friendly Indonesian message on failure
 */
export async function describeImage(
  imageUri: string,
  userCommand: string
): Promise<DescribeResponse> {
  // ─── URI Validation ─────────────────────────────────────────────────────
  console.log("[MBG:API] Preparing upload", {
    imageUri,
    uriLength: imageUri.length,
    startsWithFile: imageUri.startsWith("file://"),
    startsWithContent: imageUri.startsWith("content://"),
  });

  if (!validateImageUri(imageUri)) {
    console.error("[MBG:API] Invalid image URI — aborting upload:", imageUri);
    throw new Error(
      "URI gambar tidak valid. Silakan coba ambil gambar lagi."
    );
  }

  // ─── Connectivity Pre-Check ─────────────────────────────────────────────
  const reachable = await isBackendReachable();
  if (!reachable) {
    console.error("[MBG:API] Backend unreachable at", API_BASE_URL);
    throw new Error(
      API_MODE === "tunnel"
        ? "Backend tidak dapat dijangkau. Periksa koneksi internet Anda."
        : "Server AI tidak dapat dijangkau. Pastikan server berjalan dan perangkat terhubung ke jaringan yang sama."
    );
  }

  // ─── Retry Loop ─────────────────────────────────────────────────────────
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[MBG:API] Retry ${attempt}/${MAX_RETRIES} after ${backoff}ms...`);
      await delay(backoff);
    }

    try {
      const result = await executeFetchRequest(imageUri, userCommand);
      if (attempt > 0) {
        console.log(`[MBG:API] Request succeeded on retry ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      logErrorDetails(`Attempt ${attempt + 1} failed`, error);

      // Don't retry non-transient errors (validation, server errors, timeouts)
      if (!isRetryableError(error)) {
        console.log("[MBG:API] Error is non-retryable, failing immediately");
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= MAX_RETRIES) {
        console.error(`[MBG:API] All ${MAX_RETRIES + 1} attempts exhausted`);
        break;
      }
    }
  }

  // ─── All retries exhausted ──────────────────────────────────────────────
  logErrorDetails("Final failure after retries", lastError);
  throw new Error("Koneksi ke sistem AI terputus. Silakan periksa jaringan dan coba lagi.");
}

// ─── Fetch Execution ────────────────────────────────────────────────────────

/**
 * Execute a single fetch request to POST /describe.
 * Separated from retry logic for clarity.
 */
async function executeFetchRequest(
  imageUri: string,
  userCommand: string
): Promise<DescribeResponse> {
  // ─── FormData Construction ──────────────────────────────────────────────
  const formData = new FormData();

  // React Native FormData accepts { uri, type, name } objects natively.
  // This is a RN-specific pattern — the native networking layer reads the
  // file from the uri and streams it as multipart.
  formData.append("image", {
    uri: imageUri,
    type: "image/jpeg",
    name: "capture.jpg",
  } as unknown as Blob);

  formData.append("userCommand", userCommand);

  console.log("[MBG:API] FormData prepared, sending POST /describe...");
  console.log("[MBG:API] Target URL:", `${API_BASE_URL}/describe`);

  // ─── Request via fetch ──────────────────────────────────────────────────
  // Using RN's built-in fetch instead of axios for multipart uploads.
  // React Native's fetch natively understands {uri,type,name} objects
  // in FormData and correctly handles multipart boundary generation.

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // Build request headers — inject API token if configured
  const headers: Record<string, string> = {};
  if (API_TOKEN) {
    headers["X-API-Key"] = API_TOKEN;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/describe`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
      headers,
      // Do NOT set Content-Type — fetch auto-generates multipart boundary
    });

    clearTimeout(timeoutId);

    console.log("[MBG:API] Response received", {
      status: response.status,
      ok: response.ok,
    });

    const data: DescribeResponse = await response.json();

    if (!response.ok) {
      // Backend returned an error response
      const errorData = data as DescribeResponse & { error?: string };

      // Handle 401 Unauthorized (API token mismatch)
      if (response.status === 401) {
        throw new Error("Akses ditolak. Periksa konfigurasi API token.");
      }

      // Handle 429 Rate Limited
      if (response.status === 429) {
        throw new Error("Terlalu banyak permintaan. Silakan tunggu sebentar.");
      }

      if (errorData.error && typeof errorData.error === "string") {
        throw new Error(errorData.error);
      }
      throw new Error("Terjadi kesalahan pada server.");
    }

    console.log("[MBG:API] Parsed response", {
      success: data?.success,
    });

    return data;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      // AbortController timeout
      if (error.name === "AbortError") {
        console.error("[MBG:API] Request timed out after", API_TIMEOUT_MS, "ms");
        throw new Error("Waktu habis. Silakan coba lagi.");
      }

      // Re-throw errors we already created above (server errors, user-facing)
      if (
        error.message.startsWith("Terjadi") ||
        error.message.startsWith("URI") ||
        error.message.startsWith("Waktu") ||
        error.message.startsWith("Server AI") ||
        error.message.startsWith("Backend") ||
        error.message.startsWith("Akses") ||
        error.message.startsWith("Terlalu") ||
        error.message.startsWith("AI sedang")
      ) {
        throw error;
      }
    }

    // Re-throw for retry logic to evaluate
    throw error;
  }
}
