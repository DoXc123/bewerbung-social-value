// tsc only compiles TypeScript; the page's HTML and CSS are copied beside the compiled script.
import { cpSync } from "node:fs";
cpSync("public", "dist/public", { recursive: true });
