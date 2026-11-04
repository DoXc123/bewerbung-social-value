import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "./ratelimit.js";

function limiter(max: number, windowMs: number) {
  let t = 1_000;
  const l = createRateLimiter({ max, windowMs, now: () => t });
  return { l, advance: (ms: number) => (t += ms) };
}

test("allows up to max in a window, then refuses", () => {
  const { l } = limiter(3, 1000);
  assert.deepEqual([l.take("a"), l.take("a"), l.take("a"), l.take("a")], [true, true, true, false]);
});

test("keys are independent", () => {
  const { l } = limiter(1, 1000);
  assert.equal(l.take("a"), true);
  assert.equal(l.take("a"), false);
  assert.equal(l.take("b"), true);
});

test("the window resets after windowMs", () => {
  const { l, advance } = limiter(1, 1000);
  assert.equal(l.take("a"), true);
  assert.equal(l.take("a"), false);
  advance(999);
  assert.equal(l.take("a"), false);
  advance(1);
  assert.equal(l.take("a"), true);
});

test("refused calls do not extend the window", () => {
  const { l, advance } = limiter(1, 1000);
  l.take("a");
  advance(500);
  l.take("a"); // refused
  advance(500);
  assert.equal(l.take("a"), true);
});

test("retryAfterSeconds reports the time left, at least 1", () => {
  const { l, advance } = limiter(1, 10_000);
  assert.equal(l.retryAfterSeconds("a"), 0); // never seen
  l.take("a");
  assert.equal(l.retryAfterSeconds("a"), 10);
  advance(9_900);
  assert.equal(l.retryAfterSeconds("a"), 1);
});
