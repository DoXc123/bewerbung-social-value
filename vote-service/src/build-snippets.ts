// Build step: cut the marked regions out of src/ into dist/public/snippets.json
// for the Features page. Run by `npm run build` after tsc; fails the build when
// a region is missing or malformed, so the page never shows stale code.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectSnippets } from "./snippets.js";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const outFile = fileURLToPath(new URL("./public/snippets.json", import.meta.url));

// Every source file except tests, by path relative to src/ ("client/view.ts").
const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort()
  .map((f) => ({ file: f.replaceAll("\\", "/"), text: readFileSync(srcDir + f, "utf8") }));

const collected = collectSnippets(files);
if (!collected.ok) {
  console.error(`build-snippets: ${collected.error}`);
  process.exit(1);
}
writeFileSync(outFile, JSON.stringify(collected.value, null, 2) + "\n");
