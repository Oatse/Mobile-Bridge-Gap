/**
 * AccessibleButton — Large, high-contrast button for assistive interaction.
 * Minimum 80px height, full-width, clear visual states.
 */

import React from "react";
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  type ViewStyle,
} from "react-native";
import type { AccessibleButtonProps } from "../types";
import { COLORS, FONT_SIZES, SPACING, TOUCH_TARGET } from "../styles/theme";

const VARIANT_STYLES: Record<
  NonNullable<AccessibleButtonProps["variant"]>,
  ViewStyle
> = {
  primary: { backgroundColor: COLORS.primary },
  danger: { backgroundColor: COLORS.danger },
  secondary: { backgroundColor: COLORS.surface, borderWidth: 2, borderColor: COLORS.primary },
};

export default function AccessibleButton({
  label,
  onPress,
  disabled = false,
  accessibilityHint,
  variant = "primary",
}: AccessibleButtonProps) {
  return (
    <TouchableOpacity
      style={[
        styles.button,
        VARIANT_STYLES[variant],
        disabled && styles.disabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
    >
      <Text style={[styles.label, disabled && styles.disabledLabel]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: TOUCH_TARGET.minHeight,
    borderRadius: TOUCH_TARGET.borderRadius,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    width: "100%",
  },
  label: {
    color: COLORS.textPrimary,
    fontSize: FONT_SIZES.medium,
    fontWeight: "700",
    textAlign: "center",
  },
  disabled: {
    backgroundColor: COLORS.disabled,
    opacity: 0.6,
  },
  disabledLabel: {
    color: COLORS.textSecondary,
  },
});
