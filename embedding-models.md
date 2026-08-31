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
which touches an embedding — so every model behaves identically, and that fit holds up respectably on its
own (E1).

**With it**, the model's cosine reaches the ranker and the verdicts below apply. The Qwen family is
clearly ahead of the no-plugin fit; the weaker models are not — bge-m3 and jina each lose to it on most
book folds (E3). Read that as "a weak embedder adds little", not as a ranking — the margin comes mostly
from one book (Ascensus, where the no-cosine fit beats every model including Qwen3-8B) plus the smallest
fold.

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

**Set the model's task instruction? No — WA does it.** Qwen3-Embedding and mxbai want an instruction on the
query, and WA applies it from `relevance.mjs` PREFIXES. **Measured** on Qwen3-Embedding-8B, same
collections so only the query vector moves: the instruction is worth a real gain on most books (E7).
Nothing is prefixed onto documents, so turning one on never costs a re-index. EmbeddingGemma documents a
pair of prefixes and applying the pair against applying neither is flat (E7), so it gets neither.

## Two knobs, and they are independent

**The cutoff is a token budget. The model is how much recall that budget buys.**

`E[credit]` is calibrated — every model is fitted to the same target on the same rows — so a threshold on
it selects by predicted relevance, and how many entries clear a given value is a property of the CORPUS,
not the embedder. **Measured** across all seven models: at a given cutoff every model delivers essentially
the same count, and the spread stays negligible across the usable range (E4). The model moves WHICH
entries clear the bar, not how many.

So the two choices do not interact, and neither has to be made in terms of the other. The cutoff is the
**Relevance cutoff** setting — ONE value for every model, defaulting to 0.10 — and every model ships a
fit of its own beside it. Picking a model is then only a question of how much recall that budget buys.

On the shipped model, Qwen3-Embedding-8B, the sweep is in the register (E5). The shape: lowering the
cutoff delivers more entries, buying recall at the cost of precision, and every delivered memory entry
costs real context — on the order of a couple thousand tokens (E5) — so the cutoff is best read as a
token budget.

Memory tier only: reference entries and constants sit on top of every figure, so this is retrieval's
marginal cost rather than the whole World Info budget.

**The usable range is 0.05 to about 0.35.** Precision peaks and then falls, so past there the dial stops
trading and simply loses both. **Precision has a ceiling — it never reaches much above half at any cutoff
for any of the seven models** (E5) — which is a property of the ranking rather than of the dial, and the
number a better model would have to move.

The shipped defaults sit at the recall-favouring end deliberately. F2 weights recall, and the cutoff is
chosen on F2, so that preference is expressed twice; a user who wants the other end should say so with
this knob rather than expect the default to.

## The measurement

`relevance-regress.mjs --tier memory --lobo --cutoff` with the shipped feature set, on a lineage-disjoint
book set — the corpus state and the full recall/precision/AUC tables live in the register (E2, and its
corpus-states table). Each model gets its OWN fit — applying one model's coefficients to another's cosines
would favour whichever model the fit came from.

**Compared at a matched budget**, because a model allowed to pick its own cutoff answers a different
question. At F2's own optimum jina delivers about twice as many entries as Qwen3-8B and still scores lower
(E6). That is not a better model, it is a looser dial.

The verdicts, on recall at matched budget and on held-out AUC per book — the per-book read being what says
whether an ordering is real (E2):

**Qwen3-8B wins every book fold.** That is the one ordering here worth acting on. The Qwen family takes
the top three places, and `:4b` keeps most of 8B's lead at 2560 dimensions rather than 4096.

**The middle two are not separable.** embeddinggemma and qwen3-embedding:0.6b sit within noise of each
other and trade places by book. Do not read a ranking between them.

**ST's default is last.** jina-embeddings-v2-base-en is what a stock install embeds with, and it places
last of the seven on held-out AUC and on recall at matched budget, by a clear margin to the front of the
field.

