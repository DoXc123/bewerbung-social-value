// The colour switch: Auto (follow the system), Light or Dark. The choice is a
// data-theme attribute on <html> that style.css reads, never a style attribute,
// so the CSP stays strict. It is remembered in localStorage when the browser
// allows it; without storage the page simply starts on Auto again.
import { THEMES, parseTheme, type Theme } from "./view.js";

const KEY = "vote-theme";
const LABELS: Record<Theme, string> = { auto: "Auto", light: "Light", dark: "Dark" };

function stored(): Theme {
  try {
    return parseTheme(localStorage.getItem(KEY));
  } catch {
    return "auto";
  }
}

function apply(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private window or blocked storage: the choice lasts until reload
  }
}

// Fills `group` with one button per theme and applies the remembered choice.
export function initTheme(group: HTMLElement): void {
  let current = stored();
  apply(current);
  const buttons = THEMES.map((theme) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = LABELS[theme];
    button.addEventListener("click", () => {
      current = theme;
      apply(theme);
      mark();
    });
    return button;
  });
  const mark = () => {
    THEMES.forEach((theme, i) => buttons[i].setAttribute("aria-pressed", String(theme === current)));
  };
  mark();
  group.replaceChildren(...buttons);
}
