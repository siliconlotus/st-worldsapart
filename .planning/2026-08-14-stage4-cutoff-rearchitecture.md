# Moving the relevance cut from stage 1 to stage 4

Spec. Planning artifact — not committed, and not the design record. `matcher-design.md` and the affected
file headers get their edits when the change lands, not from this file.

## What this is

`matcher-design.md` *Principles*: the system makes exactly one relevance decision and makes it at stage
4; stages 1 and 2 admit generously, on rules that need no taste. Today stage 1 arbitrates instead —
`cutRetrieved` cuts the retrieval ranking on a score cliff, before keys exist, before activation, and
before the budget exists.

This moves that cut onto the layout ranking. It is a structural change: every default holds at its
current value, so a behaviour difference is attributable to the cut moving rather than to a number.

## Stage 1

`retrieve()` (`worldsapart.js:728`) admits; it does not cut.

- `fuseRetrieval(scores)` produces the retrieval ranking. The `cutRetrieved` call at :780 goes, and
  `winnerKeys` with it.
- `lastScores` / `lastTextScores` are populated for all of `ranked` rather than for survivors
  (:790-795). Stage 3 looks vector and text scores up from these, so a survivor-only filter leaves every
  newly-admitted entry without the two signals it was admitted on — and a missing signal reads as a low
  score, not as an error.
- `targets` returns unfiltered (:797).
- `runState.lastCutKept` moves to stage 4.

### The admission ceiling

`Math.max(100, settings().maxVectorEntries * 2)` (:529) does not survive `maxVectorEntries` moving
downstream. It becomes a constant, documented as a safety limit on what a pathological scene may feed
core's scan loop — *Principles* permits that explicitly, the admission bound being a safety limit rather
than a verdict on relevance.

The constant is path-dependent, because `queryCollections` (:262-299) has two paths and topK counts a
different thing on each:

- **Plugin path** (plugin present and `meanCentered` — the default): `poolEntries` runs server-side
  before `selectTopK`, so K counts **entries**. Ceiling **100**.
- **Stock-ST fallback** (:294-299 — plugin absent, plugin errored, or `meanCentered: false`): no
  pooling, so K counts **chunks** and the client loop at :545-577 pools over only what K let through.
  Ceiling **300**: measured chunks/entry is 9.1-10.3 and per-entry maxima do not stabilise until
  K ≈ 150-300 (`scoring.mjs:66-74`). This is what the old `* 20` multiplier was for.

One number for both paths would mean "100 entries, correctly pooled" on one and "100 chunks, with
understated per-entry maxima" on the other, and those understated scores feed the stage-4 cliff.

The measurement justifying the old floor of 100 (:509-521, the elbow's mean-gap window saturating by
topK 60) is deleted rather than moved — it measures a property of the retrieval list, which the cliff no
longer reads. The pooling half of that comment survives, as does the note that RRF ranks within the
candidate set, so changing topK reorders the head as well as lengthening the tail.

`scoreThreshold`, `uncenteredGate` and the `bm25 > 0` admission clause are untouched.

## Stage 4

`rankActivated()` (`worldsapart.js:1447`), after `fuseRanks(items)` at :1631 and after `results` is
sorted into retention order at :1688-1693, so the cliff reads the order the budget walks:

```
kept   = cutRetrieved(results)                    // cliff: relevance
ranked = [...sticky.sort(authored), ...constant.sort(authored), ...kept]
applyBudget(ranked, …)                            // caps: capacity
```

**Cliff losers get their own delete from `activated`.** They cannot ride the budget's loop at
:1716-1720, which walks `ranked` — a cliff loser is not in `ranked` by construction.

**The cliff runs outside the guard at :1701.** An irrelevant entry should not reach the prompt whether
or not there was room for it; relevance and capacity are orthogonal, which is why there are two cuts.
That guard is `maxTokens > 0 || maxTotal > 0 || maxDynamic > 0 || bookCaps.size`, which passes on
shipped defaults through `maxTokensPercent: 40` and fails at `maxTokensPercent: 0` (`state.mjs:383`).

**`runState.lastRanked` holds the pre-cliff population.** It is what `/wa-debug` and `/wa-grade` capture
at :1789, and a row has to exist for every entry stage 4 chose between, including cliff losers.

