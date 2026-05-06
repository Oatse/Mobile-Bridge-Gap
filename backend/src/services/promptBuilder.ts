/**
 * Context-aware prompt builder and response sanitizer.
 * Parses Indonesian voice commands and generates assistive-focused prompts
 * for the LM Studio vision model.
 */

import type { CommandIntent, ParsedCommand } from "../types";

// ─── Keyword → Intent Mapping ───────────────────────────────────────────────

/**
 * Keyword → intent mapping.
 * Order matters — more specific patterns are checked first.
 */
const INTENT_PATTERNS: { keywords: string[]; intent: CommandIntent }[] = [
  {
    keywords: ["bahaya", "berbahaya", "danger", "hati-hati", "awas"],
    intent: "danger_detection",
  },
  {
    keywords: ["aman", "safety", "selamat", "aman untuk berjalan", "aman tidak"],
    intent: "path_safety",
  },
  {
    keywords: ["orang", "siapa", "manusia", "seseorang", "ada orang"],
    intent: "people_detection",
  },
  {
    keywords: ["baca", "tulisan", "teks", "text", "tertulis", "papan"],
    intent: "text_reading",
  },
  {
    keywords: ["area", "tempat", "ruangan", "sekitar", "lingkungan", "dimana"],
    intent: "area_description",
  },
  {
    keywords: ["benda", "objek", "apa ini", "apa itu", "apa yang ada"],
    intent: "object_identification",
  },
];

// ─── Intent → English Prompt Mapping ────────────────────────────────────────

/**
 * Intent → English prompt mapping.
 * English prompts work better with most vision models.
 * The system prompt instructs the model to respond in Indonesian.
 */
const INTENT_PROMPTS: Record<CommandIntent, string> = {
  general_description:
    "Describe what is directly in front of the visually impaired user. Focus on nearby obstacles, objects, and safe walking direction. Respond in 1-2 short sentences. Prioritize safety information.",

  danger_detection:
    "Identify any dangerous objects, obstacles, or hazards in front of the visually impaired user. Check for sharp objects, holes, moving vehicles, stairs, wet surfaces, or anything that could cause harm. Prioritize immediate threats. Respond in 1-2 short sentences.",

  path_safety:
    "Analyze whether the walking path ahead is safe and unobstructed for a visually impaired user. Report any obstacles blocking the path, uneven surfaces, stairs, or hazards. Suggest the safest direction to walk. Respond in 1-2 short sentences.",

  people_detection:
    "Identify any people visible near the visually impaired user. Describe their approximate position (left, right, front) and distance. Do not describe appearance in detail. Respond in 1-2 short sentences.",

  area_description:
    "Describe the surrounding environment for a visually impaired user. Focus on the type of space (indoor/outdoor), key landmarks, exits, obstacles, and safe navigation paths. Respond in 1-2 short sentences.",

  object_identification:
    "Identify and describe the main objects visible to the visually impaired user. Focus on objects that are close and could affect movement or safety. Describe their position relative to the user. Respond in 1-2 short sentences.",

  text_reading:
    "Read and transcribe any visible text, signs, or labels in the image for the visually impaired user. Include the text content and describe where the text is located. Respond in 1-2 short sentences.",
};

// ─── Response Sanitization ──────────────────────────────────────────────────

/**
 * Patterns that indicate overly decorative or verbose AI descriptions.
 * These get stripped or simplified for accessibility.
 */
const DECORATIVE_PATTERNS: RegExp[] = [
  /dengan nuansa\s+\w+/gi,
  /bernuansa\s+\w+/gi,
  /yang\s+(?:sangat\s+)?(?:indah|cantik|menawan|estetik|elegan|mewah|modern|klasik)/gi,
  /pencahayaan\s+(?:yang\s+)?(?:hangat|lembut|dramatis|estetik|alami)/gi,
  /suasana\s+(?:yang\s+)?(?:hangat|nyaman|tenang|damai|romantis)/gi,
  /berwarna\s+\w+\s+(?:yang\s+)?(?:indah|cantik|menawan)/gi,
  /dengan\s+(?:sentuhan|gaya|desain)\s+\w+/gi,
  /tampak\s+(?:sangat\s+)?(?:indah|cantik|menawan|estetik)/gi,
];

/**
 * Words/phrases to strip entirely — they add no safety value.
 */
const FILLER_PHRASES: string[] = [
  "sepertinya",
  "tampaknya",
  "mungkin saja",
  "bisa jadi",
  "sebuah ",
  "sebuah buah ",
];

/**
 * Sanitizes the AI response for accessibility.
 * - Removes decorative/aesthetic language
 * - Strips unnecessary filler words
 * - Enforces conciseness
 */
export function sanitizeResponse(rawResponse: string): string {
  let cleaned = rawResponse;

  // Strip decorative patterns
  for (const pattern of DECORATIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Strip filler phrases
  for (const phrase of FILLER_PHRASES) {
    cleaned = cleaned.replaceAll(phrase, "");
  }

  // Clean up double spaces and leading/trailing whitespace
  cleaned = cleaned
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\./g, ".")
    .replace(/\s+,/g, ",")
    .trim();

  // Enforce 2-sentence maximum: split on sentence-ending punctuation, keep first 2
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);

  if (sentences.length > 2) {
    cleaned = sentences.slice(0, 2).join(" ");
  }

  // Final cleanup — ensure response ends with punctuation
  if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
    cleaned += ".";
  }

  return cleaned || rawResponse; // Fall back to original if over-cleaned
}

// ─── Command Parsing & Prompt Building ──────────────────────────────────────

/**
 * Parses the user's Indonesian voice command and determines intent.
 */
export function parseCommand(userCommand: string): ParsedCommand {
  const normalized = userCommand.toLowerCase().trim();

  for (const pattern of INTENT_PATTERNS) {
    const matched = pattern.keywords.some((keyword) =>
      normalized.includes(keyword)
    );
    if (matched) {
      return { intent: pattern.intent, originalCommand: userCommand };
    }
  }

  return { intent: "general_description", originalCommand: userCommand };
}

/**
 * Builds the context-aware prompt based on parsed command intent.
 */
export function buildPrompt(parsedCommand: ParsedCommand): string {
  return INTENT_PROMPTS[parsedCommand.intent];
}

/**
 * Convenience: parse command and build prompt in one call.
 */
export function buildPromptFromCommand(userCommand: string): string {
  const parsed = parseCommand(userCommand);
  return buildPrompt(parsed);
}
