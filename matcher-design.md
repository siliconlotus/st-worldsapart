# Matcher and activation — reference

Companion to `keyword-suggest-design.md`, which owns the *suggester*. This owns the *matcher*: how a
key is written, how it is matched, and what WA does at each stage.

Rules only. A measured claim cites its register entry — `eval/eval-data/measured-claims.md`, by ID —
and anything else is an assertion. The four-stage model is `CLAUDE.md`'s (*Four stages, and the two
rankings*) and is not restated here; say which stage a claim is about.

---

## Principles

**The haystack is where distinctions die.** A fold applied to the scan text erases a distinction for
every key at once, and no flag can ask for it back. So the fold carries orthography only: a character
joins it if it is a typographic variant of the ASCII form, and not if it is finer-grained than it.
Encoding form is never meant; punctuation sometimes is. Case is in the fold only because `^` exists
to opt out.

**Correctness that depends on knowing the language belongs in the reviewed layer.** The matcher is
silent, so it is language-neutral; the suggester is reviewed before anything is accepted, so a
judgement like "is stripping this accent safe" lives there. Hyphens pass that test (a compound is a
compound in any language that hyphenates); accents do not (`du`/`dû`).

**Quoting is the single escape.** It suppresses operator, weight, paren and wildcard interpretation and
marks a punctuation-only term as deliberate. Quoting a single term never changes what it matches;
quoting *across a space* does, turning a conjunction into a phrase — an alternation of possessives
reads as a phrase alternation and is not one, and the loose form outscores the quoted one even on the
genuine phrase match (K1).

**An alternation is only as selective as its loosest branch.** A group holding one common term is open
on almost every paragraph, and the conjunction collapses to its other operand.

**A key expecting a feature WA lacks is dead, and the audit reports it as dead from the evidence.**
Until proximity lands, `~` is a literal character.

**Validator checks read structure, not intent.** Every check that guessed at what an author meant
produced false positives on legitimate literals (`"()"` is an album, `M*A*S*H` a title). What survives
is fact about the SmartKey: no terms, no positive term, an unclosed quote, unbalanced parens, a pattern
`new RegExp` refuses — the last asked of a bare `/re/` key too.

**An unaltered lorebook behaves under WA as it does under core.** Every divergence is a named fix for a
core defect or a named WA semantic, enumerated under *Divergences from ST core*. Authored per-entry
intent survives: `scanDepth` wins over every global, `scanDepth: 0` means "match nothing from chat",
`@@dont_activate` is never overridden, `@@activate` is never revoked, and a forced entry still takes
core's probability roll.

**The system makes exactly one relevance decision, and it makes it at stage 4.** Stages 1 and 2 admit
on rules that need no taste; stage 4 arbitrates once, over the whole heterogeneous set, on the layout
order. Not absorbed, because they are not WA's calls: an author's declarations (`constant`,
`delayUntilRecursion`, `preventRecursion`, `excludeRecursion`, `disable`), core's own gates, and the
admission ceiling, which is a safety limit rather than a verdict.

**`countKey` is the only matcher.** Anything reporting on how a key will behave — the audit, the
pruner, the Studio's colouring, the evals — calls it rather than re-deriving the rules.

---

## Grammar

A key beginning `?` opts into expression syntax. `SMARTKEYS.md` is the user-facing page and describes
what works; it must not run ahead of the code or lag it, because nothing in the suite reads it.

**The sentinel is `?`**, because a key does not plausibly start with one. Every other punctuation call
resolves toward the literal — `*` and `~` are text, a single colon is text, `+` is absorbed. Only the
first character is the sentinel, so `what's up?` is a plain key. Accepted cost: a literal key that did
start with `?` is read as a SmartKey.

**Weight is `::N`, with `^N` as a Lucene alias.** A single colon is ordinary text, so `10:30`,
`Judges 3:16` and `https://…` need no quoting. `^` as a prefix is the case-sensitivity flag; as a
postfix followed by digits it is the boost.

**`/pattern/flags` is a term.** A `/re/` key is a pattern wherever it appears; the literal is reachable
as `? "/re/"`.

- A `/` opens a regex only at token start, as `"` and `-`/`!`/`+` do, so `and/or` and `3/4` are
  untouched and `? -/re/` negates a pattern.
- Leftmost qualifying close — ECMA-262's RegularExpressionLiteral scan (`regexLiteral`): `\` escapes
  the next character, `[`…`]` is a class the delimiter cannot close inside, and classes do not nest.
  A candidate delimiter is accepted only when the body compiles and its flag run ends at a token
  boundary. `\/` writes a literal slash.
- A term reads as the whole key reads: `/home/user/lux/` is one pattern in both, `/home/user/file` a
  literal in both.
- Accepted cost: an abutting term after a pattern needs a space. `? /[/]/x` is six literal characters;
  write `? /[/]/ x`, or extend the pattern where adjacency was meant.
- Flags then weight: `[gimsuy]*` after the close, then an optional `::N`. No `=`/`^` prefix — `=` is
  meaningless on a pattern and `^` a no-op; `/i` is how insensitivity is written.
- No shape, no fault: `? /re` and `? //` are literal terms, as the bare keys are. `regex-invalid` is
  for a well-formed shape whose pattern will not compile. Diagnostics may be richer inside a SmartKey
  than outside it; no reading may differ.
- A regex is a term for counting and for positivity; checks that inspect a term's value
  (`punctuation-term`, `stray-quote`) skip it.

**A count sizes exposure and is never the reason for a call or against one.** Every rule here rests on
one syntax having one reading, however many keys use it.

**A regex key is audited like any other key**, on df. Only the heuristics that read a key as a literal
string — English-common, fragment, short — stay exempt, since the matching surface of `/sal(a|e)/` is
its pattern. `registerKeys` skips regex keys, so they miss the Aho-Corasick batching and pay a compile
and a scan per entry — cheap even at heavy load, and V8 caches the compile, so there is no compile
cache (K2).

**Entry flags reach plain keys only; a `?` or `/re/` key is self-describing.** `caseSensitive` and
`matchWholeWords` do not reach inside a SmartKey or a pattern: `? nasa` in a `caseSensitive` entry is
still insensitive, and `? ver` in a `matchWholeWords` entry still matches `never` (`? =ver` for the
boundary). The grammar has `^` and `=` and no inverse of either, so an entry flag winning would leave
"insensitive here" unwritable. This is already what `countKey` fires (K3).

### Proximity — `(…)~N`

**Ruled, unimplemented.** `? (copper pipe)~5` constrains a group to a window. Parens group without
order, so the slack attaches to something order-free by construction; `"…"~N` is rejected, quoting
being the one construct that carries order.

- The unit of completeness is the conjunct, not the leaf: in `? ((Arthur | Kyle) Porsche)~3` the
  window needs one span from `Porsche` and one from either branch, and the sweep takes the nearer.
- N is per junction: consecutive spans, sorted by position, each within N words. Accepted cost: a
  k-term group can span (k−1)·N.
