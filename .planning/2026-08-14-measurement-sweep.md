# Which measurements survive the stage-4 cutoff rearchitecture

Companion to `2026-08-14-stage4-cutoff-rearchitecture.md`. Planning artifact — not committed. Nothing
here is deleted by this file; it says which claims to keep, which to re-run, and which to remove when
the change lands.

## The criterion

A measurement survives if the change does not move the population it was computed over.

- **Corpus counts** describe books and chats. Nothing about where the cut sits touches them.
- **Matcher measurements** describe `countKey` and the fold. Stage 2 matching is untouched.
- **Retrieval-ranking measurements** grade `fuseRetrieval`'s ordering with no cut involved, and the
  plugin-path candidate set does not move: topK is `max(100, maxVectorEntries * 2)` = 100 today and
  100 after. The fallback path goes 100 → 300 and is the exception.
- **Layout-ranking measurements** graded the entries a stage-1 cut admitted — the live cut at runtime,
  or a count-mode prefix of 20 (`/wa-grade`) or 30 per arm (`/wa-super-grade`) under a capture. That
  population becomes the whole admitted set, so the measurement is of a different thing.
- **Cutoff measurements** describe a stage-1 cut that will not exist.

## A. Corpus facts — survive

`matcher-design.md`

- :83 — 147 of 46,230 keys start with `?`, 6 books, all validate clean
- :88 — 0 keys contain `^` followed by a digit
- :118 — regex keys are 2 of 46,226, in 2 of 41 books
- :236 — 822 `_Joe_`-shaped cases in 178.8M chars
- :247 — 66 of 2,120 enabled entries tick whole-word AND hold a multi-word key
- :434 — 26 of 2,699 enabled entries are `delayUntilRecursion: true`
- :438 — `excludeRecursion` 526/579 public-book entries against 140/2,120 here
- :458 — 79 of 2,112 enabled entries use selective logic, 77 `AND_ANY`
- :520 — fold divergence: 9 keys of 1,229, unioned over 177,499 usable messages
- :552 — 2 of 3,403 keyed entries are SmartKey-only
- :674 — curly-apostrophe distribution over 196 chats
- :691 — prune fires on 319 of 115,527 core keyword activations
- :696 — 0 of 2,112 enabled entries in an inclusion group
- :151-189, :279-281 — the slop, conjunction and segment-scope counts

## B. Matcher and pure functions — survive

Stage 2 matching and `countKey` are not touched by this change.

- `matcher-design.md:129` — 100 regex keys × 300 entries × ~1KB is 9.8 ms when nothing matches
- `matcher-design.md:274` — 1.01x for 8 segments against one join
- `matcher-design.md:140` — the `countKey` behaviour claims

## C. Retrieval ranking — numbers survive, standing narrows

These grade `fuseRetrieval`'s ordering. They are nDCG/MRR, so under the rule at
`matcher-design.md` *Evidence → Two scores* they are diagnostics and are not evidence the system works.
The figures hold; what they license does not.

`extension/state.mjs`

- :182-191 — retrievalMode, 785 trials: bm25 0.474 MRR / 63.3% recall@5, vector 0.468 / 64.8%,
  hybrid 0.515 / 69.7%
- :197 — mean-centering +8.8% nDCG@5
- :243 — entityFilter, mean nDCG@5 0.896 filtered vs 0.808 unfiltered
- :257 — stopwordDocFreq 0.25, all 5 gold targets in the top 5, mean rank 3.0
- :294 — chunking, paragraph against message
- :135-149 — the `admit=cosine` strict-gate result. Survives and **gains** weight: admission is
  load-bearing once stage 1 stops cutting.

## D. Layout ranking at nDCG@10 — redo

Each graded the layout ranking of the entries a stage-1 cut of ~10 admitted.

- `state.mjs:266-269` — messageDepth dose-response, n=80 graded scenes, paired
- `state.mjs:347-357` — keywordWeight dose ladder, n=83 graded scenes, paired

The grader noise floor at `state.mjs:355` (the same grader re-scoring one scene moved its nDCG@10 by
0.058) survives and governs the redo: no unpaired or cross-capture comparison at this size means
anything.

## E. Cutoff — remove

Measures a stage-1 cut that will not exist. Replaced by a note naming what each measured and at which
stage; see the rearchitecture spec, *What comes out of the files*.

- `extension/selection.mjs:17-42` — the %oracle table
- `extension/selection.mjs:47-52` — the elbow's minimum retrieval depth
- `extension/selection.mjs:57-59` — dropoff bimodality on sommers
- `extension/state.mjs:211-223` — elbow-vs-count over 3 graded scenes, and the weak-scene failure mode
- `extension/state.mjs:236` — dropoff cliff size ~0.08 on Orient-Express and Vegas
- `worldsapart.js:509-521` — the topK plateau

## F. Re-check

- **`uncenteredGate: 0.5`** (`state.mjs:158-167`). "At 0.5 the gate cost NOTHING on any real scene
  (identical nDCG, identical entries kept)" was measured against a cut of ~10; with the whole admitted
  set passing through it, the gate has far more entries to bite on. The raw-cosine margins themselves —
  relevant entries >= 0.538, wrong-genre books topping out at 0.47-0.54 — are an embedder and corpus
  fact and survive.
- **The `applyBudget` offline replay** (`matcher-design.md:641`), verified exact against the runtime on
  315 rows across 7 arms. A correctness check whose subject gains the vector cap, so it re-runs.

## Entangled

`matcher-design.md:631-635`, the asymmetric-bar result. The ruling — recall at grade >= 3, precision at
grade >= 2 — is a claim about the metric and survives. Its supporting numbers came from stage-1 cutoff
arms and belong to group E. Keep the ruling, re-derive the table.

## The redo

D and E are the work: two tuning defaults and the whole cutoff story. F is two re-checks. A, B, C and
the rater measurements in `CLAUDE.md` stand.

Sequence follows the pool. Every post-change arm scores unjudged rows 0 until the rows the new admission
depth surfaces have been judged, so D cannot be re-run first. `CLAUDE.md`'s rule that a grade mean is
only comparable at matched retrieval rank governs that extension, and joining through the arm's
`candidates` is the only way to get the rank a `grades` row was judged at.

**Extend by delta, and migrate wherever a shape change suffices.** Grading is the expensive step; nothing
already judged is judged twice. `/wa-super-grade` subtracts loaded grades, `graft-grades.mjs` carries
them onto a fresh capture, and `grade-pending.mjs` builds jobs only for the `*-pending` remainder.
`split-rater.mjs` is the worked case for the migration half — 8394 rows rewritten, no model call.

The re-pool is cheaper than the depth suggests. `/wa-super-grade` does not bypass the cut — each arm is
a count-mode prefix, 30 deep — so the pool grows with the per-arm depth and shrinks with the arm count.
`vector` and `lexical` drop outright, and the section as a whole is close to obsolete: `eval/scene.mjs`
models stage-1 admission in full and scores keywords through the shared matcher, so the only thing left
unmodelled is core's gates — which no arm reaches either (see the rearchitecture spec, *Capture and
tooling*). The depth cap stays a live knob regardless; it is now the grading budget rather than a way to
see past the cut.
