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
  and `param-screen.mjs` go through them, so a second copy of the gazetteer or the scorers must never appear
  — that path has already produced one 74% BM25 error, and two tools disagreeing would report the drift as a
  parameter effect.
- `fixtures/` + `sentinel-check.mjs` — a synthetic book and chat whose every audit verdict is written
  down, and `install-sentinel.mjs`, which SYMLINKS both into `data/default-user/` so the same fixture
  can be opened in the Studio. That is the point of it: three faults shipped behind a green suite
  because every other check calls the classifier directly, one layer below what the UI uses. Symlinks
  rather than copies, so editing the fixture changes what the UI shows.
- everything else (`*-grid.mjs`, `param-screen`, `keyword-audit`, `relevance-eval`, `summary-center`) —
  benchmark and analysis tools that need a vector index and/or lorebook path as an argument. Run bare they
  print a usage line and exit non-zero; that is not a test failure.

**`synthetic-data/` is a fourth thing: it GENERATES graded data and measures nothing.**
`grade-pending.mjs` turns `graft-grades`' `*-pending` rows into judge jobs and merges the answers back,
reading `eval-data` and writing `grade-jobs` — both stay a level up, because that is what consumes them.
The rubric it dispatches against is `.claude/agents/scene-relevance.md`, which lives there because Claude
Code discovers subagents from that directory; `scene-relevance-min.md` is the minimal-prompt arm, for
measuring what the elaborated rubric is worth.

## A harness that spends anything APPENDS; it never collects and writes at the end

Model calls cost money, quota or minutes, so **no result may depend on the process finishing**. Append
each response as it arrives (JSONL is the easy shape) and key a cache so a re-run RESUMES rather than
re-paying. This is not a nicety: a buffered run was killed a few calls in and every one of them was
lost, and the same run's output could not be watched at all. Anything already on disk survives a kill,
a crash, or a decision to stop early.

**Order the sweep so every pass covers every arm.** Appending is worthless if the log cannot be read
mid-run. Loop repeat-outermost and arm-innermost — the first pass then gives one full replicate of
the design and the second gives within-arm pairs, so a decision to abandon the rest can be made at
20% spend. Sweeping one arm to exhaustion first means no comparison exists until the run is half
gone, which is when a buffered run would have been useless anyway.

**Redirect the runner's output to a file and grep THAT; never filter the live stream.** Piping through
`tail` re-buffers the log you just made incremental, and piping through `grep <pattern>` discards
whatever you did not think to anticipate — which is always the line that explains the failure. One run
produced zero rows and the reason was unrecoverable, because the filter kept two patterns and the
error matched neither. `> run.log 2>&1` then grep the log costs nothing and keeps the evidence.

Two more, same origin. `pkill -f <script>` matches the wrapper shell whose command line contains that
string, so it kills queued jobs too — kill by PID.

**Run long jobs so they stay VISIBLE AND STOPPABLE, not so they survive.** `nohup … &` detaches a run
from the session: it vanishes from the task list and outlives a deliberate stop, which takes control
away from whoever is watching it. Losing a run to a teardown is not the failure mode worth engineering
against — append-and-resume already makes a killed run cost only the calls in flight, which is the
whole point of it. Reach for tracked background execution and let the process be as mortal as the
session.

**Prompt work belongs on a local model with a fixed seed.** A seed pins output at any temperature, so
a prompt change is the only thing that can move the result — which is what makes a prompt A/B
readable at all. Hosted reasoning models honour neither seed nor temperature (measured: identical
requests, same seed, spent 1815 vs 935 reasoning tokens), so they can confirm that a finding
transfers but cannot be where it is found.

## Graded scenes: pool first, then pair

Three constraints shape every tuning claim, and each has tooling rather than a workaround.

`n` is small — a chat has to be long enough to have retrievable history and rich enough for some of it to be
irrelevant, and HUMAN grading is the scarce input. Deriving scenes offline (`synth-scenes.mjs`) raised it to
56, which is enough for a paired screen to clear Holm correction but not enough to make the scenes
independent draws. Count the LINES, not the files: the 56 sit on 4 chat files but only 3 books and 3
stories — `timewhore-syn` and `timewhore-sample-syn` are two chat files of the same story on one
lorebook, so 28 of the 56 share a corpus. Anything resting on corpus statistics has an effective n
nearer 3 than 56. The shared prefix is deliberate: the second set was called `adventure-syn` and read as
a fourth line for as long as nobody checked its `primaryBook`. So prefer `param-screen.mjs`, which contrasts one parameter at a time against each
scene's own baseline and reports the sign test. At n<6 nothing can reach p<0.05, so the finding is the
direction plus the mean delta, and "measured flat, n=X scenes across Y chats, paired" is a legitimate and
common outcome to write next to a default.

