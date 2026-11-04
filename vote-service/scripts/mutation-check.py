#!/usr/bin/env python3
"""Mutation check for vote-service: break one rule at a time, expect a test to fail.

    cd vote-service && npm ci
    python3 scripts/mutation-check.py            # all mutants
    python3 scripts/mutation-check.py S06 C09    # only these

Each mutant is one textual edit to src/store.ts or src/contests-file.ts. For each one
the script runs `npm test`, records what caught it, and puts the file back. A mutant
that SURVIVES means a rule has no test. Standard library only.

Killed by "test" is the real result. Killed by "compiler" means TypeScript refused the
mutant before any test ran: the type system pins that rule, which is fine but is not
test coverage. A mutant killed by "timeout" hung the test run (also a kill).

Exit code: 0 all killed, 1 something survived, 2 a mutant no longer matches the source
(the list below is out of date), 3 the target files have uncommitted changes.
"""
import os
import pathlib
import signal
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent  # vote-service/
STORE = "src/store.ts"
CONTESTS = "src/contests-file.ts"
TIMEOUT_S = 120

# (id, file, text to find (must occur exactly once), replacement, the rule it breaks)
MUTANTS = [
    ("S01", STORE, "      UNIQUE (contest_id, voter_id),\n      UNIQUE (contest_id, phone_hash),", "      UNIQUE (contest_id, phone_hash),", "drop UNIQUE (contest_id, voter_id)"),
    ("S02", STORE, "      UNIQUE (contest_id, phone_hash),\n      FOREIGN KEY (contest_id, choice) REFERENCES options (contest_id, label)\n", "      UNIQUE (contest_id, phone_hash)\n", "drop the votes FOREIGN KEY to options"),
    ("S03", STORE, "\n    if (contest.status === \"closed\") return { ok: false, reason: \"closed\" };\n", "\n", "cast: no closed check"),
    ("S04", STORE, "\n    if (!contest) return { ok: false, reason: \"unknown_contest\" };\n", "\n", "cast: no unknown_contest check"),
    ("S04b", STORE, "\n    if (!contest) return { ok: false, reason: \"unknown_contest\" };\n", "\n    if (!contest) return { ok: false, reason: \"closed\" };\n", "cast: unknown contest reported as closed (compiles)"),
    ("S05", STORE, "return { ok: false, reason: voterHasVoted ? \"duplicate\" : \"phone_used\" };", "return { ok: true };", "cast: duplicate reported as success"),
    ("S06", STORE, "LEFT JOIN votes v", "JOIN votes v", "tally: INNER JOIN, options with 0 votes vanish"),
    ("S07", STORE, "    ORDER BY o.position\n  `);", "    ORDER BY o.label\n  `);", "tally: ordered by label, not position"),
    ("S08", STORE, "ON v.contest_id = o.contest_id AND v.choice = o.label", "ON v.choice = o.label", "tally: counts votes across contests"),
    ("S09", STORE, "\"SELECT choice FROM votes WHERE contest_id = ? AND voter_id = ?\"", "\"SELECT choice FROM votes WHERE contest_id = ?\"", "getVote: ignores the voter"),
    ("S10", STORE, "WHERE id = ? AND status = 'open'", "WHERE id = ?", "closeContest: true on an already-closed contest"),
    ("S11", STORE, "      if (new Set(input.options).size !== input.options.length) {\n        return { ok: false, reason: \"options must be unique\" };\n      }\n", "", "createContest: duplicate options allowed"),
    ("S12", STORE, "input.options.length < 2", "input.options.length < 1", "createContest: one option allowed"),
    ("S13", STORE, "input.title.trim().length === 0 || input.title.length > 200", "input.title.length === 0 || input.title.length > 200", "createContest: whitespace-only title allowed"),
    ("S14", STORE, "input.title.length > 200", "input.title.length > 201", "createContest: title limit 200 -> 201"),
    ("S15", STORE, "input.title.trim().length === 0 || input.title.length > 200", "input.title.trim().length === 0", "createContest: no title maximum"),
    ("S16", STORE, "insertOption.run(input.id, label, i)", "insertOption.run(input.id, label, 0)", "createContest: all option positions equal"),
    ("S17", STORE, "        db.exec(\"ROLLBACK\");\n        if (errcode(e) === SQLITE_CONSTRAINT_PRIMARYKEY) {", "        if (errcode(e) === SQLITE_CONSTRAINT_PRIMARYKEY) {", "createContest: no ROLLBACK after a failure"),
    ("S18", STORE, "if (errcode(e) === SQLITE_CONSTRAINT_PRIMARYKEY) {", "if (false) {", "createContest: duplicate contest id not mapped"),
    ("S19", STORE, "const idError = contestIdProblem(input.id);\n      if (idError) return { ok: false, reason: idError };\n", "", "createContest: no id validation"),
    ("S20", STORE, "      for (const option of input.options) {\n        const problem = choiceProblem(option);\n        if (problem) return { ok: false, reason: problem.replace(\"choice\", \"option\") };\n      }\n", "", "createContest: no option validation"),
    ("S21", STORE, "CHECK (status IN ('open', 'closed'))", "", "drop the status CHECK"),
    ("S22", STORE, "status: row.status === \"closed\" ? \"closed\" : \"open\"", "status: \"open\"", "getContest: always open"),
    ("S23", STORE, "    SELECT o.label AS choice, COUNT(v.id) AS votes", "    SELECT o.label AS choice, COUNT(*) AS votes", "tally: COUNT(*) counts the empty row as 1"),
    # the SMS step: one vote per number, pending votes, codes
    ("S24", STORE, "      UNIQUE (contest_id, phone_hash),\n", "", "drop UNIQUE (contest_id, phone_hash)"),
    ("S25", STORE, "      PRIMARY KEY (contest_id, voter_id),\n      FOREIGN KEY (contest_id, choice) REFERENCES options (contest_id, label)\n", "      PRIMARY KEY (contest_id, voter_id)\n", "drop the pending_votes FOREIGN KEY to options"),
    ("S26", STORE, "voterHasVoted ? \"duplicate\" : \"phone_used\"", "\"duplicate\"", "cast: a used number reported as the voter's duplicate"),
    ("S27", STORE, "      if (Number(voted.n) > 0) return { ok: false, reason: voted.same_voter ? \"duplicate\" : \"phone_used\" };\n", "", "startVote: sends a code to a number or voter that has voted"),
    ("S28", STORE, "voted.same_voter ? \"duplicate\" : \"phone_used\"", "\"phone_used\"", "startVote: own duplicate reported as phone_used"),
    ("S29", STORE, "OR phone_hash = ?)", "OR phone_hash = ? AND 0)", "startVote: ignores whether the number has voted"),
    ("S30", STORE, "MAX(voter_id = ?) AS same_voter", "MIN(voter_id = ?) AS same_voter", "startVote: \"this number\" wins over \"this voter\" when both apply"),
    ("S31", STORE, "code_hash = excluded.code_hash, attempts = 0, expires_at", "code_hash = excluded.code_hash, expires_at", "startVote: a new code keeps the old attempts"),
    ("S32", STORE, "DELETE FROM pending_votes WHERE expires_at <= ?", "DELETE FROM pending_votes WHERE expires_at <= ? AND 0", "startVote: expired codes never swept"),
    ("S33", STORE, "    if (Number(row.expires_at) <= now) {", "    if (false) {", "confirm: no expiry"),
    ("S34", STORE, "Number(row.expires_at) <= now", "Number(row.expires_at) < now", "confirm: valid one millisecond too long"),
    ("S35", STORE, "if (!sameHash(String(row.code_hash), codeHash)) {", "if (!sameHash(String(row.code_hash), String(row.code_hash))) {", "confirm: any code is right"),
    ("S36", STORE, "if (used >= MAX_CODE_ATTEMPTS) {", "if (used > MAX_CODE_ATTEMPTS) {", "confirm: one attempt too many"),
    ("S37", STORE, "      bumpAttempts.run(contestId, voterId);\n", "", "confirm: wrong codes are not counted"),
    ("S38", STORE, "        deletePending.run(contestId, voterId);\n        return { ok: false, reason: \"locked\" };", "        return { ok: false, reason: \"locked\" };", "confirm: a locked vote stays pending"),
    ("S39", STORE, "      deletePending.run(contestId, voterId);\n      return { ok: false, reason: \"expired\" };", "      return { ok: false, reason: \"expired\" };", "confirm: an expired vote stays pending"),
    ("S40", STORE, "    deletePending.run(contestId, voterId);\n    return cast(", "    return cast(", "confirm: the code can be used again"),
    ("S41", STORE, "return x.length === y.length && timingSafeEqual(x, y);", "return timingSafeEqual(x, y);", "sameHash: throws on a different length"),
    ("S42", STORE, "if (!voteColumns.some((c) => c.name === \"phone_hash\")) {", "if (false) {", "openStore: starts on a database without the phone rule"),
    ("C01", CONTESTS, "  if (!Array.isArray(input)) return err(\"the file must contain a JSON array of contests\");\n", "", "parse: no array check"),
    ("C02", CONTESTS, "typeof item !== \"object\" || item === null || Array.isArray(item)", "typeof item !== \"object\" || Array.isArray(item)", "parse: null item accepted"),
    ("C03", CONTESTS, "typeof item !== \"object\" || item === null || Array.isArray(item)", "typeof item !== \"object\" || item === null", "parse: array item accepted"),
    ("C04", CONTESTS, "    if (extra !== undefined) return err(`${where} has an unknown field: ${extra}`);\n", "", "parse: unknown fields allowed"),
    ("C05", CONTESTS, "    if (typeof id !== \"string\") return err(`${where}: id must be a string`);\n", "", "parse: id type unchecked"),
    ("C06", CONTESTS, "    if (typeof title !== \"string\") return err(`${where}: title must be a string`);\n", "", "parse: title type unchecked"),
    ("C07", CONTESTS, "!options.every((o) => typeof o === \"string\")", "false", "parse: option element type unchecked"),
    ("C08", CONTESTS, "!Array.isArray(options) || ", "", "parse: options-is-array unchecked"),
    ("C09", CONTESTS, "    if (store.getContest(contest.id) !== null) {\n      report.skipped.push(contest.id);\n      continue;\n    }\n", "", "seed: existing contests not skipped"),
    ("C10", CONTESTS, "else report.failed.push(`${contest.id}: ${result.reason}`);", "else report.created.push(contest.id);", "seed: failures reported as created"),
]


