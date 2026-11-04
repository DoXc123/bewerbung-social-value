import { err, ok, type Result } from "./result.js";
import type { NewContest, openStore } from "./store.js";

// The contest list the owner writes by hand, as JSON:
//   [{ "id": "pets", "title": "Best pet", "options": ["Cat", "Dog"] }]
// This checks the SHAPE (so createContest only ever sees strings and arrays
// of strings); the store then checks the content (id format, option count...).
export function parseContestList(input: unknown): Result<NewContest[], string> {
  if (!Array.isArray(input)) return err("the file must contain a JSON array of contests");
  const contests: NewContest[] = [];
  for (const [i, item] of input.entries()) {
    const where = `contest #${i + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return err(`${where} must be an object`);
    }
    const { id, title, options, ...rest } = item as Record<string, unknown>;
    const extra = Object.keys(rest)[0];
    if (extra !== undefined) return err(`${where} has an unknown field: ${extra}`);
    if (typeof id !== "string") return err(`${where}: id must be a string`);
    if (typeof title !== "string") return err(`${where}: title must be a string`);
    if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) {
      return err(`${where}: options must be an array of strings`);
    }
    contests.push({ id, title, options });
  }
  return ok(contests);
}

export type SeedReport = { created: string[]; skipped: string[]; failed: string[] };

// Creates each contest that doesn't exist yet. Safe to run again: existing
// contests are left exactly as they are, because changing options under
// existing votes would corrupt the results.
export function seedContests(store: ReturnType<typeof openStore>, contests: NewContest[]): SeedReport {
  const report: SeedReport = { created: [], skipped: [], failed: [] };
  for (const contest of contests) {
    if (store.getContest(contest.id) !== null) {
      report.skipped.push(contest.id);
      continue;
    }
    const result = store.createContest(contest);
    if (result.ok) report.created.push(contest.id);
    else report.failed.push(`${contest.id}: ${result.reason}`);
  }
  return report;
}
