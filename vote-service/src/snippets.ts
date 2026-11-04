// The Features page shows the code that enforces each rule, cut from the real
// source at build time (build-snippets.ts), so it can't drift from what runs.
// A region is marked in the source with a pair of comment lines:
//
//   // feature:<id>          (or `-- feature:<id>` inside SQL)
//   ...the lines shown...
//   // end feature
//
// One id may have several regions (they are shown in order). Every id in
// FEATURE_IDS must be found and no other id may appear, or the build fails.
import { err, ok, type Result } from "./result.js";

export const FEATURE_IDS = [
  "identity",
  "cookie",
  "one-vote",
  "phone-hash",
  "code-rules",
  "phone-format",
  "demo-guard",
  "rate-limits",
  "csp",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

// `line` is where the shown code starts in the file (1-based).
export type Snippet = { file: string; line: number; code: string };
export type Snippets = Record<FeatureId, Snippet[]>;

const START = /^\s*(?:\/\/|--)\s*feature:([a-z0-9-]+)\s*$/;
const END = /^\s*(?:\/\/|--)\s*end feature\s*$/;

// Removes the indentation every non-blank line shares, so a region cut from
// inside a function doesn't start halfway across the screen.
function dedent(lines: string[]): string {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)![0].length);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(cut)).join("\n");
}

// The marked regions of one file, in order. Refuses nesting, a stray end and
// an unclosed start, each with the file and line, so the build error is exact.
export function extractRegions(
  file: string,
  text: string,
): Result<{ id: string; snippet: Snippet }[], string> {
  const lines = text.split("\n");
  const found: { id: string; snippet: Snippet }[] = [];
  let open: { id: string; at: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const start = START.exec(lines[i]);
    if (start) {
      if (open) return err(`${file}:${i + 1}: feature:${start[1]} starts inside feature:${open.id}`);
      open = { id: start[1], at: i };
      continue;
    }
    if (END.test(lines[i])) {
      if (!open) return err(`${file}:${i + 1}: "end feature" without a start`);
      const body = lines.slice(open.at + 1, i);
      if (body.every((l) => l.trim() === "")) return err(`${file}:${open.at + 1}: feature:${open.id} is empty`);
      found.push({ id: open.id, snippet: { file, line: open.at + 2, code: dedent(body) } });
      open = null;
    }
  }
  if (open) return err(`${file}:${open.at + 1}: feature:${open.id} is never ended`);
  return ok(found);
}

// All regions of all files, grouped by id. Every known id must appear; an
// unknown id is a typo, so it is refused rather than silently not shown.
export function collectSnippets(files: { file: string; text: string }[]): Result<Snippets, string> {
  const out = Object.fromEntries(FEATURE_IDS.map((id) => [id, [] as Snippet[]])) as Snippets;
  for (const { file, text } of files) {
    const regions = extractRegions(file, text);
    if (!regions.ok) return regions;
    for (const { id, snippet } of regions.value) {
      if (!(FEATURE_IDS as readonly string[]).includes(id)) {
        return err(`${snippet.file}:${snippet.line - 1}: unknown feature id "${id}"`);
      }
      out[id as FeatureId].push(snippet);
    }
  }
  const missing = FEATURE_IDS.filter((id) => out[id].length === 0);
  if (missing.length > 0) return err(`no region marked for: ${missing.join(", ")}`);
  return ok(out);
}