def run_tests():
    """Run `npm test`. Returns (passed, output, timed_out). Kills the whole process group on timeout."""
    p = subprocess.Popen(["npm", "test", "--silent"], cwd=ROOT, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        out, _ = p.communicate(timeout=TIMEOUT_S)
        return p.returncode == 0, out, False
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        out, _ = p.communicate()
        return False, out, True


def classify(output, timed_out):
    """Which kind of kill was it, and the first failing thing to show."""
    if timed_out:
        return "timeout", "test run hung"
    failed = [l.strip() for l in output.splitlines() if l.strip().startswith("not ok")]
    if failed:
        return "test", "; ".join(failed[:2])
    errors = [l.strip() for l in output.splitlines() if "error TS" in l]
    return "compiler", errors[0] if errors else "build failed"


def main(only):
    if not (ROOT / "node_modules").is_dir():
        sys.exit("run `npm ci` in vote-service/ first")
    targets = sorted({m[1] for m in MUTANTS})
    dirty = subprocess.run(["git", "status", "--porcelain", "--", *targets], cwd=ROOT,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("refusing to run: these files have uncommitted changes:\n" + dirty, file=sys.stderr)
        return 3
    passed, out, _ = run_tests()
    if not passed:
        print("refusing to run: the tests do not pass before any mutation:\n" + out[-600:], file=sys.stderr)
        return 3

    tally = {"test": 0, "compiler": 0, "timeout": 0, "SURVIVED": 0, "NO MATCH": 0}
    for mid, rel, old, new, rule in MUTANTS:
        if only and mid not in only:
            continue
        path = ROOT / rel
        original = path.read_text()
        if original.count(old) != 1:
            tally["NO MATCH"] += 1
            print(f"{mid:5} NO MATCH   {rule}  (pattern found {original.count(old)}x, list is out of date)")
            continue
        path.write_text(original.replace(old, new))
        try:
            passed, out, timed_out = run_tests()
        finally:
            path.write_text(original)  # always put the file back
        if passed:
            tally["SURVIVED"] += 1
            print(f"{mid:5} SURVIVED   {rule}")
        else:
            kind, detail = classify(out, timed_out)
            tally[kind] += 1
            print(f"{mid:5} killed ({kind}) {rule} | {detail[:110]}")

    ran = sum(tally.values())
    print(f"\n{ran} mutants: {tally['test']} killed by a test, {tally['compiler']} by the compiler, "
          f"{tally['timeout']} by timeout, {tally['SURVIVED']} survived, {tally['NO MATCH']} no longer match")
    if tally["NO MATCH"]:
        return 2
    return 1 if tally["SURVIVED"] else 0


if __name__ == "__main__":
    sys.exit(main(set(sys.argv[1:])))