- Slack counts words, off `wordChar()` — one boundary class, or two matchers.
- Occurrences are clusters: leftmost minimal windows, each consumed before the next is sought.
- A negation is a veto over the padded window: the positive witness window, padded N words each side,
  holds no negated operand. `? (-x)~N` has no positive to anchor and is the existing `negation-only`
  error.
- The digits are required; a bare `~` would depend on a default the key does not show.
- A group without `~` keeps segment scope, so no existing key changes meaning.
- NEAR is for content terms; whether an operand is a stopword is language-dependent and belongs to the
  suggester, never the validator.
- Where it earns its keep is narrow: terms individually common and jointly specific. A polyseme's noise
  sits at slack 0, which per-term `=` excludes and no `~N` can.
- Negative slack is overlap, and proximity cannot fix it: `moving in` fires inside "moving" and
  `scrap yard` matches `scrap-yard`; only per-operand whole-word excludes them.

Implementation: the trie answers presence and positions are walked with `indexOf` after the candidate
filter, rather than recorded in `scanAutomaton`, which would change `plugin/` and pay an array per
pattern per segment for every plain key that never wants one.

---

## Matching

`matcher.mjs` `countKey()` answers every question about whether and how often a key matches.

**A regex term is case-sensitive and fold-exempt, except for NFC.** `countKey` branches before
`foldedHay`, so a pattern runs on raw text as core's does; the segment is NFC-composed first, since two
encodings of `é` are one letter. Inside a SmartKey folding is mixed: `? /Cap'n/ crunch` has one term
that sees `’` and one that does not.

### Match Whole Words

**The flag applies wherever "word" is defined, with no carve-outs**, in both directions core
under-applies it (*Divergences from ST core*).

**The boundary class is a setting** (`wordBoundary`, `matcher.setBoundaryMode`/`wordChar`), because
both readings are defensible:

```
permissive  [\p{L}\p{N}\p{M}]         letters, digits, combining marks
strict      [\p{L}\p{N}\p{M}\-'’]     ...plus hyphen and both apostrophes
```

**A doubled hyphen is a boundary in both modes.** The fold rewrites an em dash to `--`, and strict
counts `-` as word-internal so `Sara-shaped` does not match `Sara`; without this rule their product read
an em dash as inside a word, costing most of the dash spacings prose uses (K4). The assertion is "the
neighbour is not a word character, or it is a doubled hyphen" — `boundaryBefore`/`boundaryAfter`,
zero-width, because the pattern counts under `g` and `keyExcerpts` reads its offsets.

**Default strict**, because the escapes are asymmetric: a regex key with `\b` recovers permissive
behaviour for any ASCII key, and from permissive there is no short form. (`\b` fails for non-ASCII
keys, as it does in core.) Plurals break a match under permissive; plurals and affixes under strict.
User-facing wording must name the mode rather than stating either as the rule.

**`_` leaves the class in both modes**: underscore is in `\w` for identifiers, and presets instruct
underscore emphasis.

**No CJK carve-out.** Whole-word in a script without word separators is an unanswerable request: such
a key still fires among Latin text or punctuation and cannot fire inside a wholly Chinese or Japanese
sentence; `matcher.wholeWordAdvice` says so and the matcher does not guess. The trigger class is Han,
Hiragana, Katakana, Thai, Lao, Khmer and Myanmar. Hangul is out, modern Korean being spaced; Tibetan is
out, the tsheg being a separator.

### The match window

A setting, `matchWindow`: `scan | message | paragraph`, default `paragraph`. It selects where WA stops
concatenating, not an evaluator mode: `scanWindow` returns segments and `scan` is the one-segment array.

- Uniform across every matching rule — SmartKey conjunctions, selective logic, all of it.
  `keysecondary` inherits the scope from `keywordScore`'s per-segment loop.
- **A block element's open or close ends a paragraph**, as a blank line does. `BLOCK_TAGS` lists them; inline
  elements and `br` do not. The cut is zero-width, so the tag stays in the text and a key can still match it.
- Both signs scoped: a negation is a segment-local veto.
- Primary keys are unaffected at any setting except an anchored regex: `^` and `$` are
  segment-relative, and `/m` is the setting-independent form.
- A unit's occurrences sum across gate-passing segments and saturate once; a segment failing its own
  secondary gate contributes nothing instead of zeroing the entry. At `scan` this is arithmetically
  identical to the unsegmented window, which `matchwindow-check` pins.
- Match sources and injects are each their own segment, so a conjunction cannot span the seam.
  `segment()` is idempotent.
- Split, do not track positions — it costs essentially nothing over one join (K5), so `scanAutomaton`
  keeps its counts-Map return and `extension/automaton.mjs` never changes.
- The audit segments the same way, so `unattested` means not attested in any segment. df still counts
  entries, not segments.
- Paragraph splits on `\n[ \t]*\n`; a message with single newlines only degenerates to
  message-scoped.
- Utterance-level is rejected as unavailable, not as wrong: models drop closing quotes, use `—` for
  dialogue, and write narration unmarked.

### Dropped chat elements

A setting, `dropChatTags`: tag names, comma-separated, empty by default. Each named element is removed
with its content from every message before WA reads it — `matcher.mjs` `dropTags`, once at intake in
`selectAndActivate`.

- A list, not a rule: a state block and a rendered letter are both elements carrying prose, so the tag
  name is the only evidence and only the author has it. Empty means off.
- Tag and content: stripping markup alone leaves the tracker's text in the haystack.
- One strip, at intake, so the embedded query and the keys see the same messages.
- Off is core's behaviour; on is a deliberate divergence. Nothing about what ST sends the model
  changes.
- A capture freezes the stripped text; `intercept` still stashes the raw chat, so the core-comparison
  baseline is untouched.
- An unclosed tag runs to its parent's close, or to the end of the text. Presets write these blocks
  unclosed (K6), and reading one as "removes nothing" makes the setting a no-op on the block it exists
  for.
- The parent is found by balance, not by parsing: scanning forward, the first close with no matching
  open inside the span ends the element. A stray close tag is left alone; same-tag nesting is tracked.
- Not the Studio's chat-rate scan, which counts key hits across whole chat files through the plugin
  route: `countChatHits` runs there, on the deployed matcher, so a chat is read where it lives and only
  the counts cross the wire. It falls back to the browser when the plugin is absent, or when the scan
  includes the open chat, which is not on disk.

### Witness spans

Where a key landed. `keyExcerpts` answers for a compound key as well as a lone `TERM` or `REGEX`;
`keySpans` returns offsets instead of excerpts; `keyHits` returns the per-window report.

- Spans are the AST's leaves, walked directly, **not** `evaluate`'s units: those are gated on the verdict,
  so a key that failed would report nothing.
- **A negated leaf is reported**, with `negated` set. At count 0 it carries no offsets — that is the
  reading for a negative that can never fire.
- **A negated leaf's count is over the whole text**, not per window: it only fires in the windows the key
  failed in, which are the windows the key's own branches are not reported from.
