# Graded bundle schema, v3

A bundle holds **one or more graded scenes**: for each, a span of chat, the entries that were candidates
for it, and every verdict anyone has passed on those entries — plus the chat text and the books, shared
across the whole document. It is self-contained: a reader needs nothing else on disk to interpret it.

**One scene is a one-element `scenes` list.** There is no single-scene shape, so a reader that handles the
list handles everything and a writer never chooses between two layouts.

`schemaVersion: 3`. It succeeds `bundleVersion: 2`; the field was renamed with the bump.

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

`<normalized chat>-msg-<start>-<end>` — `sommers_example-msg-90-100`. Normalized is the chat's basename
without extension, with every run of anything outside `[A-Za-z0-9_]` collapsed to `-`; that is also what
makes the id safe to compose at all, since chat names are filenames.

Composing it means a reader reasons from the id alone, and that it can be checked against the fields it
was built from — a cheap guard against a mis-extracted scene, the same job `depth` does from the other
side. It is the key into `sceneTexts` and the handle anything outside the bundle refers to a scene by.

**Two scenes may share an end and differ in their start.** The window is built backwards from the last
message, so a different depth gives a different span of the same chat — a different scene, with its own
entries and its own grades, not a variant of one scene. The id distinguishes them.

## Shape

```jsonc
{
  "schemaVersion": 3,

  "scenes": [
    {
      // WHERE THE SCENE IS. The chat file and the message range it covers.
      "id": "sommers_example-msg-90-100",
      "sceneChat": "sommers_example.json",
      "sceneStart": 90,
      "sceneEnd": 100,

      // ONE ROW PER CANDIDATE ENTRY, carrying only what is true of the entry and the verdicts on it.
      // Scores are NOT here — they are properties of a configuration, not of the entry (see `arms`).
      "entries": [
        {
          "book": "Sommers_Pack__v22",
          "uid": 1,
          // Duplicated from the entry for triage: reading a bundle by eye is most of what anyone does
          // with one, and a list of uids is unreadable.
          "title": "262 - Finale Prototype Testing at The Grove",

          // EVERY judge verdict, appended in the order taken. `rubric` is not optional — a model name
          // alone cannot say what produced a grade, and the rubric moves the relevant set.
          "llmGrades": [
            { "llmModel": "claude-sonnet-5", "rubric": "scene-relevance@8460b922",
              "grade": 3, "gradeDate": "2026-08-19T18:08:01Z", "why": "…" },
            { "llmModel": "gemma-4-31B-it-MLX-8bit", "rubric": "scene-relevance@8460b922",
              "grade": 2, "gradeDate": "2026-08-20T14:12:25Z", "why": "…" }
          ],

          // EVERY human verdict, same shape, same rule. A human re-grading appends; nothing overwrites.
          // `user` is the ST handle AND the host: almost nobody changes `default-user`, so the handle
          // alone does not identify a rater and two people's verdicts would read as one person's.
          "humanGrades": [
            { "user": "default-user@Hephaestus", "grade": 2, "gradeDate": "2026-07-14T16:11:23Z" },
            { "user": "default-user@ARC-MACBOOK-013", "grade": 3, "gradeDate": "2026-07-31T12:12:11Z" }
          ]
        }
      ],

      // ONE ARM PER CONFIGURATION. Scores live here because they are what a configuration produced;
      // the same entry scores differently under two arms and is exactly as relevant under both.
      "arms": [
        {
          "name": "proper name scoring on/off",
          // WHAT PRODUCED THIS CAPTURE. Not declared versions — a staging checkout's package.json
          // names a release it is not.
          "waVersion": "matcher-and-studio@7cd7496+dirty",
          "stVersion": "staging@4ed137241",
          // `depth` lives here because it is a knob, not a property of the scene. It is redundant with
          // the scene's range on purpose — the range is what was graded, the depth is what produced it,
          // and the two disagreeing means the scene was mis-extracted.
          // `scoredBy` is the fitted model's identity — a knob like any other, and the one thing
          // waVersion/stVersion cannot carry, since the model ships as data rather than as code.
          "params": { "depth": 10, "lexicalWeight": 1, "chunk": "paragraph",
                      "scoredBy": "relevance-model@a1b2c3d4" },
          // IN LAYOUT ORDER — see below. `index` and `tokens` are the fields a reader can count on;
          // `scores` is WHATEVER THE CAPTURE RECORDED, keyed by the feature's own name.
          "candidates": [
            { "book": "Sommers_Pack__v22", "uid": 1, "index": 0, "tokens": 214,
              "scores": { "cosine": 0.1234, "text": 25.1234, "proper": 12, "length": 0.1237 } }
          ]
        }
      ]
    }
  ],

  // THE BULK, LAST AND HOISTED OUT OF THE SCENES. Haystacks by scene id, and the books whole, so entry
  // text resolves without the lorebooks being on disk. Scenes from one chat share both.
  "sceneTexts": { "sommers_example-msg-90-100": "…" },
  "books": { "Sommers_Pack__v22": { /* … */ } }
}
```

## Field order is part of the schema

`sceneTexts` and `books` go LAST, and every writer emits them last. They are almost all of a bundle's
bytes, so anything ahead of them is reachable with `head` — every scene, every param, every grade — and
anything behind them is not.

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

## An entry absent from `entries` is ungraded

`arms[].candidates` is what an arm surfaced; `entries` is what carries verdicts. A candidate with no row
in `entries` simply has not been scored — not an inconsistency, and not something a writer should
manufacture an empty row for.

## Verdict elements

`llmGrades` and `humanGrades` are the same shape but for who is named — `llmModel` + `rubric` against
`user`, which is the ST handle plus the host because `default-user` is near-universal and identifies
nobody. Both carry `grade` and `gradeDate`. `grade` inside an element is unambiguous because the array it
sits in says what kind of rater gave it.

**Why a pass ran is not who ran it.** A tiebreak verdict is a third verdict; if the reason it was taken is
worth recording, it is its own field and never a suffix on the rater's name.

## Reader-side, not in the file

- Which grade is in force. Human outranks judge; within a list, whatever rule the reader states.
- Agreement, drift, and per-rater statistics.
- Availability — whether an entry could have existed at `sceneEnd`.

## Open

- Whether the schema is camelCase throughout. It is now, but `sceneChat` and `waVersion` were arrived at
  separately.
