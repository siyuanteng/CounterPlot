import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { startMotionClip, jobs as veoJobs } from "./veo.mjs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { Server } from "socket.io";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const generatedDir = path.join(rootDir, "generated");

if (!fs.existsSync(generatedDir)) {
  fs.mkdirSync(generatedDir, { recursive: true });
}

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/generated", express.static(generatedDir));

// ─────────────────────────────────────────────────────────────────────────────
//  Veo motion clip routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/motion-clip
 * Body: { imageUrl: string, turnId: string, motionPrompt?: string }
 * Returns: { jobId: string }
 */
app.post("/api/motion-clip", (req, res) => {
  const { imageUrl, turnId, motionPrompt } = req.body;
  console.log(`[veo route] POST /api/motion-clip  imageUrl=${imageUrl}  turnId=${turnId}`);

  if (!imageUrl || typeof imageUrl !== "string") {
    console.warn("[veo route] rejected: imageUrl missing or not a string");
    return res.status(400).json({ error: "imageUrl is required" });
  }
  if (!turnId || typeof turnId !== "string") {
    console.warn("[veo route] rejected: turnId missing or not a string");
    return res.status(400).json({ error: "turnId is required" });
  }

  if (!process.env.GOOGLE_CLOUD_PROJECT) {
    console.warn("[veo route] rejected: GOOGLE_CLOUD_PROJECT env var not set");
    return res.status(503).json({ error: "Veo not configured (GOOGLE_CLOUD_PROJECT missing)" });
  }

  const prompt = motionPrompt || defaultMotionPrompt();
  const serverBase = `${req.protocol}://${req.get("host")}`;
  const jobId = startMotionClip(imageUrl, prompt, turnId, serverBase);

  console.log(`[veo route] enqueued  jobId=${jobId}  turn=${turnId}  imageUrl=${imageUrl}`);
  return res.json({ jobId });
});

/**
 * GET /api/motion-clip/:jobId
 * Returns: { status: 'pending'|'done'|'error', clipUrl?, error? }
 */
app.get("/api/motion-clip/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = veoJobs.get(jobId);
  if (!job) {
    console.warn(`[veo route] poll ${jobId} — not found`);
    return res.status(404).json({ error: "job not found" });
  }
  console.log(`[veo route] poll ${jobId}  status=${job.status}${job.error ? `  error=${job.error}` : ""}${job.clipUrl ? `  clipUrl=${job.clipUrl}` : ""}`);
  return res.json(job);
});

