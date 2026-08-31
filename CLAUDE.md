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
pass was half archaeology that had already answered its question.

**Terms are stable, or they are announced as new.** Use the doc's vocabulary exactly — seed, expander,
renderer, required forms, hypernymy, propriolization. A synonym reads as a different concept, and a
reader cannot tell whether something settled is being restated or something new introduced. Prefer the
standard technical term to a coinage: most invented terms here did not survive review, and two were
hiding errors — "breadth" was hypernymy, and "contraction" concealed the false claim that truncating a
key is a purely local operation (`Big Sur` → `Sur` is not).

**Say which claims are measured, and keep the evidence out.** A measured claim states its finding and
cites its entry in `eval/eval-data/measured-claims.md` — "measured flat (F41)" — the register that
holds the numbers, the instrument and the n under a stable ID, gitignored with the corpus it measures.
Anything else is labelled an assertion. A number that would not be worth registering is not worth
stating. Unchallenged is not agreed — a scan-window conversion invented in a single message was still
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
  — that path has already produced one serious BM25 error (R22), and two tools disagreeing would report the
  drift as a parameter effect.
- `fixtures/` + `sentinel-check.mjs` — a synthetic book and chat whose every audit verdict is written
  down, and `install-sentinel.mjs`, which SYMLINKS both into `data/default-user/` so the same fixture
  can be opened in the Studio. That is the point of it: faults have shipped behind a green suite
  because every other check calls the classifier directly, one layer below what the UI uses. Symlinks
  rather than copies, so editing the fixture changes what the UI shows.
- everything else (`*-grid.mjs`, `param-screen`, `keyword-audit`, `relevance-eval`, `summary-center`) —
  benchmark and analysis tools that need a vector index and/or lorebook path as an argument. Run bare they
  print a usage line and exit non-zero; that is not a test failure.

**`synthetic-data/` is a fourth thing: it GENERATES graded data and measures nothing.**
`grade-pending.mjs` turns a row list (`{bundle, book, uid}`) into judge jobs and merges the answers back,
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
whatever you did not think to anticipate — which is always the line that explains the failure. A run
has already failed unrecoverably this way: the filter kept what was anticipated and the error matched
none of it (H4). `> run.log 2>&1` then grep the log costs nothing and keeps the evidence.

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
readable at all. Hosted reasoning models honour neither seed nor temperature (measured, H1), so they
can confirm that a finding transfers but cannot be where it is found.

## Graded scenes: pool first, then pair

Three constraints shape every tuning claim, and each has tooling rather than a workaround.

`n` is small — a chat has to be long enough to have retrievable history and rich enough for some of it to be
irrelevant, and HUMAN grading is the scarce input. Deriving scenes offline (`synth-scenes.mjs`) made paired
screens workable without making the scenes independent draws. Count the STORIES, not the files (C1): half
the set is one continuous chat, split only because ST slows on a large file. **A story is neither a chat
file nor a character card**: a long run gets continued into a new file, and one card carries many stories —
`Isekai Adventure` is Ascensus AND Time Whore, which share nothing. The closest key to a story is the
LOREBOOK, so group by that and never take a per-story n off a file or card count. Anything resting on
corpus statistics has an effective n nearer the story count than the scene count (C1). The shared prefix
is deliberate: the second set was called `adventure-syn` and read as a fourth line for as long as nobody
checked its `primaryBook`. So prefer `param-screen.mjs`, which contrasts one parameter at a time against
each scene's own baseline and reports the sign test. At single-digit n nothing can reach significance, so
the finding is the direction plus the mean delta, and "measured flat (ID), paired" is a legitimate and
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

**`humanGrades` holds a person's verdicts; `llmGrades` holds a judge's. Nothing writes into both.** Read
the value in force through `metrics.mjs` `gradeValue` (NaN when ungraded) and the rater off which array a
verdict sits in: a non-empty `humanGrades` means a person set it, judge verdicts alone mean none has
looked. Nothing else can recover this — a judge's bundle and a human's are structurally identical, and a
filename convention is enforced by nothing. The two were once ONE column written at the same value, which
made an unreviewed row indistinguishable from a reviewed-and-agreed one — and human verdicts are a small
minority of the corpus (census: G1), so that ambiguity sat on nearly every row.

