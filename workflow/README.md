# The AI workflow: using agents with control

A description of how Claude Code is used day to day in this owner's repos, and
which parts of that are enforced by code rather than by habit. Every claim
below is traced to a file or a command in [SOURCES.md](SOURCES.md); numbers were
measured on 2026-10-06 and are not copied from docs. Where something is only a
convention, or I could not verify it, it says so.

## At a glance

| What | Fact | Where |
|---|---|---|
| History | 1,019 commits in the monorepo, 2026-05-19 to 2026-10-02 (9 / 158 / 63 / 199 / 536 / 54 per month, May to Oct) | `git log` |
| Landing discipline | 108 `(ship)` merge commits; 63 `wip(session)` auto-checkpoints | `git log --grep` |
| Plugin (`ws`) | 12 skills, 4 agents, 4 hook scripts plus `hooks.json`, 5 check scripts | `workspace/plugin/` |
| Tests on the tooling | 93 test functions in the plugin's script and hook tests (counted, not re-run for this write-up) | `plugin/bin/tests`, `plugin/hooks/tests` |
| Relay | about 1,100 lines of Python (`app.py` 584, `poll.py` 413, `preflight.py` 93), 42 test functions, 35 report files | `tools/claude-relay/` |

## 1. The control model

The rule underneath everything: **an agent can write freely on a branch, and
nothing reaches `main` without a human saying yes.** Some of it is enforced by
hooks and scripts, some by skill instructions the model follows. The two are
kept apart below.

**Enforced by git layout and hooks**

- **One task = one branch = one worktree = one window.** `scripts/wt.sh` and
  `scripts/cw.sh` create the worktree. "`main` only fast-forwards" is a rule in
  `CLAUDE.md`; the hook's part is that `session-commit.sh` (`SessionEnd`) will not
  auto-commit on `main` or `master` and prints a message instead.
- **Checkpoint, never push.** On a task branch, that hook commits uncommitted
  work as `wip(session): auto-checkpoint <time>`. It takes a shared `flock`, skips
  mid-merge/rebase, honours a `.noautocommit` opt-out, and never pushes.
- **Session start.** `session-pull.sh` fast-forwards the current branch from its
  upstream only on a clean tree; it never merges. `worktree-guard.sh` reports
  (does not block) when a session is in the main checkout or when the branch
  has touched more than one project.
- **Edit guard.** `guard-protected-paths.py` (`PreToolUse`, matcher
  `Write|Edit|MultiEdit`) hard-denies edits to `.env` files and credential files
  (`*.pem`, `*.key`, `credentials.json`, `*secret*.json|yaml`), except
  `*.example` / `*.sample` templates. It also asks before an edit under a
  project's stable-reference folder (the layer that is set up once and not
  changed per run).
- **Paid-generation gate.** `credit-guard.py` (`PreToolUse` + `PostToolUse` on the
  image/video generation tools) denies a paid call unless a `runs/*/SPEC*.md`
  has `approved: yes` and names that model, requires a free price quote first,
  and denies once a session total would pass a cap (default 80 credits). An
  internal error on a paid tool asks rather than allows.

**Enforced by skill instructions (the model follows them; no script blocks a
violation)**

- **`/ship`** (`plugin/skills/ship/SKILL.md`): runs the drift report and the
  caps/stale-doc/legacy-path checks, then stops at "GATE 1: confirm the merge"
  and states "Never merge and never deploy without an explicit yes in the
  conversation." The merge happens in a throwaway worktree off `origin/main`, the
  branch is deleted locally and on origin, and a repo with a `deploy.manifest`
  hits a second gate before any deploy.
- **`/handoff` and `/resume`**: see section 5.

## 2. The agent team

`/team` (`plugin/skills/team/SKILL.md`) is a prompt, not a program: the
orchestrator is the main session, and the instructions say not to write code that
orchestrates. Four subagents are defined in `plugin/agents/`:

