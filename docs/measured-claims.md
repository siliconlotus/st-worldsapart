# Measured claims

Findings the docs and code cite by ID. Each is reproducible without WorldsApart's author's lorebooks:
a synthetic benchmark, a fact about a model or about SillyTavern, or a result that depends only on
sizes rather than on which book. Claims that rest on particular books or chats are not here and are not
published; the docs cite those by ID too, and the ID is all a reader gets.

**Identifiers are append-only and shared with the private register.** An ID is never reused, and a claim
moves between the two files without changing its number, so `grep <ID>` always finds one entry.

**Citations name a symbol, not a line.** A claim points at the exported function or constant its evidence
lives in, or at a heading — `extension/keyword-audit.mjs buildKeyPruneScan`, `docs/matching.md Stage 3 — Scoring
(onScanDone)` — so it survives an edit and `grep` finds it at any version. Several are separated by `,`
in code and by `§` in prose; a claim that cites a file and no place in it names the file alone.
`test/claims-check.mjs` asserts every cited path and symbol still exists.

**Nothing here names a book, a chat, an entry, a character or a line**, whether the author's or a
contributor's. A finding drawn from contributed bundles is quoted in aggregate — "over 250 bundles" —
and which bundles is not recorded.

**What counts.** A claim backed by a named measurement. Excluded: configuration values and thresholds
unless the threshold was derived from a measurement, spec facts stated without one, and pure arithmetic.

## R — Stage 1: retrieval, embedding space, query

- **R1** — Removing the stage-1 admission gate was a no-op: `bm25 > 0` admitted 99.9% of every book's
 indexed entries; removing `scoreThreshold` moved admission by 6 entries in 10,103 and recovered no
 relevant entry (70 graded scenes). — `plugin/scoring.mjs scoreCollection`; `docs/matching.md Divergences from ST core`; `CLAUDE.md Pure vs ST-coupled`.

- **R2** — A strict cosine gate would lose 110 of 672 graded-relevant entries: chunks below the corpus
 mean carrying the query's exact terms (70 scenes). — `plugin/scoring.mjs poolEntries`; `docs/matching.md Divergences from ST core`.

- **R3** — The old admitCeiling (100 entries / 300 chunks) bound on routine scenes — it sat below two
 of the seven books in the graded corpus: dropped 23 of 672 grade≥3 rows on 20 scenes; 200 recovered all but 2 and
 saturated; the gates admitted 100% of indexed entries on every scene measured.
 — `plugin/scoring.mjs poolEntries`; `docs/matching.md Divergences from ST core`.

- **R4** — Largest measured book: 208 vectorized entries, against the 1000-entry ceiling.
 — `plugin/scoring.mjs poolEntries, selectTopK`; `worldsapart.js`; `docs/matching.md Divergences from ST core`; `CLAUDE.md countKey is the only matcher`.

- **R5** — Chunks-per-entry ratio 9.1–10.3 (why no-plugin K counts 10,000 chunks).
 — `plugin/scoring.mjs selectTopK`; `docs/matching.md Divergences from ST core`.

- **R6** — Per-entry chunk maxima don't stabilise until K≈150–300 (three graded corpora) — why pooling
 is server-side. — `plugin/scoring.mjs scoreCollection`.

- **R7** — Stage-3 keywordScore cost: 13µs/entry at the corpus's widest window (22.8KB) and densest keys
 (19.6/entry), linear to 2000; 1000 entries ≈ 13ms/turn. — `plugin/scoring.mjs selectTopK`.

- **R9** — Mean-centering rationale: corpus mean vector norm 0.71 on a real lorebook; raw similarities
 compressed near 0.6. — `plugin/server.js`.

- **R13** — messageDepth dose-response, n=80 scenes paired vs each scene's own depth-10 capture:
 nDCG@10 climbs monotonically 1→10 (depth 3 −0.098 p=0.001; depth 5 −0.053 p=0.020), flat 10–15, dips
 at 20 (−0.009, p=0.044). ~6k chars of query at 10. — `extension/state.mjs defaultSettings`.

- **R14** — Core comparison (`eval/core-compare.mjs`, this corpus): core nominates 34.2 memory entries
 at 86.1% recall and at a 25k budget ships 14.4 at 66.4% — ~20 recall points cut by `entry.order`;
 per-book order tuning is worth +0.056 F2 to core; the untuned-order tie direction ~0.07 F2; 40.4% of
 vectorized rows carry a keyword hit; at scan depth 2 keys fire for 11 of 28 grade-4 entries vs 21 of
 28 at depth 10 (89 scenes). — `eval/core-compare.mjs`.

- **R18** — Per-book centring leaves book identity intact: 1-NN same-book purity 99.4%→98.2%.
 — `eval/lib/scene.mjs makeCandidateSet`; `eval/param-screen.mjs`.

- **R19** — Entity filter effect: unfiltered BM25 ran ~2x the filtered value on one real scene (101.06
 vs 46.11); re-measured over three graded scenes, mean nDCG@5 0.896 filtered vs 0.808 — real but far
 smaller than the original note claimed. — `worldsapart.js init`; `extension/state.mjs defaultSettings`.

- **R20** — Gazetteer source no longer moves the population: n=71 scenes paired, all four arms flat
 including `gaz=none` (nDCG@10 −0.0082, 28/42, p=0.120; F@R −0.0054, 19/15/37, p=0.608); at 70 scenes
 every arm returns a byte-identical candidate set (10,103 vector rows, 353 keyword rows, 670 of 672
 retrievable relevant), differing only in query terms (none 2911 / keys 4042 / shipped 6130 / bodies
 36,789 — bodies ≈ 5–10x the vocabulary; the keys-live arm read 9839). The `denseColumn` reweighting arms moved +0.0056 and
 +0.0005 nDCG@10 over the same 70 scenes — a question the vector weight asks directly. 
 — `extension/entity.mjs buildTermWeights, buildGazetteer`; `eval/param-screen.mjs`.

