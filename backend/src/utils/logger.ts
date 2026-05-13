/**
 * Lightweight structured logger for MBG backend.
 * No external dependencies — wraps console with timestamps and levels.
 */

import { DEPTH_DEBUG_LOGGING } from "./constants";

type LogData = Record<string, unknown>;

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatData(data?: LogData): string {
  if (!data) return "";
  return " " + JSON.stringify(data);
}

function info(message: string, data?: LogData): void {
  console.log(`[${formatTimestamp()}] ✅ ${message}${formatData(data)}`);
}

function warn(message: string, data?: LogData): void {
  console.warn(`[${formatTimestamp()}] ⚠️  ${message}${formatData(data)}`);
}

function error(message: string, data?: LogData): void {
  console.error(`[${formatTimestamp()}] ❌ ${message}${formatData(data)}`);
}

function request(method: string, path: string, durationMs: number, status?: number): void {
  const statusTag = status ? ` [${status}]` : "";
  console.log(
    `[${formatTimestamp()}] 📡 ${method} ${path}${statusTag} — ${durationMs.toFixed(0)}ms`
  );
}

function startup(message: string): void {
  console.log(`[${formatTimestamp()}] 🚀 ${message}`);
}

/**
 * Debug-level logging for depth estimation diagnostics.
 * Gated by DEPTH_DEBUG_LOGGING env var — produces no output in production.
 */
function debug(message: string, data?: LogData): void {
  if (!DEPTH_DEBUG_LOGGING) return;
  console.log(`[${formatTimestamp()}] 🔍 ${message}${formatData(data)}`);
}

/**
 * Tunnel-specific logging — records requests arriving through Cloudflare Tunnel.
 * Only active in production mode to avoid noise during local development.
 */
function tunnel(path: string, clientIp: string): void {
  console.log(
    `[${formatTimestamp()}] 🌐 TUNNEL ${path} from ${clientIp}`
  );
}

export const log = {
  info,
  warn,
  error,
  request,
  startup,
  debug,
  tunnel,
} as const;

