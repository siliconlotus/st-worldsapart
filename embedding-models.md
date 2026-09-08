# Choosing an embedding model

WA has no embedding model setting of its own. It reads Vector Storage's — source, model and endpoint —
and embeds through ST's vectorization interface; what is WA's own is the storage, one collection per
book. Change the model in Vector Storage's UI; doing so invalidates both sets of collections, WA's
per-book ones and Vector Storage's own. Point it at a connection profile for an embedding model: a
profile for a chat model is not a valid vectorization source.

## The plugin decides whether the model matters

WA's server plugin is what returns a cosine similarity score. On the no-plugin path ST's own endpoint
returns hashes and metadata only, so WA scores with a fit over `text`, `properNouns` and `density`,
every model behaves identically, and that fit holds up on its own (E1). With the plugin the model's
cosine reaches the ranker. The Qwen family is clearly ahead of the no-plugin fit; bge-m3 and jina each
lose to it on most book folds, with the margin coming mostly from one book plus the smallest fold (E3).

## What to use

| | when |
|---|---|
| **Qwen3-Embedding-8B** | Best on every book fold (E2). Needs an engine that can serve it fast — see *Speed*. |
| **qwen3-embedding:4b** | Most of 8B's lead at 2560 dimensions instead of 4096. The pick if 8B does not fit. |
| **qwen3-embedding:0.6b** | Closest of the small models, at a fraction of the parameters. |
| **embeddinggemma** | Not separable from 0.6b here, and the smallest index at 768 dimensions. |
| **mxbai-embed-large** | Beaten by everything newer, and its 512-token context truncates a scan window — see *Context length*. |
| **bge-m3** | Fine, and beaten by everything newer. |
| **jina-embeddings-v2-base-en** | **ST's stock default, and last here (E2).** Runs on the CPU and adds seconds to every retrieving turn (E10) — see *Speed*. Switch off it. |

Set the model's task instruction? No — WA does it, from `relevance.mjs` `PREFIXES`, on the query only,
so turning one on never costs a re-index. On Qwen3-Embedding-8B the instruction is worth a real gain on
most books; EmbeddingGemma's documented prefix pair is flat, so it gets neither (E7).

## Two knobs, and they are independent

The cutoff is a token budget; the model is how much recall that budget buys. `E[credit]` is calibrated
— every model is fitted to the same target on the same rows — so at a given cutoff every model delivers
essentially the same count (E4): the model moves which entries clear the bar, not how many. The cutoff
is the **Relevance cutoff** setting, one value for every model, defaulting to 0.10, and every model
ships a fit of its own beside it.

The sweep on the shipped model is in the register (E5): lowering the cutoff buys recall at the cost of
precision, every delivered memory entry costs on the order of a couple thousand tokens, and precision
never reaches much above half at any cutoff for any model. Memory tier only — reference entries and
constants sit on top of every figure. The usable range is 0.05 to about 0.35; past there the dial loses
both. The default sits at the recall-favouring end deliberately, F2 weighting recall; a user who wants
the other end says so with this knob.

## The measurement

`relevance-regress.mjs --tier memory --lobo --cutoff` with the shipped feature set, on a
lineage-disjoint book set, each model with its own fit; the corpus state and the full tables are in the
register (E2). Compared at a matched budget, because at F2's own optimum jina delivers about twice as
many entries as Qwen3-8B and still scores lower (E6). Qwen3-8B wins every book fold, the one ordering
worth acting on; embeddinggemma and qwen3-embedding:0.6b are not separable; jina-embeddings-v2-base-en,
ST's stock default, is last on held-out AUC and on recall at matched budget (E2). Panopticon is the
smallest fold, and every model does worst there.

## Context length: check it against your scan window

WA embeds the scan window, not a search phrase, and a typical window runs to several times a 512-token
context (E8). A model whose context is shorter truncates silently: it answers with a vector describing
only the beginning of the window. `mxbai-embed-large` has a 512-token context, and two queries sharing
a long prefix and then differing completely returned the identical vector where bge-m3 separated them
(E8). Do not infer this from the advertised number — embeddinggemma is listed at 2048 and did not
truncate at that length in the same probe (E8). Check the model you plan to use, especially if you have
raised the scan depth.

