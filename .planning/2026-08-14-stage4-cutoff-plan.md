# Stage-4 Cutoff Rearchitecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move WorldsApart's single relevance decision from stage 1 (cutting the retrieval ranking before keys or activation exist) to stage 4 (cutting the layout ranking, where all three signals and the budget meet).

**Architecture:** `retrieve()` stops calling `cutRetrieved` and admits everything up to a fixed ceiling. Stage 4 then makes three cuts, each answering one question: the **cliff** (relevance, over the dynamic block, taking no count), the **entry maxes** (how many — vector ⊆ dynamic ⊆ all), and the **token budget** (how much). `rankActivated()` gains the cliff ahead of `applyBudget`, which holds the other two. `maxVectorEntries` moves from a stage-1 activation cap to a stage-4 cap inside `applyBudget`. Every default holds at its current value, so any behaviour difference is attributable to the cut moving rather than to a number.

**Tech Stack:** Plain ES modules, no build step, no test framework. Node ≥ 18 for the eval half; the browser for the SillyTavern half.

## Global Constraints

- **Pure vs ST-coupled.** `matcher.mjs`, `ranking.mjs`, `keyword-core.mjs`, `selection.mjs`, `smartkeys.mjs`, `sort.mjs`, `plugin/*.mjs` are ST-free and node-importable. Settings and ST globals are injected by the caller, never imported. `worldsapart.js`, `keyword-tools.mjs`, `studio.mjs`, `ui-widgets.mjs` are the ST/DOM half and cannot be checked offline.
- **If something in the ST-coupled half needs a check, move it to the pure half first.** Tasks 6-8 are deliberately thin because Tasks 1-5 already hold their logic.
- **The check suite is run by exit code:** `for f in eval/*-check.mjs; do node "$f" || echo "FAIL $f"; done`. A failed assertion and a thrown error are the same signal. Grepping for `^FAIL` alone misses thrown errors.
- **No second copy of shared logic.** `countKey` is the only matcher; `scene.mjs` is the only gazetteer/scorer. The cliff gets the same treatment — one implementation, called from both the runtime and the harnesses.
- **Composite keys use US (`String.fromCharCode(31)`), never NUL.**
- **Do not touch** `scoreThreshold`, `uncenteredGate`, the `bm25 > 0` admission clause, `maxTotalEntries`, `maxDynamicEntries`, `ownActivation`, or anything under *Out of scope* in the spec.
- **One `plugin/` change, deliberately.** `admitCeiling` lands in `plugin/scoring.mjs` beside `poolEntries`, whose behaviour is what decides whether K counts entries or chunks. That is a fingerprint change: the task ends with `node deploy-plugin.mjs`, and the settings panel shows a drift banner until it runs. The server's behaviour does not change — the function is called client-side — so the redeploy exists to clear the banner and keep the deployed copy honest. Nothing else under `plugin/` is touched.
- **Three populations, defined in `eval/scene.mjs`** as `isMemory` / `isReference` / `isDurableEntry`,
  with `isDurable` in `extension/grading.mjs` asking the durable question of a capture row. They
  cross-cut: a keyword-activated reference entry is not durable, and a durable entry may be either tier.
  The cliff cuts memory and reference; it never cuts durable. Import them, never re-derive them.
- **Design-doc discipline:** docs record rules, not the working that produced them. Terms are fixed — retrieval ranking, layout ranking, stage 1-4, admit, arbitrate. Say which claims are measured.
- **Commit style:** declarative sentence subject, no conventional-commit prefix, body explaining why. End with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Spec:** `.planning/2026-08-14-stage4-cutoff-rearchitecture.md`. Read it before Task 1.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `extension/selection.mjs` | Stage 4's arithmetic: `cutRetrieved` (the cliff), the new `cutDynamic` (assembles the ranked list and names cliff losers), and `applyBudget` (now with a vector cap). |
| `plugin/scoring.mjs` | Gains `admitCeiling` — stage 1's bound, beside `poolEntries`, which is what makes the number mean entries or chunks. |
| `extension/state.mjs` | Settings and their documentation. `maxVectorEntries` re-homed to stage 4, `vectorCutoff` modes changed, superseded measurements deleted. |
| `worldsapart.js` | Wiring only. `retrieve()` admits, `rankActivated()` calls `cutDynamic` then `applyBudget`. |
| `eval/scene.mjs` | Gains `cliffCut`, the single place a harness applies the cliff to a fused layout ranking. |
| `eval/graded-scene-grid.mjs`, `eval/cutoff-grid.mjs` | Call `cliffCut` instead of applying `cutRetrieved` to a retrieval ranking. |
| `eval/elbow-check.mjs`, `eval/budget-check.mjs` | The pure checks for everything above. |

---

### Task 1: `applyBudget` gains a vector cap

`budget-check.mjs`'s own header already claims "vector ⊆ dynamic ⊆ all" and only two of those three exist. This adds the third.

**Files:**
- Modify: `extension/selection.mjs:152-253`
- Test: `eval/budget-check.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `applyBudget({ ..., maxVectorEntries = 0, isVector = () => false })`. `blockedBy` entries gain `{ cap: 'vector', shortfall: 1 }`. Task 7 injects `isVector`.

- [ ] **Step 1: Write the failing test**

Append to `eval/budget-check.mjs`:

```js
// --- vector cap: the third nesting level, vector ⊆ dynamic ⊆ all -------------------------------------
// Provenance, not the `vectorized` flag: the cap bounds what RETRIEVAL contributed, so an entry admitted
// on a key it kept is keyword no matter what its flag says (see worldsapart.js rankActivated).
const vectorSet = new Set(dynamic.slice(0, 6));   // 6 of the 12 dynamic rows came from retrieval
const runV = (opts) => run({ isVector: item => vectorSet.has(item), ...opts });

let v = await runV({ maxVectorEntries: 4 });
eq(v.survivors.size, 15, 'vector cap 4: 7 constants + 4 vector + 6 keyword-only dynamic - 2 blocked');
eq([...v.survivors].filter(x => vectorSet.has(x)).length, 4, 'vector cap 4 keeps 4 vector entries');
eq(dyn(v), 10, 'the 6 non-vector dynamic rows are untouched by the vector cap');
eq(constants.every(c => v.survivors.has(c)), true, 'vector cap never touches constants');

// Nesting: a dynamic cap below the vector cap binds first, because vector rows are dynamic rows.
v = await runV({ maxVectorEntries: 6, maxDynamic: 3 });
eq(dyn(v), 3, 'dynamic cap binds before the vector cap, since vector is a subset of dynamic');
eq([...v.survivors].filter(x => vectorSet.has(x)).length, 3, 'and the survivors are vector rows, being first in walk order');

// 0 is off, matching every other cap here.
v = await runV({ maxVectorEntries: 0 });
eq(dyn(v), 12, 'vector cap 0 is off');

