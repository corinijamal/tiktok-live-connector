/**
 * Battle Arena Game Engine
 * -------------------------
 * Individual player battle game:
 *  - Players join via keyword "انضم" or their first chat comment
 *  - Each like (+1) adds a point to the sender (green)
 *  - Collisions between player bubbles deal damage to the collided-into player (red)
 *    Base collision damage = 1
 *  - Gifts grant a temporary attack boost for 10s, equal to the gift's coin value.
 *    Boost stacks additively on top of base damage (1 + boost) for the duration.
 *  - Leveling: score grows bubble size up to a cap, then grants a badge/frame instead
 *  - Rounds last 3 minutes; highest score wins; next round auto-starts until stopped
 */

const ARENA_RADIUS = 500; // virtual arena units
const BUBBLE_MIN_RADIUS = 28;
const BUBBLE_MAX_RADIUS = 70; // size cap before badge kicks in
const SCORE_FOR_MAX_SIZE = 100; // points needed to reach max bubble size
const BASE_COLLISION_DAMAGE = 1;
const BOOST_DURATION_MS = 10 * 1000;
const ROUND_DURATION_MS = 3 * 60 * 1000;
const TICK_MS = 50; // physics/collision tick rate

// Badge thresholds beyond max size (score -> badge id)
const BADGES = [
  { threshold: SCORE_FOR_MAX_SIZE, id: "bronze", label: "🥉" },
  { threshold: 250, id: "silver", label: "🥈" },
  { threshold: 500, id: "gold", label: "🥇" },
  { threshold: 1000, id: "legend", label: "👑" },
];

function getBadge(score) {
  let current = null;
  for (const b of BADGES) {
    if (score >= b.threshold) current = b;
  }
  return current;
}

function getBubbleRadius(score) {
  const ratio = Math.min(score / SCORE_FOR_MAX_SIZE, 1);
  return BUBBLE_MIN_RADIUS + (BUBBLE_MAX_RADIUS - BUBBLE_MIN_RADIUS) * ratio;
}

class Player {
  constructor(userId, nickname, profilePictureUrl) {
    this.userId = userId;
    this.nickname = nickname;
    this.profilePictureUrl = profilePictureUrl;
    this.score = 0;
    this.roundScore = 0;
    this.boostAmount = 0;
    this.boostExpiresAt = 0;
    // random starting position inside arena circle
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * (ARENA_RADIUS * 0.6);
    this.x = Math.cos(angle) * dist;
    this.y = Math.sin(angle) * dist;
    this.vx = (Math.random() - 0.5) * 40;
    this.vy = (Math.random() - 0.5) * 40;
    this.joinedAt = Date.now();
  }

  get radius() {
    return getBubbleRadius(this.roundScore);
  }

  get badge() {
    return getBadge(this.roundScore);
  }

  get currentAttackDamage() {
    if (Date.now() < this.boostExpiresAt) {
      return BASE_COLLISION_DAMAGE + this.boostAmount;
    }
    return BASE_COLLISION_DAMAGE;
  }

  applyBoost(coinValue) {
    // Stacks: refresh duration, and add to existing boost if still active,
    // otherwise start fresh from the base.
    if (Date.now() < this.boostExpiresAt) {
      this.boostAmount += coinValue;
    } else {
      this.boostAmount = coinValue;
    }
    this.boostExpiresAt = Date.now() + BOOST_DURATION_MS;
  }

  toJSON() {
    const badge = this.badge;
    return {
      userId: this.userId,
      nickname: this.nickname,
      profilePictureUrl: this.profilePictureUrl,
      score: this.score,
      roundScore: this.roundScore,
      x: this.x,
      y: this.y,
      radius: this.radius,
      badge: badge ? badge.label : null,
      boosted: Date.now() < this.boostExpiresAt,
      boostAmount: Date.now() < this.boostExpiresAt ? this.boostAmount : 0,
      boostMsRemaining: Math.max(0, this.boostExpiresAt - Date.now()),
    };
  }
}

class GameEngine {
  constructor(io) {
    this.io = io;
    this.players = new Map(); // userId -> Player
    this.joinedThisStream = new Set(); // for "first comment joins" tracking
    this.running = false;
    this.roundEndsAt = 0;
    this.roundNumber = 0;
    this.events = []; // recent floating +/- events for the UI
    this.physicsTimer = null;
    this.roundTimer = null;
    this.leaderboardHistory = []; // past round winners
  }

  // ---------- Round lifecycle ----------

  start() {
    if (this.running) return;
    this.running = true;
    this.startNewRound();
    this.physicsTimer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.running = false;
    clearInterval(this.physicsTimer);
    clearTimeout(this.roundTimer);
    this.physicsTimer = null;
    this.roundTimer = null;
    this.broadcastState();
  }

