# Graded bundle schema, v3

A bundle holds **one or more graded scenes**: for each, a span of chat, the entries that were candidates
for it, and every verdict anyone has passed on those entries — plus the chat text and the books, shared
across the whole document. It is self-contained: a reader needs nothing else on disk to interpret it.

**One scene is a one-element `scenes` list.** There is no single-scene shape, so a reader that handles the
list handles everything and a writer never chooses between two layouts.

`schemaVersion: 3`. One version exists and nothing on disk predates it; there is no compatibility to carry.

## The bundle presents the record. It does not resolve it.

Every verdict ever passed is in the file, in the order it was passed. **No field holds a reduced value** —
no grade in force, no resolved scalar, no note of how a disagreement was settled, and no bundle-level
label standing in for a row's own. Which verdict counts is the reader's question (`metrics.mjs`), and two
readers may answer it differently without either being wrong about what the file says.

A reduced value stored beside the record is indistinguishable from a verdict someone gave.

## Identity is `book` + `uid`, as two fields

`uid` is unique within a book and nowhere else, and a scene routinely draws on more than one book. The two
are never joined into one string in the file: lorebook names are filenames, and **measured** across 44
books they already contain spaces, commas, apostrophes, parentheses, `#` and `@` — so no printable
separator is safe. Code needing a single key joins them in memory with US (`\x1f`), as the rest of the
codebase does.

## A scene's id is composed, not opaque

`<normalized chat>-msg-<end>` — `sommers_example-msg-1044`. The MOMENT, not the span. Normalized is the
chat's basename without extension, with every run of anything outside `[A-Za-z0-9_]` collapsed to `-`;
that is also what makes the id safe to compose at all, since chat names are filenames.

Composing it means a reader reasons from the id alone, and that it can be checked against the fields it
was built from — a cheap guard against a mis-extracted scene. It is the key into `sceneChats`,
`sceneInjects` and every arm's `scenes` map, and the handle anything outside the document refers to a
scene by.

**A different depth over the same moment is the SAME scene**, read more or less widely.
`graded-scene-grid`'s depth sweep holds the grades fixed while it varies the window, because widening
reaches further back from one graded moment rather than moving to another. So `sceneStart` and `depth`
belong to the arm's capture of the scene, not to the scene — which is why neither is in the id.

**One capture has one haystack.** `sceneChats` is hoisted per scene, so arms reading different windows
would silently share the first one's, and every count taken over it. A writer refuses to pack those as one
capture; until the haystack is stored per cell, arms at different depths belong in separate documents.

**Message indices are CHAT FILE RECORD indices**, the jsonl's own line numbers, header included at 0. The
alternative is ST's in-memory chat array, which is the same list minus that header — off by one, and a
runtime object rather than the artifact `sceneChat` names. The arm's `sceneStart` is read off the window
rather than computed as `end - depth + 1`: the window drops empty and hidden messages, so the two differ
exactly when a scene contains any.

**A SCENE ID IS NOT UNIQUE, and `captureId` is.** Two captures of one turn under different books share a
scene id and a `name` — the corpus holds such a pair, and its only distinguishing mark was its filename.
`captureId` is minted per capture, survives a rename, and is what a pointer between artifacts should
carry.

## Shape

