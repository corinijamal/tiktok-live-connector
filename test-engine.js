const { GameEngine, JOIN_LIKE_THRESHOLD, POINTS_PER_LIKE, ACTIVE_TAP_WINDOW_MS, MIN_ROUND_DURATION_MS, MAX_SPEED, MIN_SPEED_LIMIT, MAX_SPEED_LIMIT, BASE_COLLISION_DAMAGE } = require("./server/gameEngine");

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
const hitEvents = emittedOfType("event").filter(([, d]) => d.type === "hit");
console.assert(hitEvents.some(([, d]) => d.amount === BASE_COLLISION_DAMAGE), `Expected a collision hit event dealing ${BASE_COLLISION_DAMAGE} damage (BASE_COLLISION_DAMAGE), got amounts: ${hitEvents.map(([, d]) => d.amount)}`);
console.log("7) collision elimination -> Reem removed:", !engine.players.has("u3"), "| Ali kills:", ali.kills, "| hit amount:", BASE_COLLISION_DAMAGE);
engine.running = false;

// ---- 8. Gift dual-mode: "level" mode adds +1 attackLevel per coin and
// announces via gift:levelup; "shots" mode targets whoever has the
// HIGHEST ATTACK LEVEL among enemies — not highest score ----
engine.handleLike("u4", "Omar", null, JOIN_LIKE_THRESHOLD);
const omar = engine.players.get("u4");
omar.roundScore = 500; // Omar has the highest SCORE...
omar.attackLevel = 2; // ...but a low attack level

engine.handleLike("u8", "Layla", null, JOIN_LIKE_THRESHOLD);
const layla = engine.players.get("u8");
layla.roundScore = 200; // Layla has a much lower score...
layla.attackLevel = 40; // ...but the highest attack level -> should be the real target

clearEmitted();
engine.handleGift("u1", "Ali", null, 50); // both giftMode.level and giftMode.shots are on by default

const levelupEvents = emittedOfType("gift:levelup");
console.assert(levelupEvents.length === 1, "Expected one gift:levelup event");
console.assert(ali.attackLevel === 50, `Expected Ali's attackLevel to become 50 (1 per coin), got ${ali.attackLevel}`);
console.assert(levelupEvents[0][1].attackLevel === 50, `Expected gift:levelup to report attackLevel 50, got ${levelupEvents[0][1].attackLevel}`);

const giftEvents = emittedOfType("gift:attack");
console.assert(giftEvents.length === 1, "Expected one gift:attack event (first shot fires synchronously)");
const giftPayload = giftEvents[0][1];
console.assert(giftPayload.to && giftPayload.to.userId === "u8", `Expected the shot to target Layla (highest attackLevel, not Omar's higher score), got ${JSON.stringify(giftPayload.to)}`);
console.assert(layla.roundScore === 150, `Expected Layla's score to drop to 150 after 50 dmg, got ${layla.roundScore}`);
console.log("8) gift level+shots -> Ali attackLevel:", ali.attackLevel, "| barrage targeted:", giftPayload.to.userId, "(highest attackLevel, not Omar's higher score)");

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
console.assert(engine.activeBarrages.size === 0, "resetPlayers should clear any in-flight gift barrages");
console.log("11) resetPlayers -> players:", engine.players.size, "pending:", engine.pendingJoins.size);

// ---- 12. setConfig: configurable round duration + rounds-per-competition,
// with the competition auto-stopping once the configured round count is
// reached (instead of looping forever) ----
const cfgEngine = new GameEngine(fakeIo);
const cfgResult = cfgEngine.setConfig({ roundDurationMs: 90000, totalRounds: 2 });
console.assert(cfgResult.roundDurationMs === 90000 && cfgResult.totalRounds === 2, `Expected setConfig to apply valid values, got ${JSON.stringify(cfgResult)}`);
cfgEngine.setConfig({ roundDurationMs: 500, totalRounds: -3 }); // invalid: below floor / negative
console.assert(cfgEngine.roundDurationMs === 90000, `Expected an invalid (too-short) duration to be ignored, got ${cfgEngine.roundDurationMs}`);
console.assert(cfgEngine.totalRounds === 2, `Expected an invalid (negative) round count to be ignored, got ${cfgEngine.totalRounds}`);

