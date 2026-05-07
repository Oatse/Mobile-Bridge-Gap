/**
 * useCamera — Camera hook wrapping expo-camera.
 * Provides permission handling, camera ref, and image capture with compression.
 */

import { useState, useRef, useCallback } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { compressImage } from "../utils/imageHelper";

interface UseCameraReturn {
  /** Ref to attach to CameraView component */
  cameraRef: React.RefObject<CameraView | null>;
  /** Whether camera permission has been granted */
  hasPermission: boolean | null;
  /** Request camera permission */
  requestPermission: () => Promise<boolean>;
  /** Capture and compress an image. Returns compressed URI or null on failure. */
  captureAndCompress: () => Promise<string | null>;
  /** Whether an image capture is in progress */
  isCapturing: boolean;
}

export default function useCamera(): UseCameraReturn {
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestCameraPermission] = useCameraPermissions();
  const [isCapturing, setIsCapturing] = useState(false);

  const hasPermission = permission?.granted ?? null;

  const requestPermission = useCallback(async (): Promise<boolean> => {
    const result = await requestCameraPermission();
    return result.granted;
  }, [requestCameraPermission]);

  const captureAndCompress = useCallback(async (): Promise<string | null> => {
    if (!cameraRef.current) {
      console.error("[MBG:Camera] cameraRef is null — cannot capture");
      return null;
    }

    setIsCapturing(true);

    try {
      console.log("[MBG:Camera] Taking picture...");
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        skipProcessing: true,
      });

      if (!photo?.uri) {
        console.error("[MBG:Camera] takePictureAsync returned no URI");
        return null;
      }

      console.log("[MBG:Camera] Raw capture URI:", photo.uri);

      const compressedUri = await compressImage(photo.uri);
      console.log("[MBG:Camera] Final compressed URI:", compressedUri);

      return compressedUri;
    } catch (err) {
      console.error("[MBG:Camera] Capture/compress failed:", err);
      return null;
    } finally {
      setIsCapturing(false);
    }
  }, []);

  return {
    cameraRef,
    hasPermission,
    requestPermission,
    captureAndCompress,
    isCapturing,
  };
}