Panopticon is the smallest fold, and every model does worse there than on any other book. Regressions
still land on the small books.

## Context length: check it against your scan window

WA embeds the **scan window** — the recent chat — not a search phrase, and a typical one measured here
runs to several times a 512-token context (E8). A model whose context is shorter than the window silently
truncates: it answers, with a vector describing only the beginning of the window.

`mxbai-embed-large`, which older guides recommend, has a 512-token context. Measured (E8): two queries
sharing a long prefix and then differing completely returned the **identical** vector — an exact 1.0 —
where bge-m3 clearly separated the same pair. Most of a typical scan window never reaches it.

It is not thereby the worst option — it still scores slightly above bge-m3, which sees the whole window
(E2). Truncation costs it something real and it is still outclassed by everything newer, so skip it for
that reason rather than this one. What the 1.0 does establish is that the failure is **silent**: a
truncating model answers normally and scores plausibly.

Do not infer this from the advertised number alone — embeddinggemma's context is listed at 2048 and it did
*not* truncate at that length in the same probe (E8). Check the model you plan to use, especially if you
have raised the scan depth.

## Quantization: 4-bit DWQ costs nothing measurable

Measured on Qwen3-Embedding-8B, same weights and runtime, 4-bit DWQ against 8-bit mxfp8: every difference
— F2 by book, cosine's solo AUC, the fitted model's AUC — sits inside the standard errors (E9).

So take the 4-bit build: half the memory resident for the same retrieval.

This is about **DWQ** — distillation-optimized 4-bit, where the quantized model is fitted to match the
full model's outputs rather than rounded to the nearest representable value. It is not a general licence
for 4-bit quantization of any kind.

## Speed

**These figures are Apple Silicon and say nothing about Nvidia hardware.** On CUDA, llama.cpp is not the
outlier it is here.

Per-chunk cost was measured on an M-series Mac, and the ratios between engines are the finding (E10).
Fastest to slowest: MLX (oMLX) serving 8B; llama.cpp (ollama) serving 4b; ST's default — jina under
transformers.js on the CPU; and llama.cpp serving 8B, far behind the rest.

**ST's default embedder runs on the CPU, and the cost lands on every turn.** `transformers.js` runs
quantized ONNX on ONE thread — threaded wasm needs a SharedArrayBuffer that is not available — and cost
climbs faster than linearly with input length: at a real scan-window length a single query costs several
seconds (E10). Indexing is a one-off; embedding the query is not, so those seconds are added to every
turn that retrieves.

So on a Mac, the 8B rung means MLX or hosted; at llama.cpp's 8B speed a mid-sized library takes over an
hour to index (E10). On a discrete GPU that constraint does not apply and ollama is fine.

Check your own setup rather than trusting the ranking: time one `/api/embed` of ~32 chunks before
committing to a full re-vectorize.

## Hosted

A perfectly good option, and better than local if your hardware is limited. Measured against a cheap
hosted provider: **indexing a five-book library costs pennies**, and steady use costs pennies per
thousand messages (E11).

The reason to decline is privacy, not price — every scan window is chat content leaving your machine.
Latency is the other consideration: a round trip per turn, blocking before retrieval starts.

## Before you switch

- **Switching model re-vectorizes every book**, and it is changed in Vector Storage, so it takes Vector
  Storage's own collections with it. Collections cannot mix vector lengths. Pick once.
- **Longer vectors cost disk and query time.** One book's index more than doubles going from length 1024
  to 4096 (E12), and scoring scales the same way.
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
scan window as a query (far longer than 512 tokens — E8) while Vector Storage embeds messages and file chunks, so a
512-token model is correct for Vector Storage and structurally broken for WA — one setting cannot serve
both. The cost of owning it is two embedding models resident for anyone running both extensions, which is
the eviction thrash under *Known gotchas*, self-inflicted. A default-inherit with an override is the
middle path; undecided.