## Quantization: 4-bit DWQ costs nothing measurable

On Qwen3-Embedding-8B, 4-bit DWQ against 8-bit mxfp8, every difference sits inside the standard errors
(E9). Take the 4-bit build. This is about DWQ — distillation-optimized 4-bit — not 4-bit quantization of
any kind.

## Speed

These figures are Apple Silicon and say nothing about Nvidia hardware; on CUDA, llama.cpp is not the
outlier it is here. Per-chunk cost, fastest to slowest: MLX (oMLX) serving 8B; llama.cpp (ollama)
serving 4b; ST's default, jina under transformers.js on one CPU thread; llama.cpp serving 8B, far behind
(E10). ST's default climbs faster than linearly with input length, so a real scan-window query costs
several seconds on every turn that retrieves (E10); at llama.cpp's 8B speed a mid-sized library takes
over an hour to index (E10), so on a Mac the 8B rung means MLX or hosted. Time one `/api/embed` of ~32
chunks before committing to a full re-vectorize.

## Hosted

Better than local if your hardware is limited: indexing a five-book library costs pennies, and steady
use costs pennies per thousand messages (E11). The reasons to decline are privacy — every scan window is
chat content leaving your machine — and a round trip per turn before retrieval starts.

## Before you switch

- Switching model re-vectorizes every book and, being changed in Vector Storage, takes Vector Storage's
  own collections with it. Collections cannot mix vector lengths. Pick once.
- Longer vectors cost disk and query time: one book's index more than doubles from length 1024 to 4096
  (E12), and scoring scales the same way.
- The first sync of a large book can take minutes on a big model. WA raises a toast if it runs long.

## Known gotchas

- **LM Studio cannot serve MLX embedding models** — its MLX engine handles chat only, so `/v1/embeddings`
  reaches GGUF models only. Asked for a model it has not loaded it answers with whichever embedding
  model *is* loaded, at that model's vector length, with no error.
- **oMLX serves MLX only**, not GGUF.
- **Some third-party MLX conversions of Qwen3-Embedding do not load**, rejected for shipping a quantized
  `lm_head` an embedding model has no use for. The `mlx-community` builds are clean.
- **Sharing one server between a chat model and the embedder** can evict the embedder and reload it every
  turn if both do not fit in memory. It looks like retrieval getting slow, not like an error. oMLX can pin
  a model to prevent it.

## Open

- **Batch and concurrency tuning** — oMLX defaults to 8 concurrent requests and 32 texts per pass; WA's
  index build is sequential at 64 per request, so neither currently binds. Unmeasured.
- **Probe for truncation at sync time.** Embed the scan window, embed its first half; cosine 1.0 means
  the model cannot see the window. Catches any short-context model without a table of context lengths,
  which the embeddinggemma probe shows would not work.
- **Detect a stale collection and rebuild that book.** A collection built under a different model
  produces numbers rather than an error, and the setting lives in Vector Storage, so a user can re-point
  WA with nothing in WA's UI having moved. `syncWorld` lists the collection before it writes, so
  detection is free; the re-embed spends money on a hosted endpoint. Open: whether that needs a confirm.
- **A "purge WA vector indices" button.** ST's `/api/vector/purge` takes a collectionId and WA's are
  `wa_<hash of world name>` (`syncWorld`); all books, never Vector Storage's collections; purge, and
  purge-and-rebuild.
- **Should WA own its embedding model setting?** Inheriting Vector Storage's gives parity for free, but
  WA embeds the scan window (E8) while Vector Storage embeds messages and file chunks, so a 512-token
  model is correct for one and broken for the other. Owning it costs two embedding models resident for
  anyone running both extensions — the eviction thrash under *Known gotchas*. A default-inherit with an
  override is the middle path; undecided.
