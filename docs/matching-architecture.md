# Matcher and activation — reference

How a key is written, how it is matched, and what WA does at each stage of a generation. The suggester and the audit are `keyword-suggestions.md`; ST core's own scan is `eval/st-worldinfo.md`; core defects are `upstream-st.md` in the SillyTavern root. A measured claim cites its register entry by ID (`measured-claims.md`); anything else is an assertion.

## Principles

- **The fold carries orthography only.** A fold applied to the scan text erases a distinction for every key at once, and no flag can ask for it back, so a character joins the fold only if it is a typographic variant of the ASCII form. Case is folded because `^` opts out.
- **Language-dependent correctness belongs in the reviewed layer.** The matcher is silent, so it is language-neutral; the suggester is reviewed before anything is accepted. Hyphens pass that test; accents (`du`/`dû`) do not.
- **Quoting is the single escape.** It suppresses operator, weight, paren and proximity interpretation and marks a punctuation-only term as deliberate. Quoting one term never changes what it matches; quoting across a space turns a conjunction into a phrase.
- **The validator reads structure, not intent.**
- **An unaltered lorebook behaves under WA as under core**, except for the divergences listed below. Authored intent survives: `scanDepth` wins over every global, `scanDepth: 0` matches nothing from chat, `@@dont_activate` is never overridden, `@@activate` is never revoked, and a forced entry still takes core's probability roll.
- **One relevance decision, at stage 4.** Stages 1 and 2 admit on rules; stage 4 arbitrates once over the whole set. Author declarations, core's gates and the admission ceiling are not WA's calls.
- **`countKey` is the only matcher.** The audit, the Studio, the Lab and the evals call it.

## The pipeline

`worldsapart.js` hooks three points of a generation; every other module is ST-free and takes its settings as parameters.

1. **`intercept`** (the generation interceptor) stores the chat as core's scan haystack (`runState.scanChat`) and calls `selectAndActivate`: strip `dropChatTags` elements, run stage 1 (`retrieve`) and stage 2 (`keywordActivations`) independently, emit one `WORLDINFO_FORCE_ACTIVATE` for the union, and set `waOwnsScan`. ST skips interceptors on its dry runs, so those scans are core's own and WA only records them.
2. **`onEntriesLoaded`** (`WORLDINFO_ENTRIES_LOADED`) reads `@@promote` into `waPromote` and the leading decorator lines into `waDecorators`, runs the decorator desugar, and, on a scan WA owns, stands core down: the author's `ignoreBudget` is stashed on `waIgnoreBudget` and `ignoreBudget` set true, and every keyword-activating entry's keys and secondaries are stashed on `waKeys`/`waSecondary` and blanked. Constants and `@@activate` entries keep their keys: core short-circuits both before matching, and the inclusion-group filter's `getScore` reads `entry.key`.
3. **`onScanDone`** (`WORLDINFO_SCAN_DONE`, once per scan loop) feeds the next pass (`feedScanLoop`). On the last loop (`isLastLoop`: a falsy `state.next`, or core's `world_info_max_recursion_steps` break, which leaves it set) it scores what core activated (stage 3), cuts on relevance (4), applies the caps and budget (5), rewrites `order` to the prompt order and deletes everything else from core's `activated` map. Both writes wait for the last loop: core re-activates a forced entry its map no longer holds and schedules another pass, and it reads `order` in its inclusion-group sort.

If WA is enabled it owns activation; there is no half-owned mode. A matcher failure is reported once per distinct message per session (`reportFailure`) and WA keeps ownership rather than falling back to core for a turn. A throw while ranking is reported every time it happens, and the scan ships only what needed no decision: constants, `@@activate` and armed stickies (`delivery.dropUndecided`).

**One run at a time.** A run lasts from a generation's interceptor to the last loop of the scan it armed, ranked or not, or to that scan loading no entries, where core emits no scan-done. Every interceptor entry, `quiet` generations and `/wa-dry` included, waits for the run in progress to finish before taking the next `scanToken`, and a continuation whose token is no longer current bails at its next await. A run is superseded only by a stop, or when it has not armed within `ARM_WAIT_MS` or not finished its scan `RUN_WAIT_MS` after arming, which WA reads as the run being blocked on the newcomer (an interceptor after WA's awaiting a generation); that is toasted. A scan ranks only while its generation is armed (`armedToken`), and its last loop disarms it; a superseded or unarmed scan runs core in full, budget included. A `quiet` generation is not a chat turn: it records no latches and leaves the delivery panel alone.

