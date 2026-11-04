import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { choiceProblem, contestIdProblem } from "./validate.js";
import { MAX_CODE_ATTEMPTS } from "./verify.js";

// phoneHash is the keyed hash of the verified number (verify.ts), never the number.
export type Vote = { contestId: string; voterId: string; phoneHash: string; choice: string };
type Refusal = "unknown_contest" | "closed" | "unknown_option" | "duplicate" | "phone_used";
export type CastResult = { ok: true } | { ok: false; reason: Refusal };
// A vote waiting for its SMS code. expiresAt is in milliseconds (Date.now()).
export type PendingVote = Vote & { codeHash: string; expiresAt: number };
export type StartResult = CastResult;
export type ConfirmResult =
  | { ok: true }
  | { ok: false; reason: Refusal | "no_pending" | "expired" | "locked" }
  | { ok: false; reason: "wrong_code"; attemptsLeft: number };
export type TallyRow = { choice: string; votes: number };
export type Contest = {
  id: string;
  title: string;
  status: "open" | "closed";
  options: string[];
};
export type NewContest = { id: string; title: string; options: string[] };
export type CreateResult = { ok: true } | { ok: false; reason: string };

// SQLite's extended result codes.
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const errcode = (e: unknown) => (e as { errcode?: number }).errcode;

