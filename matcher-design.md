# Matcher and activation — reference

Companion to `keyword-suggest-design.md`, which owns the *suggester*. This owns the *matcher*: how a
key is written, how it is matched, and what WA does at each of the four stages.

Rules only. The arguments that produced them are in the commit messages and the module headers; do not
restate them here. A claim that was measured names its measurement — anything else is an assertion, and
saying so is not optional.

Sections follow the four-stage model (`CLAUDE.md`), because conflating the stages has produced several
wrong conclusions here. Say which stage a claim is about.

---

## Principles

**The haystack is where distinctions die.** A fold applied to the scan text erases a distinction for
every key at once, and no flag can ask for it back. So the fold carries *orthography only* — the same
character in a different encoding, which nobody means anything different by. Anything that can carry
meaning (hyphen vs space, case, accents) belongs on the key side or not at all. Case gets away with
being in the fold only because `^` exists to opt out.

**So a character joins the fold if it is a typographic VARIANT of the ASCII form, and not if it is
FINER-GRAINED than it.** A variant collapses nothing — `“` and `„` are the double quote, differently
typeset. A finer-grained mark imports a distinction its writing system draws and the ASCII form cannot
express, and that loss lands in the haystack where no key can ask for it back. This is the test for
every candidate, not just quotes.

**Fold where the distinction is not one a writer means, and leave it where they might.** Encoding form
is never meant; punctuation sometimes is.

**Correctness that depends on knowing the language belongs in the reviewed layer.** The matcher is
silent, so it must be language-neutral. The suggester is reviewed by a human before anything is
accepted, so it is where a judgement like "is stripping this accent safe" can live. Hyphens pass that
test (a compound is a compound in any language that hyphenates); accents do not (`du`/`dû`).

**Quoting is the single escape.** It suppresses operator, weight, paren and wildcard interpretation and
marks a punctuation-only term as deliberate. One rule to learn, not four. Quoting a single term never
changes what it matches; quoting *across a space* does, turning a conjunction into a phrase.

**Validator checks read structure, not intent.** Every check that guessed at what an author meant
produced false positives on legitimate literals — `"()"` is a real album, `M*A*S*H` is a real title.
The checks that survive are facts about the SmartKey: no terms, no positive term, an unclosed quote,
unbalanced parens, a pattern `new RegExp` refuses. A key that expected a feature WA lacks is dead, and
the audit reports it as dead from the evidence.

**An unaltered lorebook behaves under WA as it does under core.** Least surprise: every divergence is a
named fix for a core defect or a named WA semantic — never an incidental difference. They are
enumerated under *Divergences from ST core*. Authored per-entry intent survives: `scanDepth` still wins
over every global, `scanDepth: 0` still means "match nothing from chat", `@@dont_activate` is never
overridden, `@@activate` is never revoked, and a forced entry still takes core's probability roll.

**The system makes exactly ONE relevance decision, and it makes it at stage 4.** Everything earlier is
either an author's declaration or a mechanical bound, and neither is a judgement WA is entitled to make
on its own. Stages 1 and 2 ADMIT — generously, cheaply, on rules that need no taste; stage 4
arbitrates, once, over the whole heterogeneous set, on the layout ranking that is the only place all
three signals and the real constraint meet.

What this does NOT absorb, because these are not WA's calls: an author's declarations (`constant`,
`delayUntilRecursion`, `preventRecursion`, `excludeRecursion`, `disable`), core's own gates, and the
admission bound itself — a ceiling that stops a pathological scene feeding a recursion pass is a safety
limit, not a verdict on relevance.

**`countKey` is the only matcher.** Anything reporting on how a key will behave — the audit, the
pruner, the Studio's colouring, the evals — calls it rather than re-deriving the rules. Two
implementations drift, and the drift surfaces as an entry that activates and does not score, or the
reverse.

---

## Grammar

A key beginning `?` opts into expression syntax. `SMARTKEYS.md` is the user-facing page and describes
what WORKS — it must not be written ahead of the code, and must not lag behind it either, because
nothing in the suite reads it.

**The sentinel is `?` because a key does not plausibly start with one.** Every other punctuation call
resolves toward the literal — `*` and `~` are text, a single colon is text, `+` is absorbed — and a
leading `?` is the one place that trade is deliberately reversed. Only the FIRST character is the
sentinel, so `what's up?` is a plain key. Accepted cost: a literal key that did start with `?` is read
as a SmartKey, which both changes what it matches and overweights it.

**Measured**, books on disk: 147 of 46,230 keys start with `?`, across 6 books, and all 147 validate
clean — none is an accidental prefix that merely happens to parse.

**Weight is `::N`, with `^N` as a Lucene alias.** A single colon is ordinary text, so `10:30`,
`Judges 3:16` and `https://…` need no quoting. `^` as a *prefix* is the case-sensitivity flag; as a
*postfix followed by digits* it is the boost. **Measured**: 0 keys on disk contain `^` followed by a
digit, and 0 in 367KB of scan text.

**`/pattern/flags` is a TERM.** A `/re/` key is evaluated as a pattern everywhere else it appears, and
the literal reading survived only inside a SmartKey, where the lexer did not know regexes exist. The
literal stays reachable through the escape already there: `? "/re/"`.

- A `/` opens a regex **only at token start**, the rule `"` and `-`/`!`/`+` already follow, so `and/or`
  and `3/4` are untouched and `? -/re/` negates a pattern.
- **Leftmost QUALIFYING close** — ECMA-262's RegularExpressionLiteral scan (`regexLiteral`): `\`
  escapes the next character, `[`…`]` is a class the delimiter cannot close inside, and classes do not
  nest (`/[[]/` is a class holding `[`). A candidate delimiter is accepted only when the body compiles
  and its flag run ends at a token boundary; otherwise the scan continues. **`\/` writes a literal
  slash.**
- **A term reads as the whole key reads.** `/home/user/lux/` is one pattern in both; `/home/user/file`
  is a literal in both. Verified across every form in this section, string for string.
- Accepted cost: an abutting term after a pattern needs a space. `? /[/]/x` is the literal six
  characters; recover with `? /[/]/ x`, or better where adjacency was meant, by extending the pattern
  (`? /\/x/`) — the abutting form only ever gave a conjunction that fired on any slash and any `x`.
- Flags then weight — `[gimsuy]*` after the close, then an optional `::N`. **No `=`/`^` prefix**: `=`
  is meaningless on a pattern and `^` is a no-op, since a regex is already case-sensitive. `/i` is how
  insensitivity is written.
- **No shape, no fault.** `? /re` and `? //` are literal terms, exactly as the bare keys are.
  `regex-invalid` survives for the one case where the shape is well-formed and the pattern will not
  compile. Diagnostics may be richer inside a SmartKey than outside it (`punctuation-term` reaches
  `? //`); no READING may differ.
- A regex is a term for counting and for positivity — `no-terms` counts it and `hasPositiveTerm` treats
  it as a contributor. Checks that inspect a term's VALUE skip it — `punctuation-term` and
  `stray-quote` would fire on every pattern, one being punctuation by nature.

**Measured**, and it cannot adjudicate any of the above: regex keys on disk are 2 of 46,226, in 2 of 41
books; `?` keys containing a `/` at all are 0 of 148. Every rule here rests on one syntax having one
reading. A count sizes exposure and is never the reason for a call or against one. Worked examples
here are demonstrations of a mechanism, not samples.

**A regex key is audited like any other key**, on df, by the same machinery that judges a literal and
a SmartKey. Only the heuristics that read a key AS A LITERAL STRING stay exempt — English-common,
fragment, short — because the matching surface of `/sal(a|e)/` is its pattern and not the characters it
is written with. Without this a pattern has no oversight anywhere: the validator skips value checks on
patterns by design, so `/\n/` firing on every multi-line message drew not one word from any tool.
`registerKeys` skips regex keys, so they miss the Aho-Corasick batching and pay a compile and a scan
per entry — **measured**, 100 regex keys × 300 entries × ~1KB is 9.8 ms when nothing matches and
18.4 ms at 630,000 hits, against a Studio open already costing hundreds. V8 caches a compile by source,
so caching them would recover ~5 ms and is not worth the code.

