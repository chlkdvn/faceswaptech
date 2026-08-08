import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./db/db.js";
import dns from "node:dns";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { createDecartClient, models } from "@decartai/sdk";
import { createServer } from "http";               // NEW
import { Server } from "socket.io";                 // NEW
import { v4 as uuidv4 } from "uuid";                // NEW

import User from "./models/user.js";
import protect from "./middleware/authMiddleware.js";
import authRoutes from "./routes/authRoutes.js";

dns.setServers(["8.8.8.8", "1.1.1.1"]);
dotenv.config();
connectDB();

const app = express();

// ---------- HTTP & Socket.IO setup ----------
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:8080",
    methods: ["GET", "POST"]
  }
});

// ---------- Paystack Configuration ----------
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "sk_test_7d79cef5b6dcf1c74ffdf06fe88ee3241d1bdd8c";
const paystackHeaders = {
  Authorization: `Bearer ${PAYSTACK_SECRET}`,
  'Content-Type': 'application/json',
};
const toKobo = (amount) => Math.round(parseFloat(amount) * 100);

// ---------- Middleware Pipeline ----------
app.use(cors({ origin: "http://localhost:8080", credentials: true }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cookieParser());

// ---------- Routes ----------
app.get("/", (req, res) => res.send("API running with MongoDB 🚀"));

app.use("/api/auth", authRoutes);
app.use("/api/lucy", authRoutes);

app.post("/session", async (req, res) => {
  try {
    if (!process.env.DECART_API_KEY) {
      return res.status(500).json({ success: false, message: "DECART_API_KEY is missing" });
    }
    const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });
    const model = models.realtime("lucy-2.1");
    return res.json({
      success: true,
      model: model.id,
      message: "Lucy 2.1 initialized successfully",
    });
  } catch (error) {
    console.error("Lucy session error:", error);
    return res.status(500).json({ success: false, message: "Failed to initialize Lucy session", error: error.message });
  }
});

// --- PAYSTACK ENDPOINTS (unchanged) ---
app.post("/api/paystack/initialize", protect, async (req, res) => {
  try {
    const { amountPaid, creditsAdded } = req.body;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "User context missing" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const amountInKobo = toKobo(amountPaid);
    const body = {
      email: user.email,
      amount: amountInKobo,
      callback_url: "http://localhost:3000/Success.html",
      metadata: {
        userId: user._id.toString(),
        creditsToAdd: Number(creditsAdded),
        amountPaidOriginal: Number(amountPaid)
      }
    };

    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: paystackHeaders,
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.status) return res.status(400).json({ success: false, message: data.message });

    return res.json({
      success: true,
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(req.rawBody).digest("hex");
    if (hash !== req.headers["x-paystack-signature"]) return res.status(401).json({ message: "Invalid signature" });

    const event = req.body;
    if (event.event === "charge.success") {
      const paymentData = event.data;
      const metadata = paymentData.metadata;
      if (metadata && metadata.userId) {
        await User.findByIdAndUpdate(metadata.userId, {
          $inc: { credits: metadata.creditsToAdd },
          $push: {
            topupHistory: {
              amountPaid: metadata.amountPaidOriginal,
              creditsAdded: metadata.creditsToAdd,
              paymentProvider: "paystack",
              providerReference: paymentData.reference,
              status: "completed",
            },
          },
        });
        console.log(`Credited ${metadata.creditsToAdd} credits to user ${metadata.userId}`);
      }
    }
    return res.send("Event processed");
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ========== NEW: Video Call Room Management ==========
const rooms = new Map();   // roomId → Set<socket.id>

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("create-room", () => {
    const roomId = uuidv4();
    rooms.set(roomId, new Set([socket.id]));
    socket.join(roomId);
    socket.emit("room-created", roomId);
  });

  socket.on("join-room", (roomId) => {
    if (!rooms.has(roomId)) {
      socket.emit("error", "Room does not exist");
      return;
    }
    const room = rooms.get(roomId);
    room.add(socket.id);
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);
    socket.emit("room-joined", roomId);
  });

  socket.on("offer", ({ target, sdp }) => {
    io.to(target).emit("offer", { sender: socket.id, sdp });
  });

  socket.on("answer", ({ target, sdp }) => {
    io.to(target).emit("answer", { sender: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ target, candidate }) => {
    io.to(target).emit("ice-candidate", { sender: socket.id, candidate });
  });

  socket.on("disconnect", () => {
    for (const [roomId, participants] of rooms.entries()) {
      if (participants.has(socket.id)) {
        participants.delete(socket.id);
        if (participants.size === 0) {
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit("user-left", socket.id);
        }
        break;
      }
    }
  });
});

// ---------- Start server ----------
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
