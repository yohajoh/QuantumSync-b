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
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Room management
class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.maxRoomSize = parseInt(process.env.MAX_ROOM_SIZE) || 10;
    this.userSocketMap = new Map(); // userId -> socketId mapping
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

  joinRoom(roomId, userId, socketId, userName) {
    const room = this.createRoom(roomId);

    if (room.participants.size >= this.maxRoomSize) {
      throw new Error("Room is full");
    }

    room.participants.set(userId, {
      socketId,
      userId,
      userName,
      joinedAt: Date.now(),
      videoEnabled: true,
      audioEnabled: true,
      lastSeen: Date.now(),
    });

    // Map userId to socketId for quick lookup
    this.userSocketMap.set(userId, socketId);

    logger.info(`User ${userId} joined room ${roomId}`);
    return room;
  }

  leaveRoom(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.participants.delete(userId);
      this.userSocketMap.delete(userId);

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
      participant.lastSeen = Date.now();
    }
  }

  getSocketId(userId) {
    return this.userSocketMap.get(userId);
  }

  // Clean up disconnected users
  cleanup() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    for (const [roomId, room] of this.rooms.entries()) {
      for (const [userId, participant] of room.participants.entries()) {
        if (now - participant.lastSeen > timeout) {
          this.leaveRoom(roomId, userId);
          logger.info(`Cleaned up inactive user ${userId} from room ${roomId}`);
        }
      }
    }
  }
}

const roomManager = new RoomManager();

// Run cleanup every minute
setInterval(() => {
  roomManager.cleanup();
}, 60 * 1000);

