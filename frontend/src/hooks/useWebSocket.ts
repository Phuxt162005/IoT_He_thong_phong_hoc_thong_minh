import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth";
export type SocketStatus = "connected" | "reconnecting" | "disconnected";
const affected: Record<string, string[]> = {
  "telemetry.stored": [
    "dashboard",
    "dashboard-chart",
    "telemetry",
    "telemetry-stats",
  ],
  "device.status_changed": ["devices", "shadow", "monitoring"],
  "device.lifecycle_changed": ["devices", "lifecycle", "broker", "dashboard"],
  "device.mode_changed": ["devices", "shadow"],
  "command.updated": ["commands", "shadow"],
  "actuator.state_changed": ["shadow"],
  "alert.created": ["alerts", "dashboard"],
  "alert.updated": ["alerts", "dashboard"],
  "anomaly.detected": ["anomalies"],
  "config.updated": ["configs"],
};
export function useWebSocket(): SocketStatus {
  const token = useAuthStore((state) => state.token);
  const queries = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>("disconnected");
  useEffect(() => {
    if (!token) {
      setStatus("disconnected");
      return;
    }
    if (import.meta.env.VITE_USE_MOCK === "true") {
      setStatus("connected");
      return;
    }
    let socket: WebSocket | undefined,
      retryTimer: number | undefined,
      refreshTimer: number | undefined,
      stopped = false,
      retry = 0,
      lastRefresh = 0;
    const pending = new Set<string>();
    const refresh = (keys: string[]) => {
      if (!keys.length) return;
      keys.forEach((key) => pending.add(key));
      if (refreshTimer) return;
      refreshTimer = window.setTimeout(
        () => {
          refreshTimer = undefined;
          lastRefresh = Date.now();
          const names = new Set(pending);
          pending.clear();
          void queries.invalidateQueries({
            predicate: (query) => names.has(String(query.queryKey[0])),
            refetchType: "active",
          });
        },
        Math.max(250, 15000 - (Date.now() - lastRefresh)),
      );
    };
    const connect = () => {
      if (stopped) return;
      setStatus(retry ? "reconnecting" : "disconnected");
      socket = new WebSocket(
        import.meta.env.VITE_WS_URL ||
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      socket.onopen = () =>
        socket?.send(JSON.stringify({ type: "authenticate", token }));
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as {
            type: string;
            payload?: unknown;
          };
          if (event.type === "authenticated") {
            retry = 0;
            setStatus("connected");
            refresh([
              "dashboard",
              "dashboard-chart",
              "telemetry",
              "telemetry-stats",
              "devices",
              "rooms",
              "alerts",
              "commands",
              "shadow",
              "configs",
              "anomalies",
              "ota",
              "ota-jobs",
            ]);
          }
          if (event.type === "session.revoked")
            useAuthStore.getState().logout();
          refresh(affected[event.type] || []);
          window.dispatchEvent(new CustomEvent("iot:event", { detail: event }));
        } catch {
          setStatus("disconnected");
        }
      };
      socket.onclose = (event) => {
        if (stopped) return;
        setStatus("disconnected");
        if (event.code === 4001) {
          useAuthStore.getState().logout();
          return;
        }
        retry++;
        retryTimer = window.setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** Math.min(retry, 5)),
        );
      };
      socket.onerror = () => setStatus("disconnected");
    };
    connect();
    return () => {
      stopped = true;
      socket?.close();
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [token, queries]);
  return status;
}
