# Choosing an embedding model

**WA has no embedding model setting of its own.** It reads Vector Storage's — source, model and endpoint
all come from there — and embeds through ST's vectorization interface. What is WA's own is the storage:
one collection per book, separate from Vector Storage's.

So there is no WA default to speak of. Whatever a user has configured in Vector Storage is what WA
retrieves with, including the stock default if they never touched it. Changing it is done in Vector
Storage's UI, and it invalidates both sets of collections — WA's per-book ones and Vector Storage's own.

**Point it at a connection profile for an embedding model.** Profiles are model-specific; a profile for a
chat model is not a valid vectorization source.

## The plugin decides whether the model matters

WA's server plugin is what returns a cosine similarity score at all.

**Without it**, ST's own endpoint sorts by score and returns hashes and metadata only, so stage 1 has no
cosine to pass on. WA scores those turns with a fit over `text`, `properNouns` and `density` — none of
which touches an embedding — so every model behaves identically. **Measured**, memory tier, 99 scenes and
5585 rows: held-out AUC 0.7979.

**With it**, the model's cosine reaches the ranker and the tables below apply. The Qwen family is clearly
ahead of the no-plugin fit — Qwen3-8B wins 4 of the 5 book folds against it. The weaker models are not:
bge-m3 and jina each lose 4 of 5 to it. Read that as "a weak embedder adds little", not as a ranking — the
margin comes mostly from one book (Ascensus, where the no-cosine fit beats every model including
Qwen3-8B) and from Panopticon's 63 rows.

## What to use

| | when |
|---|---|
| **Qwen3-Embedding-8B** | Best on all 5 books. Needs an engine that can serve it fast — see *Speed*. |
| **qwen3-embedding:4b** | Most of 8B's lead at 2560 dimensions instead of 4096. The pick if 8B does not fit. |
| **qwen3-embedding:0.6b** | Closest of the small models, at 1/13 the parameters. |
| **embeddinggemma** | Not separable from 0.6b here, and the smallest index at 768 dimensions. |
| **mxbai-embed-large** | Beaten by everything newer, and its 512-token context truncates a scan window — see *Context length*. |
| **bge-m3** | Fine, and beaten by everything newer. |
| **jina-embeddings-v2-base-en** | **ST's stock default, and last here.** Runs on the CPU and adds ~5.5s to every retrieving turn — see *Speed*. Switch off it. |

**Set the model's task instruction? No — WA does it.** Qwen3-Embedding and mxbai want an instruction on the
query, and WA applies it from `relevance.mjs` PREFIXES. **Measured** on Qwen3-Embedding-8B, same
collections so only the query vector moves: +0.0131 held-out AUC and +0.0235 F2, on 4 of 5 books. Nothing
is prefixed onto documents, so turning one on never costs a re-index. EmbeddingGemma documents a pair of
prefixes and applying the pair against applying neither is flat (0.7976 against 0.7982), so it gets
neither.

## Two knobs, and they are independent

**The cutoff is a token budget. The model is how much recall that budget buys.**

`E[credit]` is calibrated — every model is fitted to the same target on the same rows — so a threshold on
it selects by predicted relevance, and how many entries clear a given value is a property of the CORPUS,
not the embedder. **Measured** over 99 scenes, memory tier, all SEVEN models: at cutoff 0.10 they deliver
between 13.3 and 14.2 entries — a spread of 0.9 against a mean near 13.8 — and the spread stays under 1
entry at every cutoff from 0.10 to 0.30. The model moves WHICH entries clear the bar, not how many.

So the two choices do not interact, and neither has to be made in terms of the other. The cutoff is the
**Relevance cutoff** setting — ONE value for every model, defaulting to 0.10 — and every model ships a
fit of its own beside it. Picking a model is then only a question of how much recall that budget buys.

On the shipped model, Qwen3-Embedding-8B:

| cutoff | delivered | precision | recall |
|---|---|---|---|
| 0.05 | 26.8 | 27.1% | 83.9% |
| 0.10 | 13.3 | 38.1% | 69.5% |
| 0.15 | 9.2 | 43.6% | 59.7% |
| 0.20 | 6.5 | 45.5% | 52.1% |
| 0.30 | 4.1 | 47.9% | 42.0% |

Roughly 1.8k tokens per delivered memory entry, so cutoff 0.10 is about 24k tokens per scene.

Memory tier only: reference entries and constants sit on top of every figure, so this is retrieval's
marginal cost rather than the whole World Info budget.

**The usable range is 0.05 to about 0.35.** Precision peaks and then falls, so past there the dial stops
trading and simply loses both. **Precision never exceeds 50.8% at any cutoff for any of the seven models**
— measured — which is a property of the ranking rather than of the dial, and the number a better model
would have to move.

The shipped defaults sit at the recall-favouring end deliberately. F2 weights recall, and the cutoff is
chosen on F2, so that preference is expressed twice; a user who wants the other end should say so with
this knob rather than expect the default to.

## The measurement