A pool built from one configuration penalises every configuration far from it, so a defaults review scored
against a single `/wa-grade` capture is not defensible. `/wa-super-grade` captures several
population-changing arms, unions what they surfaced and grades the union once; later rounds load earlier
samples and grade only the delta. `judged@10` in `graded-scene-grid.mjs` is the stopping rule — add arms
until the cells you care about stop showing gaps. It cannot always reach 10/10: offline re-derivation ranks
keyword-only rows core's GATES would have rejected — probability rolls, inclusion-group contention, delay
and cooldown, character and tag filters, `@@dont_activate`, `delayUntilRecursion`, triggers. Not matching,
which WA owns and `scene.mjs` models through the same `keywordScore` that fires at runtime. No arm surfaces
those either, since a probability roll is not made reproducible by adding one.

**`grade` is a human's verdict; `llmGrade` is a judge's. Only a human writes `grade`.** Read the value in
force through `metrics.mjs` `gradeValue` (human first, judge as fallback, NaN when ungraded) and the rater
off the shape: `grade` present means a human set it, `llmGrade` alone means none has looked. Nothing else
can recover this — a judge's bundle and a human's are structurally identical, and a filename convention is
enforced by nothing. The two were once written together at the same value, which made an unreviewed row
indistinguishable from a reviewed-and-agreed one; `eval/synthetic-data/split-rater.mjs` migrated the 8394
duplicated rows and refuses any row where the two differ. **Measured** after it: 611 human-only rows,
8394 judge-only, 0 reviewed.

**Grading is the expensive step, so extend a pool by delta and never re-pool.** Loaded grades are
subtracted (`/wa-super-grade`), carried onto a fresh capture (`graft-grades.mjs`), or built into jobs only
for what is still pending (`grade-pending.mjs`). Where a shape change would do, migrate instead of
re-grading.

**A grade mean is only comparable at matched retrieval rank.** Grades fall steeply with pool depth, so a
pass that graded deeper reads as a harsher rater when nothing about the rater changed. Measured, n=258 rows
graded by both the human rater and `scene-relevance.md`, joined on shipped-arm rank: the contract sits at
0.68x the human's mean at rank 0-19 and 1.03x at 20-44. **Those human grades predate the current rubric**, so
head disagreement is a changed construct as much as rater drift, and no agreement statistic can tell you
whether a rule the human never applied is right. What it can show is the shape of the change: the rule that
reserves 4 for the scene's current subject reads as a tightening rather than a redefinition — every 4 the
contract emitted fell on a row the human also graded 4, n=5 — while 19 of its 62 3s sit on rows the human
called 0-2. Quadratic weighted kappa is 0.690 over those 258 rows and Kendall tau-b averages 0.54 per scene,
but both are agreement statistics against a superseded construct, and neither is what the validity score
reads, which is which band a row lands in. Raw means across two passes said 0.26 vs 0.83 and almost all of
that was which rows each pass drew, not disagreement. Match the band or make no comparison; `grades` rows
carry no rank, so join through the arm's `candidates`.

That cuts two ways once a bundle holds more than one pass. Which rater graded a row correlates with rank
band, so an arm whose wins come from deep rows is scored on a different scale than one winning at the head,
and `graded-scene-grid.mjs` will report that as a parameter effect.

**The contract does not reproduce evenly, and the relevant band is the unstable one.** Re-graded at the
original job size — 179 rows, 12 jobs, 4 books — it agrees with itself 87.7% exactly and 98.3% within one
grade, so most rows are solid. But agreement is 79% at the head of the pool against 90-93% deeper, and 4 of
the 13 rows originally graded >= 3 came back below it. The 0s are what is stable. Since every selection
criterion is defined on the >= 3 line, a single pass's relevant set carries real noise there, and a
one-scene difference between arms is inside it.

**Job size does not move grades, and was checked rather than assumed.** 16-row jobs run ~140KB with single
entry lines to 28KB, which no one Read returns; the obvious worry is that a judge grades a prefix. Measured
flat: the same 64 rows at 4 rows/job scored +0.11 against 16 rows/job, 10 up and 5 down, sign test p~0.3.
Prefer small batches anyway — two of those 64 were real 0-to-3 catches — but a large-batch pass does not
need re-grading on size grounds.

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

**WA is a selection system that uses rank, not a ranking system.** What ships is the set that survives
stage 4 (today: the entry maxes and the token budget — see stage 4 on the removed cliff); rank is how that set gets chosen, not the product. So the validity score is set-based and
asymmetric — recall at grade >= 3, precision crediting a 2 at half (`metrics.mjs` `gradeCredit`),
recall-weighted (`matcher-design.md`,
*Evidence → Two scores*). nDCG over either ranking is a diagnostic for whether the ordering earns its
keep, and is not evidence that the system works.

Conflating these has produced several wrong conclusions here, more than once. The terms are fixed — use
them, and say which stage a claim is about.

**Three populations, and they cross-cut.** `memory` is STMB-marked and `reference` is everything that is
not — provenance, and the tier an entry belongs to. `durable` is `constant` plus sticky: in the prompt by
intent rather than because relevance chose it. It is how a row got there, not what kind of thing it is, so
a keyword-activated reference entry is not durable and a durable entry may be either tier.