## The decorator desugar

`onEntriesLoaded` is the last point the `@@` lines exist, since core strips them in `parseDecorators`. `resolveDecorators` keeps the leading lines named in `WA_DECORATORS` and applies core's `@@@` fallback chain: a `@@@name` line counts only when the line before it was unrecognised. `decoratorFor` reads the stash (`waDecorators`), never core's `decorators` field, which holds only core's own two names. The desugar is **gated on `settings().enabled`**, so with WA off the install behaves as without it; it runs on ST's dry runs too, since every field it writes is one core reads natively.

`decoratorFields(entry, { chatLength })` is pure and returns a field patch. `onEntriesLoaded` applies it before the key stash, so `waSecondary` captures the desugared `keysecondary`. Core hashes each entry after this hook and keys its timed effects on the hash, so a `depth` that moves with the chat (`waReverseDepth`) is withheld and set on the activated entries at `WORLDINFO_SCAN_DONE`.

| decorator | effect |
|---|---|
| `@@depth N` | `position: atDepth, depth: N` |
| `@@reverse_depth N` | `position: atDepth, depth: chatLength - N`; refused while negative |
| `@@role assistant\|system\|user` | `role`, implying at-depth — see below |
| `@@scan_depth N` | `scanDepth: N` |
| `@@position` | `before_desc` -> `before`; `after_desc`, `personality`, `scenario` -> `after` |
| `@@additional_keys a,b` | `keysecondary`, `selectiveLogic: AND_ANY` |
| `@@exclude_keys c,d` | `keysecondary`, `selectiveLogic: NOT_ANY` |
| both key decorators | `keysecondary` + `AND_ANY` for the additional keys, and a WA-only `waExcludeKeys` |
| `@@activate_only_after N`, `@@is_greeting N`, `@@activate_only_every N`, `@@is_user_icon NAME` | activation gates — see below |
| `@@dont_activate_after_match`, `@@keep_activate_after_match` | latches — see below |

An unparseable or out-of-range argument is refused, never clamped. A decorator overwrites the field the entry also sets, since the decorator is what the author wrote; the key decorators replace an authored `keysecondary` and `selectiveLogic` outright.

**Conflicts.** Decorators apply in document order and the first write to a field wins, so `@@depth` then `@@position` keeps the depth. `@@additional_keys` and `@@exclude_keys` may repeat and their lists accumulate. `@@role` is applied after the run: alone on an entry not already at-depth it also sets `position: atDepth` at the entry's `depth` or `DEFAULT_WI_DEPTH` (4); with `@@depth` it is harmonious; against a non-at-depth `@@position` the position wins and `role` is not written, since core reads `role` only at depth.

**The key pair.** `selectiveLogic` holds one value, so `@@additional_keys` keeps the core-native mapping and the exclusions ride on `waExcludeKeys`, which `selectiveEval` ANDs onto the gate as one NOT per key. Core ignores the field and gates on the additional keys alone. The entry's own keys are never rewritten. Both decorators are read as gates whatever the entry's `use_regex`, a field ST does not preserve on import; CCv3's alternative-trigger reading under it is not implemented.

**The activation gates** are `activationAdds` checks rather than core fields. `@@activate_only_after` and `@@activate_only_every` count assistant messages (not `is_user`, not `is_system`); `@@is_greeting` reads `chat[0].swipe_id`, 0 when the card has no alternates; `@@is_user_icon` compares the active persona name. A gate whose input is missing does not rule. The gate and the scan window are independent, so an entry can become eligible after its trigger has left the window.

