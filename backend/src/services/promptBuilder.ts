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

/**
 * Intent → English prompt mapping.
 * English prompts work better with most vision models.
 * The system prompt instructs the model to respond in Indonesian.
 *
 * Each prompt enforces:
 * - Specific object naming (kursi, meja, pisau — NOT "objek" or "benda")
 * - Navigation-first priority (floor hazards > path blockage > sides)
 * - Path safety assessment
 * - Confidence-aware language for uncertain identifications
 */
const INTENT_PROMPTS: Record<CommandIntent, string> = {
  general_description:
    "Describe what is directly in the walking path of the visually impaired user. " +
    "Name every obstacle by its specific type (chair, table, knife, cable, box, shoes — never say 'object' or 'thing'). " +
    "Report floor-level hazards first. Include approximate position (left, right, front, floor). " +
    "End with path safety: is the forward path clear or blocked? If blocked, suggest the safest direction. " +
    "Respond in 1-2 short sentences. Navigation safety only, no room aesthetics.",

  danger_detection:
    "Identify any dangerous or sharp objects in front of the visually impaired user. " +
    "Name each hazard specifically: knife (pisau), scissors (gunting), broken glass (pecahan kaca), exposed cable (kabel), wet floor (lantai basah), sharp metal, stairs (tangga). " +
    "Floor-level dangerous items are highest priority. " +
    "If no danger is found, state the path appears safe. " +
    "Respond in 1-2 short sentences. Be specific about object identity — never say just 'dangerous object'.",

  path_safety:
    "Analyze the walking path ahead for a visually impaired user. " +
    "Identify specific objects blocking the center walking path (name each: chair, table, box, etc.). " +
    "Assess: is the center path passable? Is the left side clear? Is the right side clear? " +
    "Suggest the safest walking direction. " +
    "If path is completely clear, state it is safe. " +
    "Respond in 1-2 short sentences. Focus only on navigation obstacles, not room description.",

  people_detection:
    "Identify any people visible near the visually impaired user. " +
    "Describe their approximate position (left, right, front) and distance. " +
    "If they are in the walking path, mention it as a potential obstacle. " +
    "Do not describe appearance in detail. Respond in 1-2 short sentences.",

  area_description:
    "Describe the surrounding environment for navigation purposes only. " +
    "Focus on: doors (pintu), stairs (tangga), exits, corridors, walls, floor type. " +
    "Mention any navigation-relevant obstacles by name. " +
    "Do NOT describe room aesthetics, lighting, or decorations. " +
    "Respond in 1-2 short sentences prioritizing navigation landmarks.",

  object_identification:
    "Identify and name the main objects visible to the visually impaired user. " +
    "Name each object specifically: chair (kursi), table (meja), cabinet (lemari), sofa, shelf (rak), fan (kipas), television (televisi), bag (tas), shoes (sepatu), bottle (botol). " +
    "For each object, state its position relative to the user and whether it is on the floor or at height. " +
    "Prioritize objects closest to the walking path. " +
    "Never use generic terms like 'object' or 'thing'. Respond in 1-2 short sentences.",

  text_reading:
    "Read and transcribe any visible text, signs, or labels in the image for the visually impaired user. " +
    "Include the text content and describe where the text is located. Respond in 1-2 short sentences.",
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