**No verdict is ever overwritten** (`bundle-schema.md`, *Verdict elements*). A re-grade appends beside the
one it disagrees with — that comparison is the only thing that says whether a rater or a rubric moved. The
one exemption is a repeated PASS, so a re-run of a merge is idempotent: same rater and day for a human,
same rubric, model and day for a judge.

**Grading is the expensive step, so extend a pool by delta and never re-pool.** Loaded grades are
subtracted (`/wa-super-grade`), carried onto a fresh capture (`graft-grades.mjs`), or built into jobs only
for what is still pending (`grade-pending.mjs`). Where a shape change would do, migrate instead of
re-grading.

**A grade mean is only comparable at matched retrieval rank.** Grades fall steeply with pool depth, so a
pass that graded deeper reads as a harsher rater when nothing about the rater changed. Measured on the rows
both raters graded, joined on shipped-arm rank (G2): the contract reads harsh at the head of the pool and
level deeper down. **Those human grades predate the current rubric**, so head disagreement is a changed
construct as much as rater drift, and no agreement statistic can tell you whether a rule the human never
applied is right. What the join can show is the shape of the change: the rule that reserves 4 for the
scene's current subject reads as a tightening rather than a redefinition (G2). Raw means across two passes
disagreed wildly and almost all of that was which rows each pass drew, not disagreement (G2). Match the
band or make no comparison; a scene's `entries` carry no rank, so join through the arm's `candidates`.

That cuts two ways once a bundle holds more than one pass. Which rater graded a row correlates with rank
band, so an arm whose wins come from deep rows is scored on a different scale than one winning at the head,
and `graded-scene-grid.mjs` will report that as a parameter effect.

**The contract does not reproduce evenly, and the relevant band is the unstable one.** Re-graded at the
original job size (G3) it agrees with itself on most rows, but agreement is weakest at the head of the
pool and a meaningful share of the rows originally graded >= 3 came back below it. The 0s are what is
stable. Since every selection criterion is defined on the >= 3 line, a single pass's relevant set carries
real noise there, and a one-scene difference between arms is inside it.

**Job size does not move grades, and was checked rather than assumed** — the obvious worry being that a
judge grades a prefix of a large job. Measured flat (G4). Prefer small batches anyway, since the paired
check caught a couple of real misses, but a large-batch pass does not need re-grading on size grounds.

## Chat-based measurement uses the standard corpus

Anything measuring how keys behave against *prose* — firing rate, over-firing, discourse recurrence —
runs against the standard chat set listed in `eval/eval-data/README.md`, not whatever chat is open. A
short branch cannot show whether a key over-fires, and the set is picked to span memory against
reference books and genre vocabulary against unmarked prose. That file is gitignored, because the
corpus is one person's chats; it also records which chats are unrepresentative and how.

Count **usable** messages, not raw lines: core and WA both drop `is_system` before scanning, and one
chat in the set is mostly hidden (C3), so `CORPUS-MAP.md`'s line counts badly overstate it.

Book-only measurements are not so limited: the book population is several times the chat-paired one,
including third-party lorebooks never played — the widest sample of other people's key authoring here
(C2). **Count LINEAGES, not files, here too** (C2): a book is versioned in place — `Daddy_Next_Door` is
many files and `Sommers_Pack__v22` is its v21 renamed, most entries byte-identical. Two versions of one
book are not two books. Say which population a two-part finding rests on; the chat half cannot be
widened by adding books.

