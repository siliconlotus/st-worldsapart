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

That last clause is the one authors get wrong, because an alternation of possessives READS as a phrase
alternation and is not one. **Measured**, against the default paragraph window:

```
                                        Your husband   Your sister's    …a husband at this point.
                                             Michael   husband Thomas   Your relationship…
? ("your husband" | "my husband")                  1                0                        0
? (your | my) husband                              2                2                        2
```

The second is `(your OR my)` AND `husband`, co-occurring anywhere in the paragraph — a different claim
from the phrase, and true of every line above. **An alternation is only as selective as its loosest
branch**: `Kyle's` is rare, `your` is not, so a group containing both is open on almost every paragraph
and the conjunction collapses to bare `husband`. Two good branches do not save it, and the loose form
scores 2 against the phrase's 1, so it also outranks a genuine phrase match.

The third reading is the one that is **ruled but not built**: `? ((your | my) husband)~3` constrains the
group to a window (*Ruled, unimplemented*, below) and would separate "Your sister's husband Thomas" from
the two sentences apart. Until it lands, `~` is a literal character and such a key is dead — which the
audit reports from evidence, since a key expecting a feature WA lacks never fires.

**Validator checks read structure, not intent.** Every check that guessed at what an author meant
produced false positives on legitimate literals — `"()"` is a real album, `M*A*S*H` is a real title.
The checks that survive are facts about the SmartKey: no terms, no positive term, an unclosed quote,
unbalanced parens, a pattern `new RegExp` refuses — the last asked of a bare `/re/` key too, not only
of a REGEX term inside a `?` expression. A key that expected a feature WA lacks is dead, and
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

**Weight is `::N`, with `^N` as a Lucene alias.** A single colon is ordinary text, so `10:30`,
`Judges 3:16` and `https://…` need no quoting. `^` as a *prefix* is the case-sensitivity flag; as a
*postfix followed by digits* it is the boost.

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

**A count sizes exposure and is never the reason for a call or against one.** Every rule here rests
on one syntax having one reading, and that holds however many keys happen to use it. Worked examples
are demonstrations of a mechanism, not samples.

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
without order, so the slack attaches to something order-free by construction. `"…"~N` is rejected:
quoting is this grammar's one construct that DOES carry order, and it stays unspent for the ordered
loosened phrase it looks like.

- **The unit of completeness is the CONJUNCT, not the leaf.** In `? ((Arthur | Kyle) Porsche)~3` the
  window needs one span from `Porsche` and one from either branch. The sweep takes whichever alternative
  is nearer, so a paragraph yields one tighter witness rather than two of them.
- **N is per junction.** Consecutive spans, sorted by position, each within N words. Decided on intent:
  an author writing a fuzzy phrase claims the steps are short, not that the whole span is compact. The
  corpus cannot adjudicate it, because re-reading plain multi-word keys as groups puts function words
  in the operands, and dropping those takes the key to two terms where the readings are identical.
  Accepted cost: a k-term group can span (k−1)·N.
- **Slack counts words, off `wordChar()`.** A `\b` counter charges a slack point to `o'neill` and
  `mother-in-law`, since the apostrophe and hyphens split one word into two and three. One boundary
  class, or two matchers.
- **Occurrences are CLUSTERS.** Three `copper` and two `pipe` are one fact, not six: leftmost minimal
  windows, each consumed before the next is sought.
- **A negation is a veto over the padded window**, and the window must be fixed before it is tested —
  positives are existential and negatives universal, so one window serves neither (the sweep may always
  shrink to a single positive, which contains no negated term by construction). The rule is the
  positive witness window, padded N words each side, holding no negated operand. Centring on the padded
  cluster and centring on each positive independently are the same region, since the slack bounds every
  internal gap by N. `? (-x)~N` has no positive to anchor and is the existing `negation-only` error.
- **The digits are required.** A bare `~` would make a key depend on a default it does not show, and
  the window it asks for is the whole of what it means.
- **A group without `~` keeps segment scope**, so no existing key changes meaning. Slack cannot be
  retrofitted onto conjunctions that were written precisely because their terms sit apart.
- **NEAR is for content terms.** A key reproducing a title stays a plain phrase, and a function word as
  an operand is the failure mode — but *is this a stopword* is language-dependent, so it belongs to the
  suggester and never to the validator.
- **Where it earns its keep is narrow.** Proper nouns co-occur genuinely, so a slack filters signal
  rather than noise. A polyseme's noise sits at slack 0, which no `~N` can exclude and per-term `=` can.
  The band it serves is terms individually common and jointly specific.
- **Negative slack is overlap, and it is the class proximity cannot fix.** A window covering fewer word
  starts than it has operands means they landed inside one word: `moving in` fires inside the word
  "moving", and a compound written closed matches its spaced spelling (`scrap yard` against
  `scrap-yard`). All are maximally near, so only per-operand whole-word excludes them.

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
a key that visibly matches the text while reporting zero has no spelling that fixes it. Inside a SmartKey this means mixed folding: `? /Cap'n/ crunch` has one
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

**A DOUBLED hyphen is a boundary in both modes**, which strict's class alone does not say. The fold
rewrites an em dash to `--` so `wait--no` matches `wait—no`; strict counts `-` as word-internal so
`Sara-shaped` does not match `Sara`. Their product read an ordinary em dash as inside a word, costing
`Sara— catch` and `Hey—Sara` — punctuation, not a compound, and four of the seven spacings prose uses.
A single hyphen joins a compound; `--` is the ASCII spelling of the dash the fold just rewrote and is
never inside a word. So the assertion is "the neighbour is not a word character, OR it is a doubled
hyphen" — `boundaryBefore`/`boundaryAfter`, still zero-width, because the pattern counts under `g` and
`keyExcerpt` reads its offsets, so consuming the boundary would hide adjacent matches and mis-highlight
the span.

Default **strict**, because the escapes are asymmetric: a regex key with `\b` recovers permissive
behaviour for any ASCII key, and `\b` is what core's own boundary approximates, so one hatch returns
both. From permissive there is no short form. Land in the mode that is cheap to leave. (`\b` fails for
non-ASCII keys, as it does in core.)

Practical reading: **plurals break a match under permissive; plurals and affixes under strict.** The
user-facing wording must name the mode rather than stating either as the rule.

**`_` leaves the class in both modes**, not part of the toggle — underscore is in `\w` for programming
identifiers and `_Joe_` failing has no defender. Presets that instruct underscore emphasis are
reason enough on their own.