function defaultMotionPrompt() {
  return (
    "Subtle atmospheric motion. Gentle camera drift, soft environmental movement — " +
    "flickering light, drifting particles, slight cloth or hair micro-movement. " +
    "Preserve original composition. No sudden subject motion."
  );
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

app.post("/api/generate-still", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: prompt,
    });

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part.inlineData);

    if (!imagePart?.inlineData?.data) {
      return res.status(500).json({
        error: "No image returned from Gemini",
        rawParts: parts,
      });
    }

    const base64 = imagePart.inlineData.data;
    const buffer = Buffer.from(base64, "base64");

    const filename = `scene-${Date.now()}.png`;
    const filepath = path.join(generatedDir, filename);

    fs.writeFileSync(filepath, buffer);

    return res.json({
      imageUrl: `/generated/${filename}`,
    });
  } catch (error) {
    console.error("generate-still failed:", error);
    return res.status(500).json({
      error: "Failed to generate still image",
      detail: error?.message || String(error),
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Room store
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory room store. Each room lives until 30 min after all seats disconnect. */
const rooms = new Map();

/** Per-socket metadata — avoids monkey-patching the socket object. */
const socketMeta = new Map(); // socketId → { roomId, playerId }

const ROOM_TTL_MS = 30 * 60 * 1000;

function makeId(bytes) {
  return randomBytes(bytes).toString("hex");
}

function getPresence(room) {
  return {
    A: room.seats.A.connected,
    B: room.seats.B.connected,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────────────────────

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*", // tighten to specific origin in production
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50 MB — allow base64 image payloads
});

io.on("connection", (socket) => {
  console.log(`[socket] connected  ${socket.id}`);

  // ── create-room ─────────────────────────────────────────────────────────────
  // Payload: { initialState: GameState }
  // Creates a new room with two seat tokens and stores the initial state.
  // The caller (SetupView) receives both tokens and builds the join URLs.
  socket.on("create-room", ({ initialState }) => {
    if (!initialState || typeof initialState !== "object") {
      socket.emit("room-error", { code: "BAD_PAYLOAD", message: "initialState is required" });
      return;
    }

    const roomId = makeId(4); // 8-char hex
    const tokenA = makeId(16); // 32-char hex
    const tokenB = makeId(16);

    const room = {
      roomId,
      state: { ...initialState, sessionId: roomId },
      seats: {
        A: { playerId: "A", token: tokenA, connected: false, socketIds: new Set() },
        B: { playerId: "B", token: tokenB, connected: false, socketIds: new Set() },
      },
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    rooms.set(roomId, room);
    console.log(`[room] created  ${roomId}`);

    socket.emit("room-created", {
      roomId,
      seats: {
        A: { token: tokenA },
        B: { token: tokenB },
      },
    });
  });

  // ── join-room ────────────────────────────────────────────────────────────────
  // Payload: { roomId, playerId: 'A'|'B', token }
  // Validates seat token, adds socket to the socket.io room, returns snapshot.
  // Multiple sockets per seat are allowed (same-device multi-tab).
  socket.on("join-room", ({ roomId, playerId, token }) => {
    // Validate seat id
    if (playerId !== "A" && playerId !== "B") {
      socket.emit("room-error", { code: "INVALID_SEAT", message: "playerId must be A or B" });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("room-error", { code: "NOT_FOUND", message: `Room ${roomId} not found` });
      return;
    }

    // Validate seat token
    const seat = room.seats[playerId];
    if (seat.token !== token) {
      socket.emit("room-error", { code: "INVALID_TOKEN", message: "Token does not match seat" });
      return;
    }

    // Register socket in seat and socket.io room
    seat.socketIds.add(socket.id);
    seat.connected = true;
    room.lastActiveAt = Date.now();

    socket.join(roomId);
    socketMeta.set(socket.id, { roomId, playerId });

    const presence = getPresence(room);

    // Return full snapshot to the joining socket
    socket.emit("room-joined", {
      roomId,
      seat: playerId,
      snapshot: room.state,
      presence,
    });

    // Notify all other sockets in the room of the updated presence
    socket.to(roomId).emit("presence-changed", presence);

    console.log(`[room] ${roomId}  seat ${playerId} joined  (socket ${socket.id})`);
  });

  // ── push-state ───────────────────────────────────────────────────────────────
  // Payload: { roomId, playerId: 'A'|'B', token, state: GameState }
  // Guards: token must match seat, and it must currently be this player's turn.
  // On success, broadcasts state-updated to ALL sockets in the room (server is truth).
  socket.on("push-state", ({ roomId, playerId, token, state }) => {
    // Validate seat id
    if (playerId !== "A" && playerId !== "B") {
      socket.emit("room-error", { code: "INVALID_SEAT", message: "playerId must be A or B" });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("room-error", { code: "NOT_FOUND", message: `Room ${roomId} not found` });
      return;
    }

    // Validate seat token
    const seat = room.seats[playerId];
    if (seat.token !== token) {
      socket.emit("room-error", { code: "INVALID_TOKEN", message: "Token does not match seat" });
      return;
    }

    // Turn guard: only the player whose turn it currently is may advance state.
    // Check against the *current* server state, not the incoming state.
    if (room.state.currentPlayer !== playerId) {
      socket.emit("room-error", {
        code: "NOT_YOUR_TURN",
        message: `It is ${room.state.currentPlayer}'s turn`,
      });
      return;
    }

    // Accept state — server becomes the new source of truth
    room.state = state;
    room.lastActiveAt = Date.now();

    // Broadcast to all sockets in room including sender
    io.to(roomId).emit("state-updated", {
      state,
      updatedBy: playerId,
    });

    console.log(`[room] ${roomId}  state pushed by ${playerId}  turn=${state.currentTurn}`);
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);

    if (!meta) return;
    const { roomId, playerId } = meta;

    const room = rooms.get(roomId);
    if (!room) return;

    const seat = room.seats[playerId];
    seat.socketIds.delete(socket.id);

    // Seat is disconnected only when its last socket closes
    if (seat.socketIds.size === 0) {
      seat.connected = false;
    }

    const presence = getPresence(room);
    io.to(roomId).emit("presence-changed", presence);

    console.log(`[room] ${roomId}  seat ${playerId} disconnected  (socket ${socket.id})`);

    // Schedule TTL cleanup only when both seats are fully disconnected
    if (!presence.A && !presence.B) {
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && !r.seats.A.connected && !r.seats.B.connected) {
          rooms.delete(roomId);
          console.log(`[room] cleaned up  ${roomId}`);
        }
      }, ROOM_TTL_MS);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

httpServer.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