```jsonc
{
  "schemaVersion": 3,
  // WHAT IDENTIFIES THIS CAPTURE, surviving a rename. Nothing content-derived can: `name` and a scene id
  // both collide across two captures of one turn under different books.
  "captureId": "4f1c2e90-7a63-4d1e-9c02-8b5a1d3e7f44",
  "name": "sommers-syn-msg1044",
  "createdAt": "2026-08-21T09:14:02.118Z",

  // ONE ENTRY PER SCENE — the graded MOMENT: a chat, and the message it ends at. No span: the span is
  // what an arm chose to READ of it, and two arms may read different amounts of the same moment.
  "scenes": [
    {
      "id": "Sommers-ABO-Frozen-Test-msg-1044",
      "sceneChat": "…/Sommers ABO - Frozen Test.jsonl",
      "sceneEnd": 1044,

      // ONE ROW PER CANDIDATE ENTRY, carrying only what is true of the entry and the verdicts on it.
      // Scores are NOT here — they are properties of a configuration, not of the entry (see `arms`).
      "entries": [
        {
          "book": "Sommers_Pack__v22",
          "uid": 1,
          // Duplicated from the entry for triage: reading a bundle by eye is most of what anyone does
          // with one, and a list of uids is unreadable.
          "title": "262 - Finale Prototype Testing at The Grove",
          // EVERY verdict, in the order passed, naming its rater by index. See *A rater is whoever
          // passed a verdict* and *One `grades` array*.
          "grades": [
            { "rater": 0, "grade": 3, "gradedAt": "2026-08-19T18:08:01.442Z", "why": "…" },
            { "rater": 1, "grade": 2, "gradedAt": "2026-08-20T14:12:25.907Z" }
          ]
        }
      ]
    }
  ],

  // ONE ARM PER CONFIGURATION, at DOCUMENT level — an arm is a configuration and a configuration spans
  // scenes, which is what a grid search is. Nesting them inside a scene would record `params` and the
  // versions once per scene.
  "arms": [
    {
      "name": "shipped",
      // WHAT PRODUCED THIS CAPTURE. Not declared versions — a staging checkout's package.json names a
      // release it is not.
      "waVersion": "matcher-and-studio@7cd7496+dirty",
      "stVersion": "staging@4ed137241",
      // `scoredBy` is the fitted model's identity — a knob like any other, and the one thing
      // waVersion/stVersion cannot carry, since the model ships as data rather than as code.
      "params": { "lexicalWeight": 1, "chunk": "paragraph", "scoredBy": "relevance-model@a1b2c3d4" },

      // THE CELL: this arm's capture of that scene, keyed by scene id. Everything varying with BOTH
      // coordinates is here — the span it read, the query it built, the rows it surfaced.
      "scenes": {
        "Sommers-ABO-Frozen-Test-msg-1044": {
          // Redundant with `depth` on purpose: the two disagreeing means the scene was mis-extracted.
          "sceneStart": 1035,
          "depth": 10,
          "query": "…", "queryChat": [ /* … */ ], "primaryBook": "Sommers_Pack__v22",
          // IN LAYOUT ORDER — see below. `index` and `tokens` are the fields a reader can count on;
          // `scores` is WHATEVER THE CAPTURE RECORDED, keyed by the feature's own name.
          "candidates": [
            { "book": "Sommers_Pack__v22", "uid": 1, "index": 0, "tokens": 214,
              // What the row IS, beside what it scored — the classification the runtime gave it, the
              // budget's verdict, and the key hits that explain the keyword number.
              "title": "262 - Finale…", "block": "dynamic", "sticky": 1, "wiOrder": 1001,
              "score": 0.0456, "vRank": 3, "tRank": 14, "kRank": 3, "why": [],
              "scores": { "cosine": 0.1234, "text": 25.1234, "proper": 12, "length": 0.1237 } }
          ]
        }
      }
    }
  ],

  // WHO THE INDICES NAME.
  "raters": [
    { "rater": 0, "kind": "llm", "id": "637cc0ff…40840\x1fscene-relevance@8460b922", "modelName": "gemma4:31b-mlx" },
    { "rater": 1, "kind": "human", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
  ],

  // THE HAYSTACK'S INPUTS, NOT THE HAYSTACK. `sceneChats` is the CHAT half; `sceneInjects` are the
  // scan-enabled extension prompts beside it, each carrying the position and depth that decide which
  // windows admit it. A reader RECONSTRUCTS a window by admitting them at a depth (matcher.mjs
  // `makeWindowFor`) — the only direction that works, since a joined blob cannot be taken apart.
  // CONTENT IDENTITY, keyed by the same names as `books`. Two captures hold the same book when these
  // agree — answerable without inflating two megabytes of entries.
  "bookHashes": { "Sommers_Pack__v22": "10bdb8e8…" },
  "sceneChats": { "Sommers-ABO-Frozen-Test-msg-1044": [ { "name": "Ada", "mes": "…" } ] },
  "sceneInjects": { "Sommers-ABO-Frozen-Test-msg-1044": [
    { "key": "NOTE", "text": "…", "ambient": false, "depth": 2 },
    { "key": "1_memory", "text": "…", "ambient": true, "depth": 0 }
  ] },
  "books": { "Sommers_Pack__v22": { /* … */ } }
}
```

## Field order is part of the schema

