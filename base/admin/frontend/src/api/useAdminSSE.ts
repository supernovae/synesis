import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Subscribes to /api/v1/events (SSE) and invalidates React Query caches
 * when the backend signals new data (e.g. new traces arriving).
 *
 * Uses fetch + ReadableStream (not EventSource) so we can pass the
 * Authorization header — EventSource doesn't support custom headers.
 *
 * Mount once in a top-level layout component.
 */
export function useAdminSSE() {
  const queryClient = useQueryClient();
  const retryDelay = useRef(1000);

  useEffect(() => {
    let aborted = false;
    let controller: AbortController | null = null;

    async function connect() {
      if (aborted) return;

      const token = localStorage.getItem("synesis_token");
      if (!token) return;

      controller = new AbortController();

      try {
        const res = await fetch("/api/v1/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }

        retryDelay.current = 1000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const payload = JSON.parse(line.slice(6)) as { type: string };
              if (payload.type === "new_traces") {
                queryClient.invalidateQueries({ queryKey: ["traces"] });
                queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              }
            } catch {
              // heartbeat or malformed
            }
          }
        }
      } catch (err) {
        if (aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
      }

      if (!aborted) {
        setTimeout(connect, retryDelay.current);
        retryDelay.current = Math.min(retryDelay.current * 2, 30_000);
      }
    }

    connect();

    return () => {
      aborted = true;
      controller?.abort();
    };
  }, [queryClient]);
}
