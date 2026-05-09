/**
 * Depth estimation calibration & validation script.
 * Supports single image, batch directory, metadata comparison,
 * threshold recommendation, assistive validation, and debug visualization.
 *
 * --validate mode calls REAL Gemma inference via LM Studio for full-pipeline
 * narration testing (Gemma vision + Depth fusion) without needing the mobile app.
 *
 * Usage:
 *   bun run depth-calibrate <image-or-directory> [options]
 *
 * Options:
 *   --thresholds 0.5,1.0,2.0    Custom proximity thresholds (meters)
 *   --metadata <json-file>       Expected distance metadata for comparison
 *   --validate                   Run full pipeline: Gemma + Depth + Fusion
 *   --command "text"             User command for Gemma (default: general description)
 *   --debug                      Show ASCII depth grid visualization
 *   --recommend                  Show threshold adjustment recommendations
 *   --output <file>              Custom JSON output path
 *
 * Examples:
 *   bun run depth-calibrate scripts/test-images/test-image.png --validate
 *   bun run depth-calibrate scripts/test-images/test-image.png --validate --command "apakah ada bahaya"
 *   bun run depth-calibrate scripts/test-images/ --validate --command "apakah jalur depan aman"
 *   bun run depth-calibrate scripts/test-images/test-image.png --validate --debug
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { basename } from "path";
import { readFileSync, writeFileSync } from "fs";
import {
  DEPTH_PROXIMITY_THRESHOLDS,
  LM_STUDIO_URL, LM_STUDIO_MODEL, SYSTEM_PROMPT,
  IMAGE_MAX_DIMENSION, IMAGE_QUALITY,
  MAX_OUTPUT_TOKENS, INFERENCE_TEMPERATURE,
} from "../src/utils/constants";
import { buildPromptFromCommand, sanitizeResponse } from "../src/services/promptBuilder";
import {
  MODEL_FILE, REGION_BOUNDS, REGION_PRIORITIES, SAFETY_REGIONS,
  type Thresholds, type RegionResult, type ImageCalibrationResult, type CLIOptions,
  preprocessImage, getRegionStats, classifyDepth, generateHistogram,
  generateAsciiDepthGrid, parseCLI, discoverImages, formatMemory,
  detectNearestObstacle, depthToDistanceBucket, analyzePathOccupancy,
} from "./calibration-utils";

// ─── Production Thresholds (from constants.ts) ──────────────────────────────

const PRODUCTION_THRESHOLDS: Thresholds = {
  sangat_dekat: DEPTH_PROXIMITY_THRESHOLDS.sangat_dekat,
  dekat: DEPTH_PROXIMITY_THRESHOLDS.dekat,
  sedang: DEPTH_PROXIMITY_THRESHOLDS.sedang,
};

// ─── Real Gemma Inference via LM Studio ─────────────────────────────────────

/**
 * Optimizes image for Gemma inference (matches production lmStudio.ts).
 * Resizes to IMAGE_MAX_DIMENSION and compresses to JPEG.
 */
async function optimizeImageForGemma(imageBuffer: Buffer): Promise<string> {
  const optimized = await sharp(imageBuffer)
    .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: IMAGE_QUALITY })
    .toBuffer();
  return `data:image/jpeg;base64,${optimized.toString("base64")}`;
}

/**
 * Calls real Gemma via LM Studio API.
 * Returns the raw description string, or null if LM Studio is unavailable.
 */
