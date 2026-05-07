/**
 * useVoiceRecognition — Speech recognition hook using expo-speech-recognition.
 * Listens for the "MBG" trigger keyword in Indonesian speech.
 * Provides continuous listening with automatic restart after processing.
 */

import { useState, useCallback, useRef } from "react";
import * as Speech from "expo-speech";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { SPEECH_LOCALE, TRIGGER_DEBOUNCE_MS } from "../constants/config";
import { parseTriggerCommand, containsTrigger } from "../utils/commandParser";
import type { ParsedCommand } from "../types";

interface UseVoiceRecognitionReturn {
  /** Whether speech recognition is currently active */
  isListening: boolean;
  /** Last detected command with trigger keyword */
  lastCommand: ParsedCommand | null;
  /** Current error message, if any */
  error: string | null;
  /** Start continuous speech recognition */
  startListening: () => Promise<void>;
  /** Stop speech recognition (user-initiated, prevents auto-restart) */
  stopListening: () => void;
  /** Clear the last command without restarting recognition */
  clearCommand: () => void;
  /** Clear the last command and resume listening (call after processing completes) */
  resetCommand: () => void;
}

export default function useVoiceRecognition(): UseVoiceRecognitionReturn {
  const [isListening, setIsListening] = useState(false);
  const [lastCommand, setLastCommand] = useState<ParsedCommand | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Prevent duplicate triggers within debounce window
  const lastTriggerTime = useRef(0);
  // Track if we're currently processing to avoid restarts during processing
  const isProcessingRef = useRef(false);
  // Track if user manually stopped — prevents auto-restart in "end" handler
  // Once set to true, ONLY startListening() resets this flag
  const manualStopRef = useRef(false);

  // ─── Safe Start Wrapper ───────────────────────────────────────────────────

  /**
   * Attempt to start recognition ONLY if not processing and not manually stopped.
   * This is the single entry point for all auto-restarts.
   */
  const startRecognitionSafe = useCallback(async () => {
    if (isProcessingRef.current) {
      console.log("[MBG:Voice] Restart blocked — processing in progress");
      return;
    }
    if (manualStopRef.current) {
      console.log("[MBG:Voice] Restart blocked — manual stop active");
      return;
    }

    // Defense-in-depth: never restart mic while TTS is playing
    try {
      const speaking = await Speech.isSpeakingAsync();
      if (speaking) {
        console.log("[MBG:Voice] Restart blocked — TTS still speaking");
        return;
      }
    } catch {
      // If check fails, proceed cautiously
    }

    try {
      console.log("[MBG:Voice] Starting recognition...");
      ExpoSpeechRecognitionModule.start({
        lang: SPEECH_LOCALE,
        interimResults: true,
        continuous: true,
        maxAlternatives: 1,
        contextualStrings: ["MBG"],
      });
    } catch {
      setError("Gagal memulai pengenalan suara.");
    }
  }, []);

  // ─── Event Handlers ─────────────────────────────────────────────────────

  useSpeechRecognitionEvent("start", () => {
    console.log("[MBG:Voice] Recognition started");
    setIsListening(true);
    setError(null);
  });

  useSpeechRecognitionEvent("end", () => {
    console.log("[MBG:Voice] Recognition ended", {
      isProcessing: isProcessingRef.current,
      manualStop: manualStopRef.current,
    });
    setIsListening(false);

    // Auto-restart ONLY if not processing AND user didn't manually stop
    if (!isProcessingRef.current && !manualStopRef.current) {
      // Small delay to avoid race with TTS starting
      setTimeout(() => startRecognitionSafe(), 300);
    }
  });

  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";

    if (!transcript) return;

    // Check for trigger keyword in the transcript
    if (containsTrigger(transcript) && event.isFinal) {
      const now = Date.now();

      // Debounce — prevent duplicate triggers
      if (now - lastTriggerTime.current < TRIGGER_DEBOUNCE_MS) {
        return;
      }
      lastTriggerTime.current = now;

      const parsed = parseTriggerCommand(transcript);
      if (parsed.hasTrigger) {
        console.log("[MBG:Voice] Trigger detected", { command: parsed.command });
        isProcessingRef.current = true;
        setLastCommand(parsed);

        // Stop recognition while processing
        ExpoSpeechRecognitionModule.abort();
      }
    }
  });

  useSpeechRecognitionEvent("error", (event) => {
    // "aborted" is expected when we call stop()/abort() — not a real error
    if (event.error === "aborted") return;

    // "no-speech" is common when user isn't talking — auto-restart
    if (event.error === "no-speech") {
      return;
    }

    console.error("[MBG:Voice] Recognition error", { error: event.error, message: event.message });
    setError(event.message ?? "Kesalahan pengenalan suara.");
  });

  // ─── Control Functions ────────────────────────────────────────────────────

  /**
   * Start listening — user-initiated.
   * Resets manual stop flag and requests permissions.
   */
  const startListening = useCallback(async () => {
    setError(null);
    manualStopRef.current = false;
    isProcessingRef.current = false;

    const result =
      await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!result.granted) {
      setError("Izin mikrofon diperlukan untuk perintah suara.");
      return;
    }

    startRecognitionSafe();
  }, [startRecognitionSafe]);

  /**
   * Stop listening — user-initiated.
   * Sets manual stop flag BEFORE aborting to prevent auto-restart in "end" handler.
   */
  const stopListening = useCallback(() => {
    console.log("[MBG:Voice] Manual stop requested");
    manualStopRef.current = true;
    isProcessingRef.current = false;

    // Use abort() for immediate, forceful termination
    ExpoSpeechRecognitionModule.abort();
    setIsListening(false);
  }, []);

  /**
   * Clear the last command data WITHOUT restarting recognition.
   * Use this in error paths where we don't want auto-restart.
   */
  const clearCommand = useCallback(() => {
    setLastCommand(null);
    isProcessingRef.current = false;
    // Do NOT touch manualStopRef — respect user's stop intent
    // Do NOT restart recognition
  }, []);

  /**
   * Clear command data AND resume listening.
   * Use this after successful processing completes.
   * Respects manual stop — won't restart if user has stopped.
   */
  const resetCommand = useCallback(() => {
    setLastCommand(null);
    isProcessingRef.current = false;
    // Do NOT reset manualStopRef — only startListening does that

    // Restart listening only if user hasn't manually stopped
    if (!manualStopRef.current) {
      startRecognitionSafe();
    } else {
      console.log("[MBG:Voice] resetCommand — not restarting, manual stop active");
    }
  }, [startRecognitionSafe]);

  return {
    isListening,
    lastCommand,
    error,
    startListening,
    stopListening,
    clearCommand,
    resetCommand,
  };
}