**Sticky is read at two moments and they do not coincide, so say which durable you mean.** The runtime
reads the ARMED effect (`isEffectActive`, `worldsapart.js` `rankActivated`) — stage 4's cliff exempts an
entry that is in the prompt because an earlier turn put it there. The eval side reads the CONFIGURED
sticky value (`grading.mjs` `isDurable` of a capture row, `eval/scene.mjs` `isDurableEntry` of a raw
entry), because grading asks whether ranking would have chosen the entry and the runtime state cannot
answer that: a dry run arms nothing. So a configured sticky entry on the turn it keyword-activates is
inside the cliff's population and outside the graded one.

**1. Retrieval** — `selectAndActivate` in `worldsapart.js`. **Stage 1 is COSINE ONLY, and it has no
admission test at all**: the plugin scores every chunk by mean-centered cosine, `fuseRetrieval` orders
them into the **retrieval ranking**, and `retrieve` returns all of it. The only thing that drops a chunk
is `uncenteredGate`, a wrong-book failsafe on RAW cosine. The only thing that bounds the result is
`admitCeiling` (`plugin/scoring.mjs`), counting entries (1000) on the pooled plugin path and chunks
(10000) on the no-plugin path.

**Call the non-plugin route the NO-PLUGIN PATH, not "the fallback".** It is ST's own `/api/vector`
endpoint, taken when the WA server plugin is absent or errors (`queryCollections`). It does not
mean-centre and does not pool server-side, so K counts chunks there and the client pools what K let
through. It has never had BM25; that is no longer a difference between the paths.

Everything lexical left this stage, and the removals are measured — see `plugin/scoring.mjs`'s header
before proposing any of it back. `scoreThreshold` was a p90 quantile whose every exclusion the `bm25 > 0`
clause beside it undid (removing it moved admission by 6 entries in 10,103); BM25 then had no admission
to serve; `retrievalMode` chose between cosine and cosine+BM25 and lost its subject; the ENTITY FILTER
builds BM25 query terms and so no longer runs here either. **Keys are not in this ranking, and neither is
any lexical signal** — both live at stage 3.

**2. Activation** — whether an entry is ranked at all. Three independent routes: WA emits
`WORLDINFO_FORCE_ACTIVATE` on the retrieval winners; ST core keyword-matches whatever keys are live;
`constant`, decorators and sticky persistence. The result is core's `activated` map.

**3. Scoring** — `rankActivated`, on `WORLDINFO_SCAN_DONE`. The vector score is looked up from what
retrieval stored; the TEXT score is BM25 over entry content, computed in the browser by
`content-lexical.mjs` over every entry (a superset of the vectorized chunks stage 1 sees) and filtered by
the entity filter's term weights; keyword score is computed over the scan window. `fuseRanks` produces
the **layout ranking** — vector + text + keys, normalised by the signals an entry was eligible for, with
no mode switch: eligibility alone decides which columns an entry is scored on.

**This is where the lexical half of WA lives now.** Measured over 7536 judged rows on 69 scenes, text is
the strongest per-entry predictor of relevance — standardised logistic beta +0.756 against cosine's
+0.570 and keys' +0.069 (`eval/relevance-regress.mjs`). So "stage 1 dropped BM25" is not "WA dropped
BM25"; say which stage.

**4. Selection** — two cuts, both here, each answering one question over the layout ranking. **There is
no relevance cut**: the CLIFF (`cutRetrieved`, elbow/dropoff) was removed on 2026-08-16 rather than
retuned, because every figure behind it had graded a cut over the RETRIEVAL ranking and none transferred
when the cut moved to stage 4 — and an unmeasured relevance cut sits between every arm and its result.
So WA currently makes no relevance decision anywhere; that is a known gap against the one-decision rule,
not a delegation, and it waits on the layout score. `selection.mjs` `walkOrder` is what remains: it
hoists constants then armed stickies ahead of the dynamic block, which is what makes every cap below a
prefix cut. The ENTRY MAXES decide how many, on nested populations — vector ⊆ dynamic ⊆ all, plus the
per-book cap — with `maxVectorEntries` counted off the `vectorized` flag — the cap exists so that at most N vector
entries are added to the layout, which is a question about what an entry is. The TOKEN BUDGET decides how much. The maxes and the budget live in `applyBudget`,
which walks the layout ranking constant and sticky first — constant leads, because constant means always
and should only be cut when constants alone overflow — so every cap is a prefix cut, and returns the
survivors; `rankActivated` is what deletes the rest from `activated`, since `selection.mjs` is ST-free
and the map is core's.

**Two rankings, not one.** `fuseRetrieval` decides what is activated; `fuseRanks` decides prompt order
and what survives the budget. **A change to `fuseRanks` can never surface an entry retrieval did not
return** — so no keyword weight, tilt or fusion change is a recall lever, only a precision one. With
stage 1 admitting everything, the retrieval ranking's ORDER now decides nothing except which entries
survive `admitCeiling`, which no measured book approaches (largest: 208 vectorized entries).

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