- **A window with no positive branch is skipped**, whatever its negatives count.
- Counts are occurrences, not weight. `keyHits` gives one excerpt per branch per window, except for a key
  that is a single positive branch, which gives every occurrence.
- `mergeSpans` folds overlapping spans to one at the first one's extent, listing the rest in `keys`; a
  caller producing spans in several passes merges the union once, not per pass.
- Offsets index the NFC form of the text.

**Unimplemented:** proximity (`(…)~N`), which these spans would display, and merging two overlapping
context windows into one excerpt carrying both.

---

## Stage 1: Retrieval

`selectAndActivate` (`worldsapart.js`). `CLAUDE.md` carries the stage — cosine only, everything
admitted, `admitCeiling` the only bound, the no-plugin path — and `plugin/scoring.mjs`'s header is the
record of what was removed and why; read it before proposing any of it back.

**What admitting everything concedes.** A strict cosine gate would lose a real share of
graded-relevant entries — chunks below the corpus mean that carry the query's exact terms (R2). No such
gate is live, but `admitCeiling` overflow is chosen on cosine alone, which is the same population; no
measured book comes near the ceiling (R4). If a book approaches it, this is the decision to revisit
first. A ceiling that binds on an ordinary scene is a cut, not a limit (R3).

**`admitCeiling` is path-dependent** because K counts a different thing on each path: the plugin pools
to one record per entry before `selectTopK`, so K counts entries (1000); the no-plugin path does not
pool, so K counts chunks (10000, sized to the chunks-per-entry ratio (R5)). `queryCollections` chooses
per path, since the no-plugin path can fire mid-request.

**Neither side of the comparison is summarized.** The query is the raw recent messages and an entry
is its whole content. Summarizing the query costs a little and summarizing the entries costs a lot, in
the ordering as well as the delivered set, and shortening every entry also decalibrates the fit by
raising BM25 and `density` against a fit trained on full entries (R11).

**The gazetteer reads the authored vocabulary** (*Stage 2*). It is a term count with no admission
effect; it moves `content-lexical`'s scores at stage 3, which is why `eval/scene.mjs` reproduces it.

---

## Stage 2: Activation

Whether an entry is ranked at all. Three independent routes: WA emits `WORLDINFO_FORCE_ACTIVATE` on
the retrieval winners; keyword matching; `constant`, decorators and sticky persistence. The result is
core's `activated` map.

**Core keeps the gates, the timers, recursion control and prompt assembly. WA replaces exactly one
question: *did a key match*.** On a scan WA intercepts, every keyword-activating entry's keys are
stashed and blanked at `WORLDINFO_ENTRIES_LOADED`, so core's matcher never fires and the
inclusion-group filter runs over WA's verdicts; `feedScanLoop` answers each later pass. If WA is
enabled, it owns activation — there is no half-owned mode and no setting selects one.

**The emit is blind.** WA force-activates every entry whose keys match and lets core's gates refuse
what they refuse, `delayUntilRecursion` included: core's matcher is blanked, so an entry WA declines to
emit has no other route in. Read from `world-info.js`: both delay-level gates are checked before the
`getExternallyActivated` branch; `externalActivations` is a static map, read non-destructively and
reset only after the loop, so one emit stands for the whole scan and core re-checks it every pass; and
`successfulNewEntriesForRecursion` is built from `activatedNow`, which that branch adds to, so WA's
emits drive core's own recursion scheduling. "Core admits it when its level arrives" is conditional:
the re-arm fires only while `availableRecursionDelayLevels` is non-empty, so a book with one distinct
delay level and `world_info_recursive` off never activates the entry at all — core's behaviour, which
the blind emit neither causes nor rescues.

**`scoreVectorKeys` asks about the entry, not about blank keys.** WA's force-emitted copies carry live
keys, so an empty-key test would score every retrieved entry and leave the setting inert.

**The gazetteer is built from the authored vocabulary, deliberately.** Its one call site is
`queryTermWeights` inside `contentTextScores`, at stage 3 with `waOwnsScan` true — after the takeover
has blanked the keys — so it restores the stash into a local view first. The source is measured
(*Evidence*, F33).

**Dry runs are outside the ruling.** ST skips generation interceptors for them (PromptManager token
counts, chat load), so core matches with live keys — correct, since a dry run with no WA union behind
it would assemble a keyless prompt. Quiet generations (Summarize, image prompts, the expression
classifier) are ordinary generations and get the takeover.

**The seam.** `getExternallyActivated` is checked inside core's scan loop, after `@@dont_activate` and
before constant/sticky/key-matching. Every other gate — disable, triggers, character and tag filters,
delay, cooldown, `delayUntilRecursion`, `excludeRecursion`, decorators — runs before it, so
force-activation inherits them rather than bypassing them.

**A retrieval outage is a failure, not a degradation.** It costs every entry its cosine, so stage 4 scores
on the cosine-free fit, and no vectorized entry is force-activated — an entry with no keys is absent from
the prompt rather than ranked lower. `retrieve` clears `lastQuery` on entry as well as setting it: the
no-query-text return sits above the assignment, so a turn with nothing to query on would leave the
previous turn's standing for `contentTextScores` to score against.

**Prohibited: no per-turn fallback to core for matching.** A silent fallback makes match semantics
flicker between two rule sets, with the audit reporting on rules that are not what fired. A matcher
failure fails visibly (`reportFailure` — stage, consequence in plain terms, the error and the top stack
frame, once per distinct message per session) and WA keeps ownership.

**`negation-only` is fatal**: a key that can fire must not fire on absence alone.

**Prohibited: `countKey` stays unfiltered.** It answers what an expression does; deciding whether to
ask is the caller's job. A validator error bars a key from scoring as well as from activating —
`usableKeys` for a primary, `secondaryKeys` for a secondary, differing by exactly one code (*Selective
logic*). Three ways a key enters a book and only the Studio's `keyWriteOk` guards one, so the runtime
is where it holds.

**Constants and `@@activate` entries keep their keys** when the takeover blanks the rest. Core
short-circuits both before its key-matching path, and `filterGroupsByScoring` reads `entry.key` via
`getScore`, so blanking them would make a grouped constant score 0. Sticky winners skip scoring
(`filterGroupsByTimedEffects`), and every keyword-activated entry reaches the filter as WA's own
live-key copy.

**Decorators are read off `entry.decorators`, not `content`.** `getSortedEntries` strips the `@@`
lines before WA sees an entry. `hasDecorator` prefers the array and falls back to the content walk for
raw entries and fixtures; `eval/activation-check.mjs` pins both.

### Depth

**Activation depth is WA's setting.** When WA runs, `messageDepth` governs key matching and core's
`world_info_depth` is not consulted — per-entry `scanDepth`, then `messageDepth`, as stage 3 already
resolves it.

**Min-activations is mirrored by widening, not by re-reading.** Core advances its own scan one message
per pass (`advanceScan`/`#skew`); WA adds the same offset to its resolved global depth
(`activationAdds` `depthSkew`). A per-entry `scanDepth` is authored and never skewed, as in core.
Ruled, not measured.