**The cliff's population is the whole dynamic block** — retrieved entries and keyword-activated
reference entries together, per "arbitrates, once, over the whole heterogeneous set". A score cliff can
therefore drop a keyword-activated entry with the budget wide open, where today only budget pressure
can. This stands against *triggered == relevant* (`matcher-design.md` *Evidence → Tiers*), and that
tension goes into the design doc.

**Sticky and constant are outside the cliff's population.** The budget may cut a constant for capacity;
the cliff may not cut it for relevance. *Principles* lists `constant` among the author declarations the
one relevance decision does not absorb. Only `ignoreBudget` exempts an entry from the budget
(`authorIgnoreBudget`, `selection.mjs:128`); the hoist gives sticky and constant first claim on it, not
exemption from it. A constant also has no vector score and often no keys, so its fused score is low by
eligibility rather than by irrelevance, and in the cliff's population it would cut immediately and
distort the mean gap.

### `applyBudget` gains a vector cap

One `blockedBy` clause beside `'total'` / `'dynamic'` / `'book'` (`selection.mjs:205-214`):

```js
if (maxVectorEntries > 0 && isVector(item) && vector >= maxVectorEntries) {
    blockedBy.push({ cap: 'vector', shortfall: 1 });
}
```

with `vector` incremented alongside `dynamic` in the admit block. The header already documents the
nesting this fills — "The populations are nested — vector ⊆ dynamic ⊆ all".

`isVector` is provenance, not the `vectorized` flag: `item => runState.lastScores.has(item.key)`,
injected by the caller like `isDynamic`. The cap bounds what retrieval contributes, so a vectorized
entry admitted on a key it kept (`suppressVectorKeys: false`) counts as keyword. The two readings
coincide under the default and diverge only with suppression off.

## Settings

| setting | change |
|---|---|
| `maxVectorEntries` | 20. Stage-4 cap on vector entries within the dynamic block. Doc comment rewritten. |
| `vectorCutoff` | Modes become `'off' \| 'elbow' \| 'dropoff'`, default `'elbow'`. `'count'` retires — `maxVectorEntries` is the count. `'off'` stays; `paired-arms.mjs` needs the cliff-disabled arm. |
| `minVectorEntries` | 3. Floor on the dynamic block rather than on the retrieval list. |
| `maxTotalEntries`, `maxDynamicEntries` | Untouched, both 0. The cliff does the cutting. |
| `scoreThreshold`, `uncenteredGate` | Untouched. |

## What comes out of the files

Every cutoff measurement in `selection.mjs` and `state.mjs` describes a cut over the retrieval ranking.
On the layout ranking the cliff spans an eligibility-normalised, heterogeneous list — entries carrying
vector+text+keys beside keyword-only entries — so the mean gap is not the same quantity.

Deleted, replaced by a note naming what they measured and at which stage: the `%oracle` table
(`selection.mjs:17-42`), the topK plateau (`worldsapart.js:509-521`), the elbow-vs-count scene results
(`state.mjs:211-223`). `elbowSensitivity: 1.5`, `minVectorEntries: 3` and `dropoffThreshold: 0.06` keep
their values, labelled as carried-over defaults with no current measurement behind them.

## Capture and tooling

- **`effectiveCutoff` / `runState.gradeCutoff`** (:3088-3101) move to stage 4. The override forces
  `count` at a depth — 20 for `/wa-grade` (:2368), 30 per arm for `/wa-super-grade` (:2859) — so a
  capture is deep enough to replay any cutoff mode offline. At stage 4 it disables the cliff and
  **keeps the depth cap**: with no cliff and no stage-1 cut, a capture would otherwise pool the whole
  admitted set, and grading cost scales with the union across arms. The knob stops meaning "widen the
  cut to see past it" and starts meaning "cap the grading budget". Call sites: :2367-2369, :2517-2521,
  :2599-2621, :2946-2950.
