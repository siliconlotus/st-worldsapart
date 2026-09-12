# WorldsApart

Only what isn't already in the file headers. Each module's header says what it is; read it before
changing it.

## Code comments say what is not obvious, never why

A comment is one of three things: what this is, when the name does not say it; what it does, when the
code does not show it; or a likely misstep in editing it — the `??` that must not become `||`, the order
a fixture must keep, the field core reads. Decisions, rationale and provenance are not comments: they
live in the design docs and `measured-claims.md`, and a misstep warning may cite a claim ID as the
pointer, in one line. A module header is at most two lines, a docblock one sentence plus the params
whose shape is not obvious, an inline comment one line.

`keyword-suggest-design.md` owns the suggester: what a good key is, what counts as success, and which
of the books' own keys are not evidence. Read it before proposing anything about `buildKeySuggest` or
how to measure it, and update it rather than re-deriving it in conversation.

`matcher-design.md` owns the matcher: how a key is matched, the SmartKeys grammar, and activation. Read
it before changing `countKey`, `smartkeys.mjs`, the fold, or anything about activation.

## The design docs record rules, not the working that produced them

They carry decisions and the facts whose absence would cause a mistake. The instance that convinced
someone, the counts behind it, and any account of what an earlier draft got wrong stay out.

**Terms are stable, or they are announced as new.** Use the doc's vocabulary exactly — seed, expander,
renderer, required forms, hypernymy, propriolization. Prefer the standard technical term to a coinage.

**Say which claims are measured, and keep the evidence out.** A measured claim states its finding and
cites its entry in `eval/eval-data/measured-claims.md` — "measured flat (F41)" — the gitignored register
that holds the numbers, the instrument and the n under a stable ID. Anything else is labelled an
assertion. A number that would not be worth registering is not worth stating. Unchallenged is not agreed.

**Propose a new claim before writing it down.** Cuts and restatements of settled content can just be
made; anything asserting what the doc does not already carry, with no measurement behind it, gets
proposed first. The test is structural, not a judgement about how controversial it looks.

## eval/ has three kinds of file

- `*-check.mjs` — self-checking. Run with no arguments; they print `ok`/`FAIL` or assert. This is the
  regression suite: `for f in eval/*-check.mjs; do node "$f"; done` should be silent-clean.
- `scene.mjs`, `metrics.mjs` — libraries, no CLI. `scene.mjs` loads and scores one graded scene;
  `metrics.mjs` holds the shared statistics. Every tool goes through them: a second copy of the
  gazetteer or the scorers must never appear (R22).
- `fixtures/` + `sentinel-check.mjs` — a synthetic book and chat whose every audit verdict is written
  down, and `install-sentinel.mjs`, which symlinks both into `data/default-user/` so the same fixture
  opens in the Studio. Symlinks rather than copies, so editing the fixture changes what the UI shows;
  every other check calls the classifier one layer below what the UI uses.
- everything else (`*-grid.mjs`, `param-screen`, `keyword-audit`, `relevance-regress`) — benchmark and
  analysis tools that take a vector index and/or lorebook path. Run bare they print a usage line and
  exit non-zero; that is not a test failure.

**`synthetic-data/` is a fourth thing: it generates graded data and measures nothing.**
`grade-pending.mjs` turns a row list (`{bundle, book, uid}`) into judge jobs and merges the answers back,
reading `eval-data` and writing `grade-jobs`. The rubric is `.claude/agents/scene-relevance.md`, where
Claude Code discovers subagents; `scene-relevance-min.md` is the minimal-prompt arm.

## A harness that spends anything appends; it never collects and writes at the end

No result may depend on the process finishing. Append each response as it arrives (JSONL) and key a
cache so a re-run resumes rather than re-paying.

**Order the sweep so every pass covers every arm.** Loop repeat-outermost and arm-innermost, so the
first pass is one full replicate and a decision to abandon the rest can be made early.

**Redirect the runner's output to a file and grep that; never filter the live stream.** `tail`
re-buffers the log and `grep <pattern>` discards the line that explains the failure (H4).

`pkill -f <script>` matches the wrapper shell too and kills queued jobs — kill by PID.

**Run long jobs so they stay visible and stoppable, not so they survive.** `nohup … &` vanishes from the
task list and outlives a deliberate stop; append-and-resume already makes a killed run cheap.

**Prompt work belongs on a local model with a fixed seed.** A seed pins output at any temperature, so a
prompt change is the only thing that can move the result. Hosted reasoning models honour neither seed nor
temperature (H1), so they can confirm a finding transfers but cannot be where it is found.