`relevance-regress.mjs --tier memory --lobo --cutoff` with the shipped feature set, over 99 scenes and
5585 judged rows on a lineage-disjoint set of 5 books. Each model gets its OWN fit — applying one model's
coefficients to another's cosines would favour whichever model the fit came from.

**Compared at a matched budget**, because a model allowed to pick its own cutoff answers a different
question. At F2's own optimum jina delivers 30.2 entries against Qwen3-8B's 15.0 and still scores lower.
That is not a better model, it is a looser dial.

| model | dims | recall @ 13.5 entries | precision | held-out AUC |
|---|---|---|---|---|
| Qwen3-Embedding-8B (4-bit DWQ) | 4096 | **69.7%** | 37.9% | **0.8332** |
| qwen3-embedding:4b | 2560 | 68.1% | 37.8% | 0.8188 |
| qwen3-embedding:0.6b | 1024 | 64.9% | 36.5% | 0.8100 |
| embeddinggemma | 768 | 64.7% | 36.4% | 0.7982 |
| mxbai-embed-large | 1024 | 63.5% | 35.8% | 0.7903 |
| bge-m3 | 1024 | 61.9% | 33.5% | 0.7833 |
| jina-embeddings-v2-base-en | 768 | 61.6% | 33.0% | 0.7797 |

Held-out AUC per book, which is what says whether an ordering is real:

| model | Ascensus | Time Whore | Richard | Sommers | Panopticon |
|---|---|---|---|---|---|
| Qwen3-Embedding-8B | 0.7987 | 0.8677 | 0.8119 | 0.8694 | 0.7792 |
| qwen3-embedding:4b | 0.7928 | 0.8585 | 0.8011 | 0.8537 | 0.7333 |
| qwen3-embedding:0.6b | 0.7923 | 0.8513 | 0.7678 | 0.8457 | 0.7194 |
| embeddinggemma | 0.7486 | 0.8561 | 0.7848 | 0.8132 | 0.7347 |
| mxbai-embed-large | 0.7523 | 0.8335 | 0.7772 | 0.8252 | 0.7278 |
| bge-m3 | 0.7341 | 0.8271 | 0.7805 | 0.8097 | 0.7431 |
| jina-embeddings-v2-base-en | 0.7335 | 0.8189 | 0.7686 | 0.8242 | 0.7250 |

**Qwen3-8B wins all 5.** That is the one ordering here worth acting on. The Qwen family takes the top
three places, and `:4b` keeps most of 8B's lead at 2560 dimensions rather than 4096.

**The middle two are not separable.** embeddinggemma and qwen3-embedding:0.6b differ by 0.012 held-out AUC
and trade places by book — 0.6b takes Ascensus and Sommers, gemma takes Richard, Time Whore and
Panopticon. Do not read a ranking between them.

**ST's default is last.** jina-embeddings-v2-base-en is what a stock install embeds with, and it places
seventh of seven on held-out AUC and on recall at matched budget. The gap to Qwen3-8B is 8.1 points of
recall at the same delivered count.

Panopticon is 63 rows, and every model does worse there than on any other book. Regressions still land on
the small books.

## Context length: check it against your scan window

WA embeds the **scan window** — the recent chat — not a search phrase. The one measured here is 6595
characters, about 1650 tokens. A model whose context is shorter than that silently truncates: it answers,
with a vector describing only the beginning of the window.

`mxbai-embed-large`, which older guides recommend, has a 512-token context. Measured: two queries sharing
a 2600-character prefix and then differing completely returned the **identical** vector, cosine 1.00000.
bge-m3 on the same pair returned 0.848. Roughly 70% of a typical scan window never reaches it.

It is not thereby the worst option — measured, it still scores slightly above bge-m3, which sees the whole
window (chart above). Truncation costs it something real and it is still outclassed by everything newer,
so skip it for that reason rather than this one. What the 1.0 does establish is that the failure is
**silent**: a truncating model answers normally and scores plausibly.

Do not infer this from the advertised number alone — embeddinggemma's context is listed at 2048 and it did
*not* truncate at that length in the same test. Check the model you plan to use, especially if you have
raised the scan depth.

## Quantization: 4-bit DWQ costs nothing measurable

Measured on Qwen3-Embedding-8B, same weights and runtime, 4-bit DWQ against 8-bit mxfp8: **-0.002 F2
averaged across books**, 4 books up and 1 down. Cosine's solo AUC is 0.833 against 0.832, and the fitted
model AUC favours the 4-bit build, 0.8312 to 0.8290. Every difference is inside the standard errors.

So take the 4-bit build: 4GB resident instead of 8GB for the same retrieval.

This is about **DWQ** — distillation-optimized 4-bit, where the quantized model is fitted to match the
full model's outputs rather than rounded to the nearest representable value. It is not a general licence
for 4-bit quantization of any kind.

## Speed

**These figures are Apple Silicon and say nothing about Nvidia hardware.** On CUDA, llama.cpp is not the
outlier it is here.