### Recursion

`WORLDINFO_SCAN_DONE` fires after *each* scan loop and carries `activated.text`, the accumulated
recursion buffer. WA evaluates against chat plus recursion text and emits for anything newly matched.

- Scan each pass's new content; retain no text. At `matchWindow: 'scan'` read core's own
  `args.activated.text`, which is core's exact haystack; otherwise segment per entry.
- Filter `preventRecursion` out first: `args.new.successful` is the list *before* that filter.
- Inherit `world_info_recursive`; WA checks it before matching recursion text at all. The token budget
  is the opposite case and is not inherited — WA supplants it (`worldsapart.js` `onEntriesLoaded`).
- One stamped field settles the loop: `waMatched`, set on first hit and never recomputed. Correct
  because the haystack only grows — `addRecurse` appends and `#skew` only widens.
- WA does not write `state.next`: core already schedules every pass WA can feed.
- Trigger provenance is not WA's business. `delayUntilRecursion` is the author's own and only
  declaration that an entry is child-only.

### Selective logic (`keysecondary`)

Core's `(key, keysecondary, selectiveLogic)` is answered by one expression per primary key:
`synthesizeSecondary` builds the AST, `selectiveEval` evaluates it, `keywordScore` is the only caller.
Synthesis builds the AST, not a string, and so has no refusals: a key containing a double quote needs
no escape, a `?` key splices in as a subtree, and a `/regex/` key is a `REGEX` node (core permits regex
in `keysecondary`). Entry flags are stamped on synthesised nodes as `isCaseSensitive`/`isExact`; a
spliced `?` subtree and a `REGEX` node carry their own, and so do their weights.

**A secondary is a term and scores like one**, so the same logic scores the same whichever of WA's two
syntaxes wrote it; `eval/core-matcher-check.mjs` is the case table. Only `AND_ANY` and `AND_ALL` see
this: a `NOT` yields no unit, so both NOT logics score the primary alone. A gate that does not score is
written `::0` on the secondary.

**`keysecondary` is a compatibility surface.** Every two-list configuration converts to one expression
and no converse exists (`? (A AND B) OR (C AND D)` has no two-list arrangement), so the field is read
only because an unaltered lorebook must behave as under core. The shape says the full cross product
under one operator, n × m pairs alike, with no grouping; `SMARTKEYS.md` carries the worked comparison.

**Secondaries are validated like primaries, minus one code.** A key carrying a fatal validator error is
dropped before the logic runs, as blanks are; a key that parses and does not occur is a verdict the
logic sees. `fatalKey` is the shared predicate, and `usableKeys` and `secondaryKeys` differ only in
what they except.

**The one exception is `negation-only`, and the operator decides.** Under `AND_ALL` it narrows
(`astronaut` with `["cosmonaut", "? -gagarin"]`). Under the NOT logics the operator's own negation
cancels the key's, so `"? -gagarin"` reads as *requiring* gagarin — a condition an author can mean,
and the Studio says so at the moment the operator changes. Under `AND_ANY` it is refused: a negation is
satisfied by absence and `AND_ANY` `OR`s its secondaries, so the gate stops gating. `secondaryKeys` is
the only place that rule lives, and `unusableKeysOf` (`keyword-audit.mjs`) reports the difference
rather than re-deriving it.

**A key the matcher refuses is flagged per key, ahead of every other verdict.** `classify` asks
`usableKeys` before anything reads the text. Red, but never pre-ticked for removal: a malformed key
wants a correction, not a deletion.

**Secondary keys are chips like any other**, in their own row under a rule, with the operator at the
head of the row as a control — core's four names, the reading on the tooltip. The collapsed entry's
badge counts the chips. Only refusal is painted (`no-terms`, `stray-quote`, `regex-invalid`,
`negation-only`; for a secondary, absent from `secondaryKeys`, so operator-dependent) — a common-word
secondary is a legitimate gate, not a flag. The write gate asks `secondaryKeys` with the entry's
operator, so the editor never refuses what the runtime gates on.

**OFF is the fifth position, and it is `selective`, not a fifth logic.** CCv2 specifies it —
`secondary_keys` is "ignored if `selective == false`" — and core reads the flag before
`selectiveLogic`, so the list is off under all four operators. `secondaryKeys` returns `[]` for such
an entry; `unusableKeysOf` reports nothing; the Studio dims the chips and labels the row `OFF`.
Switching off leaves `selectiveLogic` alone, so switching back on restores the author's operator.

---

## Stage 3: Scoring

`onScanDone`, on `WORLDINFO_SCAN_DONE`. `CLAUDE.md` carries the stage; this section is what a key is
worth there.

**Which fit, when the model has none.** A model with no fit of its own is scored through
`UNFITTED_FALLBACK` (`relevance.mjs`); `noCosine` is for a turn with no cosine at all — the no-plugin
path or a retrieval outage. The harness refuses where production borrows, because a harness is told its
embedder. The borrow sits inside the corpus's noise floor (E13).

**A key's score is the sum over the things it is about.** `AND` joins distinct things and their scores
add; `OR` names one thing several ways and its mentions pool into one saturation; a weight multiplies
its unit rather than feeding the curve, so `::2` is 2x whatever the curve is set to — the weight is the
author's and the saturation WA's. The unit is the saturation boundary, not the key: saturating a key as
a whole would make a stricter expression outscore its own left operand, and a weight fed into the
concave curve arrives as less than the author wrote (K8).

**A hit reports a count and a score, and they answer different questions.** `count` is how many times
the key's terms appeared — `x3` in the debug column and the WI panel means the text said it three
times. `score` is what the key contributed, and is where weights and saturation live.

**Presence is categorical; only the repeats saturate.** A matched key is worth its weight, and the
`n-1` repeats accrue as `1 + R x ln(1 + (n-1)/k1)` — `repeatCurveOf`, shipped as `presence-log` with
`R` 1. `bm25K1` is the rate repeats accrue at and the curve is the shape, which is why they are two
settings. A bounded curve stops discriminating above a modest count (K8).

**No frequency discount, deliberately.** A ubiquitous key is an author declaration; a badly chosen one
is reported by the audit against the chat, where the author can act on it, and an entry whose key fires
broadly but whose content does not fit still ranks low on the other signals. A discount here would be
that judgement taken a second time, silently.

**Sticky is audited like any other entry** — the whole English list, no breadth reprieve. `sticky`
declares only that an entry persists once fired, a claim about duration and not breadth, so a broad key
there latches on the wrong turn and holds. Exempting it would hide only a handful of flags (K12).

**A change to the layout score can never surface an entry retrieval did not return**, so no keyword
weight, tilt or fusion change is a recall lever, only a precision one. `scoreVectorKeys` is stage 3:
keys re-rank vector entries and never admit one.

### Trigger depth

**Stage 3 scores the recursion buffer.** The scan window is chat plus injects plus opted-in match
sources, wrapped by `matcher.withExtraTexts` over `runState.waRecursionTexts` — each recursion content
its own segment, as match sources and injects already are. Keyword scoring only: the buffer is text WA
injected, so it stays out of the window `properNouns` is counted over.

