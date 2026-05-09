/**
 * Semantic confidence scoring for extracted object identities.
 *
 * PURPOSE:
 * Scores each extraction with a multi-factor confidence score,
 * enabling narration to adjust language based on certainty.
 *
 * FACTORS (weighted):
 * 1. Temporal agreement (0.30) — same object across recent frames
 * 2. Region plausibility (0.20) — object type appropriate for region
 * 3. Depth consistency (0.20)  — stable depth across frames
 * 4. Semantic plausibility (0.15) — object-in-context reasonableness
 * 5. Known object match (0.15) — found in KNOWN_OBJECTS list
 *
 * LATENCY: <0.3ms (simple arithmetic on cached data)
 */

import {
  CONFIDENCE_HIGH_THRESHOLD,
  CONFIDENCE_MEDIUM_THRESHOLD,
} from "../../utils/constants";
import { log } from "../../utils/logger";
import type { ObjectConfidence, DepthRegion } from "./types";
import { getRecentFrames, computeDepthConsistency } from "./temporalMemory";

// ─── Factor Weights ─────────────────────────────────────────────────────────

const WEIGHT_TEMPORAL = 0.30;
const WEIGHT_REGION = 0.20;
const WEIGHT_DEPTH = 0.20;
const WEIGHT_SEMANTIC = 0.15;
const WEIGHT_KNOWN = 0.15;

// ─── Known Objects Set ──────────────────────────────────────────────────────

const KNOWN_OBJECTS_SET: ReadonlySet<string> = new Set([
  "pisau", "gunting", "pecahan kaca", "pecahan", "benda tajam",
  "kabel", "kabel listrik",
  "tangga", "anak tangga", "lubang", "genangan", "lantai basah",
  "kursi", "meja", "lemari", "sofa", "rak", "bangku", "tempat tidur", "kasur",
  "bufet", "kabinet", "laci",
  "pintu", "jendela", "dinding",
  "kipas", "kipas angin", "televisi", "tv",
  "tas", "sepatu", "sandal", "kotak", "kardus",
  "botol", "gelas", "piring", "ember", "tong",
  "karpet", "tikar", "matras",
  "tiang", "pilar", "pagar",
  "payung", "tongkat", "sapu",
]);

// ─── Region Plausibility ────────────────────────────────────────────────────

type PlausibilityCategory = "floor" | "furniture" | "wall" | "hanging" | "any";

const OBJECT_PLAUSIBILITY: Record<string, PlausibilityCategory> = {
  "kabel": "floor", "kabel listrik": "floor",
  "sepatu": "floor", "sandal": "floor",
  "karpet": "floor", "tikar": "floor", "matras": "floor",
  "genangan": "floor", "lantai basah": "floor", "lubang": "floor",
  "tangga": "floor", "anak tangga": "floor",
  "kursi": "furniture", "meja": "furniture", "lemari": "furniture",
  "sofa": "furniture", "rak": "furniture", "bangku": "furniture",
  "tempat tidur": "furniture", "kasur": "furniture",
  "bufet": "furniture", "kabinet": "furniture",
  "jendela": "wall", "pintu": "wall",
  "televisi": "wall", "tv": "wall",
  "kipas": "hanging", "kipas angin": "hanging",
  "tas": "any", "kotak": "any", "kardus": "any",
  "botol": "any", "gelas": "any", "piring": "any",
  "pisau": "any", "gunting": "any",
  "payung": "any", "tongkat": "any", "sapu": "any",
  "tiang": "any", "pilar": "any", "pagar": "any",
};

const FLOOR_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_center", "lower_left", "lower_right",
]);
const FURNITURE_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "lower_center", "center", "lower_left", "lower_right", "left", "right",
]);
const WALL_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "upper_left", "upper_center", "upper_right", "left", "right",
]);
const HANGING_REGIONS: ReadonlySet<DepthRegion> = new Set([
  "upper_left", "upper_center", "upper_right",
]);

function scoreRegionPlausibility(
  objectName: string | null,
  region: DepthRegion | null
): number {
  if (!objectName || !region) return 0.5;
  const category = OBJECT_PLAUSIBILITY[objectName.toLowerCase()];
  if (!category || category === "any") return 0.8;

  switch (category) {
    case "floor": return FLOOR_REGIONS.has(region) ? 1.0 : 0.2;
    case "furniture": return FURNITURE_REGIONS.has(region) ? 1.0 : 0.3;
    case "wall": return WALL_REGIONS.has(region) ? 1.0 : 0.4;
    case "hanging": return HANGING_REGIONS.has(region) ? 1.0 : 0.2;
    default: return 0.5;
  }
}

// ─── Temporal Agreement ─────────────────────────────────────────────────────

function scoreTemporalAgreement(
  objectName: string | null,
  region: DepthRegion | null
): number {
  const frames = getRecentFrames();
  if (frames.length === 0 || !objectName) return 0.0;

  const lower = objectName.toLowerCase();
  let matches = 0;
  let total = 0;

  for (const frame of frames) {
    if (region && frame.region && region !== frame.region
      && region !== "center" && frame.region !== "center") {
      continue;
    }
    total++;
    if (frame.objectIdentity?.toLowerCase() === lower) matches++;
  }

  return total > 0 ? matches / total : 0.0;
}

// ─── Main Confidence Scoring ────────────────────────────────────────────────

/**
 * Computes a multi-factor confidence score for an extracted object identity.
 */
export function scoreConfidence(
  objectName: string | null,
  region: DepthRegion | null
): ObjectConfidence {
  const temporalAgreement = scoreTemporalAgreement(objectName, region);
  const regionPlausibility = scoreRegionPlausibility(objectName, region);
  const depthConsistency = computeDepthConsistency();
  const semanticPlausibility = objectName
    ? Math.min(1, (regionPlausibility + 0.5) / 1.5)
    : 0.3;
  const knownObjectMatch = objectName && KNOWN_OBJECTS_SET.has(objectName.toLowerCase())
    ? 1.0 : 0.0;

  const totalScore =
    temporalAgreement * WEIGHT_TEMPORAL +
    regionPlausibility * WEIGHT_REGION +
    depthConsistency * WEIGHT_DEPTH +
    semanticPlausibility * WEIGHT_SEMANTIC +
    knownObjectMatch * WEIGHT_KNOWN;

  const confidence: ObjectConfidence = {
    temporalAgreement, regionPlausibility, depthConsistency,
    semanticPlausibility, knownObjectMatch, totalScore,
  };

  log.debug("Semantic confidence scored", {
    object: objectName ?? "(none)",
    total: totalScore.toFixed(3),
    temporal: temporalAgreement.toFixed(2),
  });

  return confidence;
}

// ─── Confidence-Based Naming ────────────────────────────────────────────────

/**
 * Applies confidence-based naming to an object identity.
 * High (≥0.7): "kursi" | Medium (0.4-0.7): "terlihat seperti kursi" | Low (<0.4): "halangan"
 */
export function applyConfidenceNaming(
  objectName: string | null,
  confidence: ObjectConfidence
): string {
  if (!objectName) return "halangan";
  if (confidence.totalScore >= CONFIDENCE_HIGH_THRESHOLD) return objectName;
  if (confidence.totalScore >= CONFIDENCE_MEDIUM_THRESHOLD) return `terlihat seperti ${objectName}`;
  return "halangan";
}
