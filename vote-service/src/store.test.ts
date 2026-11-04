import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "./store.js";

// A store with one open contest "c1" (options A, B) and one more, "c2".
function seeded(path = ":memory:") {
  const s = openStore(path);
  s.createContest({ id: "c1", title: "Contest one", options: ["A", "B"] });
  s.createContest({ id: "c2", title: "Contest two", options: ["A", "B"] });
  return s;
}

// ---- votes ----

test("a first vote is accepted and counted", () => {
  const s = seeded();
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "A" }), { ok: true });
  assert.deepEqual(s.tally("c1"), [
    { choice: "A", votes: 1 },
    { choice: "B", votes: 0 },
  ]);
  s.close();
});

test("the same voter voting again in the same contest is a duplicate", () => {
  const s = seeded();
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "A" });
  // even if they try to switch their choice
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "B" }), {
    ok: false,
    reason: "duplicate",
  });
  assert.deepEqual(s.tally("c1"), [
    { choice: "A", votes: 1 },
    { choice: "B", votes: 0 },
  ]);
  s.close();
});

test("the same voter may vote in a different contest", () => {
  const s = seeded();
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "A" });
  assert.deepEqual(s.cast({ contestId: "c2", voterId: "u1", phoneHash: "p-u1", choice: "A" }), { ok: true });
  s.close();
});

test("a vote for a contest that does not exist is refused", () => {
  const s = seeded();
  assert.deepEqual(s.cast({ contestId: "nope", voterId: "u1", phoneHash: "p-u1", choice: "A" }), {
    ok: false,
    reason: "unknown_contest",
  });
  s.close();
});

test("a vote for an option the contest does not list is refused, and not counted", () => {
  const s = seeded();
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "Z" }), {
    ok: false,
    reason: "unknown_option",
  });
  // "a" is not "A": options match exactly
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "a" }), {
    ok: false,
    reason: "unknown_option",
  });
  assert.deepEqual(
    s.tally("c1").map((r) => r.votes),
    [0, 0],
  );
  s.close();
});

test("an option of one contest cannot be used in another", () => {
  const s = openStore(":memory:");
  s.createContest({ id: "pets", title: "Pets", options: ["Cat", "Dog"] });
  s.createContest({ id: "food", title: "Food", options: ["Pizza", "Pasta"] });
  assert.deepEqual(s.cast({ contestId: "pets", voterId: "u1", phoneHash: "p-u1", choice: "Pizza" }), {
    ok: false,
    reason: "unknown_option",
  });
  s.close();
});

test("a refused vote does not use up the voter's one vote", () => {
  const s = seeded();
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "Z" });
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "A" }), { ok: true });
  s.close();
});

test("SQL in a value is never run", () => {
  const s = seeded();
  const evil = "A'); DROP TABLE votes; --";
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: evil }), {
    ok: false,
    reason: "unknown_option",
  });
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "A" }), { ok: true });
  s.close();
});

test("the database itself refuses a vote for an unlisted option, even around our code", () => {
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  const file = join(dir, "votes.sqlite");
  const s = seeded(file);
  const raw = new DatabaseSync(file); // bypasses store.ts completely
  assert.throws(
    () => raw.prepare("INSERT INTO votes (contest_id, voter_id, phone_hash, choice) VALUES ('c1','u1','p-u1','Z')").run(),
    /FOREIGN KEY constraint failed/,
  );
  raw.close();
  s.close();
  rmSync(dir, { recursive: true });
});

test("the constraints hold across two separate connections to one file", () => {
  // Two connections stand in for two server processes. Neither can see the
  // other's in-memory state; only the database file is shared.
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  const file = join(dir, "votes.sqlite");
  const a = seeded(file);
  const b = openStore(file);
  const vote = { contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "A" };
  assert.deepEqual(a.cast(vote), { ok: true });
  assert.deepEqual(b.cast(vote), { ok: false, reason: "duplicate" });
  assert.deepEqual(a.tally("c1")[0], { choice: "A", votes: 1 });
  a.close();
  b.close();
  rmSync(dir, { recursive: true });
});

// ---- closing ----

