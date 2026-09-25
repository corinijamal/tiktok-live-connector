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

// tiktok-live-connector v2.4.4's *actual* runtime payloads do not reliably
// match its published documentation. Sample logs captured from this app
// showed the LIKE event's real sender buried several levels deep (inside
// data.common.specifiedDisplayText[].pieces[].userValue.user) instead of on
// a flat data.user like the docs describe. Rather than hard-code one path
// that may break again on the next library update, we recursively search
// the whole payload for the first object that looks like a TikTok user
// (has a nickname/uniqueId/displayId alongside an id/userId) and use that.
function findUserDeep(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;

  // A plausible "user" object: has some form of id AND some form of name.
  const hasId = obj.id || obj.userId || obj.uniqueId || obj.displayId;
  const hasName = obj.nickname || obj.uniqueId || obj.displayId;
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

// Picks the first URL out of an avatar-image sub-object, trying every
// array-key name this connector's various shapes have been seen to use.
function firstUrl(img) {
  if (!img) return null;
  const list = img.urlList || img.urls || img.url;
  return (Array.isArray(list) && list[0]) || null;
}

function httpsOnly(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  return url.replace(/^http:\/\//i, "https://");
}

// Given one candidate "user-like" object, tries the full known set of
// field-name variants for identity and avatar, rather than gating on one
// or two specific names. A narrow gate (e.g. "must have nickname or
// uniqueId") risks distrusting a perfectly valid object that happens to
// only carry id/displayId, and falling through to the much riskier deep
// search instead — which is the bug that was actually causing inconsistent
// tap attribution. Returns null only when no identity field at all exists.
function fieldsOf(u) {
  if (!u || typeof u !== "object") return null;
  const identity = u.uniqueId || u.displayId || u.userId || u.id || null;
  if (!identity) return null;
  return {
    userId: String(identity),
    nickname: u.nickname || u.uniqueId || u.displayId || String(identity),
    profilePictureUrl:
      httpsOnly(u.profilePictureUrl) ||
      httpsOnly(firstUrl(u.profilePicture)) ||
      httpsOnly(firstUrl(u.avatarThumb)) ||
      httpsOnly(firstUrl(u.avatarMedium)) ||
      httpsOnly(firstUrl(u.profilePictureMedium)) ||
      (Array.isArray(u.profilePictureUrls) && httpsOnly(u.profilePictureUrls[0])) ||
      null,
  };
}

function extractUser(data) {
  // Try progressively less certain shapes, in order of trust: the
  // documented nested shape (data.user), then the documented flat shape
  // (fields directly on data), and only then a recursive deep search as a
  // last resort — since a wrong deep match silently gives different taps
  // from the same real viewer different extracted identities.
  const fromNested = fieldsOf(data.user);
  const fromFlat = !fromNested ? fieldsOf(data) : null;
  const deepUser = !fromNested && !fromFlat ? findUserDeep(data) : null;
  const fromDeep = deepUser ? fieldsOf(deepUser) : null;

  const result = fromNested || fromFlat || fromDeep || { userId: null, nickname: null, profilePictureUrl: null };

  // Whichever tier found the identity, its own object may still carry an
  // empty/deprecated picture field (observed directly in this app's own
  // logs) even when a real avatar URL exists elsewhere in the payload —
  // so the whole-payload avatar scan is always tried as a last resort.
  if (!result.profilePictureUrl) {
    result.profilePictureUrl = findAvatarUrlDeep(data);
  }

  return result;
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

// Targeted fallback for the like-count field: searches the whole payload
// for a property literally named "likeCount" (an exact key match, unlike
// the fuzzy user/avatar searches above, since we want the real per-tap
// count and not a lookalike field such as totalLikeCount or effectCnt).
function findKeyDeep(obj, keyName, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, keyName) && obj[keyName] !== undefined && obj[keyName] !== null) {
    return obj[keyName];
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") {
      const found = findKeyDeep(val, keyName, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// Diagnostic-only: collects every field anywhere in the payload whose KEY
// name suggests a count/total (case-insensitive "count"/"total"/"num"),
// so if the real per-event tap batch size lives under some other field
// name than "likeCount", the next test's logs will surface it directly
// instead of requiring another guess-and-check round.
const COUNT_LIKE_KEY_RE = /count|total|num/i;
function collectCountLikeFields(obj, path, depth, out) {
  if (!obj || typeof obj !== "object" || depth > 4 || out.length > 20) return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const fullPath = path ? path + "." + key : key;
    if ((typeof val === "number" || typeof val === "string") && COUNT_LIKE_KEY_RE.test(key)) {
      out.push(fullPath + "=" + JSON.stringify(val));
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      collectCountLikeFields(val, fullPath, depth + 1, out);
    }
  }
}

// ---------- Multi-session support ----------
// Each browser generates and keeps its own persistent session id (stored
// client-side in localStorage), so several hosts — or the same host on
// several devices — can each run a fully independent game (own arena, own
// TikTok connection, own settings) from this one deployed server at the
// same time, without any of it colliding.
const sessions = new Map(); // sessionId -> session state
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // cleaned up 6h after the last socket disconnects
const SESSION_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

function getOrCreateSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    // A thin emit-only wrapper scoped to this session's Socket.io room, so
    // GameEngine (unaware sessions even exist) only ever broadcasts to the
    // clients that belong to this one game.
    const roomIo = { emit: (event, data) => io.to(sessionId).emit(event, data) };
    session = {
      id: sessionId,
      engine: new GameEngine(roomIo),
      tiktokConnection: null,
      connectedUsername: null,
      sampleChatLogsLeft: 5,
      sampleLikeLogsLeft: 5,
      connectedSockets: 0,
      lastActivityAt: Date.now(),
    };
    sessions.set(sessionId, session);
    console.log(`Session ${sessionId.slice(0, 8)} created (${sessions.size} total)`);
  }
  return session;
}

// A session stays alive indefinitely as long as at least one browser tab
// is connected to it; the inactivity clock only starts once every socket
// for that session has disconnected (e.g. the overlay + admin tab both
// closed), so a long stream with the overlay left open never expires.
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.connectedSockets === 0 && now - session.lastActivityAt > SESSION_TTL_MS) {
      try {
        session.tiktokConnection && session.tiktokConnection.disconnect();
      } catch (e) {
        /* ignore */
      }
      session.engine.stop();
      sessions.delete(sessionId);
      console.log(`Session ${sessionId.slice(0, 8)} cleaned up after inactivity (${sessions.size} remaining)`);
    }
  }
}, SESSION_SWEEP_INTERVAL_MS);

