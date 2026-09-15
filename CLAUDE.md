# WorldsApart

Only what isn't already in the file headers. Each module's header says what it is; read it before
changing it.

## Code comments say what is not obvious, never why

A comment is one of three things: what this is, when the name does not say it; what it does, when the
code does not show it; or a likely misstep in editing it — the `??` that must not become `||`, the order
a fixture must keep, the field core reads. Decisions, rationale and provenance are not comments: they
live in the docs, and a misstep warning may cite one in a line. A module header is at most two lines, a docblock one sentence plus the params
whose shape is not obvious, an inline comment one line.

## The docs document how the code works

`docs/matching.md` owns the matcher and the pipeline: how a key is written and matched, and what each
stage does. `docs/keyword-suggestions.md` owns the suggester and the audit. `eval/st-worldinfo.md` is ST
core's own scan; `eval/bundle-schema.md` the graded bundle; `eval/embedding-models.md` the model guidance;
`SMARTKEYS.md` the user's page, which must neither run ahead of the code nor lag it. Read the owning
doc before changing what it covers, and update it rather than re-deriving it in conversation.

A doc carries how the code works now and the architectural decisions behind it, and nothing else: not
how it used to work, how it could work, how it does not work, speculation, or measurements nothing
hinges on. Options against a behaviour that stands go in a GitHub issue, never in the doc.

**Terms are stable, or they are announced as new.** Use the doc's vocabulary exactly, and prefer the
standard technical term to a coinage.

**A measured claim cites its register entry by ID; anything else is an assertion and says so.**
`docs/measured-claims.md` holds the claims reproducible without a particular corpus. Claims resting on
particular books or chats share its ID space but are not published, so a cited ID that is not in that
file resolves for the author and not for a reader.

## What is in test/ and eval/

`test/` is the regression suite and nothing else; `eval/` is the research harness, and only its `lib/` is load-bearing
outside the harness — the suite imports it, and so does the shipped `deploy-plugin.mjs`. `.github/workflows/checks.yml`
runs `test/` on every pull request and on pushes to `staging` and `release`; it prints a failing check's whole output,
since a throw carries no `FAIL` line.

- `test/*-check.mjs` — self-checking, run with no arguments. The suite is run by exit code:
  `for f in test/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`. `eq()` sets
  `process.exitCode`, so a failed assertion and a thrown error are the same signal; grepping for `^FAIL`
  misses throws.
- `test/fixtures/` + `sentinel-check.mjs` — a synthetic book and chat whose every audit verdict is
  written down, and `install-sentinel.mjs`, which symlinks both into `data/default-user/` so the same
  fixture opens in the Studio. Symlinks rather than copies, so editing the fixture changes what the UI
  shows; every other check calls the classifier one layer below what the UI uses.
  `test/genre-cases.mjs` is test data on the same footing.
- `eval/lib/` — libraries, no CLI and no argv. `scene.mjs` loads and scores one graded scene;
  `metrics.mjs` holds the shared statistics; `corpus.mjs` resolves which lorebooks a run reads;
  `reindex.mjs` builds a collection and `global-basis.mjs` the shared basis. Every tool goes through
  them: a second copy of the gazetteer or the scorers must never appear, and no tool names a book.
  **A library's paths are module-relative, so moving one silently repoints them** — `corpus-check.mjs`
  pins `ROSTER` and `WORLDS` for that reason.
- `eval/synthetic-data/` — generates graded data and measures nothing. `grade-pending.mjs` turns a row
  list (`{bundle, book, uid}`) into judge jobs and merges the answers back, reading `eval-data` and
  writing `grade-jobs`. The rubric is `.claude/agents/scene-relevance.md`, where Claude Code discovers
  subagents; `scene-relevance-min.md` is the minimal-prompt arm.
- everything else in `eval/` (`*-grid.mjs`, `param-screen`, `keyword-audit`, `relevance-regress`) —
  benchmark and analysis tools that take a vector index and/or lorebook path. Run bare they print a
  usage line and exit non-zero; that is not a test failure.

**A module is a library or a CLI, never both.** The library goes in `lib/` and takes no argv; the CLI keeps
the name a person types (`node eval/reindex.mjs …`) and is a thin wrapper over it. Within one module the
same split holds: `corpus.mjs` has `evalBooks()`, which computes and throws, and `booksOrExit()`, which
parses argv and exits.

## A harness that spends anything appends; it never collects and writes at the end

No result may depend on the process finishing. Append each response as it arrives (JSONL) and key a
cache so a re-run resumes rather than re-paying.

