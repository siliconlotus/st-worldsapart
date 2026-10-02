# Graded bundle schema, v3.1

A bundle holds one or more graded scenes: for each, a moment in a chat, the entries that were candidates for it and every verdict passed on them, with the chat text and the books shared across the document. A reader needs nothing else on disk. `extension/grading.mjs` writes it (`bundleSamples`) and hands a reader one arm of one scene as a flat view (`openBundle`).

## Shape

```jsonc
{
  "schemaVersion": 3.1,
  "captureId": "4f1c2e90-7a63-4d1e-9c02-8b5a1d3e7f44",   // string   the capture's identity; survives a rename
  "name": "apollo-msg1044",                  // string
  "notes": "…",                              // string
  "createdAt": "2026-08-21T09:14:02.118Z",   // string   every …At field is toISOString(): UTC, milliseconds
  "createdBy": "wa-grade",                   // string   the tool that wrote the document
  "bookPriority": [ { "world": "…", "weight": 1, "offset": 0, "cap": 0 } ],
  "gradeScale": 4,                           // int      the top grade
  "embedModel": "bge-m3",                    // string
  "pluginFP": "a6a0ee4d",                    // string   the plugin files as the server loaded them
  "sourceFP": "a6a0ee4d",                    // string   the same files as the page served them
  "budget": { "…": "…" },                    // object?  open; a harness writer's delivery caps and tokenizer

  "scenes": [ {                              // one per graded moment; a single scene is a one-element list
    "id": "Apollo-Splashdown-Test-msg-1044", // string   <chat basename, each run outside [A-Za-z0-9_] as "-">-msg-<sceneEnd>
    "sceneChat": "data/default-user/chats/…/Apollo - Splashdown Test.jsonl",
    "sceneEnd": 1044,                        // int      ST message index of the last message read

    // Gate inputs: the chat's shape at this turn. Each is absent, never empty, when the capture did not record it.
    "assistantCount": 412,                   // int?     non-user, non-hidden messages in the WHOLE chat to here
    "greetingIndex": 0,                      // int?     message 0's swipe_id
    "personaName": "Valentina",              // string?  the active persona
    "macros": { "{{user}}": "Valentina" },   // object?  every macro token the keys carry, as evaluated at this generation
    "chatLength": 1031,                      // int?     core's scan clock: messages to here, hidden ones out
    "firedLatches": { "Apollo_Crew__v22\u001f7": 998 },   // object?  latch key -> the first chatLength it holds at

    "query": "…", "queryChat": [ /* {name, mes, i} */ ],   // here when every arm agrees, else on each cell
    "entries": [ {                           // one row per entry carrying a verdict
      "book": "Apollo_Crew__v22", "uid": 1,
      "title": "262 - Rehearsal in the Vacuum Chamber",
      "grades": [ {                          // every verdict, in the order passed
        "rater": 0,                          // int      index into raters[]
        "grade": 3,                          // int      0..gradeScale
        "gradedAt": "2026-08-19T18:08:01.442Z",
        "why": "…",                          // string?
        "params": { "seed": 42, "temperature": 0, "num_ctx": 32768, "think": true, "effort": "high", "tool": "wa-super-eval" }   // object?  open
      } ]
    } ]
  } ],

  "arms": [ {                                // one per configuration, spanning scenes
    "name": "shipped",
    "waVersion": "1.0.0-alpha.1+build.14",   // string?  manifest.json's version
    "stVersion": "staging@4ed137241",        // string?  <branch>@<commit>
    "params": { "K1": 1.2, "matchWindow": "paragraph", "…": "…" },   // open; captureParams, and `scoredBy` where a fit is named
    "paramSnapshot": { "settings": { "…": "…" }, "derived": { "tokenizer": "…", "maxTokensEffective": 29036, "…": "…" } },   // open
    "scenes": { "Apollo-Splashdown-Test-msg-1044": {      // the cell: this arm's capture of that scene
      "sceneStart": 1035,                    // int      ST message index of the first message read
      "depth": 10,                           // int      messages read
      "primaryBook": "Apollo_Crew__v22",     // string   the book with the most similarity-scored rows
      "book": "data/default-user/worlds/Apollo_Crew__v22.json",   // string   provenance; a reader never opens it
      "index": "data/default-user/vectors/…",                     // string   the vector index the capture read
      "cutoff": { "live": { "maxVectorEntries": 20 }, "gradingOverride": { "maxVectorEntries": 30 } },   // the grading depth
      "gradedCandidates": 20,                // int?     how many rows a grader was shown
      "invalidConfiguration": "wrong-book control: primaryBook set to an unrelated book",   // string?  the reason; absent means valid
      "candidates": [ {                      // in layout order
        "book": "Apollo_Crew__v22", "uid": 1,
        "index": 0,                          // int      position in this array
        "title": "262 - Rehearsal…",
        "block": "dynamic",                  // enum     constant | sticky | promoted | dynamic
        "sticky": 1, "wiOrder": 1001,        // the entry's authored sticky and order
        "tokens": 214,                       // int
        "score": 0.0456,                     // number?  E[credit]
        "weight": 1,                         // number   the term weights' odds multiplier; the layout and the cut read score scaled by it
        "cut": false, "cutBy": null,         // whether the runtime dropped the row, and the cap that blocked it, null when none did
        "scores": { "cosine": 0.1234, "text": 25.12, "keys": 1.4, "properNouns": 12.0, "density": 3.1 }   // open; null where a signal was not measured
      } ]
    } }
  } ],

  "raters": [                                // referenced by index from every verdict
    { "rater": 0, "kind": "llm",             // enum     human | llm
      "id": "637cc0ff…40840\u001fscene-relevance@8460b922",   // llm: modelId and rubric, joined with US
      "modelName": "gemma4:31b-mlx", "family": "gemma4", "quant": "Q4_K_M", "modelParams": "25.8B" },   // llm only, each optional
    { "rater": 1, "kind": "human", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }   // human: a UUID
  ],

  "bookHashes": { "Apollo_Crew__v22": "10bdb8e8…" },      // SHA-256 of each book's entries
  "candidateWhy": { "shipped": { "Apollo-Splashdown-Test-msg-1044": [ [ { "key": "valentina", "excerpt": "…" } ] ] } },   // arm -> scene -> per candidate, by position
  "sceneChats": { "Apollo-Splashdown-Test-msg-1044": [ { "name": "Valentina", "mes": "…" } ] },
  "sceneInjects": { "Apollo-Splashdown-Test-msg-1044": [ { "key": "NOTE", "text": "…", "ambient": false, "depth": 2 } ] },
  "sceneSources": { "Apollo-Splashdown-Test-msg-1044": { "scenario": "…" } },
  "books": { "Apollo_Crew__v22": { "1": { /* the entry, whole */ } } }
}
```

