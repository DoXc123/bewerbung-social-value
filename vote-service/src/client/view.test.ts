import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barPercent,
  cleanCode,
  codeLead,
  demoNote,
  parseCodeSent,
  parseContest,
  parseTheme,
  parseSettings,
  parseSnippets,
  perWindow,
  FEATURES,
  refusal,
  screenFor,
  STRINGS,
  totalVotes,
} from "./view.js";
import { FEATURE_IDS } from "../snippets.js";

const good = {
  id: "chance",
  title: "T",
  status: "open",
  options: ["A", "B"],
  tally: [
    { choice: "A", votes: 3 },
    { choice: "B", votes: 1 },
  ],
  yourVote: null,
};

test("parseContest accepts what the server sends", () => {
  assert.deepEqual(parseContest(good), { ...good, smsDemo: false });
  assert.equal(parseContest({ ...good, smsDemo: true })?.smsDemo, true);
  assert.equal(parseContest({ ...good, yourVote: "A", status: "closed" })?.yourVote, "A");
});

test("parseContest refuses anything that is not that shape", () => {
  for (const bad of [
    null,
    "x",
    [],
    {},
    { ...good, id: 1 },
    { ...good, title: undefined },
    { ...good, status: "paused" },
    { ...good, options: "A" },
    { ...good, options: ["A", 2] },
    { ...good, tally: "no" },
    { ...good, tally: [{ choice: "A", votes: "3" }] },
    { ...good, tally: [null] },
    { ...good, yourVote: 5 },
    { ...good, yourVote: undefined },
    { ...good, smsDemo: "yes" },
  ]) {
    assert.equal(parseContest(bad), null, JSON.stringify(bad));
  }
});

test("parseTheme keeps the three choices and turns anything else into auto", () => {
  for (const t of ["auto", "light", "dark"]) assert.equal(parseTheme(t), t);
  for (const bad of [null, undefined, "", "Dark", "blue", 1]) assert.equal(parseTheme(bad), "auto", String(bad));
});

const settings = {
  smsMode: "demo",
  code: { digits: 6, validMinutes: 10, maxAttempts: 5 },
  limits: {
    votesPerAddress: { max: 30, windowMs: 60_000 },
    newVotersPerAddress: { max: 20, windowMs: 3_600_000 },
    codesPerNumber: { max: 3, windowMs: 3_600_000 },
  },
  trustProxy: false,
};

test("parseSettings accepts what GET /settings sends and refuses anything else", () => {
  assert.deepEqual(parseSettings(settings), settings);
  for (const bad of [
    null,
    { ...settings, smsMode: "sms" },
    { ...settings, code: { ...settings.code, digits: 0 } },
    { ...settings, limits: { ...settings.limits, codesPerNumber: { max: "3", windowMs: 1 } } },
    { ...settings, limits: null },
    { ...settings, trustProxy: "no" },
  ]) {
    assert.equal(parseSettings(bad), null, JSON.stringify(bad));
  }
});

test("parseSnippets keeps file, line and code, and refuses a malformed entry", () => {
  const good = { csp: [{ file: "server.ts", line: 51, code: "const PAGE_CSP = …" }] };
  assert.deepEqual(parseSnippets(good), good);
  for (const bad of [null, [], { csp: "x" }, { csp: [{ file: "a", line: 0, code: "" }] }, { csp: [{ file: 1, line: 1, code: "" }] }]) {
    assert.equal(parseSnippets(bad), null, JSON.stringify(bad));
  }
});

test("perWindow says a limit the way a person would", () => {
  assert.equal(perWindow({ max: 30, windowMs: 60_000 }), "30 per minute");
  assert.equal(perWindow({ max: 3, windowMs: 3_600_000 }), "3 per hour");
  assert.equal(perWindow({ max: 2, windowMs: 7_200_000 }), "2 per 2 hours");
  assert.equal(perWindow({ max: 5, windowMs: 90_000 }), "5 per 90 seconds");
});

test("every marked feature has a section on the page, and every section has its code", () => {
  assert.deepEqual(FEATURES.map((f) => f.id), [...FEATURE_IDS]);
  const s = parseSettings(settings)!;
  const code = FEATURES.find((f) => f.id === "code-rules")!.setting!(s);
  assert.equal(code, "6 digits · valid 10 minutes · 5 tries");
  const limits = FEATURES.find((f) => f.id === "rate-limits")!.setting!(s);
  assert.match(limits, /votes: 30 per minute per address/);
  assert.match(limits, /read from the connection/);
});

