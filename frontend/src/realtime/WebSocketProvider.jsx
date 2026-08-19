import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useAuth } from "../auth/AuthProvider.jsx";

const WebSocketContext = createContext(null);

// One connection, shared app-wide — not one per component. A product grid
// can render dozens of ProductCards; each opening its own connection would
// multiply both browser sockets and rows in the connections table for no
// benefit, since every message is broadcast (StockUpdated) or admin-scoped
// (OrderResolved/OrderNeedsReconciliation) rather than per-component.
export function WebSocketProvider({ children }) {
  const { idToken } = useAuth();
  const socketRef = useRef(null);
  const listenersRef = useRef(new Map()); // type -> Set<callback>
  const reconnectTimerRef = useRef(null);

  const dispatch = useCallback((message) => {
    const listeners = listenersRef.current.get(message.type);
    if (!listeners) return;
    for (const callback of listeners) callback(message);
  }, []);

  useEffect(() => {
    if (!idToken) {
      socketRef.current?.close();
      return;
    }

    // Missing config must degrade to "no live updates" — the same as any
    // other connection failure — not an unhandled exception. `new
    // WebSocket("undefined?token=...")` throws synchronously (an invalid
    // URL, not a connection error), which is a different failure mode from
    // the reconnect-on-close logic below and would bypass it entirely.
    if (!import.meta.env.VITE_WS_BASE_URL) {
      console.warn("VITE_WS_BASE_URL is not configured — real-time updates are disabled.");
      return;
    }

    let cancelled = false;
    let retryDelayMs = 1000;

    function connect() {
      if (cancelled) return;
      const url = `${import.meta.env.VITE_WS_BASE_URL}?token=${encodeURIComponent(idToken)}`;
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        // An invalid non-empty URL is a configuration error, distinct from
        // an ordinary dropped connection. Retrying the same invalid value
        // forever would be noisy and cannot repair it.
        console.warn("VITE_WS_BASE_URL is invalid — real-time updates are disabled.", error);
        return;
      }
      socketRef.current = socket;

      socket.onmessage = (event) => {
        try {
          dispatch(JSON.parse(event.data));
        } catch {
          // A malformed frame is a server-side bug, not something the UI
          // can act on — dropped rather than crashing the page over it.
        }
      };

      socket.onopen = () => { retryDelayMs = 1000; };

      // A dropped connection (network blip, the 2-hour/10-minute AWS
      // connection limits) is expected, ordinary behaviour here, not an
      // error state the user needs to see — reconnect quietly. Backs off
      // rather than retrying at a fixed interval, capped so a genuinely
      // down endpoint doesn't retry indefinitely at the fastest rate.
      socket.onclose = () => {
        if (cancelled) return;
        reconnectTimerRef.current = setTimeout(connect, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30000);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [idToken, dispatch]);

  const subscribe = useCallback((type, callback) => {
    if (!listenersRef.current.has(type)) listenersRef.current.set(type, new Set());
    listenersRef.current.get(type).add(callback);
    return () => listenersRef.current.get(type)?.delete(callback);
  }, []);

  return (
    <WebSocketContext.Provider value={{ subscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
}

// Subscribes `callback` to every message of `type` for the lifetime of the
// calling component. Silently a no-op if there's no provider or no
// connection (e.g. signed out) — a live update is a bonus on top of each
// component's own initial fetch, never the only way data reaches it.
export function useWebSocketMessage(type, callback) {
  const context = useContext(WebSocketContext);

  useEffect(() => {
    if (!context) return;
    return context.subscribe(type, callback);
  }, [context, type, callback]);
}