`params`, `paramSnapshot`, `budget`, `scores`, `grades[].params`, `books`, `bookHashes` and the `scene*` maps are open, keyed by whatever the capturing version computed. Every other key is listed above. `raters`, `candidateWhy`, `sceneInjects` and `sceneSources` are absent when they would be empty.

The harness tools add a few keys of their own:

```jsonc
"generatedFrom": { "chat": "…", "book": "…", "attached": [], "msg": 1044, "depth": 10, "model": "…", "records": 2210 },   // document; synth-scenes.mjs
"population": "ranked",                      // document; synth-scenes.mjs
"grading": { "from": "…", "by": "…", "at": "…", "graftedAt": "…", "orphans": [], "…": "…" },   // document; graft-grades.mjs
"frozenAt": "2026-08-21T09:14:02.118Z"       // scene; graded-scene-grid.mjs, when it freezes a query into the scene
```

## Identity

- **An entry is `book` + `uid`, as two fields.** `uid` is unique within a book only, and a lorebook name is a filename that already holds every printable separator (G8), so the two are never joined in the file. Code needing one key joins them in memory with US (`rowKey`).
- **A capture is its `captureId`.** A scene `id` and a `name` both repeat across two captures of one turn under different books.
- **A scene is a moment, not a span.** Two arms reading different depths of one moment share the scene; `sceneStart` and `depth` sit on the cell. `sceneStart` is read off the window, which drops empty and hidden messages, and is never `sceneEnd - depth + 1`.
- **A rater is the weights and the rubric.** An llm's `id` is `modelId` and `rubric` joined with US (`raterKey`, `raterParts`): `modelId` is the backend's manifest digest where it has one, else the invoked name; `rubric` names the contract graded under and resolves in `eval/contracts/`. A component that is not known is left empty, never filled with a placeholder, which would fold every such pass into one rater. The descriptive fields are for grouping by model line and are absent when unresolved.
- **The rater table is per document.** Pooling documents remaps each through its own table; the `id` is the identity, the index is not.