`sceneChats`, `sceneInjects` and `books` go LAST, in that order, and every writer emits them so — books
last, being the largest by a wide margin. `bookHashes` sits just AHEAD of them: it describes the bulk but
is two lines, and putting it in front is what makes "same book?" answerable with `head`. They are almost all of a bundle's
bytes, so anything ahead of them is reachable with `head` — every scene, every param, every grade — and
anything behind them is not.

**An absent `sceneInjects` means no injects.** **Measured** across all 107 documents: every haystack ends
at its own last chat message, so none has inject text folded into it — the only scan-enabled prompt on the
capturing install was the built-in summarizer, which carries `scan: true` by default but had no value, and
an empty prompt is never pushed.

**This is why the haystacks are hoisted rather than kept on their scenes.** A `sceneText` inside each
scene puts the bulk between scene 1 and scene 2, so a fifteen-scene bundle is unskimmable no matter what
order a scene's own fields are in.

## Candidate order is the layout order

`arms[].candidates` is written in the order the arm laid the entries out, and that is load-bearing rather
than incidental. Every stage-4 cap is a prefix cut, so a reader can replay the budget walk over the array
as it stands — take entries until a cap or the token budget is spent — and see exactly what would have
shipped under a different budget without re-running retrieval.

That is what `tokens` on each candidate is for: without it the walk cannot be simulated at all, only
described, and re-tokenizing offline gives a different answer than the tokenizer that made the decision.

**`budget` is DOCUMENT-LEVEL, and that is a consequence of the above.** It holds stage 4's caps — the entry
maxes, the token budget, the slack mode — and `tokenizer`, the name those per-candidate counts were produced
under. No arm carries a variant, because none is ever captured: a budget arm is a prefix cut over a layout
ranking that is already recorded, so it is swept OFFLINE through `selection.mjs` `applyBudget` instead of
costing a capture. `tokenizer` could not vary in any case — it is ST's `getTokenizerModel()`, an environment
fact WA does not set, which is why it sits beside `embedModel` rather than inside `paramSnapshot`. **Measured**
across the corpus: 0 of 106 multi-arm documents varied any field of it.

`paramSnapshot` stays per-arm and does vary — `scoring`, `matchText`, `vectors` and `nonDefaults` all differ
between arms in 9 documents. It is the settings the arm ran under; `budget` is what the whole capture was
budgeted by.

A writer that sorts candidates by anything else produces a valid bundle that silently answers budget
questions wrongly, and array order is the only record of layout — so `index` restates it as the one
witness a reader can check the order against. Without it a reordered file is undetectable.

`scores.length` is `log(tokens)` and so derivable from the `tokens` beside it. It is kept for the same
reason: the two should always agree, and the capture where they do not is the one worth knowing about.

## `scores` is a capture record, not a schema

Its keys are whatever the capturing version computed, named as the model names them — `relevance-model.json`
lists `features`, and those strings index into `scores` directly. That is why the scores are a nested
object rather than `cosineScore`, `textScore` and so on: a reader looks up a literal feature name instead
of composing a key, and a feature that arrives or leaves changes nothing structural.

The same holds for `arms[].params`. A fixed list would have to be revised for every new knob, and a
bundle written before the revision would read as malformed rather than as older.

A reader that needs a score it cannot find has met an older capture, not a broken file — which is what
`waVersion` and `stVersion` on the arm are for.

**Only measured SIGNAL VALUES go in it.** A rank is a position within one arm's ordering and the fused
`score` is that arm's own composite, so neither is a feature and neither is something a model indexes by
name; they sit flat on the candidate with `index`, `tokens` and the classification fields. The test is
whether a feature list could legitimately name it.

## The version fields record what was resolved, not what was declared

Both are `<branch>@<git describe --tags --always --dirty='+dirty'>`, and the two projects use the one rule
because a reader comparing captures should not have to know which field follows which convention.

```
main@0.2.0                    on a tag: the identity IS the version
main@0.2.0+dirty              …with uncommitted changes
main@0.2.0-1-g6cbcecf         past the tag: version, distance, commit
matcher-and-studio@7cd7496    no tags reachable: the commit alone
```

**The branch is not decoration.** ST's declared version only advances on pushes to `main`, so a staging
checkout reports a number with nothing to do with the tree that ran — this one's `package.json` says
`1.18.0` while its tree is 167 commits past `1.17.0`. `staging` and `release` are different software, and
the branch is what says which.

