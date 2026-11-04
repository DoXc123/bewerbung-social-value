// The page: fetch the contest, draw it, and take a vote through its two steps
// (phone number, then the code from the SMS). Everything is drawn with
// textContent and createElement, never innerHTML, so text from the server can
// never become markup.
import {
  STRINGS,
  barPercent,
  cleanCode,
  codeLead,
  demoNote,
  parseCodeSent,
  parseContest,
  phoneLead,
  refusal,
  screenFor,
  totalVotes,
  type ContestView,
} from "./view.js";
import { initTheme } from "./theme.js";

const main = document.querySelector("main");
const contestId = main?.dataset.contest;
const titleEl = document.getElementById("title");
const choicesEl = document.getElementById("choices");
const noticeEl = document.getElementById("notice");
const tallyEl = document.getElementById("tally");
const phoneStep = document.getElementById("phone-step") as HTMLFormElement | null;
const phoneLeadEl = document.getElementById("phone-lead");
const phoneInput = document.getElementById("phone") as HTMLInputElement | null;
const phoneBack = document.getElementById("phone-back");
const demoPhoneEl = document.getElementById("demo-phone");
const codeStep = document.getElementById("code-step") as HTMLFormElement | null;
const codeLeadEl = document.getElementById("code-lead");
const demoEl = document.getElementById("demo-code");
const codeInput = document.getElementById("code") as HTMLInputElement | null;
const codeBack = document.getElementById("code-back");
const themeEl = document.getElementById("theme");

if (
  !contestId || !titleEl || !choicesEl || !noticeEl || !tallyEl ||
  !phoneStep || !phoneLeadEl || !phoneInput || !phoneBack || !demoPhoneEl ||
  !codeStep || !codeLeadEl || !demoEl || !codeInput || !codeBack || !themeEl
) {
  throw new Error("page is missing its elements");
}

// Which part of the voting area is showing. The option the voter picked is
// kept until the vote is counted or they choose again.
type Step = "choose" | "phone" | "code";
let step: Step = "choose";
let chosen: string | null = null;

function setNotice(text: string): void {
  noticeEl!.textContent = text;
}

function show(next: Step): void {
  step = next;
  choicesEl!.hidden = next !== "choose";
  phoneStep!.hidden = next !== "phone";
  codeStep!.hidden = next !== "code";
  if (next === "phone") phoneInput!.focus();
  if (next === "code") codeInput!.focus();
}

function busy(form: HTMLFormElement, on: boolean): void {
  for (const el of form.querySelectorAll("button, input")) (el as HTMLButtonElement).disabled = on;
}

function render(c: ContestView): void {
  document.title = c.title;
  titleEl!.textContent = c.title;
  demoPhoneEl!.hidden = !c.smsDemo;
  demoPhoneEl!.textContent = c.smsDemo ? STRINGS.demoPhone : "";

  const screen = screenFor(c);
  choicesEl!.replaceChildren();
  if (screen.canVote) {
    for (const option of c.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option;
      button.addEventListener("click", () => pick(option));
      choicesEl!.append(button);
    }
  } else {
    show("choose"); // nothing left to confirm: voted, or closed
  }
  if (step === "choose") setNotice(screen.notice ?? ""); // also clears "Loading…"

  const total = totalVotes(c.tally);
  tallyEl!.replaceChildren();
  tallyEl!.classList.toggle("has-vote", c.yourVote !== null);
  const fills: { fill: HTMLElement; percent: number }[] = [];
  for (const row of c.tally) {
    const item = document.createElement("li");
    const mine = row.choice === c.yourVote;
    if (mine) item.classList.add("mine");

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = row.choice;
    if (mine) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = STRINGS.yourVoteTag;
      label.append(tag);
    }

    const percent = barPercent(row.votes, total);
    const stats = document.createElement("span");
    stats.className = "stats";
    stats.textContent = `${row.votes} · ${percent}%`;

    const bar = document.createElement("span");
    bar.className = "bar";
    bar.setAttribute("aria-hidden", "true"); // the numbers beside it say the same
    const fill = document.createElement("span");
    fill.className = "fill";
    bar.append(fill);
    fills.push({ fill, percent });

    item.append(label, stats, bar);
    tallyEl!.append(item);
  }
  // Start every bar at 0, let the browser lay that out, then set the real width,
  // so the CSS transition has something to grow from. CSSOM, allowed by the CSP.
  for (const { fill } of fills) fill.style.width = "0%";
  void tallyEl!.offsetWidth;
  for (const { fill, percent } of fills) fill.style.width = `${percent}%`;
}

async function load(): Promise<void> {
  try {
    const res = await fetch(`/contests/${encodeURIComponent(contestId!)}`);
    if (!res.ok) return setNotice(res.status === 404 ? STRINGS.notFound : STRINGS.failed);
    const contest = parseContest(await res.json());
    if (!contest) return setNotice(STRINGS.failed);
    render(contest);
  } catch {
    setNotice(STRINGS.network);
  }
}

// Step 0: an option was clicked. Ask for the number; nothing is sent yet.
function pick(option: string): void {
  chosen = option;
  phoneLeadEl!.textContent = phoneLead(option);
  setNotice("");
  show("phone");
}

// The body of an answer, or null when it isn't JSON.
async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// After a refusal: say why, then stay, go back to the number, or start over.
async function refused(kind: "start" | "confirm", res: Response): Promise<void> {
  const { text, next } = refusal(kind, res.status, await bodyOf(res));
  if (next === "phone") show("phone");
  if (next === "reload") {
    show("choose");
    await load();
  }
  setNotice(text);
}

// Step 1: send the choice and the number; the server answers with a code by SMS.
async function sendPhone(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (chosen === null) return show("choose");
  if (phoneInput!.value.trim() === "") return setNotice(STRINGS.badPhone);
  busy(phoneStep!, true);
  try {
    const res = await fetch("/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contestId, choice: chosen, phone: phoneInput!.value }),
    });
    if (res.status !== 202) return await refused("start", res);
    const sent = parseCodeSent(await bodyOf(res));
    if (!sent) return setNotice(STRINGS.failed);
    codeLeadEl!.textContent = codeLead(sent);
    demoEl!.hidden = sent.demoCode === null;
    demoEl!.textContent = sent.demoCode === null ? "" : demoNote(sent.demoCode);
    codeInput!.value = "";
    setNotice("");
    show("code");
  } catch {
    setNotice(STRINGS.network);
  } finally {
    busy(phoneStep!, false);
  }
}

// Step 2: send the code back. Only now is the vote counted.
async function sendCode(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const code = cleanCode(codeInput!.value);
  if (code === null) return setNotice(STRINGS.badCode);
  busy(codeStep!, true);
  try {
    const res = await fetch("/votes/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contestId, code }),
    });
    if (res.status !== 201) return await refused("confirm", res);
    chosen = null;
    show("choose");
    await load(); // the new tally, with "Your vote" on the chosen row
    setNotice(STRINGS.voted);
  } catch {
    setNotice(STRINGS.network);
  } finally {
    busy(codeStep!, false);
  }
}

phoneStep.addEventListener("submit", (e) => void sendPhone(e));
codeStep.addEventListener("submit", (e) => void sendCode(e));
phoneBack.addEventListener("click", () => {
  chosen = null;
  setNotice("");
  show("choose");
});
codeBack.addEventListener("click", () => {
  setNotice("");
  show("phone");
});

initTheme(themeEl);
setNotice(STRINGS.loading);
void load();