test("a closed contest refuses votes but still shows its tally", () => {
  const s = seeded();
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "A" });
  assert.equal(s.closeContest("c1"), true);
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u2", phoneHash: "p-u2", choice: "A" }), {
    ok: false,
    reason: "closed",
  });
  assert.deepEqual(s.tally("c1")[0], { choice: "A", votes: 1 });
  assert.equal(s.getContest("c1")?.status, "closed");
  s.close();
});

test("closing twice, or closing an unknown contest, returns false", () => {
  const s = seeded();
  assert.equal(s.closeContest("c1"), true);
  assert.equal(s.closeContest("c1"), false);
  assert.equal(s.closeContest("nope"), false);
  s.close();
});

// ---- tally ----

test("tally counts per option, in the contest's own order, for the asked contest only", () => {
  const s = openStore(":memory:");
  s.createContest({ id: "c1", title: "T", options: ["Zebra", "Apple"] });
  s.createContest({ id: "c2", title: "T", options: ["Zebra", "Apple"] });
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "Apple" });
  s.cast({ contestId: "c1", voterId: "u2", phoneHash: "p-u2", choice: "Apple" });
  s.cast({ contestId: "c1", voterId: "u3", phoneHash: "p-u3", choice: "Zebra" });
  s.cast({ contestId: "c2", voterId: "u1", phoneHash: "p-u1", choice: "Zebra" });
  assert.deepEqual(s.tally("c1"), [
    { choice: "Zebra", votes: 1 },
    { choice: "Apple", votes: 2 },
  ]);
  s.close();
});

test("tally of an unknown contest is empty", () => {
  const s = seeded();
  assert.deepEqual(s.tally("nope"), []);
  s.close();
});

// ---- creating contests ----

test("createContest stores the contest and getContest returns it with ordered options", () => {
  const s = openStore(":memory:");
  assert.deepEqual(s.createContest({ id: "pets", title: "Best pet", options: ["Cat", "Dog", "Fish"] }), {
    ok: true,
  });
  assert.deepEqual(s.getContest("pets"), {
    id: "pets",
    title: "Best pet",
    status: "open",
    options: ["Cat", "Dog", "Fish"],
  });
  assert.equal(s.getContest("nope"), null);
  s.close();
});

test("createContest refuses bad input and stores nothing", () => {
  const s = openStore(":memory:");
  const bad = (input: Parameters<typeof s.createContest>[0], fragment: string) => {
    const r = s.createContest(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, new RegExp(fragment));
    assert.equal(s.getContest(input.id), null);
  };
  bad({ id: "has space", title: "T", options: ["A", "B"] }, "letters, digits");
  bad({ id: "c1", title: "", options: ["A", "B"] }, "title");
  bad({ id: "c1", title: "T", options: ["A"] }, "at least 2");
  bad({ id: "c1", title: "T", options: [] }, "at least 2");
  bad({ id: "c1", title: "T", options: ["A", "A"] }, "unique");
  bad({ id: "c1", title: "T", options: ["A", "  "] }, "option must be 1 to 64");
  s.close();
});

test("creating a contest with an existing id is refused and leaves the original alone", () => {
  const s = seeded();
  const r = s.createContest({ id: "c1", title: "Other", options: ["X", "Y"] });
  assert.deepEqual(r, { ok: false, reason: "a contest with this id already exists" });
  assert.deepEqual(s.getContest("c1")?.options, ["A", "B"]);
  s.close();
});

test("a refused contest leaves the store usable for the next one", () => {
  const s = seeded();
  assert.equal(s.createContest({ id: "c1", title: "Again", options: ["X", "Y"] }).ok, false);
  assert.deepEqual(s.createContest({ id: "c3", title: "Three", options: ["X", "Y"] }), { ok: true });
  assert.equal(s.getContest("c3")?.title, "Three");
  s.close();
});

test("a title may be 200 characters; 201 characters or only spaces is refused", () => {
  const s = openStore(":memory:");
  const make = (id: string, title: string) => s.createContest({ id, title, options: ["A", "B"] });
  assert.deepEqual(make("t200", "x".repeat(200)), { ok: true });
  assert.equal(make("t201", "x".repeat(201)).ok, false);
  assert.equal(make("tspace", "   ").ok, false);
  assert.equal(s.getContest("t201"), null);
  assert.equal(s.getContest("tspace"), null);
  s.close();
});