// Compares two hashes in constant time, so the response time can't leak how
// much of a guessed code's hash was right.
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function openStore(path: string) {
  const db = new DatabaseSync(path); // foreign keys are enforced by default

  // The rules live HERE, in the schema, so no application bug can break them:
  //  - a vote must be for an option that exists in that contest (FOREIGN KEY)
  //  - one vote per voter per contest (UNIQUE)
  //  - one vote per phone number per contest (UNIQUE), whatever cookie it came with
  db.exec(`
    CREATE TABLE IF NOT EXISTS contests (
      id     TEXT PRIMARY KEY,
      title  TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
    );
    CREATE TABLE IF NOT EXISTS options (
      contest_id TEXT NOT NULL REFERENCES contests (id),
      label      TEXT NOT NULL,
      position   INTEGER NOT NULL,
      PRIMARY KEY (contest_id, label)
    );
    -- feature:one-vote
    CREATE TABLE IF NOT EXISTS votes (
      id         INTEGER PRIMARY KEY,
      contest_id TEXT NOT NULL,
      voter_id   TEXT NOT NULL,
      phone_hash TEXT NOT NULL,
      choice     TEXT NOT NULL,
      cast_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (contest_id, voter_id),
      UNIQUE (contest_id, phone_hash),
      FOREIGN KEY (contest_id, choice) REFERENCES options (contest_id, label)
    );
    -- end feature
    -- A vote that waits for its SMS code: at most one per voter per contest.
    -- Asking for a new code replaces it. It only becomes a row in votes once
    -- the code is confirmed, so an unconfirmed vote is never counted.
    CREATE TABLE IF NOT EXISTS pending_votes (
      contest_id TEXT NOT NULL,
      voter_id   TEXT NOT NULL,
      phone_hash TEXT NOT NULL,
      choice     TEXT NOT NULL,
      code_hash  TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (contest_id, voter_id),
      FOREIGN KEY (contest_id, choice) REFERENCES options (contest_id, label)
    );
  `);
  // CREATE TABLE IF NOT EXISTS keeps an older votes table as it was. Without
  // phone_hash it would lack the phone rule, so refuse to start on it.
  const voteColumns = db.prepare("SELECT name FROM pragma_table_info('votes')").all();
  if (!voteColumns.some((c) => c.name === "phone_hash")) {
    db.close();
    throw new Error(`${path} was made before the SMS step (no votes.phone_hash); move it away and seed again`);
  }

  // Prepared statements: the ? marks are filled in separately from the SQL
  // text, so a value can never be read as SQL (no injection).
  const insertContest = db.prepare("INSERT INTO contests (id, title) VALUES (?, ?)");
  const insertOption = db.prepare(
    "INSERT INTO options (contest_id, label, position) VALUES (?, ?, ?)",
  );
  const selectContest = db.prepare("SELECT id, title, status FROM contests WHERE id = ?");
  const selectOptions = db.prepare(
    "SELECT label FROM options WHERE contest_id = ? ORDER BY position",
  );
  const markClosed = db.prepare(
    "UPDATE contests SET status = 'closed' WHERE id = ? AND status = 'open'",
  );
  const selectVote = db.prepare(
    "SELECT choice FROM votes WHERE contest_id = ? AND voter_id = ?",
  );
  const insertVote = db.prepare(
    "INSERT INTO votes (contest_id, voter_id, phone_hash, choice) VALUES (?, ?, ?, ?)",
  );
  // Has this voter, or this number, already voted here? Answers before an SMS
  // is sent; the UNIQUE rules above are what actually hold. One row always:
  // n = 0 means neither; MAX picks "this voter" over "this number" when both
  // match, whatever order the rows come in.
  const selectVoted = db.prepare(`
    SELECT COUNT(*) AS n, MAX(voter_id = ?) AS same_voter FROM votes
    WHERE contest_id = ? AND (voter_id = ? OR phone_hash = ?)
  `);
  const upsertPending = db.prepare(`
    INSERT INTO pending_votes (contest_id, voter_id, phone_hash, choice, code_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (contest_id, voter_id) DO UPDATE SET
      phone_hash = excluded.phone_hash, choice = excluded.choice,
      code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at
  `);
  const selectPending = db.prepare(
    "SELECT phone_hash, choice, code_hash, attempts, expires_at FROM pending_votes WHERE contest_id = ? AND voter_id = ?",
  );
  const bumpAttempts = db.prepare(
    "UPDATE pending_votes SET attempts = attempts + 1 WHERE contest_id = ? AND voter_id = ?",
  );
  const deletePending = db.prepare("DELETE FROM pending_votes WHERE contest_id = ? AND voter_id = ?");
  const deleteExpired = db.prepare("DELETE FROM pending_votes WHERE expires_at <= ?");
  // LEFT JOIN from options, so an option nobody picked still shows with 0.
  const tally = db.prepare(`
    SELECT o.label AS choice, COUNT(v.id) AS votes
    FROM options o
    LEFT JOIN votes v ON v.contest_id = o.contest_id AND v.choice = o.label
    WHERE o.contest_id = ?
    GROUP BY o.label
    ORDER BY o.position
  `);

  function cast(vote: Vote): CastResult {
    const contest = getContest(vote.contestId);
    if (!contest) return { ok: false, reason: "unknown_contest" };
    if (contest.status === "closed") return { ok: false, reason: "closed" };
    try {
      insertVote.run(vote.contestId, vote.voterId, vote.phoneHash, vote.choice);
      return { ok: true };
    } catch (e) {
      // Both UNIQUE rules share one error code, and when both break SQLite may
      // name either. "You already voted" is the truer answer when it applies.
      if (errcode(e) === SQLITE_CONSTRAINT_UNIQUE) {
        const voterHasVoted = selectVote.get(vote.contestId, vote.voterId) !== undefined;
        return { ok: false, reason: voterHasVoted ? "duplicate" : "phone_used" };
      }
      if (errcode(e) === SQLITE_CONSTRAINT_FOREIGNKEY) {
        return { ok: false, reason: "unknown_option" };
      }
      throw e; // anything else is a real fault, not a rejected vote
    }
  }

  function confirmInTransaction(
    contestId: string,
    voterId: string,
    codeHash: string,
    now: number,
  ): ConfirmResult {
    const row = selectPending.get(contestId, voterId);
    if (!row) return { ok: false, reason: "no_pending" };
    if (Number(row.expires_at) <= now) {
      deletePending.run(contestId, voterId);
      return { ok: false, reason: "expired" };
    }
    if (!sameHash(String(row.code_hash), codeHash)) {
      const used = Number(row.attempts) + 1;
      if (used >= MAX_CODE_ATTEMPTS) {
        deletePending.run(contestId, voterId);
        return { ok: false, reason: "locked" };
      }
      bumpAttempts.run(contestId, voterId);
      return { ok: false, reason: "wrong_code", attemptsLeft: MAX_CODE_ATTEMPTS - used };
    }
    // The code is spent whatever happens next: a vote refused now (contest
    // closed meanwhile, number used from another browser) needs a fresh start.
    deletePending.run(contestId, voterId);
    return cast({ contestId, voterId, phoneHash: String(row.phone_hash), choice: String(row.choice) });
  }

  function getContest(id: string): Contest | null {
    const row = selectContest.get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      title: String(row.title),
      status: row.status === "closed" ? "closed" : "open",
      options: selectOptions.all(id).map((o) => String(o.label)),
    };
  }

  return {
    // Contests are made by the owner (trusted code), not by public requests.
    createContest(input: NewContest): CreateResult {
      const idError = contestIdProblem(input.id);
      if (idError) return { ok: false, reason: idError };
      if (input.title.trim().length === 0 || input.title.length > 200) {
        return { ok: false, reason: "title must be 1 to 200 characters" };
      }
      if (input.options.length < 2) {
        return { ok: false, reason: "a contest needs at least 2 options" };
      }
      for (const option of input.options) {
        const problem = choiceProblem(option);
        if (problem) return { ok: false, reason: problem.replace("choice", "option") };
      }
      if (new Set(input.options).size !== input.options.length) {
        return { ok: false, reason: "options must be unique" };
      }

      // One transaction: the contest and all its options exist together or not at all.
      db.exec("BEGIN");
      try {
        insertContest.run(input.id, input.title);
        input.options.forEach((label, i) => insertOption.run(input.id, label, i));
        db.exec("COMMIT");
        return { ok: true };
      } catch (e) {
        db.exec("ROLLBACK");
        if (errcode(e) === SQLITE_CONSTRAINT_PRIMARYKEY) {
          return { ok: false, reason: "a contest with this id already exists" };
        }
        throw e;
      }
    },

    getContest,

    // Returns false if the contest doesn't exist or was already closed.
    closeContest(contestId: string): boolean {
      return Number(markClosed.run(contestId).changes) === 1;
    },

    cast,

    // Step 1 of a vote: record it as pending, with the hash of the code that is
    // about to be sent. Refuses up front what could never be confirmed, so no
    // SMS is sent (and paid for) for it.
    startVote(p: PendingVote, now: number): StartResult {
      deleteExpired.run(now); // abandoned codes don't pile up
      const contest = getContest(p.contestId);
      if (!contest) return { ok: false, reason: "unknown_contest" };
      if (contest.status === "closed") return { ok: false, reason: "closed" };
      const voted = selectVoted.get(p.voterId, p.contestId, p.voterId, p.phoneHash)!;
      if (Number(voted.n) > 0) return { ok: false, reason: voted.same_voter ? "duplicate" : "phone_used" };
      try {
        upsertPending.run(p.contestId, p.voterId, p.phoneHash, p.choice, p.codeHash, p.expiresAt);
        return { ok: true };
      } catch (e) {
        if (errcode(e) === SQLITE_CONSTRAINT_FOREIGNKEY) {
          return { ok: false, reason: "unknown_option" };
        }
        throw e;
      }
    },

    // Forget a pending vote, e.g. when its SMS could not be sent.
    dropPending(contestId: string, voterId: string): void {
      deletePending.run(contestId, voterId);
    },

    // Step 2: the voter sends the code back. A right code turns the pending vote
    // into a counted one; a wrong one uses up an attempt; the last wrong attempt,
    // or an expired code, deletes it. One transaction, so two confirms at once
    // can't both use the same attempt.
    confirmVote(contestId: string, voterId: string, codeHash: string, now: number): ConfirmResult {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = confirmInTransaction(contestId, voterId, codeHash, now);
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    // What this voter chose in this contest, or null if they haven't voted.
    getVote(contestId: string, voterId: string): string | null {
      const row = selectVote.get(contestId, voterId);
      return row ? String(row.choice) : null;
    },

    tally(contestId: string): TallyRow[] {
      // node:sqlite rows have no prototype; hand callers plain objects.
      return tally.all(contestId).map((r) => ({
        choice: String(r.choice),
        votes: Number(r.votes),
      }));
    },

    close(): void {
      db.close();
    },
  };
}
