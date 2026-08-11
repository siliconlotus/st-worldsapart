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
- `fixtures/` + `sentinel-check.mjs` — a synthetic book and chat whose every audit verdict is written
  down, and `install-sentinel.mjs`, which SYMLINKS both into `data/default-user/` so the same fixture
  can be opened in the Studio. That is the point of it: three faults shipped behind a green suite
  because every other check calls the classifier directly, one layer below what the UI uses. Symlinks
  rather than copies, so editing the fixture changes what the UI shows.
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
reference books and genre vocabulary against unmarked prose. That file is gitignored, because the
corpus is one person's chats; it also records which chats are unrepresentative and how.

Count **usable** messages, not raw lines: core and WA both drop `is_system` before scanning, and one
chat in the set is 65% hidden, so `CORPUS-MAP.md`'s line counts overstate it threefold.

Book-only measurements are not so limited: 40 books are available, 19 with no chat at all and 11 of
those third-party lorebooks never played — the widest sample of other people's key authoring here.
Say which population a two-part finding rests on; the chat half cannot be widened by adding books.

**A key existing in a book is not evidence that it is a good key**, and which books are curated is
NOT derivable from the data — STMB share is how keys were generated, not whether anyone reviewed
them. The per-book curation status is recorded in `eval/eval-data/README.md`; ask rather than infer.
An uncurated key list is output, not judgement, so "the author kept it" says nothing. A curated one
is judgement — the flags prompted a look, they were not applied in bulk, and keys were both removed
and deliberately kept. So both directions inform: a removal is agreement with the flag, a retention
is an override. What curation cannot tell you is anything about the keys the flag never surfaced,
since it shaped which keys got examined. Removals speak to precision, never to recall.

## Four stages, and the two rankings

Conflating these has produced several wrong conclusions here, more than once. The terms are fixed — use
them, and say which stage a claim is about.

**1. Retrieval** — `selectAndActivate` in `worldsapart.js`. The plugin scores chunks (cosine + BM25 over
chunk text), `fuseRetrieval` fuses them into the **retrieval ranking**, and `cutRetrieved`
(`selection.mjs`: count / elbow / dropoff, bounded by `maxVectorEntries`) keeps a prefix. **Keys are not
in this ranking** — `fuseRetrieval` is deliberately passed no `keywordWeight`.

**2. Activation** — whether an entry is ranked at all. Three independent routes: WA emits
`WORLDINFO_FORCE_ACTIVATE` on the retrieval winners; ST core keyword-matches whatever keys are live;
`constant`, decorators and sticky persistence. The result is core's `activated` map.

**3. Scoring** — `rankActivated`, on `WORLDINFO_SCAN_DONE`. Vector and chunk-text scores are looked up
from what retrieval stored, keyword score is computed over the scan window, and `fuseRanks` produces the
**layout ranking** — vector + text + keys, normalised by the signals an entry was eligible for.

**4. Selection** — the cuts, and there are two at different stages on different rankings. `cutRetrieved`
cuts the retrieval ranking by relevance (inside stage 1, before anything is activated). `applyBudget`
walks the layout ranking and deletes non-survivors from `activated` (after stage 3), sticky and constant
first so the budget only ever cuts into the retrieved block.

**Two rankings, not one.** `fuseRetrieval` decides what is activated; `fuseRanks` decides prompt order
and what survives the budget. **A change to `fuseRanks` can never surface an entry retrieval did not
return** — so no keyword weight, tilt or fusion change is a recall lever, only a precision one.

**The two vector-key settings sit at different stages, and only one is about activation.**
`suppressVectorKeys` blanks a vectorized entry's `key` into `waKeys` so core cannot keyword-ACTIVATE it
— stage 2. `scoreVectorKeys` decides whether those stashed keys are SCORED — stage 3, and it does not
reopen stage 2. Keys re-rank vector entries; they never admit one.

`eval/scene.mjs` models stages 1 and 3. The keyword fallback loop in `makeScorer` is stage 2, so it may
only admit what core could have activated: not disabled entries, and not vectorized entries under
`suppressVectorKeys`. Both guards were added after each had already inflated a reported number.

## countKey is the only matcher

`matcher.mjs` `countKey()` mirrors ST core's `matchKeys` — match flags, `/regex/` keys, `?` SmartKeys.
Anything that reports on how a key will behave (the audit, the pruner, the Studio's keyword colouring)
calls it rather than re-deriving the rules, so the audit can't drift from what actually fires at
runtime. The Aho-Corasick batching in `keyword-core.mjs` changes only when and how often it is called.

## Pure vs ST-coupled

`matcher.mjs`, `ranking.mjs`, `keyword-core.mjs`, `selection.mjs`, `smartkeys.mjs`, `sort.mjs` and `plugin/*.mjs` are
ST-free and node-importable, so the evals exercise the real shipped code instead of string-slicing it.
Settings and ST globals are injected by the caller, never imported. The ST/DOM half is
`worldsapart.js`, `keyword-tools.mjs`, `studio.mjs`, `ui-widgets.mjs`.

One exception survives: `eval/bulk-reorder-check.mjs` string-slices `planUidReindex` out of
`studio.mjs`, which imports ST and so can't be loaded under node.

**A slice is not a test of the shipped code, and it fails silently.** `applyBudget` was sliced too,
until a helper added just outside the sliced range made every run throw `ReferenceError` — and the
suite reported green, because it was being checked by grepping for `^FAIL` and a stack trace has no
such line. If something in the ST-coupled half needs a check, move it to the pure half first;
`applyBudget` turned out to reference nothing but its own arguments, which is the usual case.

## Composite keys use US (``), never NUL

Cache keys and row ids that join fields into one string (the summary cache in `summarizeQuery`, the
`rowId` helpers in `studio.mjs` and `keyword-tools.mjs`) separate with Unit Separator. It was `\0`, and
that made git treat those files as **binary**: `git diff` printed "Binary files differ" instead of the
change, with no line-level blame or three-way merge. `grep` silently produced no output and BSD `awk`
truncated the line at the NUL. US has none of those effects and, being a control character, still can't
collide with content the way a printable delimiter could.

Defects in ST core itself go in `upstream-st.md`, in the SillyTavern root — not in this repo.

## Plugin changes need a redeploy

Editing anything in `plugin/` requires `node deploy-plugin.mjs` and an ST restart. `/plugins/worlds-apart/`
is a generated copy; the settings panel shows a drift banner until the fingerprints match.