test("totalVotes and barPercent", () => {
  assert.equal(totalVotes(good.tally), 4);
  assert.equal(totalVotes([]), 0);
  assert.equal(barPercent(3, 4), 75);
  assert.equal(barPercent(1, 3), 33);
  assert.equal(barPercent(0, 0), 0, "no votes: no division by zero");
  assert.equal(barPercent(5, 5), 100);
});

test("screenFor offers buttons only to an open contest and a voter who hasn't voted", () => {
  const c = parseContest(good)!;
  assert.deepEqual(screenFor(c), { canVote: true, notice: null });
  assert.deepEqual(screenFor({ ...c, yourVote: "A" }), { canVote: false, notice: STRINGS.voted });
  assert.deepEqual(screenFor({ ...c, status: "closed" }), { canVote: false, notice: STRINGS.closed });
  // a voter who voted in a contest that has since closed still sees their vote
  assert.equal(screenFor({ ...c, status: "closed", yourVote: "A" }).notice, STRINGS.voted);
});

// ---- the SMS step ----

const sent = { status: "code_sent", sentTo: "+49 ••••••••789", expiresInSeconds: 600 };

test("parseCodeSent accepts the 202 answer, with or without a demo code", () => {
  assert.deepEqual(parseCodeSent(sent), { sentTo: "+49 ••••••••789", expiresInSeconds: 600, demoCode: null });
  assert.equal(parseCodeSent({ ...sent, demoCode: "042042" })?.demoCode, "042042");
  for (const bad of [
    null,
    {},
    { ...sent, status: "ok" },
    { ...sent, sentTo: 5 },
    { ...sent, expiresInSeconds: "600" },
    { ...sent, expiresInSeconds: 0 },
    { ...sent, demoCode: 42042 },
    { ...sent, demoCode: "<b>1</b>" },
  ]) {
    assert.equal(parseCodeSent(bad), null, JSON.stringify(bad));
  }
});

test("the code sentences say where it went, for how long, and the demo code", () => {
  assert.equal(
    codeLead({ sentTo: "+44 •••••••123", expiresInSeconds: 600, demoCode: null }),
    "We sent a 6-digit code to +44 •••••••123. It is valid for 10 minutes.",
  );
  assert.equal(demoNote("042042"), "Demo: no SMS was sent. Your code is 042042.");
});

test("cleanCode takes six digits, with spaces, and nothing else", () => {
  assert.equal(cleanCode("042042"), "042042");
  assert.equal(cleanCode(" 042 042 "), "042042");
  for (const bad of ["", "12345", "1234567", "12345a", "١٢٣٤٥٦"]) assert.equal(cleanCode(bad), null, bad);
});

test("every refusal has a sentence and a next step", () => {
  const r = (step: "start" | "confirm", status: number, body: unknown = {}) => refusal(step, status, body);
  assert.deepEqual(r("confirm", 400, { reason: "wrong_code", attemptsLeft: 3 }), { text: "Wrong code. 3 tries left.", next: "stay" });
  assert.equal(r("confirm", 400, { reason: "wrong_code", attemptsLeft: 1 }).text, "Wrong code. 1 try left.");
  assert.deepEqual(r("confirm", 410, { reason: "expired" }), { text: STRINGS.expired, next: "phone" });
  assert.deepEqual(r("confirm", 410, { reason: "locked" }), { text: STRINGS.locked, next: "phone" });
  assert.deepEqual(r("confirm", 404, { reason: "no_pending" }), { text: STRINGS.noPending, next: "reload" });
  assert.deepEqual(r("start", 409, { reason: "phone_used" }), { text: STRINGS.phoneUsed, next: "phone" });
  assert.deepEqual(r("start", 409, { reason: "duplicate" }), { text: STRINGS.alreadyVoted, next: "reload" });
  assert.deepEqual(r("confirm", 409, { reason: "closed" }), { text: STRINGS.closed, next: "reload" });
  assert.deepEqual(r("start", 404, { reason: "unknown_contest" }), { text: STRINGS.notFound, next: "reload" });
  assert.deepEqual(r("start", 400, { reason: "unknown_option" }), { text: STRINGS.badChoice, next: "reload" });
  assert.deepEqual(r("start", 429, { reason: "too_many_codes" }), { text: STRINGS.tooManyCodes, next: "stay" });
  // no reason: the status code decides
  assert.equal(r("start", 400).text, STRINGS.badPhone);
  assert.equal(r("confirm", 400).text, STRINGS.badCode);
  assert.equal(r("start", 429).text, STRINGS.tooMany);
  assert.equal(r("start", 502).text, STRINGS.smsFailed);
  assert.equal(r("start", 500, null).text, STRINGS.failed);
  assert.equal(r("start", 415, "not json").text, STRINGS.failed);
});