**The latches.** WA owns the record, in `chat_metadata.worldsApart.fired` (`WA_METADATA_KEY`), rather than desugaring to core's `sticky`/`cooldown`, which core deletes whenever the entry's own field is absent. Each `latchKey(entry)` (world and uid joined with US) maps to the first chat length the latch holds at, one past the length when the entry first fired. Every length is on core's scan clock (`scanLength`), the one its delay and timed effects read: hidden messages out and a swiped reply popped, so a swipe or regenerate of the firing turn reads the record as not yet fired. The record is written at scan-done for activated entries carrying either decorator, never on a dry run or a quiet generation, and read through `firedUpTo`, which drops anything past the current length, so a rewind un-latches. A fired `@@dont_activate_after_match` entry is skipped; a fired `@@keep_activate_after_match` entry is admitted with no keyword hit and is durable, laid out with constants and armed stickies rather than scored and cut. Both present latches ON. Both take an optional duration, holding while `chatLength <= firedAt + N`, measured from the first firing only; bare holds forever. A record follows its entry through the Studio's renames, renumbers, moves and deletes, in every chat on disk (`rekeyLatches`; `st/studio.mjs` `rekeyChatLatches`); edits in ST's own editor are not followed.

**`@@activate` and `@@dont_activate`** are core's: `activationAdds` skips an entry carrying either.

### Rulings

Judgements where CCv3 is silent or core cannot comply. Bold marks what the author loses.

| ruling | authority | what is lost |
|---|---|---|
| document order, first write to a field wins | WA — CCv3 silent | **the later duplicate, or `@@position` after `@@depth`** |
| `@@role` implies at-depth when no position decorator appears | WA — CCv3 silent | nothing |
| an explicit `@@position` beats `@@role` | WA — CCv3 silent | **the `@@role` line** |
| both latches present: latches ON | WA, after CCv3's `@@activate` precedence | **`@@dont_activate_after_match`** |
| a latched `@@keep_activate_after_match` is durable | WA — CCv3 has no delivery stage | nothing |
| both latches take an optional duration | WA extends CCv3 | portability: a strict reader may ignore the line |
| `@@position personality\|scenario` -> after char defs | WA — no ST slot | exact placement |
| the key decorators replace `keysecondary` and `selectiveLogic` | WA — CCv3 silent | **the authored secondary list and logic** |
| both key decorators are gates, never extra triggers | WA — CCv3 couples this to `use_regex` | the `use_regex` reading |
| `@@activate_only_after` counts assistant messages | CCv3's wording; ST's `delay` differs | nothing |
| `@@ignore_on_max_context` not implemented | WA — `ignoreBudget: false` is the default | nothing |
| `@@activate` beats `@@dont_activate` | CCv3 | — |

### Out of scope

`@@instruct_depth`, `@@instruct_scan_depth` and `@@reverse_instruct_depth` count tokens where ST positions and scans by message. `@@disable_ui_prompt` is not WA's concern.

## Keys

A key is a **plain** key, matched as a substring; a **regex** key, `/pattern/flags` (`REGEX_KEY_RE`, flags `dgimsuvy`); or a **SmartKey**, an expression beginning `?`. `splitKeys` splits a key list on commas and newlines; a `/regex/` and a quoted term keep their commas, a `/` not first in a token is literal, and a token that opens a regex without closing it is re-split on its commas.

### The SmartKeys grammar (`smartkeys.mjs`)

The sentinel is `?` as the first character only; `what's up?` is a plain key. Everything else resolves toward the literal: `*` is text, `~` is text except as `~N` on a group, a single colon is text, `+` is absorbed.