**A key existing in a book is not evidence that it is a good key**, and which books are curated is
NOT derivable from the data — STMB share is how keys were generated, not whether anyone reviewed
them. The per-book curation status is recorded in `eval/eval-data/README.md`; ask rather than infer.
An uncurated key list is output, not judgement, so "the author kept it" says nothing. A curated one
is judgement — the flags prompted a look, they were not applied in bulk, and keys were both removed
and deliberately kept. So both directions inform: a removal is agreement with the flag, a retention
is an override. What curation cannot tell you is anything about the keys the flag never surfaced,
since it shaped which keys got examined. Removals speak to precision, never to recall.

## Four stages, and the two rankings

**WA is a selection system, not a ranking system.** What ships is the set that survives stage 4, and
that set is chosen by a THRESHOLD: `relevanceCut` tests each row's `E[credit]` against the cutoff on its
own, with no sort and no position. Rank enters only at stage 5, where the caps and the budget take a
prefix of the layout order — so rank decides what OVERFLOWS, never what belongs. So the validity score
is F2 over the DELIVERED SET, set-based and asymmetric — recall at grade >= 3, precision crediting a 2
at half (`metrics.mjs` `gradeCredit`), recall-weighted (`matcher-design.md`, *Evidence → Two scores*). **No
window is imposed on it: choosing the set is what is being graded.** nDCG and any score read at a
window the system is not asked to choose — `@R`, the top `relevant` rows — are DIAGNOSTICS on the
ordering, never evidence that the system works. `@R` bounds what the score can reach, since it is what
the delivered set would score if the count were predicted correctly.

Conflating these has produced several wrong conclusions here, more than once. The terms are fixed — use
them, and say which stage a claim is about.

**Three populations, and they cross-cut.** `memory` is STMB-marked and `reference` is everything that is
not — provenance, and the tier an entry belongs to. `durable` is `constant` plus sticky: in the prompt by
intent rather than because relevance chose it. It is how a row got there, not what kind of thing it is, so
a keyword-activated reference entry is not durable and a durable entry may be either tier.

**Sticky is read at two moments and they do not coincide, so say which durable you mean.** The runtime
reads the ARMED effect (`isEffectActive`, `worldsapart.js` `onScanDone`) — `walkOrder` hoists an armed
sticky into stage 5's population, so an entry that is in the prompt because an earlier turn put it there
never reaches stage 4's cut. The eval side reads the CONFIGURED
sticky value (`grading.mjs` `isDurable` of a capture row, `eval/scene.mjs` `isDurableEntry` of a raw
entry), because grading asks whether ranking would have chosen the entry and the runtime state cannot
answer that: a dry run arms nothing. So a configured sticky entry on the turn it keyword-activates is
inside the cliff's population and outside the graded one.

**1. Retrieval** — `selectAndActivate` in `worldsapart.js`. **Stage 1 is COSINE ONLY, and it has no
admission test at all**: the plugin scores every chunk by mean-centered cosine, `fuseRetrieval` orders
them into the **retrieval ranking**, and `retrieve` returns all of it. NOTHING drops a chunk. The only
thing that bounds the result is `admitCeiling` (`plugin/scoring.mjs`), counting entries (1000) on the
pooled plugin path and chunks (10000) on the no-plugin path.

**Call the non-plugin route the NO-PLUGIN PATH, not "the fallback".** It is ST's own `/api/vector`
endpoint, taken when the WA server plugin is absent or errors (`queryCollections`). It does not
mean-centre and does not pool server-side, so K counts chunks there and the client pools what K let
through. It has never had BM25; that is no longer a difference between the paths.

Everything lexical left this stage, and the removals are measured — see `plugin/scoring.mjs`'s header
before proposing any of it back. `scoreThreshold` was a p90 quantile whose every exclusion the `bm25 > 0`
clause beside it undid (removing it was a measured no-op, R1); BM25 then had no admission to serve;
`retrievalMode` chose between cosine and cosine+BM25 and lost its subject; the ENTITY FILTER builds BM25
query terms and so no longer runs here either. **Keys are not in this ranking, and neither is any lexical
signal** — both live at stage 3.