**No CJK carve-out.** Whole-word in a script without word separators is an unanswerable request rather
than a WA failure. Such a key still fires among Latin text or punctuation and cannot fire inside a
wholly Chinese or Japanese sentence; `matcher.wholeWordAdvice` says so and the matcher does not guess.
**Tibetan stays out of the trigger class** — the tsheg may be the separator the class is defined by
absence of. Han, Hiragana, Katakana, Thai, Lao, Khmer and Myanmar are the class; Hangul is not, since
modern Korean is spaced.

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
- **A unit's occurrences sum across gate-passing segments and saturate once**, rather than per segment
  or per key; a segment failing its own secondary gate contributes nothing instead of zeroing the entry.
  At `scan` this is arithmetically identical to the unsegmented window, which `matchwindow-check` pins.
- **Match sources and injects are each their own segment** — nothing may merge a character description
  onto the end of chat prose and let a conjunction span the seam. `segment()` is idempotent.
- **Split, do not track positions.** **Measured** 1.01x for 8 segments against one join (200 patterns,
  18KB, n=2000), so `scanAutomaton` keeps its counts-Map return and `plugin/automaton.mjs` never
  changes — no redeploy, and no window where the browser and server halves disagree.
- **The audit segments the same way**, so `unattested` means *not attested in any segment*. df still
  counts ENTRIES, not segments, or "how widely is this term used" would move with paragraph length.
- **Paragraph splits on `\n[ \t]*\n`.** A message written with single newlines only has no paragraph
  to find and degenerates to message-scoped, which is never worse than the mode it fell back from.
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
local view first. **Not safe to widen** — see *Evidence*, where the SOURCE is measured and an empty
gazetteer loses.

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
`usableKeys` is where that holds for a PRIMARY (`secondaryKeys` for a secondary — they differ by
exactly one code, see *Selective logic*) — filtering only the stage-2 verdicts left `? -zebra` scoring a full
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
  is child-only.

### Selective logic (`keysecondary`)

Core's `(key, keysecondary, selectiveLogic)` is answered by ONE expression per primary key:
`synthesizeSecondary` builds the AST, `countSelective` evaluates it, `keywordScore` is the only caller.
One-matcher covers selective logic as much as key matching.

Synthesis builds the AST, not a string, and therefore has no refusals — every one was an artifact of
emitting a `?` string the lexer had to read back. A key containing a double quote needs no escape, a
`?` key splices in as a subtree, and a `/regex/` key is a `REGEX` node. **ST core does permit regex in
`keysecondary`**, which is the class that decided whether the conversion was possible at all.

Entry flags are stamped on synthesised nodes as `isCaseSensitive`/`isExact`; a spliced `?` subtree and
a `REGEX` node carry their own, and so do their weights.

**A secondary is a term and scores like one**, so the same logic scores the same whichever of WA's two
syntaxes wrote it — the disagreement this conversion exists to prevent. `eval/core-matcher-check.mjs`
is the case table.

Only `AND_ANY` and `AND_ALL` see this: a `NOT` yields no unit whatever its operand weighs, so both NOT
logics score the primary alone. A gate that does not score is written `::0` on the secondary — a
condition rather than evidence.

**`keysecondary` is a compatibility surface, and the synthesis is the proof.** Every two-list
configuration converts mechanically to one expression — that is what `synthesizeSecondary` does, for
all four logics — and no converse conversion exists: `? (A AND B) OR (C AND D)` has no arrangement of
two key lists. SmartKeys strictly subsume selective logic, so the field is read because an unaltered
lorebook must behave as it does under core, not because the shape is one WA would otherwise offer.

**What the shape can say is the full cross product under one operator**, n x m implicit pairs treated
alike: three primaries against three secondaries is nine, and it fires on the pairs an author did not
mean as readily as the ones they did. Two lists have no grouping, and grouping is the whole of the
difference — a variation group and a requirement cannot coexist in one list, because one dropdown is
one operator. `SMARTKEYS.md` carries the worked comparison for authors.

**Secondaries are validated like primaries, minus one code.** A key carrying a fatal validator error is
dropped before the logic runs, as blanks are, so a dropped secondary loosens the gate; a key that PARSES
and does not occur is a different thing, and still a verdict the logic sees. `fatalKey` is the shared
predicate, and `usableKeys` and `secondaryKeys` are the two positions that ask it — they differ only in
what they except.

**The one exception is `negation-only`, and the operator decides.** Under `AND_ALL` it narrows:
`astronaut` with `["cosmonaut", "? -gagarin"]` is "both crews, but not Gagarin's territory", which core
has no way to write. Under the NOT logics the operator's own negation cancels the key's, so
`"? -gagarin"` reads as *requiring* gagarin — surprising, but a condition an author can mean, and the
Studio says so at the moment the operator changes. Under `AND_ANY` it is refused: a negation is
satisfied by absence and `AND_ANY` `OR`s its secondaries, so the branch stands open on nearly any text
and the gate stops gating — the objection that makes the key fatal in a primary, one level down.
`secondaryKeys` is the only place that rule lives, and `unusableKeysOf` (`keyword-core.mjs`) reports the
difference rather than re-deriving it.

**A key the matcher refuses is flagged per key, ahead of every other verdict.** `classify` asks
`usableKeys` before anything reads the text: unusability is a fact about the string where the rest of
the audit is evidence about firing, so `/[/` reading as `unattested` — "never matches" — described the
prose rather than the key. Red, but never pre-ticked for removal: every other red flag means the key
fires where it should not and deletion is the fix, while a malformed key means the author wrote
something WA could not read, where the fix is a correction.

**Secondary keys are chips like any other**, click-to-edit, delete and add against `keysecondary`, in
their own row under a rule — two paragraphs of chips run together, and the secondaries read as more
primaries. The operator sits at the head of the row as a CONTROL, not a caption: the same list reads as
"must also contain" or "must not contain" depending on it, so a row whose meaning inverts on a field the
author cannot reach from here is a row they cannot finish editing. Core's four names, since that is what
the WI editor and the CCv2 field call them, with the reading on the tooltip. The collapsed entry's badge
counts the chips, since a key nobody expands to is as invisible as one with no surface at all.

**Only refusal is painted** — a key the matcher will not act on, shown with the validator's reason:
`no-terms`, `stray-quote`, `regex-invalid`, `negation-only`. For a secondary that means absent from
`secondaryKeys`, so it depends on the operator as well as the position. Nothing else is: the rest of the
audit asks whether a key is a good TRIGGER, and a gate is not a trigger, so a common-word secondary is a
legitimate thing to require rather than a flag. The write gate asks `secondaryKeys` rather than the
validator directly — the editor must not refuse what the runtime gates on — and passes the entry's
operator, since which codes are fatal depends on it.

**OFF is the fifth position, and it is `selective`, not a fifth logic.** Core's dropdown has no such
entry, but the state is real: CCv2 specifies it — `secondary_keys` is "ignored if `selective == false`"
— and core reads the flag before `selectiveLogic`, so the list is off under all four operators. It is
the only way to park a gate without deleting the keys that express it. `secondaryKeys` returns `[]` for
such an entry, which is the whole of it; `unusableKeysOf` reports nothing, since the list is off by
declaration rather than malformed; and the Studio dims the chips and labels the row `OFF` rather than
naming an operator that is not running. Switching off leaves `selectiveLogic` alone, so switching back
on restores the author's own operator.

