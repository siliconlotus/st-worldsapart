# Contributing

## Where it goes

Branch from `staging` and open the PR against `staging`; it will be squash-merged, so one readable
commit per change. `release` is updated only by a merge from `staging` when a release is cut, and
carries tagged releases only.

## Cutting a release

Feature branches squash-merge into `staging`, and CI bumps the build counter on every staging push.
When `staging` is stable it is merged into `release` as the next release, and the cut is by hand:
commit the version increment to `staging` — `manifest.json` set to the plain `X.Y.Z`, the number
chosen, not derived — then merge the PR from `staging` into `release` and tag the release tip with
the bare version:

```bash
git tag -a 1.0.0 -m 1.0.0
git push origin 1.0.0
```

CI holds a counterless version as committed, so the release PR carries it plain however long the cut
sits; the next squash-merge into `staging` restarts the counter from the new number as
`X.Y.Z+build.1`. The pre-push hook refuses a direct `release` push whose version is not plain, or
whose tip is not the commit the tag names. It runs only where `git config core.hooksPath hooks` has
been run, and a merge button bypasses it — the tag is made by hand.

## Before you open it

```bash
for f in test/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
```

No output means green. There is no build step and nothing to install. CI runs the same suite on every
PR and prints the whole output of anything that fails.

A change in behaviour wants a check beside it. Checks are self-contained, take no arguments, and are
judged by exit code — a failed assertion and a thrown error are the same signal.

## What review will ask about

**Comments say what is not obvious, never why.** A comment is one of three things: what this is, when
the name does not say it; what it does, when the code does not show it; or a misstep likely in editing
it. Decisions and rationale belong in the docs, not beside the code.

**The docs describe how it works now.** If a change alters what one of them describes, update it in the
same PR. Design discussion belongs in an issue; a doc carries the outcome, not the deliberation.

**Every string a user reads goes through SillyTavern's i18n.** Injected HTML carries `data-i18n`; code
strings use the `t` tag, one whole sentence per template so a translator can reorder it.
`test/i18n-check.mjs` fails otherwise. Console output and slash-command help are not translated.

**If you touch `plugin/`, or `matcher.mjs`, `smartkeys.mjs` or `automaton.mjs`,** run
`node deploy-plugin.mjs` and restart SillyTavern — those deploy into the server plugin, and without a
redeploy you are testing the old copy. The settings panel says so when they have drifted.

## Sending graded scenes

WA's relevance model is fitted against scenes somebody graded by hand. More of them — from other books,
other genres, other ways of writing — is the single thing that improves it most, and `/wa-grade`
produces one.

**Know what you are sending.** A graded bundle is self-contained by design: it embeds the full text of
every lorebook entry in play and the chat messages verbatim, because a later run has to reproduce the
retrieval exactly. It is your writing, not statistics about your writing. It is readable JSON — open it
and look before you decide.

**What happens to it.** It is used to fit and measure the relevance model, and for nothing else. It is
never redistributed, never published, and never shared with anyone. Findings drawn from it are
published in aggregate only: "measured over 250 bundles" yes; a book title, chat title, entry title,
character name or quoted line, never — in the docs, the commit log or the issue tracker.

**Do not attach a bundle to an issue.** Issues are public, and attaching one publishes the chat it came
from. Send it privately instead; a call for grades will say where.

If that trade is not one you want to make, do not send one. There is no way to strip the content and
leave the bundle useful — the content is what is being graded.

## What is not the product

`eval/` is a research harness: measurement, grading, fitting. Only its `lib/` is load-bearing outside the harness —
the test suite imports it, and so does `deploy-plugin.mjs`. Most changes never touch it.

`CLAUDE.md` is the long form of everything above, written for coding agents but accurate for people.