- **Terms.** A run of non-space, non-syntax characters, or a quoted phrase. A phrase opens on any mark in `QUOTE_FAMILIES` (`"`, curly, guillemet, CJK) and closes on the first mark of the same family, so `"「月」"` keeps its brackets; the CJK marks are syntax only in a SmartKey, the fold leaving them in the text (K10). `-`, `!` and `+` are operators only at token start, so `sci-fi` and `c++` are terms. Prefix flags: `=` whole-word, `^` case-sensitive, either order. A weight is postfix `::N` or `^N`; a delimiter followed by non-digits stays in the term, so `10:30` and URLs need no quoting.
- **Operators.** `AND` `OR` `NOT` `XOR` as words in any case, or `&&` `&` `+` / `||` `|` / `!` `-`. Adjacent terms get an implicit `AND`. Precedence: `(...)`, `NOT`, `AND`, then `OR`/`XOR`. A binary operator missing a side keeps the side that exists; a dangling `NOT` and a stray `)` are dropped; a malformed tail matches nothing.
- **Groups.** A weight after the close, `(copper pipe)::3`, multiplies every unit inside and composes with inner weights. A flag in front of a group reaches every term in it, not a pattern. Groups and negations nest at most 100 deep; past that the key is refused (`too-deep`), counts 0, and never aborts the scan.
- **Macros are data.** A `{{token}}` is replaced under the scope's map: the runtime builds it each scan through `substituteParams`, a capture records it as `macros`, and `scene.mjs` matches in a scope of it. In an unquoted term the value's words become a group, so `? {{user}} sword` reads `? (Kyle Parsons) sword` and takes a group's `~N`, weight and flags; in a phrase the value sits inside the phrase; in a pattern it is inserted escaped; in a plain key it is the substring. `{{token}}[N]` is the Nth word, one-based, negative from the end, empty when absent. An unknown token stays as written; an empty value drops the leaf.
- **Optional terms.** A trailing `?` on a term, phrase, group or pattern makes it optional: never a gate, still scored, so `? Kyle Parsons?` matches on `Kyle`. `evaluate` forces `matched` on an optional node; inside a `~N` group an optional conjunct adds an alternative without it.
- **A regex is a term.** `/pattern/flags` at token start, negatable and weightable, closed at the leftmost `/` outside a character class whose body compiles and whose flags end at a token boundary. A term reads as the same string reads as a whole key. No `=` or `^` on a pattern; `/i` is insensitivity. The literal is `? "/re/"`.
- **Proximity.** `~N` after a group holds it to a window: `? (copper pipe)~3`.
  - N is the words strictly between neighbouring spans, counted off `wordChar()`, so `~0` is adjacency in either order; each span is widened to the words it sits in.
  - The unit of completeness is the conjunct: `? ((Arthur | Kyle) Porsche)~3` needs `Porsche` and either name, and the sweep takes the nearer.
  - Occurrences are clusters: leftmost minimal windows, each consumed before the next is sought.
  - A negation vetoes a cluster when an occurrence of its operand is within N words of it; a compound operand holds by its operator, so `-(drill practice)` vetoes when both words are within reach.
  - XOR inside a group is `(a -b) | (b -a)`. In `((a b)~2)~3` the inner slack binds.
  - The group is one unit, seen once per cluster: leaf weights inside are not read, and a one-term group takes its term's weight.
  - `"…"~N` is refused, a phrase already carrying order; `? (-x)~N` is `negation-only`.
- **Entry flags reach plain keys only.** `caseSensitive` and `matchWholeWords` do not reach into a SmartKey or a pattern.

**The validator** (`validateSmartKey`) returns `KeyAlert`s built from the `KEY_ALERTS` registry, which gives each code its severity and label. An `error` bars the key from activation and scoring (`usableKeys`; `secondaryKeys`, which excepts `negation-only` under every logic but `AND_ANY`); a `warn` is legal and probably a typo; an `info` is a note.

| code | label | severity | when |
|---|---|---|---|
| `no-terms` | No terms | error | no term at all |
| `too-deep` | Nested too deep | error | groups or negations nested past 100 |
| `negation-only` | Negation only | error | matches a text holding none of its terms, by negation alone |
| `no-required-term` | No required term | error | matches a text holding none of its terms because of an optional term: `? x?`, `? (A OR B)?`, `? A? -B` |
| `always-true` | Always-true term | error | a part true for every text through optional marks, as a side of OR or XOR or under a NOT: `? -A?`, `? C (A OR B?)` |
| `stray-weight` | Stray weight | error | a `::N` or `^N` attached to nothing |
| `stray-proximity` | Stray proximity | error | a second `~N` after a group |
| `proximity-on-phrase` | Proximity on a phrase | error | `~N` after a quoted phrase |
| `stray-quote` | Unclosed quote | error | an unclosed quote |
| `regex-invalid` | Invalid regex | error | a `/…/flags` shape `new RegExp` refuses, bare key or term |
| `punctuation-term` | Punctuation only | warn | an unquoted term with no letter or digit, usually a second `?` |
| `unbalanced-parens` | Unbalanced parentheses | warn | the counts differ; it still parses |
| `all-zero-weights` | All weights zero | warn | every term weighted 0 |
| `flag-on-pattern` | Literal regex | warn | `=` or `^` before an unquoted `/…/flags`, which lexes as a flagged literal |
| `regex-decomposed` | Decomposed accent | warn | a pattern holding a base letter plus a combining mark, which the NFC text never matches |
| `regex-core-refuses` | WA-only regex | info | a pattern core reads as literal text: an unescaped `/` inside, or a flag core lacks |
| `optional-inert` | Null term | info | an optional conjunct under a negation, where it changes nothing |

