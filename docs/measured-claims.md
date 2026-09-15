# Measured claims

Findings the docs and code cite by ID. Each is reproducible without WorldsApart's author's lorebooks:
a synthetic benchmark, a fact about a model or about SillyTavern, or a result that depends only on
sizes rather than on which book. Claims that rest on particular books or chats are not here and are not
published; the docs cite those by ID too, and the ID is all a reader gets.

**Identifiers are append-only and shared with the private register.** An ID is never reused, and a claim
moves between the two files without changing its number, so `grep <ID>` always finds one entry.

**Nothing here names a book, a chat, an entry, a character or a line**, whether the author's or a
contributor's. A finding drawn from contributed bundles is quoted in aggregate — "over 250 bundles" —
and which bundles is not recorded.

**What counts.** A claim backed by a named measurement. Excluded: configuration values and thresholds
unless the threshold was derived from a measurement, spec facts stated without one, and pure arithmetic.

## Keys and matching

- **K1** — Quoting worked example (default paragraph window): `? (your | my) husband` scores 2/2/2
  across the three probe texts where `? ("your husband" | "my husband")` scores 1/0/0 — the loose form
  outranks a genuine phrase match. — `docs/matching.md:42,:54`.

- **K2** — Regex keys off the automaton: 100 regex keys × 300 entries × ~1KB = 9.8ms with no matches,
  18.4ms at 630,000 hits; a compile cache would recover ~5ms (not worth the code).
  — `docs/matching.md:145`.

- **K3** — Entry flags reach plain keys only (the `?`/`/re/` branches return before flag args are
  read) — measured against `countKey`; the 16,000-comparison fuzz it replaced never caught it because
  it only ran flags-off. — `docs/matching.md:156`; `test/core-matcher-check.mjs:134`.

- **K4** — The fold×strict em-dash interaction broke four of the seven dash spacings prose uses.
  — `docs/matching.md:236`.

- **K5** — Window segmentation is safe and cheap: 8 segments vs one join measured 1.01x (200 patterns,
  18KB, n=2000); literal keys are slice-invariant — 8 books, 8970 distinct keys (6353 multi-word),
  0 change df, 0 change occurrence totals. — `docs/matching.md:282`; `extension/keyword-audit.mjs:298`;
  `test/matchwindow-check.mjs:78`.

- **K8** — The saturation curve stops ordering: `count/(count+k1)` moves 0.041 across n=21..89 (4.2x
  the evidence; a bounded presence form moves 0.043) vs presence-log's 1.44; the pair reads
  0.946/0.987 bounded vs 3.872/5.309 unbounded.
  Foxbridge tops out at n=10 (curves barely differ); across 14 sommers scenes NO key fires in all of
  them at n≥5, and Arthur is absent from nine scenes and dominant in one — the compressed range was
  the book's sharpest signal. Weight inside the curve: `::2` lands at 1.61x (was 1.38x pre-units).
  — `docs/matching.md:670,:685`; `extension/state.mjs:265,:270`; `test/matcher-check.mjs:142,:263`.