**Order the sweep so every pass covers every arm.** Loop repeat-outermost and arm-innermost, so the
first pass is one full replicate and a decision to abandon the rest can be made early.

**Redirect the runner's output to a file and grep that; never filter the live stream.** `tail`
re-buffers the log and `grep <pattern>` discards the line that explains the failure.

`pkill -f <script>` matches the wrapper shell too and kills queued jobs — kill by PID.

**Run long jobs so they stay visible and stoppable, not so they survive.** `nohup … &` vanishes from the
task list and outlives a deliberate stop; append-and-resume already makes a killed run cheap.

**Prompt work belongs on a local model with a fixed seed.** A seed pins output at any temperature, so a
prompt change is the only thing that can move the result. Hosted reasoning models honour neither seed nor
temperature, so they can confirm a finding transfers but cannot be where it is found.

## Four stages, and the three orderings

The stages are `docs/matching.md`'s: **1. Retrieval** (`retrieve`, cosine only, no admission test),
**2. Activation** (`selectAndActivate`, one force-activate; core's `activated` map is the result),
**3. Scoring** (`onScanDone`: text, keys, `properNouns`, `density` and the cosine into the fitted
per-tier model, whose `E[credit]` is the layout order), **4. Selection** (`relevanceCut`, the dynamic
block only, both tiers at one cutoff for every model), **5. Delivery** (`applyBudget`, every cap a
prefix of the layout order). Say which stage a claim is about.

**WA is a selection system, not a ranking system.** What ships is the set that survives stage 4, chosen
by a threshold on each row alone; rank decides what overflows at stage 5, never what belongs. So the
validity score is F2 over the delivered set, set-based and asymmetric — recall at grade >= 3, precision
crediting a 2 at half (`metrics.mjs` `gradeCredit`) — with no window imposed on it. nDCG and any score
read at a window the system is not asked to choose (`@R`) are diagnostics on the ordering, never
evidence that the system works.

**Three orderings, and only one is a ranking.** The retrieval ranking decides what is activated; the
layout order is what the caps and budget take a prefix of (`runState.lastLayoutOrder`); the prompt
order is the user's sort over the survivors (`runState.lastPromptOrder`). A change to the layout score
can never surface an entry retrieval did not return, so no scoring change is a recall lever, only a
precision one.

**Three populations, and they cross-cut.** `memory` is STMB-marked and `reference` is everything else —
the tier an entry belongs to. `durable` is `constant` plus sticky: in the prompt by intent rather than
because relevance chose it — how a row got there, not what kind of thing it is. Sticky is read at two
moments: the runtime reads the armed effect and hoists it past the cut, while the eval side reads a
capture row's `block`, which a dry run never sets to sticky, so a sticky entry is durable at runtime
once armed and is graded like any other activation.

`eval/lib/scene.mjs` models stages 1 and 3; the keyword loop in `makeCandidateSet` is stage 2 and may only
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

Every module under `extension/` and `plugin/` is ST-free and node-importable, so the evals exercise the
shipped code. The ST-coupled files are `st/` plus `worldsapart.js`, which is the ST half proper and sits
at the root because `manifest.json` names it; `plugin/server.js` is coupled to ST's SERVER half
(`../../src/`) instead, on a path that resolves from the deploy location, so it is not node-importable
either. `test/st-half.mjs` declares both lists; `st-boundary-check.mjs` fails when anything else reaches
past the repo root, and when a pure module imports the ST half. Settings and ST globals are injected by
the caller, never imported; `state.mjs` binds ST's store rather than importing it, so the harness can
read the shipped value of every knob.

**Every string a user reads goes through ST's i18n, and `test/i18n-check.mjs` is the gate.** In the ST half,
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
  carries a fallback value for one. **Which lorebooks a sweep reads is one of these**: `corpus.mjs`
  `booksOrExit()` takes them from `--books A.json,B.json` or the gitignored `eval-data/books.json`, so no
  tool names a book and any developer can point the evals at a corpus they know.
- a derived constant — the fitted feature set — comes off the artifact it derives from. Read `features`
  out of the fit.
- a deterministic value — the tier — is computed, and is never a parameter at all.

Where a check needs something from the ST-coupled half, the fix is to move that thing into a pure module
first, as `planUidReindex` was moved into `keyedit.mjs` for `bulk-reorder-check.mjs`. A check that reads
shipped code as text rather than importing it is not testing the shipped code, and it fails silently.

## Composite keys use US (``), never NUL

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
`test/plugin-deploy-check.mjs` is what fails when that breaks — the server would otherwise fail at load.
