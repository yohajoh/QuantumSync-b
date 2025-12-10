import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = createServer(app);

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Room management
const rooms = new Map();
const userSocketMap = new Map(); // userId -> socketId

io.on("connection", (socket) => {
  console.log(`✅ New connection: ${socket.id}`);

  // Join room
  socket.on("join-room", ({ roomId, userId, userName }) => {
    try {
      console.log(`👤 ${userName} (${userId}) joining room: ${roomId}`);

      // Create room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
        console.log(`🏠 Created room: ${roomId}`);
      }

      const room = rooms.get(roomId);

      // Check if room is full
      if (room.size >= 10) {
        socket.emit("room-error", { message: "Room is full" });
        return;
      }

      // Add user to room
      room.set(userId, {
        socketId: socket.id,
        userId,
        userName,
        joinedAt: Date.now(),
      });

      // Map userId to socketId
      userSocketMap.set(userId, socket.id);

      // Join socket room
      socket.join(roomId);

      // Get existing participants (excluding self)
      const participants = Array.from(room.entries())
        .filter(([id]) => id !== userId)
        .map(([id, user]) => ({
          userId: user.userId,
          userName: user.userName,
          socketId: user.socketId,
        }));

      console.log(`📊 Room ${roomId} has ${room.size} participants`);

      // Send room joined event to the new user
      socket.emit("room-joined", {
        roomId,
        participants,
        userId,
        userName,
      });

      // Notify other users in the room
      socket.to(roomId).emit("user-joined", {
        userId,
        userName,
        socketId: socket.id,
      });
    } catch (error) {
      console.error("❌ Join room error:", error);
      socket.emit("room-error", { message: error.message });
    }
  });

  // WebRTC signaling
  socket.on("offer", ({ offer, to, from }) => {
    console.log(`📨 Offer from ${from} to ${to}`);

    // Get target socket ID
    const targetSocketId = userSocketMap.get(to);

    if (targetSocketId) {
      console.log(`📤 Forwarding offer to ${to} (socket: ${targetSocketId})`);
      socket.to(targetSocketId).emit("offer", { offer, from });
    } else {
      console.warn(`⚠️ Target user ${to} not found`);
    }
  });

  socket.on("answer", ({ answer, to, from }) => {
    console.log(`📨 Answer from ${from} to ${to}`);

    const targetSocketId = userSocketMap.get(to);

    if (targetSocketId) {
      console.log(`📤 Forwarding answer to ${to} (socket: ${targetSocketId})`);
      socket.to(targetSocketId).emit("answer", { answer, from });
    } else {
      console.warn(`⚠️ Target user ${to} not found`);
    }
  });

  socket.on("ice-candidate", ({ candidate, to, from }) => {
    console.log(`🧊 ICE candidate from ${from} to ${to}`);

    const targetSocketId = userSocketMap.get(to);

    if (targetSocketId) {
      socket.to(targetSocketId).emit("ice-candidate", { candidate, from });
    } else {
      console.warn(`⚠️ Target user ${to} not found`);
    }
  });

  // Chat messages
  socket.on(
    "send-message",
    ({ roomId, userId, userName, message, timestamp }) => {
      console.log(`💬 ${userName}: ${message}`);
      const messageData = {
        userId,
        userName,
        message,
        timestamp,
      };
      io.to(roomId).emit("new-message", messageData);
    }
  );

  // Leave room
  socket.on("leave-room", ({ roomId, userId }) => {
    console.log(`👋 ${userId} leaving room ${roomId}`);

    const room = rooms.get(roomId);
    if (room) {
      room.delete(userId);
      if (room.size === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted (empty)`);
      }
    }

    userSocketMap.delete(userId);
    socket.leave(roomId);
    socket.to(roomId).emit("user-left", { userId });
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log(`🔌 User disconnected: ${socket.id}`);

    // Find and remove user from rooms
    for (const [roomId, room] of rooms.entries()) {
      for (const [userId, user] of room.entries()) {
        if (user.socketId === socket.id) {
          room.delete(userId);
          userSocketMap.delete(userId);

          if (room.size === 0) {
            rooms.delete(roomId);
            console.log(`🗑️ Room ${roomId} deleted (empty)`);
          }

          socket.to(roomId).emit("user-left", { userId });
          console.log(`🗑️ Removed ${user.userName} from room ${roomId}`);
          break;
        }
      }
    }
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    rooms: rooms.size,
    connections: io.engine.clientsCount,
  });
});

// Room info
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    roomId,
    participantCount: room.size,
    participants: Array.from(room.values()).map((p) => ({
      userId: p.userId,
      userName: p.userName,
    })),
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(
    `🌐 CORS origin: ${process.env.CORS_ORIGIN || "http://localhost:3000"}`
  );
});