## Graded scenes: pool first, then pair

`n` is small and human grading is the scarce input. **Count the stories, not the files (C1)**: a story
is neither a chat file nor a character card — a long run continues into a new file, and one card carries
many stories. The closest key to a story is the lorebook, so group by that. Anything resting on corpus
statistics has an effective n nearer the story count than the scene count (C1). So prefer
`param-screen.mjs`, which contrasts one parameter at a time against each scene's own baseline and
reports the sign test; at single-digit n the finding is the direction plus the mean delta, and
"measured flat (ID), paired" is a legitimate outcome to write next to a default.

A pool built from one configuration penalises every configuration far from it, so a defaults review
scored against a single `/wa-grade` capture is not defensible. `/wa-super-grade` captures several
population-changing arms, unions what they surfaced and grades the union once; later rounds grade only
the delta. `judged@10` in `graded-scene-grid.mjs` is the stopping rule. It cannot always reach 10/10:
offline re-derivation ranks keyword-only rows core's gates would have rejected — probability rolls,
inclusion groups, delay and cooldown, character and tag filters, `@@dont_activate`,
`delayUntilRecursion`, triggers. Matching is WA's and `scene.mjs` models it through the same
`keywordScore` that fires at runtime.

**One `grades` array per row; each verdict names its rater, and `raters[].kind` says whether that rater
is a human or a judge** (`bundle-schema.md`). Nothing in the file holds a reduced value: read the value
in force through `grading.mjs` `gradeValue` (NaN when ungraded), never a stored scalar.

**No verdict is ever overwritten** (`bundle-schema.md`, *Verdict elements*). A re-grade appends beside
the one it disagrees with. The one exemption is a repeated pass, so a re-run of a merge is idempotent:
same rater and day for a human, same rubric, model and day for a judge.

**Grading is the expensive step, so extend a pool by delta and never re-pool.** Loaded grades are
subtracted (`/wa-super-grade`), carried onto a fresh capture (`graft-grades.mjs`), or built into jobs
only for what is pending (`grade-pending.mjs`). Where a shape change would do, migrate instead of
re-grading.

**A grade mean is only comparable at matched retrieval rank.** Grades fall steeply with pool depth, so a
pass that graded deeper reads as a harsher rater (G2). Match the band or make no comparison; a scene's
`entries` carry no rank, so join through the arm's `candidates`. Which rater graded a row correlates
with rank band, so `graded-scene-grid.mjs` can report that as a parameter effect. The human grades
predate the current rubric, so head disagreement is a changed construct as much as rater drift (G2).

**The contract does not reproduce evenly, and the relevant band is the unstable one** (G3): agreement
is weakest at the head of the pool, and every selection criterion is defined on the >= 3 line, so a
one-scene difference between arms is inside the noise. **Job size does not move grades** (G4); prefer
small batches anyway.

## Chat-based measurement uses the standard corpus

Anything measuring how keys behave against prose — firing rate, over-firing, discourse recurrence — runs
against the standard chat set in `eval/eval-data/README.md` (gitignored: the corpus is one person's
chats), not whatever chat is open. Count usable messages, not raw lines: core and WA both drop
`is_system`, and one chat in the set is mostly hidden (C3).

Book-only measurements draw on the wider book population (C2). **Count lineages, not files** (C2): a
book is versioned in place, and two versions of one book are not two books. Say which population a
two-part finding rests on; the chat half cannot be widened by adding books.

**A key existing in a book is not evidence that it is a good key**, and which books are curated is not
derivable from the data. The per-book curation status is in `eval/eval-data/README.md`; ask rather than
infer. In a curated book a removal is agreement with the flag and a retention is an override; curation
says nothing about keys the flag never surfaced, so removals speak to precision, never to recall.

## Four stages, and the two rankings

**WA is a selection system, not a ranking system.** What ships is the set that survives stage 4, chosen
by a threshold: `relevanceCut` tests each row's `E[credit]` against the cutoff on its own. Rank enters
only at stage 5, where the caps and the budget take a prefix of the layout order — rank decides what
overflows, never what belongs. So the validity score is F2 over the delivered set, set-based and
asymmetric — recall at grade >= 3, precision crediting a 2 at half (`metrics.mjs` `gradeCredit`)
(`matcher-design.md`, *Evidence → Two scores*). No window is imposed on it. nDCG and any score read at a
window the system is not asked to choose (`@R`) are diagnostics on the ordering, never evidence that the
system works. The terms are fixed; say which stage a claim is about.

