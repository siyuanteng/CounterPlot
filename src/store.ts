import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { GameState } from './types';

// ─────────────────────────────────────────────────────────────────────────────
//  Socket multiplayer — Step 2
// ─────────────────────────────────────────────────────────────────────────────

// In dev, Vite runs on a different port than the backend — connect Socket.IO directly
// to the backend using the port from .env (exposed as VITE_BACKEND_PORT by vite.config.ts).
// In production, frontend and backend are the same server (same origin).
const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:${import.meta.env.VITE_BACKEND_PORT || '3001'}`
    : window.location.origin);

export interface Presence {
  A: boolean;
  B: boolean;
}

/** Strip base64 data URLs from panels before sending over the wire. */
function stripImagesForTransport(state: GameState): GameState {
  return {
    ...state,
    storyboard: state.storyboard.map(card => ({
      ...card,
      panels: card.panels?.map(panel => ({
        ...panel,
        imageUrl: panel.imageUrl.startsWith('data:') ? '' : panel.imageUrl,
      })),
    })),
  };
}

/**
 * One-shot room creation via socket.io.
 * Connects, emits create-room, calls onCreated with (roomId, tokenA, tokenB),
 * then disconnects. Returns a cleanup function.
 */
export function createSocketRoom(
  initialState: GameState,
  onCreated: (roomId: string, tokenA: string, tokenB: string) => void,
  onError: (message: string) => void,
): () => void {
  const socket: Socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
  let settled = false;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.disconnect();
    fn();
  };

  const timer = setTimeout(() => {
    settle(() => onError(`Cannot connect to server at ${SERVER_URL} — connection timed out`));
  }, 8000);

  socket.on('connect', () => {
    socket.emit('create-room', { initialState });
  });

  socket.on('room-created', ({ roomId, seats }: {
    roomId: string;
    seats: { A: { token: string }; B: { token: string } };
  }) => {
    settle(() => onCreated(roomId, seats.A.token, seats.B.token));
  });

  socket.on('room-error', ({ message }: { message: string }) => {
    settle(() => onError(message));
  });

  socket.on('connect_error', (err: Error) => {
    settle(() => onError(`Cannot connect to server at ${SERVER_URL}: ${err.message}`));
  });

  return () => { settled = true; clearTimeout(timer); socket.disconnect(); };
}

/**
 * Socket-based game state hook for true multiplayer.
 * Joins a room with roomId + playerId + token on mount.
 * Returns a no-op when any param is null — safe to call unconditionally
 * alongside useGameState so DuelView can branch without violating hook rules.
 */
export function useSocketGameState(
  roomId: string | null,
  playerId: string | null,
  token: string | null,
) {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [presence, setPresence] = useState<Presence>({ A: false, B: false });
  const socketRef = useRef<Socket | null>(null);
  // Mirror of gameState held in a ref so updateGameState can read current state
  // synchronously without going through a setState updater function.
  // This avoids React StrictMode double-invoking the updater and emitting push-state twice.
  const gameStateRef = useRef<GameState | null>(null);

  useEffect(() => {
    if (!roomId || !playerId || !token) {
      setLoading(false);
      return;
    }

    const socket: Socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    // join-room on every connect — handles both initial connect and reconnects
    const doJoin = () => socket.emit('join-room', { roomId, playerId, token });
    socket.on('connect', doJoin);

    socket.on('room-joined', ({ snapshot, presence: p }: {
      roomId: string; seat: string; snapshot: GameState; presence: Presence;
    }) => {
      gameStateRef.current = snapshot;
      setGameState(snapshot);
      setPresence(p);
      setLoading(false);
      setError(null);
    });

    socket.on('state-updated', ({ state, updatedBy }: {
      state: GameState; updatedBy: string;
    }) => {
      // Skip if we pushed this update — our local copy retains image data
      // that was stripped before transmission.
      if (updatedBy === playerId) return;
      gameStateRef.current = state;
      setGameState(state);
    });

    socket.on('presence-changed', (p: Presence) => {
      setPresence(p);
    });

    socket.on('room-error', ({ code, message }: { code: string; message: string }) => {
      if (code === 'NOT_YOUR_TURN') {
        // Stale push rejection — the state was already committed on a prior emit.
        // This can occur due to React StrictMode double-invoking updaters in dev,
        // or a race condition. It is not fatal; the game continues normally.
        console.warn('[socket] ignored stale push-state rejection:', message);
        return;
      }
      setError(`[${code}] ${message}`);
      setLoading(false);
    });

    socket.on('connect_error', (err: Error) => {
      setError(`Connection failed: ${err.message}`);
      setLoading(false);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, playerId, token]);

  const updateGameState = useCallback(
    (updater: (prev: GameState) => GameState) => {
      if (!roomId || !playerId || !token) return;
      // Read current state from ref, not from a setState updater.
      // A setState updater function is invoked twice in React StrictMode (dev),
      // which would cause push-state to emit twice — the second emit arrives
      // after currentPlayer has already flipped and gets rejected as NOT_YOUR_TURN.
      const prev = gameStateRef.current;
      if (!prev) return;
      const newState = updater(prev);
      gameStateRef.current = newState;
      setGameState(newState);
      // Emit exactly once, outside any setState call
      socketRef.current?.emit('push-state', {
        roomId,
        playerId,
        token,
        state: newState,
      });
    },
    [roomId, playerId, token],
  );

  return { gameState, updateGameState, error, loading, presence };
}

export function useGameState(sessionId: string | null) {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) {
      setError('Missing session ID');
      setLoading(false);
      return;
    }

    const storageKey = `storyRelay:${sessionId}`;
    
    const loadState = () => {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          setGameState(JSON.parse(stored));
          setError(null);
        } catch (e) {
          console.error('Failed to parse stored game state', e);
          setError('Failed to parse session data');
        }
      } else {
        setError(`Room data not found (session=${sessionId}), please return to the shelf and recreate`);
      }
      setLoading(false);
    };

    const timer = setTimeout(() => {
      loadState();
    }, 100);

    const channel = new BroadcastChannel(storageKey);
    
    channel.onmessage = (event) => {
      setGameState(event.data);
      setError(null);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey && e.newValue) {
        try {
          setGameState(JSON.parse(e.newValue));
          setError(null);
        } catch (err) {}
      } else if (e.key === storageKey && !e.newValue) {
        setError(`Room data has been deleted`);
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      clearTimeout(timer);
      channel.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [sessionId]);

  const updateGameState = useCallback((updater: (prev: GameState) => GameState) => {
    if (!sessionId) return;
    const storageKey = `storyRelay:${sessionId}`;

    const stripImages = (state: GameState): GameState => ({
      ...state,
      storyboard: state.storyboard.map(card => ({
        ...card,
        panels: card.panels?.map(panel => ({
          ...panel,
          imageUrl: panel.imageUrl.startsWith('data:') ? '' : panel.imageUrl,
        })),
      })),
    });

    const tryStore = (state: GameState) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(state));
      } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014) {
          // Base64 images blew the quota — retry without them
          try {
            localStorage.setItem(storageKey, JSON.stringify(stripImages(state)));
          } catch {
            console.warn('[store] localStorage quota exceeded even after stripping images');
          }
        }
      }
    };

    setGameState((prev) => {
      if (!prev) return prev;
      const newState = updater(prev);
      tryStore(newState);
      // Always broadcast full state (including images) to other tabs
      const channel = new BroadcastChannel(storageKey);
      channel.postMessage(newState);
      channel.close();
      return newState;
    });
  }, [sessionId]);

  return { gameState, updateGameState, error, loading };
}

export function createNewSession(initialState: GameState) {
  const storageKey = `storyRelay:${initialState.sessionId}`;
  localStorage.setItem(storageKey, JSON.stringify(initialState));
}
