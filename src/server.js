import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { createServer } from "http";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import logger from "./utils/logger.js";

dotenv.config();

const app = express();
const server = createServer(app);

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// Room management
class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.maxRoomSize = parseInt(process.env.MAX_ROOM_SIZE) || 10;
  }

  createRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        participants: new Map(),
        createdAt: Date.now(),
        active: true,
      });
      logger.info(`Room created: ${roomId}`);
    }
    return this.rooms.get(roomId);
  }

  joinRoom(roomId, userId, socketId) {
    const room = this.createRoom(roomId);

    if (room.participants.size >= this.maxRoomSize) {
      throw new Error("Room is full");
    }

    room.participants.set(userId, {
      socketId,
      userId,
      joinedAt: Date.now(),
      videoEnabled: true,
      audioEnabled: true,
    });

    logger.info(`User ${userId} joined room ${roomId}`);
    return room;
  }

  leaveRoom(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.participants.delete(userId);

      if (room.participants.size === 0) {
        this.rooms.delete(roomId);
        logger.info(`Room ${roomId} deleted (empty)`);
      }

      logger.info(`User ${userId} left room ${roomId}`);
    }
  }

  getRoomParticipants(roomId) {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.participants.values()) : [];
  }

  getParticipant(roomId, userId) {
    const room = this.rooms.get(roomId);
    return room ? room.participants.get(userId) : null;
  }

  updateParticipantStatus(roomId, userId, updates) {
    const participant = this.getParticipant(roomId, userId);
    if (participant) {
      Object.assign(participant, updates);
    }
  }
}

const roomManager = new RoomManager();

// Socket.IO event handlers
io.on("connection", (socket) => {
  logger.info(`New connection: ${socket.id}`);

  // Create or join room
  socket.on("join-room", ({ roomId, userId, userName }) => {
    try {
      const room = roomManager.joinRoom(roomId, userId, socket.id);

      socket.join(roomId);

      // Notify the user who just joined about existing participants
      const participants = roomManager
        .getRoomParticipants(roomId)
        .filter((p) => p.userId !== userId)
        .map((p) => ({
          userId: p.userId,
          userName: p.userName,
          videoEnabled: p.videoEnabled,
          audioEnabled: p.audioEnabled,
        }));

      socket.emit("room-joined", {
        roomId,
        participants,
        userId,
      });

      // Notify others in the room
      socket.to(roomId).emit("user-joined", {
        userId,
        userName,
        socketId: socket.id,
        videoEnabled: true,
        audioEnabled: true,
      });

      logger.info(`User ${userName} (${userId}) joined room ${roomId}`);
    } catch (error) {
      socket.emit("room-error", { message: error.message });
      logger.error(`Join room error: ${error.message}`);
    }
  });

  // WebRTC signaling
  socket.on("offer", ({ offer, to, from }) => {
    socket.to(to).emit("offer", { offer, from });
  });

  socket.on("answer", ({ answer, to, from }) => {
    socket.to(to).emit("answer", { answer, from });
  });

  socket.on("ice-candidate", ({ candidate, to, from }) => {
    socket.to(to).emit("ice-candidate", { candidate, from });
  });

  // Media control events
  socket.on("toggle-video", ({ roomId, userId, enabled }) => {
    roomManager.updateParticipantStatus(roomId, userId, {
      videoEnabled: enabled,
    });
    socket.to(roomId).emit("video-toggled", { userId, enabled });
  });

  socket.on("toggle-audio", ({ roomId, userId, enabled }) => {
    roomManager.updateParticipantStatus(roomId, userId, {
      audioEnabled: enabled,
    });
    socket.to(roomId).emit("audio-toggled", { userId, enabled });
  });

  // Screen sharing
  socket.on("start-screen-share", ({ roomId, userId }) => {
    socket.to(roomId).emit("screen-share-started", { userId });
  });

  socket.on("stop-screen-share", ({ roomId, userId }) => {
    socket.to(roomId).emit("screen-share-stopped", { userId });
  });

  // Chat messages
  socket.on(
    "send-message",
    ({ roomId, userId, userName, message, timestamp }) => {
      const messageData = {
        userId,
        userName,
        message,
        timestamp,
        type: "text",
      };

      io.to(roomId).emit("new-message", messageData);
    }
  );

  // Raise hand feature
  socket.on("raise-hand", ({ roomId, userId, userName }) => {
    socket.to(roomId).emit("hand-raised", { userId, userName });
  });

  // Disconnection
  socket.on("disconnect", () => {
    // Find and remove user from rooms
    // This would need additional tracking structure for O(1) lookup
    logger.info(`User disconnected: ${socket.id}`);
  });

  socket.on("leave-room", ({ roomId, userId }) => {
    roomManager.leaveRoom(roomId, userId);
    socket.leave(roomId);
    socket.to(roomId).emit("user-left", { userId });
    logger.info(`User ${userId} left room ${roomId}`);
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Room info endpoint
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const participants = roomManager.getRoomParticipants(roomId);

  res.json({
    roomId,
    participantCount: participants.length,
    participants: participants.map((p) => ({
      userId: p.userId,
      userName: p.userName,
    })),
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Socket.IO server initialized`);
});
