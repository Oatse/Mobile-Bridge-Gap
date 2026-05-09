/**
 * Response fusion layer for combining Gemma scene descriptions with metric depth analysis.
 *
 * Responsibilities:
 * - Merge Gemma understanding with metric depth proximity warnings
 * - Extract object identities from Gemma output for semantic narration
 * - Prioritize nearest-obstacle alerts from percentile-based analysis
 * - Include approximate distance context ("sekitar 1 meter")
 * - Classify object danger levels (sharp objects, floor hazards)
 * - Add path safety summary with navigation guidance
 * - Support hybrid narration: obstacle warning + scene context
 * - Avoid awkward phrasing, duplication, and contradictions
 * - Produce natural-sounding Indonesian assistive responses
 *
 * Design principles:
 * - Deterministic rule-based fusion (no LLM post-processing)
 * - Safety-first: nearest obstacle warnings override descriptive richness
 * - Semantic-aware: extracts object names from Gemma, replaces generic terms
 * - Region-aware: left/right/center/floor awareness in output
 * - Metric-aware: approximate distance context where available
 * - Failsafe: text sanitation catches edge cases
 */

import type { DepthAnalysisResult, ObstacleAlert, PathOccupancy } from "./types";
import { PROXIMITY_LABELS, type ProximityLevel } from "./types";
import type { DepthInfo } from "../../types";
import { log } from "../../utils/logger";

// ─── Fusion Constants ───────────────────────────────────────────────────────

/** Safety prefix for urgent proximity warnings */
const SAFETY_PREFIX = "Perhatian, ";

/**
 * Proximity levels that trigger safety-first response mode.
 * When nearest obstacle is at these levels, warning clarity takes priority.
 */
const SAFETY_CRITICAL_LEVELS: ReadonlySet<ProximityLevel> = new Set([
  "sangat_dekat",
  "dekat",
]);

// ─── Object Identity Extraction ─────────────────────────────────────────────

/**
 * Known object names in Indonesian for extraction matching.
 * Ordered by navigation priority: dangerous > floor hazards > furniture > general.
 */
const KNOWN_OBJECTS: readonly string[] = [
  // Dangerous objects
  "pisau", "gunting", "pecahan kaca", "pecahan", "benda tajam",
  "kabel", "kabel listrik",
  // Floor hazards
  "tangga", "anak tangga", "lubang", "genangan", "lantai basah",
  // Furniture
  "kursi", "meja", "lemari", "sofa", "rak", "bangku", "tempat tidur", "kasur",
  "bufet", "kabinet", "laci",
  // Common objects
  "pintu", "jendela", "dinding",
  "kipas", "kipas angin", "televisi", "tv",
  "tas", "sepatu", "sandal", "kotak", "kardus",
  "botol", "gelas", "piring", "ember", "tong",
  "karpet", "tikar", "matras",
  "tiang", "pilar", "pagar",
  "payung", "tongkat", "sapu",
];

/**
 * Semantic fallback categories when specific object name is not identified.
 * Maps generic Indonesian words to more assistive categories.
 */
const SEMANTIC_FALLBACKS: Record<string, string> = {
  "objek": "halangan",
  "benda": "halangan",
  "sesuatu": "halangan",
  "barang": "halangan",
  "item": "halangan",
};

/**
 * Extracts specific object names from Gemma's Indonesian description.
 * Returns the first matched known object, or null if none found.
 *
 * Strategy: scan Gemma output for known object names (longest match first),
 * then try pattern-based extraction for unknown objects.
 */
export function extractObjectIdentity(gemmaText: string): string | null {
  const lower = gemmaText.toLowerCase();

  // Direct match against known objects (longest first to match "kipas angin" before "kipas")
  const sortedObjects = [...KNOWN_OBJECTS].sort((a, b) => b.length - a.length);
  for (const obj of sortedObjects) {
    if (lower.includes(obj)) {
      return obj;
    }
  }

  // Pattern-based extraction: "terdapat/ada [OBJECT] di [POSITION]"
  const patterns = [
    /(?:terdapat|ada|terlihat)\s+([\w\s]{2,20}?)\s+(?:di|dekat|sekitar|yang)/i,
    /(?:sebuah|beberapa)\s+([\w\s]{2,15}?)\s+(?:di|dekat|yang|terletak)/i,
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim();
      // Reject if it's a generic word
      if (SEMANTIC_FALLBACKS[extracted]) continue;
      // Reject very short or very long matches (likely noise)
      if (extracted.length < 3 || extracted.length > 20) continue;
      return extracted;
    }
  }

  return null;
}