**Entry flags reach plain keys only. Ruled: a `?` or `/re/` key is self-describing.** `caseSensitive`
and `matchWholeWords` are entry-level defaults for plain keys and do not reach inside a SmartKey or a
pattern. `? nasa` in a `caseSensitive` entry is still insensitive; `? ver` in a `matchWholeWords` entry
still matches `never`, and an author who wanted boundaries would have written `? =ver`.

The reason is expressiveness rather than symmetry: the grammar has `^` and `=` and no inverse of
either, so an entry flag winning over an unflagged term would leave "insensitive here" and "substring
here" unwritable. **Measured** against `countKey`: this is already what fires, since the `?` and `/re/`
branches return before the flag arguments are read.

### Proximity — `(…)~N`

**Ruled, unimplemented.** `? (copper pipe)~5` constrains a group to a window. Parens already group
without order, so the slop attaches to something order-free by construction. `"…"~N` is rejected:
quoting is this grammar's one construct that DOES carry order, and it stays unspent for the ordered
loosened phrase it looks like.

- **The unit of completeness is the CONJUNCT, not the leaf.** In `? ((Arthur | Kyle) Porsche)~3` the
  window needs one span from `Porsche` and one from either branch. **Measured**, Sommers chat: 60
  witnesses against 47 + 16 for the two keys run separately — the sweep takes whichever alternative is
  nearer, so a paragraph yields one tighter witness rather than two.
- **N is per junction.** Consecutive spans, sorted by position, each within N words. Decided on intent:
  an author writing a fuzzy phrase claims the steps are short, not that the whole span is compact. The
  corpus cannot adjudicate it, because re-reading plain multi-word keys as groups puts function words
  in the operands, and dropping those takes the key to two terms where the readings are identical.
  Accepted cost: a k-term group can span (k−1)·N.
- **Slop counts words, off `wordChar()`.** **Measured**, standard corpus: a `\b` counter charges a slop
  point to `teddy o'neill` and `pack-bond pheromone`, since the apostrophe and hyphen split one word in
  two — 2.9pp of two-term co-occurrences at `~0`. One boundary class, or two matchers.
- **Occurrences are CLUSTERS.** Three `copper` and two `pipe` are one fact, not six: leftmost minimal
  windows, each consumed before the next is sought.
- **A negation is a veto over the padded window**, and the window must be fixed before it is tested —
  positives are existential and negatives universal, so one window serves neither (the sweep may always
  shrink to a single positive, which contains no negated term by construction). The rule is the
  positive witness window, padded N words each side, holding no negated operand. Centring on the padded
  cluster and centring on each positive independently are the same region, since the slop bounds every
  internal gap by N. `? (-x)~N` has no positive to anchor and is the existing `negation-only` error.
- **The digits are required.** **Measured**, Sommers chat: `? ((Arthur|Kyle) Porsche)` yields 16
  witnesses at `~3` and 35 at `~10`, so a bare `~` would make a key depend on a default it does not
  show.
- **A group without `~` keeps segment scope**, so no existing key changes meaning. **Measured**, the 26
  conjunction SmartKeys in `Sommers_Pack__v22` against their own chat: 720 firings, of which `~5` keeps
  39% and `~10` 57%. A slop cannot be retrofitted onto conjunctions written because the terms are apart.
- **NEAR is for content terms.** A key reproducing a title stays a plain phrase, and a function word as
  an operand is the failure mode — but *is this a stopword* is language-dependent, so it belongs to the
  suggester and never to the validator.
- **Where it earns its keep is narrow.** Proper nouns co-occur genuinely, so a slop filters signal.
  A polyseme's noise sits at slack 0 where no slop reaches it — **measured**, Sommers: `? Jeffrey
  =watch` fires 48 times against 395 for `? Jeffrey watch`, so `=` is worth 7× the slop. The band is
  terms individually common and jointly specific, where **measured**, standard corpus, `~5` rejects
  21.5% of what a segment-scope conjunction admits.
- **Negative slack is overlap, and it is the class proximity cannot fix.** A window covering fewer word
  starts than it has operands means they landed inside one word. **Measured**, standard corpus: 3.8% of
  two-term co-occurrences, led by `moving in` firing 876 times inside the word "moving", plus the
  compound written closed (`scrap yard` against `scrap-yard`). All are maximally near, so only
  per-operand whole-word excludes them.
- **Rejected — a finer match window in its place.** **Measured**, Sommers conjunction keys: 3% of
  firings have a minimal window spanning a line break, and 138 of the slack-21+ firings sit on a single
  line. A `line` mode would buy 3% and leave every distant-pair case untouched.

Implementation: the trie answers presence and positions are walked. `scanAutomaton` computes each match
start and discards it into a counter, so positions are one push away — but recording them changes
`plugin/` and pays an array per pattern per segment for every plain key that never wants one, to save
an `indexOf` over one paragraph after the candidate filter has already rejected every segment missing
an operand.

---

## Matching

`matcher.mjs` `countKey()` answers every question about whether and how often a key matches.

**A regex term is case-sensitive AND fold-exempt, except for NFC.** `countKey` branches before
`foldedHay`, so a pattern runs on raw text as core's does — fold the haystack and a pattern written
against real text stops working. Normalisation is not that kind of choice, so the segment is
NFC-composed first: two encodings of `é` are the same letter to everyone not implementing Unicode, and
a key that visibly matches the text while reporting zero has no spelling that fixes it. **Measured**: 0
decomposed sequences across 41 books and 196 chats — unexercised here, which is a statement about this
corpus and not about the case. Inside a SmartKey this means mixed folding: `? /Cap'n/ crunch` has one
term that sees `’` and one that does not.

### Match Whole Words

**Ruled: the flag applies wherever "word" is defined, with no carve-outs**, in both directions core
under-applies it (see *Divergences*).

**The boundary class is a setting** (`wordBoundary`, `matcher.setBoundaryMode`/`wordChar`), because
both readings are defensible:

```
permissive  [\p{L}\p{N}\p{M}]         letters, digits, combining marks
strict      [\p{L}\p{N}\p{M}\-'’]     ...plus hyphen and both apostrophes
```

Default **strict**, because the escapes are asymmetric: a regex key with `\b` recovers permissive
behaviour for any ASCII key, and `\b` is what core's own boundary approximates, so one hatch returns
both. From permissive there is no short form. Land in the mode that is cheap to leave. (`\b` fails for
non-ASCII keys, as it does in core.)

Practical reading: **plurals break a match under permissive; plurals and affixes under strict.** The
user-facing wording must name the mode rather than stating either as the rule.

**`_` leaves the class in both modes**, not part of the toggle — underscore is in `\w` for programming
identifiers and `_Joe_` failing has no defender. **Measured**, one author's chats (178.8M chars): 822
emphasis-shaped underscores against 1,156,063 asterisks, so this corpus does not motivate it. Presets
that instruct underscore emphasis do, and corpus absence is not population absence.

**No CJK carve-out.** Whole-word in a script without word separators is an unanswerable request rather
than a WA failure. Such a key still fires among Latin text or punctuation and cannot fire inside a
wholly Chinese or Japanese sentence; `matcher.wholeWordAdvice` says so and the matcher does not guess.
**Tibetan stays out of the trigger class** — the tsheg may be the separator the class is defined by
absence of. Han, Hiragana, Katakana, Thai, Lao, Khmer and Myanmar are the class; Hangul is not, since
modern Korean is spaced.

**Measured cost**, books on disk: 66 of 2,120 enabled entries tick the box AND hold a multi-word key —
430 keys, 10 books; the ST global is off, so the 1,711 entries inheriting it do not move. Under strict,
44% of whole-word keys lose occurrences but saturation absorbs it (`Sara` 113→100 moves
`count/(count+k1)` from 0.9895 to 0.9881); 10 keys of 955 go to zero, all singletons; **no entry stops
activating**. Of the 430, 24 narrow against their own book's text, all the plural case — and book text
is a floor, since chat prose pluralises more.