cfgEngine.setConfig({ roundDurationMs: MIN_ROUND_DURATION_MS }); // shorten so the test doesn't wait real minutes
cfgEngine.start(); // round 1 of 2
cfgEngine.endRound(); // end round 1 -> competition NOT complete yet, should auto-continue
console.assert(cfgEngine.running === true, "Expected the engine to still be running after round 1 of 2");
cfgEngine.startNewRound(); // round 2 of 2 (calling directly instead of waiting the real 5s pause)
cfgEngine.endRound(); // end round 2 -> competition complete, should auto-stop
console.assert(cfgEngine.running === false, "Expected the engine to auto-stop after the final configured round");
console.assert(cfgEngine.roundEndsAt === 0, "Expected roundEndsAt to be cleared once the competition auto-stops");
console.log("12) setConfig + competition auto-stop after round", cfgEngine.roundNumber, "of 2 -> running:", cfgEngine.running);

// ---- 13. setConfig: bubble speed and gift-mode toggles ----
const speedEngine = new GameEngine(fakeIo);
console.assert(speedEngine.maxSpeed === MAX_SPEED, `Expected default maxSpeed ${MAX_SPEED}, got ${speedEngine.maxSpeed}`);
console.assert(speedEngine.giftMode.level === true && speedEngine.giftMode.shots === true, "Expected both gift modes on by default");
const speedResult = speedEngine.setConfig({ maxSpeed: 300 });
console.assert(speedResult.maxSpeed === 300, `Expected maxSpeed to update to 300, got ${speedResult.maxSpeed}`);
speedEngine.setConfig({ maxSpeed: 99999 }); // above the safety ceiling -> should clamp, not reject
console.assert(speedEngine.maxSpeed === MAX_SPEED_LIMIT, `Expected an over-ceiling maxSpeed to clamp to ${MAX_SPEED_LIMIT}, got ${speedEngine.maxSpeed}`);
speedEngine.setConfig({ maxSpeed: 1 }); // below the safety floor -> should clamp, not reject
console.assert(speedEngine.maxSpeed === MIN_SPEED_LIMIT, `Expected a below-floor maxSpeed to clamp to ${MIN_SPEED_LIMIT}, got ${speedEngine.maxSpeed}`);
speedEngine.setConfig({ giftMode: { level: false } }); // partial update: only touches the given key
console.assert(speedEngine.giftMode.level === false && speedEngine.giftMode.shots === true, `Expected only giftMode.level to change, got ${JSON.stringify(speedEngine.giftMode)}`);
console.log("13) setConfig maxSpeed/giftMode -> maxSpeed:", speedEngine.maxSpeed, "giftMode:", JSON.stringify(speedEngine.giftMode));

// ---- 14. giftMode gating: level-only gifts don't fire a barrage;
// shots-only gifts don't touch attackLevel ----
const modeEngine = new GameEngine(fakeIo);
modeEngine.handleLike("m1", "Attacker", null, JOIN_LIKE_THRESHOLD);
modeEngine.handleLike("m2", "Defender", null, JOIN_LIKE_THRESHOLD);
const attackerM = modeEngine.players.get("m1");
const defenderM = modeEngine.players.get("m2");

modeEngine.setConfig({ giftMode: { level: true, shots: false } });
modeEngine.handleGift("m1", "Attacker", null, 15);
console.assert(attackerM.attackLevel === 15, `Expected level-only mode to still raise attackLevel, got ${attackerM.attackLevel}`);
console.assert(modeEngine.activeBarrages.size === 0, "Expected level-only mode to fire NO barrage");

