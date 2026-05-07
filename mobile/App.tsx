/**
 * MBG Assistive Vision — Main Application Screen
 *
 * Orchestrates the full voice-first interaction flow:
 * idle → listening → processing → speaking → idle
 *
 * Single-screen app: camera preview background with status overlay.
 */

import React, { useEffect, useRef, useCallback, useState } from "react";
import { View, StyleSheet, Text } from "react-native";
import { StatusBar } from "expo-status-bar";
import { CameraView } from "expo-camera";

import useVoiceRecognition from "./hooks/useVoiceRecognition";
import useCamera from "./hooks/useCamera";
import useDescribeApi from "./hooks/useDescribeApi";
import useSpeechOutput from "./hooks/useSpeechOutput";

import AccessibleButton from "./components/AccessibleButton";
import StatusText from "./components/StatusText";
import LoadingIndicator from "./components/LoadingIndicator";

import { STATUS_MESSAGES, ERROR_RECOVERY_DELAY_MS } from "./constants/config";
import { COLORS, FONT_SIZES, SPACING } from "./styles/theme";
import type { AppState } from "./types";

export default function App() {
  // ─── State ──────────────────────────────────────────────────────────────

  const [appState, setAppState] = useState<AppState>("idle");
  const [statusMessage, setStatusMessage] = useState<string>(STATUS_MESSAGES.idle);
  const [lastDescription, setLastDescription] = useState<string | null>(null);

  // Prevent re-processing the same command
  const isProcessingRef = useRef(false);
  // Track the command object we already processed to prevent duplicates
  const processedCommandRef = useRef<string | null>(null);
  // Track error recovery timer so it can be cleared on unmount
  const errorRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Hooks ──────────────────────────────────────────────────────────────

  const voice = useVoiceRecognition();
  const camera = useCamera();
  const api = useDescribeApi();
  const tts = useSpeechOutput();

  // ─── Error Recovery ─────────────────────────────────────────────────────

  const recoverToIdle = useCallback(() => {
    if (errorRecoveryTimerRef.current) {
      clearTimeout(errorRecoveryTimerRef.current);
    }
    errorRecoveryTimerRef.current = setTimeout(() => {
      errorRecoveryTimerRef.current = null;
      setAppState("idle");
      setStatusMessage(STATUS_MESSAGES.idle);
    }, ERROR_RECOVERY_DELAY_MS);
  }, []);

  // Cleanup error recovery timer on unmount
  useEffect(() => {
    return () => {
      if (errorRecoveryTimerRef.current) {
        clearTimeout(errorRecoveryTimerRef.current);
      }
    };
  }, []);

  const handleError = useCallback(
    (message: string) => {
      setAppState("error");
      setStatusMessage(message);
      tts.speak(message);
      // Use clearCommand — do NOT restart recognition during error recovery
      voice.clearCommand();
      isProcessingRef.current = false;
      processedCommandRef.current = null;
      recoverToIdle();
    },
    [tts, voice, recoverToIdle]
  );

  // ─── Main Processing Flow ──────────────────────────────────────────────

  const processCommand = useCallback(
    async (command: string) => {
      if (isProcessingRef.current) {
        console.log("[MBG:Flow] Skipped — already processing");
        return;
      }
      isProcessingRef.current = true;
      processedCommandRef.current = command;

      console.log("[MBG:Flow] Processing command:", command);

      // Step 1: Update state to processing
      setAppState("processing");
      setStatusMessage(STATUS_MESSAGES.processing);
      tts.speak(STATUS_MESSAGES.processing);

      // Step 2: Capture and compress image
      console.log("[MBG:Flow] Capturing image...");
      const imageUri = await camera.captureAndCompress();
      if (!imageUri) {
        console.error("[MBG:Flow] Image capture failed");
        handleError(STATUS_MESSAGES.errorCamera);
        return;
      }
      console.log("[MBG:Flow] Image captured (full URI):", imageUri);

      // Step 3: Send to backend
      console.log("[MBG:Flow] Sending to backend...");
      const response = await api.sendDescribeRequest(imageUri, command);
      if (!response) {
        // api.error may not be set yet (React state is async), use fallback
        const errorMsg = api.error ?? STATUS_MESSAGES.errorOffline;
        console.error("[MBG:Flow] API request failed:", errorMsg);
        handleError(errorMsg);
        return;
      }

      // Step 4: Handle response
      if (response.success) {
        console.log("[MBG:Flow] AI description received, speaking...");
        setAppState("speaking");
        setStatusMessage(STATUS_MESSAGES.speaking);
        setLastDescription(response.description);

        // Speak the AI description
        tts.speak(response.description);
      } else {
        console.error("[MBG:Flow] Backend returned error:", response.error);
        handleError(response.error);
        return;
      }

      // Step 5: Do NOT restart recognition here — wait for TTS to finish
      // The useEffect below watches tts.isSpeaking and calls voice.resetCommand()
      // when speaking ends. This prevents the mic from picking up TTS audio.
      console.log("[MBG:Flow] Waiting for TTS to finish before resuming recognition");
      // Clear the command data but keep isProcessingRef true to block restarts
      voice.clearCommand();
    },
    [camera, api, tts, voice, handleError]
  );

  // ─── Effect: React to voice commands ──────────────────────────────────

  useEffect(() => {
    const cmd = voice.lastCommand;
    if (
      cmd?.hasTrigger &&
      !isProcessingRef.current &&
      cmd.command !== processedCommandRef.current
    ) {
      processCommand(cmd.command);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.lastCommand]);

  // ─── Effect: Transition from speaking → idle when TTS finishes ────────

  useEffect(() => {
    if (appState === "speaking" && !tts.isSpeaking) {
      console.log("[MBG:Flow] TTS finished — transitioning to idle, resuming recognition");
      setAppState("idle");
      setStatusMessage(STATUS_MESSAGES.idle);
      isProcessingRef.current = false;
      processedCommandRef.current = null; // Allow same command to be processed again
      voice.resetCommand(); // Restarts recognition now that TTS is done
    }
  }, [appState, tts.isSpeaking, voice]);

  // ─── Effect: Track voice recognition state ────────────────────────────

  useEffect(() => {
    if (voice.isListening && appState === "idle") {
      setAppState("listening");
      setStatusMessage(STATUS_MESSAGES.listening);
    }
  }, [voice.isListening, appState]);

  // ─── Effect: Handle voice errors ──────────────────────────────────────

  useEffect(() => {
    if (voice.error) {
      handleError(STATUS_MESSAGES.errorMic);
    }
  }, [voice.error, handleError]);

  // ─── Permission Gate ──────────────────────────────────────────────────

  if (camera.hasPermission === null) {
    // Permissions still loading
    return (
      <View style={styles.permissionContainer}>
        <StatusBar style="light" />
        <LoadingIndicator message="Memeriksa izin..." />
      </View>
    );
  }

  if (camera.hasPermission === false) {
    return (
      <View style={styles.permissionContainer}>
        <StatusBar style="light" />
        <StatusText
          message={STATUS_MESSAGES.permissionCamera}
          variant="warning"
        />
        <View style={styles.permissionButton}>
          <AccessibleButton
            label="Berikan Izin Kamera"
            onPress={async () => {
              await camera.requestPermission();
            }}
            accessibilityHint="Ketuk untuk memberikan izin akses kamera"
          />
        </View>
      </View>
    );
  }

  // ─── Main Render ──────────────────────────────────────────────────────

  const isActive = appState !== "idle";
  const isProcessing = appState === "processing";

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {/* Camera Preview — background */}
      <CameraView
        ref={camera.cameraRef}
        style={styles.camera}
        facing="back"
      />

      {/* Overlay Container */}
      <View style={styles.overlay}>
        {/* Top: Status Text */}
        <View style={styles.topSection}>
          <StatusText
            message={statusMessage}
            variant={
              appState === "error"
                ? "error"
                : appState === "speaking"
                  ? "success"
                  : "normal"
            }
          />
        </View>

        {/* Middle: Last Description or Loading */}
        <View style={styles.middleSection}>
          {isProcessing && (
            <LoadingIndicator message={STATUS_MESSAGES.processing} />
          )}

          {lastDescription && appState !== "processing" && (
            <View style={styles.descriptionContainer}>
              <Text
                style={styles.descriptionText}
                accessibilityRole="text"
                accessibilityLiveRegion="polite"
              >
                {lastDescription}
              </Text>
            </View>
          )}
        </View>

        {/* Bottom: Control Button */}
        <View style={styles.bottomSection}>
          {!voice.isListening && appState === "idle" ? (
            <AccessibleButton
              label="Mulai Mendengarkan"
              onPress={voice.startListening}
              accessibilityHint="Ketuk untuk mulai mendengarkan perintah suara. Ucapkan MBG diikuti perintah Anda."
            />
          ) : (
            <AccessibleButton
              label={isActive ? "Berhenti" : "Mendengarkan..."}
              onPress={() => {
                console.log("[MBG:Flow] Stop button pressed");
                // Order matters: stop voice FIRST (sets manualStop flag),
                // then stop TTS and clear state
                voice.stopListening();
                voice.clearCommand();
                tts.stopSpeaking();
                isProcessingRef.current = false;
                processedCommandRef.current = null;
                setAppState("idle");
                setStatusMessage(STATUS_MESSAGES.idle);
              }}
              variant={isProcessing ? "secondary" : "danger"}
              disabled={isProcessing}
              accessibilityHint="Ketuk untuk menghentikan proses"
            />
          )}
        </View>
      </View>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: "center",
    alignItems: "center",
    padding: SPACING.lg,
    gap: SPACING.lg,
  },
  permissionButton: {
    width: "100%",
    marginTop: SPACING.lg,
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    flex: 1,
    justifyContent: "space-between",
    padding: SPACING.lg,
    paddingTop: 60,
    paddingBottom: 40,
  },
  topSection: {
    alignItems: "center",
  },
  middleSection: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: SPACING.md,
  },
  descriptionContainer: {
    backgroundColor: COLORS.overlay,
    borderRadius: 16,
    padding: SPACING.lg,
    maxWidth: "100%",
  },
  descriptionText: {
    color: COLORS.textPrimary,
    fontSize: FONT_SIZES.medium,
    fontWeight: "500",
    textAlign: "center",
    lineHeight: 32,
  },
  bottomSection: {
    width: "100%",
  },
});
