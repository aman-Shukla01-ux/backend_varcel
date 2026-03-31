require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

// Express App
const app = express();
const server = http.createServer(app);

// ====== CONFIG ======
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.ALLOWED_ORIGINS || "https://frontend-varcel.vercel.app";
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Middleware
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// ====== SOCKET.IO ======
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    credentials: true,
  },
  transports: ["websocket"],
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ====== SESSION MANAGEMENT ======
const activeSessions = new Map();
const userSessions = new Map();

// ====== INPUT VALIDATION ======
function validateInput(data, maxLength = 10000) {
  if (typeof data === "string") return data.substring(0, maxLength).trim();
  return null;
}

// ====== SOCKET AUTH ======
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Missing authentication token"));

  try {
    const user = jwt.verify(token, JWT_SECRET);
    socket.userId = user.id;
    socket.userRole = user.role;
    socket.userName = user.name;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    next(new Error("Invalid token"));
  }
});

// ====== SOCKET CONNECTION ======
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.userId} (${socket.userRole})`);

  // JOIN SESSION
  socket.on("join-session", (sessionId, callback) => {
    const validSessionId = validateInput(sessionId, 100);
    if (!validSessionId) return callback({ success: false, error: "Invalid session ID" });

    socket.join(validSessionId);
    userSessions.set(socket.id, validSessionId);

    if (!activeSessions.has(validSessionId)) activeSessions.set(validSessionId, []);
    activeSessions.get(validSessionId).push({
      userId: socket.userId,
      userName: socket.userName,
      role: socket.userRole,
      socketId: socket.id,
      joinedAt: new Date(),
    });

    socket.to(validSessionId).emit("user-joined", {
      userId: socket.userId,
      userName: socket.userName,
      role: socket.userRole,
      timestamp: new Date(),
    });

    const users = activeSessions.get(validSessionId);
    callback({ success: true, userCount: users.length, isInitiator: users.length === 1 });
  });

  // WebRTC Offer
  socket.on("webrtc-offer", (data, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });
    socket.to(sessionId).emit("webrtc-offer", { offer: data, from: socket.userId, fromName: socket.userName });
    callback({ success: true });
  });

  // WebRTC Answer
  socket.on("webrtc-answer", (data, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });
    socket.to(sessionId).emit("webrtc-answer", { answer: data, from: socket.userId, fromName: socket.userName });
    callback({ success: true });
  });

  // ICE Candidate
  socket.on("webrtc-candidate", (data, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });
    socket.to(sessionId).emit("webrtc-candidate", { candidate: data, from: socket.userId });
    callback({ success: true });
  });

  // Chat Message
  socket.on("chat-message", (message, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });

    const sanitizedMsg = validateInput(message, 1000);
    if (!sanitizedMsg) return callback({ success: false, error: "Empty message" });

    const msgData = {
      id: uuidv4(),
      userId: socket.userId,
      userName: socket.userName,
      message: sanitizedMsg,
      timestamp: new Date().toISOString(),
      role: socket.userRole,
    };

    io.to(sessionId).emit("chat-message", msgData);
    callback({ success: true, data: msgData });
  });

  // Leave Session
  socket.on("leave-session", () => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;

    socket.leave(sessionId);
    const users = activeSessions.get(sessionId) || [];
    activeSessions.set(sessionId, users.filter(u => u.socketId !== socket.id));
    userSessions.delete(socket.id);

    socket.to(sessionId).emit("user-left", { userId: socket.userId, userName: socket.userName });
  });

  // Disconnect
  socket.on("disconnect", () => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;

    const users = activeSessions.get(sessionId) || [];
    activeSessions.set(sessionId, users.filter(u => u.socketId !== socket.id));
    userSessions.delete(socket.id);

    socket.to(sessionId).emit("user-disconnected", { userId: socket.userId });
    console.log(`❌ User disconnected: ${socket.userId}`);
  });
});

// ====== REST API ======

// Health Check
app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date() }));

// Create Session
app.post("/api/sessions", (req, res) => {
  const sessionId = uuidv4();
  activeSessions.set(sessionId, []);
  res.json({ success: true, sessionId });
});

// Generate Token
app.post("/api/auth/token", (req, res) => {
  const { id, name, role } = req.body;
  if (!id || !name || !role) return res.status(400).json({ error: "Missing id, name, or role" });

  const token = jwt.sign({ id, name, role }, JWT_SECRET, { expiresIn: "24h" });
  res.json({ success: true, token });
});

// ====== START SERVER ======
server.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
});

// Graceful Shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});