**Three populations, and they cross-cut.** `memory` is STMB-marked and `reference` is everything else —
the tier an entry belongs to. `durable` is `constant` plus sticky: in the prompt by intent rather than
because relevance chose it. It is how a row got there, not what kind of thing it is.

**Sticky is read at two moments, so say which durable you mean.** The runtime reads the armed effect
(`isEffectActive`, `onScanDone`), and `walkOrder` hoists an armed sticky into stage 5's population, so it
never reaches stage 4's cut. The eval side sees no armed effect: `grading.mjs` `isDurable` reads a
capture row's `block`, which a dry run never sets to sticky, and `eval/scene.mjs` `isDurableEntry` reads
`constant`. So a sticky entry is durable at runtime once armed and is graded like any other activation.

**1. Retrieval** — `selectAndActivate` in `worldsapart.js`. Cosine only, with no admission test: the
plugin scores every chunk by mean-centered cosine, pools to entries and returns them in score order —
the **retrieval ranking** — bounded only by `admitCeiling` (`plugin/scoring.mjs`), which no measured book
approaches (R4). Keys and every lexical signal live at stage 3, not here (R1). Call the non-plugin route the **no-plugin
path**: ST's own `/api/vector` endpoint, taken when the plugin is absent or errors; it does not
mean-centre and does not pool server-side.

**2. Activation** — whether an entry is ranked at all. Three routes: WA emits `WORLDINFO_FORCE_ACTIVATE`
on the retrieval winners; core keyword-matches whatever keys are live; `constant`, decorators and sticky
persistence. The result is core's `activated` map.