## Verdicts

Every verdict passed is in the file, in the order passed, in one `grades` array across raters and kinds. No verdict is overwritten and no field holds a reduced value; which verdict counts is the reader's question. `gradeValue` (`extension/grading.mjs`, re-exported by `eval/lib/metrics.mjs`) is the one answer WA gives: the latest human verdict, else the median of the llm verdicts once there are three (G7), else the latest llm verdict.

A pass is a rater and a `gradedAt` (`passKey`), so merging the same pass twice changes nothing. `params` records what a pass ran under and is not part of that identity. Each key is named as the invocation named it and none is normalised: `think` and `effort` are different facts, and a model with no thinking capability records no `think`.

An entry with no row in `entries`, or a row with no `grades`, is ungraded. A candidate past `gradedCandidates` was never shown to a grader, so it is ungraded too, not irrelevant.

## Candidates

`candidates` is written in layout order. Every delivery cap is a prefix cut, so a reader replays the budget walk (`delivery.mjs` `applyBudget`) over the array as it stands, charging each row its `tokens`; `index` is what a reordered file fails.

`scores` holds the measured signals under the names the fit uses, so a fit's `features` index into it directly. `score` and `weight` are the arm's own and sit flat on the row.

`block` is the class the runtime put the row in:

| block | in the prompt because | graded |
|---|---|---|
| `constant` | it is always on | no |
| `sticky` | an earlier turn armed the effect | no |
| `promoted` | it activated and the author declared that sufficient (`@@promote`) | yes |
| `dynamic` | it activated and relevance selected it | yes |

`isDurable` is `constant` or `sticky`, and a gradeable row is `!isDurable(row)`. A row whose entry has `sticky` configured and that activated this turn reads `dynamic`: `block` is the runtime state, `sticky` the authored value.

## The haystack

`sceneChats` and `sceneInjects` are the scan's inputs, never a joined window: a reader rebuilds any window from them (`matcher.mjs` `makeWindowFor`), each inject carrying the position and depth that decide which windows admit it. `sceneSources` holds only the card and persona fields some entry's `matchXxx` flag names (`matcher.usedMatchSources`).

`books` holds every attached book whole, since scoring reads the whole book. `bookHashes` says whether two captures hold the same book without reading either.

## Field order

`bookHashes`, `candidateWhy`, `sceneChats`, `sceneInjects`, `sceneSources` and `books` come last, in that order, so every scene, arm and grade is reachable with `head`. A candidate's matched-key excerpts are stored in `candidateWhy` for the same reason, and `openBundle` puts them back on the row as `why`.

## Paths and versions

Every stored path is relative to the ST install (`stRelative`), never absolute. `stInstall().resolve` maps a `data/` prefix through `config.yaml` `dataRoot` and anything else through the root. `eval/lib/scene.mjs` derives its own index when the stored `index` does not exist locally.

`waVersion` is declared, the manifest's version. `stVersion` is resolved, `<branch>@<commit>` from ST's `/version` at capture and `<branch>@<git describe>` offline (`eval/lib/gitversion.mjs`), `+dirty` marking uncommitted changes. Both sit on the arm, since arms are captured at different times. `pluginFP` and `sourceFP` unequal means the server was running other plugin files than the page that captured.