- **R21** — Entity-tuning trap run results (recorded so the metric choice survives): relevant-per-scene
 mean 9.9, variance 24.5, typically 5–11 per scene (var/mean 2.48 — 71 scenes on 3 stories showing
 through); nDCG@5 returned an
 identical 0.9322 for boost 1/2/3/5/8 on one scene; scoring within the activated pool returned 0.9634
 for every arm including no-filter; graded pools bottom out in zeros around rank 24–28.
 — `extension/entity.mjs buildTermWeights`; `eval/graded-scene-grid.mjs`.

- **R24** — Chunk settings: paragraph distribution over 3642 paragraphs of 604 memory entries — mean
 881, median 650, p90 1735, p99 4934; the old 800 cap fired on 36.5% of paragraphs, 1750 is that p90;
 longest paragraph 17,115 chars vs bge-m3's ~32,800 capacity (nothing ever truncated); ceiling sweep
 measured ~flat, 103 scenes on 5 lineages paired (+0.0045 @4k, +0.0063 @12k, +0.0017 @32k, none
 significant, 4 of 5 lineages positive). — `extension/state.mjs defaultSettings`.

- **R26** — matchWindow default: p90 is 19 paragraphs per message and 81.6% of scanned text lives in
 messages of six-plus paragraphs (one author's chats — a default, not a finding about everyone).
 — `extension/state.mjs defaultSettings`.

## E — Embedding models

- **E1** — No-plugin fit (text, properNouns, density — no embedding touched): held-out AUC 0.7979.
 — `eval/embedding-models.md What to use § Known gotchas`.

- **E4** — Delivered count is a corpus property, not a model property: at cutoff 0.10 all seven models
 deliver 13.3–14.2 entries; spread stays under 1 entry across 0.10–0.30 (eight fits quoted 13.2–14.2
 in matcher-design). — `eval/embedding-models.md Context length: check it against your scan window`; `extension/state.mjs runState`; `docs/matching.md Divergences from ST core`.

- **E5** — Cutoff sweep (shipped model): 0.05→26.8 delivered / 27.1% P / 83.9% R; 0.10→13.3/38.1/69.5;
 0.15→9.2/43.6/59.7; 0.20→6.5/45.5/52.1; 0.30→4.1/47.9/42.0. ~1.8k tokens per delivered entry (≈24k
 per scene at 0.10). Precision never exceeds 50.8% at any cutoff for any model.
 — `eval/embedding-models.md Speed § Hosted`; `extension/state.mjs runState`.

- **E6** — At F2's own optimum jina delivers 30.2 entries vs Qwen3-8B's 15.0 and still scores lower — a
 looser dial, not a better model. — `eval/embedding-models.md Known gotchas`.

- **E7** — Query instructions (same collections, only the query vector moves): Qwen3-8B's instruction
 is worth +0.0131 held-out AUC and +0.0235 F2, on 4 of 5 books; EmbeddingGemma's documented prefix
 pair is flat (0.7976 vs 0.7982) and gets neither. — `eval/embedding-models.md Two knobs, and they are independent`;
 `extension/relevance.mjs queryPrefix, buildNameDf`; `eval/lib/reindex.mjs ensureIndex`; `test/model-resolve-check.mjs`.

- **E8** — mxbai truncates at its 512-token context: two queries sharing a 2600-char prefix returned
 the identical vector (cosine 1.00000) vs bge-m3's 0.848 on the same pair; ~70% of a typical scan
 window (measured 6595 chars ≈ 1650 tokens) never reaches it; embeddinggemma did NOT truncate at its
 advertised 2048 in the same probe. — `eval/embedding-models.md Quantization: 4-bit DWQ costs nothing measurable § Speed`.

- **E9** — Quantization costs nothing measurable: 4-bit DWQ vs 8-bit mxfp8 on Qwen3-8B — −0.002 F2 mean
 (4 books up, 1 down); cosine solo AUC 0.833 vs 0.832; fitted AUC 0.8312 vs 0.8290; all inside SEs.
 — `eval/embedding-models.md Speed`.

- **E10** — Speed (M-series Mac, per 800-char chunk): MLX 8B 110ms; ollama 4b 277ms; llama.cpp 8B
 910ms (≈80 min for a mid-size library); transformers.js jina 553ms on one CPU thread, super-linear
 in length: 553ms @800 chars, 1.18s @1750, 5.49s @6595 — what a real query costs on ST's default.
 — `eval/embedding-models.md Before you switch § Known gotchas § Speed`; `worldsapart.js init`.

- **E11** — Hosted cost at $0.05/1M: ~$0.03 to index a five-book library; ~8¢ per thousand messages.
 — `eval/embedding-models.md Hosted`.

- **E12** — Storage: one book 38MB at dim 1024, 94MB at 4096. — `eval/embedding-models.md Before you switch`.

- **E13** — Fit transfer (2026-08-30, 74 bundles, jina and qwen8b as the extreme embedders):
 `UNFITTED_FALLBACK` = mxbai on lowest max regret (0.000/0.011; bge-m3 0.003/0.021, gemma
 0.022/0.036, noCosine 0.031/0.039, qwen8b 0.040/0.047); the penalty curve is asymmetric (too-high
 beta on a weak embedder costs 0.04–0.05, too-low on a strong one 0.01–0.02); noCosine identical on
 both embedders is the control. Caveats: own-fit diagonal is in-sample; 32 of 74 scenes rank unjudged
 rows in the window (lower bounds); interior fits measured only at 0.10. Every margin inside the
 corpus's noise floor. — `eval/eval-data/fit-transfer-2026-08-30/README.md` (gitignored);
 `docs/matching.md Divergences from ST core`; `extension/relevance.mjs fitKey` (mxbai beta +0.337, low-middle of seven).

- **E14** — Fits do not transfer across embedders: memory-tier cosine +0.3113 under bge-m3 vs +0.7460
 under Qwen3-8B (text and properNouns compensating); the signal ORDER inverts across models — bge-m3:
 text +0.794 / cosine +0.465 / keys −0.006 (8924 rows, 69 scenes); Qwen3-8B-4bit: cosine +0.762 /
 text +0.567 / keys +0.137 (6051 rows, 102 scenes). — `worldsapart.js init`;
 `test/relevance-model-check.mjs`; `CLAUDE.md Plugin changes need a redeploy`.

## F — Stages 3–4: the relevance model

- **F1** — The number of record: AP 0.346 at AUC 0.799 held out by book (in-sample 0.820, so an unseen
 book costs ~2.5% relative AUC). Shipped five-column model (cosine, text, keys, properNouns,
 density): AUC 0.7989 / AP 0.346 / F2 0.5139, delivering 17.5 entries against 4.0 relevant.
 Regression was measured no worse than RRF+nDCG and chosen for explainability.
 — `docs/matching.md`.

- **F3** — The asymmetric bar: hard ≥3 vs ≥2 on one scene reads P 0.542 vs 0.708, F1 0.703 vs 0.829
 with arm ordering barely moving; over 73 scenes the symmetric bar ranks shallow cuts on top and
 inverts at F4, the asymmetric bar keeps depth winning at every beta. — `docs/matching.md`.

- **F4** — Offline budget replay is exact against the runtime's verdicts on 315 rows across 7 arms;
 the token budget binds on every graded scene measured. — `docs/matching.md Divergences from ST core`.

- **F6** — The idf weighting is what makes it work: idf beats count 45 up / 14 down (p 0.0001);
 Jaccard is worse than count (27 up / 33 down); restricting to the gazetteer loses 15 up / 44 down
 (p 0.0002). — `docs/matching.md`; `extension/relevance.mjs properDensity`; `eval/relevance-regress.mjs`.

- **F7** — The `entity` extractor beats the private ASCII regex it replaced: F2 0.5443→0.5476 paired
 over 88 scenes (47/17/24, p 0.0002); validation-fold AP 0.873→0.883. — `docs/matching.md`;
 `eval/relevance-regress.mjs`.

- **F8** — Multi-token spans add nothing: −0.0019 F2 (18/28/48, p 0.184), 2 of 5 books, AUC identical
 to the third decimal, signal weaker solo (AUC 0.755→0.739, beta 0.325→0.247). 105 bundles / 102
 scored scenes. — `docs/matching.md`.

- **F10** — Length is earned but over-read: P(grade≥3) rises 5.6→6.3→9.6→13.0% across entry-length
 quartiles (6107 rows), but the signals track length ~3x harder than relevance does — r(log length, ·):
 grade 0.100, text 0.308, properNouns 0.284, cosine 0.349. Under a budget it binds: one turn's 25,083
 tokens bought 13 entries averaging 1945 tokens against a population mean of 1385.
 — `docs/matching.md`.

- **F11** — The length/density lattice: `length` costs wherever it sits (F2 0.4801→0.4723 alone;
 −0.0094 mean given properNouns; −0.0069 given both, 12 up / 53 down; −0.5 precision points at
 matched 70% recall); `density` earns +0.0129 given properNouns (56/21, p 0.0001) and +2.8 precision
 points at matched recall; the pair peaks at cutoff 0.08 where properNouns alone peaks at 0.13 (17.7
 vs 10.9 delivered). What `length` did was correct properNouns' un-normalised count (its coefficient
 −0.366 without text, collapsing to −0.128 (SE 0.049) without properNouns); shipped-with-length reads
 0.7958 / 0.345 / 0.5070 at 20.0 delivered. — `docs/matching.md`.

