# WorldsApart

Only what isn't already in the file headers. Each module's header explains what it is and why; read it
before changing it.

`keyword-suggest-design.md` is the live, unsettled definition work for the rebuilt keyword suggester —
what a good key is, what would count as success, and which of the books' own keys are not evidence.
Read it before proposing anything about `buildKeySuggest` or how to measure it, and update it rather
than re-deriving it in conversation.

`matcher-design.md` is its companion for the OTHER half: how a key is matched, the SmartKeys grammar,
and the plan for WA taking over activation from core. It carries the principles that decided most of
the individual calls (the haystack is where distinctions die; language-dependent correctness belongs in
the reviewed layer; quoting is the single escape) plus the open work. Read it before changing
`countKey`, `smartkeys.mjs`, the fold, or anything about activation. Same discipline as below.

## The design docs record rules, not the working that produced them

They carry decisions and the facts whose absence would cause a mistake. The instance that convinced
someone, the counts behind it, and any account of what an earlier draft got wrong all stay out. One
pass added 312 lines and half of it was archaeology that had already answered its question.

**Terms are stable, or they are announced as new.** Use the doc's vocabulary exactly — seed, expander,
renderer, required forms, hypernymy, propriolization. A synonym reads as a different concept, and a
reader cannot tell whether something settled is being restated or something new introduced. Prefer the
standard technical term to a coinage: five of six invented ones did not survive review, and two were
hiding errors — "breadth" was hypernymy, and "contraction" concealed the false claim that truncating a
key is a purely local operation (`Big Sur` → `Sur` is not).

**Say which claims are measured.** A measured claim names its measurement; anything else is labelled an
assertion. Unchallenged is not agreed — a scan-window conversion invented in a single message was still
load-bearing three commits later, and outlived its own revert because it had been written into two
sections and only one was checked.

**Propose a new claim before writing it down.** Cuts and restatements of settled content can just be
made; anything asserting what the doc does not already carry, with no measurement behind it, gets
proposed first. The test is structural, not a judgement about how controversial it looks — every
problem here came from a new claim, none from a deletion.

## eval/ has three kinds of file

- `*-check.mjs` — self-checking. Run with no arguments; they print `ok`/`FAIL` or assert. This is the
  regression suite: `for f in eval/*-check.mjs; do node "$f"; done` should be silent-clean.
- `scene.mjs`, `metrics.mjs` — libraries, no CLI. `scene.mjs` loads and scores one graded scene (index,
  gazetteer, scorers, pool, nDCG); `metrics.mjs` holds the shared statistics. Both `graded-scene-grid.mjs`
  and `paired-arms.mjs` go through them, so a second copy of the gazetteer or the scorers must never appear
  — that path has already produced one 74% BM25 error, and two tools disagreeing would report the drift as a
  parameter effect.
- everything else (`*-grid.mjs`, `paired-arms`, `keyword-audit`, `relevance-eval`, `summary-center`) —
  benchmark and analysis tools that need a vector index and/or lorebook path as an argument. Run bare they
  print a usage line and exit non-zero; that is not a test failure.

## Graded scenes: pool first, then pair

Two constraints shape every tuning claim, and both have tooling rather than a workaround.

`n` is single-digit and always will be — a chat has to be long enough to have retrievable history and rich
enough for some of it to be irrelevant. So **argmax over a grid is not available**: use `paired-arms.mjs`,
which contrasts one parameter at a time against each scene's own baseline and reports the sign test. At n<6
nothing can reach p<0.05, so the finding is the direction plus the mean delta, and "measured flat, n=X scenes
across Y chats, paired" is a legitimate and common outcome to write next to a default.

A pool built from one configuration penalises every configuration far from it, so a defaults review scored
against a single `/wa-grade` capture is not defensible. `/wa-super-grade` captures several
population-changing arms, unions what they surfaced and grades the union once; later rounds load earlier
samples and grade only the delta. `judged@10` in `graded-scene-grid.mjs` is the stopping rule — add arms
until the cells you care about stop showing gaps. It cannot always reach 10/10: offline re-derivation ranks
keyword-only rows ST core would have rejected, and no arm can surface those.

## Chat-based measurement uses the standard corpus

Anything measuring how keys behave against *prose* — firing rate, over-firing, discourse recurrence —
runs against the standard chat set listed in `eval/eval-data/README.md`, not whatever chat is open. A
short branch cannot show whether a key over-fires, and the set is picked to span memory against
reference books and fantasy against contemporary. That file is gitignored, because the corpus is one
person's chats.

Count **usable** messages, not raw lines: core and WA both drop `is_system` before scanning, and one
chat in the set is 65% hidden, so `CORPUS-MAP.md`'s line counts overstate it threefold.

## countKey is the only matcher

`ranking.mjs` `countKey()` mirrors ST core's `matchKeys` — match flags, `/regex/` keys, `?` SmartKeys.
Anything that reports on how a key will behave (the audit, the pruner, the Studio's keyword colouring)
calls it rather than re-deriving the rules, so the audit can't drift from what actually fires at
runtime. The Aho-Corasick batching in `keyword-core.mjs` changes only when and how often it is called.

## Pure vs ST-coupled

`ranking.mjs`, `keyword-core.mjs`, `selection.mjs`, `smartkeys.mjs`, `sort.mjs` and `plugin/*.mjs` are
ST-free and node-importable, so the evals exercise the real shipped code instead of string-slicing it.
Settings and ST globals are injected by the caller, never imported. The ST/DOM half is
`worldsapart.js`, `keyword-tools.mjs`, `studio.mjs`, `ui-widgets.mjs`.

One exception survives: `eval/bulk-reorder-check.mjs` string-slices `planUidReindex` out of
`studio.mjs`, which imports ST and so can't be loaded under node.

## Composite keys use US (``), never NUL

Cache keys and row ids that join fields into one string (the summary cache in `summarizeQuery`, the
`rowId` helpers in `studio.mjs` and `keyword-tools.mjs`) separate with Unit Separator. It was `\0`, and
that made git treat those files as **binary**: `git diff` printed "Binary files differ" instead of the
change, with no line-level blame or three-way merge. `grep` silently produced no output and BSD `awk`
truncated the line at the NUL. US has none of those effects and, being a control character, still can't
collide with content the way a printable delimiter could.

## Plugin changes need a redeploy

Editing anything in `plugin/` requires `node deploy-plugin.mjs` and an ST restart. `/plugins/worlds-apart/`
is a generated copy; the settings panel shows a drift banner until the fingerprints match.