**3. Scoring** — `onScanDone`, on `WORLDINFO_SCAN_DONE`. The vector score is what retrieval stored; the
text score is BM25 over entry content (`content-lexical.mjs`, over every entry, filtered by the entity
filter's term weights); the keyword score is computed over the scan window. Those plus `properNouns`
and `density` feed the fitted per-tier model (`relevance.mjs` `scoreRelevance`), whose `E[credit]` is the
**layout order** (`layout.mjs` `layoutOrder`, checked by `eval/layout-check.mjs`). It is not the prompt
order, which is a user setting applied to whatever survived. Which signal predicts best is a property of
the embedding model, so it is quoted with one (E14).

**4. Selection** — does this entry belong. The relevance cut drops a memory row whose `E[credit]` is
below the `relevanceCutoff` setting (`selection.mjs` `relevanceCut`). Memory only: a key on a reference
entry is the author declaring when it should be present, so reference rows are ordered and never cut. A
row the model could not score is kept — an absent verdict, not a negative one. The cutoff is one setting
for every model, not a property of the fit, whose own `cutoff` is provenance. It sees the dynamic block
only: constants, armed stickies and `@@promote`d rows are separate arrays that reach `walkOrder`
directly. Being a block is `promote`'s exemption; `selection.mjs` has no condition for it.

**5. Delivery** — what fits, and in what order. Nothing here judges an entry; every cut is a prefix of
the layout order. `delivery.mjs` `walkOrder` hoists constants, then armed stickies, then promoted rows
ahead of the dynamic block. The entry maxes decide how many, on nested populations — vector ⊆ capped ⊆
all, plus the per-book cap — with `maxVectorEntries` counted off the `vectorized` flag. `isDynamic` and
`isCapped` differ by exactly the promoted block: `maxDynamic` bounds relevance-selected material, the
vector and per-book caps bound capacity. The token budget decides how much. Both live in `applyBudget`,
which walks durable-first and returns the survivors; `onScanDone` deletes the rest from `activated`,
since `delivery.mjs` is ST-free and the map is core's.

**Three orderings, and only one is a ranking.** The retrieval ranking decides what is activated; the layout
order is what the caps and budget take a prefix of (`runState.lastLayoutOrder`); the prompt order is the
user's sort over the survivors (`runState.lastPromptOrder`). A change to the layout score can never
surface an entry retrieval did not return, so no scoring change is a recall lever, only a precision one.

`eval/scene.mjs` models stages 1 and 3; the keyword loop in `makeCandidateSet` is stage 2 and may only
admit what core could have activated — not disabled entries, not a `delayUntilRecursion` one on the
initial pass, not an `excludeRecursion` one on a later one. It runs to a fixpoint when the scene records
`recursive`; a scene that does not record it is read as recursion off.

## countKey is the only matcher

`matcher.mjs` `countKey()` mirrors ST core's `matchKeys` — match flags, `/regex/` keys, `?` SmartKeys.
Anything that reports on how a key will behave (the audit, the pruner, the Studio's colouring) calls it
rather than re-deriving the rules. The Aho-Corasick batching in `keyword-audit.mjs` changes only when
and how often it is called.

**Its checks are split by what they are faithful to.** `core-matcher-check.mjs` holds every claim about
how WA relates to core on an unmodified lorebook — the parity and the named divergences.
`matcher-check.mjs` holds WA's own semantics: SmartKeys, scoring units, the saturation curve, key
refusals, excerpts. An assertion that cites core as the authority goes in the first; one about what a
matched expression is worth goes in the second.

## Pure vs ST-coupled

`matcher.mjs`, `entity.mjs`, `query.mjs`, `keyedit.mjs`, `keyword-audit.mjs`, `keyword-suggest.mjs`, `lab.mjs`, `layout.mjs`,
`selection.mjs`, `delivery.mjs`, `smartkeys.mjs`, `sort.mjs`, `lexical.mjs`, `relevance.mjs` and
`automaton.mjs` and `plugin/*.mjs` are ST-free and node-importable, so the evals exercise the shipped code. Settings and ST
globals are injected by the caller, never imported. The ST/DOM half is `worldsapart.js`,
`keyword-tools.mjs`, `studio.mjs`, `ui-widgets.mjs`, `capture-ui.mjs`. `state.mjs` binds ST's store
rather than importing it, so the harness can read the shipped value of every knob.

**Every string a user reads goes through ST's i18n, and `eval/i18n-check.mjs` is the gate.** In the ST half,
injected HTML carries `data-i18n` (the English text is the key; `[title]…` for an attribute, `;` joining the
two, so no key may hold `;`) and code strings use the `t` tag, one whole sentence per template so a translation
can reorder it — a count whose noun changes is two templates, never a `${n === 1 ? '' : 's'}`. A pure module
whose prose reaches the screen (`keyword-audit.mjs` verdicts, `wholeWordAdvice`) takes the tag as a parameter
defaulting to plain interpolation, so the checks still assert English. An English constant a check or the docs
name (a flag, a sort label, a grade anchor) stays the key and is `translate()`d where drawn; the check
enumerates those tables. Nothing in the ST half may bind a local named `t`. `i18n/<locale>.json` must cover
exactly the extracted keys, and the check prints the missing ones; `--dump` lists every key for drafting a
locale. Console output, slash-command help and the SmartKey validator's messages are not translated.

**A harness may contain no literal that has an authoritative home.** Where the authority is a file,
import it; where the authority is the user, require it.

- a constant — the chunk settings, the BM25 k1/b, everything in `INTERNAL_KEYS` — is one value
  everywhere. Import it.
- a user setting — the embedding model, `relevanceCutoff` — has no knowable value, so the harness must
  be told (a flag, the env, or the bundle's own record) and refuse when none supplies it. No eval harness
  carries a fallback value for one.
- a derived constant — the fitted feature set — comes off the artifact it derives from. Read `features`
  out of the fit.
- a deterministic value — the tier — is computed, and is never a parameter at all.

One exception: `eval/bulk-reorder-check.mjs` string-slices `planUidReindex` out of `studio.mjs`, which
imports ST. **A slice is not a test of the shipped code, and it fails silently**: a helper added outside
the sliced range throws `ReferenceError`, and grepping for `^FAIL` reports green. If something in the
ST-coupled half needs a check, move it to the pure half first.

## Composite keys use US (``), never NUL

Cache keys and row ids that join fields into one string (the `rowId` helpers in `studio.mjs` and
`keyword-tools.mjs`) separate with Unit Separator. NUL makes git treat the file as binary and truncates
lines in BSD `awk`; a printable delimiter can collide with content.

Defects in ST core itself go in `upstream-st.md`, in the SillyTavern root — not in this repo.

## Plugin changes need a redeploy

Editing anything in `plugin/` requires `node deploy-plugin.mjs` and an ST restart. `/plugins/worlds-apart/`
is a generated copy; the settings panel shows a drift banner until the fingerprints match, and the
deploy prints the fingerprint.

**`PLUGIN_FILES` is the whole contents, not just what gets copied.** The deploy removes any top-level
file the manifest no longer names, so retiring a plugin module is one edit to `fingerprint.mjs`.
Directories are left alone.

**The matcher deploys into the plugin, so editing `matcher.mjs`, `smartkeys.mjs` or `automaton.mjs`
needs a redeploy too.** The manifest names them with `../extension/` paths and copies them FLAT beside
`index.js`: they may import each other only by bare `./name`, and nothing else in `extension/`.
`eval/plugin-deploy-check.mjs` is what fails when that breaks — the server would otherwise fail at load.
