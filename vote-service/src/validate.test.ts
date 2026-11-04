import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfirm, parsePhone, parseVote } from "./validate.js";

const PHONE = "0151 23456789";

const rejects = (input: unknown, fragment: string) => {
  const r = parseVote(input);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, new RegExp(fragment));
};

test("a valid body is accepted and typed", () => {
  const r = parseVote({ contestId: "best-pet", choice: "Cat", phone: PHONE });
  assert.deepEqual(r, {
    ok: true,
    value: { contestId: "best-pet", choice: "Cat", phone: "+4915123456789" },
  });
});

test("choices with spaces and non-ASCII letters are fine", () => {
  assert.equal(parseVote({ contestId: "c1", choice: "Zürich Option 2", phone: PHONE }).ok, true);
});

test("things that are not an object are rejected", () => {
  rejects("hello", "JSON object");
  rejects(42, "JSON object");
  rejects(null, "JSON object");
  rejects(undefined, "JSON object");
  rejects([], "JSON object");
  rejects([{ contestId: "c1", choice: "A" }], "JSON object");
});

test("a missing field is rejected", () => {
  rejects({ choice: "A" }, "contestId must be a string");
  rejects({ contestId: "c1" }, "choice must be a string");
});

test("wrong types are rejected", () => {
  rejects({ contestId: "c1", choice: 42 }, "choice must be a string");
  rejects({ contestId: 7, choice: "A" }, "contestId must be a string");
  rejects({ contestId: "c1", choice: { x: 1 } }, "choice must be a string");
});

test("empty and blank values are rejected", () => {
  rejects({ contestId: "", choice: "A" }, "contestId must be 1 to 64");
  rejects({ contestId: "c1", choice: "" }, "choice must be 1 to 64");
  rejects({ contestId: "c1", choice: "   " }, "choice must be 1 to 64");
});

test("over-long values are rejected, exactly 64 is allowed", () => {
  rejects({ contestId: "c".repeat(65), choice: "A" }, "contestId must be 1 to 64");
  rejects({ contestId: "c1", choice: "x".repeat(65) }, "choice must be 1 to 64");
  assert.equal(parseVote({ contestId: "c".repeat(64), choice: "x".repeat(64), phone: PHONE }).ok, true);
});

test("contestId is limited to letters, digits and hyphens", () => {
  rejects({ contestId: "c 1", choice: "A" }, "letters, digits");
  rejects({ contestId: "../etc", choice: "A" }, "letters, digits");
  rejects({ contestId: "c1'; --", choice: "A" }, "letters, digits");
});

test("control characters in a choice are rejected", () => {
  rejects({ contestId: "c1", choice: "A\u0000B" }, "control characters");
  rejects({ contestId: "c1", choice: "A\nB" }, "control characters");
});

test("unknown fields are rejected, including a spoofed voterId", () => {
  rejects({ contestId: "c1", choice: "A", voterId: "someone-else" }, "unknown field: voterId");
  rejects({ contestId: "c1", choise: "A" }, "unknown field: choise");
});

test("an __proto__ key does not sneak through", () => {
  const body = JSON.parse('{"contestId":"c1","choice":"A","__proto__":{"admin":true}}');
  rejects(body, "unknown field: __proto__");
});

// ---- phone ----

test("German mobile numbers in the usual spellings all become +49…", () => {
  for (const typed of ["0151 23456789", "01512 3456789", "+49 151 23456789", "0049 151 23456789",
    "+49 (0)151 23456789", "0151/23456789", "0151-234-567-89", "0170 1234567", "+49 176 12345678"]) {
    const r = parsePhone(typed);
    assert.ok(r.ok, typed);
    if (r.ok) assert.match(r.value, /^\+491[5-7]\d{8,9}$/, typed);
  }
  assert.deepEqual(parsePhone("0151 23456789"), { ok: true, value: "+4915123456789" });
});

test("UK mobile numbers in the usual spellings all become +44…", () => {
  for (const typed of ["07700 900123", "+44 7700 900123", "0044 7700 900123", "+44 (0)7700 900123", "07624 123456"]) {
    const r = parsePhone(typed);
    assert.ok(r.ok, typed);
  }
  assert.deepEqual(parsePhone("07700 900123"), { ok: true, value: "+447700900123" });
});

test("landlines, other countries and junk are refused", () => {
  const refused = (typed: string, fragment: string) => {
    const r = parsePhone(typed);
    assert.equal(r.ok, false, typed);
    if (!r.ok) assert.match(r.error, new RegExp(fragment), typed);
  };
  refused("0221 1234567", "German or UK mobile"); // Köln landline
  refused("020 7946 0958", "German or UK mobile"); // London landline
  refused("07012 345678", "German or UK mobile"); // UK 070: personal numbering, not a mobile
  refused("07623 123456", "German or UK mobile"); // UK 076 pager range
  refused("0151 234", "German or UK mobile"); // too short
  refused("0151 234567890123", "German or UK mobile"); // too long
  refused("+33 6 12 34 56 78", "only German \\(\\+49\\) and UK \\(\\+44\\)");
  refused("0151 2345678a", "may only contain");
  refused("", "German or UK mobile");
  refused("1".repeat(33), "too long");
});

test("a vote without a valid phone is rejected", () => {
  rejects({ contestId: "c1", choice: "A" }, "phone must be a string");
  rejects({ contestId: "c1", choice: "A", phone: 15123456789 }, "phone must be a string");
  rejects({ contestId: "c1", choice: "A", phone: "0221 1234567" }, "German or UK mobile");
});

// ---- confirm ----

test("a confirm body needs a contest and exactly six digits", () => {
  assert.deepEqual(parseConfirm({ contestId: "c1", code: "012345" }), {
    ok: true,
    value: { contestId: "c1", code: "012345" },
  });
  const no = (input: unknown, fragment: string) => {
    const r = parseConfirm(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, new RegExp(fragment));
  };
  no({ contestId: "c1", code: "12345" }, "6 digits");
  no({ contestId: "c1", code: "1234567" }, "6 digits");
  no({ contestId: "c1", code: "12 345" }, "6 digits");
  no({ contestId: "c1", code: 123456 }, "6 digits");
  no({ contestId: "c1", code: "١٢٣٤٥٦" }, "6 digits"); // Arabic-Indic digits are not \d
  no({ code: "123456" }, "contestId must be a string");
  no({ contestId: "c1", code: "123456", voterId: "x" }, "unknown field: voterId");
  no([], "JSON object");
});