### Selective logic (`keysecondary`)

Core's `(key, keysecondary, selectiveLogic)` is one expression per primary key, built by `synthesizeSecondary` and evaluated by `selectiveEval` inside `keywordScore`:

| logic | expression |
|---|---|
| `AND_ANY` (0, and any unknown value) | `AND(p, OR(s1, s2, …))` |
| `NOT_ALL` (1) | `AND(p, NOT(AND(s1, s2, …)))` |
| `NOT_ANY` (2) | `AND(AND(p, NOT s1), NOT s2)` |
| `AND_ALL` (3) | `AND(p, AND(s1, s2, …))` |

Blank secondaries are dropped; none means no gate; `selective: false` switches the list off. A plain secondary becomes a quoted `TERM` with the entry's flags, a `/re/` a `REGEX`, a `?` key its own subtree. A secondary scores like any term, so a gate that should not score is written `::0`. A negation-only secondary is refused under `AND_ANY`, where an OR branch satisfied by absence would never gate.

## Matching — `countKey` (`matcher.mjs`)

`countKey(key, text, caseSensitive, wholeWords, scope, gateAst)` returns occurrences for a plain or regex key and the weighted score for a SmartKey, 0 for no match; a matched expression with no weight counts 1.

**The fold** (`automaton.mjs`) is `normalizeOrthography` then lowercase: apostrophe variants to `'`, double-quote variants to `"`, em dash to `--`, en dash to `-`, ellipsis to `...`, non-breaking space to a space, and NFC. The CJK brackets stay out. A key's hyphen is also tried as a space (`keyVariants`), one way only, and not at a key's edge.

**A regex key is case-sensitive and fold-exempt except for NFC**, running on the raw text as core's does.

**Markup is masked for every literal matcher** (`maskMarkup`): a tag or HTML comment becomes spaces, one per character, so offsets still index the source. A regex sees the raw text and is the only route to a tag.

**Whole words** apply at both edges, multi-word keys included. The boundary class is the `wordBoundary` setting: `permissive` is letters, digits and marks; `strict` (default) adds hyphen and apostrophes. A doubled hyphen is always a boundary; `_` never is. Scripts without word separators get no carve-out; `wholeWordAdvice` warns that the flag cannot match inside running text there.

**The match window** (`matchWindow`, `scan | message | paragraph`) is where WA stops concatenating, for every rule: `scan` one segment of the joined messages, `message` one per message, `paragraph` split on a blank line and at a block element's edge (`BLOCK_TAGS`). Match sources and injects are each their own segment. A regex `^` and `$` are segment-relative. A unit's occurrences sum across segments and saturate once.

**The match scope** (`createScanScope`) is the context a key matches in — its macro map and `wordBoundary` mode — together with every cache built under them: the term registry, the automaton, the parsed keys and the scans. A context is never changed under its caches, and another context is another scope. Every matching call takes one and throws without it (`requireScope`), so no call has a context it was not given. A call that fills a scope with a whole book or chat (`buildKeyPruneScan`, `countChatHits`) is handed a fresh one. A scope refuses an unknown mode, the setting being reset at load (`ensureSettings`), and a parsed key's nodes carry its mode, a node without one throwing rather than matching as strict. The eval harness takes the mode from the capture's record and refuses a capture without one unless given `--assume-strict`.

