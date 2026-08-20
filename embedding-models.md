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
| **Qwen3-Embedding-8B** | Best measured. Needs an engine that can serve it fast — see *Speed*. |
| **qwen3-embedding:4b** | Delivers the smallest set for its score (21 entries against 32), so it is the pick when the token budget binds harder than recall. |
| **embeddinggemma** | 621MB and the smallest index. Second on quality. The floor of the ladder, not a consolation prize. |

## The measurement

`relevance-regress.mjs --tier memory --lobo --cutoff` over 97 graded scenes, 10342 judged rows. The score
is F2 over the delivered set at each model's own best cutoff, held out by book.

| model | params | vector length | F2 | entries delivered | AUC |
|---|---|---|---|---|---|
| bge-m3 | 568M | 1024 | 0.4894 | 40.5 | 0.770 |
| mxbai-embed-large | 334M | 1024 | 0.5002 | 40.9 | 0.785 |
| qwen3-embedding:0.6b | 596M | 1024 | 0.5194 | 46.1 | 0.799 |
| embeddinggemma | 308M | 768 | 0.5273 | 29.5 | 0.804 |
| qwen3-embedding:4b | 4.0B | 2560 | 0.5386 | 21.2 | 0.811 |
| Qwen3-Embedding-8B (4-bit DWQ) | 8B | 4096 | **0.5457** | 32.3 | **0.826** |

Scenes average 6.5 relevant entries, so "delivered" is how much the model asks for to catch them.

Parameter count is not the axis: embeddinggemma at 308M beats qwen 0.6b at 596M on every column.

**Caveat.** 5 books, one person's chats. The ordering held on all five, but how *much* better varied
sharply — the 8B model's gain on one book was ten times its gain on another, and every regression any
model showed fell on one of the two books under 150 rows.

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

Per 800-character chunk, measured on an M-series Mac:

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
