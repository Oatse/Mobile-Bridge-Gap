/**
 * useVoiceRecognition — Speech recognition hook using expo-speech-recognition.
 * Listens for the "MBG" trigger keyword in Indonesian speech.
 * Provides continuous listening with automatic restart after processing.
 *
 * Lifecycle safety:
 * - hardCleanup() guarantees full recognition teardown
 * - AppState listener stops mic on background/termination
 * - Unmount cleanup prevents ghost recognition
 * - Restart timer is tracked and cleared deterministically
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { AppState } from "react-native";
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
  // Track the restart setTimeout so it can be cleared deterministically
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the app is in the foreground — blocks restarts when backgrounded
  const appIsActiveRef = useRef(true);

  // ─── Hard Cleanup ───────────────────────────────────────────────────────

  /**
   * Deterministic full teardown of recognition.
   * Stops recognition, clears timers, disables restarts.
   * Safe to call multiple times — idempotent.
   */
  const hardCleanup = useCallback(() => {
    console.log("[MBG:Voice] Hard cleanup — start");

    // 1. Block all restarts
    manualStopRef.current = true;
    isProcessingRef.current = false;

    // 2. Clear pending restart timer
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      console.log("[MBG:Voice] Restart timer cleared");
    }

    // 3. Abort recognition immediately
    try {
      ExpoSpeechRecognitionModule.abort();
      console.log("[MBG:Voice] Recognition aborted");
    } catch {
      // Already stopped or never started — safe to ignore
    }

    // 4. Update state
    setIsListening(false);

    console.log("[MBG:Voice] Hard cleanup — complete");
  }, []);

  // ─── AppState Lifecycle Listener ────────────────────────────────────────

  useEffect(() => {
    const handleAppStateChange = (nextState: string) => {
      console.log("[MBG:Voice] AppState changed:", nextState);

      if (nextState === "active") {
        appIsActiveRef.current = true;
        // Do NOT auto-restart here — user must press "Start" again
      } else {
        // background, inactive, or unknown — stop everything
        appIsActiveRef.current = false;
        console.log("[MBG:Voice] App not active — running hard cleanup");
        hardCleanup();
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      subscription.remove();
      console.log("[MBG:Voice] AppState listener removed");
    };
  }, [hardCleanup]);

  // ─── Unmount Cleanup ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      console.log("[MBG:Voice] Component unmounting — running hard cleanup");
      hardCleanup();
    };
  }, [hardCleanup]);

  // ─── Safe Start Wrapper ───────────────────────────────────────────────────

  /**
   * Attempt to start recognition ONLY if not processing, not manually stopped,
   * and the app is in the foreground. This is the single entry point for all
   * auto-restarts.
   */
  const startRecognitionSafe = useCallback(async () => {
    if (!appIsActiveRef.current) {
      console.log("[MBG:Voice] Restart blocked — app not active");
      return;
    }
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
      appIsActive: appIsActiveRef.current,
    });
    setIsListening(false);

    // Auto-restart ONLY if all conditions are met
    if (
      !isProcessingRef.current &&
      !manualStopRef.current &&
      appIsActiveRef.current
    ) {
      // Small delay to avoid race with TTS starting
      // Store the timer ref so it can be cleared during cleanup
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        startRecognitionSafe();
      }, 300);
    } else {
      console.log("[MBG:Voice] Auto-restart blocked", {
        isProcessing: isProcessingRef.current,
        manualStop: manualStopRef.current,
        appIsActive: appIsActiveRef.current,
      });
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
   * Also clears any pending restart timer.
   */
  const stopListening = useCallback(() => {
    console.log("[MBG:Voice] Manual stop requested");
    manualStopRef.current = true;
    isProcessingRef.current = false;

    // Clear pending restart timer — prevent restart during the 300ms window
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      console.log("[MBG:Voice] Pending restart timer cleared");
    }

    // Use abort() for immediate, forceful termination
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // Already stopped — safe to ignore
    }
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

    // Restart listening only if user hasn't manually stopped and app is active
    if (!manualStopRef.current && appIsActiveRef.current) {
      startRecognitionSafe();
    } else {
      console.log("[MBG:Voice] resetCommand — not restarting", {
        manualStop: manualStopRef.current,
        appIsActive: appIsActiveRef.current,
      });
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
