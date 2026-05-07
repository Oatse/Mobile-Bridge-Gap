/**
 * Shared TypeScript types for MBG backend.
 * All LM Studio types match the native REST API schema (/api/v1/*).
 */

// ─── API Response Types ─────────────────────────────────────────────────────

/** Successful response returned to the mobile client */
export interface DescribeResponse {
  success: true;
  description: string;
  depth?: DepthInfo;
}

/** Lightweight depth info included in API responses */
export interface DepthInfo {
  proximity: string;
  warning: string | null;
}

/** Error response returned on failures */
export interface ErrorResponse {
  success: false;
  error: string;
}

/** Unified API response type */
export type ApiResponse = DescribeResponse | ErrorResponse;

// ─── Command & Intent Types ─────────────────────────────────────────────────

/** Intent categories derived from user voice commands */
export type CommandIntent =
  | "general_description"
  | "danger_detection"
  | "path_safety"
  | "people_detection"
  | "area_description"
  | "object_identification"
  | "text_reading";

/** Parsed result from the user's Indonesian voice command */
export interface ParsedCommand {
  intent: CommandIntent;
  originalCommand: string;
}

// ─── LM Studio Native REST API Types (/api/v1/*) ───────────────────────────

/**
 * Input item for POST /api/v1/chat.
 * Can be a text message or an image.
 */
export type LMStudioInputItem =
  | { type: "text"; content: string }
  | { type: "image"; data_url: string };

/**
 * Request body for POST /api/v1/chat (native API).
 */
export interface LMStudioChatRequest {
  model: string;
  input: LMStudioInputItem[];
  system_prompt?: string;
  temperature?: number;
  max_output_tokens?: number;
  store?: boolean;
}

/**
 * Individual output item from the chat response.
 */
export type LMStudioOutputItem =
  | { type: "message"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; tool: string; arguments: Record<string, unknown>; output: string }
  | { type: "invalid_tool_call"; reason: string };

/**
 * Stats returned by the native chat API.
 */
export interface LMStudioStats {
  input_tokens: number;
  total_output_tokens: number;
  reasoning_output_tokens: number;
  tokens_per_second: number;
  time_to_first_token_seconds: number;
  model_load_time_seconds?: number;
}

/**
 * Response from POST /api/v1/chat (native API).
 */
export interface LMStudioChatResponse {
  model_instance_id: string;
  output: LMStudioOutputItem[];
  stats: LMStudioStats;
  response_id?: string;
}

// ─── LM Studio Model Management Types (/api/v1/models) ─────────────────────

/** Model capabilities from the models list API */
export interface ModelCapabilities {
  vision: boolean;
  trained_for_tool_use: boolean;
  reasoning?: {
    allowed_options: string[];
    default: string;
  };
}

/** Loaded model instance configuration */
export interface LoadedInstance {
  id: string;
  config: {
    context_length: number;
    eval_batch_size?: number;
    parallel?: number;
    flash_attention?: boolean;
  };
}

/** Single model entry from GET /api/v1/models */
export interface LMStudioModel {
  type: "llm" | "embedding";
  publisher: string;
  key: string;
  display_name: string;
  architecture?: string | null;
  quantization: { name: string | null; bits_per_weight: number | null } | null;
  size_bytes: number;
  params_string: string | null;
  loaded_instances: LoadedInstance[];
  max_context_length: number;
  format: "gguf" | "mlx" | null;
  capabilities?: ModelCapabilities;
  description?: string | null;
}

/** Response from GET /api/v1/models (native API) */
export interface LMStudioModelsResponse {
  models: LMStudioModel[];
}

// ─── Health Types ───────────────────────────────────────────────────────────

export type ServiceStatus = "ok" | "degraded" | "error" | "disabled";

export interface HealthStatus {
  backend: ServiceStatus;
  lmStudio: ServiceStatus;
  model: ServiceStatus;
  depthModel: ServiceStatus;
  modelKey?: string;
  timestamp: string;
}

// ─── Model Management Types ────────────────────────────────────────────────

/** Result of a full model readiness check */
export interface ModelReadiness {
  connected: boolean;
  modelFound: boolean;
  modelLoaded: boolean;
  visionCapable: boolean;
  modelKey: string;
  displayName?: string;
}

// ─── Custom Error Types ────────────────────────────────────────────────────

/**
 * Custom error class for known inference/application errors.
 * Used instead of string-prefix matching to safely re-throw known errors.
 */
export class InferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceError";
  }
}