---

## Stage 3: Scoring

`rankActivated`, on `WORLDINFO_SCAN_DONE`. Vector and chunk-text scores are looked up from what
retrieval stored, keyword score is computed over the scan window, and `fuseRanks` produces the
**layout ranking** — vector + text + keys, normalised by the signals an entry was eligible for.

**A key's score is the sum over the things it is about.** `AND` joins distinct things and their scores
add; `OR` names one thing several ways and its mentions pool into one saturation; a weight multiplies
its unit rather than feeding the curve. `SMARTKEYS.md` is the grammar. What matters here is that the
UNIT is the saturation boundary and not the key: saturating a key as a whole would make a stricter
expression outscore its own left operand, and would hand a synonym group a separate budget per
spelling — breadth the author does not have. Weight outside the curve is the other half of the same
rule: the curve is concave, so a weight fed INTO it arrives as less than the author wrote, and by an
amount that moves with the curve — `::2` would land at 1.61x. Outside it, `::2` is 2x whatever the
curve is set to, which is what makes the weight the author's and the saturation WA's.

**A hit reports a count and a score, and they answer different questions.** `count` is how many times
the key's terms appeared, so `x3` in the debug column and the WI panel means the text said it three
times and nothing else. `score` is what the key contributed, and is where weights and saturation live.
One field cannot do both: Σ weighted occurrences reads as repetition while carrying weight and
expression size, so `? fire::3` on one mention is indistinguishable from `fire` on three.

**Presence is categorical; only the repeats saturate.** A matched key is worth its weight, and the
`n-1` repeats accrue as `1 + R x ln(1 + (n-1)/k1)` — `repeatCurveOf`, shipped as `presence-log` with
`R` 1. `bm25K1` is the RATE repeats accrue at and the curve is the SHAPE; one knob could express
neither alone, which is why they are two settings.

**A bounded curve stops discriminating, and that is a property of the curve.** Above roughly n=20 its
entire remaining range is a few percent: `count/(count+k1)` moves 0.041 between n=21 and n=89, and a
bounded presence form moves 0.043 — so two keys with four times the evidence between them score the
same, and the curve has stopped ordering entries by how much the text says. Unbounded, the same pair is
3.872 against 5.309. Whether a given book ever reaches that range is a property of the book; that the
curve goes deaf when it does is not.

**No frequency discount accompanies this, deliberately.** A ubiquitous key is an author declaration —
`keyword-core.mjs` exempts entries carrying one from the too-common flags on that ground — a badly
chosen one is reported by the audit, where the author can act on it, and an entry whose key fires
broadly but whose content does not fit still ranks low on the other two fused signals. A discount here
would be that same judgement taken a second time, silently, where nobody can see it.