test("the database itself refuses a contest status other than open or closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  const file = join(dir, "votes.sqlite");
  const s = seeded(file);
  const raw = new DatabaseSync(file); // bypasses store.ts completely
  assert.throws(
    () => raw.prepare("UPDATE contests SET status = 'archived' WHERE id = 'c1'").run(),
    /CHECK constraint failed/,
  );
  raw.close();
  s.close();
  rmSync(dir, { recursive: true });
});

test("getVote returns what a voter chose, or null", () => {
  const s = seeded();
  assert.equal(s.getVote("c1", "u1"), null);
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p-u1", choice: "B" });
  assert.equal(s.getVote("c1", "u1"), "B");
  assert.equal(s.getVote("c1", "u2"), null, "another voter");
  assert.equal(s.getVote("c2", "u1"), null, "another contest");
  s.close();
});

// ---- one vote per phone number ----

test("one number, two voters: the second vote is refused as phone_used", () => {
  const s = seeded();
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p1", choice: "A" }), { ok: true });
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u2", phoneHash: "p1", choice: "B" }), {
    ok: false,
    reason: "phone_used",
  });
  assert.deepEqual(s.cast({ contestId: "c2", voterId: "u2", phoneHash: "p1", choice: "B" }), { ok: true });
  s.close();
});

test("the database itself refuses a second vote from one number, even around our code", () => {
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  const file = join(dir, "votes.sqlite");
  const s = seeded(file);
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p1", choice: "A" });
  const raw = new DatabaseSync(file); // bypasses store.ts completely
  assert.throws(
    () => raw.prepare("INSERT INTO votes (contest_id, voter_id, phone_hash, choice) VALUES ('c1','u2','p1','B')").run(),
    /UNIQUE constraint failed: votes.contest_id, votes.phone_hash/,
  );
  raw.close();
  s.close();
  rmSync(dir, { recursive: true });
});

test("a database from before the SMS step is refused at start", () => {
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  const file = join(dir, "votes.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE votes (id INTEGER PRIMARY KEY, contest_id TEXT, voter_id TEXT, choice TEXT)");
  old.close();
  assert.throws(() => openStore(file), /before the SMS step/);
  rmSync(dir, { recursive: true });
});

// ---- pending votes ----

const NOW = 1_700_000_000_000;
const pending = (over: Partial<Parameters<ReturnType<typeof openStore>["startVote"]>[0]> = {}) => ({
  contestId: "c1",
  voterId: "u1",
  phoneHash: "p1",
  choice: "A",
  codeHash: "h-right",
  expiresAt: NOW + 600_000,
  ...over,
});

test("a pending vote is not counted until its code is confirmed", () => {
  const s = seeded();
  assert.deepEqual(s.startVote(pending(), NOW), { ok: true });
  assert.deepEqual(s.tally("c1").map((r) => r.votes), [0, 0]);
  assert.equal(s.getVote("c1", "u1"), null);
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: true });
  assert.deepEqual(s.tally("c1").map((r) => r.votes), [1, 0]);
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: false, reason: "no_pending" }, "spent");
  s.close();
});

test("the same voter with another number is still a duplicate", () => {
  const s = seeded();
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p1", choice: "A" });
  assert.deepEqual(s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p2", choice: "B" }), {
    ok: false,
    reason: "duplicate",
  });
  s.close();
});

test("startVote refuses what could never be confirmed", () => {
  const s = seeded();
  // p1 voted through u2 first, then u1 voted with p8: both rows match pending()
  s.cast({ contestId: "c1", voterId: "u2", phoneHash: "p1", choice: "A" });
  s.cast({ contestId: "c1", voterId: "u1", phoneHash: "p8", choice: "A" });
  s.createContest({ id: "shut", title: "Shut", options: ["A", "B"] });
  s.closeContest("shut");
  const refused = (p: ReturnType<typeof pending>, reason: string) =>
    assert.deepEqual(s.startVote(p, NOW), { ok: false, reason });
  refused(pending({ contestId: "nope" }), "unknown_contest");
  refused(pending({ contestId: "shut" }), "closed");
  refused(pending({ voterId: "u9", phoneHash: "p9", choice: "Z" }), "unknown_option");
  refused(pending({ phoneHash: "p9" }), "duplicate"); // this voter has voted
  refused(pending({ voterId: "u9" }), "phone_used"); // this number has voted
  refused(pending(), "duplicate"); // both: "you already voted" wins
  s.close();
});

