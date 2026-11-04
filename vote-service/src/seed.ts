// Entry point: create contests from a JSON file.
//   DB_PATH=votes.sqlite npm run seed -- contests.json
import { readFileSync } from "node:fs";
import { parseContestList, seedContests } from "./contests-file.js";
import { openStore } from "./store.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run seed -- <contests.json>");
  process.exit(1);
}

let json: unknown;
try {
  json = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`seed: cannot read ${file}: ${(e as Error).message}`);
  process.exit(1);
}

const parsed = parseContestList(json);
if (!parsed.ok) {
  console.error(`seed: ${parsed.error}`);
  process.exit(1);
}

const store = openStore(process.env.DB_PATH ?? "votes.sqlite");
const report = seedContests(store, parsed.value);
store.close();

console.log(`created: ${report.created.join(", ") || "none"}`);
console.log(`already existed (left unchanged): ${report.skipped.join(", ") || "none"}`);
if (report.failed.length > 0) {
  console.error(`failed:\n  ${report.failed.join("\n  ")}`);
  process.exit(1);
}