- **`POOL_ARMS` (:2537-2564) needs its criterion restated, not just its membership edited.**

  `vector` and `lexical` clearly go: they qualified because `retrievalMode` decided "which signal orders
  the candidates, so a different set survives into the top of the ranking", and with no stage-1 cut
  there is no top to survive into, leaving pure reordering.

  The other three fail the criterion as written — "unable to compute the population offline" — because
  `eval/scene.mjs` `makeCandidateSet` calls the real `scoreCollection` with the real gates, `poolEntries`
  and `selectTopK` (:351), so stage-1 admission is modelled in full:
  - `loose-thr`: `thr` resolves from `P.threshold` at :350, `'auto'` quantile included.
  - `no-filter`: `termWeights` is a parameter (:351), and the preloaded-sweep guard at :428 names only
    the two gazetteer settings, so `entityFilter` sweeps preloaded.
  - `keys-live`: modelled at :392 (activation guard) and :231 (gazetteer). Its stated justification,
    that core's activation cannot be recomputed offline, describes a version of activation the takeover
    replaced — `suppressVectorKeys: false` now lets WA match vectorized entries, and WA's matching is
    pure. It cannot ride a preloaded sweep, which :428 already enforces, but it derives per-arm load.

  The criterion has no replacement that saves the remaining three, and the section is close to obsolete.
  Matching is modelled faithfully — `scene.mjs` scores through the shared `matcher.keywordScore`, which
  is what fires at runtime, so a derived keyword row is a row WA would activate. What the offline loop
  still cannot model is core's GATES: probability rolls, inclusion-group contention, delay and cooldown,
  character and tag filters, `@@dont_activate`, `delayUntilRecursion`, triggers. No pool arm reaches
  those either — a probability roll and a group contest are not made reproducible by adding an arm. So
  the gap is real and arms are not the instrument for it.

  Settle the section's fate against that before editing membership beyond the two clear drops. Secondary
  keys are WA's (`synthesizeSecondary`/`countSelective`) and are not among the gates.
- **`cut` / `cutBy`** already derive from `applyBudget`'s `blockedBy` (:1795). Cliff losers join with
  `cutBy: 'cliff'`, so a row records which of the two stage-4 decisions rejected it.
- **`reportVectorCandidates`** (:694-708, called at :787 and :2244) loses its `cut` argument. The stage-1
  table reports what was admitted; the cut belongs to the stage-4 table.
- **`grading.mjs`** parameter snapshot (:100-110) is unchanged in shape.

## Evals

`eval/scene.mjs` is the single place the cut moves from the retrieval ranking to the fused layout
ranking; `graded-scene-grid.mjs` and `paired-arms.mjs` go through it and inherit. A second copy of the
cut must not appear — same rule as the gazetteer and the scorers.

- `graded-scene-grid.mjs:328` and `:441` call `cutRetrieved` on the retrieval ranking; both move to the
  layout ranking. In its arm sweep (:412-414) `count max=N` becomes `maxVectorEntries=N` and is no
  longer a `vectorCutoff` mode.
- `cutoff-grid.mjs` keeps working and now describes a stage-4 parameter; its header says which stage.
- `elbow-check.mjs` is unaffected — `cutRetrieved`'s contract does not change, only its call site.
- The vector cap goes into `budget-check.mjs` alongside the existing cap cases.

Three new checks, all pure:

1. A cliff loser is deleted from `activated`, and sticky/constant never enter the cliff's population.
2. Stage 1 admits everything and stashes a score for everything.
3. The admission ceiling returns the entry-count number when the caller pools server-side and the
   chunk-count number when it does not. The choice stays a pure one-argument function; inside
   `scoreEntries` it would be a branch no check reaches, on a path that only runs when the plugin is
   missing.

Existing pools were captured as a count-mode prefix of the retrieval ranking — 20 per `/wa-grade`, 30
per `/wa-super-grade` arm — and hold no keyword-only layout rows, so an arm that surfaces those scores
them 0. Every post-change delta is a lower bound until those rows are judged.

**Extend the pool by delta; never re-pool.** Grading is the expensive step, so nothing already judged is
judged twice. `/wa-super-grade` loads earlier samples and subtracts their grades; `graft-grades.mjs`
carries existing grades onto a fresh capture; `eval/synthetic-data/grade-pending.mjs` builds jobs only
for `*-pending` rows. What needs judging after this change is exactly what the new admission depth
surfaces that no pool already holds. Where a shape change is enough, migrate rather than re-grade —
`eval/synthetic-data/split-rater.mjs` is the worked example, having rewritten 8394 rows without a single
model call.