**The prescan.** `registerKeys` interns every literal key's variants into an Aho-Corasick automaton per scope, and `primeScan` scans each segment once. `cachedCount` answers a plain key from the cache: 0 is final under any flags, a positive count final only for plain substring matching; a flagged key verifies with `wholeWordRegex`. A SmartKey term the prescan did not find is refused without a walk.

**Dropped chat elements** (`dropTags`, `dropChatTags`): each named element is removed with its content from every message WA reads, at intake. An unclosed element runs to its parent's close or the end.

### Scoring units

`evaluate` returns `{ matched, scoreBoost, units, logWeight }`. A unit is one thing the key is about, `n` occurrences carrying `wsum`. A TERM or REGEX is one unit at `weight x n`; `AND` yields both sides' units; `OR` pools its sides into one; `XOR` yields the matched side's; `NOT` yields none. A group weight multiplies `wsum`, never `n`, and a unit weighted to 0 is dropped, so an all-`::0` key activates without scoring. `logWeight` is the matched expression's: `ln(weight)` for a TERM or REGEX, summed by `AND`, the larger matched side for `OR`, the matched side for `XOR`, plus a group weight's `ln`; 0 for `NOT`, `::0` and an unmatched optional. `keywordScore` pools units by identity across the window and credits each as `weight x repeatCurveOf(n)`: `presence-log`, `1 + R ln(1 + (n-1)/k1)`. A ubiquitous key is not discounted here; it is the audit's business.

### Witness spans

`keyExcerpts`, `keySpans` and `keyHits` report where a key landed, for the Lab and the Studio. They walk the AST's leaves rather than `evaluate`'s units, so a failed key still shows the branch that hit. A negated leaf is reported with `negated` set and no offsets. `mergeSpans` folds overlapping spans. Offsets index the NFC text.

## Stage 1 — Retrieval

`retrieve` builds the query from the newest `messageDepth` messages with content (`world_info_depth` when unset), macros substituted, joined as `name: text` blocks (`query.mjs`), with the embedding model's instruction prefix (`relevance.mjs` `PREFIXES`).

`syncWorld` chunks every enabled entry with content (`chunking.mjs`) into the collection `wa_<hash of book name>`, one row per (text, uid), inserting new chunks and deleting stale ones. A chat-bound book whose collection is empty first asks the plugin's `/adopt` to copy rows other collections under the same source and model hold for the same hashes, and embeds only the rest. Generation-path fetches time out at ten seconds; the bulk insert and `/adopt` at five minutes, as hang detection only, since the server finishes the write regardless.

