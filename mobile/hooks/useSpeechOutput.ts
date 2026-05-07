/**
 * useSpeechOutput — Text-to-Speech hook using expo-speech.
 * Speaks AI responses and error messages in Indonesian.
 * Prevents overlapping speech — stops previous before starting new.
 */

import { useState, useCallback } from "react";
import * as Speech from "expo-speech";
import { TTS_LANGUAGE } from "../constants/config";

interface UseSpeechOutputReturn {
  /** Speak text aloud. Stops any current speech first. */
  speak: (text: string) => void;
  /** Immediately stop current speech */
  stopSpeaking: () => void;
  /** Whether TTS is currently speaking */
  isSpeaking: boolean;
}

export default function useSpeechOutput(): UseSpeechOutputReturn {
  const [isSpeaking, setIsSpeaking] = useState(false);

  const speak = useCallback((text: string) => {
    // Stop any current speech before starting new
    Speech.stop();

    setIsSpeaking(true);

    Speech.speak(text, {
      language: TTS_LANGUAGE,
      pitch: 1.0,
      rate: 0.95,
      onDone: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    Speech.stop();
    setIsSpeaking(false);
  }, []);

  return {
    speak,
    stopSpeaking,
    isSpeaking,
  };
}
