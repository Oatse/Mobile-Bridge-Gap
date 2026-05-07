/**
 * Application constants and configuration.
 * Mirrors relevant backend constants for consistency.
 */

/** Backend API base URL — change to your machine's local IP for device testing */
export const API_BASE_URL = "http://192.168.1.3:3000";

/** Trigger keyword for voice commands */
export const TRIGGER_KEYWORD = "MBG";

/** Target image dimension for compression (matches backend IMAGE_MAX_DIMENSION) */
export const IMAGE_TARGET_SIZE = 384;

/** JPEG compression quality (0–1) */
export const IMAGE_QUALITY = 0.8;

/** API request timeout in milliseconds (slightly above backend's 30s inference timeout) */
export const API_TIMEOUT_MS = 35_000;

/** Speech recognition locale — Indonesian */
export const SPEECH_LOCALE = "id-ID";

/** Text-to-Speech language — Indonesian */
export const TTS_LANGUAGE = "id-ID";

/** Delay before auto-returning from error state to idle (ms) */
export const ERROR_RECOVERY_DELAY_MS = 3_000;

/** Minimum interval between triggers to prevent duplicate firing (ms) */
export const TRIGGER_DEBOUNCE_MS = 2_000;

// ─── Status Messages (Indonesian) ───────────────────────────────────────────

export const STATUS_MESSAGES = {
  idle: "Siap menerima perintah.",
  listening: "Mendengarkan...",
  processing: "Sedang menganalisis lingkungan...",
  speaking: "Menyampaikan hasil...",
  errorOffline: "Koneksi ke sistem AI terputus.",
  errorMic: "Mikrofon tidak tersedia.",
  errorCamera: "Kamera tidak tersedia.",
  errorTimeout: "Waktu habis. Silakan coba lagi.",
  errorGeneric: "Terjadi kesalahan. Silakan coba lagi.",
  permissionCamera: "Izin kamera diperlukan untuk menggunakan aplikasi ini.",
  permissionMic: "Izin mikrofon diperlukan untuk perintah suara.",
} as const;
