import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { createServer } from "http";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";

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
  transports: ["websocket", "polling"],
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
});

// Room management
const rooms = new Map(); // roomId -> Map(userId -> userData)
const socketToUser = new Map(); // socketId -> {userId, roomId, userName}
const userToSocket = new Map(); // userId -> socketId (for faster lookup)

io.on("connection", (socket) => {
  console.log(`✅ New connection: ${socket.id}`);

  // Join room
  socket.on("join-room", ({ roomId, userId, userName }) => {
    try {
      console.log(`👤 ${userName} (${userId}) joining room: ${roomId}`);

      // Validate input
      if (!roomId || !userId || !userName) {
        socket.emit("room-error", { message: "Missing required fields" });
        return;
      }

      // Create room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
        console.log(`🏠 Created new room: ${roomId}`);
      }

      const room = rooms.get(roomId);

      // Check if room is full
      if (room.size >= 10) {
        socket.emit("room-error", { message: "Room is full (max 10 users)" });
        return;
      }

      // Check if user already in room
      if (room.has(userId)) {
        socket.emit("room-error", { message: "User already in room" });
        return;
      }

      // Add user to room
      const userData = {
        socketId: socket.id,
        userId,
        userName,
        joinedAt: Date.now(),
      };
      room.set(userId, userData);

      // Update mappings
      socketToUser.set(socket.id, { userId, roomId, userName });
      userToSocket.set(userId, socket.id);

      // Join socket room
      socket.join(roomId);
      console.log(`📊 Room ${roomId} now has ${room.size} participants`);

      // Get existing participants (excluding self)
      const participants = Array.from(room.entries())
        .filter(([id]) => id !== userId)
        .map(([id, user]) => ({
          userId: user.userId,
          userName: user.userName,
          socketId: user.socketId,
        }));

      console.log(
        `Existing participants:`,
        participants.map((p) => p.userName)
      );

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

  // WebRTC signaling - IMPROVED
  socket.on("offer", ({ offer, to, from }) => {
    try {
      console.log(`📨 Offer from ${from} to ${to}`);

      // Validate
      if (!offer || !to || !from) {
        console.warn("Missing offer data");
        return;
      }

      // Get sender's room
      const senderData = socketToUser.get(socket.id);
      if (!senderData) {
        console.warn(`Sender ${from} not found in any room`);
        return;
      }

      const { roomId: senderRoomId } = senderData;

      // Get the room
      const room = rooms.get(senderRoomId);
      if (!room) {
        console.warn(`Room ${senderRoomId} not found`);
        return;
      }

      // Get target user from the SAME room
      const targetUser = room.get(to);
      if (!targetUser) {
        console.warn(`Target user ${to} not found in room ${senderRoomId}`);
        return;
      }

      console.log(
        `📤 Forwarding offer to ${to} (socket: ${targetUser.socketId})`
      );
      socket.to(targetUser.socketId).emit("offer", {
        offer,
        from,
        roomId: senderRoomId,
      });
    } catch (error) {
      console.error("Offer forwarding error:", error);
    }
  });

  socket.on("answer", ({ answer, to, from }) => {
    try {
      console.log(`📨 Answer from ${from} to ${to}`);

      // Validate
      if (!answer || !to || !from) {
        console.warn("Missing answer data");
        return;
      }

      // Get sender's room
      const senderData = socketToUser.get(socket.id);
      if (!senderData) {
        console.warn(`Sender ${from} not found in any room`);
        return;
      }

      const { roomId: senderRoomId } = senderData;

      // Get the room
      const room = rooms.get(senderRoomId);
      if (!room) {
        console.warn(`Room ${senderRoomId} not found`);
        return;
      }

      // Get target user from the SAME room
      const targetUser = room.get(to);
      if (!targetUser) {
        console.warn(`Target user ${to} not found in room ${senderRoomId}`);
        return;
      }

      console.log(
        `📤 Forwarding answer to ${to} (socket: ${targetUser.socketId})`
      );
      socket.to(targetUser.socketId).emit("answer", {
        answer,
        from,
        roomId: senderRoomId,
      });
    } catch (error) {
      console.error("Answer forwarding error:", error);
    }
  });

  socket.on("ice-candidate", ({ candidate, to, from }) => {
    try {
      console.log(`🧊 ICE candidate from ${from} to ${to}`);

      // Validate
      if (!candidate || !to || !from) {
        console.warn("Missing ICE candidate data");
        return;
      }

      // Get sender's room
      const senderData = socketToUser.get(socket.id);
      if (!senderData) {
        console.warn(`Sender ${from} not found in any room`);
        return;
      }

      const { roomId: senderRoomId } = senderData;

      // Get the room
      const room = rooms.get(senderRoomId);
      if (!room) {
        console.warn(`Room ${senderRoomId} not found`);
        return;
      }

      // Get target user from the SAME room
      const targetUser = room.get(to);
      if (!targetUser) {
        console.warn(`Target user ${to} not found in room ${senderRoomId}`);
        return;
      }

      socket.to(targetUser.socketId).emit("ice-candidate", {
        candidate,
        from,
        roomId: senderRoomId,
      });
    } catch (error) {
      console.error("ICE candidate forwarding error:", error);
    }
  });

  // Chat messages
  socket.on(
    "send-message",
    ({ roomId, userId, userName, message, timestamp }) => {
      try {
        console.log(`💬 ${userName}: ${message}`);

        // Validate user is in the room
        const room = rooms.get(roomId);
        if (!room || !room.has(userId)) {
          console.warn(`User ${userId} not in room ${roomId}`);
          return;
        }

        const messageData = {
          userId,
          userName,
          message,
          timestamp: timestamp || new Date().toISOString(),
        };

        io.to(roomId).emit("new-message", messageData);
      } catch (error) {
        console.error("Send message error:", error);
      }
    }
  );

  // Leave room
  socket.on("leave-room", ({ roomId, userId }) => {
    try {
      console.log(`👋 ${userId} leaving room ${roomId}`);

      const room = rooms.get(roomId);
      if (room) {
        room.delete(userId);
        if (room.size === 0) {
          rooms.delete(roomId);
          console.log(`🗑️ Room ${roomId} deleted (empty)`);
        } else {
          // Notify others
          socket.to(roomId).emit("user-left", { userId });
        }
      }

      socket.leave(roomId);

      // Cleanup mappings
      socketToUser.delete(socket.id);
      userToSocket.delete(userId);

      console.log(`User ${userId} left room ${roomId}`);
    } catch (error) {
      console.error("Leave room error:", error);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    try {
      console.log(`🔌 User disconnected: ${socket.id}`);

      const user = socketToUser.get(socket.id);
      if (user) {
        const { userId, roomId } = user;

        const room = rooms.get(roomId);
        if (room) {
          room.delete(userId);
          if (room.size === 0) {
            rooms.delete(roomId);
            console.log(`🗑️ Room ${roomId} deleted (empty)`);
          } else {
            // Notify others
            socket.to(roomId).emit("user-left", { userId });
          }
        }

        // Cleanup mappings
        socketToUser.delete(socket.id);
        userToSocket.delete(userId);

        console.log(`User ${userId} disconnected from room ${roomId}`);
      }
    } catch (error) {
      console.error("Disconnect error:", error);
    }
  });

  // Heartbeat/keepalive
  socket.on("heartbeat", ({ userId, roomId }) => {
    // Update last seen - can be used for connection monitoring
    console.log(`💓 Heartbeat from ${userId} in room ${roomId}`);
  });

  // Debug endpoint
  socket.on("get-room-info", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      socket.emit("room-info", {
        roomId,
        participantCount: room.size,
        participants: Array.from(room.values()).map((u) => ({
          userId: u.userId,
          userName: u.userName,
          socketId: u.socketId,
        })),
      });
    }
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    connections: io.engine.clientsCount,
    totalUsers: userToSocket.size,
  });
});

// Room info endpoint
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({
      error: "Room not found",
      roomId,
    });
  }

  res.json({
    roomId,
    participantCount: room.size,
    participants: Array.from(room.values()).map((p) => ({
      userId: p.userId,
      userName: p.userName,
      joinedAt: p.joinedAt,
    })),
  });
});

// List all rooms
app.get("/api/rooms", (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([roomId, room]) => ({
    roomId,
    participantCount: room.size,
    createdAt: Math.min(...Array.from(room.values()).map((u) => u.joinedAt)),
  }));

  res.json({
    totalRooms: rooms.size,
    rooms: roomList,
  });
});

// Debug endpoint to see all connections
app.get("/api/debug/connections", (req, res) => {
  res.json({
    socketToUser: Array.from(socketToUser.entries()),
    userToSocket: Array.from(userToSocket.entries()),
    rooms: Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      users: Array.from(room.entries()).map(([userId, user]) => ({
        userId,
        userName: user.userName,
        socketId: user.socketId,
      })),
    })),
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
});