function requireSessionId(req, res) {
  const sessionId = req.body && req.body.sessionId;
  if (!sessionId || typeof sessionId !== "string" || sessionId.length > 100) {
    res.status(400).json({ error: "sessionId required" });
    return null;
  }
  return sessionId;
}

function connectToTikTok(session, username) {
  const tag = `[${session.id.slice(0, 8)}]`;

  if (session.tiktokConnection) {
    try {
      session.tiktokConnection.disconnect();
    } catch (e) {
      /* ignore */
    }
  }

  // Switching to a different TikTok account must not carry over the
  // previous stream's bubbles into the new one.
  session.engine.resetPlayers();

  // The published v2.4.4 constructor reads options.processInitialData
  // internally without guarding against a missing options object, so an
  // empty object must always be passed as the second argument (passing
  // nothing throws "Cannot read properties of undefined").
  const tiktokConnection = new TikTokLiveConnection(username, {});
  session.tiktokConnection = tiktokConnection;
  session.connectedUsername = username;
  session.sampleChatLogsLeft = 5;
  session.sampleLikeLogsLeft = 5;

  tiktokConnection
    .connect()
    .then((state) => {
      console.log(`${tag} Connected to TikTok live room of @${username}, roomId=${state.roomId}`);
      io.to(session.id).emit("tiktok:connected", { username, roomId: state.roomId });
    })
    .catch((err) => {
      console.error(`${tag} Failed to connect to TikTok live:`, err.message);
      io.to(session.id).emit("tiktok:error", { message: err.message });
    });

  tiktokConnection.on(WebcastEvent.CHAT, (data) => {
    const u = extractUser(data);
    if (session.sampleChatLogsLeft > 0) {
      session.sampleChatLogsLeft--;
      console.log(`${tag} CHAT EXTRACTED:`, JSON.stringify(u));
    }
    session.engine.handleComment(u.userId, u.nickname, u.profilePictureUrl, data.comment);
  });

  tiktokConnection.on(WebcastEvent.LIKE, (data) => {
    const u = extractUser(data);
    // Confirmed from live logs: this library's actual LIKE payload uses
    // "count" (not the documented "likeCount") for the per-event tap
    // batch size, and "total" (not "totalLikeCount") for the room-wide
    // running total. "likeCount" is tried first for forward-compat in
    // case a future library version matches the docs; "count" is the
    // field that has actually been observed to hold the real value.
    const rawTapCount =
      data.likeCount ?? data.count ?? findKeyDeep(data, "likeCount") ?? findKeyDeep(data, "count") ?? 1;
    const tapCount = Number(rawTapCount) || 1;
    if (session.sampleLikeLogsLeft > 0) {
      session.sampleLikeLogsLeft--;
      const countFields = [];
      collectCountLikeFields(data, "", 0, countFields);
      console.log(`${tag} LIKE EXTRACTED:`, JSON.stringify(u), "| tapCount:", tapCount, "| count-like fields:", countFields.join(", ") || "(none found)");
    }
    session.engine.handleLike(u.userId, u.nickname, u.profilePictureUrl, tapCount);
  });

  tiktokConnection.on(WebcastEvent.GIFT, (data) => {
    const u = extractUser(data);
    const giftDetails = data.giftDetails || {};
    // Streakable gifts (giftType === 1) fire repeatedly while the streak is
    // building; only apply the boost once the streak settles (repeatEnd).
    const isCombo = giftDetails.giftType === 1;
    if (isCombo && !data.repeatEnd) return;

    const coinValue = (giftDetails.diamondCount || 1) * (data.repeatCount || 1);
    session.engine.handleGift(u.userId, u.nickname, u.profilePictureUrl, coinValue);
  });

  tiktokConnection.on("disconnected", () => {
    console.log(`${tag} Disconnected from TikTok live`);
    io.to(session.id).emit("tiktok:disconnected", {});
  });

  tiktokConnection.on("error", (err) => {
    console.error(`${tag} TikTok connection error:`, err && err.info ? err.info : err);
    io.to(session.id).emit("tiktok:error", { message: (err && err.info) || "unknown error" });
  });
}

