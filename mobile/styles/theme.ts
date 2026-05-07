/**
 * Shared theme constants for MBG assistive app.
 * High-contrast, large elements, accessibility-first.
 */
import { StyleSheet } from "react-native";

// ─── Colors ─────────────────────────────────────────────────────────────────

export const COLORS = {
  /** App background — very dark blue-black */
  background: "#1a1a2e",
  /** Primary surface — slightly lighter than background */
  surface: "#16213e",
  /** Primary accent — bright blue for active states */
  primary: "#4a90d9",
  /** Danger / error — warm red */
  danger: "#e74c3c",
  /** Warning — amber */
  warning: "#f39c12",
  /** Success — green */
  success: "#2ecc71",
  /** Primary text — white */
  textPrimary: "#ffffff",
  /** Secondary text — light gray */
  textSecondary: "#b0b0b0",
  /** Disabled state */
  disabled: "#555555",
  /** Overlay background for status text */
  overlay: "rgba(0, 0, 0, 0.65)",
} as const;

// ─── Typography ─────────────────────────────────────────────────────────────

export const FONT_SIZES = {
  /** Large status messages */
  large: 28,
  /** Button labels */
  medium: 22,
  /** Secondary info */
  small: 18,
} as const;

// ─── Spacing ────────────────────────────────────────────────────────────────

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

// ─── Touch Targets ──────────────────────────────────────────────────────────

export const TOUCH_TARGET = {
  /** Minimum button height for accessibility (80px) */
  minHeight: 80,
  /** Border radius for buttons */
  borderRadius: 16,
} as const;

// ─── Common Styles ──────────────────────────────────────────────────────────

export const commonStyles = StyleSheet.create({
  /** Full-screen container with dark background */
  screenContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  /** Centered content container */
  centeredContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: SPACING.lg,
  },
});