modeEngine.setConfig({ giftMode: { level: false, shots: true } });
const defenderScoreBefore = defenderM.roundScore;
modeEngine.handleGift("m1", "Attacker", null, 5);
console.assert(attackerM.attackLevel === 15, `Expected shots-only mode to leave attackLevel unchanged, got ${attackerM.attackLevel}`);
console.assert(defenderM.roundScore === defenderScoreBefore - 5, `Expected the shots-only barrage's first shot to still deal damage, got ${defenderM.roundScore}`);
modeEngine.stop(); // cancel the barrage this just started
console.log("14) giftMode gating -> level-only kept attackLevel-only, shots-only kept the barrage-only:", true);

// ---- 15. Collision damage scales with the attacker's attackLevel
// (BASE_COLLISION_DAMAGE + attackLevel), not a flat amount ----
const dmgEngine = new GameEngine(fakeIo);
dmgEngine.handleLike("d1", "Leveled", null, JOIN_LIKE_THRESHOLD);
dmgEngine.handleLike("d2", "Plain", null, JOIN_LIKE_THRESHOLD);
const leveled = dmgEngine.players.get("d1");
const plain = dmgEngine.players.get("d2");
leveled.attackLevel = 25; // +25 collision damage on top of the base
leveled.x = 0; leveled.y = 0; leveled.vx = 0; leveled.vy = 0;
plain.x = 1; plain.y = 0; plain.vx = 0; plain.vy = 0;
plain.roundScore = 1000; // enough cushion that the damage isn't clipped by the zero-floor
const plainScoreBefore = plain.roundScore;
dmgEngine.running = true;
dmgEngine.tick();
const expectedDmg = plainScoreBefore - plain.roundScore;
const expectedTotal = BASE_COLLISION_DAMAGE + 25;
console.assert(expectedDmg === expectedTotal, `Expected a leveled attacker (attackLevel 25) to deal ${expectedTotal} damage (${BASE_COLLISION_DAMAGE} base + 25), got ${expectedDmg}`);
console.log("15) attackLevel-scaled collision damage:", expectedDmg, `(expected ${expectedTotal})`);
dmgEngine.running = false;

// ---- 16. Gift barrage keeps firing over time (not just once), and
// stop()/resetPlayers() cancels it instead of leaving it running loose ----
async function testBarrage() {
  engine.handleLike("u6", "Target", null, JOIN_LIKE_THRESHOLD);
  const target = engine.players.get("u6");
  target.roundScore = 100000; // large cushion so the barrage can't finish them off mid-test
  engine.handleLike("u7", "Shooter", null, JOIN_LIKE_THRESHOLD);

  const scoreBeforeBarrage = target.roundScore;
  engine.handleGift("u7", "Shooter", null, 20); // first shot fires immediately (synchronous)
  console.assert(target.roundScore === scoreBeforeBarrage - 20, `Expected the first barrage shot to deal 20 damage immediately, got score ${target.roundScore}`);
  console.assert(engine.activeBarrages.size === 1, `Expected one active barrage interval to be tracked, got ${engine.activeBarrages.size}`);

  // At GIFT_SHOTS_PER_SECOND=3, waiting ~700ms should let a couple more
  // shots land beyond the first, proving this is a sustained barrage and
  // not a one-off attack.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const totalDamageSoFar = scoreBeforeBarrage - target.roundScore;
  console.assert(totalDamageSoFar >= 40, `Expected at least 2 more shots (>=40 extra damage) to have landed after ~700ms, got total damage ${totalDamageSoFar}`);
  console.log("16) gift barrage fires repeated shots -> total damage after ~700ms:", totalDamageSoFar);

  engine.stop();
  console.assert(engine.activeBarrages.size === 0, "Expected stop() to cancel any in-flight gift barrage");
  console.log("17) stop() cancels an in-flight gift barrage:", engine.activeBarrages.size === 0);

  console.log("\nALL CHECKS RAN (see any 'Assertion failed' lines above for failures)");
}

testBarrage();