**2. Activation** — whether an entry is ranked at all. Three independent routes: WA emits
`WORLDINFO_FORCE_ACTIVATE` on the retrieval winners; ST core keyword-matches whatever keys are live;
`constant`, decorators and sticky persistence. The result is core's `activated` map.

**3. Scoring** — `onScanDone`, on `WORLDINFO_SCAN_DONE`. The vector score is looked up from what
retrieval stored; the TEXT score is BM25 over entry content, computed in the browser by
`content-lexical.mjs` over every entry (a superset of the vectorized chunks stage 1 sees) and filtered by
the entity filter's term weights; keyword score is computed over the scan window. Those signals plus
`properNouns` and `density` feed the fitted per-tier model (`relevance.mjs` `scoreRelevance`), whose
`E[credit]` is the **layout order** — built by `layout.mjs` `layoutOrder`, which takes every input as a
parameter and so is checkable under node (`eval/layout-check.mjs`) — the quantity stage 4 cuts on, and which stage 5's caps then take a prefix of. It is not
the PROMPT order, which is a user setting defaulting to `entry.order` and is applied to whatever
survived.

**This is where the lexical half of WA lives.** `content-lexical.mjs` computes BM25 over every entry's
content, a superset of the vectorized chunks stage 1 sees, and `onScanDone` reads it.

**Which signal predicts best is a property of the embedding model, so it is quoted with one** (E14).
Under bge-m3 text led; under Qwen3-Embedding-8B the order inverts and cosine leads. A ranking of the
signals carried across a model change is the claim to distrust.

**4. Selection** — DOES THIS ENTRY BELONG. The RELEVANCE CUT drops a memory row whose `E[credit]` is
below the `relevanceCutoff` setting (`selection.mjs` `relevanceCut`, from `onScanDone`), and it is the
one relevance decision *Principles* rules for. Three conditions: MEMORY ONLY, because a key on a reference
entry is the author declaring when it should be present, so reference rows are ordered and never cut; it
NEEDS A FIT, and a row the model could not score is kept — an absent verdict, not a negative one; and THE
CUTOFF IS ONE SETTING for every model, not a property of the fit, whose own `cutoff` is provenance. It
sees the DYNAMIC BLOCK only: constants and armed stickies are separate arrays that reach `walkOrder`
directly, so they are never scored for relevance.

**5. Delivery** — WHAT FITS, AND IN WHAT ORDER. Nothing here judges an entry: a row it drops cleared
stage 4 and lost to space, which is why every cut is a prefix of the layout order rather than a test
against a threshold. `delivery.mjs`
`walkOrder` hoists constants then armed stickies ahead of the dynamic block, which is what makes every
cap below a prefix cut; it cuts nothing. The ENTRY MAXES decide how many, on nested populations — vector ⊆ dynamic ⊆ all, plus the
per-book cap — with `maxVectorEntries` counted off the `vectorized` flag — the cap exists so that at most N vector
entries are added to the layout, which is a question about what an entry is. The TOKEN BUDGET decides how much. The maxes and the budget live in `applyBudget`,
which walks the layout order constant and sticky first — constant leads, because constant means always
and should only be cut when constants alone overflow — so every cap is a prefix cut, and returns the
survivors; `onScanDone` is what deletes the rest from `activated`, since `delivery.mjs` is ST-free
and the map is core's.

**THREE ORDERINGS, and only one is a ranking.** `fuseRetrieval` decides what is ACTIVATED; LAYOUT ORDER
is the score the caps and budget take a prefix of (`layout.mjs`, stashed as `runState.lastLayoutOrder`);
PROMPT ORDER is the user's sort over the survivors (`runState.lastPromptOrder`). **A change to the layout score can never surface an entry retrieval did not
return** — so no keyword weight, tilt or fusion change is a recall lever, only a precision one. With
stage 1 admitting everything, the retrieval ranking's ORDER now decides nothing except which entries
survive `admitCeiling`, which no measured book approaches (R4).