**An entry does not match its own content in the buffer.** Its own text is filtered out of its own
window. Core never reaches this case, activating an entry once, where stage 3 re-reads the whole buffer
for every entry.

**An `excludeRecursion` entry is scored against the chat window alone.** Core's gate runs before
`getExternallyActivated` (*The seam*), so stage 2 inherits it; stage 3 is WA's own loop and core is not
in it, so the exclusion is applied there by hand.

**An entry reached at recursion pass `d` scores `keys / (1 + d)`.** `waTriggerDepth` is a per-entry
scalar stamped where a newly-matched entry joins `waMatched`; the counter advances on recursion passes
only, `args.state.next === scan_state.MIN_ACTIVATIONS` marking a min-activations widening, whose match
was found in the chat. Depth is a property of the moment, not of the entry, and depth 0 is unweighted.
The curve is an assertion.

**`eval/scene.mjs` recomputes the buffer rather than replaying one.** `makeCandidateSet`'s keyword route
runs to a fixpoint: chat first, then chat plus the content of what each pass admitted, the retrieval
winners seeding it, WA force-activating them into `new.successful`. `preventRecursion` decides who feeds
it, `excludeRecursion` who it may reach, and a `delayUntilRecursion` entry is held out of the initial
pass; its LEVEL is not modelled, core walking distinct levels rather than passes. **Termination is the
buffer standing still, never a pass admitting nothing** — the depth-0 pass matches chat only, so a pass
that admits nothing can still leave text for the next. Neither the buffer nor the depth is a capture
field: both are deterministic from the scene's `scanChat`, entries and params.

**A capture that does not carry `recursive` reads as off.** It and `maxRecursionSteps` go in under core's
own names, `maxRecursionSteps` 0 meaning no cap. Which emits core's gates would have admitted stays the
standing offline divergence.

---

## Stage 4: Selection

`CLAUDE.md` carries the cut — memory only, needs a fit, one cutoff, the dynamic block only — and stage
5's caps and budget.

**The cutoff is one setting for every embedding model** because `E[credit]` is calibrated: at one
cutoff, every fitted embedder delivers essentially the same count (E4).

**The relevance cut arbitrates over the whole dynamic block**, keyword-activated entries included, so
it can drop one with the budget wide open. That stands against *triggered == relevant* (*Evidence*) and
is recorded rather than resolved: carving an exemption for keyword rows would make stage 4 read
provenance. `promote` is the per-entry escape.

**`promote` is an author declaration that activation is sufficient**: a promoted entry enters the
layout whenever its keys fire, exempt from the relevance cut and not from capacity — the per-entry form
of *triggered == relevant*, and what `sticky: 1, constant: false` was reaching for: the insertion
guarantee without the persistence.

- Declared as `@@promote`, read at `WORLDINFO_ENTRIES_LOADED` — the last place the raw content exists,
  since core's `parseDecorators` strips every leading `@@` line and records only `KNOWN_DECORATORS` —
  and stashed as `entry.waPromote`. The stored book keeps the line. The name is unnamespaced, and WA's
  read is exact where core's is `startsWith`.
- The harness exempts promoted rows the same way (`eval/scene.mjs` `admits`). A capture records
  `block: 'promoted'`; the row is not durable, having had to activate.
- The audit gives it no reprieve, and would need its own evidence to.
- No per-book count is worth surfacing: promoted entries are situational, and what means something is
  how many fired on this turn.

---

## Divergences from ST core

Every difference between WA's matching and core's, each deliberate. Core *defects* are recorded in
`upstream-st.md` in the SillyTavern root; this section carries WA's semantics, and a divergence that
routes around a defect cites its number, since neither document says which otherwise. Parity is owed to
core's intent, not to its bugs.

- **The fold.** `fold` is `normalizeOrthography` then lowercase; core's `#transformString` only
  lowercases. For the default substring path WA is a strict superset.
- **NFC** on the regex path, where core runs raw.
- **A regex is fold-exempt, and the audit says so rather than rewriting it.** An ASCII quote in a
  pattern matches only itself where the same character in a plain key matches its whole family, so
  `regex orthography` fires where a pattern carries one side of `ORTHO_FAMILIES`' `pair` and not the
  other, in either direction, and suggests the pair — never the whole folded family, a guillemet or a
  prime being a different mark. The straight side flags on shape, the curly side only on evidence. An
  expansion would take away the only way to demand one form.
- **A regex hyphen flags only on evidence**, a scanned chat or the book holding what the en-dash form
  would have matched (`matcher.mjs` `swapLiteralHyphens`, range markers and `v` patterns left alone).
  The chip cites where, the chat outranking the book. `orthoAlternates` is what a chat scan counts
  beside the keys themselves — a verdict can cite only a pattern somebody counted. Evidence outranks
  `unattested`: a pattern that would match under another orthography is mis-written, not dead.

- **`variant only` cites where**, a scanned chat before the book: `countChatHits` returns `typedWith`
  beside `messagesWith`, the same per-message count for the key as written. What the model writes is
  the stronger claim about which form a key will meet.

- **A key's hyphen is written as a space too** (`automaton.mjs` `keyVariants`), and not the reverse:
  62% of the corpus's keys are spaces-only and would each intern a form nobody writes. An em-dash's `--`
  yields a double space, a literal nothing matches. It is an expansion and not a fold: the haystack keeps the distinction, and a `/regex/` key is the way to
  demand one form. A SmartKeys `TERM` is a word and expands with the rest.
- **Whole-word applies to multi-word keys.** Core splits the key on whitespace and uses `includes()`,
  so *Match Whole Words* is a silent no-op for any key with a space in it — the same shape as
  `upstream-st.md` #1.
- **Whole-word stops at an affix in core**, so `Joe` matches `Joe's`; WA applies the flag in both
  directions. The documented contract is preserved exactly — `king` matches "long live the king" and
  not "it's not to my liking" under core, permissive and strict alike. Every divergence lives in
  territory core never described.
- **Markup is masked for every literal matcher.** `maskMarkup` replaces a tag or an HTML comment with
  spaces, one per character, before `foldedHay` and before the Aho-Corasick prescan — both, or the prescan
  and the walk disagree on the haystack. Length-preserving, so excerpt and span offsets still index the
  source. `/regex/` keys and a SmartKey's REGEX leaf match the raw text, which is the only route to a tag.
  Core matches inside tags: `size` counts 1 on `font-size` there and 0 here.
- **The boundary class** (`wordChar()`) against core's `\W`, which diverges both ways. Fixes
  `upstream-st.md` #1 — core's whole-word test is ASCII-only.
- **A scanned inject is bounded by the window it was placed in.** Core appends every `scan: true`
  extension prompt outside its depth slice, so an Author's Note placed "In-chat @ Depth 100" is
  effectively constant in the haystack. WA scans a chat-placed inject only when its depth falls inside
  the window; one with no chat position (`IN_PROMPT`, before/after story string) has no depth to test
  and stays ambient, as core treats it. Depth 0 keeps an at-depth inject in every window.
  `scanDepth: 0` therefore excludes chat-placed injects and keeps ambient ones. Fixes `upstream-st.md`
  #16.
