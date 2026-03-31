require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

// ✅ SECURITY: Restrict CORS to trusted domains
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || "http://localhost:3001"
).split(",");

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
  pingInterval: 25000,
  pingTimeout: 20000,
});

// Middleware
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// ✅ SECURITY: Socket.io authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error("Missing authentication token"));
  }
  try {
    const user = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key-change-this"
    );
    socket.userId = user.id;
    socket.userRole = user.role; // 'mentor' or 'student'
    socket.userName = user.name;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    next(new Error("Invalid token"));
  }
});

// ✅ Track active sessions and users
const activeSessions = new Map();
const userSessions = new Map();

// ✅ Input validation helper
function validateInput(data, maxLength = 10000) {
  if (typeof data === "string") {
    return data.substring(0, maxLength).trim();
  }
  return data;
}

io.on("connection", (socket) => {
  console.log(
    `✅ User connected: ${socket.userId} (${socket.userRole}) - Socket: ${socket.id}`
  );

  // ✅ Join session room
  socket.on("join-session", (sessionId, callback) => {
    const validSessionId = validateInput(sessionId, 100);
    if (!validSessionId) {
      return callback({ success: false, error: "Invalid session ID" });
    }

    socket.join(validSessionId);
    userSessions.set(socket.id, validSessionId);

    if (!activeSessions.has(validSessionId)) {
      activeSessions.set(validSessionId, []);
    }
    activeSessions.get(validSessionId).push({
      userId: socket.userId,
      userName: socket.userName,
      role: socket.userRole,
      socketId: socket.id,
      joinedAt: new Date(),
    });

    console.log(`📍 User ${socket.userId} joined session ${validSessionId}`);

    socket.to(validSessionId).emit("user-joined", {
      userId: socket.userId,
      userName: socket.userName,
      role: socket.userRole,
      timestamp: new Date(),
    });

    const sessionUsers = activeSessions.get(validSessionId) || [];
    const userCount = sessionUsers.length;
    const isInitiator = userCount === 1;

    callback({ success: true, message: "Joined session", userCount, isInitiator });
  });

  // ✅ WebRTC: Offer
  socket.on("webrtc-offer", (data, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });

    try {
      if (!data || !data.type || data.type !== "offer") {
        return callback({ success: false, error: "Invalid offer format" });
      }
      socket.to(sessionId).emit("webrtc-offer", {
        offer: data,
        from: socket.userId,
        fromName: socket.userName,
      });
      callback({ success: true });
    } catch (err) {
      console.error("Offer error:", err);
      callback({ success: false, error: "Failed to send offer" });
    }
  });

  // ✅ WebRTC: Answer
  socket.on("webrtc-answer", (data, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });

    try {
      if (!data || !data.type || data.type !== "answer") {
        return callback({ success: false, error: "Invalid answer format" });
      }
      socket.to(sessionId).emit("webrtc-answer", {
        answer: data,
        from: socket.userId,
        fromName: socket.userName,
      });
      callback({ success: true });
    } catch (err) {
      console.error("Answer error:", err);
      callback({ success: false, error: "Failed to send answer" });
    }
  });

  // ✅ WebRTC: ICE Candidate
  socket.on("webrtc-candidate", (data, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });

    try {
      if (!data || !data.candidate) {
        return callback({ success: false, error: "Invalid candidate" });
      }
      socket.to(sessionId).emit("webrtc-candidate", { candidate: data, from: socket.userId });
      callback?.({ success: true });
    } catch (err) {
      console.error("Candidate error:", err);
      callback?.({ success: false, error: "Failed to send candidate" });
    }
  });

  // ✅ Chat: Send message
  socket.on("chat-message", (message, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });

    try {
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
    } catch (err) {
      console.error("Chat error:", err);
      callback({ success: false, error: "Failed to send message" });
    }
  });

  // ✅ Code Editor: Send code update
  socket.on("code-update", (codeData, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return callback({ success: false, error: "Not in session" });

    try {
      const sanitizedCode = validateInput(codeData.code, 50000);
      const update = {
        code: sanitizedCode,
        language: validateInput(codeData.language, 50),
        userId: socket.userId,
        userName: socket.userName,
        timestamp: new Date().toISOString(),
      };

      socket.to(sessionId).emit("code-update", update);
      callback({ success: true });
    } catch (err) {
      console.error("Code update error:", err);
      callback({ success: false, error: "Failed to update code" });
    }
  });

  // ✅ Cursor sync
  socket.on("cursor-move", (cursorData, callback) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;
    try {
      socket.to(sessionId).emit("cursor-move", {
        userId: socket.userId,
        line: parseInt(cursorData.line) || 0,
        column: parseInt(cursorData.column) || 0,
      });
      callback?.({ success: true });
    } catch (err) {
      console.error("Cursor error:", err);
    }
  });

  // ✅ Leave session
  socket.on("leave-session", (callback) => {
    const sessionId = userSessions.get(socket.id);
    if (sessionId) {
      socket.leave(sessionId);

      const users = activeSessions.get(sessionId);
      if (users) {
        const idx = users.findIndex((u) => u.socketId === socket.id);
        if (idx > -1) users.splice(idx, 1);
        if (users.length === 0) activeSessions.delete(sessionId);
      }

      userSessions.delete(socket.id);

      socket.to(sessionId).emit("user-left", {
        userId: socket.userId,
        userName: socket.userName,
        timestamp: new Date(),
      });

      console.log(`📍 User ${socket.userId} left session ${sessionId}`);
    }
    callback?.({ success: true });
  });

  // ✅ Disconnect handler
  socket.on("disconnect", (reason) => {
    const sessionId = userSessions.get(socket.id);
    if (sessionId) {
      const users = activeSessions.get(sessionId);
      if (users) {
        const idx = users.findIndex((u) => u.socketId === socket.id);
        if (idx > -1) users.splice(idx, 1);
        if (users.length === 0) activeSessions.delete(sessionId);
      }
      io.to(sessionId).emit("user-disconnected", {
        userId: socket.userId,
        userName: socket.userName,
        reason: reason,
      });
    }
    userSessions.delete(socket.id);
    console.log(`❌ User disconnected: ${socket.userId} (reason: ${reason})`);
  });

  // ✅ Error handler
  socket.on("error", (error) => {
    console.error(`Socket error for user ${socket.userId}:`, error);
  });
});

