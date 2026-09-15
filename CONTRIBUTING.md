# Contributing

## Where it goes

Branch from `staging` and open the PR against `staging`; it will be squash-merged, so one readable
commit per change. `release` carries tagged releases only — nothing is merged into it directly.

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
it. Decisions and rationale belong in the design docs, not beside the code.

**The design docs are the record.** `matcher-design.md` owns the matcher and the pipeline,
`keyword-suggest-design.md` the suggester and the audit, `bundle-schema.md` the graded bundle,
`SMARTKEYS.md` the key syntax. If a change alters what one of them describes, update it in the same PR.

**Every string a user reads goes through SillyTavern's i18n.** Injected HTML carries `data-i18n`; code
strings use the `t` tag, one whole sentence per template so a translator can reorder it.
`test/i18n-check.mjs` fails otherwise. Console output and slash-command help are not translated.

**If you touch `plugin/`, or `matcher.mjs`, `smartkeys.mjs` or `automaton.mjs`,** run
`node deploy-plugin.mjs` and restart SillyTavern — those deploy into the server plugin, and without a
redeploy you are testing the old copy. The settings panel says so when they have drifted.

## What is not the product

`eval/` is a research harness: measurement, grading, fitting. Nothing in it ships, and nothing in it
runs in CI. Most changes never touch it.

`CLAUDE.md` is the long form of everything above, written for coding agents but accurate for people.
