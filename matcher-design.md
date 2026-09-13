# Matcher and activation — reference

How a key is written, how it is matched, and what WA does at each stage of a generation. The suggester
and the audit are `keyword-suggest-design.md`; ST core's own scan is `st-worldinfo.md`; core defects
are `upstream-st.md` in the SillyTavern root. The stage numbering is `CLAUDE.md`'s (*Four stages, and
the three orderings*). A measured claim cites its register entry, `eval/eval-data/measured-claims.md`, by
ID; anything else is an assertion.

## Principles

- **The haystack is where distinctions die.** A fold applied to the scan text erases a distinction for
  every key at once, and no flag can ask for it back. So the fold carries orthography only: a character
  joins it if it is a typographic variant of the ASCII form, never if it is finer-grained. Case is in the
  fold only because `^` exists to opt out.
- **Correctness that depends on knowing the language belongs in the reviewed layer.** The matcher is
  silent, so it is language-neutral; the suggester is reviewed before anything is accepted. Hyphens
  pass that test, accents (`du`/`dû`) do not.
- **Quoting is the single escape.** It suppresses operator, weight, paren and proximity interpretation
  and marks a punctuation-only term as deliberate. Quoting a single term never changes what it
  matches; quoting across a space turns a conjunction into a phrase.
- **Validator checks read structure, not intent.** Every check is a fact about the key's shape; none
  guesses what the author meant.
- **An unaltered lorebook behaves under WA as it does under core.** Every divergence is named under
  *Divergences from ST core*. Authored per-entry intent survives: `scanDepth` wins over every global,
  `scanDepth: 0` means "match nothing from chat", `@@dont_activate` is never overridden, `@@activate`
  is never revoked, and a forced entry still takes core's probability roll.
- **The system makes exactly one relevance decision, at stage 4.** Stages 1 and 2 admit on rules that
  need no taste; stage 4 arbitrates once over the whole set on the layout order. Author declarations
  (`constant`, `delayUntilRecursion`, `preventRecursion`, `excludeRecursion`, `disable`), core's gates
  and the admission ceiling are not WA's calls.
- **`countKey` is the only matcher.** The audit, the Studio's colouring, the Lab and the evals call it
  rather than re-deriving the rules.

## The pipeline

`worldsapart.js` hooks three points of a generation; every other module is ST-free and takes its
settings as parameters.

1. **`intercept`** (the generation interceptor) stores the chat as core's scan haystack and calls
   `selectAndActivate`, which strips `dropChatTags` elements, runs stage 1 (`retrieve`) and stage 2
   (`keywordActivations`) independently, and emits one `WORLDINFO_FORCE_ACTIVATE` for the retrieval
   winners plus the keyword adds. Then it sets `waOwnsScan`. ST skips interceptors on its dry runs, so
   those scans are core's own with live keys and WA only records the result.
2. **`onEntriesLoaded`** (`WORLDINFO_ENTRIES_LOADED`) reads `@@promote` off the raw content into
   `waPromote`, stashes the author's `ignoreBudget` on `waIgnoreBudget` and sets `ignoreBudget` true so
   core's budget stands down, and — on a scan WA owns — stashes every keyword-activating entry's keys and
   secondaries on `waKeys`/`waSecondary` and blanks them, so core's matcher matches nothing and the
   inclusion-group filter runs over WA's verdicts. Constants and `@@activate` entries keep their keys:
   core short-circuits both before matching, and the group filter's `getScore` reads `entry.key`.
3. **`onScanDone`** (`WORLDINFO_SCAN_DONE`, once per scan loop) feeds the next pass (`feedScanLoop`),
   then on every pass scores what core activated (stage 3), lays it out, cuts on relevance on the last
   pass only (stage 4), applies the caps and the budget (stage 5), rewrites `order` so assembly reads the
   prompt order, and deletes everything else from core's `activated` map.

If WA is enabled it owns activation; there is no half-owned mode. A matcher failure is reported once
per distinct message per session (`reportFailure`) and WA keeps ownership: no per-turn fallback to
core, whose match semantics would then flicker between two rule sets.

## Keys