- **F13** — Story-time position (uid) carries nothing: −0.0055 mean F2, 24 up / 53 down (p 0.0013),
 AUC flat. — `docs/matching.md`.

- **F14** — Polynomial and interaction terms measured worse: `--degree 2` costs AUC 0.7989→0.7966, AP
 0.346→0.336, F2 0.5139→0.5109 while gaining in-sample; only properNouns² nears 2 SE (−0.066, SE
 0.034); `keys²` reads +0.002 (SE 0.019) — it once destabilised at +2.244 (SE 1.418), which was the
 blanked column, not the signal. `--interactions`: AUC→0.7971, AP→0.328, F2→0.5074; cosine*text
 +0.135 (SE 0.070) the only near-2-SE term, the two carrying keys pure noise (−0.017 and −0.021, both
 under one SE); retried with properNouns live: cosine*properNouns −0.059 (SE 0.063),
 text*properNouns −0.016 (SE 0.039), AUC 0.7980→0.7973, paired 14/12/42.
 — `docs/matching.md`.

- **F16** — An ungraded row is not a negative: `--ungraded-negative` moves rows 6051→7088, prevalence
 6.26→5.35%, AUC 0.8015→0.8185 while AP falls 0.342→0.321, precision at 50/75/90% recall
 27.6/14.3/8.8→26.0/13.6/8.6%, F2 0.5081→0.5021 delivering 18.9 vs 17.9. — `docs/matching.md`.

- **F17** — AUC flatters rare bands: at grade ≥4 it reads 0.975 while 90% recall costs 17.5%
 precision. Grade-4 on the shipped design: AUC 0.8877 at 0.63% prevalence, AP 0.139, precision 3.4%
 at 75% recall — and half the grade-4 rows were straddlers; removing them halved prevalence and cut
 AP 0.324→0.139 (the signals were finding the paraphrase). — `docs/matching.md`.

- **F18** — Tier signal coverage: 99.8% of memory rows vectorized; 84% of reference rows keyword-only;
 solo AUC memory/reference — cosine 0.713/0.448, text 0.759/0.662, keys 0.687/0.668.
 — `docs/matching.md`; `extension/relevance.mjs properNounsOf`.

- **F19** — `density` inverts on reference: −0.935 (SE 0.185) vs +0.215 on memory, solo AUC 0.336
 there.
 — `docs/matching.md`; `extension/relevance.mjs properDensity`; `worldsapart.js init`.

- **F25** — Per-book standardisation reverses the pathology and loses the score: share-vs-scene-max
 correlation −0.158→+0.486, size-dependence 0.928→0.652, share spread 7.1→11.9 points, mean delivered
 17.8→9.4 (94 scenes); F2 0.5102→0.4671 with AUC 0.8076 vs 0.8198; `--beta 1.5` halves the gap
 (0.4594 vs 0.4396) — mostly the smaller delivered set, but no beta closes it.
 — `docs/matching.md`.