| Agent | Tools (from frontmatter) | Model (from frontmatter) |
|---|---|---|
| `implementer` | Read, Write, Edit, Glob, Grep, Bash | `claude-sonnet-4-6` |
| `reviewer` | Read, Glob, Grep, Bash (no Write/Edit by design) | `claude-opus-4-8` |
| `advisor` | Read, Glob, Grep, WebFetch, WebSearch, Bash | `claude-opus-4-8` |
| `step-executor` | Read, Write, Edit, Glob, Grep, Bash | `inherit` |

- **Generator and verifier are different models.** The cheaper model writes, the
  stronger one reviews, and the reviewer cannot edit, so it can run beside the
  implementer without racing it.
- **Context by path, not by summary.** An agent starts cold and gets a path to a
  spec or `CONTRACT.md`; the `team` skill says "Pass each agent paths, not prose
  recaps", agents never talk to each other, and everything routes through the
  orchestrator.
- **Fan out only when it pays.** The same skill warns that each subagent pays a
  full warm-up and that parallel agents multiply token cost.

I did not measure whether this split produces better code than a single model;
the policy is a stated design choice (monorepo `CLAUDE.md`, "Per-agent model
policy"), not a result.

## 3. The relay: handing whole tasks to a second account

`tools/claude-relay/` lets a second person, on their own Claude subscription,
take whole tasks without sharing an account. It runs on a small VPS.

```
owner's session --ssh--> VPS --> loopback queue <-- worker (own unix user)
 (enqueue-only token)             SQLite = scheduling    runs `claude` headless
                                  real work = git branches, reviewed by a human
```

Design choices, each stated in `tools/claude-relay/README.md` and visible in
`relay/app.py`:

- **The relay executes nothing.** It stores JSON. A task is a pointer (repo,
  base branch, brief path); there is no inline-instruction field. Losing the
  database loses scheduling, not work, because git is the data plane.
- **Two token roles.** `worker` may claim, heartbeat and report; `client` may
  enqueue and read. A client token on a worker route gets a 403.
- **One task at a time, globally.** `claim_task` has a global busy check.
- **Leases with fencing.** Each claim bumps an epoch; a stale worker gets a 409 on
  its next heartbeat and abandons without pushing. Cancel does not kill the
  worker: the next heartbeat (and one more right before pushing) fails and the
  worker stops.
- **Bounded spend per task.** `model`, `effort` and `budget_usd` are validated
  against an allowlist at enqueue time; `budget_usd` is capped at
  `RELAY_MAX_TASK_BUDGET_USD` (20).
- **Isolation from production.** `poller/preflight.py` refuses to run if the
  scratch clone is, or is inside, the production checkout, and re-checks before
  every task. The worker unit is the designated OOM victim (`OOMScoreAdjust=500`)
  so a bot is not.
- **A run ends in one of three honest states**: `done` (pushed a branch),
  `needs_attention` (ended cleanly, landed no work: decided by footprint, because
  two of the first fifteen tasks reported success after launching background work
  that never completed), or `failed`.
- **The report file is the channel.** Every run writes a four-heading report
  (What changed, Questions for the owner, Assumptions I made, Not verified)
  because a 1,500-character stored summary kept truncating the caveats.

## 4. Headless-agent traps (paid for once, written down)

From the monorepo `CLAUDE.md`, "Headless-agent traps the relay paid for". They
apply to anything running `claude -p` against a repo with session hooks:

1. A scratch clone must carry `.noautocommit` (now gitignored so `git add -A`
   cannot ship it), or the `SessionEnd` hook auto-commits the agent's work.
   `preflight.py` refuses to start a task without it, and checks again before
   every task, since a `git clean -fdx` would remove it silently.
2. A headless run needs an explicit `--permission-mode`. The default refuses every
   write and sandboxes Bash read-only; the first smoke test returned "No changes
   produced".
3. `thinking_tokens` lives at `usage.output_tokens_details.thinking_tokens`, not
   at the top of `usage`.
4. A lease must be heartbeated during the run, not only before the push. The relay
   README's reasoning: "the lease is minutes and a task is up to 50", so without a
   background heartbeat the relay would sweep a live task back to `queued`.

## 5. Context discipline

**Layers (the monorepo's ICM scheme).** `CLAUDE.md` at the root is always read.
Each project has a routing file, stage contracts that are read only when that
stage runs, stable reference, and live artifacts. The root `CLAUDE.md` lists
"Anti-Patterns You Must Avoid": do not merge stages, do not auto-chain, do not
load artifacts a stage contract does not name.

**Carriers with caps (the newer per-repo scheme).** A repo keeps a fixed set of
docs, each with a line cap that `plugin/bin/state-cap` checks: `CLAUDE.md` 60,
`STATE.md` 80, `VISION.md` 80, `GLOSSARY.md` 120, `OVERVIEW.md` 150, system docs
300, `KNOWN-ISSUES.md` 150, `ROADMAP.md` 200. The point is that what a session
loads at start stays small.

**Session bookends.**

- `/resume` (`plugin/skills/resume`) is read-only: it reads `STATE.md`, the system
  overview and the `### KI-` headings, derives the git facts itself, restates the
  next one to three tasks and waits. It never opens `archive/` at session start.
- `/handoff` rewrites `STATE.md` (it does not append): the outgoing version goes
  verbatim to `archive/YYYY-MM/` first, git facts are derived rather than carried
  over, and it runs `state-cap` and `stale-docs`. Its own text records the bug
  that shaped it: a handoff written while a relay task was still running named
  the wrong next step, and was wrong 11 minutes later.
- `stale-docs` flags a system doc when `git log <verified>..HEAD -- <covers>` is
  non-empty, so a doc must declare what code it covers.

## 6. What this does not guarantee

Written from what is visible in the repos, not from a clean bill of health.

- **Several hooks fail open.** `guard-protected-paths.py` exits 0 on a parse
  error; `skill-reminder.py` has bare `except` blocks; `worktree-guard` and
  `session-pull` never block by design. Only `credit-guard` is written to fail
  closed, and only for paid tools.
- **The edit guard covers the edit tools, not the shell.** Its matcher in
  `hooks.json` is `Write|Edit|MultiEdit`. I did not test whether a shell
  redirect to a `.env` file is stopped some other way.
- **Relayed work runs with permissions bypassed.** The relay README says the
  worker uses `--permission-mode bypassPermissions` and that "the containment
  that matters is the unix user it runs as, plus a human reviewing the branch."
  That is a deliberate trade, and it relies on the review step.
- **Guards depend on the plugin being enabled.** `KI-002` in the workspace repo
  records that credit-guard is not enabled in the monorepo, so paid generations
  there are ungated until the plugin is switched on or the work moves.
- **Stale copies exist.** `KI-001` records that the monorepo still holds an old
  copy of the relay and its `relay.sh`, which predate the multi-repo registry.
- **A leftover `deploy.manifest`.** The workspace repo contains a
  `deploy.manifest` naming service entries for bots that live in another repo,
  while `repos.json` has `deploy: null` for `workspace`, so the deploy check is
  skipped there. It looks like a leftover from the old layout and should be
  removed or explained.
- **Docs drift, and the check only sees opted-in docs.** `stale-docs` skips a doc
  without `covers:` frontmatter. A 2026-09-09 audit in
  `docs/workspace-assessment.md` rated one project "stale": the code was fine, the
  documentation about it had fallen behind.
- **Safety-net commits are not reviewed work.** 63 of the 1,019 commits are
  `wip(session)` checkpoints; they exist so nothing is lost, not because anyone
  read them.
- **Housekeeping lapses are recorded, not hidden.** The workspace `STATE.md` lists
  "Owed human passes", including a main checkout with an uncommitted file of
  unknown origin and a backup that still has to be made.
- **Nothing here measures output quality.** The model-per-role split, the relay
  and the gates are designed controls. I have no data on defect rates with and
  without them.

## 7. How this maps to the posting

The posting asks for AI tools used centrally and proactively "while keeping full
control, understanding and a critical eye on code quality and architecture"
(translated from the German). What the repos show for that: agents work only on
branches and in isolated worktrees; generation and verification are split across
roles and models; the merge and deploy steps are gated on an explicit human yes;
headless runs are contained by a unix user, a preflight and a human-reviewed
branch; and the failure modes found along the way are written down with the check
that now catches them. The gaps are in section 6.
