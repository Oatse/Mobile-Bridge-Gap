/**
 * StatusText — Displays current app status with accessibility support.
 * Large text, color-coded by variant, live region for screen readers.
 */

import React from "react";
import { Text, StyleSheet, View } from "react-native";
import type { StatusTextProps } from "../types";
import { COLORS, FONT_SIZES, SPACING } from "../styles/theme";

const VARIANT_COLORS: Record<
  NonNullable<StatusTextProps["variant"]>,
  string
> = {
  normal: COLORS.textPrimary,
  warning: COLORS.warning,
  error: COLORS.danger,
  success: COLORS.success,
};

export default function StatusText({
  message,
  variant = "normal",
}: StatusTextProps) {
  return (
    <View
      style={styles.container}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.text, { color: VARIANT_COLORS[variant] }]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.overlay,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: 12,
    alignItems: "center",
  },
  text: {
    fontSize: FONT_SIZES.large,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 36,
  },
});