**On `main` the identity is always exactly a version**, because a release is one squashed commit carrying
one tag. The distance form therefore only appears off main, and a capture from a release can be read as a
version string with nothing parsed off it.

**A declared version is never read.** `manifest.json` and `package.json` say what the next release will be
called, not what ran; only a tag makes a version a fact about a commit. A capture on an untagged commit
records the commit, which is honest — and the version bump that has no tag behind it is a thing to catch
at push time, not to paper over here.

**A `+dirty` suffix means the tree had uncommitted changes.** Neither a version nor a commit identifies
uncommitted code, so without it a capture from a working tree is indistinguishable from one made at that
commit, and the suffix is what says the capture cannot be reproduced from the version alone. It is
deliberately not a description of what differed: a diff would not survive in a field anyone reads, and
knowing the run is unreproducible is the whole of what a reader can act on.

`+dirty` is SemVer BUILD METADATA, which annotates a version without changing its precedence — `0.2.0+dirty`
compares equal to `0.2.0`, which is what a dirty tree is. Git's own default marker is `-dirty`, and that
would be a SemVer PRE-RELEASE sorting BELOW `0.2.0` — backwards, since a dirty tree is that version plus
changes rather than a candidate for it.

A suffix rather than a prefix so that a series filter like `0.2.*` INCLUDES dirty captures. Excluding them
should be an explicit act — a filter that silently drops the unreproducible rows is how an analysis loses
data without anyone seeing it happen.

They sit on the ARM rather than the bundle: arms of one scene are captured at different times, and a
re-capture months later is the case where the version matters most.

## `invalidConfiguration` marks a capture that is not a real configuration

A control — a wrong-book capture, a deliberately broken parameter — looks exactly like a real scene, and
pooled with real ones it is scored as if someone meant it. The field carries the REASON rather than a
bare `true`, because "this is not valid" without saying why is a fact nobody can act on:

```jsonc
"invalidConfiguration": "wrong-book control: primaryBook set to an unrelated book, to measure the floor"
```

Absent means valid. Nothing infers it — `-null-book` in a filename is a note to the author and no
guarantee, and a renamed file loses it.

**It does not make the capture unreadable.** A control exists to be looked at; grids print it and carry
on. What it must never do is enter a pooled set silently, which is the whole reason it is on the document
rather than in the name.

## An entry absent from `entries` is ungraded

`arms[].candidates` is what an arm surfaced; `entries` is what carries verdicts. A candidate with no row
in `entries` simply has not been scored — not an inconsistency, and not something a writer should
manufacture an empty row for.

## Verdict elements

A verdict is `{ rater, grade }` plus what qualifies it: `gradedAt`, an optional `why`, and an optional
`params`. `rater` is an index into the document's `raters` table; nothing else on the element says who
passed it, because the table is where an identity is spelled out.

**`params` is what the pass was RUN under, and it is not identity.** Seed, temperature, context length,
`think`, `effort` — whatever the invocation set, recorded under the name the invocation used. Not
condensed into a common scale across backends: `params` exists so a pass can be reproduced, and
`reasoning: high` cannot say whether to send `think: true` or `effort: high`. Those are also not the same
thing — `think: false` is a capability declined, `effort: low` is a level — and a cross-backend reading
belongs beside `gradeValue`, with the other reader-side questions.

Best-effort throughout. A knob a writer does not know is simply absent, and absence stays legible:
a model with no thinking capability records no `think`, which is a different fact from one that has it and
declined. In a positional id those three states — unsupported, unset, unrecorded — collapse into one empty
string, which is why the knobs are here and not there.

**Why a pass ran is not who ran it.** An adjudication verdict is another verdict, and its position in the
array already says so; nothing records the reason, and it is never a suffix on the rater's name.

**NOTHING IS EVER OVERWRITTEN.** A re-grade appends beside the verdict it disagrees with, whoever gave
either — that comparison is the only thing that says whether a rater or a rubric moved, and a
last-writer-wins merge deletes it.

The single exemption is a repeated PASS, so that re-running a merge is idempotent. A pass is
**rater + `gradedAt`** (`passKey` in `extension/grading.mjs`) — who, and when to the millisecond.

`params` is deliberately NOT in it. Dedup runs over one entry's verdicts and a pass grades each row
exactly once, so two verdicts on a row always came from two dispatches and already differ in their stamp;
keying on params would only make identity depend on how completely a writer recorded the knobs, so
recording one more later would stop an old verdict matching its own re-merge.

