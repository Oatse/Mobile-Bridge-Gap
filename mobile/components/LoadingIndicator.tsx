/**
 * LoadingIndicator — Simple accessible loading spinner with status message.
 */

import React from "react";
import { ActivityIndicator, Text, StyleSheet, View } from "react-native";
import { COLORS, FONT_SIZES, SPACING } from "../styles/theme";

interface LoadingIndicatorProps {
  message?: string;
}

export default function LoadingIndicator({
  message = "Memproses...",
}: LoadingIndicatorProps) {
  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={message}
    >
      <ActivityIndicator size="large" color={COLORS.primary} />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.overlay,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.lg,
    borderRadius: 12,
    alignItems: "center",
    gap: SPACING.md,
  },
  message: {
    color: COLORS.textPrimary,
    fontSize: FONT_SIZES.small,
    fontWeight: "500",
    textAlign: "center",
  },
});
