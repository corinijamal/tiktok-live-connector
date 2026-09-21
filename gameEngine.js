/**
 * Battle Arena Game Engine
 * -------------------------
 * Individual player battle game:
 *  - A viewer joins once they've (a) posted at least one comment AND
 *    (b) tapped/liked 20+ times — whichever completes second promotes them
 *    into the arena, starting with their accumulated like count as points.
 *  - Each like (+1) adds a point to an already-joined player (green).
 *  - Collisions between player bubbles deal 1 damage to the collided-into
 *    player (red). If a hit brings someone to 0, they're eliminated from
 *    the arena and the attacker earns a kill.
 *  - Gifts fire a direct attack (damage = the gift's coin value) at the
 *    current top-scoring player, and show the gifter's activated level
 *    based on the gift's value.
 *  - Leveling: score grows bubble size up to a cap, then grants a
 *    rank (bronze/silver/gold/diamond/ruby/crown) with its own spike-ring
 *    color instead of continued growth.
 *  - Rounds last 3 minutes; highest score wins; next round auto-starts
 *    until the host stops the game.
 */

const ARENA_RADIUS = 500; // virtual arena units
const BUBBLE_MIN_RADIUS = 28;
const BUBBLE_MAX_RADIUS = 70; // size cap before rank tiers kick in
const SCORE_FOR_MAX_SIZE = 100; // points needed to reach max bubble size
const BASE_COLLISION_DAMAGE = 1;
const ROUND_DURATION_MS = 3 * 60 * 1000;
const TICK_MS = 50; // physics/collision tick rate
const MAX_SPEED = 140; // bubble movement speed (virtual units/sec)
const JOIN_LIKE_THRESHOLD = 20; // likes required (plus a comment) to join

// Rank tiers beyond the size cap: score -> visual identity (color + spike
// ring). Spike count escalates with rank for a clearer sense of power.
const RANKS = [
  { threshold: SCORE_FOR_MAX_SIZE, id: "bronze", label: "🥉", color: "#cd7f32", spikes: 6 },
  { threshold: 250, id: "silver", label: "🥈", color: "#c7ccd1", spikes: 7 },
  { threshold: 500, id: "gold", label: "🥇", color: "#ffd54a", spikes: 8 },
  { threshold: 1000, id: "diamond", label: "💎", color: "#67e8f9", spikes: 10 },
  { threshold: 2000, id: "ruby", label: "🔴", color: "#f43f5e", spikes: 11 },
  { threshold: 4000, id: "crown", label: "👑", color: "#facc15", spikes: 13 },
];

function getRank(score) {
  let current = null;
  for (const r of RANKS) {
    if (score >= r.threshold) current = r;
  }
  return current;
}

function getBubbleRadius(score) {
  const ratio = Math.min(score / SCORE_FOR_MAX_SIZE, 1);
  return BUBBLE_MIN_RADIUS + (BUBBLE_MAX_RADIUS - BUBBLE_MIN_RADIUS) * ratio;
}

// Gift value -> "activated level" shown in the level-up toast. A separate,
// simpler scale from the score-based rank above: this reflects the power
// of the gift itself, not the gifter's accumulated arena score.
function levelForCoinValue(coinValue) {
  if (coinValue >= 1000) return 6;
  if (coinValue >= 500) return 5;
  if (coinValue >= 100) return 4;
  if (coinValue >= 50) return 3;
  if (coinValue >= 10) return 2;
  return 1;
}

class Player {
  constructor(userId, nickname, profilePictureUrl) {
    this.userId = userId;
    this.nickname = nickname;
    this.profilePictureUrl = profilePictureUrl;
    this.score = 0;
    this.roundScore = 0;
    this.kills = 0;
    this.eliminated = false;
    // random starting position inside arena circle
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * (ARENA_RADIUS * 0.6);
    this.x = Math.cos(angle) * dist;
    this.y = Math.sin(angle) * dist;
    this.vx = (Math.random() - 0.5) * 70;
    this.vy = (Math.random() - 0.5) * 70;
    this.joinedAt = Date.now();
    this._justCollided = 0;
  }

  get radius() {
    return getBubbleRadius(this.roundScore);
  }

  get rank() {
    return getRank(this.roundScore);
  }

  toJSON() {
    const rank = this.rank;
    return {
      userId: this.userId,
      nickname: this.nickname,
      profilePictureUrl: this.profilePictureUrl,
      score: this.score,
      roundScore: this.roundScore,
      kills: this.kills,
      x: this.x,
      y: this.y,
      radius: this.radius,
      rankId: rank ? rank.id : null,
      rankLabel: rank ? rank.label : null,
      rankColor: rank ? rank.color : null,
      rankSpikes: rank ? rank.spikes : 0,
    };
  }
}