// ---------- Admin / control routes ----------
// Every route requires sessionId in the JSON body so it operates on the
// right browser's independent game instance.

app.post("/api/connect", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  connectToTikTok(session, username.replace("@", "").trim());
  res.json({ ok: true });
});

app.post("/api/start", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  session.engine.start();
  res.json({ ok: true });
});

app.post("/api/stop", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  session.engine.stop();
  res.json({ ok: true });
});

app.post("/api/reset", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  session.engine.resetPlayers();
  res.json({ ok: true });
});

app.post("/api/config", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  const { roundDurationMinutes, totalRounds, maxSpeed, giftMode } = req.body || {};
  const config = {};
  if (roundDurationMinutes !== undefined) {
    const minutes = Number(roundDurationMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      config.roundDurationMs = Math.round(minutes * 60 * 1000);
    }
  }
  if (totalRounds !== undefined) {
    const rounds = Number(totalRounds);
    if (Number.isFinite(rounds) && rounds >= 0) {
      config.totalRounds = rounds;
    }
  }
  if (maxSpeed !== undefined) {
    const speed = Number(maxSpeed);
    if (Number.isFinite(speed)) config.maxSpeed = speed;
  }
  if (giftMode !== undefined && typeof giftMode === "object") {
    config.giftMode = giftMode;
  }
  const applied = session.engine.setConfig(config);
  res.json({ ok: true, ...applied });
});

// Manual/test event injection (useful for local testing without a live TikTok stream)
app.post("/api/simulate/join", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  const { userId, nickname, profilePictureUrl } = req.body;
  session.engine.ensurePlayer(userId, nickname, profilePictureUrl);
  res.json({ ok: true });
});

app.post("/api/simulate/comment", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  const { userId, nickname, profilePictureUrl, comment } = req.body;
  session.engine.handleComment(userId, nickname || userId, profilePictureUrl, comment || "test");
  res.json({ ok: true });
});

app.post("/api/simulate/like", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  const { userId, nickname, count } = req.body;
  session.engine.handleLike(userId, nickname || userId, null, count || 1);
  res.json({ ok: true });
});

app.post("/api/simulate/gift", (req, res) => {
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  const session = getOrCreateSession(sessionId);
  session.lastActivityAt = Date.now();
  const { userId, nickname, coinValue } = req.body;
  session.engine.handleGift(userId, nickname || userId, null, coinValue || 1);
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  const sessionId = socket.handshake.query && socket.handshake.query.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    console.log("Client connected without a sessionId — disconnecting:", socket.id);
    socket.disconnect(true);
    return;
  }
  socket.join(sessionId);
  const session = getOrCreateSession(sessionId);
  session.connectedSockets++;
  session.lastActivityAt = Date.now();
  console.log(`Client connected: ${socket.id} (session ${sessionId.slice(0, 8)})`);
  session.engine.broadcastState();
  socket.emit("tiktok:status", {
    connected: !!session.connectedUsername,
    username: session.connectedUsername,
  });

  socket.on("disconnect", () => {
    session.connectedSockets = Math.max(0, session.connectedSockets - 1);
    session.lastActivityAt = Date.now();
  });
});

server.listen(PORT, () => {
  console.log(`Battle Arena server running on port ${PORT}`);
});
