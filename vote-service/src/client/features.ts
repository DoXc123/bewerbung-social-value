// The Features page: each rule in a sentence, what this instance is set to
// (GET /settings) and the code that enforces it (/snippets.json, cut from the
// source at build time). Drawn with textContent only, like the vote page.
import { initTheme } from "./theme.js";
import { FEATURES, STRINGS, parseSettings, parseSnippets, type Settings, type ShownSnippet } from "./view.js";

const listEl = document.getElementById("features");
const noticeEl = document.getElementById("notice");
const themeEl = document.getElementById("theme");
if (!listEl || !noticeEl || !themeEl) throw new Error("page is missing its elements");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string | null, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function codeBlock(s: ShownSnippet): HTMLElement {
  const figure = el("figure", "code");
  figure.append(el("figcaption", null, `src/${s.file}:${s.line}`));
  const pre = el("pre", null);
  pre.tabIndex = 0; // long lines scroll sideways; keyboard users need to reach them
  pre.append(el("code", null, s.code));
  figure.append(pre);
  return figure;
}

function render(settings: Settings | null, snippets: Record<string, ShownSnippet[]>): void {
  listEl!.replaceChildren(
    ...FEATURES.map((f) => {
      const section = el("section", "feature");
      section.append(el("h2", null, f.title), el("p", "text", f.text));
      if (f.setting && settings) {
        const line = el("p", "setting");
        line.append(el("span", "setting-label", "This instance"), document.createTextNode(f.setting(settings)));
        section.append(line);
      }
      for (const s of snippets[f.id] ?? []) section.append(codeBlock(s));
      return section;
    }),
  );
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function load(): Promise<void> {
  noticeEl!.textContent = STRINGS.loading;
  const [settingsRaw, snippetsRaw] = await Promise.allSettled([getJson("/settings"), getJson("/snippets.json")]);
  const settings = settingsRaw.status === "fulfilled" ? parseSettings(settingsRaw.value) : null;
  const snippets = snippetsRaw.status === "fulfilled" ? parseSnippets(snippetsRaw.value) : null;
  render(settings, snippets ?? {});
  noticeEl!.textContent =
    settings && snippets ? "" : "Some of this page could not be loaded. Please reload to try again.";
}

initTheme(themeEl);
void load();
