/**
 * API service for communicating with the MBG backend.
 * Sends image + user command to POST /describe.
 *
 * Uses React Native's built-in `fetch` for multipart uploads.
 * Axios has known issues with RN's FormData + {uri,type,name} pattern
 * that cause ERR_NETWORK before the request even leaves the device.
 */

import { API_BASE_URL, API_TIMEOUT_MS } from "../constants/config";
import type { DescribeResponse } from "../types";

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
 * Send an image and user command to the backend for AI analysis.
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

  try {
    const response = await fetch(`${API_BASE_URL}/describe`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
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
        console.error("[MBG:API] Request timed out");
        throw new Error("Waktu habis. Silakan coba lagi.");
      }

      // Network error — fetch failed entirely
      if (error.message === "Network request failed") {
        console.error("[MBG:API] Network request failed (fetch)");
        throw new Error("Koneksi ke sistem AI terputus.");
      }

      // Re-throw errors we already created above (server errors)
      if (
        error.message.startsWith("Terjadi") ||
        error.message.startsWith("URI") ||
        error.message.startsWith("Waktu") ||
        error.message.startsWith("Koneksi")
      ) {
        throw error;
      }

      console.error("[MBG:API] Request failed", {
        name: error.name,
        message: error.message,
      });
    } else {
      console.error("[MBG:API] Unexpected error", error);
    }

    throw new Error("Koneksi ke sistem AI terputus.");
  }
}