// Socket.IO event handlers
io.on("connection", (socket) => {
  logger.info(`New connection: ${socket.id}`);

  // Create or join room
  socket.on("join-room", ({ roomId, userId, userName }) => {
    try {
      const room = roomManager.joinRoom(roomId, userId, socket.id, userName);

      socket.join(roomId);

      // Notify the user who just joined about existing participants
      const participants = roomManager
        .getRoomParticipants(roomId)
        .filter((p) => p.userId !== userId)
        .map((p) => ({
          userId: p.userId,
          userName: p.userName,
          socketId: p.socketId,
          videoEnabled: p.videoEnabled,
          audioEnabled: p.audioEnabled,
          joinedAt: p.joinedAt,
        }));

      socket.emit("room-joined", {
        roomId,
        participants,
        userId,
        userName,
        socketId: socket.id,
      });

      // Notify others in the room
      socket.to(roomId).emit("user-joined", {
        userId,
        userName,
        socketId: socket.id,
        videoEnabled: true,
        audioEnabled: true,
        joinedAt: Date.now(),
      });

      logger.info(`User ${userName} (${userId}) joined room ${roomId}`);
    } catch (error) {
      socket.emit("room-error", { message: error.message });
      logger.error(`Join room error: ${error.message}`);
    }
  });

  // WebRTC signaling - UPDATED FOR BETTER RELIABILITY
  socket.on("offer", ({ offer, to, from }) => {
    logger.info(`Relaying offer from ${from} to ${to}`);
    const targetSocketId = roomManager.getSocketId(to);
    if (targetSocketId) {
      socket.to(targetSocketId).emit("offer", { offer, from });
    } else {
      logger.warn(`Target user ${to} not found or disconnected`);
    }
  });

  socket.on("answer", ({ answer, to, from }) => {
    logger.info(`Relaying answer from ${from} to ${to}`);
    const targetSocketId = roomManager.getSocketId(to);
    if (targetSocketId) {
      socket.to(targetSocketId).emit("answer", { answer, from });
    } else {
      logger.warn(`Target user ${to} not found or disconnected`);
    }
  });

  socket.on("ice-candidate", ({ candidate, to, from }) => {
    logger.info(`Relaying ICE candidate from ${from} to ${to}`);
    const targetSocketId = roomManager.getSocketId(to);
    if (targetSocketId) {
      socket.to(targetSocketId).emit("ice-candidate", { candidate, from });
    } else {
      logger.warn(`Target user ${to} not found or disconnected`);
    }
  });

  // Media control events
  socket.on("toggle-video", ({ roomId, userId, enabled }) => {
    roomManager.updateParticipantStatus(roomId, userId, {
      videoEnabled: enabled,
    });
    socket.to(roomId).emit("video-toggled", { userId, enabled });
    logger.info(`User ${userId} ${enabled ? "enabled" : "disabled"} video`);
  });

  socket.on("toggle-audio", ({ roomId, userId, enabled }) => {
    roomManager.updateParticipantStatus(roomId, userId, {
      audioEnabled: enabled,
    });
    socket.to(roomId).emit("audio-toggled", { userId, enabled });
    logger.info(`User ${userId} ${enabled ? "unmuted" : "muted"} audio`);
  });

  // Screen sharing
  socket.on("start-screen-share", ({ roomId, userId }) => {
    socket.to(roomId).emit("screen-share-started", { userId });
    logger.info(`User ${userId} started screen sharing`);
  });

  socket.on("stop-screen-share", ({ roomId, userId }) => {
    socket.to(roomId).emit("screen-share-stopped", { userId });
    logger.info(`User ${userId} stopped screen sharing`);
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
      logger.info(
        `Message from ${userName} in room ${roomId}: ${message.substring(
          0,
          50
        )}...`
      );
    }
  );

  // Raise hand feature
  socket.on("raise-hand", ({ roomId, userId, userName }) => {
    socket.to(roomId).emit("hand-raised", { userId, userName });
    logger.info(`User ${userName} raised hand in room ${roomId}`);
  });

  // Disconnection handling
  const handleUserDisconnect = (socketId) => {
    // Find user in rooms and remove them
    for (const [roomId, room] of roomManager.rooms.entries()) {
      for (const [userId, participant] of room.participants.entries()) {
        if (participant.socketId === socketId) {
          roomManager.leaveRoom(roomId, userId);
          socket.to(roomId).emit("user-left", {
            userId,
            userName: participant.userName,
          });
          logger.info(
            `User ${participant.userName} (${userId}) disconnected from room ${roomId}`
          );
          break;
        }
      }
    }
  };

  socket.on("disconnect", (reason) => {
    logger.info(`User disconnected: ${socket.id}, reason: ${reason}`);
    handleUserDisconnect(socket.id);
  });

  socket.on("leave-room", ({ roomId, userId }) => {
    roomManager.leaveRoom(roomId, userId);
    socket.leave(roomId);
    socket.to(roomId).emit("user-left", { userId });
    logger.info(`User ${userId} left room ${roomId}`);
  });

  // Ping/pong for connection health
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });

  // Update last seen
  socket.on("heartbeat", ({ userId }) => {
    // Update last seen for user across all rooms
    for (const [roomId, room] of roomManager.rooms.entries()) {
      if (room.participants.has(userId)) {
        roomManager.updateParticipantStatus(roomId, userId, {});
      }
    }
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  const roomCount = roomManager.rooms.size;
  let totalParticipants = 0;

  for (const room of roomManager.rooms.values()) {
    totalParticipants += room.participants.size;
  }

  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    rooms: roomCount,
    participants: totalParticipants,
    memory: process.memoryUsage(),
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
      joinedAt: p.joinedAt,
      videoEnabled: p.videoEnabled,
      audioEnabled: p.audioEnabled,
    })),
  });
});

// Get all rooms (for monitoring)
app.get("/api/rooms", (req, res) => {
  const rooms = [];

  for (const [roomId, room] of roomManager.rooms.entries()) {
    rooms.push({
      roomId,
      createdAt: room.createdAt,
      participantCount: room.participants.size,
      participants: Array.from(room.participants.values()).map((p) => ({
        userId: p.userId,
        userName: p.userName,
        joinedAt: p.joinedAt,
      })),
    });
  }

  res.json({
    totalRooms: rooms.length,
    rooms,
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Socket.IO server initialized`);
  logger.info(
    `CORS origin: ${process.env.CORS_ORIGIN || "http://localhost:3000"}`
  );
  logger.info(`Max room size: ${process.env.MAX_ROOM_SIZE || 10}`);
});

export { io, roomManager };
