/**
 * Shared TypeScript types for MBG mobile frontend.
 * API response types mirror the backend contract.
 */

// ─── API Response Types ─────────────────────────────────────────────────────

/** Successful response from POST /describe */
export interface DescribeSuccessResponse {
  success: true;
  description: string;
}

/** Error response from POST /describe */
export interface DescribeErrorResponse {
  success: false;
  error: string;
}

/** Unified API response type */
export type DescribeResponse = DescribeSuccessResponse | DescribeErrorResponse;

// ─── App State Types ────────────────────────────────────────────────────────

/** Application processing states */
export type AppState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "error";

// ─── Voice Command Types ────────────────────────────────────────────────────

/** Result of parsing a voice command for the trigger keyword */
export interface ParsedCommand {
  /** Whether the trigger keyword "MBG" was found */
  hasTrigger: boolean;
  /** The command text after the trigger keyword (empty if no trigger) */
  command: string;
  /** The original unprocessed text */
  rawText: string;
}

// ─── Component Props ────────────────────────────────────────────────────────

/** Props for the AccessibleButton component */
export interface AccessibleButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
  variant?: "primary" | "danger" | "secondary";
}

/** Props for the StatusText component */
export interface StatusTextProps {
  message: string;
  variant?: "normal" | "warning" | "error" | "success";
}