// ─── Object Danger Classification ───────────────────────────────────────────

/** Object danger level for narration emphasis */
type DangerLevel = "danger" | "furniture" | "floor_hazard" | "general";

/** Objects classified as dangerous (sharp, harmful) */
const DANGER_OBJECTS: ReadonlySet<string> = new Set([
  "pisau", "gunting", "pecahan kaca", "pecahan", "benda tajam",
  "kabel", "kabel listrik",
]);

/** Objects classified as furniture (path blockers) */
const FURNITURE_OBJECTS: ReadonlySet<string> = new Set([
  "kursi", "meja", "lemari", "sofa", "rak", "bangku",
  "tempat tidur", "kasur", "bufet", "kabinet",
]);

/** Objects classified as floor hazards */
const FLOOR_HAZARD_OBJECTS: ReadonlySet<string> = new Set([
  "tangga", "anak tangga", "lubang", "genangan", "lantai basah",
  "karpet", "tikar", "kabel",
]);

/**
 * Classifies an extracted object name into a danger category.
 * Used for narration emphasis and priority.
 */
export function classifyObjectDanger(objectName: string | null): DangerLevel {
  if (!objectName) return "general";
  const lower = objectName.toLowerCase();

  if (DANGER_OBJECTS.has(lower)) return "danger";
  if (FLOOR_HAZARD_OBJECTS.has(lower)) return "floor_hazard";
  if (FURNITURE_OBJECTS.has(lower)) return "furniture";

  // Check partial matches for compound names
  for (const obj of DANGER_OBJECTS) {
    if (lower.includes(obj) || obj.includes(lower)) return "danger";
  }
  for (const obj of FLOOR_HAZARD_OBJECTS) {
    if (lower.includes(obj) || obj.includes(lower)) return "floor_hazard";
  }

  return "general";
}

// ─── Text Sanitation ────────────────────────────────────────────────────────

/**
 * Sanitizes fused text to prevent awkward or broken output.
 *
 * Rules:
 * 1. Remove consecutive duplicate words (e.g., "kursi dekat kursi" → "kursi dekat")
 * 2. Remove double punctuation (e.g., ".." → ".")
 * 3. Normalize whitespace
 * 4. Ensure proper sentence ending
 */
function sanitizeFusedText(text: string): string {
  let result = text;

  // Remove consecutive duplicate words (case-insensitive)
  result = result.replace(/\b(\w+)\s+\1\b/gi, "$1");

  // Remove double punctuation
  result = result.replace(/([.!?])\1+/g, "$1");
  result = result.replace(/\.\s*\./g, ".");

  // Normalize whitespace
  result = result.replace(/\s{2,}/g, " ").trim();

  // Ensure proper ending punctuation
  if (result && !/[.!?]$/.test(result)) {
    result += ".";
  }

  return result;
}

/**
 * Detects contradictory safety statements in text.
 * Returns true if text contains both "safe" and "danger" indicators.
 */
function hasContradiction(text: string): boolean {
  const safeIndicators = ["aman", "terbuka", "bebas", "kosong"];
  const dangerIndicators = ["bahaya", "halangan", "sangat dekat", "hati-hati", "perhatian", "setengah meter", "sekitar 1 meter"];

  const hasSafe = safeIndicators.some((w) => text.toLowerCase().includes(w));
  const hasDanger = dangerIndicators.some((w) => text.toLowerCase().includes(w));

  return hasSafe && hasDanger;
}

/**
 * Replaces generic Indonesian obstacle words with semantically useful alternatives.
 * Transforms "objek" → extracted object name or fallback category.
 */
