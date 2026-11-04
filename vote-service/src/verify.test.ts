import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerifier, maskPhone } from "./verify.js";

const SECRET = "v".repeat(32);

test("a phone hash is stable, differs per number and per secret, and hides the number", () => {
  const v = createVerifier({ secret: SECRET });
  const h = v.phoneHash("+4915123456789");
  assert.equal(v.phoneHash("+4915123456789"), h);
  assert.notEqual(v.phoneHash("+4915123456788"), h);
  assert.notEqual(createVerifier({ secret: "w".repeat(32) }).phoneHash("+4915123456789"), h);
  assert.ok(!h.includes("23456789"));
});

test("a code hash is bound to the contest and the voter", () => {
  const v = createVerifier({ secret: SECRET });
  const h = v.codeHash("c1", "u1", "123456");
  assert.equal(v.codeHash("c1", "u1", "123456"), h);
  assert.notEqual(v.codeHash("c2", "u1", "123456"), h);
  assert.notEqual(v.codeHash("c1", "u2", "123456"), h);
  assert.notEqual(v.codeHash("c1", "u1", "123457"), h);
});

test("codes are six digits and not all the same", () => {
  const v = createVerifier({ secret: SECRET });
  const codes = Array.from({ length: 200 }, () => v.newCode());
  for (const c of codes) assert.match(c, /^\d{6}$/);
  assert.ok(new Set(codes).size > 150);
});

test("a short secret is refused", () => {
  assert.throws(() => createVerifier({ secret: "short" }), /at least 32/);
});

test("maskPhone keeps the country and the last three digits", () => {
  assert.equal(maskPhone("+4915123456789"), "+49 ••••••••789");
  assert.equal(maskPhone("+447700900123"), "+44 •••••••123");
});