**Every `…At` field is `toISOString()` — UTC, `Z`, milliseconds, and the SAME precision throughout.**
`createdAt`, `gradedAt`, `reviewedAt`, `graftedAt` and `frozenAt` all record an instant; a reader wanting a
day slices one. Truncating at write time is the same error as freezing a joined haystack — it discards
what cannot be recovered to save a step that costs nothing. It also had a live consequence: a document's
`createdAt` stamps the human verdicts captured with it, so a day-granularity `createdAt` made two
`/wa-grade` sessions in one day one pass.

Not merely "ISO 8601": a local-offset spelling like `2026-08-21T15:03:02.481+01:00` breaks both of the
properties the format is chosen for. Sorting stamps as STRINGS gives chronological order, and slicing one
gives a bucket at any precision — `.slice(0,4)` year, `,7)` month, `,10)` day, `,13)` hour. Mixed
precision is safe: a day-only stamp from a migrated capture sorts before any time on that day and slices
identically. Unix milliseconds would separate two sequential passes just as well and lose both.

**`gradedAt` is named for the moment rather than the calendar**, because four writers read a field called
`gradeDate` and truncated it to one. A second pass over the same rows on the same day is the adjudication
case — and a hosted rater has no `params` at all, so the stamp is the whole of what separates
two of them. At day granularity that second pass reads as the first merged twice and is dropped. It
records when the PASS RAN, taken from the result itself or from when the result file was written; merge
time is a last resort and cannot separate two passes filed in one invocation.

## A rater is whoever passed a verdict

`kind` is `human` or `llm`, and **`id` is one canonical field either way** — so grouping verdicts by rater
is a plain key comparison, in metrics and everywhere else.

A human's id is a UUID, minted once per install. An llm's is two components joined with **US**
(`\x1f`), decomposable and never printable-joined:

```jsonc
"raters": [
  { "rater": 0, "kind": "human", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
  { "rater": 1, "kind": "llm",   "id": "637cc0ff…40840\x1fscene-relevance@8460b922",
    "modelName": "gemma4:31b-mlx", "family": "gemma4", "quant": "Q4_K_M", "modelParams": "25.8B" }
]
```

| component | is |
|---|---|
| `modelId` | the resolved model — a content digest where one exists, else the invoked name |
| `rubric` | the contract it graded under — `scene-relevance@8460b922` |

**WEIGHTS AND CONTRACT ONLY.** The knobs a pass ran under live on the verdict (*Verdict elements*), not
here: they change the sample, not who produced it. The same weights under the same rubric sampled twice is
ONE rater giving two verdicts, which is how a third vote for the median is reached — and folding a seed
into the identity would assert a determinism nothing has, since a model without one is nondeterministic
and one with it frequently still is (CLAUDE.md: hosted reasoning models honour neither seed nor
temperature, measured at 1815 vs 935 reasoning tokens on identical requests).

**The digest is in the id because the name is not an identity.** `bge-m3:latest` is whatever was pulled
most recently, so two captures months apart record one string for different weights — the same failure as
reading a declared version instead of a resolved one. Ollama's API returns a manifest digest per model; a
hosted model has none to give, and an empty component says so rather than implying a stability nothing
provides.

**US, not a printable separator.** **Measured**: 11 of 11 local Ollama models carry a `:`
(`gemma4:31b-mlx`, `bge-m3:latest`), every MLX model is a HuggingFace repo id carrying a `/`, and `@`
already appears inside a rubric — so a printable join cannot be decomposed. US is a control character and
cannot occur in either component, which is why it is the project's composite key everywhere else
(CLAUDE.md). `raterKey`/`raterParts` in `extension/grading.mjs` are the only join and split.

**Coarser groupings live in the descriptive fields**, and are not derivable from the id: `modelName` is
the model LINE and spans digests (`bge-m3:latest` re-pulled is two raters and one line); `family` is the
architecture. Three questions — same rater, same model, same architecture — and three fields, which is why
a hashed id would have been strictly worse: it destroys exactly that addressability and buys nothing over
the raw components. The components themselves are NOT duplicated as fields, since `raterParts` splits the
id in one call and a second copy could only drift.

## One `grades` array, in the order passed