test("a wrong code counts an attempt; the fifth ends the pending vote", () => {
  const s = seeded();
  s.startVote(pending(), NOW);
  for (const left of [4, 3, 2, 1]) {
    assert.deepEqual(s.confirmVote("c1", "u1", "h-wrong", NOW), { ok: false, reason: "wrong_code", attemptsLeft: left });
  }
  assert.deepEqual(s.confirmVote("c1", "u1", "h-wrong", NOW), { ok: false, reason: "locked" });
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: false, reason: "no_pending" });
  s.close();
});

test("a new code resets the attempts and replaces the choice", () => {
  const s = seeded();
  s.startVote(pending(), NOW);
  for (let i = 0; i < 4; i++) s.confirmVote("c1", "u1", "h-wrong", NOW);
  s.startVote(pending({ choice: "B", codeHash: "h-new" }), NOW);
  assert.deepEqual(s.confirmVote("c1", "u1", "h-wrong", NOW), { ok: false, reason: "wrong_code", attemptsLeft: 4 });
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: false, reason: "wrong_code", attemptsLeft: 3 });
  assert.deepEqual(s.confirmVote("c1", "u1", "h-new", NOW), { ok: true });
  assert.equal(s.getVote("c1", "u1"), "B");
  s.close();
});

test("an expired code is refused and its pending vote removed", () => {
  const s = seeded();
  s.startVote(pending({ expiresAt: NOW + 1000 }), NOW);
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW + 1000), { ok: false, reason: "expired" });
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: false, reason: "no_pending" });
  s.close();
});

test("pending votes are per voter and per contest", () => {
  const s = seeded();
  s.startVote(pending(), NOW);
  assert.deepEqual(s.confirmVote("c2", "u1", "h-right", NOW), { ok: false, reason: "no_pending" });
  assert.deepEqual(s.confirmVote("c1", "u2", "h-right", NOW), { ok: false, reason: "no_pending" });
  s.close();
});

test("a confirm after the contest closed is refused, and the code is spent", () => {
  const s = seeded();
  s.startVote(pending(), NOW);
  s.closeContest("c1");
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: false, reason: "closed" });
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: false, reason: "no_pending" });
  s.close();
});

test("dropPending forgets a pending vote", () => {
  const s = seeded();
  s.startVote(pending(), NOW);
  s.dropPending("c1", "u1");
  assert.deepEqual(s.confirmVote("c1", "u1", "h-right", NOW), { ok: false, reason: "no_pending" });
  s.close();
});

test("abandoned codes are swept when the next vote starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  const file = join(dir, "votes.sqlite");
  const s = seeded(file);
  s.startVote(pending({ expiresAt: NOW + 1000 }), NOW);
  s.startVote(pending({ voterId: "u2", phoneHash: "p2", expiresAt: NOW + 5000 }), NOW + 2000);
  const raw = new DatabaseSync(file);
  const left = raw.prepare("SELECT voter_id FROM pending_votes").all().map((r) => r.voter_id);
  raw.close();
  assert.deepEqual(left, ["u2"]);
  s.close();
  rmSync(dir, { recursive: true });
});

test("the database refuses a pending vote for an unlisted option, even around our code", () => {
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  const file = join(dir, "votes.sqlite");
  const s = seeded(file);
  const raw = new DatabaseSync(file);
  assert.throws(
    () =>
      raw
        .prepare(
          "INSERT INTO pending_votes (contest_id, voter_id, phone_hash, choice, code_hash, expires_at) VALUES ('c1','u1','p1','Z','h',1)",
        )
        .run(),
    /FOREIGN KEY constraint failed/,
  );
  raw.close();
  s.close();
  rmSync(dir, { recursive: true });
});
