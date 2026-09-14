const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { WebcastPushConnection } = require("tiktok-live-connector");
const { GameEngine } = require("./server/gameEngine");

const PORT = process.env.PORT || 3000;
const JOIN_KEYWORD = "السلام عليكم";

const app = express();
app.use(express.static("public"));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

const engine = new GameEngine(io);

let tiktokConnection = null;
let connectedUsername = null;

function connectToTikTok(username) {
  if (tiktokConnection) {
    try {
      tiktokConnection.disconnect();
    } catch (e) {
      /* ignore */
    }
  }

  tiktokConnection = new WebcastPushConnection(username);
  connectedUsername = username;

  tiktokConnection
    .connect()
    .then((state) => {
      console.log(`Connected to TikTok live room of @${username}, roomId=${state.roomId}`);
      io.emit("tiktok:connected", { username, roomId: state.roomId });
    })
    .catch((err) => {
      console.error("Failed to connect to TikTok live:", err.message);
      io.emit("tiktok:error", { message: err.message });
    });

  tiktokConnection.on("chat", (data) => {
    engine.handleChatJoin(
      data.userId,
      data.nickname || data.uniqueId,
      data.profilePictureUrl,
      data.comment,
      JOIN_KEYWORD
    );
  });

  tiktokConnection.on("like", (data) => {
    engine.handleLike(
      data.userId,
      data.nickname || data.uniqueId,
      data.profilePictureUrl,
      data.likeCount || 1
    );
  });

  tiktokConnection.on("gift", (data) => {
    // Only count a gift once it's "settled" (for combo-able gifts) or immediately
    // if it's not a repeatable/combo gift.
    const isCombo = data.giftType === 1;
    if (isCombo && !data.repeatEnd) return;

    const coinValue = (data.diamondCount || 1) * (data.repeatCount || 1);
    engine.handleGift(
      data.userId,
      data.nickname || data.uniqueId,
      data.profilePictureUrl,
      coinValue
    );
  });

  tiktokConnection.on("disconnect", () => {
    console.log("Disconnected from TikTok live");
    io.emit("tiktok:disconnected", {});
  });
}

// ---------- Admin / control routes ----------

app.post("/api/connect", (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  connectToTikTok(username.replace("@", "").trim());
  res.json({ ok: true });
});

app.post("/api/start", (req, res) => {
  engine.start();
  res.json({ ok: true });
});

app.post("/api/stop", (req, res) => {
  engine.stop();
  res.json({ ok: true });
});

// Manual/test event injection (useful for local testing without a live TikTok stream)
app.post("/api/simulate/join", (req, res) => {
  const { userId, nickname, profilePictureUrl } = req.body;
  engine.ensurePlayer(userId, nickname, profilePictureUrl);
  res.json({ ok: true });
});

app.post("/api/simulate/like", (req, res) => {
  const { userId, count } = req.body;
  engine.handleLike(userId, null, null, count || 1);
  res.json({ ok: true });
});

app.post("/api/simulate/gift", (req, res) => {
  const { userId, coinValue } = req.body;
  engine.handleGift(userId, null, null, coinValue || 1);
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  engine.broadcastState();
  socket.emit("tiktok:status", {
    connected: !!connectedUsername,
    username: connectedUsername,
  });
});

server.listen(PORT, () => {
  console.log(`Battle Arena server running on port ${PORT}`);
});
