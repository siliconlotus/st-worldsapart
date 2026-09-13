# Graded bundle schema, v3

A bundle holds one or more graded scenes: for each, a span of chat, the entries that were candidates
for it, and every verdict anyone has passed on those entries — plus the chat text and the books, shared
across the whole document. A reader needs nothing else on disk to interpret it. One scene is a
one-element `scenes` list; there is no single-scene shape. `schemaVersion: 3`, and nothing on disk
predates it.

## The bundle presents the record. It does not resolve it.

Every verdict ever passed is in the file, in the order it was passed. No field holds a reduced value —
no grade in force, no resolved scalar, no note of how a disagreement was settled, and no bundle-level
label standing in for a row's own. Which verdict counts is the reader's question (`metrics.mjs`).

## Identity is `book` + `uid`, as two fields

`uid` is unique within a book and nowhere else. The two are never joined into one string in the file:
lorebook names are filenames and already contain every printable separator (G8). Code needing a single
key joins them in memory with US (`\x1f`).

## A scene's id is composed, not opaque

`<normalized chat>-msg-<end>` — `sommers_example-msg-1044`: the moment, not the span. Normalized is the
chat's basename without extension, every run outside `[A-Za-z0-9_]` collapsed to `-`. It keys
`sceneChats`, `sceneInjects` and every arm's `scenes` map. A different depth over the same moment is
the same scene, so `sceneStart` and `depth` sit on the arm's cell, not in the id; one capture has one
haystack, so arms at different depths belong in separate documents. Message indices are chat file
record indices — the jsonl's own line numbers, header at 0 — and `sceneStart` is read off the window,
which drops empty and hidden messages, not computed as `end - depth + 1`.