**`scoreVectorKeys` is stage 3 and does not reopen stage 2.** It decides whether a vectorized entry's
keys are SCORED, and asks that of the entry rather than of whether its keys are blank. Keys re-rank
vector entries; they never admit one, because stage 1 already admitted every vectorized entry it scored.
There is no longer a stage-2 counterpart: `suppressVectorKeys` blanked those keys to stop core
keyword-activating an entry its cosine had not earned, which stopped deciding anything once stage 1
admitted everything.

`eval/scene.mjs` models stages 1 and 3. The keyword loop in `makeCandidateSet` is stage 2, so it may only
admit what core could have activated — not disabled entries. That guard was added after it had already
inflated a reported number.

## countKey is the only matcher

`matcher.mjs` `countKey()` mirrors ST core's `matchKeys` — match flags, `/regex/` keys, `?` SmartKeys.
Anything that reports on how a key will behave (the audit, the pruner, the Studio's keyword colouring)
calls it rather than re-deriving the rules, so the audit can't drift from what actually fires at
runtime. The Aho-Corasick batching in `keyword-audit.mjs` changes only when and how often it is called.

**Its checks are split by what they are faithful to.** `core-matcher-check.mjs` holds every claim about
how WA relates to core on an unmodified lorebook — the parity AND the named divergences, since a
divergence only means something beside the parity it departs from. `matcher-check.mjs` holds WA's own
semantics, which core has no opinion about: SmartKeys, scoring units, the saturation curve, key refusals,
excerpts. A new assertion that cites core as the authority goes in the first; one about what a matched
expression is WORTH goes in the second.

## Pure vs ST-coupled

`matcher.mjs`, `entity.mjs`, `query.mjs`, `keyword-audit.mjs`, `keyword-suggest.mjs`, `layout.mjs`, `selection.mjs`, `delivery.mjs`, `smartkeys.mjs`, `sort.mjs`, `lexical.mjs`, `relevance.mjs` and `plugin/*.mjs` are
ST-free and node-importable, so the evals exercise the real shipped code instead of string-slicing it.
Settings and ST globals are injected by the caller, never imported. The ST/DOM half is
`worldsapart.js`, `keyword-tools.mjs`, `studio.mjs`, `ui-widgets.mjs`.

`state.mjs` BINDS ST's store rather than importing it, for the same reason: it holds the shipped value of
every knob, so the harness has to read them, and while it imported `extension_settings` it could not be
loaded from node at all. That is why `chunkConfig` carried its own copy of the chunk settings — a copy
that would have gone on chunking at 1750 the day production moved.

**A harness may contain no literal that has an authoritative home.** Where the authority is a file, import
it; where the authority is the user, require it. Four kinds, and they do not behave alike:

- a CONSTANT — the chunk settings, the BM25 k1/b, everything in `INTERNAL_KEYS`, reset every init and
  unreachable from the UI — is one value everywhere. Import it.
- a USER SETTING — the embedding model, `relevanceCutoff` — has no knowable value, so the harness must be
  TOLD: a flag, the env, or the bundle's own record, and REFUSE when none supplies it. No eval harness
  carries a fallback value for one.
- a DERIVED constant — the fitted feature set — comes off the artifact it derives from. Read `features`
  out of the fit; a restated list is how a refit shipped `cosine,text,keys` against a model fitted on
  `cosine,text,properNouns,density`.
- a DETERMINISTIC value — the tier — is computed, and is never a parameter at all.

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
is a generated copy; the settings panel shows a drift banner until the fingerprints match, and the deploy
prints the fingerprint so you can compare without opening the panel.

**`PLUGIN_FILES` is the whole contents, not just what gets copied.** The deploy REMOVES any top-level
file the manifest no longer names, so retiring a plugin module is one edit to `fingerprint.mjs` — leaving
the orphan behind is how a module the plugin stopped running goes on looking like plugin code. Directories
are left alone; a `node_modules` is yours to remove.