  startNewRound() {
    this.roundNumber += 1;
    for (const p of this.players.values()) {
      p.roundScore = 0;
      p.boostAmount = 0;
      p.boostExpiresAt = 0;
    }
    this.roundEndsAt = Date.now() + ROUND_DURATION_MS;
    this.io.emit("round:start", {
      roundNumber: this.roundNumber,
      roundEndsAt: this.roundEndsAt,
    });
    clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => this.endRound(), ROUND_DURATION_MS);
  }

  endRound() {
    const ranked = [...this.players.values()].sort((a, b) => b.roundScore - a.roundScore);
    const winner = ranked[0] || null;
    if (winner) {
      this.leaderboardHistory.unshift({
        roundNumber: this.roundNumber,
        winnerNickname: winner.nickname,
        winnerScore: winner.roundScore,
        userId: winner.userId,
      });
      this.leaderboardHistory = this.leaderboardHistory.slice(0, 20);
    }
    this.io.emit("round:end", {
      roundNumber: this.roundNumber,
      winner: winner ? winner.toJSON() : null,
      leaderboard: ranked.slice(0, 10).map((p) => p.toJSON()),
    });
    if (this.running) {
      // brief pause before next round for the "winner" screen
      setTimeout(() => {
        if (this.running) this.startNewRound();
      }, 5000);
    }
  }

  // ---------- Player management ----------

  ensurePlayer(userId, nickname, profilePictureUrl) {
    let p = this.players.get(userId);
    if (!p) {
      p = new Player(userId, nickname, profilePictureUrl);
      this.players.set(userId, p);
      this.io.emit("player:joined", p.toJSON());
    } else {
      // keep profile data fresh
      p.nickname = nickname || p.nickname;
      p.profilePictureUrl = profilePictureUrl || p.profilePictureUrl;
    }
    return p;
  }

  handleChatJoin(userId, nickname, profilePictureUrl, comment, keyword = "انضم") {
    const alreadyJoined = this.players.has(userId);
    const isFirstComment = !this.joinedThisStream.has(userId);
    const saidKeyword = comment && comment.trim().includes(keyword);

    if (!alreadyJoined && (saidKeyword || isFirstComment)) {
      this.ensurePlayer(userId, nickname, profilePictureUrl);
    }
    this.joinedThisStream.add(userId);
  }

  handleLike(userId, nickname, profilePictureUrl, likeCount = 1) {
    if (!this.players.has(userId)) {
      // likes alone don't create a player; must join via keyword/first comment first
      return;
    }
    const p = this.players.get(userId);
    p.score += likeCount;
    p.roundScore += likeCount;
    this.pushEvent({ type: "like", userId, amount: likeCount });
  }

  handleGift(userId, nickname, profilePictureUrl, coinValue) {
    const p = this.ensurePlayer(userId, nickname, profilePictureUrl);
    p.applyBoost(coinValue);
    this.pushEvent({ type: "boost", userId, amount: coinValue });
    this.io.emit("player:boosted", p.toJSON());
  }

  pushEvent(evt) {
    evt.ts = Date.now();
    this.events.push(evt);
    if (this.events.length > 200) this.events.shift();
    this.io.emit("event", evt);
  }

  // ---------- Physics / collisions ----------

  tick() {
    if (!this.running) return;
    const dt = TICK_MS / 1000;
    const players = [...this.players.values()];

    // move
    for (const p of players) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // bounce off arena boundary
      const dist = Math.hypot(p.x, p.y);
      const maxDist = ARENA_RADIUS - p.radius;
      if (dist > maxDist && maxDist > 0) {
        const angle = Math.atan2(p.y, p.x);
        p.x = Math.cos(angle) * maxDist;
        p.y = Math.sin(angle) * maxDist;
        // reflect velocity
        const nx = Math.cos(angle);
        const ny = Math.sin(angle);
        const dot = p.vx * nx + p.vy * ny;
        p.vx -= 2 * dot * nx;
        p.vy -= 2 * dot * ny;
      }

      // small random drift so bubbles keep moving
      p.vx += (Math.random() - 0.5) * 4;
      p.vy += (Math.random() - 0.5) * 4;
      const speed = Math.hypot(p.vx, p.vy);
      const maxSpeed = 60;
      if (speed > maxSpeed) {
        p.vx = (p.vx / speed) * maxSpeed;
        p.vy = (p.vy / speed) * maxSpeed;
      }
    }

    // collisions (pairwise)
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = a.radius + b.radius;
        if (dist < minDist && dist > 0) {
          // separate them
          const overlap = minDist - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          a.x -= (nx * overlap) / 2;
          a.y -= (ny * overlap) / 2;
          b.x += (nx * overlap) / 2;
          b.y += (ny * overlap) / 2;

          // simple velocity swap along normal (bounce)
          [a.vx, b.vx] = [b.vx, a.vx];
          [a.vy, b.vy] = [b.vy, a.vy];

          // damage exchange: each deals their current attack damage to the other
          if (!a._justCollided || a._justCollided < Date.now() - 300) {
            const dmgToB = a.currentAttackDamage;
            b.roundScore = Math.max(0, b.roundScore - dmgToB);
            this.pushEvent({ type: "hit", fromUserId: a.userId, toUserId: b.userId, amount: dmgToB });
            a._justCollided = Date.now();
          }
          if (!b._justCollided || b._justCollided < Date.now() - 300) {
            const dmgToA = b.currentAttackDamage;
            a.roundScore = Math.max(0, a.roundScore - dmgToA);
            this.pushEvent({ type: "hit", fromUserId: b.userId, toUserId: a.userId, amount: dmgToA });
            b._justCollided = Date.now();
          }
        }
      }
    }

    this.broadcastState();
  }

  broadcastState() {
    const players = [...this.players.values()]
      .sort((a, b) => b.roundScore - a.roundScore)
      .map((p) => p.toJSON());
    this.io.emit("state", {
      running: this.running,
      roundNumber: this.roundNumber,
      roundEndsAt: this.roundEndsAt,
      players,
      leaderboardHistory: this.leaderboardHistory,
    });
  }
}

module.exports = { GameEngine, ARENA_RADIUS, BUBBLE_MIN_RADIUS, BUBBLE_MAX_RADIUS, SCORE_FOR_MAX_SIZE, ROUND_DURATION_MS, BOOST_DURATION_MS };