`queryCollections` asks the plugin's `/query-multi`: every chunk of every attached book scored by cosine against the query, both centred on the collection's centroid (the memory tier's chunks, or every chunk when a book has none), pooled to the best chunk per entry and cut at `admitCeiling`, 1000 entries. Without the plugin the request goes to ST's `/api/vector/query-multi`, which neither centres, pools nor scores, so K counts chunks and stage 3 has no cosine. Admission is the returned chunks' owners on both paths; only the cosine column differs. Only `vectorized` entries are retrieval winners; every scored entry keeps its cosine in `runState.lastScores`. A retrieval failure costs every entry its cosine; keyword matching and constants are unaffected.

A plugin route that errors, or answers without a field the extension reads, takes the no-plugin path for that call, and `pluginFallback` announces it once per load. Only fields a reader consumes are checked.

The plugin (`plugin/server.js`, `scoring.mjs`, `vector.mjs`) caches an index's items and mean on the file's mtime and size; `scoreCollection` is mean-centred cosine, `poolEntries` keeps the best chunk per entry, `selectTopK` cuts.

## Stage 2 — Activation

Three routes reach core's `activated` map: WA's force-activate, `constant` and `@@activate`, and sticky persistence. Core keeps every gate, the timers, recursion control and prompt assembly; WA replaces one question, *did a key match*.

**The seam.** Core checks `getExternallyActivated` after `@@dont_activate` and before constant, sticky and key matching, so disable, triggers, character and tag filters, delay, cooldown, `delayUntilRecursion` and `excludeRecursion` run first and the probability roll runs after: a forced entry inherits them all. WA emits every entry whose keys match and lets core refuse, except that it pre-checks `delay` itself so its captures do not list an entry core would drop. With core's matcher blanked, an entry WA does not emit has no other route in.

**`keywordActivations`** fetches the candidates with live keys, registers every usable key and secondary, and calls `activationAdds`: an enabled, non-constant entry without `@@dont_activate`/`@@activate`, past its `delay` and every activation gate it carries, activates if `keywordScore` reports any hit in its window, and a fired `@@keep_activate_after_match` entry with none. The window (`makeWindowFor`) is the chat minus `is_system` messages at depth, plus every `scan: true` extension prompt that is ambient or placed inside the depth, plus the sources the entry opted into, each its own segment.

**Depth.** `messageDepth` replaces `world_info_depth`, which is the fallback when the setting is unset. A per-entry `scanDepth` wins; `scanDepth: 0` matches nothing from chat and keeps ambient injects.

**Recursion and min-activations** (`feedScanLoop`, each `WORLDINFO_SCAN_DONE`). Activated entries are never rescanned. With `world_info_recursive` on, each pass's newly successful entries minus `preventRecursion` ones append their content to the recursion buffer; a min-activations pass widens WA's depth by one message instead, as core's `advanceScan` does. Unmatched candidates are rematched over the chat plus the buffer, and an add is stamped with its pass (`waTriggerDepth`). Core schedules every pass.

## Stage 3 — Scoring (`onScanDone`)

Every activated entry becomes a row, `score` its stage-1 cosine if it had one. With `dropUnavailable`, a memory entry whose STMB range postdates the current message is deleted first.

**Text.** `contentTextScores`: BM25 (`lexical.mjs`) of the query over every enabled entry's content, chunked as `syncWorld` chunks and max-pooled per entry. The entity filter picks the query terms: a token survives if it is capitalised mid-sentence or in the gazetteer of every authored key, secondary and title, capitalised ones weighted `properNounBoost`, and terms in more than `stopwordDocFreq` of chunks are dropped. The per-book index is rebuilt when `indexFingerprint` moves, a sum of per-entry hashes over world, uid and content.

**Keys.** Each row's keys, live or stashed, are scored by `keywordScore` over its window plus the recursion buffer, minus the entry's own content, and not at all for an `excludeRecursion` entry. The score is divided by `1 + waTriggerDepth`; the curve is an assertion. No shipped fit reads the column.

**The relevance column** (`scoreRelevanceColumn`). `properNouns` is the sum, over names the entry shares with the window, of `log((N+1)/(df+1))`, df counting the book's entries with content, disabled included. `density` is names per hundred tokens of the entry. `E[credit]` comes from a fitted logistic model per tier (memory or reference, by `isMemory`), `extension/relevance-model-<tier>.json`, keyed by embedding model, over the fit's own `features`. Each feature is standardised within the turn over the fit's recorded population, because no feature has a fixed scale; `E[credit]` is therefore conditional on the turn's pool (F24). `E[credit] = 0.5 P(>=2) + 0.5 P(>=3)`, `P(>=3)` clamped to `P(>=2)`. A model with no fit of its own scores through `UNFITTED_FALLBACK`'s; a pass with no cosine through the file's `noCosine` fit. A tier with no model is not scored, and an unscored row is kept.

**Term weights** (`layout.mjs` `weightedCredit`). The fit never reads a term weight: a weight is the author's assertion. `keywordScore` returns an entry's `logWeight`, the strongest over every key and segment that matched, read over the keys column's window and undivided by trigger depth. `weightedCredit` adds it to `E[credit]`'s log-odds, so `::2` doubles an entry's odds in every turn and an entry without weights scores exactly `E[credit]`. It is `relevanceCut`'s score and the layout's; a capture records `E[credit]` as `score` and the multiplier as `weight`.

**Layout** (`layout.mjs` `layoutOrder`). Rows are classified durable first: armed sticky, or a fired `@@keep_activate_after_match`; then constant (`isConstant`: the flag or `@@activate`); then promoted (`waPromote`); then dynamic. The scored blocks sort by weighted credit, unscored rows last, then authored order; `sequential` book priority makes the book tier the primary key, `interleaved` scales the score by the book's weight and shifts authored order by its offset. Durable blocks sort by authored order. This is the layout order (`runState.lastLayoutOrder`).

## Stage 4 — Selection

`selection.mjs` `relevanceCut`, over the dynamic block only: a row whose weighted credit is below `relevanceCutoff` is deleted from core's map. The cutoff is one setting for every model and both tiers, never the fit's own `cutoff`, because `E[credit]` is calibrated across embedders (E4). A row with no finite score, or whose tier has no fit, is kept.

**`@@promote`** exempts an entry from the cut, not from capacity: the author declaring activation sufficient. It is matched exactly where core's decorator test is `startsWith`, and the stored book keeps the line.

## Stage 5 — Delivery

`delivery.mjs`. `walkOrder` is constants, armed stickies, promoted, then dynamic, so every cap is a prefix cut of the layout order. `applyBudget` walks it once:

- **Token budget:** the tighter of `maxTokensPercent` of the max prompt and `maxTokens`, 0 off. An entry past the budget is rescued once or every time (`budgetSlackMode`) when it fits within `budgetSlackPercent`. An `ignoreBudget` entry, by the author's own value, is neither capped nor counted; with `maxTokensIncludesExempt` its tokens still come off the budget.
- **Entry caps**, 0 off: `maxTotalEntries` over every counted entry; `maxDynamicEntries` over the dynamic block; `maxVectorEntries` over dynamic plus promoted rows carrying `vectorized`; a per-book `cap` over dynamic plus promoted.
- A blocked entry is skipped, not stopped at; a skip after the last admission is marked `tail`.

Survivors stay in core's map. The **prompt order** is one sort of the survivors by `presentationOrder` (any `SORT_FNS` key, or `best-first`/`best-last` on the weighted credit), grouped by tier under `presentationTiered` and by book tier under `sequential`; each survivor's `order` is rewritten to its index, since assembly sorts by `order`. The delivery panel reads `runState.lastPromptOrder`, `lastSkipped` and `lastBudget`.

## Divergences from ST core

Every difference between WA's matching and core's; a divergence that routes around a core defect cites its `upstream-st.md` number.

- **The fold.** Core only lowercases; WA folds orthography first and tries a key's hyphen as a space. On the substring path WA is a strict superset.
- **NFC** on the regex path, where core runs raw.
- **A regex is fold-exempt**, and the audit says so (`regex orthography`, `keyword-suggestions.md`) rather than rewriting it.
- **Whole-word applies to multi-word keys**, where core's check is a no-op for any key with a space (`upstream-st.md` #1).
- **Whole-word stops at an affix in both directions**, with a Unicode boundary class; core's `\W` test lets `Joe` match `Joe's` (`upstream-st.md` #1).
- **A macro in a pattern is inserted escaped**; core inserts it raw.
- **Markup is masked** for a literal key; core matches inside tags.
- **A scanned inject is bounded by the window it was placed in**; core appends every `scan: true` prompt outside its depth slice (`upstream-st.md` #16).
- **A `/re/` with an unescaped `/` inside, or a `d` or `v` flag, is a pattern here**; core matches the delimited string as literal text. `coreReadsAsRegex` mirrors core's rule for the `regex-core-refuses` note.
- **`?` keys never match in core**, which treats them as literal needles, so a SmartKey book loads in a stock install and matches nothing.
- **`splitKeys`** keeps a `/regex/` written straight after a comma, which core's `customTokenizer` loses (`upstream-st.md` #17).
- **Recursion off runs no recursion pass.** Core still forces one per `delayUntilRecursion` level; WA ends it on a scan it owns (`upstream-st.md` #19).
- **`messageDepth` supersedes `world_info_depth`**; a per-entry `scanDepth` still wins.
- **Entry flags do not reach a SmartKey or a pattern.**
- **The match window** segments the haystack; `scan` is core's behaviour.
- **Dropped chat elements** are removed before matching.

Settings, their defaults and which are internal are `extension/state.mjs` `defaultSettings` and `INTERNAL_KEYS`. `tierCfg` is the exception: unset until the tier editor writes it, and filled by `reconcileTiers`.