class GameEngine {
  constructor(io) {
    this.io = io;
    this.players = new Map(); // userId -> Player (active, in-arena)
    // userId -> { hasCommented, likeCount, nickname, profilePictureUrl }
    // Tracks viewers working toward the join threshold before they have a
    // bubble in the arena.
    this.pendingJoins = new Map();
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
      p.kills = 0;
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

  ensurePlayer(userId, nickname, profilePictureUrl, startingScore = 0) {
    let p = this.players.get(userId);
    if (!p) {
      p = new Player(userId, nickname, profilePictureUrl);
      p.score = startingScore;
      p.roundScore = startingScore;
      this.players.set(userId, p);
      this.io.emit("player:joined", p.toJSON());
    } else {
      // keep profile data fresh
      p.nickname = nickname || p.nickname;
      p.profilePictureUrl = profilePictureUrl || p.profilePictureUrl;
    }
    return p;
  }

  _getPending(userId, nickname, profilePictureUrl) {
    let entry = this.pendingJoins.get(userId);
    if (!entry) {
      entry = { hasCommented: false, likeCount: 0, nickname, profilePictureUrl };
      this.pendingJoins.set(userId, entry);
    } else {
      entry.nickname = nickname || entry.nickname;
      entry.profilePictureUrl = profilePictureUrl || entry.profilePictureUrl;
    }
    return entry;
  }

  _tryPromote(userId) {
    const entry = this.pendingJoins.get(userId);
    if (!entry) return;
    if (entry.hasCommented && entry.likeCount >= JOIN_LIKE_THRESHOLD) {
      this.ensurePlayer(userId, entry.nickname, entry.profilePictureUrl, entry.likeCount);
      this.pendingJoins.delete(userId);
    }
  }

  // A comment satisfies half of the join condition. Once this viewer has
  // also liked 20+ times, they're promoted into the arena.
  handleComment(userId, nickname, profilePictureUrl, comment) {
    if (!userId || this.players.has(userId)) return;
    const entry = this._getPending(userId, nickname, profilePictureUrl);
    entry.hasCommented = true;
    this._tryPromote(userId);
  }

  handleLike(userId, nickname, profilePictureUrl, likeCount = 1) {
    if (!userId) return;
    const p = this.players.get(userId);
    if (p) {
      p.score += likeCount;
      p.roundScore += likeCount;
      this.pushEvent({ type: "like", userId, amount: likeCount });
      return;
    }
    // Not yet joined: likes count toward the 20-like join threshold.
    const entry = this._getPending(userId, nickname, profilePictureUrl);
    entry.likeCount += likeCount;
    this._tryPromote(userId);
  }

  // Gifts fire a direct attack on the current top scorer (excluding the
  // gifter), dealing damage equal to the gift's coin value, and report an
  // "activated level" derived from that value for the UI toast.
  handleGift(userId, nickname, profilePictureUrl, coinValue) {
    const attacker = this.ensurePlayer(userId, nickname, profilePictureUrl);
    const level = levelForCoinValue(coinValue);

    let target = null;
    for (const p of this.players.values()) {
      if (p.userId === attacker.userId) continue;
      if (!target || p.roundScore > target.roundScore) target = p;
    }

    let eliminated = false;
    if (target) {
      target.roundScore = Math.max(0, target.roundScore - coinValue);
      this.pushEvent({ type: "hit", fromUserId: attacker.userId, toUserId: target.userId, amount: coinValue });
      if (target.roundScore <= 0) {
        this.eliminate(target, attacker);
        eliminated = true;
      }
    }

    this.io.emit("gift:attack", {
      from: { userId: attacker.userId, nickname: attacker.nickname, x: attacker.x, y: attacker.y },
      to: target ? { userId: target.userId, nickname: target.nickname, x: target.x, y: target.y } : null,
      amount: coinValue,
      level,
      eliminated,
    });

    this.broadcastState();
  }

  eliminate(victim, killer) {
    victim.eliminated = true;
    this.players.delete(victim.userId);
    if (killer) killer.kills += 1;
    this.io.emit("player:eliminated", {
      victim: { userId: victim.userId, nickname: victim.nickname, x: victim.x, y: victim.y },
      killer: killer ? killer.toJSON() : null,
    });
  }

  pushEvent(evt) {
    evt.ts = Date.now();
    this.events.push(evt);
    if (this.events.length > 200) this.events.shift();
    this.io.emit("event", evt);
  }

  // Clears all in-arena and pending players (used when switching connected
  // TikTok accounts, so a new stream never inherits the last one's bubbles).
  resetPlayers() {
    this.players.clear();
    this.pendingJoins.clear();
    this.broadcastState();
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
      p.vx += (Math.random() - 0.5) * 8;
      p.vy += (Math.random() - 0.5) * 8;
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > MAX_SPEED) {
        p.vx = (p.vx / speed) * MAX_SPEED;
        p.vy = (p.vy / speed) * MAX_SPEED;
      }
    }

    // collisions (pairwise)
    for (let i = 0; i < players.length; i++) {
      const a = players[i];
      if (a.eliminated) continue;
      for (let j = i + 1; j < players.length; j++) {
        const b = players[j];
        if (b.eliminated) continue;

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

          // damage exchange: each deals base damage to the other
          if (!a._justCollided || a._justCollided < Date.now() - 300) {
            b.roundScore = Math.max(0, b.roundScore - BASE_COLLISION_DAMAGE);
            this.pushEvent({ type: "hit", fromUserId: a.userId, toUserId: b.userId, amount: BASE_COLLISION_DAMAGE });
            a._justCollided = Date.now();
            if (b.roundScore <= 0) this.eliminate(b, a);
          }
          if (!b.eliminated && (!b._justCollided || b._justCollided < Date.now() - 300)) {
            a.roundScore = Math.max(0, a.roundScore - BASE_COLLISION_DAMAGE);
            this.pushEvent({ type: "hit", fromUserId: b.userId, toUserId: a.userId, amount: BASE_COLLISION_DAMAGE });
            b._justCollided = Date.now();
            if (a.roundScore <= 0) this.eliminate(a, b);
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

module.exports = {
  GameEngine,
  ARENA_RADIUS,
  BUBBLE_MIN_RADIUS,
  BUBBLE_MAX_RADIUS,
  SCORE_FOR_MAX_SIZE,
  ROUND_DURATION_MS,
  JOIN_LIKE_THRESHOLD,
  RANKS,
};
