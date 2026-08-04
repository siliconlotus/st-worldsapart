# Codebase Concerns

**Analysis Date:** 2026-08-04

## Deployment & Integration Issues

### Plugin Deploy Drift Risk

**Issue:** Changes to `plugin/` files are not automatically reflected in the deployed copy at `/plugins/worlds-apart/`. The plugin must be redeployed and SillyTavern restarted for changes to take effect.

**Files:** `plugin/*.mjs`, `plugin/server.js`, `deploy-plugin.mjs`, `plugin/fingerprint.mjs`

**Impact:** 
- Modified plugin code silently fails to reload if developer forgets `node deploy-plugin.mjs` and restart
- UI shows a drift banner when fingerprints don't match, but developer may not see it until much later
- The fold (orthography normalization in `plugin/automaton.mjs`) changes are not live until redeploy, which is part of correctness, not just performance

**Current mitigation:** 
- Fingerprint system (`plugin/fingerprint.mjs`) detects drift via hash comparison
- Settings panel displays a drift banner (`extension/ui-widgets.mjs`, `extension/state.mjs`)
- CLAUDE.md documents the requirement

**Improvement path:** Automate this in development workflows. Consider a pre-commit hook or post-save file watcher that runs `deploy-plugin.mjs` automatically.

### String-Slicing Exception in Testing

**Issue:** `eval/bulk-reorder-check.mjs` contains an exception to the "no string-slicing" rule: it slices `planUidReindex` directly from `studio.mjs` source code because `studio.mjs` imports SillyTavern and DOM, making it unbundled under Node.

**Files:** `eval/bulk-reorder-check.mjs` (lines 1-13), `extension/studio.mjs` (contains `planUidReindex` function)

**Impact:**
- If `planUidReindex` signature changes or is renamed, the test silently breaks
- The slice is order-dependent on source text formatting
- This is the only node-importable test harness that re-derives shipped code instead of importing it

**Current mitigation:** CLAUDE.md explicitly documents this as a standing caveat

**Fix approach:** Extract `planUidReindex` to a pure `reindex.mjs` module so it can be imported directly. The ponytail comment in the code marks this: "promote planUidReindex to a pure module if a second harness ever needs it."

---

## Architecture & Design Gaps

### Gazetteer/Scorers Duplication Risk

**Issue:** The evaluation suite has a documented history of a 74% BM25 score inflation caused by a second copy of the gazetteer or scorers being accidentally introduced. This silently produces wrong rankings that appear like parameter effects rather than errors.

**Files:** 
- `eval/scene.mjs` (lines 1-12, 46, 252-255) — the centralized loader
- `eval/graded-scene-grid.mjs`, `eval/paired-arms.mjs` — both must call `loadScene` from `scene.mjs`
- `eval/paired-check.mjs` (lines 48-49, 104, 118) — guards against this

**Measured incident:** A raw book keys gazetteer (not suppressed) admitted 2.3x the terms and inflated BM25 scores by up to 74%, making a validated sample look unreproducible.

**Current mitigation:** 
- All scorers and scene loading are in `eval/scene.mjs` with no copies allowed
- Comments and guards warn developers not to re-derive
- `paired-check.mjs` has an explicit arm-reuse guard

**Risk:** If a new evaluation tool is written without using `loadScene`, or if someone copy-pastes gazetteer-loading logic, the error repeats silently.

**Improvement path:** Extract scene loading into a separate NPM-style module or function that other tools must import, never copy.

---

### C17 Divergence: Audit vs. Runtime Rules

**Issue:** While SillyTavern core owns activation, the matcher already diverges from core on orthography, NFC (Unicode normalization), and word boundaries. This means the Studio's audit reports on rules that are *not* what actually fires at runtime.

