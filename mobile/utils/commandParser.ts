/**
 * Command parser utility.
 * Detects the "MBG" trigger keyword and extracts the user command.
 */

import { TRIGGER_KEYWORD } from "../constants/config";
import type { ParsedCommand } from "../types";

/**
 * Parse a speech transcription for the trigger keyword.
 * Case-insensitive. Strips trigger prefix and returns clean command.
 *
 * @example
 * parseTriggerCommand("MBG, apa yang ada di depan saya?")
 * // { hasTrigger: true, command: "apa yang ada di depan saya?", rawText: "..." }
 *
 * parseTriggerCommand("halo selamat pagi")
 * // { hasTrigger: false, command: "", rawText: "halo selamat pagi" }
 */
export function parseTriggerCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  if (!trimmed) {
    return { hasTrigger: false, command: "", rawText: trimmed };
  }

  const lowerText = trimmed.toLowerCase();
  const triggerLower = TRIGGER_KEYWORD.toLowerCase();
  const triggerIndex = lowerText.indexOf(triggerLower);

  if (triggerIndex === -1) {
    return { hasTrigger: false, command: "", rawText: trimmed };
  }

  // Extract everything after the trigger keyword
  let command = trimmed.slice(triggerIndex + TRIGGER_KEYWORD.length).trim();

  // Strip leading comma or period after trigger keyword (common in speech)
  if (command.startsWith(",") || command.startsWith(".")) {
    command = command.slice(1).trim();
  }

  return {
    hasTrigger: true,
    command: command || "deskripsikan lingkungan di depan saya",
    rawText: trimmed,
  };
}

/**
 * Quick check if text contains the trigger keyword.
 * Useful for partial results checking without full parsing.
 */
export function containsTrigger(text: string): boolean {
  return text.toLowerCase().includes(TRIGGER_KEYWORD.toLowerCase());
}
