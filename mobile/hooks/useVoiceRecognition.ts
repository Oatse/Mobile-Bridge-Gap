/**
 * useVoiceRecognition — Speech recognition hook using expo-speech-recognition.
 * Listens for the "MBG" trigger keyword in Indonesian speech.
 * Provides continuous listening with automatic restart after processing.
 *
 * Lifecycle safety:
 * - lifecycleCleanup() stops recognition without locking user intent
 * - hardCleanup() is full teardown (unmount only)
 * - AppState listener debounces transitions and ignores "inactive"
 * - manualStopRef tracks ONLY user intent, never lifecycle events
 * - Restart loop protection via consecutive restart counter
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

/** Max consecutive auto-restarts before giving up (prevents tight loops) */
const MAX_CONSECUTIVE_RESTARTS = 5;

/** Debounce delay for AppState "background" cleanup (ms) */
const APPSTATE_DEBOUNCE_MS = 200;

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
  // Track if user manually stopped — prevents auto-restart in "end" handler.
  // ONLY set by user actions (stopListening), NEVER by lifecycle events.
  const manualStopRef = useRef(false);
  // Track the restart setTimeout so it can be cleared deterministically
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the app is in the foreground — blocks restarts when backgrounded
  const appIsActiveRef = useRef(true);
  // Consecutive restart counter — prevents tight restart loops
  const consecutiveRestartsRef = useRef(0);

  // ─── Lifecycle Cleanup ────────────────────────────────────────────────────

  /**
   * Lightweight cleanup: stops recognition and clears timers.
   * Does NOT touch manualStopRef — preserves user intent.
   * Used by AppState handler for background transitions.
   * Safe to call multiple times — idempotent.
   */
  const lifecycleCleanup = useCallback(() => {
    console.log("[MBG:Voice] Lifecycle cleanup — start");

    // 1. Block processing restarts
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

    // 5. Reset restart counter
    consecutiveRestartsRef.current = 0;

    console.log("[MBG:Voice] Lifecycle cleanup — complete");
  }, []);

  // ─── Hard Cleanup ───────────────────────────────────────────────────────

  /**
   * Full teardown: stops everything AND locks manual restart.
   * ONLY used on component unmount — not for AppState transitions.
   */
  const hardCleanup = useCallback(() => {
    console.log("[MBG:Voice] Hard cleanup — start (unmount path)");
    manualStopRef.current = true;
    lifecycleCleanup();
    console.log("[MBG:Voice] Hard cleanup — complete");
  }, [lifecycleCleanup]);

  // ─── AppState Lifecycle Listener ────────────────────────────────────────

  useEffect(() => {
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const handleAppStateChange = (nextState: string) => {
      console.log("[MBG:Voice] AppState changed:", nextState, {
        manualStop: manualStopRef.current,
        wasActive: appIsActiveRef.current,
      });

      // Cancel any pending debounced cleanup
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }

      if (nextState === "active") {
        appIsActiveRef.current = true;
        // Do NOT auto-restart here — user must press "Start" again
        // manualStopRef is preserved from before the transition
        console.log("[MBG:Voice] App active — manualStop:", manualStopRef.current);
      } else if (nextState === "background") {
        // Only "background" triggers cleanup — "inactive" is ignored.
        // Android fires "inactive" for permission dialogs, mic indicators,
        // TTS activity, and other system overlays. These are transient.
        appIsActiveRef.current = false;

        // Debounce: wait before cleanup to survive rapid background→active flickers
        cleanupTimer = setTimeout(() => {
          cleanupTimer = null;
          console.log("[MBG:Voice] App backgrounded (debounced) — running lifecycle cleanup");
          lifecycleCleanup(); // Does NOT set manualStopRef
        }, APPSTATE_DEBOUNCE_MS);
      }
      // "inactive" → intentionally ignored (Android system UI transitions)
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
      }
      subscription.remove();
      console.log("[MBG:Voice] AppState listener removed");
    };
  }, [lifecycleCleanup]);

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
    consecutiveRestartsRef.current = 0; // Reset on successful start
    setIsListening(true);
    setError(null);
  });

  useSpeechRecognitionEvent("end", () => {
    console.log("[MBG:Voice] Recognition ended", {
      isProcessing: isProcessingRef.current,
      manualStop: manualStopRef.current,
      appIsActive: appIsActiveRef.current,
      consecutiveRestarts: consecutiveRestartsRef.current,
    });
    setIsListening(false);

    // Auto-restart ONLY if all conditions are met
    if (
      !isProcessingRef.current &&
      !manualStopRef.current &&
      appIsActiveRef.current
    ) {
      // Restart loop protection
      if (consecutiveRestartsRef.current >= MAX_CONSECUTIVE_RESTARTS) {
        console.warn(
          "[MBG:Voice] Max consecutive restarts reached (" +
            MAX_CONSECUTIVE_RESTARTS +
            ") — stopping auto-restart to prevent loop"
        );
        return;
      }
      consecutiveRestartsRef.current += 1;

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

    // "no-speech" is common when user isn't talking — auto-restart handles it
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
   * This is the ONLY path that clears manualStopRef.
   */
  const startListening = useCallback(async () => {
    console.log("[MBG:Voice] Manual start requested");
    setError(null);

    // Reset all blocking flags — user explicitly wants the mic on
    manualStopRef.current = false;
    isProcessingRef.current = false;
    consecutiveRestartsRef.current = 0;

    const result =
      await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!result.granted) {
      setError("Izin mikrofon diperlukan untuk perintah suara.");
      return;
    }

    // Re-assert manualStop = false after the async permission await.
    // This guards against AppState "inactive" flickers from the permission
    // dialog on Android, which previously called hardCleanup() and locked
    // manualStopRef. With the new lifecycleCleanup(), this is belt-and-suspenders.
    manualStopRef.current = false;

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
    consecutiveRestartsRef.current = 0;
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
