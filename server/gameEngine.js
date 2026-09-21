/**
 * Battle Arena Game Engine
 * -------------------------
 * Individual player battle game:
 *  - A viewer joins purely by tapping/liking 8+ times — no comment
 *    required — starting with points = their accumulated taps × 10.
 *  - Each like/tap is worth 10 points (POINTS_PER_LIKE) to an
 *    already-joined player (green), and marks them as "tapping" for a
 *    few seconds (drives the spike-ring blade visual, see below).
 *  - Collisions between player bubbles deal 10 damage to the collided-into
 *    player (red) — proportionate to a single tap's worth of points. If a
 *    hit brings someone to 0, they're eliminated from the arena and the
 *    attacker earns a kill.
 *  - Gifts fire a sustained barrage of projectiles (GIFT_SHOTS_PER_SECOND
 *    shots/sec for GIFT_BARRAGE_DURATION_MS), each dealing the gift's full
 *    coin value in damage to whoever is currently the top scorer
 *    (re-targeted every shot), and show the gifter's activated level once
 *    at the start of the barrage.
 *  - Leveling: score grows bubble size up to a cap, then grants a rank
 *    (bronze/silver/gold/diamond/ruby/crown) that colors the spike-ring
 *    blade. The blade itself only shows while the player is actively
 *    tapping (within ACTIVE_TAP_WINDOW_MS of their last tap) — it's an
 *    activity indicator, not a permanent badge — and fades out a few
 *    seconds after tapping stops. An unranked player who is tapping still
 *    gets a blade, in a default color.
 *  - Rounds last 3 minutes; highest score wins; next round auto-starts
 *    until the host stops the game.
 */

const ARENA_RADIUS = 500; // virtual arena units
const BUBBLE_MIN_RADIUS = 28;
const BUBBLE_MAX_RADIUS = 70; // size cap before rank tiers kick in
const SCORE_FOR_MAX_SIZE = 1000; // points needed to reach max bubble size
const BASE_COLLISION_DAMAGE = 10; // matches POINTS_PER_LIKE: a hit undoes ~1 tap's worth
const ROUND_DURATION_MS = 3 * 60 * 1000;
const MIN_ROUND_DURATION_MS = 15 * 1000; // safety floor for setConfig()
const TICK_MS = 50; // physics/collision tick rate
const MAX_SPEED = 140; // bubble movement speed (virtual units/sec)
const JOIN_LIKE_THRESHOLD = 8; // raw taps required to join (taps only, no comment)
const POINTS_PER_LIKE = 10; // points awarded per tap/like
const ACTIVE_TAP_WINDOW_MS = 3000; // how long the blade stays visible after the last tap
const DEFAULT_BLADE_COLOR = "#67e8f9";
const DEFAULT_BLADE_SPIKES = 10;
const GIFT_BARRAGE_DURATION_MS = 10 * 1000; // gifts fire a sustained barrage, not one shot
const GIFT_SHOTS_PER_SECOND = 3;