- **F28** — Straddling entries are the haystack paraphrased: 66 of 446 memory positives straddle their
 scene, within-scene z 2.795 vs clean positives' 0.800, ranking first in 53% of their scenes vs 7%.
 `dropUnavailable` removes 43% of graded rows and 20% of grade≥3 rows over the 96 syn scenes; on one
 frozen capture 105 of 213 candidates post-dated the turn and 18 cleared the cut; missing the filter's
 books half once read precision 33.5% → 15.5% (`test/paired-check.mjs`).
 — `extension/relevance.mjs properNames`; `eval/lib/scene.mjs dropUnavailable, lineagesOf`; `test/relevance-model-check.mjs`; `extension/state.mjs defaultSettings`.

- **F29** — The scale is ordinal in the signals and the flat spot is memory's: cosine across the four
 boundaries +0.682 / +0.625 / **+0.468** / +0.901 (the operational ≥3 cut is the flattest); grades 2
 and 3 sit together and cosine inverts across them (+0.748 vs +0.694); reference is monotone
 (+0.123 / +0.588 / +1.397). — `docs/matching.md`; `extension/relevance.mjs postDates`.

- **F30** — Calibration: P(≥3) indistinguishable from calibrated (ECE 0.0077 vs 0.0067 null, p 0.252);
 P(≥2) 0.0112 vs 0.0080 (p 0.080) — no longer the leaked corpus's p 0.002; most of that bias was the
 straddlers. Reference unmeasurable at n=342 (ECE p 0.336 / 0.044); the tiers differ 25-fold in rows.
 — `docs/matching.md`; `eval/lib/logistic.mjs`.

- **F31** — The probability clamp: 39 of 8975 rows invert P(≥3) > P(≥2), by at most 0.0002.
 — `docs/matching.md`; `extension/relevance.mjs scoreRelevance`; `eval/relevance-regress.mjs`.

- **F32** — Grade-2 rows are a steady ~20% of what E[credit] surfaces at every depth (22.0% of top-5,
 19.4% of top-20) — they pay into precision, not recall. — `docs/matching.md`.

- **F34** — Two cutoffs, one per tier: memory peaks at 0.08 (F2 0.5139, 17.5 vs 4.0 relevant),
 reference at 0.19 (F2 0.806, 6.5 vs 2.5); both curves flat (memory within 0.012 of best across
 0.10–0.20, reference within 0.03 across 0.05–0.25) — a cutoff is a range, a third decimal is false
 precision. — `docs/matching.md`.

- **F35** — Reference cosine wants `denseAllEntries`: fitted only on entries that happen to carry one
 it is an absence indicator (−0.281, SE 0.119, solo AUC 0.442 — below chance, inverting on the
 vectorized entries where it is real); computed for every entry: +0.683 (SE 0.122), solo AUC 0.759,
 the tier's strongest signal — AUC 0.7417→0.7712, held-out 0.679→0.718, F2 0.7674→0.7746 at shared
 0.17 (25/9/32, p 0.0090), 6.4 vs 6.8 delivered for 2.9 relevant; 647 rows / 84 scenes. Cosine was
 missing on 124 of 135 reference entries — missing because nobody computed one, not because the
 quantity does not exist.
 — `docs/matching.md`; `worldsapart.js init`.

- **F37** — Reference tolerates a weak fit: AUC 0.733→0.698 held out (vs memory's 0.820→0.799), on 342
 vs 6051 rows. — `docs/matching.md`.

- **F38** — The tier base-rate argument was measured wrong: pooled the tiers look 3.7x apart [5x at
 `:1522` — D6], but base rate correlates −0.63 with grading depth, and at matched rank the tiers are
 indistinguishable at the head (38.4% vs 37.7% at K=10, gap growing with K). Depth-filtering selects
 the rater: `judged >= 50` drops 39% of human grades while keeping 8536 of 8546 judge rows.
 — `docs/matching.md`.

- **F39** — Tier base rates as the eval uses them: memory ~7%, reference ~30%; a threshold that read
 as a clean win (69% less material for 29% less relevance) kept 93% of relevant reference rows but
 only 56% of relevant memory rows — why `tierRecall` is a standing readout.
 — `eval/lib/scene.mjs`; `test/paired-check.mjs`; `eval/lib/logistic.mjs`.

- **F40** — Keyword tilt dose-response is closed: 13 doses 0.75–3 over 70 scenes, unimodal on both
 metrics, joint plateau [1.25, 1.3]; the standing arms are tripwires (tilt=1 ~−0.02 F@R, tilt=1.5
 ~−0.02 nDCG). — `eval/param-screen.mjs`.

- **F42** — The metric window is load-bearing: moving from top-10 to the admitted set roughly halved
 the tie columns across five arms on 103 scenes (82→52, 84→47) and reversed the sign of the largest
 per-lineage effect. Letting an arm pick its own cutoff misleads the same way: the properNouns arm at
 0.04 vs baseline 0.10 delivered twice as many entries and moved 39 of 63 scenes' F2 DOWN while the
 macro mean went up. — `eval/param-screen.mjs`; `eval/relevance-regress.mjs`.

- **F43** — Fit-matrix statistics come from every candidate, not the graded subset: at 73% pool
 coverage (the worst turn) the graded-only statistics delivered 49 entries where the fit's own gave
 35; coverage falls as scenes grow (r −0.661); well-covered scenes unaffected (3 vs 3 at 93%).
 — `eval/relevance-regress.mjs`.

- **F44** — Centroid population (memory tier vs `vectorized`): measured flat — −0.0003 n@10, −0.0016
 F2, paired over 103 scenes [104 in `worldsapart.js` — D10] on 4 lineages; the two centroids sit
 at cosine 0.99873–1.00000 across 6 books — ~0.002 of centroid movement, far below what the fitted
 cosine coefficient could read, so it needs no refit. The
 displacement the switch fixes: memory centroid at 0.99106–0.99896 of the pooled mean vs the
 reference centroid's 0.81806–0.97998 (memory is 59–93% of chunks; worst at 7.3% reference; 7 books).
 — `docs/matching.md`; `worldsapart.js`; `eval/lib/scene.mjs makeCandidateSet`.

- **F52** — Runtime/harness parity: on one browser capture (16 scored rows), `properNouns` reproduces
 from `extension/relevance.mjs` to the capture's own rounding. — `docs/matching.md`.

- **F53** — Per-book and per-scene standardisation lie on ONE cost curve, so the F25 loss was a cutoff
 artefact rather than a model difference. Both fits refit on the same 100 scenes (`--lobo --cutoff`,
 memory tier), then swept over `memoryCutoff` 0.04–0.30 and scored on the DELIVERED SET through
 `eval/cost-curve.mjs`. Read at matched token spend the two are inseparable and the sign alternates:
 ~29.5k/30.3k tokens F2 0.5250 vs 0.5221; ~23.9k 0.5240 vs 0.5279; ~20.9k 0.5192 vs 0.5203; ~18.7k
 0.5010 vs 0.5035; ~16.5k 0.4631 vs 0.4687; ~15.0k 0.4443 vs 0.4408 — every gap under 0.006 against a
 0.09 swing along either curve. Each fit's own best differs (scene 0.5355 at cutoff 0.10 delivering
 13.3; book 0.5096 at 0.12 delivering 11.4) on `relevance-regress`'s held-out ROWS, which is not the
 delivered set: the gap does not survive scoring the set the system actually chooses. NOT PAIRED — a
 macro-mean per cell, no sign test; the claim is that no gap is visible, not that one is excluded.
 — `docs/matching.md`.