## Out of scope

- **Tuning the `bm25 > 0` admission clause.** After this change it is a cost item, not a relevance one:
  stage 4 arbitrates, so admitting a useless entry costs the work of carrying it through stages 2 and 3
  rather than costing precision. `scoreThreshold: 'auto'` is `quantile(vectorScores, 0.9)`
  (`scoring.mjs:36`), a top-decile selector rather than a floor, so admission is "top 10% by centered
  cosine OR any lexical overlap" and the slack is on the lexical side. The symmetric tightening is
  `bm25 >= quantile(nonzero, q)`, and **the offline arm already exists** — `P.bm25FloorPct` in
  `eval/scene.mjs:355-358` computes exactly that floor over the nonzero scores, with `P.bm25Floor` for
  the absolute form and `P.admit` for the strict variants. Only the plugin side is unwritten. Its metric
  is entries admitted per scene at an unchanged shipped set. The "80-95% of chunks" figure
  at `state.mjs:131` names no measurement and should be re-measured before it is tuned against.
- **Retuning any cutoff default.** Nothing grades stage 4.
- **The layout score** (expected `F2@budget` over the dynamic block), which is what the tuning questions
  wait on. See *Risk*.
- **`ownActivation` removal**, recursion scoring, trigger-depth weighting.

## Consequences accepted

- **Stage 2 widens irrecoverably.** In `world-info.js`, `filterByInclusionGroups` (:5012) and
  `buffer.addRecurse` (:5142) both run before the `WORLDINFO_SCAN_DONE` emit (:5175), so a stage-4
  delete takes back neither: inclusion groups pick winners from a wider field and the recursion buffer
  carries more entries' content. Bounded by `world_info_recursive` defaulting off and by
  `excludeRecursion` sitting at 91% of public-book entries against 6.6% here — a property of the corpus,
  not of the design.
- **`selectTopK` unions top-K by vector with top-K by lexical** (`scoring.mjs:103-105`), so the plugin
  path's ceiling of 100 admits up to ~200 entries deduped; the constant bounds per signal. The fallback
  path has no such union.
- **Per-generation cost.** Up to ~200 entries through core's gate stack per pass, stage-3 key scoring
  over the scan window for each, and a `tokensOf` call per dynamic entry once `maxTokens > 0` — against
  ~10 such calls today. Admission width is the only thing controlling it, which is what makes the
  lexical-admission item the natural follow-on. Measure entries admitted per scene before and after.

## Risk

This moves the one relevance decision to the stage nothing grades yet, and it is the prerequisite for
grading it. Whether `elbow` survives, at what sensitivity, and what `maxVectorEntries` should be are
unanswerable TODAY because the cut sits on a ranking that cannot see keys and does not know the budget —
no sweep of that ranking answers a question about the set that ships. Landing the move does not answer
them either; it makes them answerable, against a cut that sits where the evidence is.

The structural move therefore stands on *Principles*, with every default held at its current value. The
measurement it unblocks is the tuning pass, and `graded-scene-grid`'s cutoff-arm table is that pass's
instrument — superseded by this change and rewritten by that one, not by this one.

What the tuning waits on is the **layout score** — expected to be `F2@budget` over the dynamic block,
set-based and asymmetric: recall at grade >= 3, precision at grade >= 2. Set-based because what ships is
the surviving set and rank is only how it gets chosen; recall-weighted because a missing must-deliver
entry costs more than a delivered 2. It is not the whole two-score split. The split's other half is
answered structurally rather than measured: with no relevance decision at stage 1, the vector score
stops being a quality metric and becomes a recall diagnostic (was the relevant entry admitted at all)
alongside the admission-cost measure the lexical item needs.

Two definitions in `matcher-design.md` lose their referent when this lands, and both belong to the
design-doc edit rather than to this change: the vector score's ("grades `fuseRetrieval`'s output, cut by
`cutRetrieved`"), and the layout score's, which *Evidence* still gives as `nDCG@budget` — against the
four-stages rule that nDCG is a diagnostic for whether the ordering earns its keep and not evidence the
system works. *Open work* #1 shrinks to the layout score.
