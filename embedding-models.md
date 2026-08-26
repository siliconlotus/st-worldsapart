# Choosing an embedding model

**WA has no embedding model setting of its own.** It reads Vector Storage's — source, model and endpoint
all come from there — and embeds through ST's vectorization interface. What is WA's own is the storage:
one collection per book, separate from Vector Storage's.

So there is no WA default to speak of. Whatever a user has configured in Vector Storage is what WA
retrieves with, including the stock default if they never touched it. Changing it is done in Vector
Storage's UI, and it invalidates both sets of collections — WA's per-book ones and Vector Storage's own.

**Point it at a connection profile for an embedding model.** Profiles are model-specific; a profile for a
chat model is not a valid vectorization source.

## What to use

| | when |
|---|---|
| **Qwen3-Embedding-8B** | Best at every cutoff, and on 4 of 5 books. Needs an engine that can serve it fast — see *Speed*. |
| **qwen3-embedding:0.6b** | Closest of the small models, at 1/13 the parameters. |
| **embeddinggemma** | Indistinguishable from 0.6b here, and the smallest index at 768 dimensions. |
| **bge-m3** | Lowest at every cutoff. Fine, and beaten by everything newer. |

## Two knobs, and they are independent

**The cutoff is a token budget. The model is how much recall that budget buys.**

`E[credit]` is calibrated — every model is fitted to the same target on the same rows — so a threshold on
it selects by predicted relevance, and how many entries clear a given value is a property of the CORPUS,
not the embedder. **Measured** over 105 scenes, memory tier: at cutoff 0.10 the four models deliver
between 10.4 and 11.0 entries and spend between 18,824 and 19,728 tokens per scene. The model moves WHICH
entries clear the bar, not how many.

So the two choices do not interact, and neither has to be made in terms of the other.

| cutoff | tokens/scene | precision | recall |
|---|---|---|---|
| 0.05 | ~34k | ~27% | ~82% |
| 0.10 | ~19k | ~38% | ~67% |
| 0.15 | ~13k | ~43% | ~58% |
| 0.20 | ~10k | ~45% | ~52% |
| 0.30 | ~6k | ~48% | ~41% |

Memory tier only: reference entries and constants sit on top of every figure, so this is retrieval's
marginal cost rather than the whole World Info budget.

**The usable range is 0.05 to about 0.35.** Precision peaks near 48-53% and then falls, so past there the
dial stops trading and simply loses both — above 0.50 it is strictly dominated. **Precision never exceeds
~53% at any cutoff for any model**, which is a property of the ranking rather than of the dial, and the
number a better model would have to move.

The shipped defaults sit at the recall-favouring end deliberately. F2 weights recall, and the cutoff is
chosen on F2, so that preference is expressed twice; a user who wants the other end should say so with
this knob rather than expect the default to.

## The measurement

`relevance-regress.mjs --tier memory --lobo --cutoff` with the shipped feature set, over 105 scenes on a
lineage-disjoint set of 5 books. Each model gets its OWN fit — applying one model's coefficients to
another's cosines would favour whichever model the fit came from.

**Compared at a matched budget**, because a model allowed to pick its own cutoff answers a different
question. At F2's own optimum bge-m3 scores 80.3% recall — the highest of the four — by delivering 23.8
entries against Qwen3-8B's 13.5. That is not a better model, it is a looser dial.

| model | params | dims | recall @ ~13.5 entries | precision | AUC |
|---|---|---|---|---|---|
| bge-m3 | 568M | 1024 | 63.3% | 36.8% | 0.8037 |
| embeddinggemma | 308M | 768 | 65.4% | 37.4% | 0.8116 |
| qwen3-embedding:0.6b | 596M | 1024 | 67.8% | 38.0% | 0.8210 |
| Qwen3-Embedding-8B (4-bit DWQ) | 8B | 4096 | **69.9%** | 38.9% | **0.8408** |

Held-out AUC per book, which is what says whether an ordering is real:

| model | Ascensus | Time Whore | Richard | Sommers | Panopticon |
|---|---|---|---|---|---|
| bge-m3 | 0.8056 | 0.8263 | 0.7746 | 0.8377 | 0.8014 |
| embeddinggemma | 0.7973 | 0.8474 | 0.7906 | 0.8350 | 0.7528 |
| qwen3-embedding:0.6b | 0.8321 | 0.8442 | 0.7685 | 0.8590 | 0.7472 |
| Qwen3-Embedding-8B | 0.8329 | 0.8592 | 0.8133 | 0.8784 | 0.7875 |

**Qwen3-8B wins 4 of 5, losing only Panopticon.** That is the one ordering here worth acting on.

**The middle two are not separable.** embeddinggemma and qwen3-embedding:0.6b trade places by book, and
swap again on a wider row population — 0.6b leads on the fit's held-out rows, embeddinggemma leads when
every memory row in the scene is ranked. Do not read a ranking between them.

Panopticon is 63 rows, and every model except bge-m3 does worse there than on any other book. Regressions
still land on the small books.

**Not re-measured: `mxbai-embed-large` and `qwen3-embedding:4b`.** Their earlier numbers were taken at
chunkSize 800 and through a query path that never applied a model's task prefix, so they are not
comparable to the table above; their collections were purged with the rest of the legacy set. `:4b` had
been the second pick and may well be again.

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