- **F55** — Pooled standardisation sits above per-scene on the WHOLE-SYSTEM cost curve, at matched
 token spend, at every point read. Both tiers, delivered set, `eval/cost-curve.mjs`, 105 bundles, both
 artefacts refit on the same corpus. Cutoff 0.04-0.30, scene -> pooled F2: 0.5055->0.5071,
 0.5242->0.5315, 0.5335->0.5412, 0.5366->0.5377, 0.5388->0.5425, 0.5310->0.5378, 0.5185->0.5261,
 0.4958->0.5111, 0.4701->0.4829, 0.4552->0.4749 — ten of ten positive, +0.0011 to +0.0197, sign never
 alternating, tokens matched within 2% at every row against a ~0.08 swing along either curve. Contrast
 F53, where per-book alternated sign under the same instrument. NOT PAIRED — a macro-mean per cell, as
 F53 was; the claim is that no crossing is visible, not that the gap is established. At the SERVED
 cutoff (0.10, the `relevanceCutoff` default) the delta is +0.0011, so the shipped configuration is not
 measurably improved. — `docs/matching.md`.

- **F56** — The gain is the REFERENCE tier's; memory is flat with a negative lean. Reference held-out
 AUC rises for all seven models: 0.7314->0.7553, 0.7315->0.7550, 0.7019->0.7307, 0.7767->0.7884,
 0.7149->0.7429, 0.7370->0.7602, 0.7471->0.7758 (+0.012 to +0.029); that tier is never cut, so AUC is
 its whole measure and no cutoff artefact applies. Memory, PAIRED per scene at the served 0.10 over 94
 scenes, macro F2 up in 6 of 7 models while MORE SCENES GET WORSE in 5 of 7 — bge-m3 23/34, qwen3-8b
 19/29, jina 19/35 (p 0.040), gemma 25/29, mxbai 22/29, qwen3-0.6b 31/23, qwen3-4b 33/16 (p 0.021);
 pooled over all seven views of the same rows, +172/-195/=291. Delivered counts move under 0.4 entries,
 so it is not a spend artefact. The two nominally significant cells point OPPOSITE ways across seven
 uncorrected tests. Memory held-out AUC nonetheless rises in 7 of 7 (+0.0019 to +0.0063). Seven models
 are seven views of ONE corpus, not seven draws. — `docs/matching.md`.

- **F58** — The English lists in the scoring path are measured flat. (a) `COMMON_WORDS` subtracted
 inside `properNames`, the shipped properNouns extractor: `--sweep properNounsExtract=entity,bare`
 (`bare` = `properNounsOf`, no list), own fit per arm, 105 scenes. Memory (6051 rows) held-out AUC
 0.8437→0.8418, AP 0.370→0.371; paired F2 at 0.10 −0.006 (15/22/57, p 0.32), at 0.20 +0.001
 (16/19/59, p 0.74); per book 2/2 and 2/1. Reference (653 rows) held-out AUC 0.7550→0.7519, AP
 0.592→0.585; F2 at 0.10 +0.004 (10/3/53, p 0.09), at 0.20 −0.004 (6/4/56, p 0.75). Opposite signs
 by tier and by cutoff. (b) `stopwordDocFreq`, the BM25 query-term df threshold, is not an English
 list; `param-screen --arms stopwordDf=0,stopwordDf=0.15,stopwordDf=0.4`, shipped fit, fAtCut, 105
 scenes: off +0.0024 (17/12/76, p 0.46), 0.15 −0.0048 (28/14/63, p 0.044, Holm 0.13), 0.4 +0.0009
 (14/10/81); no arm consistent per lineage. So neither list is load-bearing at the cut, and the
 suggester/audit (`ZIPF_EN`, `english common`) are the only places English is assumed.
 — `docs/matching.md`, *Evidence*.

## K — Keys and matching

- **K1** — Quoting worked example (default paragraph window): `? (your | my) husband` scores 2/2/2
 across the three probe texts where `? ("your husband" | "my husband")` scores 1/0/0 — the loose form
 outranks a genuine phrase match. — `docs/matching.md The pipeline`.

- **K2** — Regex keys off the automaton: 100 regex keys × 300 entries × ~1KB = 9.8ms with no matches,
 18.4ms at 630,000 hits; a compile cache would recover ~5ms (not worth the code).
 — `docs/matching.md Selective logic (keysecondary)`.

- **K3** — Entry flags reach plain keys only (the `?`/`/re/` branches return before flag args are
 read) — measured against `countKey`; the 16,000-comparison fuzz it replaced never caught it because
 it only ran flags-off. — `docs/matching.md Matching — countKey (matcher.mjs)`; `test/core-matcher-check.mjs`.

- **K4** — The fold×strict em-dash interaction broke four of the seven dash spacings prose uses.
 — `docs/matching.md Stage 1 — Retrieval`.