Per 800-character chunk, measured on an M-series Mac. Chunks are 1750 characters now, so a real chunk
costs roughly twice these figures — the ratios between engines are what the table is for:

| engine | ms/chunk |
|---|---|
| MLX (oMLX) — 8B | 110 |
| llama.cpp (ollama) — 4b | 277 |
| llama.cpp — 8B | 910 |
| **transformers.js (CPU) — jina, ST's default** | **553** |

**ST's default embedder runs on the CPU, and the cost lands on every turn.** `transformers.js` runs
quantized ONNX on ONE thread — threaded wasm needs a SharedArrayBuffer that is not available — and cost
climbs faster than linearly with input length. Measured on the same Mac: 553ms at 800 characters, 1.18s at
1750, and **5.49s at 6595 — the scan-window length measured above**, which is what a query actually costs.
Indexing is a one-off; embedding the query is not, so that is roughly five and a half seconds added to
every turn that retrieves.

So on a Mac, the 8B rung means MLX or hosted; ollama at 910ms/chunk is 80 minutes to index a mid-sized
library. On a discrete GPU that constraint does not apply and ollama is fine.

Check your own setup rather than trusting the table: time one `/api/embed` of ~32 chunks before
committing to a full re-vectorize.

## Hosted

A perfectly good option, and better than local if your hardware is limited. Measured against a $0.05/1M
provider: about **$0.03 to index a five-book library** and about **8 cents per thousand messages**.

The reason to decline is privacy, not price — every scan window is chat content leaving your machine.
Latency is the other consideration: a round trip per turn, blocking before retrieval starts.

## Before you switch

- **Switching model re-vectorizes every book**, and it is changed in Vector Storage, so it takes Vector
  Storage's own collections with it. Collections cannot mix vector lengths. Pick once.
- **Longer vectors cost disk and query time.** One book here is 38MB stored at length 1024 and 94MB at
  4096, and scoring scales the same way.
- **The first sync of a large book can take minutes** on a big model. WA raises a toast if it runs long.

## Known gotchas

- **LM Studio cannot serve MLX embedding models** — its MLX engine handles chat only, so `/v1/embeddings`
  reaches GGUF models only. Worse, asked for a model it has not loaded it will answer with whichever
  embedding model *is* loaded, at that model's vector length, with no error.
- **oMLX serves MLX only**, not GGUF.
- **Some third-party MLX conversions of Qwen3-Embedding do not load**, rejected for shipping a quantized
  `lm_head` an embedding model has no use for. The `mlx-community` builds are clean.
- **Sharing one server between a chat model and the embedder** can evict the embedder and reload it every
  turn if both do not fit in memory. It looks like retrieval getting slow, not like an error. oMLX can pin
  a model to prevent it.

## Open

- **Batch and concurrency tuning** — oMLX defaults to 8 concurrent requests and 32 texts per pass; WA's
  index build is sequential at 64 per request, so neither currently binds. Unmeasured.

**Validation — needed whichever way the ownership question below goes.** WA knows what its collections
were built with and can probe the configured model, whether or not it owns the setting.

- **Probe for truncation at sync time.** Embed the scan window, embed its first half; cosine 1.0 means the
  model cannot see the window (see *Context length*). Catches any short-context model without maintaining
  a table of context lengths — which would not work anyway, since embeddinggemma did not truncate at its
  advertised 2048.
- **Detect a stale collection and rebuild that book.** A collection built under a different model cannot
  be scored against the current one — vector lengths cannot mix, and the mismatch produces numbers rather
  than an error. Live today, not a future problem: the setting lives in Vector Storage, so a user can
  change it for Vector Storage's own reasons and silently re-point WA with nothing in WA's UI having
  moved. Per book, on the sync path that already touches it — `syncWorld` lists the collection before it
  writes, so detection costs nothing extra. The stale vectors are unusable, so purging them is safe;
  what is not free is the re-embed that follows, which on a hosted endpoint spends money nobody asked to
  spend. Open: whether that needs a confirm or the existing long-sync toast is enough.
- **A "purge WA vector indices" button.** There is no way to clear WA's collections from its UI today, so
  a model change leaves dead vectors in every book the user has not opened since. ST's
  `/api/vector/purge` takes a collectionId and WA's are `wa_<hash of world name>` (`syncWorld`), so the
  button walks the books and purges each.
  Vector Storage's collections are separate and must not be touched. **All books** — the per-book case is
  handled automatically above, so the button is the deliberate hammer for the whole set. Two actions:
  purge, and purge-and-rebuild.

**Open question: should WA own its embedding model setting?** It currently inherits Vector Storage's,
which gives parity for free. The one argument for owning it that validation cannot answer: WA embeds the
scan window as a query (~1650 tokens measured) while Vector Storage embeds messages and file chunks, so a
512-token model is correct for Vector Storage and structurally broken for WA — one setting cannot serve
both. The cost of owning it is two embedding models resident for anyone running both extensions, which is
the eviction thrash under *Known gotchas*, self-inflicted. A default-inherit with an override is the
middle path; undecided.
