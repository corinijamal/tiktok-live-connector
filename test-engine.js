const { GameEngine, JOIN_LIKE_THRESHOLD } = require("./server/gameEngine");

const emitted = [];
const fakeIo = { emit: (evt, data) => emitted.push([evt, data]) };
const engine = new GameEngine(fakeIo);

function clearEmitted() { emitted.length = 0; }
function emittedOfType(type) { return emitted.filter(([evt]) => evt === type); }

// ---- 1. Comment alone does not join ----
engine.handleComment("u1", "Ali", null, "hello");
console.assert(!engine.players.has("u1"), "Comment alone should NOT create a player");
console.log("1) comment-only -> no player:", !engine.players.has("u1"));

// ---- 2. Likes under threshold do not join ----
engine.handleLike("u2", "Sara", null, 5);
console.assert(!engine.players.has("u2"), "5 likes alone should NOT create a player (no comment yet)");
console.log("2) 5 likes, no comment -> no player:", !engine.players.has("u2"));

// ---- 3. Likes reaching threshold WITHOUT comment still doesn't join ----
engine.handleLike("u2", "Sara", null, 20); // total 25 likes now, still no comment
console.assert(!engine.players.has("u2"), "25 likes with no comment should still NOT create a player");
console.log("3) 25 likes, no comment -> no player:", !engine.players.has("u2"));

// ---- 4. Comment completes the join condition -> promoted with accumulated likes as score ----
engine.handleComment("u2", "Sara", null, "hi");
console.assert(engine.players.has("u2"), "Comment after 25 likes should promote to player");
const sara = engine.players.get("u2");
console.assert(sara.roundScore === 25, `Expected Sara to start with 25 points, got ${sara.roundScore}`);
console.log("4) comment completes join -> Sara score:", sara.roundScore);

// ---- 5. u1 (commented first) now reaches threshold via likes -> joins with 20 ----
engine.handleLike("u1", "Ali", null, JOIN_LIKE_THRESHOLD);
console.assert(engine.players.has("u1"), "Ali should join once likes reach the threshold");
const ali = engine.players.get("u1");
console.assert(ali.roundScore === JOIN_LIKE_THRESHOLD, `Expected Ali to start with ${JOIN_LIKE_THRESHOLD}, got ${ali.roundScore}`);
console.log("5) Ali joins via likes -> score:", ali.roundScore);

// ---- 6. Further likes on an already-joined player add directly ----
engine.handleLike("u1", "Ali", null, 10);
console.assert(ali.roundScore === 30, `Expected Ali's score to be 30 after +10, got ${ali.roundScore}`);
console.log("6) additional likes after join -> Ali score:", ali.roundScore);

// ---- 7. Collision elimination + kill credit ----
ali.x = 0; ali.y = 0; ali.vx = 0; ali.vy = 0;
sara.x = 1; sara.y = 0; sara.vx = 0; sara.vy = 0;
sara.roundScore = 1; // one hit from Ali should eliminate Sara
engine.running = true;
clearEmitted();
engine.tick();
console.assert(!engine.players.has("u2"), "Sara should be eliminated after her score hits 0");
console.assert(ali.kills === 1, `Expected Ali to have 1 kill, got ${ali.kills}`);
const elimEvents = emittedOfType("player:eliminated");
console.assert(elimEvents.length === 1, "Expected exactly one player:eliminated event");
console.log("7) collision elimination -> Sara removed:", !engine.players.has("u2"), "| Ali kills:", ali.kills);
engine.running = false;

// ---- 8. Gift attack targets the current top scorer and can eliminate ----
engine.handleComment("u3", "Omar", null, "hey");
engine.handleLike("u3", "Omar", null, JOIN_LIKE_THRESHOLD);
const omar = engine.players.get("u3");
omar.roundScore = 500; // make Omar the top scorer
clearEmitted();
engine.handleGift("u1", "Ali", null, 50); // Ali gifts -> should attack Omar (top scorer, not self)
const giftEvents = emittedOfType("gift:attack");
console.assert(giftEvents.length === 1, "Expected one gift:attack event");
const giftPayload = giftEvents[0][1];
console.assert(giftPayload.to && giftPayload.to.userId === "u3", `Expected gift to target Omar (u3), got ${JSON.stringify(giftPayload.to)}`);
console.assert(giftPayload.level === 3, `Expected level 3 for a 50-coin gift, got ${giftPayload.level}`);
console.assert(omar.roundScore === 450, `Expected Omar's score to drop to 450 after 50 dmg, got ${omar.roundScore}`);
console.log("8) gift attack -> target:", giftPayload.to.userId, "| level:", giftPayload.level, "| Omar score:", omar.roundScore);

// ---- 9. resetPlayers clears everyone (reconnect fix) ----
engine.resetPlayers();
console.assert(engine.players.size === 0, "resetPlayers should clear all active players");
console.assert(engine.pendingJoins.size === 0, "resetPlayers should clear all pending joins");
console.log("9) resetPlayers -> players:", engine.players.size, "pending:", engine.pendingJoins.size);

console.log("\nALL CHECKS RAN (see any 'Assertion failed' lines above for failures)");
