const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");
const { GameEngine } = require("./server/gameEngine");

const PORT = process.env.PORT || 3000;
const JOIN_KEYWORD = "انضم";

const app = express();
app.use(express.static("public"));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

const engine = new GameEngine(io);

let tiktokConnection = null;
let connectedUsername = null;

// tiktok-live-connector v2.x: user fields live under data.user (uniqueId,
// nickname, profilePictureUrl), not flat on data. See BREAKING.md upstream.
function extractUser(data) {
  const user = data.user || {};
  return {
    userId: user.userId || data.userId,
    nickname: user.nickname || user.uniqueId || data.nickname || data.uniqueId,
    // v2.x nests avatar as user.profilePicture.urls[]; older/flat shapes may
    // expose user.profilePictureUrl or user.profilePictureUrls[] directly,
    // so check all three.
    profilePictureUrl:
      user.profilePictureUrl ||
      (user.profilePicture && user.profilePicture.urls && user.profilePicture.urls[0]) ||
      (user.profilePictureUrls && user.profilePictureUrls[0]) ||
      null,
  };
}

function connectToTikTok(username) {
  if (tiktokConnection) {
    try {
      tiktokConnection.disconnect();
    } catch (e) {
      /* ignore */
    }
  }

  tiktokConnection = new TikTokLiveConnection(username);
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

  tiktokConnection.on(WebcastEvent.CHAT, (data) => {
    const u = extractUser(data);
    engine.handleChatJoin(u.userId, u.nickname, u.profilePictureUrl, data.comment, JOIN_KEYWORD);
  });

  tiktokConnection.on(WebcastEvent.LIKE, (data) => {
    const u = extractUser(data);
    engine.handleLike(u.userId, u.nickname, u.profilePictureUrl, data.likeCount || 1);
  });

  tiktokConnection.on(WebcastEvent.GIFT, (data) => {
    const u = extractUser(data);
    const giftDetails = data.giftDetails || {};
    // Streakable gifts (giftType === 1) fire repeatedly while the streak is
    // building; only apply the boost once the streak settles (repeatEnd).
    const isCombo = giftDetails.giftType === 1;
    if (isCombo && !data.repeatEnd) return;

    const coinValue = (giftDetails.diamondCount || 1) * (data.repeatCount || 1);
    engine.handleGift(u.userId, u.nickname, u.profilePictureUrl, coinValue);
  });

  tiktokConnection.on("disconnected", () => {
    console.log("Disconnected from TikTok live");
    io.emit("tiktok:disconnected", {});
  });

  tiktokConnection.on("error", (err) => {
    console.error("TikTok connection error:", err && err.info ? err.info : err);
    io.emit("tiktok:error", { message: (err && err.info) || "unknown error" });
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
