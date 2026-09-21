const { GameEngine, JOIN_LIKE_THRESHOLD, POINTS_PER_LIKE, ACTIVE_TAP_WINDOW_MS } = require("./server/gameEngine");

const emitted = [];
const fakeIo = { emit: (evt, data) => emitted.push([evt, data]) };
const engine = new GameEngine(fakeIo);

function clearEmitted() { emitted.length = 0; }
function emittedOfType(type) { return emitted.filter(([evt]) => evt === type); }

// ---- 1. Taps under threshold do not join (no comment needed at all now) ----
engine.handleLike("u1", "Ali", null, 5);
console.assert(!engine.players.has("u1"), "5 taps alone should NOT create a player yet");
console.log("1) 5 taps -> no player:", !engine.players.has("u1"));

// ---- 2. Reaching the threshold via taps ALONE joins, no comment required ----
engine.handleLike("u1", "Ali", null, JOIN_LIKE_THRESHOLD - 5); // total = threshold
console.assert(engine.players.has("u1"), "Ali should join once taps reach the threshold, with no comment at all");
const ali = engine.players.get("u1");
const expectedAliStart = JOIN_LIKE_THRESHOLD * POINTS_PER_LIKE;
console.assert(ali.roundScore === expectedAliStart, `Expected Ali to start with ${expectedAliStart}, got ${ali.roundScore}`);
console.log("2) taps-only join (no comment) -> Ali score:", ali.roundScore);

// ---- 3. A comment alone (no taps) never joins someone ----
engine.handleComment("u2", "Sara", null, "hello");
console.assert(!engine.players.has("u2"), "A comment alone should never join someone (taps-only now)");
console.log("3) comment-only -> no player:", !engine.players.has("u2"));

// ---- 4. Further taps on an already-joined player add points and refresh tapping ----
engine.handleLike("u1", "Ali", null, 10);
const expectedAliAfter = expectedAliStart + 10 * POINTS_PER_LIKE;
console.assert(ali.roundScore === expectedAliAfter, `Expected Ali's score to be ${expectedAliAfter} after +10 taps, got ${ali.roundScore}`);
console.assert(ali.tapping === true, "Ali should be flagged as actively tapping right after a like event");
console.log("4) additional taps -> Ali score:", ali.roundScore, "| tapping:", ali.tapping);

// ---- 5. The tapping flag expires after the activity window ----
ali.lastTapAt = Date.now() - (ACTIVE_TAP_WINDOW_MS + 500);
console.assert(ali.tapping === false, "Ali should no longer be 'tapping' after the activity window elapses");
console.log("5) tapping flag expires after window:", ali.tapping === false);

// ---- 6. String-typed tap counts must not corrupt accumulation (concat bug) ----
engine.handleLike("u3", "Reem", null, "3");  // string, not number
engine.handleLike("u3", "Reem", null, "5"); // string, not number -> total raw taps = threshold
const reem = engine.players.get("u3");
console.assert(!!reem, "Reem should have joined after 3+5 string-typed taps reach the threshold");
const expectedReemStart = JOIN_LIKE_THRESHOLD * POINTS_PER_LIKE;
console.assert(reem && reem.roundScore === expectedReemStart, `Expected Reem to start with ${expectedReemStart}, got ${reem && reem.roundScore}`);
console.log("6) string-typed like counts -> Reem score:", reem && reem.roundScore);

// ---- 7. Collision elimination + kill credit ----
ali.x = 0; ali.y = 0; ali.vx = 0; ali.vy = 0;
reem.x = 1; reem.y = 0; reem.vx = 0; reem.vy = 0;
reem.roundScore = 1; // one hit from Ali should eliminate Reem
engine.running = true;
clearEmitted();
engine.tick();
console.assert(!engine.players.has("u3"), "Reem should be eliminated after her score hits 0");
console.assert(ali.kills === 1, `Expected Ali to have 1 kill, got ${ali.kills}`);
const elimEvents = emittedOfType("player:eliminated");
console.assert(elimEvents.length === 1, "Expected exactly one player:eliminated event");
console.log("7) collision elimination -> Reem removed:", !engine.players.has("u3"), "| Ali kills:", ali.kills);
engine.running = false;

// ---- 8. Gift attack targets the current top scorer and can eliminate ----
engine.handleLike("u4", "Omar", null, JOIN_LIKE_THRESHOLD);
const omar = engine.players.get("u4");
omar.roundScore = 500; // make Omar the top scorer (arbitrary test value)
clearEmitted();
engine.handleGift("u1", "Ali", null, 50); // Ali gifts -> should attack Omar (top scorer, not self)
const giftEvents = emittedOfType("gift:attack");
console.assert(giftEvents.length === 1, "Expected one gift:attack event");
const giftPayload = giftEvents[0][1];
console.assert(giftPayload.to && giftPayload.to.userId === "u4", `Expected gift to target Omar (u4), got ${JSON.stringify(giftPayload.to)}`);
console.assert(giftPayload.level === 3, `Expected level 3 for a 50-coin gift, got ${giftPayload.level}`);
console.assert(omar.roundScore === 450, `Expected Omar's score to drop to 450 after 50 dmg, got ${omar.roundScore}`);
console.log("8) gift attack -> target:", giftPayload.to.userId, "| level:", giftPayload.level, "| Omar score:", omar.roundScore);

// ---- 9. A gift from someone who already has partial tap progress but
// hasn't joined yet must inherit that progress as their starting score ----
engine.handleLike("u5", "Yousef", null, JOIN_LIKE_THRESHOLD - 3); // short of the threshold, not joined yet
console.assert(!engine.players.has("u5"), "Yousef should not be joined yet (short of the threshold)");
engine.handleGift("u5", "Yousef", null, 10); // gifting should join him using his partial taps, not 0
const yousef = engine.players.get("u5");
console.assert(!!yousef, "Yousef should be joined immediately by gifting");
const expectedYousefStart = (JOIN_LIKE_THRESHOLD - 3) * POINTS_PER_LIKE;
console.assert(yousef && yousef.roundScore === expectedYousefStart, `Expected Yousef to start with ${expectedYousefStart} from the gift path, got ${yousef && yousef.roundScore}`);
console.log("9) gift-before-join uses pending taps -> Yousef score:", yousef && yousef.roundScore);

// ---- 10. stop() clears roundEndsAt so the client-side timer stops counting ----
engine.start();
console.assert(engine.roundEndsAt > 0, "roundEndsAt should be set after start()");
engine.stop();
console.assert(engine.roundEndsAt === 0, `Expected roundEndsAt to be reset to 0 after stop(), got ${engine.roundEndsAt}`);
console.log("10) stop() clears roundEndsAt:", engine.roundEndsAt === 0);

// ---- 11. resetPlayers clears everyone (reconnect / manual reset) ----
engine.resetPlayers();
console.assert(engine.players.size === 0, "resetPlayers should clear all active players");
console.assert(engine.pendingJoins.size === 0, "resetPlayers should clear all pending joins");
console.log("11) resetPlayers -> players:", engine.players.size, "pending:", engine.pendingJoins.size);

console.log("\nALL CHECKS RAN (see any 'Assertion failed' lines above for failures)");