// Rank tiers beyond the size cap: score -> visual identity (color + spike
// ring). Spike count escalates with rank for a clearer sense of power.
// Thresholds are scaled to POINTS_PER_LIKE so the number of taps needed to
// reach each rank stays the same as before the per-tap value increased.
const RANKS = [
  { threshold: SCORE_FOR_MAX_SIZE, id: "bronze", label: "🥉", color: "#cd7f32", spikes: 14 },
  { threshold: 2500, id: "silver", label: "🥈", color: "#c7ccd1", spikes: 16 },
  { threshold: 5000, id: "gold", label: "🥇", color: "#ffd54a", spikes: 18 },
  { threshold: 10000, id: "diamond", label: "💎", color: "#67e8f9", spikes: 20 },
  { threshold: 20000, id: "ruby", label: "🔴", color: "#f43f5e", spikes: 22 },
  { threshold: 40000, id: "crown", label: "👑", color: "#facc15", spikes: 26 },
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

// TikTok's payloads have repeatedly shown numeric-looking fields arriving
// as JSON strings (e.g. "2" instead of 2). Left uncoerced, accumulating
// such a value with += performs string concatenation instead of addition
// (0 + "6" -> "06"), silently corrupting every count derived from it. Every
// tap/coin count that reaches the engine is funneled through this first.
function toPositiveInt(value, fallback) {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
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
    this.lastTapAt = 0; // drives the "tapping" activity flag below
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

  // The blade is an activity indicator, not a permanent badge: true only
  // while this player has tapped within the last ACTIVE_TAP_WINDOW_MS.
  get tapping() {
    return this.lastTapAt > 0 && Date.now() - this.lastTapAt < ACTIVE_TAP_WINDOW_MS;
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
      tapping: this.tapping,
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
    // userId -> { likeCount, nickname, profilePictureUrl }
    // Tracks viewers working toward the join threshold before they have a
    // bubble in the arena.
    this.pendingJoins = new Map();
    this.running = false;
    this.roundEndsAt = 0;
    this.roundNumber = 0;
    this.roundDurationMs = ROUND_DURATION_MS; // configurable via setConfig()
    this.totalRounds = 0; // 0 = unlimited (default); N = stop after round N
    this.events = []; // recent floating +/- events for the UI
    this.physicsTimer = null;
    this.roundTimer = null;
    this.leaderboardHistory = []; // past round winners
    // Diagnostic budget for logging pending-join tap accumulation — capped
    // so a busy stream doesn't flood the logs forever, but generous enough
    // to watch several viewers' progress toward the 20-tap threshold.
    this.pendingLogsLeft = 50;
    // Interval IDs for in-flight gift barrages (see handleGift), tracked so
    // stop()/resetPlayers() can cancel them instead of leaving them firing
    // into a stopped or cleared game.
    this.activeBarrages = new Set();
  }

  // Updates round duration / total-rounds-per-competition. Takes effect
  // from the next round that starts — an in-progress round keeps running
  // on its original deadline, so changing this mid-round never yanks the
  // timer backward or forward under the host's feet.
  setConfig({ roundDurationMs, totalRounds } = {}) {
    if (typeof roundDurationMs === "number" && Number.isFinite(roundDurationMs) && roundDurationMs >= MIN_ROUND_DURATION_MS) {
      this.roundDurationMs = roundDurationMs;
    }
    if (typeof totalRounds === "number" && Number.isFinite(totalRounds) && totalRounds >= 0) {
      this.totalRounds = Math.floor(totalRounds);
    }
    return { roundDurationMs: this.roundDurationMs, totalRounds: this.totalRounds };
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
    this.roundEndsAt = 0; // otherwise the client keeps counting down a stale deadline
    this._clearBarrages();
    this.broadcastState();
  }

  startNewRound() {
    this.roundNumber += 1;
    for (const p of this.players.values()) {
      p.roundScore = 0;
      p.kills = 0;
    }
    this.roundEndsAt = Date.now() + this.roundDurationMs;
    this.io.emit("round:start", {
      roundNumber: this.roundNumber,
      roundEndsAt: this.roundEndsAt,
      totalRounds: this.totalRounds,
    });
    clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => this.endRound(), this.roundDurationMs);
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
    const competitionComplete = this.totalRounds > 0 && this.roundNumber >= this.totalRounds;
    this.io.emit("round:end", {
      roundNumber: this.roundNumber,
      winner: winner ? winner.toJSON() : null,
      leaderboard: ranked.slice(0, 10).map((p) => p.toJSON()),
      competitionComplete,
      totalRounds: this.totalRounds,
    });
    if (competitionComplete) {
      // The configured number of rounds is done — stop the whole
      // competition rather than looping forever, matching "N rounds per
      // competition". The host starts a fresh competition manually.
      this.stop();
    } else if (this.running) {
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
      entry = { likeCount: 0, nickname, profilePictureUrl };
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
    if (entry.likeCount >= JOIN_LIKE_THRESHOLD) {
      // Raw taps accumulated before joining convert to points at the same
      // rate as taps do once in the arena, so nothing is lost by joining
      // "late" relative to tapping while already in.
      const startingScore = entry.likeCount * POINTS_PER_LIKE;
      const p = this.ensurePlayer(userId, entry.nickname, entry.profilePictureUrl, startingScore);
      p.lastTapAt = Date.now(); // they just tapped their way in — blade shows immediately
      this.pendingJoins.delete(userId);
      if (this.pendingLogsLeft > 0) {
        this.pendingLogsLeft--;
        console.log(`PENDING JOIN: ${entry.nickname} (${userId}) reached ${entry.likeCount} taps -> PROMOTED with ${startingScore} points`);
      }
    } else if (this.pendingLogsLeft > 0) {
      this.pendingLogsLeft--;
      console.log(`PENDING JOIN: ${entry.nickname} (${userId}) now at ${entry.likeCount}/${JOIN_LIKE_THRESHOLD} taps`);
    }
  }

  // Comments no longer gate joining (joining is tap-count only), but a
  // comment can still carry a fresher nickname/photo than LIKE events do,
  // so it's kept as an opportunistic profile-info refresh.
  handleComment(userId, nickname, profilePictureUrl, comment) {
    if (!userId) return;
    const p = this.players.get(userId);
    if (p) {
      p.nickname = nickname || p.nickname;
      p.profilePictureUrl = profilePictureUrl || p.profilePictureUrl;
      return;
    }
    this._getPending(userId, nickname, profilePictureUrl);
  }

  handleLike(userId, nickname, profilePictureUrl, likeCount = 1) {
    if (!userId) return;
    const taps = toPositiveInt(likeCount, 1);
    const p = this.players.get(userId);
    if (p) {
      const points = taps * POINTS_PER_LIKE;
      p.score += points;
      p.roundScore += points;
      p.lastTapAt = Date.now();
      this.pushEvent({ type: "like", userId, amount: points });
      return;
    }
    // Not yet joined: raw tap count accumulates toward the 20-tap join
    // threshold (the threshold is a tap count, not a point total).
    const entry = this._getPending(userId, nickname, profilePictureUrl);
    entry.likeCount += taps;
    this._tryPromote(userId);
  }

  // Gifts fire a sustained barrage of projectiles — not one shot — at
  // whoever is the current top scorer (excluding the gifter), retargeted
  // on every shot so a barrage that finishes off the leader keeps firing
  // at the new one. Each shot deals the gift's full coin value in damage,
  // for GIFT_SHOTS_PER_SECOND shots/sec over GIFT_BARRAGE_DURATION_MS.
  // The "activated level" toast fires once, on the barrage's first shot.
  handleGift(userId, nickname, profilePictureUrl, coinValue) {
    const coins = toPositiveInt(coinValue, 1);
    let attacker = this.players.get(userId);
    if (!attacker) {
      // A gift is at least as strong a signal of engagement as the normal
      // tap-join condition, so it's allowed to join the gifter immediately
      // — but any taps they'd already racked up toward the threshold must
      // still convert to their starting score, instead of being discarded.
      const pending = this.pendingJoins.get(userId);
      const startingScore = pending ? pending.likeCount * POINTS_PER_LIKE : 0;
      attacker = this.ensurePlayer(userId, nickname, profilePictureUrl, startingScore);
      this.pendingJoins.delete(userId);
    }
    const attackerId = attacker.userId;
    const level = levelForCoinValue(coins);
    const totalShots = Math.round((GIFT_BARRAGE_DURATION_MS / 1000) * GIFT_SHOTS_PER_SECOND);
    let shotsFired = 0;

    const fireShot = () => {
      const liveAttacker = this.players.get(attackerId);
      if (!liveAttacker) return; // attacker left the arena mid-barrage; skip silently

      let target = null;
      for (const p of this.players.values()) {
        if (p.userId === attackerId) continue;
        if (!target || p.roundScore > target.roundScore) target = p;
      }

      let eliminated = false;
      if (target) {
        target.roundScore = Math.max(0, target.roundScore - coins);
        this.pushEvent({ type: "hit", fromUserId: attackerId, toUserId: target.userId, amount: coins });
        if (target.roundScore <= 0) {
          this.eliminate(target, liveAttacker);
          eliminated = true;
        }
      }

      this.io.emit("gift:attack", {
        from: { userId: liveAttacker.userId, nickname: liveAttacker.nickname, x: liveAttacker.x, y: liveAttacker.y },
        to: target ? { userId: target.userId, nickname: target.nickname, x: target.x, y: target.y } : null,
        amount: coins,
        level,
        eliminated,
        showLevelToast: shotsFired === 0,
      });

      this.broadcastState();
      shotsFired++;
    };

    fireShot();
    const intervalId = setInterval(() => {
      if (shotsFired >= totalShots) {
        clearInterval(intervalId);
        this.activeBarrages.delete(intervalId);
        return;
      }
      fireShot();
    }, 1000 / GIFT_SHOTS_PER_SECOND);
    this.activeBarrages.add(intervalId);
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
    this._clearBarrages();
    this.broadcastState();
  }

  _clearBarrages() {
    for (const id of this.activeBarrages) clearInterval(id);
    this.activeBarrages.clear();
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
      roundDurationMs: this.roundDurationMs,
      totalRounds: this.totalRounds,
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
  MIN_ROUND_DURATION_MS,
  JOIN_LIKE_THRESHOLD,
  POINTS_PER_LIKE,
  ACTIVE_TAP_WINDOW_MS,
  DEFAULT_BLADE_COLOR,
  DEFAULT_BLADE_SPIKES,
  BASE_COLLISION_DAMAGE,
  GIFT_BARRAGE_DURATION_MS,
  GIFT_SHOTS_PER_SECOND,
  RANKS,
};
