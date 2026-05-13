/**
 * Application constants and configuration.
 * Mirrors relevant backend constants for consistency.
 *
 * Supports two API modes:
 * - "local"  — Direct LAN connection (USB debugging / same WiFi)
 * - "tunnel" — Remote access via Cloudflare Tunnel (mobile data / any network)
 */

// ─── API Mode ───────────────────────────────────────────────────────────────

/**
 * API connection mode.
 * - "local":  Uses LOCAL_API_URL (LAN IP, fast, requires same network)
 * - "tunnel": Uses TUNNEL_API_URL (Cloudflare Tunnel, works from anywhere)
 *
 * Switch to "tunnel" for production/remote testing.
 */
export type ApiMode = "local" | "tunnel";

export const API_MODE: ApiMode = "tunnel";

// ─── API Endpoints ──────────────────────────────────────────────────────────

/** Backend URL for local LAN development */
const LOCAL_API_URL = "http://192.168.1.4:3000";

/** Backend URL via Cloudflare Tunnel (production) */
const TUNNEL_API_URL = "https://api.mbridgegap.my.id";

/** Computed API base URL based on current mode */
export const API_BASE_URL = API_MODE === "tunnel" ? TUNNEL_API_URL : LOCAL_API_URL;

// ─── API Security ───────────────────────────────────────────────────────────

/**
 * API token for authenticated access through the tunnel.
 * Must match the API_TOKEN value configured on the backend.
 * Leave empty for local development (backend skips auth when no token is set).
 */
export const API_TOKEN = "5e5ffcea367869a8138ea69eea3a779202bda4d289b44d760cf5a2794afbd2d9";

// ─── Trigger & Interaction ──────────────────────────────────────────────────

/** Trigger keyword for voice commands */
export const TRIGGER_KEYWORD = "MBG";

/** Speech recognition locale — Indonesian */
export const SPEECH_LOCALE = "id-ID";

/** Text-to-Speech language — Indonesian */
export const TTS_LANGUAGE = "id-ID";

// ─── Image Processing ───────────────────────────────────────────────────────

/** Target image dimension for compression (matches backend IMAGE_MAX_DIMENSION) */
export const IMAGE_TARGET_SIZE = 384;

/** JPEG compression quality (0–1) */
export const IMAGE_QUALITY = 0.8;

// ─── Timeouts ───────────────────────────────────────────────────────────────

/**
 * API request timeout in milliseconds.
 * Tunnel mode uses a longer timeout to account for internet latency.
 * Local: 35s (slightly above backend's 30s inference timeout)
 * Tunnel: 45s (additional 10s buffer for network overhead)
 */
export const API_TIMEOUT_MS = API_MODE === "tunnel" ? 45_000 : 35_000;

// ─── Recovery ───────────────────────────────────────────────────────────────

/** Delay before auto-returning from error state to idle (ms) */
export const ERROR_RECOVERY_DELAY_MS = 3_000;

/** Minimum interval between triggers to prevent duplicate firing (ms) */
export const TRIGGER_DEBOUNCE_MS = 2_000;

// ─── Status Messages (Indonesian) ───────────────────────────────────────────

export const STATUS_MESSAGES = {
  idle: "Siap menerima perintah",
  listening: "Mendengarkan...",
  processing: "Sedang menganalisis lingkungan...",
  speaking: "Menyampaikan hasil...",
  errorOffline: "Koneksi ke sistem AI terputus. Silakan periksa jaringan dan coba lagi.",
  errorMic: "Mikrofon tidak tersedia.",
  errorCamera: "Kamera tidak tersedia.",
  errorTimeout: "Waktu habis. Silakan coba lagi.",
  errorGeneric: "Terjadi kesalahan. Silakan coba lagi.",
  errorServerUnreachable: "Backend tidak dapat dijangkau. Pastikan server berjalan.",
  errorAiUnavailable: "AI sedang tidak tersedia. Silakan coba beberapa saat lagi.",
  errorUnauthorized: "Akses ditolak. Periksa konfigurasi API token.",
  permissionCamera: "Izin kamera diperlukan untuk menggunakan aplikasi ini.",
  permissionMic: "Izin mikrofon diperlukan untuk perintah suara.",
} as const;
