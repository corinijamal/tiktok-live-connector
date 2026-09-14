const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");
const { GameEngine } = require("./server/gameEngine");

const PORT = process.env.PORT || 3000;
const JOIN_KEYWORD = "اا";

const app = express();
app.use(express.static("public"));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

const engine = new GameEngine(io);

let tiktokConnection = null;
let connectedUsername = null;

// tiktok-live-connector v2.x: user fields live under data.user, per the
// underlying protobuf schema (userId, nickname, profilePicture.urls[],
// uniqueId). Earlier docs/snippets show a flatter or differently-named
// shape, so every field here falls back through multiple possible
// locations rather than trusting a single path.
function extractUser(data) {
  const user = data.user || {};
  // uniqueId (the permanent @handle) is the most reliable identity field
  // across versions; userId can be missing or inconsistent, and using
  // undefined as a Map key collapses every player into a single entry.
  const identity =
    user.uniqueId || user.userId || data.uniqueId || data.userId || null;
  return {
    userId: identity,
    nickname: user.nickname || user.uniqueId || data.nickname || data.uniqueId || identity,
    profilePictureUrl:
      user.profilePictureUrl ||
      (user.profilePicture && user.profilePicture.urls && user.profilePicture.urls[0]) ||
      (user.profilePictureUrls && user.profilePictureUrls[0]) ||
      data.profilePictureUrl ||
      null,
  };
}

let loggedSampleChat = false;
let loggedSampleLike = false;

function connectToTikTok(username) {
  if (tiktokConnection) {
    try {
      tiktokConnection.disconnect();
    } catch (e) {
      /* ignore */
    }
  }

  // The published v2.4.4 constructor reads options.processInitialData
  // internally without guarding against a missing options object, so an
  // empty object must always be passed as the second argument (passing
  // nothing throws "Cannot read properties of undefined").
  tiktokConnection = new TikTokLiveConnection(username, {});
  connectedUsername = username;
  loggedSampleChat = false;
  loggedSampleLike = false;

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
    if (!loggedSampleChat) {
      loggedSampleChat = true;
      console.log("SAMPLE CHAT PAYLOAD:", JSON.stringify(data, null, 2));
    }
    const u = extractUser(data);
    engine.handleChatJoin(u.userId, u.nickname, u.profilePictureUrl, data.comment, JOIN_KEYWORD);
  });

  tiktokConnection.on(WebcastEvent.LIKE, (data) => {
    if (!loggedSampleLike) {
      loggedSampleLike = true;
      console.log("SAMPLE LIKE PAYLOAD:", JSON.stringify(data, null, 2));
    }
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