- **K9** — The fold is the matcher's: the old `[^a-z0-9']` split made "Möbius" index as "bius" — 87
  word types / 319 occurrences across four books (André ×51); the real fold costs 33x a bare
  toLowerCase on 15KB (hence memoisation). — `extension/lexical.mjs:22`;
  `test/content-lexical-check.mjs:53`; `extension/matcher.mjs:600`.

- **K13** — Priming secondaries up front: 2ms vs 102ms over 200 entries × 20 segments.
  — `worldsapart.js:1085`.

- **K17** — [VERIFIED, not statistical] Core's scan behaviour read from `world-info.js`: both
  delay-level gates run before `getExternallyActivated`, and `externalActivations` is a static map
  read non-destructively per pass — the blind emit is refused on the initial pass and stands for the
  whole scan. — `docs/matching.md:441`.

## Embedding models

- **E8** — mxbai truncates at its 512-token context: two queries sharing a 2600-char prefix returned
  the identical vector (cosine 1.00000) vs bge-m3's 0.848 on the same pair; ~70% of a typical scan
  window (measured 6595 chars ≈ 1650 tokens) never reaches it; embeddinggemma did NOT truncate at its
  advertised 2048 in the same probe. — `embedding-models.md:134,:138,:147`.

- **E10** — Speed (M-series Mac, per 800-char chunk): MLX 8B 110ms; ollama 4b 277ms; llama.cpp 8B
  910ms (≈80 min for a mid-size library); transformers.js jina 553ms on one CPU thread, super-linear
  in length: 553ms @800 chars, 1.18s @1750, 5.49s @6595 — what a real query costs on ST's default.
  — `embedding-models.md:167,:180,:185`; `worldsapart.js:387`.

- **E11** — Hosted cost at $0.05/1M: ~$0.03 to index a five-book library; ~8¢ per thousand messages.
  — `embedding-models.md:193`.

- **E12** — Storage: one book 38MB at dim 1024, 94MB at 4096. — `embedding-models.md:203`.

## Performance and mechanics

- **P1** — Chat metadata routes: ST's `/api/characters/chats` reads every line of every chat — 1.28GB
  and 3.2s over 194 chats — vs 0.06s reading the line-0 bindings (53x); a globally-active book means
  190 chats / 1.2GB / 12–17MB files, which is why global bindings are never pre-ticked.
  — `plugin/server.js:344,:284`; `extension/studio.mjs:169,:2137,:2218,:2308`.

- **P2** — Suggester chat evidence: one Aho-Corasick pass is 254ms for 497 keys over 5473 messages
  (O(chat), key-count independent); pooling other chats runs 0.28s/MB (22MB ≈ 7s vs 2.5s) and looks
  like a free win — on one book the share of candidates that never occur anywhere fell 51% → 25% — but
  both measured cases are real: a heavily-versioned book's pool collapsed to the open chat (5646 vs 5598
  messages, 0.1pp gain) while a cleanly-bound one picked up a sibling branch (20,045 vs 16,359;
  never-occurring candidates 32.0%→28.2%; 5.8s vs 2.6s). — `extension/studio.mjs:137,:636,:644`.

- **P3** — Chunking oracle: 992/992 chunks identical on the first book; currently clean across three
  collections (983 + 640 + 1049 chunks); the wrong comparison granularity (per-entry positional vs
  hash-keyed store) read a perfectly-synced 1050-chunk collection as 70% stale; one eval sample really
  is ~30% out of sync with its re-summarized book. — `extension/chunking.mjs:20,:29`;
  `test/chunking-check.mjs:7,:11,:93`; `eval/lib/reindex.mjs:63`.

- **P6** — Composite-key separator: US, never NUL (NUL made the files binary to git/grep/awk) and
  never printable (G8's model-name survey). Bundle rater keys and studio rowIds all use it.
  — `CLAUDE.md` (*Composite keys*); `extension/grading.mjs:630`.

- **G14** — Head-read resolution: reading `captureId` from the head is 8ms vs 263ms parsing every
  document whole, same 107 ids. — `eval/synthetic-data/apply-review.mjs:42`.

- **H6** — `think: false` is required on gemma4:e4b: at 400 tokens it spent the whole budget reasoning
  and returned empty on all 24 prompts — a silent zero; disabled it is also 7x faster (2.1s / 25
  tokens vs 15.4s / 601). — `eval/temp-ladder.mjs:101`.

## Keyword suggester

- **S4** — Particles occurring over 38 books: only de/la/los/el/van/del/du/da/der/le.
  — `extension/keyword-suggest.mjs:299`.

- **S10** — dfSubstr term-by-term was 97% of build runtime on a 327-entry book (hence the
  Aho-Corasick warm-up). — `extension/keyword-suggest.mjs:362,:504`.

- **S24** — Fiction register vs wordfreq for the Zipf table, gold pairs + hand-written public books. Shift:
  genre and narrative vocabulary rises 0.3–0.7 (sword 4.4→4.8, cloak 3.6→4.3, mage 3.1→3.7, shoulder
  4.5→5.2, thrall/necromancer absent→3.0+), web/tech/business falls (spreadsheet, inbox, firewall pass
  the gate). Gate kills 98% shared (161/407/2155 wordfreq vs 158/395/2078 fiction); fiction's own
  kills — teak, collarbone, unhurried, divan, minotaur — hold 0 curated keys, wordfreq's own 126 on
  Sommers hold 9. Curated single-word keys the unigram gate kills over 7 books / 1041 keys: wordfreq
  473, fiction 436, a 0.5-mean blend 452; each register kills the other's vocabulary (fiction-only 23:
  necromancer, minotaur, inquisitor, elven, first names; wordfreq-only 60: bucharest, firewall, heist,
  implants). Decided on principle, not on these: the prior judges "ordinary" against fiction prose, and
  a suggester over-filtering costs one typed key. Genre case "thrall" reclassified as a rejection.
  POS sets from the same corpus at >= 1000 tagged occurrences on wordfreq-known words: VA95 10326 /
  VA85 4723 / ADJ85 6856 vs SUBTLEX 13317 / 1611 / 9056, 67% / 9% / 67% of the fiction sets inside
  SUBTLEX's; on the gold pairs the swap moves 0 / 11 / 72 offered terms out and 19 / 25 / 235 in, one
  curated key each way on Sommers. Shipped: fiction table + fiction POS, SUBTLEX out — gate kills
  158 / 403 / 2146, chat common still 1.9% / 4.0% / 1.1%. n = 3 pairs, 7 books, one user.
  — `docs/keyword-suggestions.md:365`; `build-zipf.py`.

## The relevance model

- **F2** — With no relevance cut, F2@layout is EXACTLY invariant to layout: 5 arms × 4 parameter
  families × 3 scenes, every per-scene delta 0.0000; level F2 ~0.25 (precision 0.064–0.104, recall
  1.000). Rank decides overflow, never membership. — `docs/matching.md:924`.

- **F4** — Offline budget replay is exact against the runtime's verdicts on 315 rows across 7 arms;
  the token budget binds on every graded scene measured. — `docs/matching.md:962,:726`.

- **F52** — Runtime/harness parity: on one browser capture (16 scored rows), `properNouns` reproduces
  from `relevance.mjs` to the capture's own rounding. — `docs/matching.md:1612`.

- **F54** — Per-tier standardisation is DEGENERATE on a small tier, by arithmetic rather than by
  measurement. The sd of two points is half their gap, so a tier of two gives every z exactly +/-1 and
  `E[credit]` can take only 2^4 = 16 values whatever the raw signals are: under qwen3-embedding-8b the
  best is 0.1725 and only 3 of the 16 clear a 0.10 cutoff; two partner rows differing wildly and
  differing barely produce byte-identical output. A tier of ONE has sd 0, takes the `sd || 1` guard, and
  collapses to the intercept — 0.0435/0.0363/0.0458/0.0407/0.0430/0.0406/0.0400 against that fit's own
  cutoff 0.07/0.11/0.07/0.08/0.08/0.10/0.09, so it is cut under every one of the seven shipped models.
  Reproduced through the shipped `scoreRelevance` on a live capture: a 26-row scan (2 memory, 24
  reference) returned 0.04627 for a memory row ranking 1st of 26 on `text` and on `properNouns` and 3rd
  on `cosine`, placing it 24th of 26. Corpus-independent: it is a property of n, not of the fit.
  — `extension/relevance.mjs:284`.

- **G12** — Token accounting: `recorded − cl100k(content)` = 6 on every one of 259 captured rows (min
  6, median 6, max 6); corpus chars-per-token 4.91 (median over 1297 rows, p5 4.46 / p95 5.33 — a
  flat /4 would be 23% out). — `eval/lib/tokens.mjs:9`; `eval/lib/scene.mjs:1425`.