A key is one of three things: a **plain** key, matched as a substring; a **regex** key, `/pattern/flags`
(`REGEX_KEY_RE`: any body, flags `gimsuy`); or a **SmartKey**, an expression beginning `?`. `splitKeys`
parses a key list on commas and newlines; a `/regex/` and a `"quoted"` term keep their commas, a `/`
that is not the first character of a token is literal, and a token that opens a regex without closing
it is re-split on its commas.

### The SmartKeys grammar (`smartkeys.mjs`)

The sentinel is `?`, and only the first character; `what's up?` is a plain key. Everything else
resolves toward the literal: `*` is text, `~` is text except as `~N` on a group, a single colon is text,
`+` is absorbed.

- **Terms.** A run of non-space, non-syntax characters, or a `"quoted"` phrase. `-`, `!` and `+` are
  operators only at token start, so `sci-fi` and `c++` are terms. Prefix flags: `=` whole-word, `^`
  case-sensitive, in either order. A weight is the postfix `::N` or `^N` (Lucene's boost); a delimiter
  followed by non-digits stays in the term, so `10:30`, `re:code` and URLs need no quoting.
- **Operators.** `AND` `OR` `NOT` `XOR` as words in any case at a token boundary, or `&&` `&` `+` /
  `||` `|` / `!` `-`. Adjacent terms get an implicit `AND`. Precedence: `(...)`, then `NOT`, then
  `AND`, then `OR`/`XOR`. A binary operator with nothing on one side keeps the side that exists; a
  dangling `NOT` and a stray `)` are dropped; a malformed tail parses to nothing and matches nothing.
- **Groups.** `(...)` group; a weight after the close, `(copper pipe)::3`, multiplies every unit inside
  and composes with term weights and nested groups.
- **A regex is a term.** `/pattern/flags` at token start, negatable and weightable, closed at the
  leftmost `/` outside a character class whose body compiles and whose flag run ends at a token
  boundary; `\/` is a literal slash. A term reads exactly as the same string reads as a whole key
  (`/home/user/lux/` a pattern, `/home/user/file` a literal, `/re` a literal). A term after a pattern
  needs a space. No `=` or `^` on a pattern; `/i` is how insensitivity is written. The literal is
  reachable as `? "/re/"`.
- **Proximity.** `~N` after a group, digits required, holds it to a window: `? (copper pipe)~3`.
  - N is the words strictly between neighbouring spans, so `~0` is adjacency in either order. Slack
    counts words off `wordChar()`, and every span is widened to the words it sits in before it is
    counted.
  - The unit of completeness is the conjunct: `? ((Arthur | Kyle) Porsche)~3` needs one span from
    `Porsche` and one from either branch, and the sweep takes the nearer. An alternation of anything
    larger than leaves is a choice of alternatives, swept together, a span consumed once whichever
    alternative formed it.
  - Occurrences are clusters: leftmost minimal windows, each consumed before the next is sought. A
    refused window consumes nothing; the sweep moves on from its first span.
  - A negation vetoes within reach: a cluster stands only if no occurrence of the negated operand has at
    most N words between it and the cluster. A term, a pattern or a `~N` group is within reach by an
    occurrence, however far it extends; a compound holds by its operator over its sides, so
    `-(drill practice)` vetoes when both words are within reach and `-(drill practice)~0` when a stretch
    holding them adjacent is.
  - XOR inside a group is `(a -b) | (b -a)`, the negations being the group's own veto.
  - In `((a b)~2)~3` the inner slack binds: a nested group is one conjunct whose spans are its clusters.
  - The group is one unit, seen once per cluster; leaf weights inside it are not read, its own weight
    applies. Its unit carries its leaves under `parts` for the witness walk; the cluster window is not a
    span.
  - A group without `~` keeps segment scope. `"…"~N` is refused, quoting being the construct that
    carries order; `? (-x)~N` has no positive to anchor and is `negation-only`.
- **Entry flags reach plain keys only.** `caseSensitive` and `matchWholeWords` do not reach inside a
  SmartKey or a pattern: `? nasa` in a case-sensitive entry is still insensitive.

**The validator** (`validateSmartKey`) reports structure. An `error` bars the key from activation and
scoring (`usableKeys`; `secondaryKeys` for a secondary, which excepts `negation-only` under every logic
but `AND_ANY`); a `warn` is legal and probably a typo.

| code | severity | when |
|---|---|---|
| `no-terms` | error | no term at all |
| `negation-only` | error | no term reachable without an odd number of NOTs |
| `stray-weight` | error | a `::N` or `^N` attached to nothing |
| `proximity-on-phrase` | error | `~N` after a quoted phrase |
| `stray-quote` | error | an unclosed quote |
| `regex-invalid` | error | a `/…/flags` shape `new RegExp` refuses; asked of a bare regex key too |
| `punctuation-term` | warn | an unquoted term with no letter or digit, usually a second `?` |
| `unbalanced-parens` | warn | the counts differ; it still parses |
| `all-zero-weights` | warn | every term weighted 0 |
| `regex-core-refuses` | warn | a pattern with an unescaped `/` inside, which core reads as literal text; bare key or term |

### Selective logic (`keysecondary`)

Core's `(key, keysecondary, selectiveLogic)` is one expression per primary key, built as an AST by
`synthesizeSecondary` and evaluated by `selectiveEval` inside `keywordScore`:

| logic | expression |
|---|---|
| `AND_ANY` (0, and any unknown value) | `AND(p, OR(s1, s2, …))` |
| `NOT_ALL` (1) | `AND(p, NOT(AND(s1, s2, …)))` |
| `NOT_ANY` (2) | `AND(AND(p, NOT s1), NOT s2)` |
| `AND_ALL` (3) | `AND(p, AND(s1, s2, …))` |

Blank secondaries are dropped before the logic; no secondaries means no gate. A plain key becomes a
quoted `TERM` carrying the entry's flags, a `/re/` key a `REGEX` node, a `?` key its own subtree with
its own flags and weights. A secondary is a term and scores like one, so a gate that should not score is
written `::0`. `selective: false` switches the list off under every logic, leaving `selectiveLogic`
untouched. A negation-only secondary narrows under `AND_ALL`, is negated again by the NOT logics so it
requires its term, and is refused under `AND_ANY`, where an OR branch satisfied by absence would never
gate.

## Matching — `countKey` (`matcher.mjs`)

`countKey(key, text, caseSensitive, wholeWords, scope, gateAst)` returns occurrences for a plain or
regex key and the weighted score for a SmartKey, 0 for no match; a matched expression with no weight
counts 1.

**The fold** (`automaton.mjs`): `normalizeOrthography` then lowercase. Orthography is apostrophe
variants (`‘’‚‛ʼʹ´` `` ` `` `′‹›`) to `'`, double-quote variants (`“”„‟″ʺ«»`) to `"`, em dash to `--`,
en dash to `-`, ellipsis to `...`, non-breaking space to a space, and NFC where a combining mark is
present. Em and en dashes never collapse together, and the CJK brackets `《》` `「」` stay out: they
partition what `"` collapses. **A key's hyphen is written as a space too** (`keyVariants`), one way
only: a spaces-only key interns no hyphenated form, and an em dash's `--` yields a double space nothing
matches.

**A regex key is case-sensitive and fold-exempt except for NFC**, running on the raw text as core's
does. Inside a SmartKey folding is mixed per term.

**Markup is masked for every literal matcher** (`maskMarkup`): a tag or an HTML comment becomes spaces,
one per character, before the fold and before the automaton prescan, so offsets still index the
source. A regex key or term sees the raw text and is the only route to a tag.

**Whole words** apply wherever "word" is defined, multi-word keys included and at both edges. The
boundary class is the `wordBoundary` setting: `permissive` is letters, digits and marks; `strict`
(default) adds hyphen and both apostrophes. A doubled hyphen is a boundary in both modes, since the
fold writes an em dash as `--`. `_` is outside the class in both. There is no carve-out for scripts
without word separators (Han, kana, Thai, Lao, Khmer, Myanmar); `wholeWordAdvice` names the script
and says the flag cannot match inside running text there.

**The match window** is the `matchWindow` setting, `scan | message | paragraph`: where WA stops
concatenating, applied uniformly to every rule. `scan` is one segment of the joined messages; `message`
one per message; `paragraph` splits each on a blank line (`\n[ \t]*\n`) and at a block element's open or
close (`BLOCK_TAGS`), zero-width so the tag stays in the text. Match sources and injects are each their
own segment. A regex `^` and `$` are segment-relative. A unit's occurrences sum across segments and
saturate once.

**The prescan.** `registerKeys` interns every literal key's variants into an Aho-Corasick automaton per
scope; `primeScan` scans each segment once and caches the counts. `cachedCount` answers a plain key
from the cache: a 0 is final under any flags, a positive count final only for plain substring matching,
and a flagged key verifies against the folded haystack with `wholeWordRegex`. A SmartKey's terms carry
their automaton indices, so a term the prescan did not find is refused without a walk.

**Dropped chat elements** (`dropTags`, the `dropChatTags` setting): each named element is removed with
its content from every message WA reads, once, at intake. An unclosed element runs to its parent's
close, found by balance, or to the end. Off is core's behaviour.

### Scoring units

`evaluate` returns `{ matched, scoreBoost, units }`. A unit is one thing the key is about, `n`
occurrences at weight `wsum/n`. A TERM or REGEX is one unit at `weight x n`; `AND` yields both sides'
units; `OR` pools its sides into one unit, the alternation; `XOR` yields the matched side's; `NOT`
yields none. A group weight multiplies every unit's `wsum` and never `n`. `keywordScore` pools units by
identity across the window, then credits each as `weight x repeatCurveOf(n)`: `presence-log`, `1 + R
ln(1 + (n-1)/k1)`, `R` 1 and `k1` the `bm25K1` setting. A hit reports `count`, the occurrences, and
`score`, the contribution. There is no frequency discount on a key: a ubiquitous key is the audit's
business.

### Witness spans

`keyExcerpts` marks where a key landed, `keySpans` returns offsets and `keyHits` the per-window report;
the Lab and the Studio draw from these. Spans are the AST's leaves, walked directly rather than through
`evaluate`'s units, so a key that failed still shows the branch that hit. A negated leaf is reported
with `negated` set, at count 0 with no offsets; its count is over the whole text. A window with no
positive branch is skipped. `keyHits` gives one excerpt per branch per window, every occurrence for a
single-positive-branch key. `mergeSpans` folds overlapping spans to one at the first one's extent.
Offsets index the NFC form of the text.

## Stage 1 — Retrieval

`retrieve`. The query is the newest `messageDepth` messages with content, macros substituted, the file
prefix stripped, joined as `name: text` blocks (`query.mjs`), with the embedding model's instruction
prefixed where the family has one (`relevance.mjs` `PREFIXES`). Neither the query nor an entry is
summarised.

`syncWorld` chunks every enabled entry with content (`chunking.mjs`: `paragraph` mode keeps one
paragraph per chunk, splits one over `chunkSize` and merges fragments under `minChunkSize` forward)
into the collection `wa_<hash of book name>`, one row per (text, uid), inserting new chunks and
deleting stale ones.

`queryCollections` asks the server plugin's `/query-multi`: every chunk of every attached book scored
by cosine against the query, both centred on the collection's centroid — the memory tier's chunks,
named per collection by uid, every chunk when a book has none — pooled to the best chunk per entry and
cut at `admitCeiling`, 1000 entries. No admission test: cosine only. Without the plugin the same
request goes to ST's `/api/vector/query-multi`, which neither centres nor pools nor returns scores, so
K counts chunks (10000) and stage 3 has no cosine. Every scored entry keeps its cosine in
`runState.lastScores`; only `vectorized` entries are retrieval winners. Retrieval is serialised so a
query never reads a half-built index. A retrieval failure is reported and costs every entry its cosine;
keyword matching and constants are unaffected.

Plugin side (`plugin/server.js`, `scoring.mjs`, `vector.mjs`): an index's items and corpus mean are
cached on the index file's mtime and size; `centroidFor` averages the named uids' chunks;
`scoreCollection` is mean-centred cosine; `poolEntries` keeps the best chunk per entry; `selectTopK`
sorts and cuts. The plugin is a generated copy: edits need `node deploy-plugin.mjs` and a restart, and
the settings panel shows a drift banner until the fingerprints match.

## Stage 2 — Activation

Three routes into core's `activated` map: WA's force-activate of the retrieval winners and the keyword
adds, `constant` and `@@activate`, and sticky persistence. Core keeps every gate, the timers,
recursion control and prompt assembly; WA replaces one question, *did a key match*.

**The seam.** `getExternallyActivated` is checked inside core's loop after `@@dont_activate` and before
constant, sticky and key matching; disable, triggers, character and tag filters, delay, cooldown,
`delayUntilRecursion`, `excludeRecursion` and the probability roll all run before it, so a forced entry
inherits them. The emit is blind: WA emits every entry whose keys match and lets core refuse what it
refuses. With core's matcher blanked, an entry WA declines to emit has no other route in.

**`keywordActivations`** fetches the candidates with live keys, registers every usable key and secondary
once, and calls `activationAdds`: for each enabled, non-constant entry without `@@dont_activate`, the
window at its depth, and the verdict is whether `keywordScore` reports any hit. The window
(`makeWindowFor`) is the chat minus `is_system` messages at depth, plus every `scan: true` extension
prompt that is ambient (not `IN_CHAT`) or placed inside the depth, plus the sources the entry opted into
(persona, character description, personality, depth prompt, scenario, creator notes), each its own
segment, re-cut by the match window.

**Depth.** `messageDepth` governs when WA runs; core's `world_info_depth` is the fallback only when the
setting is unset. A per-entry `scanDepth` wins and is never skewed; `scanDepth: 0` matches nothing from
chat and keeps ambient injects.

**Recursion and min-activations** (`feedScanLoop`, each `WORLDINFO_SCAN_DONE`). Entries already
activated are recorded and never rescanned. With `world_info_recursive` on, each pass's newly
successful entries minus `preventRecursion` ones append their content to the recursion buffer, and the
recursion depth advances; a min-activations pass (`state.next === MIN_ACTIVATIONS`) widens WA's depth
by one message instead, mirroring core's `advanceScan`. Unmatched candidates are rematched over the
chat plus the buffer, each recursion text its own segment; an add is stamped with the pass's depth
(`waTriggerDepth`) and emitted. WA never writes `state.next`; core schedules every pass.

## Stage 3 — Scoring (`onScanDone`)

Every activated entry becomes a row `{ entry, score, textScore }`, `score` its stage-1 cosine if it
had one. With `dropUnavailable` a memory entry whose STMB range postdates the current message is
deleted first.

**Text.** `contentTextScores`: BM25 (`lexical.mjs`, `k1` 1.2, `b` 0.75, the matcher's fold for
tokens) of the query over every enabled entry's content, chunked as `syncWorld` chunks and max-pooled
per entry. The entity filter supplies the query terms: a token survives if it is capitalised mid-sentence
in the query or in the gazetteer of every authored key, secondary and title, capitalised ones weighted
`properNounBoost` (3), and terms in more than `stopwordDocFreq` (25%) of chunks are dropped. The
gazetteer reads the authored keys through the takeover's stash, as a local view. These settings are
internal and reset each init.

**Keys.** Each row's keys — live, or the stash — are scored by `keywordScore` over its window with the
recursion buffer appended, minus the entry's own content, and not at all for an `excludeRecursion`
entry; secondaries gate through the stash. The score is divided by `1 + waTriggerDepth`, so an entry
reached at recursion pass `d` scores `keys / (1 + d)`; depth 0 is unweighted. Every entry's keys are
scored, vectorized included. The curve is an assertion.

**The relevance column** (`scoreRelevanceColumn`). `properNouns` is the sum over names the entry shares
with the window of `log((N+1)/(df+1))`, a name being a token capitalised somewhere not sentence-initial
(`properNounsOf`) minus the bundled English common list, df counting the book's entries with content,
disabled included. `density` is names per hundred tokens of the entry, no stoplist. `E[credit]` comes
from a fitted logistic model per tier, memory or reference by `isMemory` (STMB-marked):
`extension/relevance-model-<tier>.json`, keyed by embedding model, features `cosine`, `text`, `keys`,
`properNouns`, `density`. Each feature is standardised over the fit's recorded population — every row
of the scan minus constants under `pooled` — and `E[credit] = 0.5 P(>=2) + 0.5 P(>=3)`, `P(>=3)`
clamped to `P(>=2)`. A model with no fit of its own scores through `UNFITTED_FALLBACK`'s; a pass in
which no row has a cosine scores through the file's `noCosine` fit. A tier with no model is not scored,
and an unscored row is kept.

**Layout** (`layout.mjs` `layoutOrder`). Rows are classified by what the entry is, durable first: armed
sticky (core's `timedEffects.isEffectActive`), then `constant`, then promoted (`waPromote`), then
dynamic. The scored blocks sort by `E[credit]`, an unscored row below every scored one, then authored
order; `sequential` book priority makes the book tier the primary key, `interleaved` scales the score
by the book's weight and shifts authored order by its offset. Durable blocks sort by authored order.
This is the layout order (`runState.lastLayoutOrder`); the prompt order is separate.

## Stage 4 — Selection

`selection.mjs` `relevanceCut`, on the last scan loop only, over the dynamic block only: a row of
either tier whose `E[credit]` is below the `relevanceCutoff` setting (0.10) is dropped and deleted from
core's map. The cutoff is one setting for every model and both tiers, never the fit's own `cutoff`,
because `E[credit]` is calibrated across embedders (E4). A row with no finite score, or whose tier has
no fit, is kept: an absent verdict is not a negative one. Constants, armed stickies and promoted rows
are separate blocks and never reach the cut.

**`@@promote`** is the per-entry exemption: an author declaration that activation is sufficient. It is
read at `WORLDINFO_ENTRIES_LOADED`, the last place the raw content exists, exact-named where core's
decorator test is `startsWith`, and the stored book keeps the line. A promoted row is exempt from the
relevance cut and not from capacity.

## Stage 5 — Delivery

`delivery.mjs`. `walkOrder` is constants, armed stickies, promoted, then the dynamic block, so every
cap is a prefix cut of the layout order. `applyBudget` walks it once:

- **Token budget:** the tighter of `maxTokensPercent` of the max prompt and `maxTokens`, 0 off. An
  entry past the budget is rescued once (`budgetSlackMode: 'once'`) or every time (`'all'`) when it fits
  within `budgetSlackPercent` over it. An `ignoreBudget` entry, by the author's own value, is neither
  capped nor counted; with `maxTokensIncludesExempt` its tokens still come off the budget.
- **Entry caps**, each 0 off: `maxTotalEntries` over every counted entry; `maxDynamicEntries` over the
  dynamic block; `maxVectorEntries` (20) over dynamic plus promoted rows carrying the `vectorized` flag;
  a per-book `cap` from the priority list over dynamic plus promoted.
- A blocked entry is skipped, not stopped at, so an exempt entry behind an oversized one is reached; a
  skip after the last admission is marked `tail`.

Survivors stay in core's map, the rest are deleted. Then the **prompt order**: one flat sort of the
survivors by the `presentationOrder` setting (any `SORT_FNS` key, `best-first` or `best-last` on
`E[credit]`), grouped by tier first under `presentationTiered`, by book tier first under `sequential`;
each survivor's `order` is rewritten to a base plus its index, since assembly sorts by `order`. The
delivery panel and `/wa-debug` read `runState.lastPromptOrder` and `lastSkipped`.

## Divergences from ST core

Every difference between WA's matching and core's. A divergence that routes around a core defect cites
its `upstream-st.md` number.

- **The fold.** Core's `#transformString` only lowercases; WA folds orthography first, and expands a
  key's hyphen to a space. For the default substring path WA is a strict superset.
- **NFC** on the regex path, where core runs raw.
- **A regex is fold-exempt and the audit says so** (`regex orthography`, `keyword-suggest-design.md`)
  rather than rewriting it: an ASCII quote in a pattern matches only itself where a plain key matches
  its family. The suggestion is the pair, never the whole family.
- **Whole-word applies to multi-word keys.** Core splits the key on whitespace and uses `includes()`, so
  its checkbox is a no-op for any key with a space (the shape of `upstream-st.md` #1).
- **Whole-word stops at an affix in both directions.** Core's `\W` test lets `Joe` match `Joe's`; WA's
  boundary class applies both ways, and is Unicode where core's is ASCII (`upstream-st.md` #1).
- **Markup is masked** for a literal key; core matches inside tags.
- **A scanned inject is bounded by the window it was placed in.** Core appends every `scan: true`
  extension prompt outside its depth slice, so an Author's Note at depth 100 is effectively constant in
  the haystack (`upstream-st.md` #16).
- **A bare `/re/` with an unescaped `/` inside is a pattern here**, where core's `parseRegexFromString`
  refuses it and matches the delimited string as literal text. `coreReadsAsRegex` mirrors core's rule
  for the `regex-core-refuses` warning only.
- **`?` keys never match in core**, which treats `? …` as a literal needle, so a book keyed only on
  SmartKeys loads in a stock install and matches nothing rather than breaking.
- **`splitKeys`** parses a key list where core's `customTokenizer` skips the character after every
  comma and loses a `/regex/` written directly after one (`upstream-st.md` #17).
- **`messageDepth` supersedes `world_info_depth`** when WA runs; a per-entry `scanDepth` still wins.
- **Entry flags do not reach a SmartKey or a pattern.**
- **The match window** segments the haystack where core matches over the joined scan text; `scan` is
  core's behaviour.
- **Dropped chat elements** are removed before matching; core matches inside them.

## Settings (`state.mjs`)

| setting | default | what it is |
|---|---|---|
| `enabled` | true | WA owns selection, ranking and budget |
| `messageDepth` | 10 | messages read for the query and the keyword window; per-entry `scanDepth` overrides |
| `matchWindow` | `paragraph` | `scan` / `message` / `paragraph`, the unit a key must match within |
| `wordBoundary` | `strict` | the whole-word boundary class |
| `dropChatTags` | `''` | tag names removed with their content from every message WA reads |
| `relevanceCutoff` | 0.10 | the stage-4 `E[credit]` cutoff for dynamic rows of both tiers |
| `dropUnavailable` | true | hide memory entries whose STMB range postdates the current message |
| `maxVectorEntries` | 20 | stage-5 cap on `vectorized` rows |
| `maxDynamicEntries`, `maxTotalEntries` | 0 | stage-5 caps, 0 off |
| `maxTokensPercent`, `maxTokens` | 40, 0 | the token budget; the tighter wins, 0 off |
| `budgetSlackPercent`, `budgetSlackMode` | 0, `once` | how far past the budget an entry may go, and how often |
| `maxTokensIncludesExempt` | false | `ignoreBudget` entries' tokens come off the budget |
| `presentationOrder`, `presentationTiered`, `tierCfg` | `order-asc`, false | the prompt order |
| `worldPriorityMode`, `worldPriorityByChar` | `interleaved` | book priority: weight, offset and cap per book, per character |
| `language` | `en` | the language pack the suggester and audit read |
| `llmProfile`, `llmTemperature` | `''`, `'1'` | the connection profile for WA's own generation calls |
| `debugLog` | true | `console.table` the ranking every scan |

Internal, no UI, reset to their defaults each init: `chunkSize` 1750 characters, `chunkMode`
`paragraph`, `minChunkSize` 120 (a change re-embeds every collection); `meanCentered` true;
`entityFilter` true, `properNounBoost` 3, `stopwordDocFreq` 0.25; `bm25K1` 1.2, `bm25B` 0.75,
`repeatCurve` `presence-log`, `repeatR` 1.

## Open

Each an option against a behaviour that stands:

1. **A depth term in the score.** Depth is not a scoring signal: `waTriggerDepth` divides `keys`, which
   no shipped fit reads, and `cosine` and `text` are scored against the query with no discount, so an
   entry reached at any recursion depth competes on relevance like one matched in the chat. A fitted
   depth column needs a recursion-using book with graded scenes; a post-hoc factor on `E[credit]` would
   be the first term outside the fit, against `layoutOrder`'s prefix property. `maxRecursionSteps`
   bounds how far recursion reaches.
2. **Language packs beyond wordfreq.** Any language but English is wordfreq alone, with no POS sets, so
   the verb and adjective filters are no-ops there and the English morphology rules stay on. Options:
   the English morphology rules under another language, and tokenisation for languages without
   whitespace.
3. **Per-book signal spread as a book property.** A signal's within-scene SD varies by book (F45), and
   standardisation divides by the scene's own SD, so a near-constant column has its few small
   differences amplified against a slope fitted on other books. No use proposed.
4. **Per-tier centring.** Reference is centred on the memory tier's centroid, which sits well off the
   reference centroid (F44). Per-tier and cross centring are measured flat (F57); the
   `referenceCentroid` arm in `eval/scene.mjs` is the instrument. Re-run when the corpus has more books.