- **K5** — Window segmentation is safe and cheap: 8 segments vs one join measured 1.01x (200 patterns,
 18KB, n=2000); literal keys are slice-invariant — 8 books, 8970 distinct keys (6353 multi-word),
 0 change df, 0 change occurrence totals. — `docs/matching.md Stage 3 — Scoring (onScanDone)`; `extension/keyword-audit.mjs buildKeyPruneScan`;
 `test/matchwindow-check.mjs`.

- **K6** — Unclosed preset tags are real: five `<internal_states>` opens across ten messages, no
 close, on the motivating chat. — `docs/matching.md Stage 3 — Scoring (onScanDone)`; `extension/matcher.mjs textSegments`.

- **K7** — PARAGRAPH_BREAK is blank-line, not single-newline: 27.6% of messages carry blank-line
 breaks AND single newlines within a paragraph; only 3.8% use single newlines alone (one author's
 chats, 392 messages, 780KB). — `extension/matcher.mjs segment`.

- **K9** — The fold is the matcher's: the old `[^a-z0-9']` split made "Möbius" index as "bius" — 87
 word types / 319 occurrences across four books (André ×51); the real fold costs 33x a bare
 toLowerCase on 15KB (hence memoisation). — `extension/lexical.mjs buildLexical`;
 `test/content-lexical-check.mjs`; `extension/matcher.mjs keyExcerpts`.

- **K10** — Orthography censuses: apostrophe-form keys mismatched in BOTH directions (2 of 3 in one
 book, 2 of 84 in another); over 512MB of chat — em-dash 729,692, curly doubles 93,065, curly singles
 87,665, ellipsis 7,215, en-dash 2,230, nbsp 57; non-NFC keys 0 of 46,140 (0 in chat); zero-width /
 ligatures / U+2212 all 0; fullwidth 14,367 but all punctuation; the NFC guard is free (0.000ms
 guarded vs 0.019ms unconditional on a 15KB window). — `extension/automaton.mjs ORTHO_FAMILIES, normalizeOrthography, keyVariants, buildAutomaton`.

- **K12** — SmartKey/regex censuses over the books on disk: 2 regex keys in 46,226; 0 keys contain
 `^`+digit (0 in 367KB of scan text); 148 SmartKeys across 43 books, exactly 1 with a per-term weight
 (single-term, so the group-weight change is free); removing the sticky audit exemption hides 2
 SmartKeys + 23 book-common flags; the case-sensitive-capital exemption covers 2 of the 7 flagged
 SmartKeys (both one character name); 84 entries across 43 books carry secondary keys.
 — `extension/smartkeys.mjs tokenize, validateSmartKey`; `docs/matching.md Divergences from ST core`;
 `test/smartkeys-check.mjs`; `st/studio.mjs lorebookStudio`.

- **K13** — Priming secondaries up front: 2ms vs 102ms over 200 entries × 20 segments.
 — `worldsapart.js`.

- **K14** — Audit flag evidence: unfolded "isn't" scored maximally rare and fired in 770 of 16,360
 messages; KEY_DUPE sits in an empty band (dupes 0.52–1.00, highest non-dupe 0.294, 7 books;
 near-misses are consecutive STMB parts at 0.200; calibrating instance 0.584 vs 0.289 in-book
 ceiling; raw overlap reads ~0.6 on unrelated same-book pairs — hence rare-vocabulary Jaccard);
 fragment gap: 3 uncurated entries, 22 keys, 0 hits over 5473 messages, all unflagged;
 KEY_CHAT_COMMON's 20% is a bound not a fit (no key one curated book's curation kept fired above 11%; of 20
 keys over 20% across seven books, 8 sit on vectorized entries, rest mostly cast on sticky sheets);
 `eng`-flag precision against chat: 1 of 38 flagged keys actually fires broadly; dropping the whole
 yellow band: +0.036 nDCG on one graded book, 0.000/−0.0006 on two others; dead-flag by provenance:
 on STMB entries 12/39/40% of keys ever appear in chat (three full histories) vs ~90% deliberate
 aliases on a hand-written public book (real finds: two typos, two apostrophe breaks); near-dupe
 discovery: one hand-disabled pair in a 334-entry book; the O(n²) pass is 55k intersections on the
 largest book. — `extension/keyword-audit.mjs KEY_DUPE_MIN, looksLikeFragment, buildKeyPruneScan`;
 `st/studio.mjs lorebookStudio`.

## S — Keyword suggester and curation evidence

- **S1** — The count instruction is the largest lever found: raising it moved agreement with the
 books' own keys 0.152→0.337 (gemma3:4b) and 0.286→0.396 (gemma4:e4b). Temperature has no
 per-response quality effect; the one positive: the union across repeats reaches more keys at T=1
 than T=0. Responses sit at 8–10, at the instruction, nowhere near the token budget.
 — `eval/count-sweep.mjs`; `eval/count-vs-temp.mjs`.

- **S2** — The shipped count wording won on worst-case F over 5 wordings × 6 model configurations: 5
 wins of 6, best mean rank, best floor (the sixth a tie inside a measured noise floor; the old
 wording ranked fourth of five, never won a cell); re-scored across betas from the same 596 cached
 hosted responses it wins the mean at F1/F1.5/F2/F4 and the worst cell at every beta except F1, where
 the lowest-yield wording edges it by 0.006 inside the noise floor. — `extension/keyword-suggest.mjs parseKeyList`.

- **S3** — Name capitalisation ratio separates cleanly: real names 99.5–100% vs junk 1.6–16.4%, "lord"
 the nearest miss at 91% (two books); the old boolean broke on "Marches" (397 capitalised, 2
 lowercase); distributional function-word test: "marches" df 48.6% / 3.0 repeats was blocking every
 n-gram, "aldric" escaped at 6.42 repeats. — `extension/keyword-suggest.mjs buildKeySuggest`.

- **S4** — Particles occurring over 38 books: only de/la/los/el/van/del/du/da/der/le.
 — `extension/keyword-suggest.mjs buildKeySuggest`.

- **S6** — Cohesion: splitting a trigram down the middle muddied the bands to 0/50/55/68% where the
 bigram pair reads 8/65/100/100%; the legal-part rule matters — 13/84 and 31/102 of dropped grams on
 two books were being counted against an illegal part. — `extension/keyword-suggest.mjs buildKeySuggest`.

- **S7** — Subsumption is match-aware because specificity dies unattested: a half of an INCOHESIVE
 tetragram out-fires the whole 96% of the time, 13% when cohesive (one book and its 5598-message
 chat); a unit never swallows a bare word, and ~a third of swallowed unigrams sat in that band.
 — `extension/keyword-suggest.mjs buildKeySuggest`; `test/keyword-extract-check.mjs`.

- **S9** — The cap: uncapped over 39 books / 3405 entries an entry yields median 17 / mean 27
 candidates, near-linear ~7 per 1000 chars; cap 8 discarded ~70% of gate survivors (not junk — on a
 269-candidate entry the next hundred still held proper nouns); 30 sits above the p75 of 29. The
 demoted-rejects fallback fired on 1% of 38 books / 3466 entries and offered junk; admitting f=1
 names covers 98.8% of entries. — `extension/keyword-suggest.mjs buildKeySuggest`.

- **S10** — dfSubstr term-by-term was 97% of build runtime on a 327-entry book (hence the
 Aho-Corasick warm-up). — `extension/keyword-suggest.mjs buildKeySuggest`.

- **S15** — Embedding drift detection ruled out: seed-variant cosine reads surface overlap ~1.71x as
 strongly as meaning (standardised coefficient, 45 term pairs, bge-m3; synonyms with no surface
 overlap average 0.61, orthographic neighbours with no shared meaning 0.68 — no separating
 threshold). — `docs/keyword-suggestions.md`.

- **S19** — Genre shapes over one user's 35 books: acronyms in 30, bracket tags 26, apostrophe names
 20, accented text 18, nobiliary particles 15, hyphenated species compounds 12, shouted markdown
 headers 9, elisions 8, roman numerals 8, LitRPG stat blocks 7 — nearly every suggester bug came
 from one of these. — `test/genre-cases.mjs`.

- **S21** — [zero-result census] `matchPersonaDescription` and siblings: nothing on disk sets one.
 — `docs/keyword-suggestions.md`.

- **S24** — Fiction register vs wordfreq for the Zipf table, gold pairs + hand-written public books. Shift:
 genre and narrative vocabulary rises 0.3–0.7 (sword 4.4→4.8, cloak 3.6→4.3, mage 3.1→3.7, shoulder
 4.5→5.2, thrall/necromancer absent→3.0+), web/tech/business falls (spreadsheet, inbox, firewall pass
 the gate). Gate kills 98% shared (161/407/2155 wordfreq vs 158/395/2078 fiction); fiction's own
 kills — teak, collarbone, unhurried, divan, minotaur — hold 0 curated keys, wordfreq's own 126
 hold 9. Curated single-word keys the unigram gate kills over 7 books / 1041 keys: wordfreq
 473, fiction 436, a 0.5-mean blend 452; each register kills the other's vocabulary (fiction-only 23:
 necromancer, minotaur, inquisitor, elven, first names; wordfreq-only 60: bucharest, firewall, heist,
 implants). Decided on principle, not on these: the prior judges "ordinary" against fiction prose, and
 a suggester over-filtering costs one typed key. Genre case "thrall" reclassified as a rejection.
 POS sets from the same corpus at >= 1000 tagged occurrences on wordfreq-known words: VA95 10326 /
 VA85 4723 / ADJ85 6856 vs SUBTLEX 13317 / 1611 / 9056, 67% / 9% / 67% of the fiction sets inside
 SUBTLEX's; on the gold pairs the swap moves 0 / 11 / 72 offered terms out and 19 / 25 / 235 in, one
 curated key each way. Shipped: fiction table + fiction POS, SUBTLEX out — gate kills
 158 / 403 / 2146, chat common still 1.9% / 4.0% / 1.1%. n = 3 pairs, 7 books, one user.
 — `docs/keyword-suggestions.md`; `build-zipf.py`.

## G — Grading, judges, bundles

- **G1** — Bundle-corpus census (migrated, 2026-08): 598 human verdicts, 16,962 judge verdicts, 12,519
 rows across 107 bundles; the reader's resolution rule reproduces all 11,946 stored v2 `llmGrade`
 scalars; 611 bare grades in `/wa-grade` documents are human while 37 in synth documents were llm
 verdicts in the wrong field; every one of the 107 frozen haystacks re-derives from its source chat. — `CLAUDE.md Pure vs ST-coupled`; `eval/bundle-schema.md A rater is whoever passed a verdict`;
 `extension/grading.mjs searchedBook`; `docs/matching.md`.

- **G2** — Human vs contract at matched rank (n=258 rows graded by both, joined on shipped-arm rank):
 contract mean 0.68x the human's at rank 0–19 and 1.03x at 20–44; every contract 4 fell on a human 4
 (n=5); 19 of its 62 3s sit on human 0–2; QWK 0.690; Kendall tau-b 0.54 per scene. The human grades
 predate the current rubric — agreement statistics against a superseded construct. Unmatched-rank
 comparison of the same passes read 0.26 vs 0.83 and was almost all row draw.
 — `CLAUDE.md Pure vs ST-coupled`.

- **G3** — Contract self-agreement (re-grade at original job size: 179 rows / 12 jobs / 4 books):
 87.7% exact, 98.3% within one; 79% at the head of the pool vs 90–93% deeper; 4 of the 13 rows
 originally ≥3 came back below. The labels are the ceiling: ~a third of boundary positives change
 side between passes of the same judge. — `CLAUDE.md Pure vs ST-coupled`; `docs/matching.md`;
 `eval/judge-agree.mjs`; `extension/grading.mjs searchedBook`.

- **G4** — Job size does not move grades: the same 64 rows at 4 vs 16 rows/job scored +0.11, 10 up / 5
 down, sign test p~0.3 — though two of the 64 were real 0-to-3 catches, so prefer small batches
 anyway. — `CLAUDE.md Pure vs ST-coupled`.

- **G5** — Anchored wording is the lever: restating the question — same rater, same entries — moved
 weighted kappa against the human rater 0.242→0.455 (a one-scene version: "nearly doubled").
 — `.claude/agents/scene-relevance.md The question` (byte-identical in the sr-* family and all 16
 `eval/contracts/*.md`); `extension/grading.mjs armNames`.

- **G6** — Judge calibration facts carried in the rubric: ~half of all graded rows are 0, under a
 tenth are 4; the last pass ran lenient (mean 1.78 vs the human's 0.93; 142 of the human's 180 grades
 on 0–1) with rank order agreeing far better than the zero point; one measured prefix-read miss
 (graded 1 vs human 4, relevant passage past the first 1000 chars); the 4-demotion read as a general
 discount cost more than it bought (two human-4 siblings split 2 and 3). — `.claude/agents/scene-relevance.md Calibration § What you are shown, and how to read it § The scale`.

- **G7** — A later pass is not a better pass: re-grading the same rows with the same model under a
 corrected rubric moved ~30% of the relevant set out — the same magnitude as the contract's own
 non-reproduction — which is why the median of 3+ verdicts wins over latest-wins, and why that rule
 reproducing all 11,946 stored scalars made the resolution move lossless.
 — `eval/bundle-schema.md A rater is whoever passed a verdict`; `extension/grading.mjs mergeGrades, searchedBook`.

- **G8** — Schema decisions, each on a measured sweep: 44 book filenames already contain spaces,
 commas, apostrophes, parens, `#`, `@` (no printable separator); 0 of 106 multi-arm documents vary
 any budget field; all 107 documents structurally clean — 491 arms carry no version pair, 436 cells
 no book, 37 documents no gradeScale; `paramSnapshot` genuinely varies between arms in 9 documents;
 97 of 107 documents held an absolute path across two usernames; 33 rater rows are
 `scene-relevance@fable-inline-1` (2026-07-31, pre-rubric-file); local models span 6 HF orgs and 7 of
 10 resolve; 11 of 11 Ollama models carry `:`; spelled-out rater identity was 645KB across 3 models /
 4 rubrics; `why` is 18% of a 2MB document vs 0.6% for all verdicts; 21,077 entries carry
 `entry.world`, 0 disagree with their book; the ST version fields exist because a staging tree ran
 167 commits past the 1.17.0 its package.json's 1.18.0 implied. — `eval/bundle-schema.md A scene's id is composed, not opaque § scores is a capture record, not a schema § A row's block § Every stored path is relative to the ST install § WA's version is declared, ST's is resolved § Verdict elements`; `extension/grading.mjs captureParams, buildSample, passKey, bundleSamples`.

- **G12** — Token accounting: `recorded − cl100k(content)` = 6 on every one of 259 captured rows (min
 6, median 6, max 6); corpus chars-per-token 4.91 (median over 1297 rows, p5 4.46 / p95 5.33 — a
 flat /4 would be 23% out). — `eval/lib/tokens.mjs TOKENIZER_OFFSET`; `eval/lib/scene.mjs`.

- **G13** — Capture conventions verified against the corpus: all 97 pre-existing bundles record depth
 10 (two sets derived at 5 were thrown away and re-derived); 52 of 107 bundles record the budget only
 as the display string `"40%* = 29036"`; message ids are raw record indices (msg5347 = raw 5347,
 usable 5340, 7 hidden). — `eval/synth-scenes.mjs`; `eval/lib/scene.mjs makeCandidateSet`.

- **G14** — Head-read resolution: reading `captureId` from the head is 8ms vs 263ms parsing every
 document whole, same 107 ids. — `eval/synthetic-data/apply-review.mjs resolveSections`.

## C — Corpus facts

- **C7** — Disabled entries are not a weak-entry population: they are EARLIER (mean story position
 0.33 vs 0.60) and shorter; control both and vocabulary rarity, proper-noun density, embedding
 coherence and centroid distance all go to chance. — `eval/eval-data/README.md Standard chat corpus for chat-based measurement` (gitignored);
 `eval/relevance-regress.mjs`.

## P — Performance and mechanics

- **P1** — Chat metadata routes: ST's `/api/characters/chats` reads every line of every chat — 1.28GB
 and 3.2s over 194 chats — vs 0.06s reading the line-0 bindings (53x); a globally-active book means
 190 chats / 1.2GB / 12–17MB files, which is why global bindings are never pre-ticked.
 — `plugin/server.js init`; `st/studio.mjs lorebookStudio`.

- **P2** — Suggester chat evidence: one Aho-Corasick pass is 254ms for 497 keys over 5473 messages
 (O(chat), key-count independent); pooling other chats runs 0.28s/MB (22MB ≈ 7s vs 2.5s) and looks
 like a free win — on one book the share of candidates that never occur anywhere fell 51% → 25% — but
 both measured cases are real: a heavily-versioned book's pool collapsed to the open chat (5646 vs 5598
 messages, 0.1pp gain) while a cleanly-bound one picked up a sibling branch (20,045 vs 16,359;
 never-occurring candidates 32.0%→28.2%; 5.8s vs 2.6s). — `st/studio.mjs lorebookStudio`.

- **P3** — Chunking oracle: 992/992 chunks identical on the first book; currently clean across three
 collections (983 + 640 + 1049 chunks); the wrong comparison granularity (per-entry positional vs
 hash-keyed store) read a perfectly-synced 1050-chunk collection as 70% stale; one eval sample really
 is ~30% out of sync with its re-summarized book. — `extension/chunking.mjs splitRecursive`;
 `test/chunking-check.mjs`; `eval/lib/reindex.mjs cachePath`.

- **P6** — Composite-key separator: US, never NUL (NUL made the files binary to git/grep/awk) and
 never printable (G8's model-name survey). Bundle rater keys and studio rowIds all use it.
 — `CLAUDE.md` (*Composite keys*); `extension/grading.mjs passKey`.

## H — Harness and process

- **H6** — `think: false` is required on gemma4:e4b: at 400 tokens it spent the whole budget reasoning
 and returned empty on all 24 prompts — a silent zero; disabled it is also 7x faster (2.1s / 25
 tokens vs 15.4s / 601). — `eval/temp-ladder.mjs`.