// A blocked row reports the cap by name, so the panel can tell the user which knob to raise.
v = await runV({ maxVectorEntries: 2 });
eq(v.skipped.some(s => s.blockedBy.some(b => b.cap === 'vector')), true, 'a vector-blocked row names the vector cap');
eq(v.skipped.filter(s => s.blockedBy.some(b => b.cap === 'vector')).length, 4, 'the 4 vector rows past the cap are each reported');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node eval/budget-check.mjs`
Expected: FAIL lines for the vector assertions (the cap is ignored, so `dyn(v)` is 12 and `survivors.size` is 19), and exit code 1.

- [ ] **Step 3: Write minimal implementation**

In `extension/selection.mjs`, change the signature:

```js
export async function applyBudget({ ranked, isDynamic, maxTokens, maxTotal, maxDynamic, maxVectorEntries = 0, isVector = () => false, tokensOf, capOf = () => 0, exemptIsBudgeted = true, slack = 0, slackOnce = true }) {
```

Add the counter beside `dynamic`:

```js
    let counted = 0;
    let dynamic = 0;
    let vector = 0;
```

Add the clause immediately after the `maxDynamic` clause:

```js
        if (maxDynamic > 0 && isDynamic(item) && dynamic >= maxDynamic) {
            blockedBy.push({ cap: 'dynamic', shortfall: 1 });
        }
        // Retrieval's own ceiling, inside the dynamic block. Nested rather than parallel: a vector entry
        // is a dynamic entry, so maxDynamic still binds first when it is the tighter of the two.
        if (maxVectorEntries > 0 && isVector(item) && vector >= maxVectorEntries) {
            blockedBy.push({ cap: 'vector', shortfall: 1 });
        }
```

And increment inside the existing `isDynamic` branch of the admit block, which is what makes the nesting structural rather than a convention:

```js
            if (isDynamic(item)) {
                dynamic += 1;
                if (isVector(item)) {
                    vector += 1;
                }
                perWorld.set(item.entry?.world, (perWorld.get(item.entry?.world) ?? 0) + 1);
            }
```

Update the header's cap list, which currently names three:

```
 *   maxVectorEntries  caps the retrieved entries within that, so retrieval cannot flood the block
 *   maxDynamic  caps keyword and vector entries; constants and stickies are unaffected
 *   maxTotal    caps everything, so constants consume it before the dynamic entries
 *   maxTokens   caps context usage, which is only meaningful over everything
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node eval/budget-check.mjs`
Expected: every line `ok`, exit code 0.

- [ ] **Step 5: Run the whole suite**

Run: `for f in eval/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add extension/selection.mjs eval/budget-check.mjs
git commit -m "$(cat <<'EOF'
The budget gains the cap its own header already described

budget-check has claimed "vector ⊆ dynamic ⊆ all" since it was written and
only two of those three existed. maxVectorEntries is moving from a stage-1
activation cap to a stage-4 one, and this is the slot it moves into: one
blockedBy clause beside total, dynamic and book, with the counter incremented
inside the isDynamic branch so the nesting is structural rather than a
convention two call sites have to remember.

isVector is injected like isDynamic and means provenance — an entry retrieval
returned — not the `vectorized` flag. The cap exists to bound what retrieval
contributes, so an entry admitted on a key it kept is keyword whatever its
flag says. The two readings coincide under the default and diverge only with
suppressVectorKeys off.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `admitCeiling` — stage 1's bound as a pure function

**Files:**
- Modify: `plugin/scoring.mjs` (append after `poolEntries`)
- Test: `eval/elbow-check.mjs`
- Run: `node deploy-plugin.mjs` as the last step, then restart ST

**Interfaces:**
- Consumes: nothing.
- Produces: `admitCeiling(pooledServerSide: boolean) => number`. Task 6 calls it from `scoreEntries`.

**Why a function and not a constant:** `queryCollections` has two paths and topK counts a different thing on each. Inside `scoreEntries` the choice would be a branch no check reaches, on a path that only runs when the plugin is missing.

- [ ] **Step 1: Write the failing test**

Append to `eval/elbow-check.mjs`:

```js
// --- admitCeiling: stage 1's bound, which counts a different thing on each retrieval path ------------
import { admitCeiling } from '../extension/selection.mjs';

eq(admitCeiling(true), 100, 'plugin path: K counts ENTRIES, because poolEntries ran server-side');
eq(admitCeiling(false), 300, 'fallback path: K counts CHUNKS, so it must cover each entry s best one');
eq(admitCeiling(undefined), 300, 'unknown pooling is treated as unpooled — the safe direction is more chunks');
eq(admitCeiling(true) < admitCeiling(false), true, 'the chunk ceiling is the larger of the two');
```

Put the import at the top of the file beside the existing one rather than leaving it mid-file. `eval/bm25-commonword-check.mjs` already imports from `plugin/` this way, so the pattern is established:

```js
import { cutRetrieved as cut } from '../extension/selection.mjs';
import { admitCeiling } from '../plugin/scoring.mjs';   // stage-1 bound; lives beside poolEntries, which is what makes K mean entries or chunks
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node eval/elbow-check.mjs`
Expected: `SyntaxError` or `TypeError: admitCeiling is not a function`, exit code 1.

- [ ] **Step 3: Write minimal implementation**

Append to `plugin/scoring.mjs`:

```js
/**
 * How many records stage 1 asks the store for. A SAFETY LIMIT on what a pathological scene may feed
 * core's scan loop, not a verdict on relevance — stage 4 makes the only relevance decision.
 *
 * PATH-DEPENDENT, because K counts a different thing on each retrieval path:
 *
 *   pooled server-side   poolEntries runs before selectTopK, so K counts ENTRIES. 100.
 *   not pooled           K counts CHUNKS and the client pools over only what K let through. 300,
 *                        because chunks/entry measures 9.1-10.3 and the per-entry maxima do not
 *                        stabilise until K ~= 150-300 (plugin/scoring.mjs poolEntries).
 *
 * One number for both would mean "100 entries, correctly pooled" on one path and "100 chunks, with
 * understated per-entry maxima" on the other — and those understated scores feed the stage-4 cliff.
 *
 * Unknown resolves to the chunk ceiling: over-asking costs a larger response, under-asking silently
 * mis-scores entries.
 *
 * @param {boolean} pooledServerSide Whether the store pooled to one record per entry before cutting
 * @returns {number} topK to request
 */
export const admitCeiling = pooledServerSide => (pooledServerSide === true ? 100 : 300);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node eval/elbow-check.mjs`
Expected: every line `ok`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add extension/selection.mjs eval/elbow-check.mjs
git commit -m "$(cat <<'EOF'
Stage 1 asks for entries or for chunks, and it is not the same number

topK was max(100, maxVectorEntries * 2), which cannot survive maxVectorEntries
moving to stage 4. It becomes admitCeiling, and it takes an argument because
queryCollections has two paths that count different things: the plugin pools
to one record per entry before selectTopK, so K counts entries; the stock-ST
fallback does not, so K counts chunks and the client pools over only what K
let through.

100 entries against 300 chunks. The 300 is what the old `* 20` multiplier was
compensating for — chunks/entry measures 9.1-10.3 and per-entry maxima do not
stabilise until K ~= 150-300. Under the old architecture cutRetrieved cut to
~10 on both paths and the mismatch never reached the prompt; once stage 1's
ceiling IS the admission, one number would silently mis-score every entry on
the fallback path.

A function rather than a branch inside scoreEntries, so a check can reach it —
that branch only runs when the plugin is missing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `cutDynamic` — stage 4's cliff, assembled

The cliff itself is `cutRetrieved`, unchanged. What is new is the population it walks and the list it produces, and both belong in the pure half so a check can reach them.

**Files:**
- Modify: `extension/selection.mjs` (append after `cutRetrieved`)
- Test: `eval/budget-check.mjs`

**Interfaces:**
- Consumes: `cutRetrieved` (existing, unchanged).
- Produces: `cutDynamic({ sticky, constant, results }, cfg) => { ranked, dropped }`. `ranked` is the budget's walk order; `dropped` is the cliff losers, which Task 7 deletes from `activated`.

- [ ] **Step 1: Write the failing test**

Append to `eval/budget-check.mjs`:

```js
// --- cutDynamic: the cliff's population and the list it hands the budget -----------------------------
import { cutDynamic } from '../extension/selection.mjs';

const row = (key, fused) => ({ key, fused, entry: {} });
// A clear cliff after the third row.
const res = [row('r1', 9), row('r2', 8.9), row('r3', 8.8), row('r4', 1), row('r5', 0.9), row('r6', 0.8)];
const stick = [row('s1', 0.1)];
const cons = [row('k1', 0)];
const cliffCfg = { mode: 'elbow', minVectorEntries: 1, elbowSensitivity: 1.5 };

let c = cutDynamic({ sticky: stick, constant: cons, results: res }, cliffCfg);
eq(c.ranked.map(x => x.key).join(','), 's1,k1,r1,r2,r3', 'sticky and constant lead, then the surviving prefix');
eq(c.dropped.map(x => x.key).join(','), 'r4,r5,r6', 'cliff losers are named, not silently absent');
eq(c.ranked.includes(stick[0]) && c.ranked.includes(cons[0]), true, 'sticky and constant always survive the cliff');

// The population excludes sticky and constant, so their low fused scores cannot move the cliff. A
// constant scores low by ELIGIBILITY (no vector signal, often no keys), not by irrelevance.
const withNoise = cutDynamic({ sticky: [row('s1', 0.05)], constant: [row('k1', 0.04)], results: res }, cliffCfg);
eq(withNoise.dropped.map(x => x.key).join(','), 'r4,r5,r6', 'a constant s low score does not shift where the cliff falls');

// 'off' disables the cliff without disabling the budget that follows.
c = cutDynamic({ sticky: stick, constant: cons, results: res }, { ...cliffCfg, mode: 'off' });
eq(c.dropped.length, 0, 'mode off drops nothing');
eq(c.ranked.length, 8, 'mode off still assembles the full walk order');

// Empty blocks are the ordinary keyword-only and retrieval-only cases, not edge cases.
c = cutDynamic({ sticky: [], constant: [], results: [] }, cliffCfg);
eq(c.ranked.length, 0, 'nothing activated');
eq(c.dropped.length, 0, 'and nothing dropped');
c = cutDynamic({ sticky: stick, constant: cons, results: [] }, cliffCfg);
eq(c.ranked.map(x => x.key).join(','), 's1,k1', 'a scene with no dynamic rows still ranks its always-on ones');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node eval/budget-check.mjs`
Expected: `SyntaxError: The requested module ... does not provide an export named 'cutDynamic'`, exit code 1.

- [ ] **Step 3: Write minimal implementation**

Append to `extension/selection.mjs`:

```js
/**
 * Stage 4's first cut: the cliff, over the dynamic block, ahead of the budget.
 *
 * THREE CUTS AT STAGE 4, EACH ANSWERING ONE QUESTION. The cliff decides relevance; the entry maxes
 * decide how many; the token budget decides how much. The cliff therefore takes no count and runs
 * unconditionally — an irrelevant entry should not reach the prompt whether or not there was room for it,
 * and a flat ranking with no cliff survives whole for the entry maxes to bound.
 *
 * STICKY AND CONSTANT ARE NOT IN THE POPULATION. The budget may cut a constant for capacity; the cliff
 * may not cut it for relevance, because marking an entry constant is that judgement already made. They
 * also score low by ELIGIBILITY rather than by irrelevance — a constant has no vector signal and often
 * no keys — so including them would both cut them immediately and distort the mean gap the elbow reads.
 *
 * `results` must already be in retention order, so the cliff reads the order the budget walks.
 *
 * @param {object} blocks The three activation classes
 * @param {Array<{fused: number}>} blocks.sticky Armed stickies, authored order
 * @param {Array<{fused: number}>} blocks.constant Constants, authored order
 * @param {Array<{fused: number}>} blocks.results The dynamic block, retention order
 * @param {object} cfg Cutoff settings, as cutRetrieved takes them
 * @returns {{ranked: Array<object>, dropped: Array<object>}} Budget walk order, and the cliff's losers
 */
export function cutDynamic({ sticky = [], constant = [], results = [] }, cfg = {}) {
    const kept = cutRetrieved(results, cfg);
    const keptSet = new Set(kept);
    return {
        ranked: [...sticky, ...constant, ...kept],
        dropped: results.filter(item => !keptSet.has(item)),
    };
}
```

Add `'off'` as an explicit mode in `cutRetrieved`'s guard, replacing the retired `'count'`:

```js
    if ((mode !== 'elbow' && mode !== 'dropoff') || head.length <= 1) {
        return head;
    }
```

This line already returns `head` for any mode that is not a cliff mode, so `'off'` needs no code change — only the documentation in Task 4. Verify by running the test rather than assuming.

- [ ] **Step 4: Run test to verify it passes**

Run: `node eval/budget-check.mjs`
Expected: every line `ok`, exit code 0.

- [ ] **Step 5: Run the whole suite**

Run: `for f in eval/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add extension/selection.mjs eval/budget-check.mjs
git commit -m "$(cat <<'EOF'
The cliff walks the dynamic block, and names what it drops

Stage 4 gets two cuts on two questions: the cliff decides relevance, the
budget decides capacity. cutDynamic is the first — it applies cutRetrieved to
the dynamic block, assembles the budget's walk order, and returns the losers
rather than leaving them implicit, because a cliff loser is not in `ranked` by
construction and so cannot ride the budget's own delete loop.

Sticky and constant stay out of the population. The budget may cut a constant
for capacity; the cliff may not cut it for relevance, since marking an entry
constant is that judgement already made. They also score low by eligibility
rather than by irrelevance — no vector signal, often no keys — so including
them would cut them immediately and drag the mean gap the elbow reads, which
the check pins with a constant scoring below every dynamic row.

Pure, so the property that matters is reachable by a check: the ST half only
calls this and deletes what it returns.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Settings and the superseded measurements

No behaviour change beyond the `maxVectorEntries` default. This is the documentation half, and it is where the numbers that measured the wrong stage come out.

**Files:**
- Modify: `extension/state.mjs:198-239`
- Modify: `extension/selection.mjs:1-79` (the `cutRetrieved` header)
- Test: `eval/elbow-check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `vectorCutoff` values are now `'off' | 'elbow' | 'dropoff'`. Tasks 6-8 and the harnesses read these.

- [ ] **Step 1: Write the failing test**

In `eval/elbow-check.mjs`, replace the two `vectorCutoff: 'count'` cases with `'off'`, and add the retirement case:

```js
cfg = { vectorCutoff: 'off', minVectorEntries: 3, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,8,7,6,5,4,3,2,1,0.5,0.4,0.3))), 12, 'off mode keeps the whole list — bounding it is the entry maxes job');
eq(n(cutRetrieved(mk(9,8))), 2, 'off mode on a short list');
// 'count' retired: maxVectorEntries IS the count now, and it is enforced at stage 4 by the entry maxes.
// An unknown mode must behave as 'off' rather than throwing — a stored setting outlives a rename.
cfg = { vectorCutoff: 'count', minVectorEntries: 3, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,8.9,8.8,8.7,1,0.9,0.8))), 7, 'a retired or unknown mode falls through to no cut');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node eval/elbow-check.mjs`
Expected: PASS already — `cutRetrieved` returns `head` for any non-cliff mode, so this is a characterisation test that pins behaviour the rename relies on. Record that it passed; do not "fix" anything.

- [ ] **Step 3: Update the settings documentation**

In `extension/state.mjs`, replace lines 198-239 (from `/** Max retrieved entries to force-activate. ... */` through `dropoffThreshold: 0.06,`) with:

```js
    /**
     * Cap on VECTOR entries in the final selection — stage 4, inside applyBudget, nested as
     * vector ⊆ dynamic ⊆ all. It bounds what retrieval contributes to the prompt; it does not decide
     * what activates. Stage 1 admits every vectorized entry up to a fixed ceiling (selection.mjs
     * admitCeiling) and makes no relevance decision at all.
     *
     * IT IS A USER SETTING BECAUSE IT IS AN INPUT-TOKEN COST, not because it protects the ranker. The
     * cliff is what should be keeping irrelevant entries out; this is the user deciding how much of
     * their context window World Info may occupy on the retrieval side. So it is deliberately GENEROUS
     * — the tighter it is set, the more it is doing a relevance job it has no signal for, since it cuts
     * by rank position and knows nothing about the gap it cuts across.
     *
     * The failure it does not guard against: a prompt can be well within every cap and still dilute the
     * model's attention across too much material. No metric here sees that — F2@budget scores the SET
     * that shipped, not what the model did with it.
     *
     * Counted by PROVENANCE — an entry retrieval returned — not by the `vectorized` flag, so an entry
     * admitted on a key it kept counts as keyword. The two coincide unless suppressVectorKeys is off.
     */
    maxVectorEntries: 20,
    /**
     * The stage-4 relevance cut, over the dynamic block, ahead of the budget:
     *   'off'     — no cliff; the caps alone decide.
     *   'elbow'   — cuts at a gap that stands out from the MEAN gap, so the number adapts to the scene.
     *   'dropoff' — cuts at a gap larger than a FIXED fraction of the top score, which is comparable
     *               across scenes where a raw gap value is not.
     * Both cliff modes cut at the LAST qualifying gap and are floored/capped the same way.
     *
     * 'count' retired: maxVectorEntries is the count now, enforced by applyBudget. A stored 'count'
     * reads as 'off', since cutRetrieved passes through any mode that is not a cliff mode.
     *
     * CARRIED-OVER DEFAULT, NOT A MEASUREMENT. Every figure that chose 'elbow' graded a cut over the
     * RETRIEVAL ranking. On the layout ranking the cliff spans an eligibility-normalised, heterogeneous
     * list — vector+text+keys entries beside keyword-only ones — so the mean gap is not the same
     * quantity and none of those results transfers. Nothing grades stage 4 yet; see matcher-design.md
     * Evidence, "Two scores".
     */
    vectorCutoff: 'elbow',
    /** Cliff modes only: never cut the dynamic block below this many. Carried-over default, unmeasured
     *  at this stage. */
    minVectorEntries: 3,
    /**
     * Elbow mode only: how large a gap must be, as a multiple of the mean gap, to count as a cliff.
     * Higher keeps fewer. Below 1 would treat an average gap as a cliff and is meaningless.
     * Carried-over default, unmeasured at this stage.
     */
    elbowSensitivity: 1.5,
    /**
     * Dropoff mode only: a gap is a cliff when it erases more than this fraction of the top fused
     * score. Higher keeps fewer. Carried-over default, unmeasured at this stage.
     */
    dropoffThreshold: 0.06,
```

- [ ] **Step 3b: Delete `cutRetrieved`'s survivor cap**

The cliff answers relevance and nothing else. Its cap (`head = ranked.slice(0, Math.max(1, maxVectorEntries))`)
was justified by "a flat distribution has no meaningful cliff and would otherwise admit the lot" — which
is true, and is now the entry maxes' job one cut later. Keeping it would also mean a provenance-blind
count sitting inside the relevance cut, where `Math.max(1, 0)` turns "no cap" into "keep one row".

Add the failing checks to `eval/elbow-check.mjs` first:

```js
// The cliff is PURELY relevance. It takes no count, so a flat ranking survives it whole and the entry
// maxes — a separate cut — decide how many of those rows ship.
cfg = { vectorCutoff: 'elbow', minVectorEntries: 3, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,8,7,6,5,4,3,2,1,0,-1,-2))), 12, 'an evenly-spaced ranking has no elbow and is kept whole');
eq(n(cutRetrieved(mk(9,8.9,8.8,8.7,1,0.9,0.8,0.7,0.6,0.5,0.4,0.3))), 4, 'a cliff deep in a long list still cuts at the cliff');
eq(n(cutRetrieved(mk(...Array.from({ length: 200 }, (_, i) => 100 - i)))), 200, 'no arbitrary ceiling: 200 evenly-spaced rows all survive');
```

Then in `extension/selection.mjs`, drop the parameter and the slice:

```js
export function cutRetrieved(ranked, { mode = 'off', minVectorEntries = 1, elbowSensitivity = 1.5, dropoffThreshold = 0.06 } = {}) {
    const head = ranked.slice();
```

Delete every `maxVectorEntries` reference from this function and its `@param` block. Update
`elbow-check.mjs`'s existing cases to drop `maxVectorEntries:` from their `cfg` objects; the two that
asserted "caps at max" were rewritten in Step 1.

Run `node eval/elbow-check.mjs`. Expected: all `ok`, exit 0.

- [ ] **Step 4: Update the `cutRetrieved` header**

In `extension/selection.mjs`, replace the block comment at lines 5-79 (everything from `/**` through the `@returns` line, keeping the `export function` line untouched) with:

```js
/**
 * The cliff: how much of a ranking's head survives.
 *
 * STAGE 4, over the dynamic block of the LAYOUT ranking (see cutDynamic). It ran at stage 1 over the
 * retrieval ranking until 2026-08, which is why every measurement that once lived here is gone rather
 * than moved — they graded a different population.
 *
 * 'off' keeps the head whole and lets the caps decide. The two cliff modes cut at a drop in fused
 * score, so a scene with three strong matches admits three and one with twelve admits twelve. It takes
 * no count: a flat distribution has no cliff and survives whole, and how many of those rows ship is the
 * entry maxes' question, one cut later. They differ only in how big
 * a gap counts as a cliff:
 *   'elbow'   — relative to the MEAN gap (elbowSensitivity × mean). Adapts per query but shifts with
 *               the window, since the mean depends on what is in it.
 *   'dropoff' — a FIXED fraction of the top score (dropoffThreshold × head[0]). Comparable across
 *               queries because RRF bounds the score band, and window-independent where the mean is not.
 *
 * Both cut at the LAST significant gap, not the largest. A decaying score curve often has several
 * cliffs; the largest is usually the earliest, and cutting there discards whole clusters of near-tied
 * entries that sit below it. The largest gap only wins when it is also the last.
 *
 * The search starts at minVectorEntries: the biggest gap in a good ranking is very often the one
 * between rank 1 and rank 2, and cutting there would return a single entry every time.
 *
 * Any mode that is not a cliff mode passes through, so a stored setting that outlives a rename degrades
 * to 'off' rather than throwing.
 *
 * @param {Array<{fused: number}>} ranked Fused ranking, best first
 * @param {object} cfg Cutoff settings (from settings())
 * @param {string} cfg.mode vectorCutoff — 'off' | 'elbow' | 'dropoff'
 * @param {number} cfg.minVectorEntries Floor the cliff search starts at
 * @param {number} cfg.elbowSensitivity Cliff = elbowSensitivity × mean gap (elbow mode)
 * @param {number} cfg.dropoffThreshold Cliff = dropoffThreshold × top score (dropoff mode)
 * @returns {Array<{fused: number}>} The surviving prefix
 */
```

Change the default in the signature from `mode = 'count'` to `mode = 'off'`.

- [ ] **Step 5: Run the whole suite**

Run: `for f in eval/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add extension/state.mjs extension/selection.mjs eval/elbow-check.mjs
git commit -m "$(cat <<'EOF'
A cutoff table that graded the retrieval ranking cannot describe this one

maxVectorEntries becomes a stage-4 cap on vector entries and defaults to 20;
vectorCutoff's modes become off/elbow/dropoff, 'count' retiring because
maxVectorEntries IS the count now and applyBudget enforces it. A stored
'count' reads as 'off', since cutRetrieved passes through any mode that is not
a cliff mode — pinned by a check rather than left to be discovered.

The measurements go rather than move. The %oracle table, the elbow's minimum
retrieval depth, the dropoff bimodality and the elbow-vs-count scene results
all graded a cut over the retrieval ranking. On the layout ranking the cliff
spans an eligibility-normalised, heterogeneous list, so the mean gap is not the
same quantity and none of it transfers. elbowSensitivity 1.5,
minVectorEntries 3 and dropoffThreshold 0.06 keep their values and are now
labelled as carried-over defaults with nothing behind them, which is the honest
state until something grades stage 4.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `cliffCut` in `eval/scene.mjs`, and the harnesses that use it

The harnesses apply `cutRetrieved` to a retrieval ranking in two places. Both move to the layout ranking, through one shared helper — a second copy of the cut is the same mistake as a second copy of the gazetteer.

**Files:**
- Modify: `eval/scene.mjs` (add export near `makeFuse`)
- Modify: `eval/graded-scene-grid.mjs:65`, `:328`, `:396-441`
- Modify: `eval/cutoff-grid.mjs:33`, header
- Test: `eval/budget-check.mjs` covers `cutDynamic`; this task's verification is running the harnesses against a real sample.

**Interfaces:**
- Consumes: `cutDynamic` from Task 3.
- Produces: `cliffCut(fusedRows, P) => { kept, dropped, refKept, refAll }` from `eval/scene.mjs`. Reference rows are IN the cliff's population, matching the runtime.

- [ ] **Step 1: Add the helper**

In `eval/scene.mjs`, import `cutDynamic` alongside the existing imports and export:

```js
import { cutDynamic } from '../extension/selection.mjs';

/**
 * The stage-4 cliff as the runtime applies it: over the fused LAYOUT ranking's dynamic block, not over
 * the retrieval ranking. One helper so graded-scene-grid and paired-arms cannot drift — the same rule
 * that keeps the gazetteer and the scorers in one place.
 *
 * Reference-tier rows are the harness's sticky/constant analogue: they reach the prompt because a key
 * fired, not because ranking chose them, so they are outside the cliff's population exactly as constants
 * are at runtime.
 *
 * DURABLE IS OUT OF THE POPULATION, matching the runtime — the budget may cut a constant for capacity,
 * the cliff may not cut it for relevance. REFERENCE IS IN IT, also matching the runtime, because a
 * keyword-activated entry is neither sticky nor constant and so lands in `results` there.
 *
 * `scoreScene` still strips reference rows before its RANKING metrics (triggered == relevant); whether
 * the cliff is entitled to cut them is a different question and the answer is yes.
 *
 * `refKept`/`refAll` report composition over the CUT population, so a cliff eating the reference tier is
 * visible. Read it as a calibration symptom, not as a case for a quota: the fused score is meant to make
 * a grade-3 memory entry beat a grade-2 reference entry, and if reference rows vanish at equal grade
 * that is fuseRanks failing to compare across provenance, which no cliff placement can rescue.
 *
 * @param {Array<object>} fused Layout ranking, best first, all three populations present
 * @param {object} P Scene params (vectorCutoff, minVectorEntries, elbowSensitivity, …)
 * @returns {{kept: Array<object>, dropped: Array<object>, refKept: number, refAll: number}}
 */
export function cliffCut(layout, P) {
    // `layout` is ALREADY durable-filtered by the caller — graded-scene-grid's `layoutOf` does exactly
    // that split, and re-deriving it here is the second copy the gazetteer rule exists to prevent.
    const { ranked, dropped } = cutDynamic({ sticky: [], constant: [], results: layout }, {
        mode: P.vectorCutoff ?? 'off',
        minVectorEntries: P.minVectorEntries ?? 3,
        elbowSensitivity: P.elbowSensitivity ?? 1.5,
        dropoffThreshold: P.dropoffThreshold ?? 0.06,
    });
    return {
        kept: ranked,
        dropped,
        refKept: ranked.filter(r => isReference(r.entry)).length,
        refAll: layout.filter(r => isReference(r.entry)).length,
    };
}
```

- [ ] **Step 2: Point `graded-scene-grid.mjs` at it**

REFRESHED AGAINST HEAD — the file gained `layoutOf`/`vectorOf`/`ndcgAtR` and four nDCG columns, so the
line numbers and snippets from the spec no longer apply. Read the file before editing.

Import `cliffCut` from `./scene.mjs` and drop `cutRetrieved` from the `extension/selection.mjs` import
(delete the import line if nothing else in the file uses it).

In the depth sweep, the cutoff column currently rebuilds a `fuseRetrieval` ranking (`retr`/`rk`) purely
to cut it. That ranking goes; cut the layout ranking the runtime cuts:

```js
            // Cutoff, at stage 4, on the layout ranking — reference rows included, because the runtime's
            // cliff can drop them too. Durable rows are already out via layoutOf.
            const { kept: keep, refKept, refAll } = cliffCut(layoutOf(rows), P);
            const relInRank = layoutOf(rows).filter(r => gradeOf(r) >= 3).length;
```

leaving `tp`, `pr`, `rc` and `blind` reading `keep` as they already do, and adding `refKept/refAll` to
the row so a cliff eating the reference tier is visible rather than inferred.

- [ ] **Step 2b: Leave the cutoff-arm section alone**

The standalone cutoff-arm table (`count max=N` / `elbow sens=` / `dropoff thr=`, with its own `P`, `R`,
`F1` and `%oracle` columns) is not part of this change. It is the instrument for the tuning this change
EXISTS to make possible — what `elbow` should be, whether it survives, what `maxVectorEntries` should
default to — and rewriting it belongs to that work, against the architecture once it ships.

It does not break. `fuseRetrieval` still runs; the section still cuts its output and still measures
something coherent about that ranking. What changes is that production no longer cuts there, so the
numbers stop describing what ships. Add one line to its header saying so, and change nothing else:

```js
    // SUPERSEDED BY THE STAGE-4 MOVE, kept until the tuning pass rewrites it: production cuts the layout
    // ranking now, so these arms describe a cut WA no longer makes. The rewrite is the tuning work's,
    // and needs three calls this change does not make — which credit rule the precision uses, which
    // population it scores, and whether depth returns as an axis once maxVectorEntries is a budget cap
    // this harness would have to replay applyBudget to apply.
```

- [ ] **Step 3: Update `cutoff-grid.mjs`**

It stays on `cutRetrieved` and does not gain `cliffCut`: it measures the cliff's BEHAVIOUR over hundreds
of real rankings — how many rows each mode keeps — which is a property of the mode and the score
distribution, not of which ranking it is handed. It has no graded scenes and no layout ranking to build.

Replace its `count` arm with `['off', { mode: 'off' }]`, drop `maxVectorEntries` and `MIN` from the
`cutRetrieved` call (the cliff takes no count now), and add to its header:

```js
// STAGE 4. The shipped cliff cuts the LAYOUT ranking (extension/selection.mjs cutDynamic); this grid
// reads retrieval rankings, because those are what it has cheaply and mode behaviour transfers. Read the
// kept-counts as "how decisive is each mode on a real score curve", not as a measurement of what ships.
```

- [ ] **Step 4: Verify against a real sample**

Run: `node eval/graded-scene-grid.mjs --sample eval/eval-data/timewhore-syn-msg550.json`
Expected: runs to completion, prints the depth grid and a `cutoff at shipped k1/b/lexW` section whose arm labels are `off`, `elbow sens=…`, `dropoff thr=…` with no `count max=` rows. `judged@10` still reports `10/10`.

Run: `for f in eval/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add eval/scene.mjs eval/graded-scene-grid.mjs eval/cutoff-grid.mjs
git commit -m "$(cat <<'EOF'
The harness cuts the ranking the runtime cuts

graded-scene-grid applied cutRetrieved to a fuseRetrieval ranking it rebuilt
for the purpose, which was correct while the cut lived at stage 1 and measures
a decision WA no longer makes. Both call sites now go through scene.mjs
cliffCut, over the fused layout ranking, so the grid and paired-arms cannot
drift — the same rule that keeps one gazetteer and one set of scorers.

Reference-tier rows sit outside the cliff's population, which is the harness's
version of the runtime keeping sticky and constant out of it: they reach the
prompt because a key fired, not because ranking chose them.

The `count max=N` arms retire with the mode. maxVectorEntries is a budget cap
now, so sweeping it is a budget question and belongs with whatever finally
grades stage 4, not with a cutoff-mode column.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Stage 1 admits

First of the ST-coupled tasks. The logic is already checked; this is wiring.

**Files:**
- Modify: `worldsapart.js:497-529` (topK), `:694-708` + `:787` + `:2244` (`reportVectorCandidates`), `:779-797` (`retrieve`)

**Interfaces:**
- Consumes: `admitCeiling` from Task 2, imported as `import { admitCeiling } from './plugin/scoring.mjs';` (worldsapart.js already imports `./plugin/fingerprint.mjs`, so the path shape is established).
- Produces: `runState.lastScores` / `lastTextScores` now hold every admitted entry, which Task 7's `isVector` reads. `queryCollections` no longer accepts a `topK` from its caller.

**Widening `lastScores` gives vector RANKS to entries that had eligibility without one.** `vectorable`
resolves off `entry.vectorized` at runtime — `worldsapart.js` never sets `vectorEligible`, only
`eval/scene.mjs` does — so eligibility itself is unchanged. But a vectorized entry that lost the old cut
was normalised by the vector weight while contributing zero RRF, and with every admitted entry scored it
now contributes its actual position. Intended, and it moves fused scores, so a before/after comparison
of any ranking figure is not like-for-like even before the cliff moves.

**On the spec's check #2.** The spec lists "stage 1 admits everything and stashes a score for everything" among three pure checks. It cannot be one: `retrieve()` reads ST globals and awaits `queryCollections`, so it is not node-importable, and the loop it guards is three lines with no branch. Extracting it to reach it would be scaffolding for its own sake. Step 4's in-app verification is the check, and the durable guard is Task 7's `isVector`, which reads `lastScores` — if stage 1 ever stashes a subset again, the vector cap starts miscounting immediately and visibly. Record this rather than reporting three pure checks when two shipped.

- [ ] **Step 1: Let `queryCollections` choose the ceiling**

The caller cannot pick correctly: `queryCollections` also falls back MID-REQUEST — a non-ok response or
a throw — and a ceiling chosen before the attempt would run the fallback at the entry number against a
chunk response, understating every per-entry maximum silently. The function that knows which path it
took is the one that must choose.

Delete `worldsapart.js:497-529` (the whole comment block plus `const topK = …`) and drop `topK` from the
`queryCollections({ … })` call at `:530`.

Then in `queryCollections` (`:262-299`), set it on each path:

```js
async function queryCollections(args) {
    // ENTRIES or CHUNKS depending on which path answers — selection.mjs admitCeiling carries both
    // numbers and why they differ. Chosen HERE rather than by the caller because the fallback below can
    // fire mid-request, and a ceiling picked before the attempt would ask for entries and be handed
    // chunks. A safety limit on what a pathological scene may feed core's scan loop, not a verdict on
    // any entry — stage 4 makes the only relevance decision.
    if (settings().meanCentered && await hasPlugin()) {
        try {
            const body = vectorRequestBody({ ...args, topK: admitCeiling(true) });
```

leaving the rest of the plugin branch untouched, and at the fallback:

```js
    // Stock ST can't quantile ('auto' resolves in the plugin) — pin the old centered default; on raw
    // scores it's permissive and client-side selection narrows.
    if (args.threshold === 'auto') args = { ...args, threshold: 0.1 };
    // No server-side pooling here, so K counts chunks and must run deep enough for each entry's best
    // one to survive. Re-asked rather than inherited from a failed plugin attempt.
    return await vectorPost('query-multi', { ...args, topK: admitCeiling(false) }) ?? {};
```

- [ ] **Step 2: Stop cutting in `retrieve()`**

Replace `worldsapart.js:779-797` with:

```js
    const ranked = fuseRetrieval(scores);

    runState.lastCutKept = null;

    // /wa-debug's stage-1 table, rendered from the admission that just happened rather than a replay.
    if (runState.verboseRun) {
        reportVectorCandidates(ranked, targets, searchText);
    }

    // EVERY admitted entry, not a surviving prefix. Stage 3 looks its vector and text scores up from
    // here, so stashing only survivors would leave every entry stage 4 has yet to judge without the two
    // signals it was admitted on — and a missing signal reads as a low score rather than as an error.
    for (const [key, value] of scores) {
        runState.lastScores.set(key, value.score);
        runState.lastTextScores.set(key, value.bm25 ?? 0);
    }

    return targets;
```

- [ ] **Step 3: Drop `reportVectorCandidates`' cut argument**

At `:694-708`, change the signature and the two lines reading `cut`:

```js
/**
 * @param {object[]} ranked The retrieval ranking, best first
 * @param {object[]} targets Vectorized entries in the active books
 * @param {string} searchText The query
 */
function reportVectorCandidates(ranked, targets, searchText) {
```

Replace the `console.log` naming the cutoff with one naming the admission, since stage 1 no longer cuts:

```js
    console.log(`Worlds Apart: ${ranked.length} entries admitted, ${settings().retrievalMode} ranking, top-5 vector spread ${spread.toFixed(5)}`);
```

and the `console.table` slice, which used `cut`:

```js
    console.table(ranked.slice(0, 40).map((row, index) => ({
```

At `:2244`, drop the second argument: `reportVectorCandidates(ranked, targets, searchText);`

- [ ] **Step 4: Verify in the app**

There is no offline check for this half. Reload SillyTavern, open a chat with a vectorized book, run `/wa-debug`.
Expected: the stage-1 table lists far more rows than before (order of 100 rather than order of 10), the console line reads `N entries admitted` with no cutoff clause, and no error is thrown.

Then force the fallback — turn `meanCentered` off in the panel — and run `/wa-debug` again.
Expected: still completes, and the console shows the stock-ST path was used. This is the path that would
have silently run at a third of its needed depth had the caller kept choosing the ceiling.

Run: `for f in eval/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add worldsapart.js
git commit -m "$(cat <<'EOF'
Stage 1 admits, and stops pretending to know what is relevant

cutRetrieved leaves retrieve(). The retrieval ranking is admitted whole up to
admitCeiling, which is a safety limit on what a pathological scene may feed
core's scan loop rather than a verdict about any entry — stage 4 makes the one
relevance decision, on a ranking that can see keys and knows what the budget is.

lastScores and lastTextScores now hold every admitted entry rather than a
surviving prefix. Stage 3 looks both signals up from there, so the old filter
would have left every entry stage 4 has yet to judge without the two signals it
was admitted on, and a missing signal reads as a low score rather than as an
error — the quietest way this change could have gone wrong.

reportVectorCandidates loses its cut argument: the stage-1 table reports what
was admitted, and the cut now belongs to the stage-4 table.

queryCollections chooses the ceiling rather than taking one, because it is the
only thing that knows which path answered — it can fall back mid-request on a
non-ok response or a throw, and a ceiling picked before the attempt would ask
for entries and be handed chunks, understating every per-entry maximum with
nothing to show for it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Stage 4 arbitrates

**Files:**
- Modify: `worldsapart.js:1631-1720` (`rankActivated`'s assembly and budget call), `:1789` (`lastRanked`), `:1795` (`cutBy`)

**Interfaces:**
- Consumes: `cutDynamic` (Task 3), `applyBudget`'s vector cap (Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Insert the cliff**

At `worldsapart.js:1694`, replace `let ranked = [...sticky.sort(authored), ...constant.sort(authored), ...results];` with:

```js
    // STAGE 4, FIRST CUT: relevance. Runs unconditionally and ahead of the budget — an irrelevant entry
    // should not reach the prompt whether or not there was room for it, and the budget's guard below is
    // a capacity condition (it fails at maxTokensPercent 0, which is a documented setting).
    const cliff = selection.cutDynamic(
        { sticky: sticky.sort(authored), constant: constant.sort(authored), results },
        effectiveCliff(),
    );
    let ranked = cliff.ranked;

    // Cliff losers cannot ride the budget's delete loop below: that walks `ranked`, and a cliff loser is
    // not in it by construction.
    for (const item of cliff.dropped) {
        activated.delete(item.key);
    }
    if (cliff.dropped.length) {
        console.log(`Worlds Apart: cliff dropped ${cliff.dropped.length} entries below the relevance cut, ${ranked.length} remain`);
    }
```

- [ ] **Step 2: Keep `lastRanked` pre-cliff**

The capture at `:1789` reads `runState.lastRanked ?? ranked` and must hold every row stage 4 chose between, including cliff losers. Immediately before the `cutDynamic` call, add:

```js
    // PRE-CLIFF, so /wa-debug and /wa-grade record a row for every entry stage 4 judged — not only the
    // ones that survived it. `cut`/`cutBy` below record which side each fell on.
    runState.lastRanked = [...sticky, ...constant, ...results];
```

Check whether `runState.lastRanked` is already assigned further down and remove that assignment if so, keeping exactly one.

- [ ] **Step 3: Record the cliff in `cutBy`**

At `:1795`, the `blockedOf` map is built from `runState.lastSkipped`. Add the cliff's losers so a capture row says which of the two stage-4 decisions rejected it:

```js
        const blockedOf = new Map([
            ...(runState.lastSkipped ?? []).map(s => [s.item ?? s, (s.blockedBy ?? []).map(b => b.cap).join('+')]),
            ...cliff.dropped.map(item => [item, 'cliff']),
        ]);
```

- [ ] **Step 4: Wire the vector cap and `isVector`**

At `:1701-1714`, add the cap to the guard and the call:

```js
    const maxVectorEntries = settings().maxVectorEntries;

    if (maxTokens > 0 || maxTotal > 0 || maxDynamic > 0 || maxVectorEntries > 0 || bookCaps.size) {
        const dynamicSet = new Set(results);
        const { survivors, counted, skipped, dropped, budgeted, inPrompt } = await selection.applyBudget({
            ranked,
            isDynamic: item => dynamicSet.has(item),
            // PROVENANCE: retrieval scored it. Not `entry.vectorized` — an entry admitted on a key it
            // kept (suppressVectorKeys off) got in through the keyword route and is not what this cap
            // bounds. The two coincide under the default.
            isVector: item => runState.lastScores.has(item.key),
            maxTokens,
            maxTotal,
            maxDynamic,
            maxVectorEntries,
```

leaving the remaining arguments unchanged.

- [ ] **Step 5: Add `effectiveCliff`**

Replace `effectiveCutoff` at `:3088-3101` with a stage-4 version. `runState.gradeCutoff` keeps its depth-cap job and gains the cliff-disabling one:

```js
/**
 * The cliff in force. Normally the settings; during a /wa-grade or /wa-super-grade run, the cliff is
 * DISABLED and the cap widened, so the capture records the population stage 4 chose between rather than
 * the survivors — an offline harness can then replay any cliff setting against it.
 *
 * The depth cap survives the move. With no cliff and no stage-1 cut a capture would pool the whole
 * admitted set, and grading cost scales with the union across arms, so the knob stops meaning "widen
 * the cut to see past it" and starts meaning "cap the grading budget".
 *
 * @returns {object} cutDynamic/cutRetrieved settings
 */
function effectiveCliff() {
    const s = settings();
    const grading = runState.gradeCutoff;
    return {
        mode: grading ? 'off' : s.vectorCutoff,
        minVectorEntries: s.minVectorEntries,
        elbowSensitivity: s.elbowSensitivity,
        dropoffThreshold: s.dropoffThreshold,
    };
}
```

The cliff takes no count at all — it answers relevance, and stage 4's three cuts each answer one
question: the cliff (relevance), the entry maxes (how many), the token budget (how much).

**Capture depth is ALL DURABLE + N DYNAMIC, applied where the capture is built, not through the cliff.**
A grading run turns the cliff off so the capture holds the population stage 4 chose between; capping it
is a grading-budget decision, so it belongs to the capture rather than to selection. Cap the DYNAMIC
block, not the walk order: `runState.lastRanked` leads with sticky and constant in AUTHORED order, and
those are the rows the grading popup lists but does not grade, so a cap on the whole list spends slots
on ungradeable rows and N stops meaning the same thing across books.

`runState.gradeCutoff` keeps `maxVectorEntries: wanted` as that N, read by the capture builder at :1789
rather than by `effectiveCliff`.

Delete the now-unused `cutRetrieved` wrapper at `:3094-3102` and its `effectiveCutoff` callers; update `:2367-2369`, `:2517-2521`, `:2599-2621`, `:2946-2950` to record `{ mode: 'off', maxVectorEntries: wanted }` as the grading override.

- [ ] **Step 6: Verify in the app**

Reload SillyTavern. In a chat with a vectorized book:
1. Run `/wa-debug`. Expected: a stage-4 section showing rows cut by `cliff` as well as by the caps; the console reports `cliff dropped N entries`.
2. Set `vectorCutoff` to `off` in the panel and re-run. Expected: no cliff drops, `maxVectorEntries` visible as the binding cap in the budget line.
3. Set the token budget percentage to 0 and re-run with `vectorCutoff: elbow`. Expected: the cliff still drops rows — this is the case that would have regressed had the cliff sat inside the budget guard.
4. Run `/wa-grade`. Expected: the candidate table lists the pre-cliff population, capped at the requested depth.

Run: `for f in eval/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add worldsapart.js
git commit -m "$(cat <<'EOF'
The one relevance decision, made where all three signals meet

rankActivated gains the cliff, over the dynamic block, after fuseRanks and
after results is sorted into retention order so the cliff reads the order the
budget walks. Three cuts, one question each: the cliff decides relevance, the
entry maxes decide how many, the token budget decides how much. The cliff takes
no count, so a flat ranking survives it whole and the entry maxes bound it.

It runs outside the budget's guard deliberately. That guard is a capacity
condition and passes on shipped defaults only because maxTokensPercent is 40;
at 0 — "defer to core entirely", a documented setting — it fails, and a cliff
inside it would silently stop cutting for anyone who turned the token budget
off. Turning off capacity must not turn off relevance.

Cliff losers get their own delete, because the budget's loop walks `ranked` and
a cliff loser is not in it. lastRanked is stashed pre-cliff so a capture holds
a row for every entry stage 4 judged, and cutBy records which of the two
decisions rejected it.

maxVectorEntries reaches applyBudget as a nested cap and is read by provenance
— retrieval scored it — rather than off the vectorized flag, since an entry
admitted on a key it kept came in through the keyword route. The cliff's own
cap is off: applying it at both cuts would reject vector entries before the
keyword ones had competed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `POOL_ARMS` loses the two arms that measured a cut

Only the two clear drops. The section's criterion needs restating and that is the user's adjudication, not this plan's.

**Files:**
- Modify: `worldsapart.js:2537-2564`

- [ ] **Step 1: Drop the arms and record why**

Remove the `vector` and `lexical` entries from `POOL_ARMS` and their two lines from the header comment, replacing them with:

```js
 *   no-filter   entityFilter off moves the surviving query terms, so it moves BM25 and what stage 1
 *               admits at all.
 *   loose-thr   scoreThreshold gates whether a chunk is admitted — with no stage-1 cut it is one of the
 *               two knobs that can change the population rather than reorder it.
 *   keys-live   suppressVectorKeys off lets WA keyword-match vectorized entries.
 *
 * `vector` and `lexical` retired with the stage-1 cut. retrievalMode decided which signal ordered the
 * candidates, so a different set survived into the TOP of the ranking — and with nothing cut at stage 1
 * there is no top to survive into, leaving pure reordering, which graded-scene-grid re-derives offline.
 * They would still matter on a book larger than admitCeiling; the books measured here hold 70-115
 * vectorized entries.
```

- [ ] **Step 2: Verify in the app**

Run `/wa-super-grade` on a chat with a vectorized book.
Expected: the grading window's "surfaced by" column lists three arms, not five; the run is correspondingly faster; no error.

- [ ] **Step 3: Commit**

```bash
git add worldsapart.js
git commit -m "$(cat <<'EOF'
An arm that changed what survived the cut has nothing left to change

POOL_ARMS earns an arm only by changing the POPULATION; anything that reorders
is re-derived offline. vector and lexical qualified because retrievalMode
decided which signal ordered the candidates and so which entries survived into
the top of the stage-1 cut. There is no stage-1 cut and no top to survive into,
so both are pure reordering now.

They would still matter on a book larger than admitCeiling, where ordering
decides what makes the ceiling; the books measured here hold 70-115 vectorized
entries. no-filter, loose-thr and keys-live stay for now — the section's
criterion needs restating rather than its membership trimmed further, and that
is a separate call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The design docs

Last, so they describe what shipped.

**Files:**
- Modify: `matcher-design.md` (*Stage 1*, *Stage 3*, *Stage 4*, *Evidence*, *Open work*)
- Modify: `CLAUDE.md` (*Four stages, and the two rankings*)

- [ ] **Step 1: `matcher-design.md` Stage 1**

Replace the *Open* paragraph (`matcher-design.md:333-335`, "the stage-1 elbow is a relevance judgement made early…") — it is answered, not open. Write:

```markdown
**Stage 1 admits and does not cut.** `selection.mjs` `admitCeiling` bounds how much a pathological scene
may feed core's scan loop, and that is a safety limit rather than a verdict on relevance. It is
path-dependent because topK counts a different thing on each: the plugin pools to one record per entry
before `selectTopK`, so K counts ENTRIES (100); the stock-ST fallback does not, so K counts CHUNKS (300,
chunks/entry measuring 9.1-10.3 with per-entry maxima stabilising at K ~= 150-300).

**`scoreThreshold` cannot narrow the candidate set.** A vectorized chunk is also admitted by `bm25 > 0`
on its own text, so admission is "top decile by centered cosine OR any lexical overlap" — `'auto'`
resolves to `quantile(vectorScores, 0.9)`, a selector rather than a floor. That bypass is measured
load-bearing: a strict cosine gate dropped sommers from 3/3 to 1/3 on grade-5 entries. Narrowing
admission is therefore a COST question, not a precision one, since stage 4 arbitrates.
```

- [ ] **Step 2: `matcher-design.md` Stage 4**

Replace the whole *Stage 4: Selection* body (`:501-506`) with:

```markdown
Three cuts, all here, each answering one question over the same layout ranking.

**The cliff** (`selection.mjs` `cutDynamic`) decides relevance, over the dynamic block, in the order the
budget walks. It runs unconditionally: an irrelevant entry should not reach the prompt whether or not
there was room for it. DURABLE entries — constant and active-sticky — are outside its population: the
budget may cut a constant for capacity, the cliff may not cut it for relevance, because marking an entry
constant is that judgement already made, and a constant scores low by ELIGIBILITY rather than by
irrelevance. REFERENCE entries that are not durable are in it, and are cut like anything else — the
fused score is what has to make a grade-3 memory entry beat a grade-2 reference entry, and giving either
tier a structural exemption would be compensating for a score that is not doing its job.

**The entry maxes** then decide how many, on nested populations: vector ⊆ dynamic ⊆ all, plus the
per-book quota. `maxVectorEntries` bounds what retrieval contributed and is counted by provenance, not
by the `vectorized` flag.

**The token budget** decides how much, and is the only one of the three measured in tokens rather than
entries. Both live in `applyBudget`, which walks the ranked list once and reports every cap that
rejected a row.

This is where the one relevance decision is made (see *Principles*).

**The cliff can drop a keyword-activated entry with the budget wide open**, where previously only budget
pressure could. That stands against *triggered == relevant* (*Evidence → Tiers*) and is recorded rather
than resolved: arbitrating once over the whole heterogeneous set is what *Principles* requires, and
carving an exemption for keyword rows would make stage 4 read provenance.
```

- [ ] **Step 3: `matcher-design.md` Evidence**

The vector score's definition (`:605-606`) loses its referent — there is no `cutRetrieved` at stage 1. Replace with:

```markdown
**The vector score** grades ADMISSION: was the relevant entry returned at all. With no relevance
decision at stage 1 it is a recall diagnostic and a cost measure, not a quality metric — the question it
answers is whether anything downstream could have surfaced the entry, and how much was carried to find
out.
```

Then, in *Open work*, replace item 1's title and body so it names the layout score (`F2@budget` over the dynamic block, set-based, recall at grade >= 3 and precision at grade >= 2) rather than "the two-score split", since the split's other half is now answered structurally.

- [ ] **Step 4: `CLAUDE.md` four stages**

Update the stage 1 and stage 4 paragraphs to match, keeping the "two rankings, not one" rule intact — it is unchanged and still load-bearing.

- [ ] **Step 5: Verify the docs against the code**

Run: `grep -rn "cutRetrieved" CLAUDE.md matcher-design.md`
Expected: no line describes it as cutting the retrieval ranking or as living at stage 1.

Run: `grep -rn "maxVectorEntries" CLAUDE.md matcher-design.md`
Expected: every mention places it at stage 4.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md matcher-design.md
git commit -m "$(cat <<'EOF'
The docs describe one relevance decision, at the stage that makes it

Stage 1 admits to a path-dependent ceiling and cuts nothing; stage 4 holds both
cuts, the cliff for relevance and the caps for capacity. The vector score's
definition loses its referent — it graded fuseRetrieval's output "cut by
cutRetrieved" and there is no such cut — so it becomes a recall diagnostic,
was the relevant entry admitted at all, and Open work #1 shrinks to the layout
score.

Recorded rather than resolved: the cliff can now drop a keyword-activated entry
with the budget wide open, which stands against triggered == relevant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification

After Task 9, all of:

```bash
for f in eval/*-check.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
node eval/graded-scene-grid.mjs --sample eval/eval-data/timewhore-syn-msg550.json
node eval/sentinel-check.mjs
```

Expected: suite silent, grid completes with `off`/`elbow`/`dropoff` arms, sentinel green.

In the app, with a vectorized book: `/wa-debug` shows ~100 admitted at stage 1 and a stage-4 section naming `cliff` alongside the caps; `/wa-grade` captures the pre-cliff population; `/wa-super-grade` runs three arms.

## Follow-up work, after this lands

Neither is part of this plan. Both were found while tracing the lexical path and are recorded here so
they are not re-derived.

### A. Lexically score a keyword entry's CONTENT

Today a non-vectorized entry's body is never indexed: `worldsapart.js:462` admits only
`x.vectorized && !x.disable && x.content` into `syncWorld`, and `plugin/server.js:137` builds the BM25
index over exactly those chunks. So a keyword entry earns `keywordScore` — BM25 over its authored KEYS
against the scan window — and nothing else. The orientations are inverted: a vectorized entry's content
is the document and the chat is the query; a keyword entry's keys are the query and the chat is the
document.

**Why it matters for the hybrid score.** A vectorized entry is ranked on three signals, a keyword entry
on one. `fuseRanks` eligibility normalisation equalises the CEILING — both top out at `1/(k+1)`
(`ranking.mjs:336-359`) — but not the evidence behind the estimate, so one noisy signal decides where a
keyword entry lands. Indexing its content lexically gives it two, and is the concrete mechanism for
"a grade-3 vector entry should outrank a grade-2 keyword entry".

**Scoring signal, NOT an admission route.** Content-lexical for keyword entries belongs at stage 3. If it
also admitted, any lexical overlap would activate any entry in the book, bypassing the author's key
declarations — which *Principles* lists among the things WA does not decide. Keys stay the activation
route; content-lexical only re-ranks what activated.

**What it moves that is already measured**, and must be re-checked rather than assumed:
- The IDF corpus changes. Term statistics are currently computed over vectorized content alone, so on a
  reference-heavy book "common" is defined by the memory entries. `stopwordDocFreq`'s 25% bar shifts.
- Every BM25 tuning figure (`bm25K1`, `bm25B`, `lexicalWeight`) was measured on a vectorized-only corpus.
- `fuseRanks` `txtOK` is `mode !== 'vector' && vectorable(it)` — text eligibility is currently tied to
  being vectorized, and would have to become "has content in the lexical index", i.e. everything.

### B. BM25 in the browser for the plugin-less path — or at least profile it

Without the plugin there is no content-lexical signal for anyone: `worldsapart.js:559` defaults `bm25` to
0 because ST's own `/query-multi` returns no such field. So retrieval is cosine-only, `lexicalWeight` has
nothing to act on, and nothing tells the user — the setting they would look at is called `meanCentered`.

Feasible client-side with no wire transfer: `syncWorld` already chunks in the browser
(`worldsapart.js:333`), `lexical.mjs` names the extension as an intended consumer, and three plugin
modules are already imported extension-side. `buildLexical` is O(total tokens) over the book's chunks,
once per corpus rather than per query, and `syncWorld` computes a natural cache key. **Profile before
building** — that is the cheap half and it decides whether the rest is worth it.

**It recovers ranking, not admission.** ST selects its top-K by cosine before WA sees anything, so the
`bm25 > 0` admission clause still cannot fire on that path — and that clause is what rescued sommers'
grade-5 entries when a strict cosine gate was tried. `admitCeiling(false)` asking for 300 chunks bounds
the loss by depth rather than by a threshold, which is mitigation rather than a fix.

## Open items for adjudication after this lands

Carried from the spec, none blocking:

1. Whether `POOL_ARMS` survives at all — its criterion no longer separates the remaining three arms.
2. `uncenteredGate: 0.5` — "cost NOTHING, identical entries kept" was measured against a cut of ~10; the gate now sees the whole admitted set.
3. The `keys-live` residue — an entry whose collection failed to sync, an entry past the ceiling on a larger book, the chunk-bounded fallback path.
