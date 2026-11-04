# Sources for `workflow/README.md`

Read on 2026-10-06. Path prefixes: `ws:` = `~/projects/workspace`, `mono:` =
`~/projects` (the old monorepo checkout), `relay:` = `~/projects/tools/claude-relay`.
All were read-only. No file here was copied into this repo.

## Files read

| Used for | File |
|---|---|
| Hook wiring, matchers (sections 1, 6) | `ws:plugin/hooks/hooks.json`, `mono:.claude/settings.json` |
| Paid-generation gate | `ws:plugin/hooks/credit-guard.py` (docstring, fail-closed lines 289-294) |
| Edit guard, fail-open | `ws:plugin/hooks/guard-protected-paths.py` |
| Worktree and pull hooks | `ws:plugin/hooks/worktree-guard.sh`, `ws:plugin/hooks/session-pull.sh` |
| Checkpoint hook | `mono:.claude/hooks/session-commit.sh` |
| skill-reminder fail-open | `mono:.claude/hooks/skill-reminder.py` |
| Agent roles, tools, models | `ws:plugin/agents/{advisor,implementer,reviewer,step-executor}.md` (frontmatter); `mono:.claude/agents/*.md` (same models) |
| Model policy as stated | `mono:CLAUDE.md` ("developer agent team", "Per-agent model policy") |
| Orchestration rules | `ws:plugin/skills/team/SKILL.md` |
| `/ship` gates | `ws:plugin/skills/ship/SKILL.md` (the installed `ws` plugin copy of the same skill) |
| `/handoff`, `/resume` | `ws:plugin/skills/handoff/SKILL.md`, `ws:plugin/skills/resume/SKILL.md` (installed copies) |
| Caps and check scripts | `ws:plugin/bin/README.md`; script names in `ws:plugin/bin/` |
| Relay design, roles, leases, budgets, states, report channel | `relay:README.md`, `relay:relay/app.py` (role check, global busy check, lease/heartbeat), `relay:poller/preflight.py` |
| Headless-agent traps | `mono:CLAUDE.md` ("Headless-agent traps the relay paid for"), `relay:README.md` |
| `.noautocommit` gitignored | `mono:.gitignore` (line 102) |
| Known issues KI-001, KI-002 | `ws:docs/KNOWN-ISSUES.md` |
| Owed human passes, repo split state | `ws:STATE.md` |
| Docs-drift audit | `ws:docs/workspace-assessment.md` (2026-09-09 entry) |
| Leftover `deploy.manifest` | `ws:deploy.manifest`, `ws:repos.json` (`deploy: null` for `workspace`) |
| ICM layers, anti-patterns | `mono:CLAUDE.md` |

## Commands run (numbers in the README)

```bash
# in ~/projects (monorepo)
git rev-list --count HEAD                                  # 1019
git log --reverse --format=%ad --date=short | head -1      # 2026-05-19
git log -1 --format=%ad --date=short                       # 2026-10-02
git log --format='%ad' --date=format:%Y-%m | sort | uniq -c   # 9/158/63/199/536/54
git log --oneline --grep='(ship)' --merges | wc -l         # 108
git log --oneline --grep='^wip(session)' | wc -l           # 63

# test functions (grep 'def test_'), not executed
tools/claude-relay/tests/test_relay.py     35
tools/claude-relay/tests/test_poller.py     7
ws:plugin/bin/tests + plugin/hooks/tests   93 (sum over files)

# line counts
wc -l relay/app.py poller/poll.py poller/preflight.py     # 584 / 413 / 93
ls tools/claude-relay/reports | wc -l                      # 35
ls ws:plugin/skills | wc -l                                # 12
```

## Not verified, so left out or hedged

- Whether the model-per-role split improves results: no data, stated as a design
  choice only.
- Whether a shell write to a `.env` file is blocked: only the hook matcher was
  checked, not a live test.
- Test pass/fail: test functions were counted, not run.
- The lease and task durations: quoted from the relay README ("the lease is
  minutes and a task is up to 50"), units not stated there, so not restated.