A scene id is not unique; `captureId` is. Two captures of one turn under different books share a scene
id and a `name`; `captureId` survives a rename and is what a pointer between artifacts carries.

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
      "params": { "lexicalWeight": 1, "chunk": "paragraph", "scoredBy": "relevance-model-memory@a1b2c3d4" },
      // THE SETTINGS THE CONFIGURATION RAN UNDER — on the arm, by the same rule as `params`: a
      // configuration spans scenes, so this cannot vary between them (one capture reads one settings
      // object). `settings` is every scalar setting by name, an OPEN MAP that grows with the app.
      "paramSnapshot": { "settings": { "chunkSize": 1750, "…": "…" }, "derived": { "maxTokensEffective": 29036 } },

      // THE CELL: this arm's capture of that scene, keyed by scene id. Everything varying with BOTH
      // coordinates is here — the span it read, the query it built, the rows it surfaced.
      "scenes": {
        "Sommers-ABO-Frozen-Test-msg-1044": {
          // Redundant with `depth` on purpose: the two disagreeing means the scene was mis-extracted.
          "sceneStart": 1035,
          "depth": 10,
          // ON THE CELL ONLY WHEN THE ARMS DISAGREE — `queryMode` moves them, so they cannot hoist
          // unconditionally; when nothing moved them they sit once on the scene instead.
          "query": "…", "queryChat": [ /* … */ ], "primaryBook": "Sommers_Pack__v22",
          // WHAT THE GRADER WAS SHOWN, which a later run needs to know what it may believe. `cutoff` is
          // the depth this capture graded at; `gradedCandidates` is how many rows actually reached a
          // grader, so rows past it are UNGRADED rather than irrelevant, and a deep-cutoff arm scored
          // past it is reporting a lower bound. NOTHING declares a grade out of scope: the harness ranks
          // every book in `books`, so scope is membership there (eval/scene.mjs `outOfScope`). Bundles
          // written before 2026-08-25 carry an `excludeTitles` list here; it is not read.
          "cutoff": { "live": { "maxVectorEntries": 20 } }, "gradedCandidates": 20,
          // IN LAYOUT ORDER — see below. `index` and `tokens` are the fields a reader can count on;
          // `scores` is WHATEVER THE CAPTURE RECORDED, keyed by the feature's own name.
          "candidates": [
            { "book": "Sommers_Pack__v22", "uid": 1, "index": 0, "tokens": 214,
              // What the row IS, beside what it scored — the classification the runtime gave it, the
              // budget's verdict, and the key hits that explain the keyword number. `block` is one of
              // `constant` | `sticky` | `promoted` | `dynamic`; see *A row's block*.
              "title": "262 - Finale…", "block": "dynamic", "sticky": 1, "wiOrder": 1001,
              // NO `why`: the key hits that explain the keyword number are bulk, and live in
              // `candidateWhy` behind the head of the file. `openBundle` puts them back on the row.
              "score": 0.0456, "vRank": 3, "tRank": 14, "kRank": 3,
              "scores": { "cosine": 0.1234, "text": 25.1234, "proper": 12, "length": 0.1237 } }
          ]
        }
      }
    }
  ],

  // WHO THE INDICES NAME.
  "raters": [
    { "rater": 0, "kind": "llm", "id": "637cc0ff…40840\x1fscene-relevance@8460b922",
      "modelName": "gemma4:31b-mlx", "family": "gemma4", "quant": "Q4_K_M", "modelParams": "25.8B" },
    { "rater": 1, "kind": "human", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
  ],

  // THE HAYSTACK'S INPUTS, NOT THE HAYSTACK. `sceneChats` is the CHAT half; `sceneInjects` are the
  // scan-enabled extension prompts beside it, each carrying the position and depth that decide which
  // windows admit it. A reader RECONSTRUCTS a window by admitting them at a depth (matcher.mjs
  // `makeWindowFor`) — the only direction that works, since a joined blob cannot be taken apart.
  // CONTENT IDENTITY, keyed by the same names as `books`. Two captures hold the same book when these
  // agree — answerable without inflating two megabytes of entries.
  "bookHashes": { "Sommers_Pack__v22": "10bdb8e8…" },
  // arm -> scene -> the matched-key excerpts of each candidate, POSITIONALLY ALIGNED with that cell's
  // `candidates`. Absent when no candidate matched a key.
  "candidateWhy": { "shipped": { "Sommers-ABO-Frozen-Test-msg-1044": [ [ { "key": "ada", "excerpt": "…" } ] ] } },
  "sceneChats": { "Sommers-ABO-Frozen-Test-msg-1044": [ { "name": "Ada", "mes": "…" } ] },
  "sceneInjects": { "Sommers-ABO-Frozen-Test-msg-1044": [
    { "key": "NOTE", "text": "…", "ambient": false, "depth": 2 },
    { "key": "1_memory", "text": "…", "ambient": true, "depth": 0 }
  ] },
  // Only the card/persona fields some entry's `matchXxx` names. Absent when none does.
  "sceneSources": { "Sommers-ABO-Frozen-Test-msg-1044": { "scenario": "…" } },
  "books": { "Sommers_Pack__v22": { /* … */ } }
}
```

## Field order is part of the schema

`candidateWhy`, `sceneChats`, `sceneInjects` and `books` go last, in that order, with `bookHashes` just
ahead of them, so everything else — every scene, param and grade, and "same book?" — is reachable with
`head`. `why` lives in `candidateWhy`, keyed arm -> scene and aligned by position with the cell's
`candidates`, because matched-key excerpts are the heaviest thing after the books (G8); `openBundle`
re-attaches it, so a reader still says `c.why`. Haystacks are hoisted off their scenes for the same
reason.

`sceneSources` carries only what an entry opted into: the six `scanSources()` fields — five
character-card fields and the persona description — each gated by a per-entry `matchXxx` flag, kept
only when some entry names them (`matcher.usedMatchSources`). The Author's Notes (`note.allowWIScan`),
the persona description at `TOP_AN`/`BOTTOM_AN` and the character depth prompt under `allowWIScan`
arrive as injects, in `sceneInjects`; absent `sceneInjects` means no injects (G8).

## Candidate order is the layout order

`arms[].candidates` is written in the order the arm laid the entries out. Every stage-5 cap is a prefix
cut, so a reader replays the budget walk over the array as it stands; `tokens` on each candidate is
what makes that possible, and `index` is the witness a reordered file fails. `budget` is therefore
document-level — stage 5's caps and `tokenizer`, the name the counts were produced under — because a
budget arm is swept offline through `delivery.mjs` `applyBudget` and no arm carries a variant (G8).
`tokenizer` is ST's `getTokenizerModel()`, an environment fact, so it sits beside `embedModel` rather
than in `paramSnapshot`, which is per-arm and does vary (G8).

Required fields are written by every capture and their absence is a defect. Emitted only when they have
a value: `waVersion` and `stVersion` (`waVersion` is empty with no server plugin), `book`,
`gradedCandidates`, `gradeScale`, `paramSnapshot`, `candidateWhy`, `invalidConfiguration`, and the
`query`/`queryChat` pair, on the scene or the cell but never both. Every bundle on disk is structurally
clean (G8).

`candidates[].scores`, `params`, `paramSnapshot.settings`, `books`, `bookHashes` and the `scene*` maps
are open maps keyed by whatever the capturing version computed, so an unlisted key is expected. Every
structural field — document, scene, arm and cell keys — is closed and listed here. `scores.length` is
`log(tokens)`; it is kept so the capture where the two disagree can be found.

## `scores` is a capture record, not a schema

Its keys are whatever the capturing version computed, named as the model names them —
`relevance-model-memory.json` lists `features`, and those strings index into `scores` directly; the same
holds for `arms[].params`. A score a reader cannot find means an older capture, which is what
`waVersion` and `stVersion` on the arm are for. Only measured signal values go in it: a rank and the
fused `score` are an arm's own and sit flat on the candidate with `index`, `tokens` and the
classification fields.

## A row's block

`block` is the activation class the runtime put the row in, and the only categorical field on a
candidate. The distinction that matters to a reader is durable versus not:

| block | in the prompt because | graded |
|---|---|---|
| `constant` | it is always on | no |
| `sticky` | an EARLIER turn armed the effect | no |
| `promoted` | it activated and the author declared that sufficient (`@@promote`) | yes |
| `dynamic` | it activated and relevance selected it | yes |

`isDurable` (`extension/grading.mjs`) is `constant || sticky`: durable rows are in the prompt by intent,
so they are listed and not graded; a promoted row is exempt from the relevance cut, not from being
judged. Anything asking "is this row gradeable" reads `!isDurable(row)`; testing `block === 'dynamic'`
drops promoted rows out of the pool. A row with `sticky` configured that activated this turn reads
`dynamic`: `block` is the runtime state, `sticky` the authored value.

## Every stored path is relative to the ST install

`chat`, `sceneChat`, `index`, `book` and `generatedFrom.chat` are written from the install root down —
`data/default-user/chats/…`, `public/scripts/extensions/…` — never absolute, which is machine identity
carrying the author's OS username. `grading.mjs` `stRelative` cuts at the first of ST's top-level
directories, first because a chat folder may itself be named `data`; a path naming none is stored
unchanged. `stInstall().resolve` maps a `data/` prefix through `config.yaml` `dataRoot` and anything
else through the root; `eval/scene.mjs` skips a stored `index` that does not exist locally and derives
its own.

## The version fields record what was resolved, not what was declared

Both are `<branch>@<git describe --tags --always --dirty='+dirty'>`, one rule for both projects, on the
arm because arms of one scene are captured at different times.

```
main@0.2.0                    on a tag: the identity IS the version
main@0.2.0+dirty              …with uncommitted changes
main@0.2.0-1-g6cbcecf         past the tag: version, distance, commit
matcher-and-studio@7cd7496    no tags reachable: the commit alone
```

The branch says which software ran: ST's declared version only advances on pushes to `main`, so a
staging `package.json` names a release its tree is not (G8); on `main` a release is one squashed commit
carrying one tag, so the identity is exactly a version. `manifest.json` and `package.json` are never
read — only a tag makes a version a fact about a commit. `waVersion` comes off the server plugin's
`/ping` and is empty without one (`sourceFP`, a hash of the code, is the stronger drift signal);
`stVersion` comes from ST's `/version` (`<branch>@<short HEAD>`, no tags, no dirty flag). `+dirty`
means uncommitted changes, so the capture cannot be reproduced from the version alone; it is SemVer
build metadata, equal to `0.2.0` rather than sorting below it as git's `-dirty` would, and a suffix so
that a `0.2.*` filter includes dirty captures and excluding them is an explicit act.

## `invalidConfiguration` marks a capture that is not a real configuration

A control — a wrong-book capture, a deliberately broken parameter — looks exactly like a real scene. The
field carries the reason, never a bare `true`:

```jsonc
"invalidConfiguration": "wrong-book control: primaryBook set to an unrelated book, to measure the floor"
```

Absent means valid; nothing infers it from a filename. Grids print a control and carry on; what it must
never do is enter a pooled set silently.

## An entry absent from `entries` is ungraded

`arms[].candidates` is what an arm surfaced; `entries` is what carries verdicts. A candidate with no row
in `entries` has not been scored, and a writer does not manufacture an empty row for it.

## Verdict elements

```jsonc
// entries[].grades[] — one element per verdict passed on that row
{
  "rater":    0,                            // int       index into raters[]
  "grade":    3,                            // int       0..gradeScale (4)
  "gradedAt": "2026-08-21T09:14:02.118Z",   // string    full ISO instant, UTC, ms
  "why":      "…",                          // string?   optional
  "params":   { }                           // object?   what the pass RAN under; never identity
}
```

```jsonc
// grades[].params — best-effort, each key named as the INVOCATION named it, never normalised
{
  "seed":        42,                // as sent
  "temperature": 0,
  "num_ctx":     32768,
  "think":       true,              // capability used or declined; ABSENT if the model has none
  "effort":      "high",            // a level — not the same fact as `think`
  "tool":        "wa-super-eval"    // what produced the verdict
}
```

`rater` is an index into `raters[]`; nothing else on the element says who passed it. `params` is what a
pass ran under, never who ran it, and is not normalised across backends: `think: true` and `effort:
high` are different facts, and a model with no thinking capability records no `think`. Why a pass ran is
not who ran it either: an adjudication verdict is another verdict, and its position says so.

No verdict is ever overwritten; a re-grade appends beside the verdict it disagrees with. The single
exemption is a repeated pass, so re-running a merge is idempotent: a pass is rater + `gradedAt`
(`passKey` in `extension/grading.mjs`). `params` is not in it — two verdicts on a row always came from
two dispatches and already differ in their stamp.

Every `…At` field is `toISOString()` — UTC, `Z`, milliseconds — `createdAt`, `gradedAt`, `reviewedAt`,
`graftedAt` and `frozenAt` alike; a reader wanting a day slices one, which a local-offset spelling would
break along with string-sort chronology. `gradedAt` is when the pass ran, from the result or the result
file's write time; merge time is a last resort that cannot separate two passes filed in one invocation.
The stamp is all that separates two passes by a hosted rater, which has no `params`, and a document's
`createdAt` stamps the human verdicts captured with it, so its precision separates two `/wa-grade`
sessions in one day.

## A rater is whoever passed a verdict

```jsonc
// raters[] — one row per rater, referenced by index from every verdict
{
  "rater":       0,                 // int      index; a verdict's `rater` is this
  "kind":        "llm",             // enum     "human" | "llm"
  "id":          "…",               // string   human: a UUID. llm: `modelId␟rubric`, joined with US (\x1f)

  // llm only, and DESCRIPTIVE — every one optional, absent when the writer could not resolve it.
  // These answer the groupings the id cannot: same model line, same architecture.
  "modelName":   "gemma4:31b-mlx",  // string   the model LINE; spans digests
  "family":      "gemma4",          // string   architecture
  "quant":       "Q4_K_M",          // string   quantisation
  "modelParams": "25.8B"            // string   parameter count, as the backend reports it
}
```

| `id` component | is | when unavailable |
|---|---|---|
| `modelId` | the backend's manifest digest where it has one, else the invoked name | empty |
| `rubric` | the contract graded under — `scene-relevance@8460b922`, resolvable in `eval/contracts/` | a named pass, or empty |

Name a pass by what is known, never by what is not: a hole named `unknown` folds the next such pass into
the same rater. The corpus holds rater rows named `scene-relevance@fable-inline-1`, graded before any
rubric was a file (G8); the name does not resolve in `eval/contracts/` and must not.

Only Ollama surfaces a digest (`/api/tags`), with `/api/show` giving `details.family`,
`.quantization_level`, `.parameter_size` and `capabilities` — the last is what lets an absent `think`
mean unsupported rather than unrecorded. oMLX's `/v1/models` gives only the repo id's tail, without the
org, and the local models span several publishing accounts (G8); `~/.omlx/models/` is `<org>/<name>`
for anything oMLX downloaded, so the org is resolvable, and nothing reads it yet. Nothing is parsed out
of a name; `config.json` `architectures` is `family` resolved. A hosted model has none of it.

Three facts the block cannot carry:

- US, not a printable separator: every Ollama name carries `:`, an HF repo id `/`, and a rubric `@` (G8).
  `raterKey`/`raterParts` in `extension/grading.mjs` are the only join and split.
- A digest, because a name is not an identity: `bge-m3:latest` is whatever was pulled most recently.
- Weights and contract only; knobs live on the verdict. The same weights under the same rubric sampled
  twice is one rater giving two verdicts.

## One `grades` array, in the order passed

Not one array per kind: a human grading, an llm re-grading under a corrected rubric, then the human
revising is one sequence, and two arrays cannot express it. Provenance is which rater a verdict names. A
verdict names its rater by index — spelled out, the same few strings would repeat tens of thousands of
times (G8) — and `openBundle` resolves it, so readers and writers work in identities and only the file
is indexed. The table is per document, so pooling documents means remapping through each one's table;
the id, not the index, is the identity.

## Reader-side, not in the file

- Which grade is in force. Human outranks judge; within a list, whatever rule the reader states.
- Agreement, drift, and per-rater statistics.
- Availability — whether an entry could have existed at `sceneEnd`.

The rule WA states is `extension/grading.mjs` `gradeValue`, re-exported by `eval/metrics.mjs` so every
reader shares one copy: the latest human verdict if any, else the judges' median once three exist, else
the latest judge. A later judge pass is not a better one (G7).

## Open

- Whether the schema is camelCase throughout. It is now, but `sceneChat` and `waVersion` were arrived at
  separately.