**Files:**
- `extension/smartkeys.mjs` (matcher rules)
- `extension/ranking.mjs` (countKey implementation vs. core's matchKeys)
- `plugin/automaton.mjs` (fold definition, orthography)
- `matcher-design.md` (lines 99-101) — documents the issue

**Impact:** An audit verdict ("this key fires in these places") is inaccurate for what core will actually activate. This is correctness-invisible — queries are accepted, but rankings differ subtly.

**Current mitigation:** Documented as "C17" and noted as dissolving once WA takes over activation (Bucket 2 in matcher-design.md).

**Improvement path:** Complete Bucket 2 (WA activation ownership). Once WA's rules are what fires, this divergence becomes moot.

---

### Bucket 2 Not Started (WA Activation Ownership)

**Issue:** Matcher-design.md Bucket 2 (WA taking over activation from core) is "not started" but "all design questions are settled; it is implementation." This is a major architectural transition that is blocked on nothing except implementation bandwidth.

**Files:** `matcher-design.md` (lines 47-73)

**Open work:**
- Core recursion buffer arrives pre-joined; WA must reconstruct segmentation when evaluating (`matcher-design.md:157-158`)
- `getExternallyActivated` seam is designed but not integrated (`matcher-design.md:60-64`)
- Key-side variant expansion (hyphen ↔ space, wildcards) deferred until WA owns activation (`matcher-design.md:95-98`)

**Impact:** 
- Until Bucket 2 ships, the audit diverges from runtime (C17 issue above)
- `keysecondary` rewriting to SmartKeys is not yet deployed
- Performance optimization of segmentation cannot be finalized

**Current state:** All design decisions are documented; implementation plan is clear.

---

## Test & Instrumentation Issues

### eq() Assertion Checker Exits Clean on Failure

**Issue:** The `eq()` function in `eval/metrics.mjs` (line 5) prints "FAIL" to console but exits with code 0. Checking the eval suite by exit code alone misses assertion failures.

**Files:** `eval/metrics.mjs` (lines 1-5), any eval tool that uses `eq()`

**Impact:** A regression in graded-scene evaluation can pass `echo $?` checks and CI pipelines that check only exit codes.

**Current mitigation:** CLAUDE.md documents this as a standing caveat (matcher-design.md:191). The correct check is: `grep -E '^FAIL' eval/*.mjs`.

**Fix approach:** Make `eq()` exit non-zero on failure, or separate assertion and logging concerns so the harness owns the exit code.

---

### Regression Suite Requires Manual Grep

**Issue:** The eval test harness (`for f in eval/*-check.mjs; do node "$f"; done`) completes successfully even if several `FAIL` lines were printed.

**Files:** CLAUDE.md (eval/ section, line 42)

**Impact:** CI/CD pipelines and developer scripts cannot rely on exit codes to detect test failures.

**Current practice:** Developers must manually scan output for "FAIL" or use `grep '^FAIL'` after running.

**Improvement path:** Wrap the regression suite in a script that:
1. Runs all checks
2. Collects output
3. Greps for "^FAIL"
4. Exits non-zero if any found
5. Prints summary

---

## Performance & Resource Concerns

### Synchronous buildKeySuggest on Main Thread

**Issue:** `buildKeySuggest` is synchronous and can take 2.6–5.8 seconds depending on the book's chat history and versioning. It blocks the main thread when the Studio opens.

**Files:**
- `extension/studio.mjs` (lines 620-624) — lazy initialization comment
- `extension/keyword-core.mjs` (contains `buildKeySuggest`)

**Measured:** On a book versioned heavily mid-story: 5.8s; on a cleanly bound one with a sibling branch: 5.8s vs. 2.6s depending on pool configuration.

**Current mitigation:** Lazy initialization (`ensureSuggest` function) defers the build until first use (the ⚡ suggest button). Comments note "Worth revisiting if the build ever moves off the main thread."

**Tradeoff documented:** Multi-second synchronous rebuild every time the Studio opens is deemed worse than ~4pp of dead candidates (entries that should be suggested but aren't), so the build is not run on every open.

**Improvement path:** 
1. Move `buildKeySuggest` off the main thread (Web Worker or async batching)
2. Pre-warm the cache on idle callback once available off-thread
3. Consider caching results per book+settings combination

---

## Design Work Not Yet Started

### Keyword Suggester i18n Not Implemented

**Issue:** The suggester has no i18n support. Zipf frequency data (`ZIPF_EN`) is English-only, causing non-English books to be misscored.

**Files:** 
- `keyword-suggest-design.md` (lines 169-178) — "Suggester i18n, none of it started"
- `extension/keyword-core.mjs` — scoring uses `ZIPF_EN`

**Specific problems:**
- Function words in non-English (avec, toujours, siempre, porque, immer) score as maximally rare (z=0)
- Hyphenated compounds (`well-known`) absent from table, scored as rare
- `stems()` knows English inflections only; fallback cannot rescue non-English words
- The frequency gate would propose non-English common words as prime keys

**Impact:** Books in French, Spanish, German, etc., get poor key suggestions where English books succeed.

**Current state:** Design section explicitly labels this as "not started"; no implementation path documented.

---

### Accent Variants Not Handled

**Issue:** Accent variants (Gérard/Gerard, Geneviève/Genevieve) are not suggested as keys, even though models write both forms and in some corpora the unaccented form appears more often.

**Files:** `keyword-suggest-design.md` (lines 180-182) — marked as belonging in the suggester, not the matcher

**Why not in matcher:** Whether stripping accents is safe depends on language, so it needs human review. Correctness belongs in the reviewed layer (suggester), not the silent matcher.

**Current state:** Documented as desired but not implemented.

---

### Renderer Thresholds Not Yet Determined

**Issue:** The suggester's renderer stage (which collapses a morphological family into final keys) has two open thresholds:

**Files:** `keyword-suggest-design.md` (lines 539-550)

1. **Collision-free threshold:** How clean is clean enough? The measure exists (`strictClean(k) / scan(k, cs, false).total` in `keyword-core.mjs:225`), banded by severity. Open question: do stems use the same bands as short keys, or earn their own?

2. **Minimum substring length:** "scry" and "scried" share only "scr" (too short). "thaumaturg" at 9 characters is fine. The floor interacts with `KEY_MIN_LENGTH` (4) and likely should be a collision bound, not a character count.

**Impact:** Keys suggested by the renderer may be too broad (sub-stems that collide widely) or too narrow (families collapse to nothing).

**Measurement required:** Run the backoff over gold families and read cases where the suggested key differs from human judgment.

---

## Unsettled Design Questions

### Anchor Provenance for Third-Party Books

**Issue:** Measurement of key quality for books beyond the two gold sets (Sommers, Richard) requires anchor provenance: human-vetted seed keys per book.

**Files:** `keyword-suggest-design.md` (item 2, line 558)

**Problem:** Books beyond the curated sets have no anchors, so their key quality cannot be measured against gold standard. "Already approved" cannot be read as a decision because standards drift.

**Current state:** Blocking measurement; no solution documented.

---

### LLM-as-Proxy Validation

**Issue:** Model-generated keys must clear validation against gold (Foxbridge and Richard books) before they can be assumed to be a good proxy for human judgment elsewhere.

**Files:** `keyword-suggest-design.md` (item 3, line 560-564)

**Ordering problem:** Testing lexical-only against a badly-configured LLM arm would make "lexical-only wins" an artifact of bad LLM config, not actual advantage. Solution: pool across several LLM configurations and treat the residual as lower bound (like `/wa-super-grade` pools retrieval arms).

**Current state:** Design documented; implementation waiting on infrastructure.

---

### Chat Corpus Drift Risk

**Issue:** Evaluation corpus (`eval/eval-data/README.md`) is gitignored (private chats) and not fully documented for reproducibility. `CORPUS-MAP.md` line counts are known to overstate usable messages by 3x in some cases.

**Files:**
- `eval/eval-data/README.md` (documents corpus)
- `eval/eval-data/CORPUS-MAP.md` (line counts, known inaccurate)
- `.gitignore` (line 147: eval-data/)

**Impact:** 
- A second measurement run by someone else cannot reproduce results without access to the same private chats
- `CORPUS-MAP.md` overcounts, e.g., one chat is 65% hidden (`is_system` messages), so line count is 3x actual usable messages

**Current state:** Documented as a limitation; trade-off accepted for privacy.

---

### Nested Short Forms Ambiguity

**Issue:** A short form nested inside a longer form (e.g., "Kim" inside "Kimberly") can be either a substring defect or a deliberate weighting choice. Some Sommers entries keep the short form ON PURPOSE to weight the term.

**Files:** `keyword-suggest-design.md` (item 0, line 532-536)

**Impact:** A per-entry collapse diagnostic cannot fix nesting automatically; it must be advisory only, and the user decides whether term weighting this way is better than explicit weight syntax.

**Current state:** Diagnostic designed but not deployed; decision needed on when to show it.

---

## Data & Instrumentation Gaps

### Sentinel Fixture Symlink Dependency

**Issue:** `eval/fixtures/` + `install-sentinel.mjs` uses symlinks to link a synthetic test fixture into `data/default-user/` so the same fixture can be opened in the Studio. Three separate faults shipped behind a green test suite because every other check called the classifier directly, one layer below what the UI uses.

**Files:**
- `eval/fixtures/` (sentinel book and chat)
- `eval/fixtures/install-sentinel.mjs` (creates symlinks)
- `eval/sentinel-check.mjs` (tests the fixture)
- `CLAUDE.md` (line 49-53) — documents the design

**Risk:** If symlinks are lost (moved repo, Windows without symlink support, .gitignore mistake), the UI half stops being tested.

**Current mitigation:** Symlinks rather than copies, so editing the fixture changes what the UI shows.

**Improvement path:** Document symlink requirement clearly; consider a pre-flight check that verifies symlinks are present before running tests.

---

### Graded Scene Pool Bias

**Issue:** A pool built from one configuration penalizes every configuration far from it, producing biased measurements. Design explicitly requires `/wa-super-grade` (multi-arm capture) before a full review, not a single `/wa-grade` capture.

**Files:** `CLAUDE.md` (lines 68-73)

**Stopping rule:** `judged@10` in `graded-scene-grid.mjs` — add arms until cells you care about stop showing gaps.

**Impact:** A default-settings review scored against a single graded scene is not defensible statistically.

**Current practice:** Required by design; noted in CLAUDE.md.

---

### Small-n Statistical Floor

**Issue:** Single-digit n (number of scenes) has a hard statistical floor. At n<6, nothing can reach p<0.05 under sign test.

**Files:** `CLAUDE.md` (line 64-66), `eval/metrics.mjs` (signTest function, lines 22-58)

**Minimum reportable findings at n<6:**
- 6/6 one-way: p=0.031 (barely significant)
- 5/5: p=0.063 (marginal)
- 4/4: p=0.125 (weak)
- 3/3: p=0.25 (not significant)

**Current practice:** Report as "direction + mean delta, measured flat, n=X scenes across Y chats, paired" rather than claiming significance.

**Implication:** Claims about defaults must be phrased carefully; "measured flat" is honest reporting, not a failed test.

---

## Security & Validation

### Unit Separator Historical Fragility

**Issue:** Composite keys and row IDs use Unit Separator (\\x1f) now, but were NUL (\\0) before. The history: NUL made git treat files as **binary**, preventing diffs, blame, and three-way merge on files containing composite keys.

**Files:**
- `extension/grading.mjs` (line 142) — documents the decision
- `extension/studio.mjs` — rowId helpers use Unit Separator
- `extension/keyword-tools.mjs` — rowId helpers use Unit Separator

**Risks if reverted:**
- `git diff` shows "Binary files differ" instead of line-level diffs
- `grep` silently produces no output on NUL-terminated fields
- BSD `awk` truncates lines at NUL
- Version control history becomes unreadable

**Current state:** US documented and in place. No risk if not reverted.

---

## Open Work Summary

| Item | Category | Blocker | Impact |
|------|----------|---------|--------|
| Plugin redeploy requirement | Integration | None — documented | Silently stale code |
| Bucket 2 (WA activation) | Architecture | Implementation only | Unfinished core feature |
| Gazetteer duplication risk | Quality | Vigilance | Silent 74% errors |
| Suggester i18n | Feature completeness | Design + implementation | Non-English books |
| Renderer thresholds | Quality | Measurement | Key coverage/precision tradeoff |
| Sentinel symlinks | Testing | None — designed | Fixture availability |
| Chat corpus reproducibility | Measurement | Privacy/design tradeoff | Non-reproducible results |

---

*Concerns audit: 2026-08-04*