function replaceGenericTerms(
  text: string,
  objectName: string | null,
  dangerLevel: DangerLevel
): string {
  let result = text;

  // Determine replacement term
  const replacement = objectName
    ?? (dangerLevel === "furniture" ? "furnitur" : "halangan");

  // Replace generic terms with specific or category name
  for (const [generic, fallback] of Object.entries(SEMANTIC_FALLBACKS)) {
    // Only replace if the generic word is used as a standalone obstacle reference
    const pattern = new RegExp(`(?:ada|terdapat|sebuah)\\s+${generic}\\b`, "gi");
    if (pattern.test(result)) {
      result = result.replace(
        pattern,
        (match) => match.replace(new RegExp(generic, "gi"), objectName ?? fallback)
      );
    }
  }

  return result;
}

// ─── Semantic Warning Building ──────────────────────────────────────────────

/**
 * Builds a semantically enhanced warning by combining depth warning
 * with extracted object identity from Gemma output.
 *
 * Replaces generic "halangan" in depth warnings with specific object names
 * when available from Gemma's description.
 */
function buildSemanticWarning(
  depthWarning: string,
  objectName: string | null,
  dangerLevel: DangerLevel
): string {
  if (!objectName) {
    // No specific object identified — use category-based fallbacks
    if (dangerLevel === "furniture") {
      return depthWarning.replace(/halangan|penghalang/gi, "furnitur");
    }
    if (dangerLevel === "danger") {
      return depthWarning.replace(/halangan|penghalang/gi, "benda tajam");
    }
    return depthWarning;
  }

  // Replace generic obstacle terms with specific object name
  return depthWarning
    .replace(/halangan|penghalang/gi, objectName)
    .replace(/furnitur/gi, objectName)
    .replace(/benda kecil/gi, objectName);
}

/**
 * Adds danger emphasis prefix for sharp/dangerous objects.
 * Only applied when the object is classified as dangerous.
 */
