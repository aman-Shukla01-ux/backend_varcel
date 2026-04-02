require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

// ✅ YOUR REAL FRONTEND URL (FIXED)
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://frontend-varcel.vercel.app"
];

// ✅ CORS (HTTP)
app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

app.use(express.json());

// ================= ROOT ROUTE =================
app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

// ================= SOCKET.IO =================
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket"]
});

// ================= SOCKET AUTH =================
io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Missing token"));
  }

  try {
    const user = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key-change-this"
    );

    socket.userId = user.id;
    socket.userRole = user.role;
    socket.userName = user.name;

    next();
  } catch (err) {
    console.error("JWT Error:", err.message);
    next(new Error("Invalid token"));
  }
});

// ================= DATA =================
const activeSessions = new Map();
const userSessions = new Map();

// ================= SOCKET EVENTS =================
io.on("connection", (socket) => {
  console.log(`✅ Connected: ${socket.userId}`);

  socket.on("join-session", (sessionId, callback) => {
    if (!sessionId) {
      return callback && callback({ success: false, error: "Invalid session" });
    }

    socket.join(sessionId);
    userSessions.set(socket.id, sessionId);

    if (!activeSessions.has(sessionId)) {
      activeSessions.set(sessionId, []);
    }

    activeSessions.get(sessionId).push({
      userId: socket.userId,
      userName: socket.userName,
      role: socket.userRole,
      socketId: socket.id
    });

    callback && callback({ success: true });
  });

  socket.on("chat-message", (message, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;

    const msg = {
      id: uuidv4(),
      userId: socket.userId,
      userName: socket.userName,
      message,
      timestamp: new Date().toISOString()
    };

    io.to(sessionId).emit("chat-message", msg);
    callback && callback({ success: true });
  });

  socket.on("disconnect", () => {
    userSessions.delete(socket.id);
    console.log(`❌ Disconnected: ${socket.userId}`);
  });
});

// ================= REST APIs =================

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ✅ Create session
app.post("/api/sessions", (req, res) => {
  const sessionId = uuidv4();
  activeSessions.set(sessionId, []);
  res.json({ success: true, sessionId });
});

// ✅ Generate JWT token
app.post("/api/auth/token", (req, res) => {
  const { id, name, role } = req.body;

  if (!id || !name || !role) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const token = jwt.sign(
    { id, name, role },
    process.env.JWT_SECRET || "your-secret-key-change-this",
    { expiresIn: "24h" }
  );

  res.json({ success: true, token });
});

// ================= SERVER =================
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
