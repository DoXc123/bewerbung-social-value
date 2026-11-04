import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { collectSnippets, extractRegions, FEATURE_IDS, type Snippets } from "./snippets.js";

test("a region is the lines between the markers, dedented, with its start line", () => {
  const text = ["a", "  // feature:csp", "    const X = 1;", "      nested;", "  // end feature", "b"].join("\n");
  const r = extractRegions("x.ts", text);
  assert.deepEqual(r, { ok: true, value: [{ id: "csp", snippet: { file: "x.ts", line: 3, code: "const X = 1;\n  nested;" } }] });
});

test("SQL comment markers work too, and one file may hold several regions", () => {
  const text = ["-- feature:one-vote", "UNIQUE (a),", "-- end feature", "// feature:csp", "x", "// end feature"].join("\n");
  const r = extractRegions("s.ts", text);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.map((x) => x.id), ["one-vote", "csp"]);
});

test("malformed markers are refused with the file and line", () => {
  const cases: [string, RegExp][] = [
    ["// feature:a\n// feature:b\n// end feature", /x\.ts:2: feature:b starts inside feature:a/],
    ["x\n// end feature", /x\.ts:2: "end feature" without a start/],
    ["// feature:a\nx", /x\.ts:1: feature:a is never ended/],
    ["// feature:a\n\n// end feature", /x\.ts:1: feature:a is empty/],
  ];
  for (const [text, expected] of cases) {
    const r = extractRegions("x.ts", text);
    assert.equal(r.ok, false, text);
    if (!r.ok) assert.match(r.error, expected);
  }
});

const allMarked = FEATURE_IDS.map((id) => `// feature:${id}\n${id};\n// end feature`).join("\n");

test("collectSnippets groups by id and keeps several regions of one id in order", () => {
  const r = collectSnippets([
    { file: "a.ts", text: allMarked },
    { file: "b.ts", text: "// feature:csp\nmore;\n// end feature" },
  ]);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.csp.map((s) => [s.file, s.code]), [["a.ts", "csp;"], ["b.ts", "more;"]]);
});

test("collectSnippets refuses an unknown id and a missing one", () => {
  const unknown = collectSnippets([{ file: "a.ts", text: allMarked + "\n// feature:typo\nx\n// end feature" }]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /unknown feature id "typo"/);
  const missing = collectSnippets([{ file: "a.ts", text: "// feature:csp\nx\n// end feature" }]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /no region marked for: identity, cookie/);
});

test("the real source marks every feature, and each snippet is code that is really there", () => {
  // npm test runs from vote-service/, so src/ is the source the build reads.
  const files = readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(`src/${f}`, "utf8") }));
  const r = collectSnippets(files);
  if (!r.ok) return assert.fail(r.error);
  const snippets: Snippets = r.value;
  for (const id of FEATURE_IDS) {
    for (const s of snippets[id]) {
      const source: string[] = files.find((f) => f.file === s.file)!.text.split("\n");
      const firstLine: string = s.code.split("\n")[0];
      assert.equal(source[s.line - 1].trim(), firstLine.trim(), `${id} starts at ${s.file}:${s.line}`);
    }
  }
});
