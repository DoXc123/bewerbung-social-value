# STATE — Application
<!-- cap 80 lines. /handoff rewrites this file. Git facts are derived, never typed. -->
**Updated:** 2026-10-14 · handoff-2026-10-14

## Now
Nothing in flight in code. The repo is in its send-ready form: all three pieces test on their own, and
`vote-service/DESIGN.md` (German, written by the owner, with an attributed excerpt from Claude's attacker pass) is
linked from the README. Hosting stays decided: none. The repo keeps no archive, decisions or roadmap on purpose.

## Next
1. **Owner's text passes: done** (2026-10-14). Über mich stays as written; DESIGN.md got its spelling pass.
2. **Public copy:** a fresh repository with a single commit of this tree, so that earlier drafts in this repo's
   history are not published. Name and visibility only on the owner's yes. Re-run the secrets and personal-data
   sweep on the exact tree that goes out.
3. **The two gaps in `vote-service/DESIGN.md` § Angriffsmöglichkeiten stay open by choice** (codes to many numbers
   from one browser, per-address limits under IPv6). Closing them is a separate decision, not a default next step.

## Owner questions
None open. Resolved 2026-11-04: `voicepptx` fixtures now use `/home/app/...`; the config default folder is `reference`
(no `no-legacy-paths` hit); `whitesea-core` cost and build-time formulas are placeholders written for this extract.

## Live branches / WIP
None.

## Owed human passes
- Own sentences in `workflow/README.md`, `whitesea-core/README.md`, `voicepptx/README.md` are optional now: the
  `TODO(owner)` placeholders were removed on 2026-10-14.
- Read the reworded comments in `voicepptx`: `src/transcribe.js`, `src/config.js`, and the two in `.env.example`.
- A full vote by hand through the SMS step is not confirmed (the pages were checked in headless Chromium).