Not one array per kind. The file promises every verdict "in the order it was passed", and two arrays
cannot express that ACROSS kinds — a human grading, an llm re-grading under a corrected rubric, then the
human revising is exactly the sequence the review flow produces, and split arrays record it as two
unrelated orders.

Provenance is not lost by merging them: it moves from which array a verdict sits in to which rater it
names, which is structural either way. The collapse the split guarded against was one FIELD holding both
kinds at one value with nothing saying which; nothing here can be written without naming a rater.

**A verdict names its rater by INDEX**, and the table says who that is. Spelled out per verdict these are
the same handful of strings repeated tens of thousands of times — **measured**: 645KB of llm identity
across 3 distinct models and 4 rubrics — and unreadable by eye, which is most of what anyone does with a
bundle. `openBundle` resolves the index back to the whole rater, so every reader and writer works in
identities and only the file is indexed; unlike a joined blob, an index can always be followed.

**The table is per DOCUMENT, so an index is document-local.** Pooling several documents means remapping
through each one's own table — which is why the id, not the index, is the identity.

## Reader-side, not in the file

- Which grade is in force. Human outranks judge; within a list, whatever rule the reader states.
- Agreement, drift, and per-rater statistics.
- Availability — whether an entry could have existed at `sceneEnd`.

The rule WA states is `extension/grading.mjs` `gradeValue`, re-exported by `eval/metrics.mjs` so every
reader shares one copy of it: the latest human verdict if any — a person re-grading has seen the earlier
one and replaced it — else the judges' MEDIAN once three exist, else the latest judge. Newest-first among
judges is only defensible when a later pass is known to be better, and it is not: re-grading the same rows
with the same model under a corrected rubric moved ~30% of the relevant set out. **Measured**: this rule
reproduces all 11,946 `llmGrade` scalars v2 stored, which is what made moving the resolution out of the
file lossless rather than a silent re-labelling.

## Open

- Whether the schema is camelCase throughout. It is now, but `sceneChat` and `waVersion` were arrived at
  separately.
- **`waVersion` has no browser source.** A live capture records `stVersion` from ST's own `/version`
  (`<branch>@<short HEAD>`, no tags and no dirty flag) and omits `waVersion` entirely, since the page
  cannot run git and the deployed plugin is a copy rather than the repo. `sourceFP` is the stronger drift
  signal there anyway, being a hash of the code rather than a name for it. Node-side writers resolve both
  properly. Closing this wants a plugin route reporting `git describe` over the extension directory.
- **`why` is bulk, and it is not last.** A candidate's matched-key excerpts are most of what sits ahead of
  `sceneChats` — 18% of a two-megabyte document, against 0.6% for every scene field and verdict combined.
  The field-order rule names only the two hoisted blocks, so this is within the letter of it and against
  the point.
- **Arms nest inside scenes, so a configuration is recorded once per scene.** A fifteen-scene document
  repeats `shipped`'s `params` fifteen times. The alternative is arms at DOCUMENT level, each holding its
  captures keyed by scene id — a configuration recorded once, which is what an arm IS:

  ```jsonc
  "scenes": [ { "id": "…", "sceneChat": "…", "sceneStart": 90, "sceneEnd": 100, "entries": [ … ] } ],
  "arms": [ { "name": "shipped", "params": { … },
              "captures": { "…-msg-90-100": { "query": "…", "candidates": [ … ] } } } ]
  ```

  A CAPTURE IS THE (SCENE, ARM) CELL and everything that varies with both belongs on it: the candidates,
  the query, the cutoff, the index. What stays on the arm is what varies with the configuration alone.

  `depth` does NOT obstruct this, though an earlier draft of this note said it did. One arm has one depth,
  and the N scenes it covers all have spans that depth produced — different spans, one value. Two arms at
  different depths produce different spans and so are captures of different SCENES, which the schema
  already says. Nothing stores an arm spanning two depths; `--depths` in `graded-scene-grid.mjs` is a
  read-time ablation that rebuilds queries and writes nothing.

  What it costs is that a scene stops being self-contained — slicing a document to one scene means walking
  every arm — and nothing writes a multi-scene document yet, so the win is currently zero.
- **`query` and `queryChat` are per-arm and duplicated.** Both are produced by a configuration (`queryMode`
  moves them), so they cannot hoist to the scene the way the haystack does — but six arms of one scene
  carry six identical copies whenever no arm moved them, which is every capture on disk.