async function callGemma(imageBuffer: Buffer, userCommand: string): Promise<{ raw: string; sanitized: string } | null> {
  try {
    const dataUrl = await optimizeImageForGemma(imageBuffer);
    const prompt = buildPromptFromCommand(userCommand);

    const response = await fetch(`${LM_STUDIO_URL}/api/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LM_STUDIO_MODEL,
        input: [
          { type: "text", content: prompt },
          { type: "image", data_url: dataUrl },
        ],
        system_prompt: SYSTEM_PROMPT,
        temperature: INFERENCE_TEMPERATURE,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as any;
    const messageItem = data?.output?.find?.((item: any) => item.type === "message");
    const content = messageItem?.content?.trim();
    if (!content || content.length === 0) return null;

    // Return BOTH raw and sanitized for debugging
    return { raw: content, sanitized: sanitizeResponse(content) };
  } catch {
    return null;
  }
}

// ─── Single Image Calibration ───────────────────────────────────────────────

async function calibrateImage(
  session: ort.InferenceSession,
  imagePath: string,
  opts: CLIOptions
): Promise<ImageCalibrationResult> {
  const filename = basename(imagePath);
  const result: ImageCalibrationResult = { filename, success: false };

  try {
    const imageBuffer = readFileSync(imagePath);
    const mem = formatMemory();
    result.memory = mem;

    // Preprocess
    const preStart = performance.now();
    const { tensor, width: _tw, height: _th } = await preprocessImage(imageBuffer);
    const preprocessMs = performance.now() - preStart;

    // Inference
    const inferStart = performance.now();
    const output = await session.run({ pixel_values: tensor });
    const inferenceMs = performance.now() - inferStart;

    // Extract depth map
    const depthOutput = output.predicted_depth!;
    const depthData = depthOutput.data as Float32Array;
    const dims = depthOutput.dims;
    const outH = Number(dims[dims.length - 2]);
    const outW = Number(dims[dims.length - 1]);

    // Analysis timing
    const analysisStart = performance.now();

    // Global stats
    let gMin = Infinity, gMax = -Infinity, gSum = 0;
    for (let i = 0; i < depthData.length; i++) {
      const v = depthData[i]!;
      if (v < gMin) gMin = v;
      if (v > gMax) gMax = v;
      gSum += v;
    }
    const gMean = gSum / depthData.length;
    result.global = { min: gMin, max: gMax, mean: gMean, range: gMax - gMin };

    // Region analysis (with percentile stats)
    const regions: RegionResult[] = [];
    for (const [name, bounds] of Object.entries(REGION_BOUNDS)) {
      const stats = getRegionStats(depthData, outW, outH, bounds, opts.thresholds);
      const priority = REGION_PRIORITIES[name] ?? 0.5;
      const meanProx = classifyDepth(stats.mean, opts.thresholds);
      const p5Prox = classifyDepth(stats.p5, opts.thresholds);
      const hasObstacle = SAFETY_REGIONS.has(name) && stats.obstacleRatio >= 0.005 && p5Prox !== "jauh";

      regions.push({
        region: name,
        ...stats,
        proximity: meanProx,
        p5Proximity: p5Prox,
        priority,
        hasObstacle,
      });
    }
    result.regions = regions;

    // Nearest obstacle detection (percentile-based)
    const nearestObstacle = detectNearestObstacle(regions, opts.thresholds);
    result.nearestObstacle = nearestObstacle;

    // Closest + warning region (now uses p5)
    const sorted = [...regions].sort((a, b) => a.p5 - b.p5);
    result.closestRegion = sorted[0]?.region ?? "center";
    result.warningRegion = nearestObstacle?.region ?? null;

    // Path occupancy analysis (matches production)
    const pathOccupancy = analyzePathOccupancy(regions, opts.thresholds);
    result.pathOccupancy = pathOccupancy;

    // Mean vs Percentile comparison (center/lower_center)
    const lowerCenter = regions.find(r => r.region === "lower_center");
    const center = regions.find(r => r.region === "center");
    const primaryRegion = lowerCenter ?? center;
    if (primaryRegion) {
      result.comparison = {
        meanProximity: primaryRegion.proximity,
        percentileProximity: primaryRegion.p5Proximity,
        meanDepth: primaryRegion.mean,
        percentileDepth: primaryRegion.p5,
        changed: primaryRegion.proximity !== primaryRegion.p5Proximity,
      };
    }

    const analysisMs = performance.now() - analysisStart;
    result.timing = { preprocessMs, inferenceMs, analysisMs, totalMs: preprocessMs + inferenceMs + analysisMs };

    // Metadata comparison
    if (opts.metadata && opts.metadata[filename] !== undefined) {
      result.expectedM = opts.metadata[filename];
      if (primaryRegion && result.expectedM !== undefined) {
        result.deviation = primaryRegion.p5 - result.expectedM;
      }
    }

    // Assistive validation — use REAL Gemma inference (not mock)
    if (opts.validate) {
      try {
        const { fuseGemmaWithDepth } = await import("../src/services/depth/responseFusion");
        const { analyzeDepthMap } = await import("../src/services/depth/depthAnalysis");
        const analysis = analyzeDepthMap(depthData, outW, outH, inferenceMs);

        // Call real Gemma via LM Studio
        const userCommand = opts.userCommand ?? "deskripsikan apa yang ada di depan saya";
        const gemmaStart = performance.now();
        const gemmaResult = await callGemma(imageBuffer, userCommand);
        const gemmaMs = performance.now() - gemmaStart;

        if (gemmaResult) {
          const fused = fuseGemmaWithDepth(gemmaResult.sanitized, analysis);
          result.assistiveNarration = fused.description;
          result.gemmaRaw = gemmaResult.raw;
          result.gemmaSanitized = gemmaResult.sanitized;
          result.gemmaMs = gemmaMs;
        } else {
          // Fallback: depth-only narration
          const fused = fuseGemmaWithDepth("(Gemma tidak tersedia)", analysis);
          result.assistiveNarration = `[depth-only] ${fused.description}`;
          result.gemmaMs = 0;
        }
      } catch { result.assistiveNarration = "(fusion import failed)"; }
    }

    // Print per-image report
    console.log(`\n┌─ ${filename} ${"─".repeat(Math.max(1, 50 - filename.length))}`);
    console.log(`│ Analysis method: percentile-based (p5) + mean`);

    // Mean vs Percentile comparison
    if (result.comparison) {
      const changed = result.comparison.changed ? " ⚡ CHANGED" : "";
      console.log(`│`);
      console.log(`│ ── Mean vs Percentile Comparison ──`);
      console.log(`│ Mean depth:        ${result.comparison.meanDepth.toFixed(3)}m → ${result.comparison.meanProximity}`);
      console.log(`│ P5 depth:          ${result.comparison.percentileDepth.toFixed(3)}m → ${result.comparison.percentileProximity}${changed}`);
      if (result.comparison.changed) {
        console.log(`│ ⚡ Classification IMPROVED: "${result.comparison.meanProximity}" → "${result.comparison.percentileProximity}"`);
      }
    }

    // Nearest obstacle
    console.log(`│`);
    if (nearestObstacle) {
      console.log(`│ 🎯 Nearest obstacle: ${nearestObstacle.region} @ ${nearestObstacle.depthM.toFixed(3)}m`);
      console.log(`│    Proximity:       ${nearestObstacle.proximity} (${nearestObstacle.distanceBucket})`);
      console.log(`│    Legacy score:    ${nearestObstacle.score.toFixed(3)} (priority: ${nearestObstacle.priority})`);
      console.log(`│    Nav score:       ${nearestObstacle.navigationScore.totalScore.toFixed(3)} (dist=${nearestObstacle.navigationScore.distanceScore.toFixed(2)} reg=${nearestObstacle.navigationScore.regionScore.toFixed(2)} size=${nearestObstacle.navigationScore.sizeScore.toFixed(2)} floor=${nearestObstacle.navigationScore.floorContactScore.toFixed(1)} center=${nearestObstacle.navigationScore.centerPathScore.toFixed(1)})`);
    } else {
      console.log(`│ ✅ No nearby obstacle detected (path clear)`);
    }

    // Path occupancy
    console.log(`│`);
    console.log(`│ 🚶 Path occupancy:  ${pathOccupancy.safestDirection} (center=${pathOccupancy.centerPathBlocked ? "blocked" : "clear"}, left=${pathOccupancy.leftPathClear ? "clear" : "blocked"}, right=${pathOccupancy.rightPathClear ? "clear" : "blocked"})`);
    console.log(`│    Summary:         ${pathOccupancy.summary}`);

    console.log(`│`);
    if (result.expectedM !== undefined) {
      console.log(`│ Expected:          ~${result.expectedM}m (metadata)`);
      console.log(`│ Deviation (p5):    ${(result.deviation ?? 0) >= 0 ? "+" : ""}${(result.deviation ?? 0).toFixed(3)}m`);
    }
    console.log(`│ Closest region:    ${result.closestRegion} (p5=${sorted[0]?.p5.toFixed(3)}m)`);
    if (result.warningRegion) console.log(`│ Warning region:    ${result.warningRegion}`);
    console.log(`│ Preprocess:        ${preprocessMs.toFixed(0)}ms`);
    console.log(`│ Inference:         ${inferenceMs.toFixed(0)}ms`);
    console.log(`│ Analysis:          ${analysisMs.toFixed(1)}ms`);
    console.log(`│ Total (depth):     ${result.timing.totalMs.toFixed(0)}ms`);
    if (result.gemmaMs) console.log(`│ Gemma latency:     ${result.gemmaMs.toFixed(0)}ms`);
    console.log(`│ Memory:            RSS=${mem.rss}, Heap=${mem.heap}`);
    if (result.gemmaRaw) {
      console.log(`│`);
      console.log(`│ 🤖 Gemma raw (pre-sanitize):`);
      console.log(`│    "${result.gemmaRaw}"`);
      if (result.gemmaSanitized && result.gemmaSanitized !== result.gemmaRaw) {
        console.log(`│ 🧹 Gemma sanitized:`);
        console.log(`│    "${result.gemmaSanitized}"`);
      }
    }
    if (result.assistiveNarration) console.log(`│ 🔊 Fused narration: "${result.assistiveNarration}"`);
    if (opts.userCommand) console.log(`│ 💬 Command:         "${opts.userCommand}"`);
    console.log(`└${"─".repeat(51)}`);

    // Region detail (expanded)
    console.log("  Regions (sorted by priority):");
    const byPriority = [...regions].sort((a, b) => b.priority - a.priority);
    for (const r of byPriority) {
      const obstacleTag = r.hasObstacle ? " 🔴" : "";
      const p5Tag = r.proximity !== r.p5Proximity ? ` [p5→${r.p5Proximity}]` : "";
      console.log(`    [${r.region.toUpperCase().padEnd(14)}] mean=${r.mean.toFixed(3)}m  p5=${r.p5.toFixed(3)}m  obs=${(r.obstacleRatio * 100).toFixed(1)}%  → ${r.proximity}${p5Tag}${obstacleTag}  (pri=${r.priority})`);
    }

    // Histogram for single mode
    if (!opts.isBatch) {
      const histMax = Math.min(Math.ceil(gMax), 10);
      console.log("\n──── Depth Distribution ────");
      console.log(generateHistogram(depthData, histMax));
    }

    // Debug ASCII grid
    if (opts.debug) {
      console.log("\n──── Debug Visualization ────");
      console.log(generateAsciiDepthGrid(depthData, outW, outH, opts.thresholds));
    }

    // Threshold sensitivity (single mode only)
    if (!opts.isBatch) {
      console.log("\n──── Threshold Sensitivity (p5-based) ────");
      const alts = [
        { label: "Aggressive", sangat_dekat: 0.7, dekat: 1.5, sedang: 3.0 },
        { label: "Current   ", ...opts.thresholds },
        { label: "Conserv.  ", sangat_dekat: 0.3, dekat: 0.8, sedang: 1.5 },
      ];
      for (const alt of alts) {
        const lc = classifyDepth(regions.find(r => r.region === "lower_center")!.p5, alt);
        const c = classifyDepth(regions.find(r => r.region === "center")!.p5, alt);
        const l = classifyDepth(regions.find(r => r.region === "left")!.p5, alt);
        const ri = classifyDepth(regions.find(r => r.region === "right")!.p5, alt);
        console.log(`  ${alt.label}: lower_center=${lc.padEnd(13)} center=${c.padEnd(13)} left=${l.padEnd(13)} right=${ri}`);
      }
    }

    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.log(`\n┌─ ${filename} ${"─".repeat(Math.max(1, 50 - filename.length))}`);
    console.log(`│ ❌ ERROR: ${result.error}`);
    console.log(`└${"─".repeat(51)}`);
  }

  return result;
}

// ─── Threshold Recommendations ──────────────────────────────────────────────

function printRecommendations(results: ImageCalibrationResult[], thresholds: Thresholds): void {
  const withMetadata = results.filter(r => r.success && r.deviation !== undefined);
  if (withMetadata.length === 0) {
    console.log("  ⚠ No metadata-matched images found. Add --metadata for recommendations.");
    return;
  }

  const avgDev = withMetadata.reduce((s, r) => s + (r.deviation ?? 0), 0) / withMetadata.length;
  const positiveBias = withMetadata.filter(r => (r.deviation ?? 0) > 0.1).length;
  const negativeBias = withMetadata.filter(r => (r.deviation ?? 0) < -0.1).length;

  console.log(`  Samples with metadata:   ${withMetadata.length}`);
  console.log(`  Average deviation (p5):  ${avgDev >= 0 ? "+" : ""}${avgDev.toFixed(3)}m`);
  console.log(`  Positive bias (>+0.1m):  ${positiveBias} images (model overestimates)`);
  console.log(`  Negative bias (<-0.1m):  ${negativeBias} images (model underestimates)`);

  if (Math.abs(avgDev) > 0.15) {
    const direction = avgDev > 0 ? "upward" : "downward";
    console.log(`\n  ⚠ Consistent ${direction} bias detected (${avgDev.toFixed(3)}m avg).`);
    console.log(`    Current thresholds: [${thresholds.sangat_dekat}, ${thresholds.dekat}, ${thresholds.sedang}]`);
    const adj = Math.abs(avgDev) * 0.5;
    const sign = avgDev > 0 ? 1 : -1;
    console.log(`    Suggested:          [${(thresholds.sangat_dekat + sign * adj).toFixed(2)}, ${(thresholds.dekat + sign * adj).toFixed(2)}, ${(thresholds.sedang + sign * adj).toFixed(2)}]`);
    console.log(`    Rationale: Shift thresholds ${direction} by ~${adj.toFixed(2)}m to compensate for model bias.`);
  } else {
    console.log("\n  ✅ Thresholds appear well-calibrated (deviation within ±0.15m).");
  }
}

// ─── Batch Aggregate Statistics ─────────────────────────────────────────────

function printBatchAggregates(results: ImageCalibrationResult[], thresholds: Thresholds): void {
  const ok = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  BATCH AGGREGATE STATISTICS");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  Total images:    ${results.length}`);
  console.log(`  Succeeded:       ${ok.length}`);
  console.log(`  Failed:          ${failed.length}`);

  if (ok.length === 0) return;

  // Timing aggregates
  const timings = ok.map(r => r.timing!);
  const avgPre = timings.reduce((s, t) => s + t.preprocessMs, 0) / timings.length;
  const avgInf = timings.reduce((s, t) => s + t.inferenceMs, 0) / timings.length;
  const avgTotal = timings.reduce((s, t) => s + t.totalMs, 0) / timings.length;
  const minTotal = Math.min(...timings.map(t => t.totalMs));
  const maxTotal = Math.max(...timings.map(t => t.totalMs));

  console.log("\n  ── Latency ──");
  console.log(`  Avg preprocess:  ${avgPre.toFixed(0)}ms`);
  console.log(`  Avg inference:   ${avgInf.toFixed(0)}ms`);
  console.log(`  Avg total:       ${avgTotal.toFixed(0)}ms`);
  console.log(`  Min total:       ${minTotal.toFixed(0)}ms`);
  console.log(`  Max total:       ${maxTotal.toFixed(0)}ms`);

  // Mean vs Percentile improvement summary
  const withComparison = ok.filter(r => r.comparison);
  const changedCount = withComparison.filter(r => r.comparison!.changed).length;
  console.log("\n  ── Mean vs Percentile Impact ──");
  console.log(`  Images analyzed:     ${withComparison.length}`);
  console.log(`  Classification changed: ${changedCount} (${((changedCount / Math.max(withComparison.length, 1)) * 100).toFixed(0)}%)`);
  if (changedCount > 0) {
    console.log("  Changed images:");
    for (const r of ok.filter(r => r.comparison?.changed)) {
      console.log(`    ${r.filename}: ${r.comparison!.meanProximity} → ${r.comparison!.percentileProximity}`);
    }
  }

  // Obstacle detection summary
  const withObstacle = ok.filter(r => r.nearestObstacle);
  console.log("\n  ── Obstacle Detection ──");
  console.log(`  Obstacles found:     ${withObstacle.length}/${ok.length} images`);
  for (const r of withObstacle) {
    const o = r.nearestObstacle!;
    console.log(`    ${r.filename}: ${o.region} @ ${o.depthM.toFixed(3)}m (${o.proximity})`);
  }

  // Proximity distribution (p5-based)
  const proxCounts: Record<string, number> = { sangat_dekat: 0, dekat: 0, sedang: 0, jauh: 0 };
  for (const r of ok) {
    const prox = r.nearestObstacle?.proximity ?? r.comparison?.percentileProximity ?? "jauh";
    proxCounts[prox] = (proxCounts[prox] ?? 0) + 1;
  }
  console.log("\n  ── Proximity Distribution (percentile-based) ──");
  for (const [k, v] of Object.entries(proxCounts)) {
    const pct = ((v / ok.length) * 100).toFixed(0);
    const bar = "█".repeat(Math.round((v / ok.length) * 30));
    console.log(`  ${k.padEnd(13)} ${bar} ${v}/${ok.length} (${pct}%)`);
  }

  // Region consistency (with percentile)
  console.log("\n  ── Region Consistency ──");
  for (const regionName of ["lower_center", "center", "left", "right"]) {
    const means = ok.map(r => r.regions!.find(rr => rr.region === regionName)!).filter(Boolean);
    if (means.length === 0) continue;
    const avgMean = means.reduce((s, d) => s + d.mean, 0) / means.length;
    const avgP5 = means.reduce((s, d) => s + d.p5, 0) / means.length;
    const stdMean = Math.sqrt(means.reduce((s, d) => s + (d.mean - avgMean) ** 2, 0) / means.length);
    console.log(`  ${regionName.padEnd(14)}: mean=${avgMean.toFixed(3)}m (std=${stdMean.toFixed(3)}m)  p5=${avgP5.toFixed(3)}m`);
  }

  // Failed images list
  if (failed.length > 0) {
    console.log("\n  ── Failed Images ──");
    for (const f of failed) console.log(`  ❌ ${f.filename}: ${f.error}`);
  }
}

// ─── Thesis Documentation ───────────────────────────────────────────────────

function printThesisDocumentation(results: ImageCalibrationResult[], opts: CLIOptions): void {
  const ok = results.filter(r => r.success);
  if (ok.length === 0) return;

  console.log("\n──── Thesis Documentation Summary ────");
  console.log(`Model:            Depth-Anything-V2-Metric-Indoor-Small`);
  console.log(`Model type:       Metric indoor (ONNX, CPU inference)`);
  console.log(`Input resolution: 518×518 (fixed DPT constraint)`);
  console.log(`Gemma input res:  512×512 (IMAGE_MAX_DIMENSION)`);
  console.log(`Analysis method:  Percentile-based (p5) + multi-factor navigation scoring`);
  console.log(`Scoring factors:  distance(0.4) + region(0.25) + size(0.15) + floor(0.1) + center(0.1)`);
  console.log(`Regions:          9 assistive zones with priority weights`);
  console.log(`Images tested:    ${ok.length}`);
  console.log(`Thresholds (m):   [${opts.thresholds.sangat_dekat}, ${opts.thresholds.dekat}, ${opts.thresholds.sedang}]`);
  console.log(`Threshold source: ${opts.isCustomThresholds ? "custom CLI" : "production (constants.ts)"}`);
  console.log(`Noise protection: ≥0.5% obstacle ratio required`);

  const timings = ok.map(r => r.timing!);
  const avgInf = timings.reduce((s, t) => s + t.inferenceMs, 0) / timings.length;
  const avgAnalysis = timings.reduce((s, t) => s + t.analysisMs, 0) / timings.length;
  console.log(`Avg inference:    ${avgInf.toFixed(0)}ms`);
  console.log(`Avg analysis:     ${avgAnalysis.toFixed(1)}ms`);

  // Path occupancy summary
  const withOccupancy = ok.filter(r => r.pathOccupancy);
  if (withOccupancy.length > 0) {
    const directionCounts: Record<string, number> = {};
    for (const r of withOccupancy) {
      const dir = r.pathOccupancy!.safestDirection;
      directionCounts[dir] = (directionCounts[dir] ?? 0) + 1;
    }
    console.log(`\nPath occupancy distribution:`);
    for (const [dir, count] of Object.entries(directionCounts)) {
      console.log(`  ${dir}: ${count}/${withOccupancy.length} images`);
    }
  }

  console.log("\nKnown limitations:");
  console.log("  - Monocular depth is inherently approximate (no stereo baseline)");
  console.log("  - Model trained primarily on indoor NYU-Depth-V2 data");
  console.log("  - Performance degrades in low-light and reflective surfaces");
  console.log("  - Distance estimates are bucketed, not centimeter-precise");

  console.log("\nObstacle prioritization notes:");
  console.log("  - p5 percentile used for obstacle detection (5th percentile of region depth)");
  console.log("  - Multi-factor navigation scoring: distance × region × size × floor × center");
  console.log("  - 9 priority-weighted regions with floor-level emphasis");
  console.log("  - Noise protection via ≥0.5% obstacle ratio threshold");
  console.log("  - Nearest obstacle prioritized over scene-wide average");
  console.log("  - Path occupancy analysis for directional guidance");
  console.log("  - Best accuracy at 0.5m–5m range (training distribution)");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCLI(process.argv, PRODUCTION_THRESHOLDS);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MBG Depth Estimation — Calibration & Validation");
  console.log("  (Percentile-Based + Real Gemma Inference)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📂 Input:      ${opts.inputPath}`);
  console.log(`📂 Mode:       ${opts.isBatch ? "batch (directory)" : "single image"}`);
  console.log(`📐 Thresholds: [${opts.thresholds.sangat_dekat}, ${opts.thresholds.dekat}, ${opts.thresholds.sedang}]m ${opts.isCustomThresholds ? "(custom)" : "(production)"}`);
  console.log(`📐 Analysis:   p5 percentile + obstacle ratio ≥0.5%`);
  if (opts.validate) {
    console.log(`🤖 Gemma:      ${LM_STUDIO_MODEL} @ ${LM_STUDIO_URL}`);
    console.log(`💬 Command:    "${opts.userCommand ?? "deskripsikan apa yang ada di depan saya"}"`);
    console.log(`📷 Image res:  ${IMAGE_MAX_DIMENSION}×${IMAGE_MAX_DIMENSION} (Gemma input)`);
  }
  if (opts.metadata) console.log(`📋 Metadata:   ${opts.metadataPath} (${Object.keys(opts.metadata).length} entries)`);
  console.log(`🔧 Flags:      ${[opts.validate && "validate", opts.debug && "debug", opts.recommend && "recommend"].filter(Boolean).join(", ") || "none"}`);

  // Load model
  console.log("\n🔄 Loading metric indoor model...");
  const loadStart = performance.now();
  const session = await ort.InferenceSession.create(MODEL_FILE, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    executionMode: "parallel",
    interOpNumThreads: 2,
    intraOpNumThreads: 2,
  });
  console.log(`✅ Model loaded in ${(performance.now() - loadStart).toFixed(0)}ms`);

  // Discover images
  const imagePaths = opts.isBatch ? discoverImages(opts.inputPath) : [opts.inputPath];
  if (imagePaths.length === 0) {
    console.error("❌ No valid image files found in directory.");
    process.exit(1);
  }
  console.log(`📷 Images to process: ${imagePaths.length}`);

  // Process each image
  const results: ImageCalibrationResult[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    if (opts.isBatch) console.log(`\n── [${i + 1}/${imagePaths.length}] ──`);
    const result = await calibrateImage(session, imagePaths[i]!, opts);
    results.push(result);
  }

  // Batch aggregates
  if (opts.isBatch) {
    printBatchAggregates(results, opts.thresholds);
  }

  // Threshold recommendations
  if (opts.recommend) {
    console.log("\n──── Threshold Recommendations ────");
    printRecommendations(results, opts.thresholds);
  }

  // Thesis documentation
  printThesisDocumentation(results, opts);

  // Save JSON results
  const jsonOutput = {
    timestamp: new Date().toISOString(),
    model: "Depth-Anything-V2-Metric-Indoor-Small",
    modelType: "metric_indoor",
    analysisMethod: "percentile_p5_obstacle_prioritization",
    mode: opts.isBatch ? "batch" : "single",
    thresholds: opts.thresholds,
    thresholdSource: opts.isCustomThresholds ? "custom" : "production",
    obstacleMinRatio: 0.005,
    analysisPercentile: 5,
    imageCount: results.length,
    successCount: results.filter(r => r.success).length,
    failedCount: results.filter(r => !r.success).length,
    results,
  };
  writeFileSync(opts.outputPath, JSON.stringify(jsonOutput, null, 2));
  console.log(`\n📊 Results saved to: ${opts.outputPath}`);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Calibration Complete");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((error) => {
  console.error("❌ Calibration failed:", error);
  process.exit(1);
});