### The match window

A setting, `matchWindow`: `scan | message | paragraph`, default `paragraph`. It selects **where WA
stops concatenating**, not an evaluator mode — `scanWindow` returns segments and `scan` is the
degenerate one-segment array that reproduces the pre-setting behaviour exactly.

- **Uniform across every matching rule** — SmartKey conjunctions, selective logic, all of it.
  `keysecondary` inherits the scope from the call site (`keywordScore`'s per-segment loop), not from
  which evaluator runs.
- **Both signs scoped.** A negation is a segment-local veto: `? fire -drill` silently killed by a drill
  five messages back is a false negative that never surfaces, where a false positive competes and loses.
- **Primary keys are unaffected at any setting — except an anchored regex.** A single-word key's count
  is slice-invariant and a multi-word key cannot span the `\n` join, but `^` and `$` are SEGMENT-relative.
  `/^Doc/` counts 1 paragraph-scoped and 0 at `scan`; `/^Doc/m` counts 1 either way, and `/m` is the
  setting-independent form authors want.
- **Occurrences sum across gate-passing segments and saturate once**, rather than per segment; a
  segment failing its own secondary gate contributes nothing instead of zeroing the entry. At `scan`
  this is arithmetically identical to the pre-setting code, which is what `matchwindow-check` pins.
- **Match sources and injects are each their own segment** — nothing may merge a character description
  onto the end of chat prose and let a conjunction span the seam. `segment()` is idempotent.
- **Split, do not track positions.** **Measured** 1.01x for 8 segments against one join (200 patterns,
  18KB, n=2000), so `scanAutomaton` keeps its counts-Map return and `plugin/automaton.mjs` never
  changes — no redeploy, and no window where the browser and server halves disagree.
- **The audit segments the same way**, so `unattested` means *not attested in any segment*. df still
  counts ENTRIES, not segments, or "how widely is this term used" would move with paragraph length.
  **Measured** inert on every book on disk: 8 books, 8,970 distinct keys, 0 change df or occurrence
  total.
- **Measured**, one author's chats, n=1 (392 messages, 79 windows, 780KB): message-scoping is near a
  no-op — p90 is 19 paragraphs per message, and 81.6% of scanned text lives in messages of six
  paragraphs or more. Paragraph is unambiguous in 96.2% of messages; the other 3.8% use single newlines
  only and degenerate to message-scoped, which is never worse. Split on `\n[ \t]*\n`.
- **Rejected — utterance-level.** The right unit, since a multi-sentence quote is one utterance, but it
  has no reliable marker: models drop closing quotes, use `—` for dialogue, and write narration
  unmarked. Rejected as unavailable, not as wrong.

### Witness spans

**Ruled, unimplemented.** `keyExcerpts` answers only for a lone `TERM` or `REGEX` and returns null for
every compound key.

- **A key's spans are the leaves that CONTRIBUTED, not a whitelist of node types.** The rule is the one
  `evaluate` already applies to `scoreBoost`: a leaf's spans survive exactly where its weight does. `OR`
  concatenates, a matched `AND` keeps both operands, `XOR` keeps the winner, and a failed `AND` branch
  inside a matched `OR` retracts. So `? (a | b | c) -d` is fully excerptable — a negation has an empty
  extension, which is not the same as barring the spans beside it.
- **Collection rides on `evaluate` rather than mirroring it**: an optional accumulator, absent on the
  hot path, with `AND` and `XOR` recording its length before descending and truncating on failure. A
  second traversal would be a second copy of the survival rules.
- **Below a negation the algebra is existence, not extension.** The collector never descends into a
  `NOT`. Counting a negated term reports how often it almost matched, a quantity the semantics do not
  have, and extracting its spans pays the per-character fold walk for excerpts that are discarded.
- **Counts belong to the result, never to the node.** `astCache` interns a tree by its raw key on a
  module-level scope, so one object serves every segment and every entry sharing that key; a count
  written onto it is last-segment-wins and leaks between entries. Weight is the node's, being a
  property of the key as written.
- **The display takes occurrences and ignores weight.** A witness line answers *how is this key
  reaching the text*, not what it contributed to the ranking. Per-leaf counts come from the leaf's own
  count, not `spans.length`, which is capped for display.
- **Overlapping context windows are one window**, rendered as one excerpt with both spans marked. The
  cluster count then reads as the diagnostic — one line means the terms were adjacent, two means they
  were not — and the only claim being made is a rendering one.
- **An `AND`'s leaf spans are already restricted to segments that fired**, since `keywordScore`
  evaluates per segment and a failed conjunction retracts its leaves there.

---

## Stage 1: Retrieval

`selectAndActivate` (`worldsapart.js`). The plugin scores every chunk by mean-centered cosine,
`fuseRetrieval` orders them into the **retrieval ranking**, and `retrieve` returns all of it.

**Stage 1 is cosine only, and admits everything it scores.** No lexical signal, no entity filter, no
relevance test. The one thing that drops a chunk is `uncenteredGate`, the wrong-book failsafe on RAW
cosine; the one thing that bounds the result is `admitCeiling`. Keys are not in this ranking either.

Everything else that used to gate here was removed against measurement, and `plugin/scoring.mjs`'s header
is the record — read it before proposing any of it back. In short: `scoreThreshold` resolved to a p90
quantile, a top-decile SELECTOR rather than a floor, and sat beside `bm25 > 0`, which admitted 99.9% of
every book's indexed entries and so undid each of its exclusions; removing the threshold outright moved
admission by 6 entries in 10,103 across 70 graded scenes and recovered no relevant entry. BM25 then had
no admission left to serve, `retrievalMode` had no second signal to choose, and the entity filter — which
produces BM25 query terms — had nothing here to spend them on.

**What that concedes.** A strict cosine gate loses 110 of 672 graded-relevant entries (measured, 70
scenes): chunks below the corpus mean in embedding space that carry the query's exact terms, which
mean-centering is what puts there. Stage 1 no longer applies such a gate, so the loss is not live — but
`admitCeiling` overflow is now chosen on cosine alone, which is the same population. The ceiling is 1000
entries and the largest book measured holds 208 vectorized ones. **If a book approaches the ceiling, this
is the decision to revisit first.**

`admitCeiling` (`plugin/scoring.mjs`, beside `poolEntries`) bounds how much a pathological scene may feed
stage 3 rather than judging any entry, and is path-dependent because topK counts a different thing on
each path: the plugin pools to one record per entry before `selectTopK`, so K counts ENTRIES (1000); the
NO-PLUGIN PATH does not pool, so K counts CHUNKS (10000, holding the 9.1-10.3 chunks/entry ratio).
`queryCollections` chooses per path, since the no-plugin path can fire mid-request. It was 100/300 and
that bound *did* bind — below two of seven books here, costing 23 of 672 graded-relevant entries on 20
scenes. **A ceiling that binds on an ordinary scene is a cut, not a limit.**

**The NO-PLUGIN PATH** (ST's own `/api/vector`, taken when the WA plugin is absent or errors) does not
mean-centre and does not pool server-side. It has never had BM25, and since stage 1 no longer does
either, that has stopped being a difference between the paths. Neither path passes a threshold now.

**The gazetteer reads the AUTHORED vocabulary** — see *Stage 2* for why that has to be deliberate rather
than inherited from the scan's blanking. It is a TERM count, not an entry count, and no admission effect
at all since stage 1 admits every candidate it scores; the 74% BM25 inflation the old figure carried was
stage-1 BM25 and is retired with it. It still moves content-lexical's scores at STAGE 3, where the filter
now lives, so `eval/scene.mjs` reproduces production for that reason instead.

---

## Stage 2: Activation

Whether an entry is ranked at all. Three independent routes: WA emits `WORLDINFO_FORCE_ACTIVATE` on the
retrieval winners; keyword matching; `constant`, decorators and sticky persistence. The result is
core's `activated` map.

**Core keeps the gates, the timers, recursion control and prompt assembly. WA replaces exactly one
question: *did a key match*.** On a scan WA intercepts, every keyword-activating entry's keys are
stashed and blanked at `WORLDINFO_ENTRIES_LOADED`, so core's matcher never fires and the
inclusion-group filter runs over WA's verdicts. `feedScanLoop` answers each later pass.

**RULED: if WA is enabled, it owns activation.** There is no half-owned mode, and no setting selects
one — the prune direction that existed to describe the other half is gone with it. WA's matcher runs
BEFORE the inclusion-group filter, which is the ordering the deletion-after-the-fact shape could not
have: core never sees a match WA rejected, so a group picks its winner from WA's verdicts instead of
having its winner deleted afterwards and going empty.

**The emit is BLIND.** WA force-activates every entry whose keys match and lets core's gates refuse
what they refuse — including `delayUntilRecursion`, which WA once skipped for provenance hygiene. Under
the takeover that skip was a silent veto: core's matcher is blanked, so an entry WA declines to emit has
no other route in. Verified in `world-info.js`: both delay-level gates are checked BEFORE the
`getExternallyActivated` branch, so a blind emit is refused on the initial pass rather than overriding
the delay; and `externalActivations` is a static map, read non-destructively and reset only after the
loop, so one emit stands for the whole scan and core re-checks it every pass.

**Core still schedules its own loop under the takeover**, which is what the blind emit depends on.
`successfulNewEntriesForRecursion` is built from `activatedNow`, and the `getExternallyActivated` branch
adds to `activatedNow` — so WA's emits drive recursion scheduling exactly as core's own matches did.

**But "core admits it when its level arrives" is conditional, and often the level never arrives.**
`currentRecursionDelayLevel` is PRESET by shifting the lowest level off `availableRecursionDelayLevels`
before the loop, and the re-arm only fires while that list is non-empty. So a book with ONE distinct
delay level has an empty list from the start, and with `world_info_recursive` off nothing else sets
`RECURSION` — the entry is suppressed on every pass and never activates at all. That is core's
behaviour, not the takeover's, and it was equally true when WA skipped the entry; the blind emit neither
causes it nor rescues it. Recursion is off in this install, so it is the case that actually obtains
here.

**`suppressVectorKeys` is gone too**, and its job with it. It blanked a vectorized entry's keys so a
keyword hit could not activate an entry whose cosine had not earned it — a bypass of ST core, which
matches those keys like any others. Stage 1 now admits every vectorized entry it scores, so retrieval
has already activated them and the suppression decided nothing; what it still decided was the residue,
an entry the wrong-book gate zeroed or one with no chunk in the collection, and there a key hit is the
author's own evidence. It was also a second blanking mechanism running ahead of a more complete one:
the takeover stashes `key` AND `keysecondary`, where the suppress branch stashed only `key` and
destroyed a vectorized entry's secondaries. The stage-3 question survives as `scoreVectorKeys`.

**`scoreVectorKeys` asks about the ENTRY, not about blank keys.** It used to read an empty `key` as
"this is a suppressed vectorized entry", which only worked because the suppress branch fired on every
load including WA's own. WA's force-emitted copies carry live keys, so an empty-key test would score
every retrieved entry and leave the setting inert.

**The gazetteer is built from the AUTHORED vocabulary, deliberately.** Its one call site is
`queryTermWeights` inside `contentTextScores`, at stage 3 with `waOwnsScan` true — and `getSortedEntries`
emits `WORLDINFO_ENTRIES_LOADED`, so the entries it returns have already been blanked by the takeover.
Built from those, "the lorebook's own vocabulary" would mean titles plus whatever core exempts, decided
by when the call happens rather than by anything. `queryTermWeights` therefore restores the stash into a
local view first. Safe to widen: the gazetteer SOURCE is measured flat at n=71 scenes paired, including
an empty gazetteer.

**Dry runs are not an exception to the ruling, they are outside it.** ST skips interceptors for them, so
WA is never offered the scan and core matches with live keys. That is structural, not a mode.

**The seam.** `getExternallyActivated` is checked inside core's scan loop, after `@@dont_activate` and
before constant/sticky/key-matching. Every other gate — disable, triggers, character and tag filters,
delay, cooldown, `delayUntilRecursion`, `excludeRecursion`, decorators — runs *before* it, so
force-activation inherits all of them rather than bypassing them.

**Prohibited: no per-turn fallback to core for matching.** A silent fallback makes match semantics
flicker between two rule sets depending on whether an exception happened, with the audit reporting on
rules that are not what fired. A matcher failure fails visibly (`reportFailure` — stage, consequence in plain terms, the error and
the top stack frame, **once per distinct message per session** so a per-turn toast cannot train the
user to dismiss it) and WA keeps ownership — the realistic trigger is the ST surface, not a key, so handing matching back would hand it
to a path that may be equally broken.

`negation-only` stopped being advisory when SmartKeys began to activate: a key that can fire must not
fire on absence alone.

**Prohibited: `countKey` stays unfiltered.** It answers what an expression does; deciding whether to
ask is the caller's job. A validator error bars a key from SCORING as well as from activating, and
`usableKeys` is where that holds — filtering only the stage-2 verdicts left `? -zebra` scoring a full
hit on every scan where "zebra" is absent. Three ways a key enters a book and only one is guarded (the
Studio's `keyWriteOk`), so the runtime is where it has to hold.

**Constants and `@@activate` entries keep their keys** when the takeover blanks the rest. Core
short-circuits both before its key-matching path, so live keys cannot leak a core keyword activation —
and `filterGroupsByScoring` reads `entry.key` via `getScore`, so blanking them would make a grouped
constant score 0 and lose ties it should win. Sticky winners skip scoring entirely
(`filterGroupsByTimedEffects`), and every keyword-activated entry reaches the filter as WA's own
live-key copy.

**Decorators are read off `entry.decorators`, not `content`.** `getSortedEntries` runs
`parseDecorators` and strips the `@@` lines before WA sees an entry, so a content-scan finds nothing at
runtime. `hasDecorator` prefers the array and falls back to the content walk for raw entries and
fixtures; `eval/activation-check.mjs` pins both shapes.

**Scope: WA-run generations only.** ST skips generation interceptors for its dry runs (PromptManager
token counts, chat load), so those keep core's matcher — correct, since a dry run with no WA union
behind it would assemble a keyless prompt. Quiet generations (Summarize, image prompts, the LLM
expression classifier) are ordinary generations and get the takeover like any other.

### Depth

**Activation depth is WA's setting.** When WA runs, `messageDepth` governs key matching; core's
`world_info_depth` is superseded, not consulted. Stage-3 scoring already resolves depth this way
(per-entry `scanDepth`, then `messageDepth`); this extends the same resolution to activation. The
stakes are highest on a keyword-only book, where the activation window is the book's entire memory
horizon — retrieval cannot recover what the scan missed.

**Min-activations is mirrored by widening, not by re-reading.** Core advances its own scan one message
per min-activation pass (`advanceScan`/`#skew`); WA adds the same offset to its resolved GLOBAL depth
(`activationAdds` `depthSkew`). A per-entry `scanDepth` is authored and never skewed, as in core.
Ruled, not measured — with core's keys blanked this feed is the only thing a min-activation pass can
pull from, so the alternative is that the widening does nothing.

### Recursion

`WORLDINFO_SCAN_DONE` fires after *each* scan loop, not once at the end, and its args carry
`activated.text` — the accumulated recursion buffer. WA evaluates against chat + recursion text and
emits `WORLDINFO_FORCE_ACTIVATE` for anything newly matched.

- **Scan each pass's new content; retain no text.** At `matchWindow: 'scan'` read core's own
  `args.activated.text` — one segment either way, both joined with `\n`, so it is core's exact haystack
  and the cross-pass conjunction cannot diverge. Otherwise segment per entry.
- **Filter `preventRecursion` out first.** `args.new.successful` is the list *before* that filter, and
  core builds the recursion buffer from the list after it, so using it raw restores the propagation the
  flag exists to stop.
- **Inherit `world_info_recursive`.** WA must check it before matching recursion text at all, or it
  activates on content a user who disabled recursion never wanted scanned. The token budget is the
  opposite case and is not inherited — WA supplants it (`worldsapart.js` `onEntriesLoaded`).
- **WA emits blindly and lets core reject; one stamped field settles the loop.** `waMatched`, set on
  first hit and never recomputed. `WorldInfoBuffer.externalActivations` is a static map cleared only at
  scan end (`resetExternalEffects`), so a single emit stands for the whole scan and core re-checks it
  every pass — which is how an entry refused at one delay level is admitted at a later one, with no
  retry logic on WA's side. WA therefore models none of core's gates. The sticky flag is correct
  because the haystack only grows: `addRecurse` appends and `#skew` only widens, so a verdict goes
  false→true and never back.
- **WA does not write `state.next`, because core already schedules every pass WA can feed**: a pass
  with recursion-eligible successes sets RECURSION, open delay levels set RECURSION, min-activations
  sets MIN_ACTIVATIONS — and WA only ever has something new to emit in exactly those cases. The field
  is writable; nothing here needs it.
- **Trigger provenance is not WA's business.** Where an entry was triggered from does not change
  whether it may compete. `delayUntilRecursion` is the author's own and only declaration that an entry
  is child-only. **Measured**, 44 books / 2,699 enabled entries: 26 are `true`, one carries an explicit
  level 1, and nothing anywhere is authored deeper — so this rule admits everything on disk and ships
  unexercised.
- **Third-party books suppress recursion far harder than this author's do**, which sizes the whole
  item. **Measured**: `excludeRecursion` is set on 526 of 579 public-book entries (91%) against 140 of
  2,120 here (6.6%), and the public books set `preventRecursion` and `delayUntilRecursion` on nothing.
  Read that as a bound on how much this can matter, not as permission to skip it.

### Selective logic (`keysecondary`)

Core's `(key, keysecondary, selectiveLogic)` is answered by ONE expression per primary key:
`synthesizeSecondary` builds the AST, `countSelective` evaluates it, `keywordScore` is the only caller.
One-matcher covers selective logic as much as key matching.

Synthesis builds the AST, not a string, and therefore has no refusals — every one was an artifact of
emitting a `?` string the lexer had to read back. A key containing a double quote needs no escape, a
`?` key splices in as a subtree, and a `/regex/` key is a `REGEX` node. **ST core does permit regex in
`keysecondary`**, which is the class that decided whether the conversion was possible at all.

Entry flags are stamped on synthesised nodes as `isCaseSensitive`/`isExact`; a spliced `?` subtree and
a `REGEX` node carry their own. Secondary nodes carry weight 0 (`zeroWeights` reaches into a spliced
subtree, or the author's own `::5` would leak), so the conversion is score-neutral by construction:
`AND` and `OR` both sum. `eval/synthesis-check.mjs` is the case table.

**Measured** population, books on disk: 79 entries of 2,112 enabled (3.7%) across 14 books, 77 of them
`AND_ANY`.

---

## Stage 3: Scoring

`rankActivated`, on `WORLDINFO_SCAN_DONE`. Vector and chunk-text scores are looked up from what
retrieval stored, keyword score is computed over the scan window, and `fuseRanks` produces the
**layout ranking** — vector + text + keys, normalised by the signals an entry was eligible for.

**Two rankings, not one.** `fuseRetrieval` decides what is activated; `fuseRanks` decides prompt order
and what survives the budget. **A change to `fuseRanks` can never surface an entry retrieval did not
return** — so no keyword weight, tilt or fusion change is a recall lever, only a precision one.

**`scoreVectorKeys` is stage 3 and does not reopen stage 2.** Keys re-rank vector entries; they never
admit one — stage 1 already did.

**Open — a recursed entry cannot currently compete.** Stage 3 builds its scan window from chat plus
injects plus opted-in match sources, and never the recursion buffer, so an entry whose key matched
another entry's CONTENT is scored against text where that key does not appear. It scores `keys: 0`,
sorts to the bottom, and the budget drops it first — and the budget binds on every graded scene
measured. **Ruled: stage 3 scores the recursion buffer**, via the existing `matcher.withExtraTexts` on
the same `runState.waRecursionTexts`, so this closes with one call rather than a second code path.
Recursion contents are per-entry strings and become their own segments, the rule match sources and
injects already follow.

**Open — trigger-depth weighting.** An entry reached at the third recursion pass is three removes from
the conversation and should not score as though the conversation had named it. The weight is a
per-entry scalar stamped at first match, NOT a per-segment weight. It needs a pass counter, stamped
where a newly-matched entry joins `waMatched`; **the counter advances on RECURSION passes only**
(`args.state.next === scan_state.MIN_ACTIVATIONS` distinguishes them), because an entry first matched
on a min-activation pass was found in the CHAT, just further back. Depth is a property of the MOMENT,
not of the entry — the same entry can be reached at depth 1 in one scene and depth 3 in another, so
anything averaging it across scenes is averaging two different things.

**The two halves are one change.** Without buffer scoring the weight has nothing to discount; without
the weight, buffer scoring admits a depth-3 entry at full strength on text WA itself injected.

---

## Stage 4: Selection

Two cuts, both here, each answering one question over the same layout ranking.

**THERE IS NO RELEVANCE CUT, so the system makes no relevance decision at all** — a standing exception to
*Principles*, which rules for exactly one and puts it here. The dynamic block reaches the prompt whole,
bounded only by the two cuts below. Designing the cut waits on the layout score (*Open work* #1).
`selection.mjs` `walkOrder` orders the classes and cuts nothing.

**The entry maxes** decide how many, on nested populations: vector ⊆ dynamic ⊆ all, plus the
per-book quota. `maxVectorEntries` is counted off the `vectorized` FLAG, not off retrieval provenance:
the cap exists so at most N vector entries are added to the layout, which is a question about what an
entry is.

**The token budget** decides how much, and is the only one measured in tokens rather than entries. The maxes and the budget both live in `applyBudget`, which walks the ranked layout once, sticky
and constant first so every cap is a prefix cut, returns the survivors, and reports every cap that
rejected a row. `rankActivated` deletes the rest from `activated` — `selection.mjs` is ST-free and the
map is core's.

**The relevance cut arbitrates over the whole dynamic block**, keyword-activated entries included, which
means it can drop one with the budget wide open. That stands against *triggered == relevant*
(*Evidence*) and is recorded rather than resolved: arbitrating once over the whole heterogeneous set is
what *Principles* requires, and carving an exemption for keyword rows would make stage 4 read
provenance. `promote` (*Open work* #2) is the per-entry escape from it.

---

## Divergences from ST core

Every difference between WA's matching and core's, and each is deliberate. Core *defects* are recorded
in `upstream-st.md` in the SillyTavern root, not here; this section carries WA's semantics.

Divergence is free where WA owns activation and costly where core owns it — while core activates, every
matcher difference makes the Studio's audit report on rules that are not what fires. Once WA activates,
WA's rules *are* what fires.

- **The fold.** `fold` is `normalizeOrthography` then lowercase; core's `#transformString` only
  lowercases. For the default substring path WA is a strict superset. **Measured**, one corpus, as an
  upper bound on the remaining seam: 9 keys of the 1,229 containing quote or hyphen characters match
  under WA's fold and not under core's lowercase, unioned over 177,499 usable messages.
- **NFC** on the regex path, where core runs raw.
- **Whole-word applies to multi-word keys.** Core splits the key on whitespace and uses `includes()`,
  so *Match Whole Words* is a silent no-op for any key with a space in it — the same shape as the `\W`
  boundary bug rather than a considered semantic. The `=` flag was never constrained, being WA syntax
  no unaltered book can contain.
- **Whole-word stops at an affix in core**, so `Joe` matches `Joe's`. WA applies the flag in both
  directions. **The documented contract is preserved exactly**: ST documents one example — `king`
  matches "long live the king" and not "it's not to my liking" — and core, permissive and strict all
  reproduce it. Every divergence lives in territory core never described.
- **The boundary class** (`wordChar()`) against core's `\W`, which diverges both ways.
- **A bare `/re/` key.** Core's `parseRegexFromString` refuses a pattern whose delimiter appears
  unescaped inside it and falls back to matching the whole delimited string as literal text;
  `REGEX_KEY_RE` does not refuse it, so `/and/or/` is the pattern `and/or` here and the literal
  `/and/or/` there. WA keeps its reading: core's refusal is an implementation detail rather than a
  meaning. The two readings are not symmetric — core's fires only where the whole DELIMITED string
  occurs, so it CAN hit and "does nothing" would be a verdict about all prose.

  The warning (`regex-core-refuses`) rests on LEAST SURPRISE, not on portability: the principle above
  requires every divergence to be named to the user whose expectations came from core, and that reason
  does not expire. It leads with what WA does, since leading with core's reading framed WA as the
  deviant in three cases out of four, and `\/` is named nowhere in it because escaping serves core and
  nothing else. `SMARTKEYS.md` carries portability separately, as a conditional: write a pattern with
  unescaped slashes and plan to port it to a non-WA system, and you must escape them.

  `coreReadsAsRegex` mirrors core's rule for that warning and counts nothing. It reaches SmartKey TERMS
  as well as bare keys. The mirror direction is closed rather than recorded: `REGEX_KEY_RE` used `.`,
  so a body holding a literal newline was a pattern to core and a literal key to WA — the class widened
  to `[\s\S]` and the two now agree.
- **`?` SmartKeys and `/re/` terms inside them.** Core's `matchKeys` treats `? …` as a literal needle,
  so an entry keyed only on SmartKeys never activates there. **Measured**: 2 such entries of 3,403
  keyed entries on disk. Un-extended cores see the raw string and silently never match it, which is the
  compatibility story that keeps books portable.
- **`messageDepth` supersedes `world_info_depth`** when WA runs (see *Stage 2: Activation*).

---

## Evidence

What a measurement here can and cannot support.

**Corpus counts size a known effect and never dismiss a case.** A permitted input occurs whether or not
this author has written one. The scarcity of a syntax on disk measures core's support and
discoverability — which is what this project is removing — so an author who did not know regex keys
existed has not declined to use them.

**A chat measurement describes the haystack and is admissible where a key count is not**, because the
haystack exists independently of whether anyone has written the key yet.

**Chat-based measurement uses the standard corpus** listed in `eval/eval-data/README.md`, counting
usable messages rather than raw lines. Book-only measurements are not so limited: 40 books are
available, 19 with no chat at all. Say which population a two-part finding rests on; the chat half
cannot be widened by adding books.

**A key existing in a book is not evidence that it is a good key**, and which books are curated is not
derivable from the data — see `eval/eval-data/README.md`. Removals speak to precision, never to recall.

**Tiers are provenance, never routing configuration** (decided in
`eval/eval-data/shared-metrics/FULLBOOK-AUDIT-2026-08-10.md`, enforced in `eval/scene.mjs`
`scoreScene`). An entry is memory iff STMB-marked
(`stmemorybooks`/`STMB_start`), because provenance cannot drift with the configuration under
evaluation, where `vectorized`/`sticky`/`constant` all can. A keyword-activated reference entry is
relevant because its trigger fired — *triggered == relevant* — so the only judgement left is whether
the trigger deserved to fire; a memory entry is relevant because ranking chose it.

**`durable` — constant plus sticky — is a third population that CROSS-CUTS the tiers** (`CLAUDE.md`,
*Four stages*). It says how a row reached the prompt, where the tiers say what kind of thing it is: a
keyword-activated reference entry is not durable and is graded like anything else. Grading reads it off
the CONFIGURED sticky value (`grading.mjs` `isDurable`, `eval/scene.mjs` `isDurableEntry`), because the
question is whether ranking would have chosen the entry and the runtime state cannot answer it — a dry
run arms nothing. Stage 4 reads the ARMED effect instead — `walkOrder` hoists an armed sticky out of the
dynamic block — so a configured sticky entry on the turn it keyword-activates is inside the runtime's
dynamic population and outside the graded one.

**Set metrics on a reference-heavy book are JOINT** and cannot tune routing alone: a reference entry
reaches the prompt because its key fired, so a key miss and a routing miss land in the same recall
number. Split the misses by divergence class (`eval/divergence-audit.mjs`) — key miss (suggester),
window miss (depth/persistence), over-fire (prune) — before reading an F or recall figure on such a
book as a statement about the ranker.

**Graded scenes: pool first, then pair.** `n` is small — human grading is the scarce input — so prefer a
screen to an argmax over a grid: `param-screen.mjs` contrasts one parameter at a time against each
scene's own baseline and reports the sign test. A pool built from one configuration penalises every
configuration far from it, so `/wa-super-grade` unions several population-changing arms and grades the
union once. An arm that surfaces unjudged entries scores them 0 and looks worse than it is, so its Δ is
a lower bound.

### Two scores, because one metric cannot grade two populations

**Ruled, unimplemented.** It separates the gates at stage 1 and stage 4, which one metric currently
conflates.

**The vector score** grades ADMISSION: was the relevant entry returned at all. With no relevance
decision at stage 1 it is a recall diagnostic and a cost measure, not a quality metric — the question it
answers is whether anything downstream could have surfaced the entry, and how much was carried to find
out. Homogeneous by construction — the collection holds only vectorized entries' chunks — so no
exclusion rule is needed.

**The layout score is F2 over the LAYOUT ITSELF** — the set stage 4 delivers, over the dynamic block, on
the asymmetric bars below, beta settled at `RECALL_WEIGHT` 2 (`metrics.mjs`). No window is imposed on it,
because CHOOSING THE SET IS THE THING BEING GRADED. Constants and armed stickies are hoisted to the front
of `ranked` so every cap is a prefix cut, which means they consume budget without competing for it — the
graded population is exactly what a cut can reject. Everything else is in, cards included.

**The budget is the SANITY CHECK, not the window.** A token ceiling is set by cost and is not a property
of the ranking, so a score read at the budget moves with a preference no arm controls. Checking that a
delivered layout fits a real ceiling confirms a result rather than producing one.

**`@R` IS A DIAGNOSTIC, alongside nDCG, and for the same reason.** It scores the top `relevant` rows —
a cardinality the system is not told at runtime and whose choice is precisely what a relevance predictor
is for. So it measures the ORDERING under an oracle count, not the prediction. Its use is as a BOUND: it
is the value F2@layout would take if the system predicted the right number, so no relevance decision over
this ordering can beat it. **In the ideal case the two coincide** — a layout containing all and only the
relevant entries makes `@R` and `@layout` the same set — and the gap between them is the cardinality
error.

**Measured, and it is why stage 4's relevance decision comes before any layout tuning:** with no
relevance cut, F2@layout is EXACTLY invariant to the layout. 5 arms over 4 parameter families (LEXW,
KEYW, K1, gazetteer source), 3 scenes, every per-scene delta 0.0000 — because the delivered set is
everything activated, and no ranking parameter changes set membership. The level is F2 ~0.25: precision
0.064-0.104 with recall 1.000. Read `@R` on the same scenes and arms and it moves, which is the
diagnostic doing its job and not evidence about the set.

**nDCG is a DIAGNOSTIC, not an evaluation score.** It asks whether the ordering puts the good material
at the top. The evaluation score asks whether the system delivers the right set. A reordering inside the
cut moves nDCG and cannot move the set, so the two correlate without being the same measurement, and an
nDCG figure is never evidence that the system works.

It is kept because every cut at stage 4 takes a PREFIX of the layout ranking, so the ordering bounds
what any cut placed on it can achieve — a well-placed cut cannot rescue a badly ordered list. The
diagnostic is what tells a cut that fell in the wrong place from a ranking where no cut position was
good.

**Reference entries are GRADED, on the same 0-4 scale as anything else — not reduced to a boolean.** A
two-valued "does it belong" throws away the only evidence there is about contention, which is precisely
what the layout score reads. The vector score never sees the grades, because a reference entry has no
chunk in the collection; the layout score consumes them fully.

**Relevance is asymmetric, and the two halves take different bars.** Recall at grade >= 3 — did the
must-deliver material arrive. Precision credits a 3 or 4 in full and a 2 at HALF, keeping the 2 in the
denominator (`metrics.mjs` `gradeCredit`): a 2 is "weakly relevant, 50/50 on inclusion", so the grader
declined to call it and the metric must not call it either. Full credit made padding with ambiguous
entries raise the score; dropping 2s from the denominator instead let a configuration shrink what it is
judged on by delivering ambiguity. **Measured**, one scene, contrasting two HARD bars rather than the
shipped half-credit: P@>=3 0.542 against P@>=2 0.708, F1 0.703 against 0.829; the arm ORDERING barely
moves, so comparative findings survive but the absolute level does not. **Measured**, 73 scenes: under the symmetric bar F1 ranked the shallow cuts on top and the
ordering inverted at F4 — under the asymmetric bar depth wins at every beta and the inversion
disappears.

**What this unblocks**: what the relevance cut should BE — the cliff was removed rather than retuned, so
this is now a design question and not a parameter sweep — what `maxVectorEntries` should default to, and
whether reference entries need contention grades. All three are currently unanswerable because nothing
grades stage 4.

**The offline half exists.** `/wa-grade` records the pre-budget population with per-row `tokens`, `cut`
and `cutBy`, plus the tokenizer, so `applyBudget` replays offline at any budget — verified exact
against the runtime's own verdicts on 315 rows across 7 arms.

### Stage 4 predicts per-entry relevance

**Ruled, unimplemented.** Regression was measured to be no worse than RRF + nDCG and was chosen for
explainability. Everything below is measured on 69 graded scenes, 8924 judged rows, three signals
(cosine, text, keys), by `eval/relevance-regress.mjs`.

**LOGISTIC regression**, on the project's own relevance line (grade >= 3). Linear would put predictions
outside [0,1] on a bounded target and would weight a 0-vs-1 error the same as a 0.4-vs-0.5 one. Each
entry gets p, and ships if it clears the bar. The count falls out — a scene with three relevant entries
delivers three — so "how many entries does this scene need" is not a separate question and takes no
parameter of its own.

**RELEVANCE IS A PROPERTY OF THE PAIR, never of the entry.** Every feature is query-dependent and every
grade belongs to one scene. **Measured**: of the 594 entries graded in two or more scenes, 89.7% have a
grade that varies and 54.5% cross the relevance line — the same entry, the same book, relevant here and
not there. Anything that caches a verdict per entry is wrong by construction.

**JUDGE THE PREDICTOR BY AP AND PRECISION-AT-RECALL, NOT AUC.** AUC is prevalence-independent, which
makes it the right thing for comparing signals and the wrong thing for asking what clears a bar — at
grade >= 4 it reads 0.975 while 90% recall costs 17.5% precision. `logistic.mjs` `prCurve` prints both.
The same distinction as nDCG against the layout score, one level down.

**HOLD OUT A BOOK, NOT A SCENE.** The system meets books it has never seen, and a held-out scene still
shares its book's vocabulary, entry style, chunk statistics and BM25 scale with the rows that fitted the
model. `--lobo` is the honest estimate; `--loso` measures another moment in a book already known.

**The number of record is AP 0.423 at AUC 0.810, held out by book** (`--lobo`, grade >= 3, one intercept).
In-sample on the same design it is 0.438, so the model extrapolates: an unseen book costs 2% relative
against an unseen scene. Held out, precision is 37.4% at half the relevant rows and 10.3% at 90% of them.
Per-scene intercepts were tried as a control for differing base rates and measured to buy nothing.

**Fit PER TIER, on eligibility rather than on base rate.** The tiers do not carry the same signals:
99.8% of memory rows are vectorized and carry cosine and text, while 84% of reference rows are
keyword-only. A pooled fit reads one slope across two eligibility regimes, and it is also blind to any
change confined to the smaller one — computing a cosine for every reference entry (`denseAllEntries`)
moves that tier's AUC from 0.7387 to 0.7851 and its log-loss from 0.5539 to 0.5163, while the memory tier
and the pooled model do not move at all. Reference cosine then carries the tier's largest slope
(+0.806 standardised, against text's +0.419), where without it the tier runs on keys.

**The base-rate argument for the split does NOT hold, and was measured wrong.** Pooled over all judged
rows the tiers look 3.7x apart, but base rate correlates -0.63 with how deep a capture was graded, and
memory is admitted wholesale while reference only enters when a key fires — so a pooled comparison puts
memory's whole distribution against reference's head. **Measured at matched rank** (top-K of each
scene's own ranking, no scene dropped): the tiers are indistinguishable at the head, 38.4% against 37.7%
at K=10, and the gap grows monotonically with K. Filtering scenes by pool depth instead of matching rank
reproduces the artifact AND selects the rater — a `judged >= 50` cut drops 39% of every human grade in
the corpus while keeping 8536 of 8546 judge rows.

**The scale is ordinal in the signals, and the line we threshold is its weakest boundary.** Mean
standardised signal rises monotonically across grades, so the levels are not decoration — but 2 and 3
sit together and cosine INVERTS across them (+0.748 against +0.694). Fitted at every boundary
(`--ordinal`, `logistic.mjs` `cumulativeFit`), cosine runs +0.682, +0.625, **+0.468**, +0.901 across
>= 1, 2, 3, 4: the operational cut is drawn through the flattest part of the scale. **Proportional odds
does not hold** — that non-constancy is what a shared slope would average away, which is why the
boundaries are fitted separately.

**And the flat spot is memory's.** In the reference tier cosine strengthens monotonically across the
boundaries (+0.123, +0.588, +1.397) and the >= 3 line is real; in memory it collapses at exactly that
cut. The tiers may not want the same bar, let alone the same model.

**RULED: the target is EXPECTED `gradeCredit`, not `P(>=3)`.** `metrics.mjs` `gradeCredit` scores a
delivered 2 at HALF, so the layout score's precision numerator is a sum of credits — and the quantity to
threshold is the one that sum is built from. `E[credit] = 0.5 * P(>=2) + 0.5 * P(>=3)`, both of which the
cumulative fit already produces. It costs no architecture: still one number per entry, still a bar. It
also stops the decision resting entirely on the boundary the signals separate worst, and it lets the model
express the middle band the scale defines and the metric already pays for — a 2 is "50/50 on inclusion",
so half credit is the grader's own stated probability rather than a weighting invented here.

**Clamp `P(>=3)` to `P(>=2)`.** The boundaries are fitted separately, so nothing guarantees the nesting
the events have, and `E[credit]` is malformed where it inverts. **Measured**: 39 of 8975 rows invert, by
at most 0.0002 — numerically trivial, so a clamp costs nothing and removes the case entirely. It is not
optional for being small; an incoherent probability pair is a bug that reads as a threshold effect.

**Watch the asymmetry when the bar is chosen.** The layout score's two halves read different quantities
on purpose — precision credits a 2 at half, recall counts only grade >= 3, because recall asks whether the
must-deliver material arrived. So `E[credit]` is aligned with the precision half and not with the recall
half, and recall is the half weighted twice. **Measured**, ranking by `E[credit]`: 2s are a steady ~20% of
what it surfaces at every depth (22.0% of the top 5 per scene, 19.4% of the top 20), and those rows pay
into precision and not into recall. That is the target and the score disagreeing at the margin. It is
recorded rather than resolved, because the alternative is a weight between the halves that no measurement
here would choose.

**Grade 4 is the band the signals find, and it does NOT travel between books.** Held out by book at
1.29% prevalence: AUC 0.8867, AP 0.324 — a ~25x lift on base rate, but against 0.423 in-sample, and
precision at 75% recall falls from 16.5% to 7.6%. So its strength is substantially book-specific, which
follows from the construct: the anchors reserve 4 for the scene's current SUBJECT, and what counts as a
subject is a property of how a book was written. Treat it as a high-confidence core within a known book,
never as a guarantee on a new one.

**The labels are the ceiling, not the model.** About a third of boundary positives change side between
two passes of the same judge — corroborated by the contract re-grade, where 4 of 13 rows originally >= 3
came back below it (`CLAUDE.md`, graded scenes). The headroom is small and it is not in the fitting.

**Still naming no instrument**, and now suspect rather than merely unverified, since the claim beside
them was measured wrong: the 71% p-overlap, the 25%-purity-at-66%-recall cut, ECE 0.0067, and the
per-tier recall curve (reference 95% at 5.4 entries, memory 38 for 73%). Nothing computes an overlap, a
purity or a calibration error. **The calibration readout is work the predictor has to bring with it** —
the bar is argued in probability terms and nothing currently checks that the probabilities mean what
they say.

---

## Open work

Ordered by whether a user can see the difference — not by how tidy the fix is, and not by how many
instances the books on disk hold.

1. **The relevance prediction — stage 4 deciding, per entry, whether it belongs.** This is the whole of
   the open work, not a step after tuning: F2@layout is the score of record, and until a prediction
   exists the delivered set is everything activated, so that score is invariant to every layout
   parameter (measured, *Evidence → Two scores*). The predicted set IS the layout, so scoring it is
   scoring the prediction, and `tierRecall` gets its kept set back at the same moment. The model, its
   evidence and what is still open about it are in *Stage 4 predicts per-entry relevance*; three things
   have to be decided in the building rather than after it — where the bar goes, the calibration readout
   that lets it be argued in probability terms, and whether the per-tier split earns two bars as well as
   two fits.
2. **`promote` — an author declaration that activation is sufficient.** A promoted entry enters the
   layout whenever its keys fire, exempt from the relevance cut. It is the per-entry form of *triggered
   == relevant*, which stage 4 broke by having the cliff arbitrate keyword-activated entries alongside
   retrieved ones. The fused score still orders it within its block; it no longer gates inclusion.

   It ships with the relevance cut, having nothing to be exempt from until then. The walk becomes
   `[constant, fired-sticky, promoted, dynamic]`, which `walkOrder` gains as one more array; the cut must
   exempt those rows as it exempts constants, and the harness must too, or it cuts what the runtime
   keeps. The RANKING metrics still rank them: how a haystack should be sorted is a question about the
   entries, and only `constant` is outside that population.

   **Exempt from relevance, not capacity.** The per-book cap applies, which is what stops one book
   flooding a turn. `maxDynamic` does not — that cap bounds relevance-selected material, and charging
   author-declared entries against it would make promoting things silently eat retrieval, the failure
   `applyBudget` already refuses for `ignoreBudget` rows. `maxVectorEntries` cannot apply: it reads the
   `vectorized` flag and a promoted keyword entry does not carry it. Only `ignoreBudget` exempts from
   the budget itself.

   **It replaces sticky-as-priority.** ST fills sticky entries first, making sticky the only reliable
   way to guarantee a keyword entry is inserted, so it carries persistence, cliff exemption and queue
   position at once — and the ST maintainers recommend it for exactly that. **Measured**: 34 of
   `Sommers_Pack__v22`'s 45 live reference entries are `sticky: 1, constant: false`. Promoting them
   keeps the exemption the author wanted and drops the rest.

   Stored as `entry.promote`, top-level beside `sticky` and `vectorized` rather than under
   `extensions` — `convertCharacterBook` reads 25 fields OUT of `extensions` and never copies the map,
   so an ST entry has no such key. It is author data rather than WA scratch, so it takes no `wa`
   prefix. It survives loose-JSON import, load and save (`addMissingWorldInfoFields` backfills and
   deletes nothing; `/api/worldinfo/edit` writes verbatim; the Studio mutates the loaded object), and
   is lost only through `convertCharacterBook`, as CCv2 `priority` is (`upstream-st.md` #13).

   No per-book count is worth surfacing: promoted entries are situational, so forty of them is not
   forty constants — activation gates them and most turns fire a handful. The number that means
   something is how many fired on THIS turn, which is a runtime observation.

3. **Recursion scoring** — buffer scoring plus trigger-depth weighting, one change. Ships on reasoning
   rather than evidence (`world_info_recursive` is off here and no book in the corpus exercises it), so
   it waits on a recursion-using book.
4. **Witness spans**, then **proximity** — they share one collector, and the display half lands first
   because it is what tells a proximity key's classes apart.
5. **`probeKeys`** (pure: keys × segments → verdict, count, witnesses), then the **Keyword Lab** tab
   (paste text or pick an entry/chat, see what hits), then wiring the same function into `scanChats` so
   `?` and `/re/` keys finally get chat evidence.
6. **`chat common` as a raising flag** — currently `KEY_CHAT_COMMON` can only confirm another flag. It
   needs the structural exclusion (constant/sticky) decided and the 20% re-read against what survives.
7. **Key-side variant expansion**: hyphen ↔ space, since compounds are written both ways and prose
   picks per term. Quoting suppresses generation.
8. **Orthographic expansion for REGEX keys**, which belongs to that pass and not to the fold — a
   pattern is code, so rewriting `…` to `...` turns a literal into three wildcards. Expansion has no
   equivalent problem because a character class matches exactly one character while an alternation has
   no such limit. **Only 1→1 substitutions are generated**: a one-character swap is local and splices
   into a class as an ordinary member, where in `a--?b` the two hyphens are a hyphen plus a QUANTIFIED
   hyphen, and telling those apart needs a parse a substitution pass does not have. So the generated
   set is the apostrophe family, the double-quote family, en-dash ↔ hyphen, and nbsp ↔ space; em-dash
   and ellipsis are left to the author, being visible in both pattern and prose.

   **Measured**, one author's 196 chats (1.28G chars, 3.28M possessives): 10.6% use a curly apostrophe
   overall, but the share belongs to whoever wrote the chat — of 144 chats with at least 200
   possessives, 18 are above 90% curly (worst 97.6%), 91 sit between 5% and 95%, and 44 are under 5%.
   The mixed chats are the worse failure, since a key that fires SOMETIMES reads as weak rather than
   broken. Which argues for building it BEFORE the keys exist.
9. **A grading row's key count is a SCORE wearing a count's name.** `keywordScore` pushes
   `hits.count = scoreBoost`, so `? fire::3` displays `3` for a single occurrence and the row reads as
   "fired three times". Independent of the witness-span work and fixable on its own.
10. **`reportFailure`: retrieval failure is a failure, not a degradation.** The two-severity split rests
   on "keys are still handled". Weaker than it was now that a vectorized entry keeps its keys, but a
   retrieval outage still costs the vector and text signals on every entry it was the only source for.
11. **Suggester i18n, none of it started.** `ZIPF_EN` scores non-English function words as maximally
    rare, so the gate designed to reject common words would propose them; a few are present with
    meaningless values, which is worse than absent. The suggester should detect that its priors do not
    apply and stand down rather than invert. Accent variants belong here too — `Gérard`/`Gerard` is a
    real miss, but whether stripping is safe depends on the language, so it wants a human in the loop.

---

## Standing caveats

- **`plugin/` changes need `node deploy-plugin.mjs` and an ST restart.** The fold lives in
  `plugin/automaton.mjs`, so orthography and NFC are not live on the server half until then.
- **The check suite is run by exit code.** `eq()` sets `process.exitCode`, so a failed assertion and a
  thrown error are the same signal: `for f in eval/*-check.mjs; do node "$f" || …; done`. Grepping for
  `^FAIL` alone misses thrown errors.
