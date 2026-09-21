const { GameEngine, JOIN_LIKE_THRESHOLD, POINTS_PER_LIKE } = require("./server/gameEngine");

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
console.assert(!engine.players.has("u2"), "5 taps alone should NOT create a player (no comment yet)");
console.log("2) 5 taps, no comment -> no player:", !engine.players.has("u2"));

// ---- 3. Taps reaching threshold WITHOUT comment still doesn't join ----
engine.handleLike("u2", "Sara", null, 20); // total 25 taps now, still no comment
console.assert(!engine.players.has("u2"), "25 taps with no comment should still NOT create a player");
console.log("3) 25 taps, no comment -> no player:", !engine.players.has("u2"));

// ---- 4. Comment completes the join condition -> promoted with taps*POINTS_PER_LIKE as score ----
engine.handleComment("u2", "Sara", null, "hi");
console.assert(engine.players.has("u2"), "Comment after 25 taps should promote to player");
const sara = engine.players.get("u2");
const expectedSaraStart = 25 * POINTS_PER_LIKE;
console.assert(sara.roundScore === expectedSaraStart, `Expected Sara to start with ${expectedSaraStart} points, got ${sara.roundScore}`);
console.log("4) comment completes join -> Sara score:", sara.roundScore, `(25 taps x ${POINTS_PER_LIKE})`);

// ---- 5. u1 (commented first) now reaches threshold via taps -> joins with threshold*10 ----
engine.handleLike("u1", "Ali", null, JOIN_LIKE_THRESHOLD);
console.assert(engine.players.has("u1"), "Ali should join once taps reach the threshold");
const ali = engine.players.get("u1");
const expectedAliStart = JOIN_LIKE_THRESHOLD * POINTS_PER_LIKE;
console.assert(ali.roundScore === expectedAliStart, `Expected Ali to start with ${expectedAliStart}, got ${ali.roundScore}`);
console.log("5) Ali joins via taps -> score:", ali.roundScore, `(${JOIN_LIKE_THRESHOLD} taps x ${POINTS_PER_LIKE})`);

// ---- 6. Further taps on an already-joined player add points at the same rate ----
engine.handleLike("u1", "Ali", null, 10);
const expectedAliAfter = expectedAliStart + 10 * POINTS_PER_LIKE;
console.assert(ali.roundScore === expectedAliAfter, `Expected Ali's score to be ${expectedAliAfter} after +10 taps, got ${ali.roundScore}`);
console.log("6) additional taps after join (+10 taps) -> Ali score:", ali.roundScore);

// ---- 7. Collision elimination + kill credit (collision damage is flat, unaffected by tap scaling) ----
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
omar.roundScore = 500; // make Omar the top scorer (arbitrary test value)
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

// ---- 10. String-typed tap counts (as TikTok's payloads sometimes send)
// must not corrupt accumulation via string concatenation ----
engine.handleComment("u4", "Reem", null, "hi");
engine.handleLike("u4", "Reem", null, "6");  // string, not number
engine.handleLike("u4", "Reem", null, "14"); // string, not number -> total raw taps = 20
const reem = engine.players.get("u4");
console.assert(!!reem, "Reem should have joined after 6+14 string-typed taps reach the threshold");
console.assert(reem && reem.roundScore === 200, `Expected Reem to start with 200 (20 taps x 10), got ${reem && reem.roundScore}`);
console.log("10) string-typed like counts -> Reem score:", reem && reem.roundScore);

// ---- 11. A gift from someone who already has partial tap progress but
// hasn't joined yet must inherit that progress as their starting score,
// not join with 0 ----
engine.handleComment("u5", "Yousef", null, "hey");
engine.handleLike("u5", "Yousef", null, 15); // 15 taps, short of the 20 threshold, not joined yet
console.assert(!engine.players.has("u5"), "Yousef should not be joined yet (only 15/20 taps)");
engine.handleGift("u5", "Yousef", null, 10); // gifting should join him using his 15 taps, not 0
const yousef = engine.players.get("u5");
console.assert(!!yousef, "Yousef should be joined immediately by gifting");
console.assert(yousef && yousef.roundScore === 150, `Expected Yousef to start with 150 (15 taps x 10) from the gift path, got ${yousef && yousef.roundScore}`);
console.log("11) gift-before-join uses pending taps -> Yousef score:", yousef && yousef.roundScore);

// ---- 12. stop() clears roundEndsAt so the client-side timer stops counting ----
engine.start();
console.assert(engine.roundEndsAt > 0, "roundEndsAt should be set after start()");
engine.stop();
console.assert(engine.roundEndsAt === 0, `Expected roundEndsAt to be reset to 0 after stop(), got ${engine.roundEndsAt}`);
console.log("12) stop() clears roundEndsAt:", engine.roundEndsAt === 0);

console.log("\nALL CHECKS RAN (see any 'Assertion failed' lines above for failures)");
