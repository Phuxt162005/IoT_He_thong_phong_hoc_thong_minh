import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth';
export type SocketStatus = 'connected' | 'reconnecting' | 'disconnected';
export function useWebSocket(roomIds: string[] = [], onEvent?: (event: unknown) => void): SocketStatus {
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState<SocketStatus>('disconnected');
  useEffect(() => {
    if (!token || import.meta.env.VITE_USE_MOCK === 'true') { setStatus(token ? 'connected' : 'disconnected'); return; }
    const url = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retry = 0;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      setStatus(retry ? 'reconnecting' : 'disconnected');
      socket = new WebSocket(url);
      socket.onopen = () => {
        retry = 0;
        setStatus('connected');
        socket?.send(JSON.stringify({ type: 'authenticate', token }));
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as { type?: string; event?: string };
          if (event.type === 'authenticated') socket?.send(JSON.stringify({ type: 'subscribe', room_ids: roomIds }));
          if (event.event === 'session.revoked') useAuthStore.getState().logout();
          onEvent?.(event);
        } catch { setStatus('disconnected'); }
      };
      socket.onclose = () => {
        if (stopped) return;
        retry += 1;
        retryTimer = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(retry, 5)));
      };
      socket.onerror = () => setStatus('disconnected');
    };
    connect();
    return () => { stopped = true; if (retryTimer) window.clearTimeout(retryTimer); socket?.close(); };
  }, [token, onEvent, roomIds.join(',')]);
  return status;
}
