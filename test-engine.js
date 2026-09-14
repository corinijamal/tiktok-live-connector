const { GameEngine } = require("./server/gameEngine");

const fakeIo = { emit: () => {} }; // suppress broadcasts for the test
const engine = new GameEngine(fakeIo);

// Simulate two players joining
engine.ensurePlayer("u1", "Ali", "http://img/1.png");
engine.ensurePlayer("u2", "Sara", "http://img/2.png");

console.log("Initial players:", [...engine.players.keys()]);

// Simulate likes
engine.handleLike("u1", "Ali", null, 5);
engine.handleLike("u2", "Sara", null, 3);
console.log("After likes -> u1 score:", engine.players.get("u1").roundScore, "u2 score:", engine.players.get("u2").roundScore);

// Simulate gift boost
engine.handleGift("u1", "Ali", null, 50);
const p1 = engine.players.get("u1");
console.log("u1 boostAmount:", p1.boostAmount, "currentAttackDamage:", p1.currentAttackDamage);
console.assert(p1.currentAttackDamage === 51, "Expected boosted damage to be 51 (1 base + 50 boost)");

// Force a collision manually by placing them on top of each other
p1.x = 0; p1.y = 0; p1.vx = 0; p1.vy = 0;
const p2 = engine.players.get("u2");
p2.x = 1; p2.y = 0; p2.vx = 0; p2.vy = 0; // within collision range

engine.running = true; // tick() no-ops unless the engine is running
engine.tick();

console.log("After collision tick -> u1 score:", p1.roundScore, "u2 score:", p2.roundScore);
console.assert(p2.roundScore === Math.max(0, 3 - 51), "Expected u2 (Sara) to take 51 boosted damage from u1 (Ali), floored at 0");
console.assert(p1.roundScore === 5 - 1, "Expected u1 (Ali) to take 1 base damage from u2 (started at 5)");
engine.running = false;

// Test round lifecycle timers exist without crashing
engine.start();
console.log("Round running:", engine.running, "round number:", engine.roundNumber);
engine.stop();
console.log("Stopped cleanly.");

console.log("\nALL BASIC CHECKS PASSED (see asserts above for failures)");