- **A bare `/re/` key.** Core's `parseRegexFromString` refuses a pattern whose delimiter appears
  unescaped inside it and matches the whole delimited string as literal text; `REGEX_KEY_RE` does not,
  so `/and/or/` is the pattern `and/or` here and the literal `/and/or/` there — core's refusal is an
  implementation detail, not a meaning. The warning (`regex-core-refuses`) rests on least surprise, not
  portability: it leads with what WA does and names `\/` nowhere, since escaping serves core alone;
  `SMARTKEYS.md` carries portability as a conditional. `coreReadsAsRegex` mirrors core's rule for that
  warning and counts nothing; it reaches SmartKey terms as well as bare keys.
- **`?` SmartKeys and `/re/` terms inside them.** Core's `matchKeys` treats `? …` as a literal needle,
  so an entry keyed only on SmartKeys never activates there. `SMARTKEYS.md` carries what that means
  for an author porting a book to a non-WA install.
- **`splitKeys` parses a key list**, not core's `customTokenizer`, which skips the character after every
  comma and so loses a `/regex/` written directly after one (`upstream-st.md` #17). Newlines separate as
  well as commas; a `"quoted"` term keeps its commas; a token that opens a regex without closing it is
  re-split on its commas, as core's recovery does.
- **`messageDepth` supersedes `world_info_depth`** when WA runs (*Stage 2: Activation*).

---

## Evidence

What a measurement here can and cannot support. Corpus discipline — the standard chat set, usable
messages, lineages rather than files, curation status, `humanGrades`/`llmGrades`, pool first then
pair, matched rank — is `CLAUDE.md`'s and is not restated.

**Corpus counts size a known effect and never dismiss a case.** A permitted input occurs whether or
not this author has written one; the scarcity of a syntax on disk measures core's support and
discoverability, which is what this project is removing.

**A chat measurement describes the haystack and is admissible where a key count is not**, because the
haystack exists independently of whether anyone has written the key yet.

**Tiers are provenance, never routing configuration** (decided in
`eval/eval-data/shared-metrics/FULLBOOK-AUDIT-2026-08-10.md`, enforced in `eval/scene.mjs`
`scoreScene`). An entry is memory iff STMB-marked (`stmemorybooks`/`STMB_start`), because provenance
cannot drift with the configuration under evaluation, where `vectorized`/`sticky`/`constant` all can.
A keyword-activated reference entry is relevant because its trigger fired — *triggered == relevant* —
so the only judgement left is whether the trigger deserved to fire; a memory entry is relevant because
ranking chose it.

**Set metrics on a reference-heavy book are joint** and cannot tune routing alone: a key miss and a
routing miss land in the same recall number. Split the misses by divergence class
(`eval/divergence-audit.mjs`) — key miss (suggester), window miss (depth/persistence), over-fire
(prune) — before reading an F or recall figure on such a book as a statement about the ranker.

**An arm that surfaces unjudged entries scores them 0**, so its Δ is a lower bound.

### Two scores, because one metric cannot grade two populations

**The vector score grades admission**: was the relevant entry returned at all. With no relevance
decision at stage 1 it is a recall diagnostic and a cost measure, not a quality metric. Homogeneous by
construction, since the collection holds only vectorized entries' chunks.

**The layout score is F2 over the layout itself** — the set stage 4 delivers, over the dynamic block,
on the asymmetric bars below, beta at `RECALL_WEIGHT` 2 (`metrics.mjs`). No window is imposed on it,
because choosing the set is the thing being graded. Constants and armed stickies consume budget without
competing for it; the graded population is exactly what a cut can reject. The budget is the sanity
check, not the window: a token ceiling is set by cost and is not a property of the ranking.

**`@R` and nDCG are diagnostics, never evidence that the system works.** `@R` scores the top
`relevant` rows — a cardinality the system is not told — so it measures the ordering under an oracle
count; its use is as a bound, the value F2@layout would take if the count were predicted right, and the
gap is the cardinality error. With no relevance cut, F2@layout is exactly invariant to the layout while
`@R` moves (F2). nDCG asks whether the ordering puts the good material at the top; a reordering inside
the cut moves it and cannot move the set. It is kept because every stage-5 cut takes a prefix of the
layout order, so the ordering bounds what any cut placed on it can achieve.

**Reference entries are graded on the same 0-4 scale, not reduced to a boolean.** A two-valued "does
it belong" throws away the evidence about contention the layout score reads. The vector score never
sees them, a reference entry having no chunk in the collection.

**Relevance is asymmetric, and the two halves take different bars.** Recall at grade >= 3 — did the
must-deliver material arrive. Precision credits a 3 or 4 in full and a 2 at half, keeping the 2 in the
denominator (`metrics.mjs` `gradeCredit`): a 2 is "50/50 on inclusion", so the metric must not call it
either. Moving the bar moves the absolute level while the arm ordering barely moves, and under the
symmetric bar the shallow cuts ranked on top (F3).

**The offline half exists.** `/wa-grade` records the pre-budget population with per-row `tokens`,
`cut` and `cutBy`, plus the tokenizer, so `applyBudget` replays offline at any budget — exact against
the runtime's own verdicts (F4).

### Stage 4 predicts per-entry relevance

**Shipped.** Regression measured no worse than RRF + nDCG and was chosen for explainability (F1).
Unless a paragraph says otherwise, everything below is `eval/relevance-regress.mjs` on the corpus of
record, held out by book (the register's corpus-states table), with entries that straddle their scene
removed (`dropUnavailable`).

**The model.** Logistic regression on the relevance line (grade >= 3) — linear would put predictions
outside [0,1] and weight a 0-vs-1 error the same as a 0.4-vs-0.5 one. The shipped design is cosine,
text, keys, properNouns, density (F1), fitted and served per tier: one file per tier, keyed by
embedding model, carrying the two coefficient vectors `E[credit]` is built from plus a `noCosine` fit.
The target is expected `gradeCredit`, `E[credit] = 0.5 * P(>=2) + 0.5 * P(>=3)`, both from the
cumulative fit (`--ordinal`, `logistic.mjs` `cumulativeFit`): proportional odds does not hold (F29),
and that sum is what the layout score's precision numerator is built from. `P(>=3)` is clamped to
`P(>=2)`, since separately fitted boundaries do not guarantee the nesting and an incoherent pair reads
as a threshold effect (F31). `E[credit]` decides layout order as well as membership, because
`applyBudget` assumes every cap is a prefix cut; constant and armed-sticky hoisting is about kind and
unaffected, and prompt order is the user's. `cutoff` is the threshold, `cut` the mechanism, a `bar` a
grade boundary.

**Standardisation pools both tiers; the scene stays.** The shipped fit is emitted under
`--standardise pooled` — mean and sd from every candidate the scene offered, coefficients per tier —
and records its population in `standardise`, which both consumers (`worldsapart.js`
`scoreRelevanceColumn`, `eval/scene.mjs` `makeLayoutOrder`) obey, since serving a fit the wrong
population rescales every z silently. Per-tier statistics are degenerate on a small tier by
arithmetic — a tier of one collapses to the intercept, below every shipped cutoff, and every new book
starts there (F54).

**The name index.** A name is `relevance.properNounsOf`, which the entity filter also uses:
`normalizeOrthography` is the fold minus its case half, a token enters the set only where it appears
capitalised somewhere not sentence-initial, and only the stored key is lowercased. A shared name is
worth `log((N+1)/(df+1))` with the entry as the document and the primary book as the corpus. The df
corpus is every entry in the book, disabled included, because df asks how distinctive a name is where
`buildContentIndex` asks what can be retrieved (F27). Two walks, not one: `buildContentIndex` excludes
disabled entries and counts chunks, `buildNameDf` includes them and counts entries, and neither N may be
read for the other. The index rides `contentIndexes`' per-book cache and fingerprint; the window is the
shared `windowFor` at global depth with a plain entry, the builder `eval/scene.mjs` `haystackFor` uses.
`density` is `properNounsOf` with no stoplist subtraction, one shipped function on both sides.

**Cosine is admitted for all of a tier's entries or for none.** `reindex --all` builds a collection
over every entry with content and `denseAllEntries` scores it; computing a cosine is not vectorizing
the entry — `vectorized` decides what stage 1 retrieves, a cosine is a column stage 3 reads — so every
entry with content is embedded and scored, and only `vectorized` ones are admitted. Whether a signal is
in the model is a question about the feature set, never about a row.

**The centroid is the memory tier**, named per collection in the query (`centroidUids`) rather than
stored, since `metadata.index` already carries the uid and ST's insert drops unknown fields. An absent
set means every item counts, which is what a book with no memory entries falls back to.

**Reference is scored and not cut**, because a key on a reference entry is the authorial decision —
the tier-wide form of *triggered == relevant*. The reference fit is `cosine`, `text`, `properNouns`,
`density` (`extension/relevance-model-reference.json`).

**`scoreVectorKeys` is a checkbox in Ranking & fusion, defaulting off**, and ticking it is the
author's assertion that they curated their keys: a per-book rule has nothing to key on, the curation
detector (`eval-data/README.md`) reading cleanly and then signless across corpus revisions (C5). One
fit serves both settings, the keys-live one; unticking blanks the keys and the column standardises to 0.

**How to measure.**

- Hold out a book, not a scene: a held-out scene shares its book's vocabulary, entry style, chunk
  statistics and BM25 scale. `--lobo` is the honest estimate; `--loso` is another moment in a known
  book. A small fold is not a harmless fold, since `--lobo` trains each fold on all the others (F21).
- Judge the predictor by AP and precision-at-recall, not AUC: prevalence-independent, it is right for
  comparing signals and wrong for asking what clears a cutoff, reading near-perfect at the rarest band
  while precision at usable recall is dismal (F17). `logistic.mjs` `prCurve` prints both.
- A cutoff-curve peak is not a comparison. Two arms differ by less than the flatness of their own
  curves, so `--cutoff` reports the per-scene F2 vector and the sign test against the first arm, as
  `param-screen` does. Each arm's peak is a different operating point — F2 walks the peak toward
  precision as a model improves, so a contrast between peaks reports "cut tighter" as "ranks better";
  `--emit` carries the whole cutoff grid and `pair-f2 --at-recall` reads it (F11). The exception is a
  setting that ships as its own fit with its own derived cutoff, where peak to peak is what a user
  gets.
- A scene-level sign test overstates its own n, the scenes sitting on a handful of books; a contrast
  reports books up against books down, and agreement of magnitudes across books is what carries a
  positive result.
- Measure against the ruled variant of a feature, not the harness default: `--proper-nouns` defaults
  to `idf` and `--proper-nouns-extract` to `entity`, so the shipped model is what a run reproduces
  passing neither flag.
- Ask a setting as a feature contrast, not a parameter sweep: turning `scoreVectorKeys` off leaves a
  degenerate column, where leaving `keys` out of `--features` drops it (F20).
- `--emit-model` runs at the shipped definition or refuses — `--cut 3`, `--relevant-at 3`, no
  `--half-recall`, `--cutoff --lobo` present — since anything else reads as the shipping artefact and
  is not.
- Calibration is read held out and against its null: `logistic.mjs` `reliability` bins by quantile
  and reports the ECE a perfectly calibrated model of the same size would score, and an intercept
  forces in-sample `mean(p)` to the base rate.

**Found.**

- The number of record is the held-out-by-book AP and AUC of the shipped design; in-sample reads only
  a little better, and per-scene intercepts buy nothing (F1).
- Relevance is a property of the pair, never of the entry: most entries graded in two or more scenes
  vary, over half across the relevance line, so anything caching a verdict per entry is wrong by
  construction (F15).
- An ungraded row is not a negative: fitting it as 0 lowers every readout that pays for precision and
  raises only AUC (F16).
- The count does not fall out; it is a fixed share of what activation produced. Within-scene
  standardisation makes a fixed threshold a quantile: delivered count tracks candidate count, the share
  tracks distribution shape with the sign backwards — a scene with a standout delivers fewer — and the
  macro-average hides it (F24). A count read off a frozen capture overstates a live playthrough.
- A scene-level covariate cannot fix it: candidate count is story position within a book and book
  identity across books, and mean signal level tracks relevant count rather than share (F26). The
  count can only come from the per-entry scores.
- Per-book standardisation reverses the sign of the count pathology (F25) and lies on the same cost
  curve as per-scene (F53), so it buys nothing the cutoff setting does not; the delivered count remains
  uncalibrated, and a fix would have to beat the curve.
- Pooled standardisation sits above per-scene on the whole-system cost curve at every cutoff read and
  unmeasurably at the served one (F55); the gain is reference's, memory flat with a negative lean
  (F56). The corpus cannot test the small-tier case that decided it.
- The cold start is empty on both sides: a memory tier gains an entry as the statistics gain a turn;
  reference has no history at turn one, costing ordering only since the tier is not cut; an
  established book on a fresh chat wants the per-scene fallback anyway.
- `properNouns` fills the one cell the other signals leave empty — entry content against the scan
  window — and is the largest coefficient, improving nearly every fold (F5). Idf beats the count,
  Jaccard is worse than the count, and restricting to the gazetteer loses (F6). The `entity` extractor
  beats the ASCII regex the feature was found with (F7); multi-token spans add nothing, so a name is a
  token (F8); detector variants read flat or slightly worse inside the noise floor, so the shipped
  detector stands on parsimony — retest when the graded corpus grows (F9). Excluding disabled entries
  from df costs; excluding empty entries is a no-op here (F27). The runtime reproduces the harness's
  `properNouns` to the capture's rounding (F52).
- Length is earned but over-read: relevance rises with entry length, the signals rise severalfold
  faster (`text` and `cosine` pool max over chunks, `properNouns` is an un-normalised sum), and under
  a budget the delivered entries sit well above the mean length (F10). Not established: that more
  smaller entries would be better.
- Of the two entry-intrinsic columns, `density` earns and `length` costs, in the fit and at matched
  recall alike; `length` was correcting `properNouns`'s un-normalised count, and `keys` supplies enough
  of that correction (F11). `density` inverts on reference, the concrete case for fitting per tier
  (F19).
- Entry-level priors fail: an oracle reading the entry's relevance rate in other scenes raises AUC and
  loses the delivered set, and its embedding profile reads near chance once length and story position
  are in, length being what both labels are mostly made of (F12). Re-run `peaked.mjs` if the embedder
  changes or a second book is curated.
- Story-time position carries nothing (F13). `order` is ST's insertion priority and is not consulted.
- Polynomial terms and two-way interactions measure worse held out, retried once `properNouns`
  existed; the model is linear in its features (F14).
- The tiers carry different signals — memory nearly all vectorized, reference mostly keyword-only —
  and a shared signal is not worth the same in both (F18). Fitted on the subset that carries one,
  reference cosine is an absence indicator; computed for every entry it is the tier's strongest signal,
  and a pooled fit does not move (F35).
- Scoring memory's keys gives a real signal and costs a little: the column goes from a constant to a
  within-scene signal with a small positive coefficient, the delivered set reads slightly worse peak to
  peak and at matched recall, the sign splits per book with curation not picking it, and the keys-live
  fit on blanked rows reads as well as a purpose-built keys-free one (F20). It is redundant with
  `text`, an entry's keys being drawn from its own content. Most memory keys are machine output, so a
  keys claim on this tier is a claim about generated keys (F22).
- Against the `vectorized` population the memory-tier centroid is flat and the two all but coincide
  (F44).
- The base-rate argument for the tier split was measured wrong: pooled prevalence tracks grading
  depth, at matched rank the tiers are indistinguishable at the head, and a depth cut selects the rater
  (F38).
- The scale is ordinal in the signals and the >= 3 line is its weakest boundary on memory, where
  cosine is flattest; on reference it strengthens monotonically (F29).
- 2s are a steady share of what `E[credit]` surfaces and pay into precision only, so the target and
  the recall-weighted score disagree at the margin (F32). Recorded rather than resolved.
- The gazetteer source lands within a whisker whichever it is; the ordering below the top does not
  replicate across passes, and the gazetteer is worth more where keys were never reviewed (F33). Keys
  can be the best source while useless as a signal in the same tier: a signal asks whether an entry's
  keys fired, a gazetteer what vocabulary the query should weight.
- Two cutoffs, one per tier, and each is a range rather than a point: both curves are flat around
  their peak, so a re-tune inside the band measures noise (F34).
- Cutting reference would fall almost entirely on the corpus's only reference-only book, on abstract
  world-mechanics material carrying few names, and recall at that peak is high but not full (F36); the
  tier tolerates a weak fit (F37), and its calibration is unmeasurable at its n (F30).
- Grade 4 is a band the ordering finds and the delivered set cannot; half its rows were straddlers,
  and the rest is book-specific, the anchors reserving 4 for the scene's current subject (F17). A
  high-confidence core within a known book, never a guarantee on a new one.
- The labels are the ceiling, not the model: a substantial share of boundary positives change side
  between two passes of the same judge (G3).
- `P(>=3)` is indistinguishable from calibrated, `P(>=2)` over-confident through the middle of its
  range, and `E[credit]` inherits about half of that (F30).

---

## Open work

Ordered by whether a user can see the difference.

1. **Depth does not reach `E[credit]`.** `waTriggerDepth` divides `keys`, which no shipped fit reads,
   while `cosine` and `text` are scored against the query rather than the scan window and carry no
   discount at all — so a depth-3 entry competes on relevance like any other. A depth column cannot be
   fitted until a recursion-using book has graded scenes; a post-hoc factor on `E[credit]` would be the
   first term outside the fit, against `layoutOrder`'s prefix property. `maxRecursionSteps` is the
   existing lever, and caps where this would decay.
2. **Proximity** (`(…)~N`). Witness spans shipped, so the display it needs exists.
3. **`chat common` as a gate for how a key fires, not as a flag of its own.** Rate alone is refuted:
   a firing-rate band mostly catches legitimate keys, Sommers' >20% band removing none against a 41%
   curation baseline (K16). What it can gate is the breakdown — a key over the threshold whose hits are
   mostly not whole-word wants `=`, and mostly the wrong case wants `^`. Breadth alone does not flag
   either, `authoriz` being exactly what substring matching is for; it is breadth THAT COMES FROM
   COLLISIONS, bare `Eve` on "even" and "evening". `strictClean` is the boundary-respecting count and
   is gated to keys under `minLength` and to book content, so `Eve` and `Mark` never reach it; the chat
   half scans `? =Eve` and `? =^Eve` as probes beside the key, as `orthoAlternates` already rides
   along. The sentinel's `ver` is the case, at 4 of 11 messages and no whole-word hit. K14's 20% is a
   bound, not a fit.
4. **Suggester i18n, none of it started.** `ZIPF_EN` scores non-English function words as maximally
   rare, so the suggester should detect that its priors do not apply and stand down rather than invert.
   Accent variants belong here too (`Gérard`/`Gerard`), with a human in the loop.
5. **A firing-rate diagnostic for loose reference keys.** Reference entries are never cut, so a key
   that fires too easily costs budget on every turn it wins and nothing warns anybody. The Lab answers it
   for one text at a time; what is missing is the standing per-entry rate, beside the keyword audit. Not
   blocking: an over-firing reference entry is a budget cost, where a wrongly cut one is missing material.
6. **A signal's within-scene SD varies by book**, and the two books `keys` costs are its extremes
   (F45). Standardisation divides by the scene's own SD, so a near-constant column has its few small
   differences amplified into large z against a slope fitted on other books. No use proposed; it is a
   property a book can be measured for, where curation is a label someone applies.
7. **Reference is centred on the memory tier's centroid, and nothing has asked whether it should
   be.** The memory centroid all but coincides with the collection's mean while the reference centroid
   sits well off it (F44), and cosine is the reference fit's largest coefficient. Candidates, none
   screened: a per-tier centroid, reference on raw cosine, or leaving it. Deferred deliberately —
   stage-4 work is memory-tier only.

---

## Standing caveats

- **`plugin/` changes need `node deploy-plugin.mjs` and an ST restart** — and so does a change to
  `matcher.mjs`, `smartkeys.mjs` or `automaton.mjs`, which the manifest deploys into the plugin so the
  server matches through the shipped `countKey`. Until the redeploy the two halves match differently.
- **The check suite is run by exit code.** `eq()` sets `process.exitCode`, so a failed assertion and a
  thrown error are the same signal: `for f in eval/*-check.mjs; do node "$f" || …; done`. Grepping for
  `^FAIL` alone misses thrown errors.
