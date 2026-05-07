/**
 * Image utilities — compression and URI normalization.
 * Ensures images are properly sized and have valid file URIs for upload.
 */

import { Platform } from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
import { IMAGE_TARGET_SIZE, IMAGE_QUALITY } from "../constants/config";

/**
 * Normalize a file path into a proper `file://` URI.
 *
 * Android ImageManipulator can return paths in various formats:
 * - `file:///data/...` (already valid)
 * - `/data/user/0/...` (absolute path, missing scheme)
 * - `content://...` (content URI, pass through)
 * - `7ecbadcd-...jpg` (bare filename — broken)
 *
 * @param uri - Raw URI or path from camera/manipulator
 * @returns Normalized `file://` URI safe for FormData upload
 */
export function normalizeFileUri(uri: string): string {
  if (!uri) {
    console.warn("[MBG:Image] normalizeFileUri received empty URI");
    return uri;
  }

  // Already a valid file:// or content:// URI
  if (uri.startsWith("file://") || uri.startsWith("content://")) {
    return uri;
  }

  // Absolute path without scheme (common on Android)
  if (uri.startsWith("/")) {
    return `file://${uri}`;
  }

  // Windows-style path (unlikely in RN but defensive)
  if (/^[A-Za-z]:[\\/]/.test(uri)) {
    return `file:///${uri.replace(/\\/g, "/")}`;
  }

  // Bare filename or relative path — this is the broken case
  // Attempt to construct a valid path using the cache directory
  console.warn("[MBG:Image] Suspicious URI (bare filename?):", uri);

  if (Platform.OS === "android") {
    // Android ImageManipulator typically outputs to cache
    return `file:///data/user/0/com.anonymous.mobile/cache/ImageManipulator/${uri}`;
  }

  // iOS fallback — should rarely reach here
  return `file://${uri}`;
}

/**
 * Compress and resize an image for upload.
 * - Resizes to fit within IMAGE_TARGET_SIZE (384px)
 * - Compresses to JPEG at IMAGE_QUALITY (0.8)
 * - Normalizes the output URI to a valid file:// format
 *
 * @param uri - Local file URI of the captured image
 * @returns Normalized URI of the compressed image
 */
export async function compressImage(uri: string): Promise<string> {
  console.log("[MBG:Image] compressImage input URI:", uri);

  const result = await ImageManipulator.manipulateAsync(
    uri,
    [
      {
        resize: {
          width: IMAGE_TARGET_SIZE,
          height: IMAGE_TARGET_SIZE,
        },
      },
    ],
    {
      compress: IMAGE_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    }
  );

  console.log("[MBG:Image] manipulateAsync raw output URI:", result.uri);

  const normalizedUri = normalizeFileUri(result.uri);

  if (normalizedUri !== result.uri) {
    console.log("[MBG:Image] URI normalized:", normalizedUri);
  }

  return normalizedUri;
}