// ============ REST ENDPOINTS ============
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

app.get("/api/sessions", (req, res) => {
  const sessions = Array.from(activeSessions.entries()).map(([id, users]) => ({
    sessionId: id,
    userCount: users.length,
    users: users.map((u) => ({
      userId: u.userId,
      userName: u.userName,
      role: u.role,
      joinedAt: u.joinedAt,
    })),
  }));
  res.json(sessions);
});

app.post("/api/sessions", (req, res) => {
  try {
    const sessionId = uuidv4();
    activeSessions.set(sessionId, []);
    console.log(`✅ New session created: ${sessionId}`);
    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to create session" });
  }
});

app.post("/api/auth/token", (req, res) => {
  try {
    const { id, name, role } = req.body;
    if (!id || !name || !role) {
      return res.status(400).json({ error: "Missing id, name, or role" });
    }
    const token = jwt.sign(
      { id, name, role },
      process.env.JWT_SECRET || "your-secret-key-change-this",
      { expiresIn: "24h" }
    );
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to generate token" });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

// const { exec } = require("child_process");
// app.use(express.json());
// app.post("/run", (req, res) => {
//   const { code, language } = req.body;
//   if (language === "javascript") {
//     exec(`node -e "${code.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
//       if (err) return res.json({ output: stderr });
//       res.json({ output: stdout });
//     });
//   }
//   else if (language === "python") {
//     exec(`python -c "${code.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
//       if (err) return res.json({ output: stderr });
//       res.json({ output: stdout });
//     });
//   }
//   else {
//     res.json({ output: "Language not supported yet" });
//   }
// });

// app.listen(3001, () => console.log("Server running"));