**The exemption belongs to `constant` and `promote`, not to `sticky`.** `constant` declares presence
unconditionally and `promote` declares it on activation (*Open work* #3), so a broad key on either is
doing what it was told. `sticky` declares only that an entry PERSISTS once fired — a claim about
duration, not about breadth — and a broad key there latches on the wrong turn and then holds for as
long as the author asked, which is the expensive version of the mistake rather than an intended one.
The two were one thing before `promote` separated them, and the exemption stayed on the half that
kept the name.

So sticky is audited like any other entry: the whole English list rather than the head-of-list cut, and
no book-common reprieve. **Measured** across 43 books: 2 SmartKeys on sticky entries are hidden by the
head cut and 23 book-common flags by the reprieve — small, and both of the SmartKeys are keys their
author had already judged bad by eye. The exemption lands with `promote`, since until then a
declaration has nowhere to live and the main-cast-name-on-a-sticky-sheet pattern would flag with no way
to say it was meant.

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
bounded only by the two cuts below. Designing the cut waits on the layout score (*Open work* #2).
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
provenance. `promote` (*Open work* #3) is the per-entry escape from it.

---

## Divergences from ST core

Every difference between WA's matching and core's, and each is deliberate. Core *defects* are recorded
in `upstream-st.md` in the SillyTavern root, not here; this section carries WA's semantics.

**Some of these ARE a defect being routed around, and those cite its number.** The two documents split by
whose behaviour is described, not by whether WA acts — so an entry can be both a WA semantic and a fix,
and without the citation neither document says which. Reproducing a core defect faithfully in the layer
that now owns activation does not make WA compatible, it makes WA wrong in the same way; parity is owed
to core's intent, not to its bugs.

Divergence is free where WA owns activation and costly where core owns it — while core activates, every
matcher difference makes the Studio's audit report on rules that are not what fires. Once WA activates,
WA's rules *are* what fires.

- **The fold.** `fold` is `normalizeOrthography` then lowercase; core's `#transformString` only
  lowercases. For the default substring path WA is a strict superset.
- **NFC** on the regex path, where core runs raw.
- **Whole-word applies to multi-word keys.** Core splits the key on whitespace and uses `includes()`,
  so *Match Whole Words* is a silent no-op for any key with a space in it — the same shape as
  `upstream-st.md` #1 rather than a considered semantic. The `=` flag was never constrained, being WA syntax
  no unaltered book can contain.
- **Whole-word stops at an affix in core**, so `Joe` matches `Joe's`. WA applies the flag in both
  directions. **The documented contract is preserved exactly**: ST documents one example — `king`
  matches "long live the king" and not "it's not to my liking" — and core, permissive and strict all
  reproduce it. Every divergence lives in territory core never described.
- **The boundary class** (`wordChar()`) against core's `\W`, which diverges both ways. Fixes
  `upstream-st.md` #1 — core's whole-word test is ASCII-only, so an accented or non-Latin key never
  matches as a word.
- **A scanned inject is bounded by the window it was placed in.** Core collects every `scan: true`
  extension prompt and appends the lot outside its depth slice, having dropped the depth at `addInject` —
  so an Author's Note or persona description placed "In-chat @ Depth 100" is matched by a depth-10 scan
  as though it sat in the current turn, and is effectively CONSTANT in the haystack. WA scans an inject
  placed in the chat only when its depth falls inside the window; one with no chat position
  (`IN_PROMPT`, before/after story string) has no depth to test and stays ambient, exactly as core treats
  it. Depth 0 keeps an at-depth inject in every window, which is what "always" already means in that
  buffer. `scanDepth: 0` — "match nothing from chat" — therefore excludes chat-placed injects and keeps
  ambient ones, which is the case that setting exists for. Fixes `upstream-st.md` #16.
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
  so an entry keyed only on SmartKeys never activates there.
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
entry gets p, and ships if it clears the cutoff. The count falls out — a scene with three relevant entries
delivers three — so "how many entries does this scene need" is not a separate question and takes no
parameter of its own.

**The three shipped signals never compare entry CONTENT to the scan WINDOW, and that cell is where a
new signal was found.** Cosine is query against chunk, `text` is query against content, `keys` is the
entry's keys against the window — three readings of one question, which is why they are collinear and
why neither curvature nor interaction adds anything. PROPER-NOUN OVERLAP fills the empty cell: title-case
tokens shared between the entry's content and the window, minus the common-English list. It is not a
reweighting of `text`, because BM25 spreads its mass over every shared term and a character name arrives
diluted among hundreds of ordinary words.

**A NAME IS `ranking.properNounsOf`, which the entity filter already used.** Capitalisation is the
detection signal and it is preserved: `normalizeOrthography` is the fold MINUS its case half, and a token
enters the set only where it appears capitalised somewhere that is not sentence-initial — so a window
saying "apple" the fruit never joins, and cannot match an entry's "Apple". Only the stored key is
lowercased, after detection. **Measured** against the private ASCII regex this feature was found with,
paired over 88 scenes: F2 0.5443 -> 0.5476, 47 scenes up against 17 with 24 tied, p 0.0002, and the
validation fold's AP 0.873 -> 0.883. It is also the reading that removes the second implementation.

**MULTI-TOKEN SPANS LOSE, and they lose REPAIRED.** The first attempt broke runs at lowercase particles
and let sentence-initial capitals start them, so it was rebuilt on the same name detection: particles
join only BETWEEN name tokens and a trailing one is trimmed ("Church of the Sun", "Maren's Gap",
"van der Berg"), `and` is excluded because it joins entities rather than living inside one, and each run
emits its parts as well as itself — a span alone is brittle, since an entry's "Brackenmoor Patrol" would
share nothing with a window's "Brackenmoor". **Measured**: the repair is worth 43 scenes up against 21
(p 0.0081) over the broken version, and the repaired arm still loses to plain unigrams 15 up against 50
(p 0.0000). So a name is a TOKEN, and the phrase is noise on top of it rather than evidence beside it.

Restricting to the GAZETTEER loses too, 15 up against 44 (p 0.0002): the signal is a rare name shared
with what is on screen, not an author-declared one.

**IDF-WEIGHTED, and the weighting is what makes it work.** A shared name is worth `log((N+1)/(df+1))`
with the ENTRY as the document and the primary book as the corpus — the same one-index principle
`content-lexical` rests on — so a protagonist named in every scene summary counts for almost nothing and
a name two entries share counts for a lot. **Measured**, memory tier, held out by book, against the
unweighted count: 45 scenes up against 14 with 9 tied, p 0.0001. Jaccard is WORSE than the count (27 up
against 33) and restricting to the gazetteer loses outright (above), so neither the
normalisation nor the vocabulary restriction is what matters — the term weighting is.

**Measured**, memory tier, held out by book, against the three shipped signals: +0.456 (SE 0.071) and
solo AUC 0.783, second only to text's 0.787 and ahead of cosine's 0.746. On the score of record, over 103
scenes and 5 books: **F2 0.5326 -> 0.5495, paired 42 scenes up against 17 with 38 tied, p 0.0015**, with
AUC 0.8117 -> 0.8216 and AP 0.455 -> 0.463. The first feature change to clear the line rather than
approach it.

**It transfers to a book nothing was fitted on.** A validation corpus was graded for this — 20 scenes on
`System, Status Window…` / `Lit RPG - Fenwood`, 149 rows, 5 memory entries, judge-graded — and entered as
an eighth `--lobo` fold. On it the feature moves AP 0.844 -> 0.873 and AUC 0.8650 -> 0.8858. Per fold, AP
improves in 6 of 7 books; the one that falls holds 59 rows and 5 positives. Fenwood's own scenes are 4 up
against 0 down with 16 tied (p 0.125) — a 5-entry book rarely changes its delivered set at all, so the
per-fold AP is the readable number there and the pooled paired test is what the 20 scenes bought.

**Of the two ENTRY-INTRINSIC columns, `density` earns and `length` costs.** Neither reads the query —
entry length (log tokens) and proper-noun density (names per 100 tokens, `ranking.properNounsOf`) are
priors rather than signals. **Measured** over the full lattice on `properNouns`, `length` and `density`,
memory tier, 103 scenes, held out by book: `length` costs wherever it sits — -0.0041 mean F2 alone,
-0.0027 given `properNouns`, -0.0006 given both, and -0.4 and -1.7 precision points at matched 60% and
70% recall. `density` earns +1.9 and +2.2 points at those same recalls, so it is a better ordering rather
than a looser cut.

**The shipped model is cosine, text, keys, properNouns, density**: AUC 0.8269, AP 0.469, F2 0.5520
delivering 16.0 entries, against 0.8238 / 0.466 / 0.5514 at 17.7 with `length` added back. What `length`
did was correct `properNouns`'s un-normalised COUNT — dropping `text` leaves it at -0.366 while dropping
`properNouns` collapses it to -0.128 (SE 0.049) — and `keys` supplies enough of that correction to make
it cost more than it returns.

**Measure against the RULED variant of a feature, not the harness default.** `--proper-nouns` defaulted
to `count`, which the ruling three sections above rejects at p 0.0001, so a run that passed no flag
measured a variant already discarded. It defaults to `idf` now.

**An entry's own relevance rate in its other scenes adds nothing**, which is what bounds any entry-level
prior: `--with oracle` reads grades the runtime cannot have and still fails, held out by book, raising
AUC while losing the delivered set. A better ordering read at a looser cutoff is not a better chosen set.

**`density` INVERTS ON REFERENCE**, which is the concrete case for *Fit PER TIER*: it runs -0.935
(SE 0.185) there against +0.215 on memory, solo AUC 0.336 — strongly predictive inverted. A reference
entry thick with names is a roster or an index, scaffolding rather than subject, where a memory
scene-summary thick with names is a specific scene. A shared coefficient would carry the wrong SIGN.
Measured before keys were scored, and reference has no fitted model to re-measure it against.

**Story-time position carries nothing.** Fitted as the entry's uid, which within-scene standardisation
makes equivalent to distance from the current point up to sign: adding it to `properNouns` costs
0.0006 AUC and 0.0020 F2, 19 scenes up against 17 with 61 tied (p 0.87). `order` is deliberately not consulted — it is ST's
insertion priority, and a column falling back between the two would mean story position in one book and
priority in the next, which a fit held out BY BOOK cannot survive.

**Polynomial terms measured WORSE, on the tier that could afford them.** Squares of the standardised
signals were fitted on memory (6231 rows, `--degree 2`): held out by book they cost AUC 0.8238 -> 0.8173
and AP 0.466 -> 0.453 while leaving F2 flat at 0.5516 against 0.5514, and gain in-sample — the signature
of terms fitted to the training books. Only `text^2` had individual support (+0.071, SE 0.027) and it loses held
out on its own too (AUC 0.7851, F2 0.493), which is what holding out is for: an in-sample t-statistic is
not evidence a term transfers. `keys` also destabilises beside its own square (+2.244, SE 1.418), the
collinearity a small slope invites. Not retried on reference, where 342 rows cannot support three more
coefficients and the delivered set is already at full recall.

**Two-way INTERACTIONS fail the same way** (`--interactions`, memory): AUC 0.8238 -> 0.8068 held out,
AP 0.466 -> 0.428 and F2 0.5514 -> 0.5409, with `cosine*text` the one nominally supported term (+0.081, SE 0.037) and the two
carrying `keys` pure noise. Curvature and combination were tested separately because they are different
questions, and a tree ensemble that beat this model would have to be exploiting one of them. Neither
exists at this n, which is 7 BOOKS however many rows it is.

**Retried once PROPER existed**, since the argument above — three readings of one question cannot
combine into a fourth — does not cover a pair containing a signal from the empty cell. It does not
survive either: `cosine*properNouns` reads -0.059 (SE 0.063) and `text*properNouns` -0.016 (SE 0.039),
both under one standard error, held-out AUC slips 0.7980 to 0.7973, and paired against it alone it is 14 scenes
up against 12 with 42 TIED. `cosine*text` is the only product ever to reach 2 SE and it has never
improved a held-out number. The model is linear in its features, at four features as at three.

**RELEVANCE IS A PROPERTY OF THE PAIR, never of the entry.** Every feature is query-dependent and every
grade belongs to one scene. **Measured**: of the 594 entries graded in two or more scenes, 89.7% have a
grade that varies and 54.5% cross the relevance line — the same entry, the same book, relevant here and
not there. Anything that caches a verdict per entry is wrong by construction.

**JUDGE THE PREDICTOR BY AP AND PRECISION-AT-RECALL, NOT AUC.** AUC is prevalence-independent, which
makes it the right thing for comparing signals and the wrong thing for asking what clears a cutoff — at
grade >= 4 it reads 0.975 while 90% recall costs 17.5% precision. `logistic.mjs` `prCurve` prints both.
The same distinction as nDCG against the layout score, one level down.

**HOLD OUT A BOOK, NOT A SCENE.** The system meets books it has never seen, and a held-out scene still
shares its book's vocabulary, entry style, chunk statistics and BM25 scale with the rows that fitted the
model. `--lobo` is the honest estimate; `--loso` measures another moment in a book already known.

**The number of record is AP 0.469 at AUC 0.827, held out by book** (`--lobo`, grade >= 3, one intercept,
the shipped five columns). In-sample on the same design it is 0.843, so the model extrapolates: an unseen
book costs it about 2% relative on AUC against an unseen scene.
Per-scene intercepts were tried as a control for differing base rates and measured to buy nothing.

**Fit PER TIER, on which signals the tier carries rather than on base rate.** The tiers do not carry the same signals:
99.8% of memory rows are vectorized and carry cosine and text, while 84% of reference rows are
keyword-only. **And where both carry one, it is not worth the same.** **Measured**, solo AUC per tier:
cosine 0.746 memory against 0.448 reference, text 0.787 against 0.662, keys 0.717 against 0.668. Cosine
is the reading to distrust: reference's is only computed under `denseAllEntries`, so 0.448 is an absence
rather than a failure. Memory's keys once read 0.503 for the same reason — `scoringKeys` blanked a
vectorized entry's keys unless `scoreVectorKeys` was on, it defaulted off, and memory is 99.8%
vectorized, so that number was the AUC
of a constant. On books whose memory entries are all vectorized the column's within-scene SD is exactly
0, and the fit returns +0.000 at SE 1000 rather than a slope.

**Scoring memory's keys gives a real signal and costs a little.** **Measured**, memory tier,
`scoreVectorKeys` on: keys go from within-scene SD 0 and solo AUC 0.500 to 0.7573 and 0.717, fitting at
std beta +0.165 (SE 0.052) in the six-feature model. A third signal exists in that tier; it is redundant,
which follows from an entry's keys being drawn from its own content while `text` scores that content
directly.

**ASK IT AS A FEATURE CONTRAST, not as a parameter sweep.** Turning the setting off does not remove the
column — it leaves a DEGENERATE one on a tier that is all but entirely vectorized, still consuming a
coefficient. `--without keys` drops it, which is the honest counterfactual.
On the current corpus the two coincide exactly: the blanked column is constant in every one of the 103
scenes, so its SD is 0, the fit returns +0.000 at SE 1000, and `scoreVectorKeys=false` reproduces
`--without keys` to the bit on all 97 scored scenes. They stop coinciding at the first scene holding an
unvectorized memory entry whose keys score, where the one row breaking the constant meets a fitted slope.

**Measured** on the shipped design (`relevance-model-memory.json`: cosine, text, keys, properNouns, density),
103 scenes, 6231 rows, 446 relevant, both arms at `scoreVectorKeys=true`, held out by
book. **The score of record is F2 over the delivered set**, and it reads 0.5545 -> 0.5514 with the column
live. AUC is 0.8239 -> 0.8238 and AP 0.464 -> 0.466, but those rank rows rather than choose a set and do
not carry the decision. So the column costs about three F2 thousandths, and it changes nothing at all on
15 of the 97 scenes, which deliver an identical set either way.

**WHETHER A SIGNAL IS IN THE MODEL IS A QUESTION ABOUT THE FEATURE SET, never about a row.** The fit
carries one standardised column per signal and nothing else, so a signal is either fitted for the whole
tier or dropped from it (`--without`). On the memory tier every entry is vectorized and 4 of 496 have no
keys, so nothing varies. On reference, `cosine` is missing on 124 of 135 entries — missing because nobody
computed one, not because the quantity does not exist, since `reindex --all` builds a collection over
every entry with content and `denseAllEntries` scores it. So the reference model is one of two designs:
WITHOUT cosine, on the four remaining columns, or with a cosine COMPUTED FOR ALL OF THEM. Computing one
is not vectorizing the entry — it is a column in the fit, where `vectorized` decides what stage 1
retrieves.

**Per book the sign follows curation.** The column moves Sommers +0.004 and Richard +0.014, the two
curated books, against Time Whore -0.001, Ascensus -0.007 and Panopticon -0.010. Five books is not a rule
and these are AUC deltas in the third decimal, but nothing dominates and the direction is the one key
quality would predict.

**A SMALL FOLD IS NOT A HARMLESS FOLD**, because `--lobo` trains each fold on all the others. At 5 scenes
Richard decided the sign of this contrast for every other book, Sommers moving between +0.0026 and
-0.0032 on its inclusion without one of its own rows changing. At 25 scenes it no longer does: on the
three-signal design the contrast reads the same with Richard in (29 scenes up / 34 down) as with it held
out (27 / 34 over 78 scenes).

**A per-book rule has nothing to key on, so the AUTHOR asserts it.** Selecting the setting off the
curation detector (`eval-data/README.md`) has read 6-for-6 and then signless across corpus revisions, and
wants a book nobody fitted the threshold on. `scoreVectorKeys` is therefore a checkbox in Ranking &
fusion, **defaulting ON**: a key is authored, so the default is to read it, and UNTICKING is the
assertion — that this book's memory keys are machine output nobody reviewed. The corpus argues both ways
and neither loudly: three of its five books are uncurated and the column costs them, but by a third of a
percent, where the two curated ones gain.

**ONE MODEL SERVES BOTH SETTINGS, and it is the keys-live one**, fitted with the column so the checkbox
reaches the prediction — a keys-free fit would leave it with nothing to change. A fit made with keys live
and run with them blanked ranks as well as one refitted for it (AUC 0.8420 against 0.8416) and holds its
operating point (F2 0.5751 at its unchanged cutoff against the refit's 0.5804, delivering 13.0 rather
than 13.5). A blanked column standardises to 0 for every row, so the keys term drops out and the other
five decide, which is what makes the transfer free.

**MOST OF THE MEMORY TIER'S KEYS ARE MACHINE OUTPUT, which every claim above rests on.** **Measured**,
by key provenance: 6136 of the 10,981 memory rows (55.9%) sit on books whose scene-summary keys nobody
reviewed, against 4687 curated. Time Whore alone is 5027 of them and its 208 STMB entries average 21.5
keys where Sommers' average 9.4 — its "mostly curated" label described the reference half. So a claim
about what KEYS are worth on this tier is a claim about generated keys, and the curated counter-sample is
one book. `eval-data/README.md` carries the per-book status and how to recover it from a book alone.

**Nor does the redundancy hide a denoised copy of `text`.** The agreement term is the shape that
hypothesis predicts, and it is one standard error: `text*keys` reads +0.034 (SE 0.035) with the signal
live. PAIRED per scene at each arm's own best cutoff, scoring keys is
-0.0031 mean F2 on 22 scenes up against 60 (*Scoring memory's keys gives a real signal and costs a
little*), which is the redundancy priced rather than a denoised copy appearing.

**AND EACH ARM'S PEAK IS A DIFFERENT OPERATING POINT.** The paired sign test compares two arms where each
sits at ITS own best cutoff, and F2 walks that peak toward precision as a model improves — so a contrast
between peaks mixes "ranks better" with "cut tighter", and reports the second as the first. `--emit`
carries the whole cutoff grid and `pair-f2 --at-recall` reads it, which is how the two are separated.
**Measured**, and it is what split the two entry-intrinsic columns above: `length+density` peaks at 0.08
where `properNouns` alone peaks at 0.13, delivering 17.7 entries against 10.9 — nowhere near the same
operating point. Held at matched recall the pair is worth half a precision point, and `length` on its own
is negative there while `density` is worth two. Any target stated as a recall (*Evidence*) has to be read this way or a feature is credited
where it does nothing.

**A SCENE-LEVEL SIGN TEST OVERSTATES ITS OWN n, so a contrast reports books up against books down.** The
test treats ~100 scenes as independent draws where they sit on 7 books, and within-book correlation is
then counted as evidence — which is why a feature can read p 0.0000 across scenes and have no consistent
direction across corpora. Both numbers are given above where they disagree, and the book count is the one
that decides. With 7 books the test itself is nearly powerless (6-0 reaches only p 0.031), so what carries
a positive result is the AGREEMENT OF MAGNITUDES across books, not the count: `length`+`density` lands
within 0.005 on four independent books, which is the reason it is in the model and `rarity`, `chunkdens`
and `oracle` are not.

**A cutoff-curve peak is not a comparison.** Two arms differ by less than the flatness of their own
curves, so `--cutoff` reports the per-scene F2 vector and the sign test against the first arm. Every
contrast between arms reads that, never the peak — the same rule `param-screen` follows and for the
same reason. A pooled fit reads one slope across two tiers holding different columns, and it is also blind to any
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
cut. The tiers may not want the same cutoff, let alone the same model.

**`cutoff` is the threshold; `cut` is the mechanism; a `bar` is a GRADE boundary.** Three words for three
things, kept apart because the section needs all three in one sentence. The asymmetric bars are where
the metric reads the scale (recall at >= 3, precision at >= 2); the relevance cut is what stage 4 does;
the cutoff is the number on `E[credit]` it does it at. The CLIFF was the removed drop-off on the fused
layout score — relative and ranking-shaped, where a cutoff is absolute and per pair — and the word now
survives only in what is exempt from it.

**RULED: the target is EXPECTED `gradeCredit`, not `P(>=3)`.** `metrics.mjs` `gradeCredit` scores a
delivered 2 at HALF, so the layout score's precision numerator is a sum of credits — and the quantity to
threshold is the one that sum is built from. `E[credit] = 0.5 * P(>=2) + 0.5 * P(>=3)`, both of which the
cumulative fit already produces. It costs no architecture: still one number per entry, still a cutoff. It
also stops the decision resting entirely on the boundary the signals separate worst, and it lets the model
express the middle band the scale defines and the metric already pays for — a 2 is "50/50 on inclusion",
so half credit is the grader's own stated probability rather than a weighting invented here.

**RULED: `E[credit]` decides prompt ORDER too, not just membership.** The dynamic block is ordered by the
same quantity the cutoff reads, rather than by `fuseRanks`. The reason is coherence rather than elegance:
`applyBudget` assumes every cap is a prefix cut, and a set chosen by `E[credit]` but ordered by RRF lets
the budget drop a high-`E[credit]` entry because a different combination of the same three columns ranked
it low. Ordering by the thresholded quantity makes the prefix property true by construction. Constant and
armed-sticky hoisting is unaffected, being about kind rather than relevance. This retires `rrfK`,
`lexicalWeight` and `keywordWeight` for the dynamic block, and costs nothing measured — regression was
already no worse than RRF on nDCG.

**Clamp `P(>=3)` to `P(>=2)`.** The boundaries are fitted separately, so nothing guarantees the nesting
the events have, and `E[credit]` is malformed where it inverts. **Measured**: 39 of 8975 rows invert, by
at most 0.0002 — numerically trivial, so a clamp costs nothing and removes the case entirely. It is not
optional for being small; an incoherent probability pair is a bug that reads as a threshold effect.

**Watch the asymmetry when the cutoff is chosen.** The layout score's two halves read different quantities
on purpose — precision credits a 2 at half, recall counts only grade >= 3, because recall asks whether the
must-deliver material arrived. So `E[credit]` is aligned with the precision half and not with the recall
half, and recall is the half weighted twice. **Measured**, ranking by `E[credit]`: 2s are a steady ~20% of
what it surfaces at every depth (22.0% of the top 5 per scene, 19.4% of the top 20), and those rows pay
into precision and not into recall. That is the target and the score disagreeing at the margin. It is
recorded rather than resolved, because the alternative is a weight between the halves that no measurement
here would choose.

**The gazetteer is worth about two F2 points, and keys are the best source of it.** **Measured**, memory
tier, held out by book, AP: keys 0.397, keys+titles 0.398, titles 0.380, none 0.371, bodies 0.369 — so
bodies are WORSE than having no gazetteer, a source drawn from every entry weighting everything and
therefore nothing. F2 over the delivered set spans 0.495 for keys to 0.471 for none.

**Re-measured** (103 scenes, `properNouns+length+density`, memory tier, held out by book),
and the shape holds while the ordering below the top does not. F2 and the paired sign test against the
shipped `keys+titles`: keys 0.5473 (+0.0063, 29 up against 22 with 52 tied, p 0.401), titles 0.5363
(-0.0046, p 0.001), none 0.5300 (-0.0110, **p 0.017**), bodies 0.5243 (-0.0167, p 0.012). AP:
keys+titles 0.389, keys 0.389, bodies 0.382, titles 0.376, none 0.371. **An empty gazetteer LOSES**, and
needs 30.5 delivered entries to reach what keys reaches with 21.2 — which is what *Stage 3* points here
for. `bodies` and `titles` swapped places between the two passes and disagree between AP and F2, so read
nothing into their order; what replicates is keys at the top and none at the bottom of AP. `keys` against
`keys+titles` is a coin flip in both passes, so the default stands on neither being better. That span is the
ceiling on the whole line of work: the query terms reaching `text` are not what limits it. Keys are the
best source while being useless as a SIGNAL in the same tier, which is not a contradiction — a signal
asks whether an entry's keys fired in the chat, a gazetteer asks what vocabulary the query should weight,
and an entry's keys can name the right entities without ever matching.

**Curation does not explain it.** Split into the curated books (Sommers, Richard, Time Whore; 50 scenes)
and the rest (20 scenes), the gazetteer is worth MORE where keys were never reviewed — AP 0.401 against
0.378 curated, 0.317 against 0.268 uncurated. The uncurated tranche is 4 books with 3 of them tiny, so
read the direction and not the size.

**Two cutoffs, one per tier.** **Measured**, F2 over the delivered set, macro-averaged over scenes, with
`E[credit]` held out by book and `P(>=3)` clamped: memory peaks at 0.14 (F2 0.494, 19.9 delivered against
7.8 relevant), reference at 0.19 (F2 0.806, 6.5 against 2.5). Pooling costs reference its full-recall
region and pulls memory off its own peak.

**The cutoff is a RANGE, not a point.** Both curves are flat around their peak — memory stays within
0.012 of its best across 0.10-0.20, reference within 0.03 across 0.05-0.25 — so a re-tune that moves a
cutoff inside its band is measuring noise, and a reported third decimal is false precision.

**The reference tier tolerates a weak fit, and its cutoff barely matters.** **Measured**: its AUC falls
0.733 to 0.698 held out by book, against memory's 0.790 to 0.786 — 342 rows against 8502 — and it still
reaches F2 0.806 at full recall anywhere below 0.20. Its calibration is unmeasurable at that n (ECE p
0.336 and 0.044 at the two boundaries). None of this is a reason to work on it: recall is already
complete, and the score weights that half twice. **This is not the base-rate argument**, which is
measured wrong above — the tiers' pooled prevalences differ by 5x here and that gap is the grading-depth
artifact, not evidence about activation. What is measured is the delivered set.

**Grade 4 is the band the signals find, and it does NOT travel between books.** Held out by book at
1.29% prevalence: AUC 0.8867, AP 0.324 — a ~25x lift on base rate, but against 0.423 in-sample, and
precision at 75% recall falls from 16.5% to 7.6%. So its strength is substantially book-specific, which
follows from the construct: the anchors reserve 4 for the scene's current SUBJECT, and what counts as a
subject is a property of how a book was written. Treat it as a high-confidence core within a known book,
never as a guarantee on a new one.

**The labels are the ceiling, not the model.** About a third of boundary positives change side between
two passes of the same judge — corroborated by the contract re-grade, where 4 of 13 rows originally >= 3
came back below it (`CLAUDE.md`, graded scenes). The headroom is small and it is not in the fitting.

**Calibration is measured, and an ECE is read against its null.** Everything above reads the ORDERING,
which a monotone rescaling leaves untouched — so a model can rank exactly as measured and be wrong about
every probability it reports, and the cutoff is argued in probability terms. `logistic.mjs` `reliability`
bins by quantile and reports the ECE a perfectly calibrated model of the same size and shape would
score, because binomial scatter alone produces one and it grows as the sample shrinks: the tiers differ
25-fold in rows, so raw ECE compares their sizes as much as their models. Read HELD OUT — a fit with an
intercept forces `mean(p)` to the base rate as one of its score equations, so in-sample calibration is
arithmetic.

**Measured**, held out by book, 8924 rows on 69 scenes: `P(>=3)` is indistinguishable from calibrated in
every population (pooled p=0.248, memory p=0.270, reference p=0.044 at n=342). `P(>=2)` is not — memory
reads ECE 0.0132 against a 0.0072 floor at **p=0.002**, over-confident through the middle of its range.
So `E[credit]` inherits about half that bias and a cutoff drawn on it admits marginally more than it says,
on the boundary the signals already separate worst. The reference tier is unmeasurable at n=342, and its
precision matters less regardless: activation has already removed the entries a relevance model would
reject, which is why the score weights its recall twice.

**Still naming no instrument**, and suspect rather than merely unverified, since the claim beside them
was measured wrong: the 71% p-overlap, the 25%-purity-at-66%-recall cut, and the per-tier recall curve
(reference 95% at 5.4 entries, memory 38 for 73%). Nothing computes an overlap or a purity.

---

## Open work

Ordered by whether a user can see the difference — not by how tidy the fix is, and not by how many
instances the books on disk hold.
1. **Bundle v3 — LANDED.** `bundle-schema.md` carries the shape and the rules that decide it; the writer
   is `bundleSamples`, the reader is `openBundle`, and `gradeValue` resolves the verdict in force out of
   the record rather than reading a stored scalar. The corpus is on it: 107 documents, one schema, no
   compatibility path — the migration was one-shot and is deleted, along with the v1 tool before it.

   `resolve-grades.mjs`, `normalize-grades.mjs` and `split-rater.mjs` went too; all three existed to
   maintain or repair a reduced scalar that no longer exists.

   **Measured** on the way through, each having caught a real defect: the reader's resolution rule
   reproduces all 11,946 stored `llmGrade` scalars; 611 bare grades sit in `/wa-grade` documents and are
   human, while 37 sat in synth documents and were llm verdicts in the wrong field; every one of the 107
   frozen haystacks re-derives from its source chat, so all decompose to messages; and the grids print
   byte-identical numbers either side of the whole change.

   **THE READERS READ THE SCHEMA'S NAMES.** `openBundle` selects a view across the nesting levels and
   translates nothing: `entries`, `params`, `scanChat`, `book`, `index`, `scores`. `entry.world` is ST's
   field, read where an ST entry becomes a WA row and nowhere else.

   What is still open is in `bundle-schema.md`'s own *Open*: `waVersion` has no browser source, `why` is
   bulk sitting ahead of the hoisted blocks, `query`/`queryChat` duplicate per arm, and nothing yet fills
   `modelDigest` or a pass's `params` at capture.

2. **The relevance prediction — stage 4 deciding, per entry, whether it belongs.** This is the whole of
   the open work, not a step after tuning: F2@layout is the score of record, and until a prediction
   exists the delivered set is everything activated, so that score is invariant to every layout
   parameter (measured, *Evidence → Two scores*). The predicted set IS the layout, so scoring it is
   scoring the prediction, and `tierRecall` gets its kept set back at the same moment. The model, its
   evidence and what is still open about it are in *Stage 4 predicts per-entry relevance*.

   THE MODEL IS FITTED AND THE CUTOFF WITH IT. `relevance-model-memory.json` carries seven coefficients
   and the operating point the held-out F2 curve peaks at, so what remains is the CONSUMER: `rankActivated`
   reading the file, standardising each signal within the scene it is scoring as the fit did, and cutting
   the layout at that probability. Reference has neither a fit nor a cutoff, and gets both or neither —
   its own question is whether cosine is a feature there at all.
3. **`promote` — an author declaration that activation is sufficient.** A promoted entry enters the
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
   position at once — and the ST maintainers recommend it for exactly that. A reference entry marked
   `sticky: 1, constant: false` is reaching for the insertion guarantee, not the persistence; promoting
   it keeps that and drops the two it was never asking for.

   **It also takes the too-common exemption over from `sticky`** (`stickySkipCommon`, which becomes
   `promoteSkipCommon`): the audit's reprieve is for an author declaring an entry should be present,
   which is what `promote` says and what `sticky` only used to imply. Until then sticky keeps it, for
   want of anywhere else to put it.

   Stored as `entry.promote`, top-level beside `sticky` and `vectorized` rather than under
   `extensions` — `convertCharacterBook` reads 25 fields OUT of `extensions` and never copies the map,
   so an ST entry has no such key. It is author data rather than WA scratch, so it takes no `wa`
   prefix. It survives loose-JSON import, load and save (`addMissingWorldInfoFields` backfills and
   deletes nothing; `/api/worldinfo/edit` writes verbatim; the Studio mutates the loaded object), and
   is lost only through `convertCharacterBook`, as CCv2 `priority` is (`upstream-st.md` #13).

   No per-book count is worth surfacing: promoted entries are situational, so forty of them is not
   forty constants — activation gates them and most turns fire a handful. The number that means
   something is how many fired on THIS turn, which is a runtime observation.

4. **Recursion scoring** — buffer scoring plus trigger-depth weighting, one change. Ships on reasoning
   rather than evidence (`world_info_recursive` is off here and no book in the corpus exercises it), so
   it waits on a recursion-using book.
5. **Witness spans**, then **proximity** — they share one collector, and the display half lands first
   because it is what tells a proximity key's classes apart.
6. **`probeKeys`** (pure: keys × segments → verdict, count, witnesses), then the **Keyword Lab** tab
   (paste text or pick an entry/chat, see what hits), then wiring the same function into `scanChats` so
   `?` and `/re/` keys finally get chat evidence.
7. **`chat common` as a raising flag** — currently `KEY_CHAT_COMMON` can only confirm another flag. It
   needs the structural exclusion (constant/sticky) decided and the 20% re-read against what survives.
8. **Key-side variant expansion**: hyphen ↔ space, since compounds are written both ways and prose
   picks per term. Quoting suppresses generation.
9. **Orthographic expansion for REGEX keys**, which belongs to that pass and not to the fold — a
   pattern is code, so rewriting `…` to `...` turns a literal into three wildcards. Expansion has no
   equivalent problem because a character class matches exactly one character while an alternation has
   no such limit. **Only 1→1 substitutions are generated**: a one-character swap is local and splices
   into a class as an ordinary member, where in `a--?b` the two hyphens are a hyphen plus a QUANTIFIED
   hyphen, and telling those apart needs a parse a substitution pass does not have. So the generated
   set is the apostrophe family, the double-quote family, en-dash ↔ hyphen, and nbsp ↔ space; em-dash
   and ellipsis are left to the author, being visible in both pattern and prose.

   possessives, 18 are above 90% curly (worst 97.6%), 91 sit between 5% and 95%, and 44 are under 5%.
   The mixed chats are the worse failure, since a key that fires SOMETIMES reads as weak rather than
   broken. Which argues for building it BEFORE the keys exist.
10. **`reportFailure`: retrieval failure is a failure, not a degradation.** The two-severity split rests
   on "keys are still handled". Weaker than it was now that a vectorized entry keeps its keys, but a
   retrieval outage still costs the vector and text signals on every entry it was the only source for.
11. **Suggester i18n, none of it started.** `ZIPF_EN` scores non-English function words as maximally
    rare, so the gate designed to reject common words would propose them; a few are present with
    meaningless values, which is worse than absent. The suggester should detect that its priors do not
    apply and stand down rather than invert. Accent variants belong here too — `Gérard`/`Gerard` is a
    real miss, but whether stripping is safe depends on the language, so it wants a human in the loop.
12. **Group weights, `(...)::N`.** A weight is per unit and a conjunction has one intent, so the author's
   unit is the group — but the grammar has nowhere to put it. `? (copper pipe)::3` tokenizes to
   `(copper AND pipe) AND TERM("::3")`, a required literal no text contains, and the validator passes
   it. **Measured** across 43 books: 1 of 148 SmartKeys carries a per-term weight and it is a
   single-term key, so nothing on disk depends on the current reading and the change is free. Until it
   lands, a bare `::N` or `^N` term is a silently dead key of the same class as `~N` proximity.
---

## Standing caveats

- **`plugin/` changes need `node deploy-plugin.mjs` and an ST restart.** The fold lives in
  `plugin/automaton.mjs`, so orthography and NFC are not live on the server half until then.
- **The check suite is run by exit code.** `eq()` sets `process.exitCode`, so a failed assertion and a
  thrown error are the same signal: `for f in eval/*-check.mjs; do node "$f" || …; done`. Grepping for
  `^FAIL` alone misses thrown errors.