function addDangerEmphasis(text: string, dangerLevel: DangerLevel): string {
  if (dangerLevel !== "danger") return text;

  // Already has emphasis
  if (text.toLowerCase().startsWith("perhatian")) return text;
  if (text.toLowerCase().startsWith("hati-hati")) return text;

  return `${SAFETY_PREFIX}${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

// ─── Obstacle-First Fusion ──────────────────────────────────────────────────

/**
 * Determines if a depth result requires safety-first response mode.
 * Now checks nearest obstacle (percentile-based) instead of overall proximity.
 */
function isSafetyCritical(depthResult: DepthAnalysisResult): boolean {
  // Check nearest obstacle first (percentile-based, more reliable)
  if (depthResult.nearestObstacle) {
    return SAFETY_CRITICAL_LEVELS.has(depthResult.nearestObstacle.proximity);
  }
  // Fall back to overall proximity
  return SAFETY_CRITICAL_LEVELS.has(depthResult.proximity);
}

/**
 * Builds a hybrid narration combining obstacle warning with scene context.
 * Now uses semantic warning building for specific object references.
 *
 * Good examples:
 * - "Perhatian, ada kursi sangat dekat di jalur depan Anda. Sisi kanan lebih aman."
 * - "Terdapat meja dekat di jalur depan, sekitar 1 meter."
 * - "Ada halangan di lantai depan Anda, sekitar 1 meter."
 */
function buildObstacleFirstResponse(
  gemmaDescription: string,
  depthResult: DepthAnalysisResult,
  semanticWarning: string
): string {
  const warning = semanticWarning || depthResult.warning;
  if (!warning) return gemmaDescription;

  const obstacle = depthResult.nearestObstacle;

  // For sangat_dekat obstacles: urgent prefix + warning + Gemma context
  if (obstacle && obstacle.proximity === "sangat_dekat") {
    const trimmedGemma = gemmaDescription.replace(/[.!?]\s*$/, "");

    // If Gemma already has safety phrasing, avoid duplication
    if (
      gemmaDescription.toLowerCase().includes("perhatian") ||
      gemmaDescription.toLowerCase().includes("hati-hati")
    ) {
      return `${trimmedGemma}. ${warning}.`;
    }

    return `${SAFETY_PREFIX}${warning.toLowerCase()}. ${trimmedGemma}.`;
  }

  // For dekat obstacles: warning + Gemma context
  if (obstacle && obstacle.proximity === "dekat") {
    // Try to inject proximity into Gemma's "di depan" if present
    const injected = tryInjectProximity(gemmaDescription, depthResult);
    if (injected) return injected;

    const trimmedGemma = gemmaDescription.replace(/[.!?]\s*$/, "");
    return `${trimmedGemma}. ${warning}.`;
  }

  // For sedang obstacles or general warnings: append as context
  const trimmedGemma = gemmaDescription.replace(/[.!?]\s*$/, "");
  return `${trimmedGemma}. ${warning}.`;
}

/**
 * Attempts to inject proximity context into a Gemma description
 * by replacing "di depan" with proximity-qualified "di depan".
 *
 * Returns null if injection is not applicable.
 */
function tryInjectProximity(
  description: string,
  depthResult: DepthAnalysisResult
): string | null {
  const proximityLabel = PROXIMITY_LABELS[depthResult.proximity];

  // Only inject if Gemma mentions "di depan" without existing proximity qualifier
  const hasFrontMention = description.includes("di depan");
  const hasExistingProximity =
    description.includes("dekat") ||
    description.includes("jauh") ||
    description.includes("sangat dekat");

  if (!hasFrontMention || hasExistingProximity) {
    return null;
  }

  // Only inject for close/very close proximity
  if (!SAFETY_CRITICAL_LEVELS.has(depthResult.proximity)) {
    return null;
  }

  return description.replace("di depan", `${proximityLabel} di depan`);
}

/**
 * Builds a standard (non-safety-critical) enriched response.
 * Adds depth context without urgency framing.
 */
function buildEnrichedResponse(
  gemmaDescription: string,
  depthResult: DepthAnalysisResult,
  semanticWarning: string
): string {
  const warning = semanticWarning || depthResult.warning;

  // No warning = no enrichment needed
  if (!warning) {
    return gemmaDescription;
  }

  // Try proximity injection first
  const injected = tryInjectProximity(gemmaDescription, depthResult);
  if (injected) {
    return injected;
  }

  // Append warning as separate clause
  const proximityLabel = PROXIMITY_LABELS[depthResult.proximity];
  if (!gemmaDescription.includes(proximityLabel)) {
    const trimmed = gemmaDescription.replace(/[.!?]\s*$/, "");
    return `${trimmed}. ${warning}.`;
  }

  return gemmaDescription;
}

// ─── Path Safety Summary ────────────────────────────────────────────────────

/**
 * Appends path safety guidance to the narration.
 * Uses PathOccupancy analysis from depth processing.
 *
 * Only appends if:
 * - Path occupancy data is available
 * - The existing text doesn't already contain direction guidance
 * - Adding it won't exceed reasonable narration length
 */
function appendPathSafety(
  text: string,
  pathOccupancy: PathOccupancy
): string {
  // Don't append if text already has direction guidance
  const hasDirectionGuidance =
    text.includes("sisi kiri") ||
    text.includes("sisi kanan") ||
    text.includes("jalur depan relatif aman") ||
    text.includes("lebih aman");

  if (hasDirectionGuidance) return text;

  // Don't append if text is already long (2+ sentences)
  const sentenceCount = (text.match(/[.!?]/g) ?? []).length;
  if (sentenceCount >= 2) return text;

  // Append path safety summary
  const trimmed = text.replace(/[.!?]\s*$/, "");
  return `${trimmed}. ${pathOccupancy.summary}`;
}

// ─── Main Fusion API ────────────────────────────────────────────────────────

/**
 * Fuses a Gemma scene description with depth proximity analysis.
 *
 * Enhanced fusion pipeline:
 * 1. Extract object identity from Gemma text
 * 2. Classify object danger level
 * 3. Build semantic warning (replacing generic terms)
 * 4. Determine fusion strategy (safety-critical vs enrichment)
 * 5. Add danger emphasis for sharp objects
 * 6. Replace remaining generic terms in Gemma text
 * 7. Add path safety summary
 * 8. Sanitize and return
 *
 * @param gemmaDescription - Sanitized scene description from Gemma model
 * @param depthResult - Semantic depth analysis result (or null if unavailable)
 * @returns Fused description and optional depth metadata
 */
export function fuseGemmaWithDepth(
  gemmaDescription: string,
  depthResult: DepthAnalysisResult | null
): { description: string; depth: DepthInfo | undefined } {
  // No depth data — still apply generic term replacement on Gemma output
  if (!depthResult) {
    const objectName = extractObjectIdentity(gemmaDescription);
    const cleaned = replaceGenericTerms(gemmaDescription, objectName, "general");
    return { description: cleaned, depth: undefined };
  }

  const depthInfo: DepthInfo = {
    proximity: PROXIMITY_LABELS[depthResult.proximity],
    warning: depthResult.warning,
  };

  // Step 1: Extract object identity from Gemma output
  const objectName = extractObjectIdentity(gemmaDescription);
  const dangerLevel = classifyObjectDanger(objectName);

  log.debug("Semantic extraction", {
    objectName: objectName ?? "(none)",
    dangerLevel,
    gemmaPreview: gemmaDescription.slice(0, 60),
  });

  // Step 2: Build semantic warning (replaces generic terms in depth warning)
  const semanticWarning = depthResult.warning
    ? buildSemanticWarning(depthResult.warning, objectName, dangerLevel)
    : null;

  // No warning from depth — path appears clear
  if (!depthResult.warning) {
    log.debug("Fusion: no depth warning, applying semantic cleanup only");
    let result = replaceGenericTerms(gemmaDescription, objectName, dangerLevel);
    // Append path safety if path is clear
    result = appendPathSafety(result, depthResult.pathOccupancy);
    return { description: sanitizeFusedText(result), depth: depthInfo };
  }

  // Step 3: Determine fusion strategy
  let fused: string;
  const safetyCritical = isSafetyCritical(depthResult);

  if (safetyCritical) {
    log.debug("Fusion: obstacle-first safety mode", {
      proximity: depthResult.proximity,
      nearestObstacle: depthResult.nearestObstacle
        ? `${depthResult.nearestObstacle.region} @ ${depthResult.nearestObstacle.depthM.toFixed(3)}m`
        : "none",
      semanticWarning,
      objectName: objectName ?? "(none)",
    });
    fused = buildObstacleFirstResponse(gemmaDescription, depthResult, semanticWarning ?? "");
  } else {
    log.debug("Fusion: standard enrichment mode", {
      proximity: depthResult.proximity,
      semanticWarning,
    });
    fused = buildEnrichedResponse(gemmaDescription, depthResult, semanticWarning ?? "");
  }

  // Step 4: Add danger emphasis for sharp/dangerous objects
  fused = addDangerEmphasis(fused, dangerLevel);

  // Step 5: Replace any remaining generic terms in the fused text
  fused = replaceGenericTerms(fused, objectName, dangerLevel);

  // Step 6: Detect contradictions — if found, prefer the safety-critical version
  if (hasContradiction(fused)) {
    log.debug("Fusion: contradiction detected, using depth warning only");
    const trimmed = gemmaDescription.replace(/[.!?]\s*$/, "");
    fused = `${trimmed}. ${semanticWarning ?? depthResult.warning}.`;
  }

  // Step 7: Add path safety summary
  fused = appendPathSafety(fused, depthResult.pathOccupancy);

  // Step 8: Apply text sanitation
  fused = sanitizeFusedText(fused);

  log.debug("Fusion result", {
    original: gemmaDescription.slice(0, 80),
    fused: fused.slice(0, 120),
    strategy: safetyCritical ? "obstacle-first" : "enrichment",
    hasNearestObstacle: !!depthResult.nearestObstacle,
    objectName: objectName ?? "(none)",
    dangerLevel,
    pathSafety: depthResult.pathOccupancy.safestDirection,
  });

  return { description: fused, depth: depthInfo };
}
