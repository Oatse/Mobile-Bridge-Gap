/**
 * Input validation helpers for the /describe endpoint.
 * Validates image files (MIME, magic bytes, size) and user commands.
 */

import {
  MAX_IMAGE_SIZE_BYTES,
  ALLOWED_IMAGE_TYPES,
  IMAGE_MAGIC_BYTES,
  MAX_COMMAND_LENGTH,
} from "./constants";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates the uploaded image file.
 * Checks: presence → zero-byte → MIME type → magic bytes → size.
 */
export function validateImage(
  image: File | null | undefined
): ValidationResult {
  if (!image) {
    return {
      valid: false,
      error: "Gambar tidak ditemukan dalam permintaan.",
    };
  }

  // Zero-byte / corrupted check
  if (image.size === 0) {
    return {
      valid: false,
      error: "File gambar kosong atau rusak.",
    };
  }

  // MIME type check
  if (!ALLOWED_IMAGE_TYPES.includes(image.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    return {
      valid: false,
      error: `Tipe gambar tidak didukung: ${image.type || "unknown"}. Gunakan JPEG, PNG, atau WebP.`,
    };
  }

  // Size check
  if (image.size > MAX_IMAGE_SIZE_BYTES) {
    const maxMB = MAX_IMAGE_SIZE_BYTES / (1024 * 1024);
    return {
      valid: false,
      error: `Ukuran gambar terlalu besar. Maksimum ${maxMB} MB.`,
    };
  }

  return { valid: true };
}

/**
 * Validates image magic bytes against expected file signatures.
 * Call this after reading the file buffer for deeper verification.
 * Returns false if the file header doesn't match the declared MIME type.
 */
export function validateMagicBytes(
  buffer: ArrayBuffer,
  mimeType: string
): boolean {
  const expectedBytes = IMAGE_MAGIC_BYTES[mimeType];
  if (!expectedBytes) return false;

  const header = new Uint8Array(buffer, 0, Math.min(expectedBytes.length, buffer.byteLength));

  if (header.length < expectedBytes.length) return false;

  return expectedBytes.every((byte, index) => header[index] === byte);
}

/**
 * Validates and sanitizes the user command string.
 * Returns a trimmed, length-capped string or null if invalid.
 */
export function validateUserCommand(
  command: string | null | undefined
): string | null {
  if (!command || typeof command !== "string") {
    return null;
  }

  const trimmed = command.trim();

  if (trimmed.length === 0) {
    return null;
  }

  // Cap command length to prevent abuse
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return trimmed.slice(0, MAX_COMMAND_LENGTH);
  }

  return trimmed;
}
