/**
 * useDescribeApi — Hook wrapping the backend /describe API call.
 * Manages loading state, response, and error.
 */

import { useState, useCallback } from "react";
import { describeImage } from "../services/api";
import type { DescribeResponse } from "../types";

interface UseDescribeApiReturn {
  /** Send an image + command to the backend */
  sendDescribeRequest: (
    imageUri: string,
    command: string
  ) => Promise<DescribeResponse | null>;
  /** Whether a request is in flight */
  isLoading: boolean;
  /** Last successful or failed response */
  lastResponse: DescribeResponse | null;
  /** Error message if the request failed at the network level */
  error: string | null;
}

export default function useDescribeApi(): UseDescribeApiReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [lastResponse, setLastResponse] = useState<DescribeResponse | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const sendDescribeRequest = useCallback(
    async (
      imageUri: string,
      command: string
    ): Promise<DescribeResponse | null> => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await describeImage(imageUri, command);
        setLastResponse(response);
        return response;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Terjadi kesalahan. Silakan coba lagi.";
        setError(message);
        setLastResponse(null);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return {
    sendDescribeRequest,
    isLoading,
    lastResponse,
    error,
  };
}
