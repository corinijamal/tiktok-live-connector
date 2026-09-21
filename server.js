const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");
const { GameEngine } = require("./server/gameEngine");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static("public"));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

const engine = new GameEngine(io);

let tiktokConnection = null;
let connectedUsername = null;

// tiktok-live-connector v2.4.4's *actual* runtime payloads do not reliably
// match its published documentation. Sample logs captured from this app
// showed the LIKE event's real sender buried several levels deep (inside
// data.common.specifiedDisplayText[].pieces[].userValue.user) instead of on
// a flat data.user like the docs describe. Rather than hard-code one path
// that may break again on the next library update, we recursively search
// the whole payload for the first object that looks like a TikTok user
// (has a nickname/uniqueId alongside an id/userId) and use that.
function findUserDeep(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;

  // A plausible "user" object: has some form of id AND some form of name.
  const hasId = obj.id || obj.userId || obj.uniqueId;
  const hasName = obj.nickname || obj.uniqueId;
  if (hasId && hasName) return obj;

  for (const key of Object.keys(obj)) {
    // Skip huge/irrelevant branches to keep this fast and avoid false
    // positives from unrelated nested "user"-shaped objects (e.g. badges).
    if (key === "userBadges" || key === "borderList" || key === "badgeList") continue;
    const val = obj[key];
    if (val && typeof val === "object") {
      const found = findUserDeep(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractUser(data) {
  // Try the documented flat/nested shapes first (cheap, and correct for
  // GIFT events in practice), then fall back to the deep search.
  const direct = data.user || null;
  const user = direct && (direct.nickname || direct.uniqueId) ? direct : findUserDeep(data) || {};

  const identity =
    user.uniqueId || user.userId || user.id || data.uniqueId || data.userId || null;

  return {
    userId: identity,
    nickname: user.nickname || user.uniqueId || data.nickname || data.uniqueId || identity,
    profilePictureUrl:
      user.profilePictureUrl ||
      (user.profilePicture && user.profilePicture.urls && user.profilePicture.urls[0]) ||
      (user.profilePictureUrls && user.profilePictureUrls[0]) ||
      data.profilePictureUrl ||
      findAvatarUrlDeep(data) ||
      null,
  };
}

// Last-resort avatar search: scans the whole payload for any string that
// looks like a TikTok CDN image URL, regardless of which key holds it.
// Sample payloads showed the matched user object's own picture fields
// (profilePicture, deprecated9/10/11, etc.) can arrive empty even when a
// real avatar exists elsewhere in the message, so this is broader than
// findUserDeep on purpose.
const AVATAR_URL_RE = /^https?:\/\/[^\s"]*tiktokcdn[^\s"]*\.(webp|jpe?g|png)(\?[^\s"]*)?$/i;

function findAvatarUrlDeep(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string" && AVATAR_URL_RE.test(val)) return val;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && AVATAR_URL_RE.test(item)) return item;
      }
    } else if (val && typeof val === "object") {
      const found = findAvatarUrlDeep(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
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

  // Switching to a different TikTok account must not carry over the
  // previous stream's bubbles into the new one.
  engine.resetPlayers();

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
    const u = extractUser(data);
    if (!loggedSampleChat) {
      loggedSampleChat = true;
      console.log("CHAT EXTRACTED:", JSON.stringify(u), "| top-level keys:", Object.keys(data));
    }
    engine.handleComment(u.userId, u.nickname, u.profilePictureUrl, data.comment);
  });

  tiktokConnection.on(WebcastEvent.LIKE, (data) => {
    const u = extractUser(data);
    if (!loggedSampleLike) {
      loggedSampleLike = true;
      console.log("LIKE EXTRACTED:", JSON.stringify(u), "| top-level keys:", Object.keys(data));
    }
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

app.post("/api/simulate/comment", (req, res) => {
  const { userId, nickname, profilePictureUrl, comment } = req.body;
  engine.handleComment(userId, nickname || userId, profilePictureUrl, comment || "test");
  res.json({ ok: true });
});

app.post("/api/simulate/like", (req, res) => {
  const { userId, nickname, count } = req.body;
  engine.handleLike(userId, nickname || userId, null, count || 1);
  res.json({ ok: true });
});

app.post("/api/simulate/gift", (req, res) => {
  const { userId, nickname, coinValue } = req.body;
  engine.handleGift(userId, nickname || userId, null, coinValue || 1);
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
