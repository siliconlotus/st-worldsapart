# Matcher and activation — decisions and open work

Companion to `keyword-suggest-design.md`, which owns the *suggester*. This owns the *matcher*: how a
key is matched, the SmartKeys grammar, and the plan for WA taking over activation.

Rules and open items only. The arguments that produced them are in the commit messages and the module
headers; do not restate them here.

---

## Principles

These decided most of the individual calls below, and are worth applying before re-deriving anything.

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

**Correctness that depends on knowing the language belongs in the reviewed layer.** The matcher is
silent, so it must be language-neutral. The suggester is reviewed by a human before anything is
accepted, so it is where a judgement like "is stripping this accent safe" can live. Hyphens pass that
test (a compound is a compound in any language that hyphenates); accents do not (`du`/`dû`).

**The sentinel is `?` because a key does not plausibly start with one.** Every other punctuation call
in the grammar resolves toward the literal — `*` and `~` are text, a single colon is text, `+` is
absorbed — and a leading `?` is the one place that trade is deliberately reversed. **Measured**, books
on disk: 147 of 46,230 keys start with `?`, across 6 books, and all 147 validate clean, so none is an
accidental prefix that merely happens to parse. Only the FIRST character is the sentinel, so an
interior or trailing `?` is ordinary text and `what's up?` is a plain key. Accepted cost: a literal key
that did start with `?` would be read as a SmartKey rather than a phrase, which both changes what it
matches and overweights it — `? what's up?` scores its two bare terms separately rather than the
phrase once.

**Quoting is the single escape.** It suppresses operator, weight, paren and wildcard interpretation and
marks a punctuation-only term as deliberate. One rule to learn, not four. Quoting a single term never
changes what it matches; quoting *across a space* does, turning a conjunction into a phrase.

**Validator checks read structure, not intent.** Every check that guessed at what an author meant
produced false positives on legitimate literals — `"()"` is a real album, `M*A*S*H` is a real title.
The checks that survive are facts about the SmartKey: no terms, no positive term, an unclosed quote,
unbalanced parens. A key that expected a feature WA lacks is dead, and the audit reports it as dead
from the evidence.

**Divergence from core is free where WA owns activation, and costly where core owns it.** While core
activates, every matcher difference makes the Studio's audit report on rules that are not what fires.

**An unaltered lorebook behaves under WA as it does under core.** Least surprise: every divergence is
a named fix for a core defect (the `\W` boundary class, `upstream-st.md` #1) or a named WA semantic
(the fold, `messageDepth`, the match window) — never an incidental difference. Authored per-entry
intent survives the takeover: `scanDepth` still wins over every global, `scanDepth: 0` still means
"match nothing from chat", `@@dont_activate` is never overridden by the union, `@@activate` is never
revoked by the prune, and a forced entry still takes core's probability roll.

**Two tiers of relevance, and only one is rankable.** A keyword-activated reference entry is relevant
because its trigger fired — *triggered == relevant*: the author declared the presence conditions in
the keys, so activation IS delivery, and the only judgement left is whether the trigger deserved to
fire. A memory entry is relevant because ranking chose it. Consequences, decided in the fullbook audit
(`eval/eval-data/shared-metrics/FULLBOOK-AUDIT-2026-08-10.md`, enforced in `eval/scene.mjs`
`scoreScene`): ranking metrics REMOVE reference entries from the ranked list before computing —
removed, not zero-graded, or the ranker is punished for routing's job — while set metrics (recall,
F@budget) count them fully, and keyword-weight contrasts are routing decisions readable only there;
nDCG cannot see what they are for. The tier label is provenance, never routing configuration: an entry
is memory iff STMB-marked (`stmemorybooks`/`STMB_start`), because provenance cannot drift with the
configuration under evaluation, where `vectorized`/`sticky`/`constant` all can. What a graded sample
measures on the reference tier is the KEYS, in three divergence classes with three different fixes —
key miss (suggester), window miss (depth/persistence, bucket 1.5), over-fire (prune) —
`eval/divergence-audit.mjs` is that tool, and its header carries the fuller statement.

---

## Status

**Bucket 1 — matcher and SmartKeys: done.** Parser bugs, the `::` weight delimiter, the validator, the
Studio save gate, the audit change, `weight × count` scoring, the Lucene aliases, and `SMARTKEYS.md`
carrying both halves — the grammar, and the matching behaviour that had no user-facing home. Regex
terms closed the last of it: `REGEX` is a node, `regexLiteral` is the ECMA-262 scan under a
qualifying-close rule that makes a term read as the whole key reads, and `regex-invalid` is the check
it added.

**Bucket 1.5 — SmartKeys activate: implemented.** Union (`selectAndActivate` → `activationAdds`),
prune (`rankActivated` → `activationPrunes`), the scan-haystack stash, and the sentinel
certifications (uids 7–14). Bucket 2's first increment rather than an alternative to it: every
piece carries over unchanged.

**Bucket 2 — WA owns activation: implemented and complete**, behind `ownActivation` (default on). On a scan WA
intercepts, every keyword-activating entry's keys are stashed and blanked at `WORLDINFO_ENTRIES_LOADED`,
so core's matcher never fires and the inclusion-group filter runs over WA's verdicts. `feedScanLoop`
answers each later pass. The group asymmetry and the recursion-buffer residual are closed by that
ordering, and the failure path now reports visibly (`reportFailure`). The `keysecondary` conversion
landed last and took `secondaryOk` with it. Key-side variant expansion is the one thing named here
that was never scheduled, and it is not owed to anything.

**Match window — implemented** (`matchWindow` setting, `matcher.scanSegments`/`segment`), and independent
of bucket 2 except where noted.

**Match Whole Words — implemented.** The multi-word exemption is gone from `countKey` and its cached
fast path; the boundary class is the `wordBoundary` setting (`matcher.setBoundaryMode`/`wordChar`,
default `strict`), which `=` terms inherit through the same function; `_` left the class; and
`matcher.wholeWordAdvice` is the Studio's structural flag, shown on the whole-words tool.

---

## The queue is empty

Nothing in this doc is decided-and-unimplemented. When it refills, order it by whether a user can see
the difference — not by how tidy the fix is, and **not by how many instances the books on disk hold**.
A permitted input occurs whether or not this author has written one; corpus counts size a known effect
and never dismiss a case.

`SMARTKEYS.md` describes what WORKS, so it must not be written ahead of the code — and it must not lag
behind it either. It claimed "SmartKeys rank, they do not yet activate" through the whole of buckets
1.5 and 2, because a page that describes behaviour goes stale silently: nothing in the suite reads it.

---

## Bucket 1.5 — SmartKeys activate, and WA's matcher may add

Core's `matchKeys` treats `? …` as a literal needle, so **an entry keyed only on SmartKeys never
activates**. Today the grammar is a stage-3 signal that re-ranks what got in by other means and can
admit nothing. Measured: 2 such entries of 3,403 keyed entries on disk, so the exposure is small and
the defect is not.

WA force-activates on its own matches, from the `allEntries` it already holds at intercept. **Zero
divergence risk, because core has no semantics for `?` to diverge from** — the union can only add,
which is why this does not wait on bucket 2 and why `C17` does not block it.

Generalises to any key WA matches and core cannot: `fold` is `normalizeOrthography` then lowercase and
core's `#transformString` only lowercases, so for the default substring path WA is a strict superset.
What that leaves for the seam is accounted under `C17` in bucket 2, not here.

**Guards.** Skip keys whose `validateSmartKey` returns an `error` — `negation-only` is advisory only
while these cannot activate, and stops being so here. Honour `suppressVectorKeys`, the same stage-2
guard `makeCandidateSet` needs.

**Deletion is the other half, and it is not symmetric with never-activating.** WA may also remove from
`args.activated.entries`; `applyBudget` already does, and core documents the mutation as supported.
That closes the `matchWholeWords` direction, where `WORD_CHAR` and core's `\W` diverge both ways and a
union is powerless — core's side of that divergence is a defect, `upstream-st.md` #1. But
`filterByInclusionGroups` runs **before** the `WORLDINFO_SCAN_DONE` emit and discards the losers, so
deleting a group winner leaves the group unrepresented, where a matcher that answered "no match" up
front would have promoted a loser.

**Ruled: deletion ships with no group guard; a deleted winner leaves its group empty for that turn.**
Transient until bucket 2, whose matcher-before-group-filter ordering removes the case — CLOSED there,
and reachable now only with `ownActivation` off. The gap is
reachable from outside, only expensively — verified in `world-info.js`: the SCAN_DONE emit documents
adding entries as well as removing them, force-activation does not bypass the group filter (forced
entries join `activatedNow` and are filtered with the rest), and probability rolls run after group
filtering — so promoting a discarded loser means WA mirrors both the group tie-break and the
probability roll. Bucket 2 makes that machinery unnecessary; 1.5 does not build it. Measured 0 of
2,112 enabled entries in a group, so the behaviour is untestable without a fixture; the sentinel's
`terrace` group (uids 8–9) is that fixture, and certifies the group-empty outcome.

**Measured** (`eval/prune-audit.mjs`, 8-chat standard corpus, core depth 4 / `messageDepth` 10):
the prune fires on 319 of 115,527 core keyword activations (0.28%; 115 of 87,255 at core depth 2),
all `segmentation` — secondary-keyed entries whose primary and secondary co-occur in the buffer but
not in one segment — from 3 entries in 2 books. Zero boundary, zero depth, zero unexplained. Upper
bound: sticky exemptions are not modeled offline.

**Residual, by core's ordering:** a pass's activated content joins the recursion buffer before the
`SCAN_DONE` emit, so a pruned entry's content still drives that scan's recursion pass — entries it
recursively activated survive. Unreachable from outside the seam (the buffer is not in the event
args). The union has the mirror limit: it feeds only the initial pass, so a SmartKeys-only entry
cannot match recursion text in 1.5. Bucket 2 closes both the way it closes the group gap — the prune
does not run at all on an owned scan, since every activation there is WA's own force, constant, sticky
or another extension's, and `feedScanLoop` matches each pass's recursion text directly.

**Activation depth is WA's setting. Ruled**: when WA runs, `messageDepth` governs key matching;
core's `world_info_depth` is superseded, not consulted — a WA user tunes WA's setting. Stage-3
scoring already resolves depth this way (per-entry `scanDepth`, then `messageDepth`); this extends
the same resolution to activation. The stakes are highest on a keyword-only book, where the
activation window is the book's entire memory horizon — retrieval cannot recover what the scan
missed, so core's depth was a recall floor no key curation could raise. The union path implements
the common direction: WA matches at its own depth and force-activates, and core's shallower matches
are a subset. A `messageDepth` set *narrower* than core's depth is the deletion direction, and
inherits the inclusion-group caveat above.

## Bucket 2 — WA owns activation

Core keeps the gates, the timers, recursion control and prompt assembly. WA replaces exactly one
question: *did a key match*.

**WA owns its failure states. Ruled**: once WA answers that question, there is no per-turn fallback
to core for matching — a silent fallback makes match semantics flicker between two rule sets
depending on whether an exception happened, with the audit reporting on rules that are not what
fired. A matcher failure fails visibly. (Bucket 1.5's "falling back to core behavior" catch in
`selectAndActivate` is legitimate only while core still owns matching — it does not survive the
takeover.)

**The failure path honours it — done.** WA still takes ownership when its matcher throws, which is
correct: the realistic trigger is the ST surface (`getSortedEntries`, the inject API, the
`world_info_*` globals), not a key, so handing matching back would hand it to a path that may be
equally broken and would make behaviour on an ST upgrade depend on which integration failed first.
What was missing was visibility, and `reportFailure` supplies it — stage, consequence in plain terms,
the error message and the top stack frame, once per distinct message per session so a per-turn toast
cannot train the user to dismiss it. Two severities, because the halves differ: retrieval failing is a
degradation (keys are still handled), keyword activation failing is total. The old catch asserted
"core scan still applies", which bucket 2 had made false.

**The seam.** `getExternallyActivated` is checked inside core's scan loop, after `@@dont_activate` and
before constant/sticky/key-matching. Every other gate — disable, triggers, character and tag filters,
delay, cooldown, `delayUntilRecursion`, `excludeRecursion`, decorators — runs *before* it, so
force-activation inherits all of them rather than bypassing them. `WORLDINFO_FORCE_ACTIVATE` is the
supported way in, and WA already emits it for vector winners.

**Constants and `@@activate` entries keep their keys** when the takeover blanks the rest. Core
short-circuits both before its key-matching path, so live keys there cannot leak a core keyword
activation — and `filterGroupsByScoring` reads `entry.key` via `getScore`, so blanking them would make
a grouped constant score 0 and lose ties it should win. The other group classes need nothing: sticky
winners skip scoring entirely (`filterGroupsByTimedEffects`), and every keyword-activated entry reaches
the filter as WA's own live-key copy through the external-activation map.

**Recursion is solved, not blocked.** `WORLDINFO_SCAN_DONE` fires after *each* scan loop, not once at
the end, and its args carry `activated.text` — the accumulated recursion buffer. WA evaluates against
chat + recursion text and emits `WORLDINFO_FORCE_ACTIVATE` for anything newly matched.

**WA does not write `state.next`.** Core already schedules every pass WA can feed: a pass with
recursion-eligible successes sets RECURSION, open delay levels set RECURSION, min-activations sets
MIN_ACTIVATIONS — and WA only ever has something new to emit in exactly those cases, since its matches
come from that pass's content or that pass's widening. The field is writable; nothing here needs it.

**WA emits blindly and lets core reject; ONE stamped field settles the loop.** `waMatched`, set on
first hit and never recomputed. A second field holding the delay level was designed and is not needed:
`WorldInfoBuffer.externalActivations` is a static map cleared only at scan end (`resetExternalEffects`),
so a single emit stands for the whole scan and core re-checks it every pass — which is how an entry
refused at one delay level is admitted at a later one, with no retry logic on WA's side. WA therefore
models none of core's gates. **The sticky flag is correct because the haystack only grows**: `addRecurse`
appends and `#skew` only widens, so a verdict goes false→true and never back, and core does not revoke
activation either.

**Min-activations is mirrored by widening, not by re-reading.** Core advances its own scan one message
per min-activation pass (`advanceScan`/`#skew`); WA adds the same offset to its resolved GLOBAL depth
(`activationAdds` `depthSkew`). A per-entry `scanDepth` is authored and never skewed, as in core, where
the buffer skew only moves the default window. Ruled, not measured — with core's keys blanked this feed
is the only thing a min-activation pass can pull from, so the alternative is that the widening does
nothing.

**Scan each pass's new content; retain no text.** At `matchWindow: 'scan'` read core's own
`args.activated.text` instead — one segment either way, and both join with `\n`, so it is core's exact
haystack and the cross-pass conjunction cannot diverge. Otherwise segment per entry, which is
`keyword-core.mjs`'s existing loop pointed at a different array. **Filter `preventRecursion` out first**:
`args.new.successful` is the list *before* that filter, and core builds the recursion buffer from the
list after it, so using it raw restores the propagation the flag exists to stop.

**Inherit `world_info_recursive`.** WA must check it before matching recursion text at all, or it
activates on content a user who disabled recursion never wanted scanned. The token budget is the
opposite case and is not inherited — WA supplants it (see `worldsapart.js` `onEntriesLoaded`).

**`keysecondary` — converted. `secondaryOk` is gone.** Core's `(key, keysecondary, selectiveLogic)`
is answered by ONE expression per primary key: `synthesizeSecondary` builds the AST,
`countSelective` evaluates it, `keywordScore` is the only caller. The rival evaluator was the reason
to do it — one-matcher covers selective logic as much as key matching — and the string route was
never the survivor, because it could not carry the entry flags: `countKey` returns from its `?`
branch before it reads them. **Measured** population, books on disk: 79 entries of 2,112 enabled
(3.7%) across 14 books, 77 of them `AND_ANY`.

**Synthesis builds the AST, not a string, and that is why it has no refusals.** Every one was an
artifact of emitting a `?` string the lexer then had to read back. A key containing a double quote
needs no escape, because a `TERM` node carries it verbatim and nothing lexes it. A `?` key parses and
splices in as a subtree. A `/regex/` key is a `REGEX` node — and **ST core does permit regex in
`keysecondary`**, so that is the class that decided whether `secondaryOk` could be replaced at all.

Entry flags are stamped on the synthesised nodes as `isCaseSensitive`/`isExact`, and a spliced `?`
subtree and a `REGEX` node carry their own. Secondary nodes carry weight 0 (`zeroWeights` reaches
into a spliced subtree, or the author's own `::5` would leak), so the conversion is score-neutral by
construction: `AND` and `OR` both sum.

Behaviour-neutrality also **depended on the whole-words change landing first**. A synthesised `TERM`
has never had core's multi-word exemption, so while `countKey` did, a multi-word key gated by a
secondary would have scored on different rules than the same key ungated.

`eval/synthesis-check.mjs` is now the written-down case table the doc asked for. The 16,000-comparison
fuzz went with `secondaryOk`: it was not an independent authority, only a second WA implementation of
core's rule, and it never caught the flag defect because it only ever ran with both flags off.

Selective logic already inherited `matchWindow` scoping before the conversion and still does — the
scoping comes from the call site, `keywordScore`'s per-segment loop, not from which evaluator runs.

**Then the key-side variant expansion** that bucket 1 deferred, since it is only safe once WA's rules
are what fires: hyphen ↔ space (compounds are written both ways, and prose picks per term, not per
book), and wildcards if they ever earn it. Quoting suppresses generation.

**`C17` dissolves here** rather than being fixed. The matcher already diverges from core on
orthography, NFC and Unicode word boundaries; while core activates, that means the audit reports on
rules that are not what fires. Once WA activates, WA's rules *are* what fires. There is no third form:
the alternative is surrendering the fold, which the first principle rejects on purpose.

Bucket 1.5 closes the orthography half. What is left for the seam is `matchWholeWords`, where core
fires and WA would not. **Measured**, one corpus, as an upper bound on that half: 9 keys of the 1,229
containing quote or hyphen characters match under WA's fold and not under core's lowercase, unioned
over 177,499 usable messages — so a whole corpus, not a scan. It sizes one person's exposure and not
the defect; consistency is the reason to close it, and that reason does not shrink with a bigger corpus.

**Scope: WA-run generations only.** ST skips generation interceptors for its dry runs (PromptManager
token counts, chat load), so WA is never offered those scans and they keep core's matcher — which is
correct, since a dry run with no WA union behind it would otherwise assemble a keyless prompt. Quiet
generations (Summarize, image prompts, the LLM expression classifier) ARE ordinary generations here and
get the takeover like any other; they were previously skipped, and that skip was WA's own choice rather
than an ST constraint.

**Decorators are read off `entry.decorators`, not `content`.** `getSortedEntries` runs `parseDecorators`
and strips the `@@` lines out of content before WA sees an entry, so a content-scan finds nothing at
runtime. Both guards were inert: the union's `@@dont_activate` check (harmless — core's own gate order
still refused the force) and the prune's `@@activate` exemption (not harmless — a keyed `@@activate`
entry whose keys missed the window could be pruned). `hasDecorator` now prefers the array and falls
back to the content walk for raw entries and fixtures; `eval/activation-check.mjs` pins both shapes.

---

## Entry flags reach plain keys only

**Ruled: a `?` or `/re/` key is self-describing.** `caseSensitive` and `matchWholeWords` are entry-level
defaults for plain keys; they do not reach inside a SmartKey or a pattern. `? nasa` in a `caseSensitive`
entry is still insensitive, and `? ver` in a `matchWholeWords` entry still matches `never` — an author
who wanted boundaries would have written `? =ver`.

The reason is expressiveness rather than symmetry. The grammar has `^` and `=` and no inverse of
either, so an entry flag winning over an unflagged term would leave "insensitive here" and "substring
here" unwritable, and `^` a one-way ratchet that can add strictness and never remove it.

**Ruled: whole-word applies to multi-word keys too.** Core exempts them — it splits the key on
whitespace and uses `includes()` — so *Match Whole Words* is a silent NO-OP for any key with a space
in it, which is the same shape as the `\W` boundary bug rather than a considered semantic. A named
divergence, `upstream-st.md`. The `=` flag was never constrained here: it is WA syntax, so no unaltered
book can contain one, and mirroring core's exemption into `evaluate` would import the defect into a
feature no legacy key can reach.

The cost is a NARROWING of keys already authored, which is the expensive direction. **Measured**, books
on disk: 66 of 2,120 enabled entries tick the box AND hold a multi-word key — 430 keys, 10 books, and
the global default is off so the 1,711 entries that inherit it do not move. Of those 430, 24 narrow
against their own book's text, all of them the plural case (`satyr camp` no longer reaching `satyr
camps`). Book text is a floor; chat prose pluralises more.

**Plurals under permissive, plurals AND affixes under strict.** The two halves ship together, so the
narrowing an author sees is the strict one: `hot tub's` and `hot tub-side` stop matching along with
`hot tubs`. Under permissive only a letter or digit suffix breaks the match, which in practice means
a plural. The user-facing wording must name the mode rather than stating either as the rule.

**Measured** against `countKey`, both flags and all three key kinds: this is already what fires — the
`?` and `/re/` branches return before the flag arguments are read — so it ratifies behaviour rather
than changing it. The `keysecondary` conversion inherited the rule rather than restating it: a plain
key synthesises to a `TERM` carrying the entry's flags, while a spliced `?` subtree and a `REGEX`
node carry their own.

---

## Match Whole Words means what it says

**Ruled: the flag applies wherever "word" is defined, with no carve-outs.** Core under-applies its own
label twice — it skips any key containing a space, and it stops at an affix, so `Joe` matches `Joe's`.
The first is documented, but only in a parenthetical ("entries with keys containing only one word"),
and both surprise a reader of the label. WA applies it in both directions.

**The boundary class is a setting**, because both readings are defensible and least-surprise cuts both
ways. `permissive | strict`, default **strict**:

```
permissive  [\p{L}\p{N}\p{M}]         letters, digits, combining marks
strict      [\p{L}\p{N}\p{M}\-'’]     ...plus hyphen and both apostrophes
```

Strict is the default because **the escapes are asymmetric**. A regex key with `\b` recovers permissive
behaviour for any ASCII key — and `\b` is what core's own boundary approximates, so one escape hatch
returns both. From permissive there is no short form: strict needs the explicit class written twice.
Land in the mode that is cheap to leave. (`\b` fails for non-ASCII keys, as it does in core.)

**`_` leaves the class in both modes** — not part of the toggle. Underscore is in `\w` for programming
identifiers, and `_Joe_` failing has no defender under either reading. **Measured**, one author's chats
(178.8M chars of message text): 822 emphasis-shaped underscores against 1,156,063 asterisks, so this
corpus does not motivate it. Presets that instruct underscore emphasis do, and corpus absence is not
population absence.

**No CJK carve-out.** Whole-word in a script without word separators is an unanswerable request rather
than a WA failure, and ST's own docs advise against it. Such a key still fires where it appears among
Latin text or punctuation — the mixed-language case, a sign name or a tattoo in English prose — and
cannot fire inside a fully Chinese or Japanese sentence. The Studio flag says so; the matcher does not
guess. **Tibetan is out of scope and stays out of the trigger class**: the tsheg may function as the
separator the class is defined by absence of, so including it would flag a script that possibly does
not belong there. Han, Hiragana, Katakana, Thai, Lao, Khmer and Myanmar are the class; Hangul is not,
since modern Korean is spaced.

**Measured cost**, books on disk: 66 of 2,120 enabled entries tick the box AND hold a multi-word key —
430 keys, 10 books. The ST global is off, so the 1,711 entries inheriting it do not move. Under strict,
44% of whole-word keys lose occurrences, but saturation absorbs it (`Sara` 113→100 moves
`count/(count+k1)` from 0.9895 to 0.9881); 10 keys of 955 go to zero, all singletons; and **no entry
stops activating**.

**The documented contract is preserved exactly.** ST documents one example — `king` matches "long live
the king" and not "it's not to my liking" — and core, permissive and strict all reproduce it. Every
divergence here lives in territory core never described, which is why an unaltered book changing
behaviour is acceptable under the least-surprise principle rather than an exception to it.

---

## Regex terms in a SmartKey

**Decided on principle, and the corpus cannot adjudicate it.** Regex keys on disk: **2** of 46,226
keys, in 2 of 41 books (`/salar(y|ies)/`, `/^sons?$/`), neither carrying an internal slash; `?` keys
containing a `/` at all: 0 of 148. So every rule below rests on ONE SYNTAX HAVING ONE READING, not on
observation, and a count here can only size exposure — it can never be the reason for a call or the
reason against one. Worked examples in this section are demonstrations of a mechanism, not samples;
where a claim is genuinely measured it says so and names the measurement.

**Ruled: `/pattern/flags` is a TERM.** A `/re/` key is evaluated as a pattern everywhere else it
appears — core's `matchKeys` and `countKey` both branch on it — and the literal reading survives in
exactly one place, inside a SmartKey, where `tokenize` hands `evaluate` a bare word. Nobody chose that;
it is what fell out of a lexer that did not know regexes exist. So this closes a divergence rather
than adding a feature, and the literal stays reachable through the escape already there: `? "/re/"`
is one quoted term.

**A `/` opens a regex only at token start** — the rule `"` and `-`/`!`/`+` already follow. `and/or`
and `3/4` are untouched; only a token that starts with `/` reaches the branch. The branch sits after
the operator match, so `? -/re/` negates a pattern.

**Leftmost QUALIFYING close, tracking escape and character class.** `\` escapes the next character,
`[`…`]` is a class the delimiter cannot close inside, and classes do not nest (`/[[]/` is a class
holding `[`) — ECMA-262's RegularExpressionLiteral, which exists for this same ambiguity. A candidate
delimiter is accepted only when the body it delimits COMPILES and its flag run ends at a token
boundary; otherwise the scan continues. `\/` writes a literal slash.

Delimiter hunting alone is not enough, because `/` is both the delimiter and an ordinary character in
a pattern. Neither is drawing a token boundary first: `(`, `)` and `|` are simultaneously SmartKey
syntax and regex syntax, so splitting on them breaks `? /(rain|snow)/` and splitting on whitespace
breaks `? (/a/|/b/) x`. Scanning under regex-literal rules and letting the surviving candidate decide
needs neither classification up front.

**A TERM READS AS THE WHOLE KEY READS, and that is the point of the rule.** The plain-key test is
"the entire string is `/…/flags`"; when a term IS the entire key, the accept test above is that same
test. So `/home/user/lux/` is one pattern in both, `/home/user/file` is a literal in both, and
`? /(home/user|~/user)/file/` — a defensible key, matching either home form — is the pattern its
author wrote rather than an invalid fragment plus three stray terms. Verified across every form in
this section: the SmartKey reading equals the plain-key reading, string for string.

**The cost, accepted: an abutting term after a pattern needs a space.** `? /[/]/x` is now the literal
six characters rather than the pattern `[/]` and the term `x`. It is recovered by a space (`? /[/]/ x`)
or, better where adjacency was meant, by extending the pattern (`? /\/x/`) — the abutting form never
delivered adjacency anyway, only a conjunction that fired on any slash and any `x`. Keeping it would
cost `/home/user/file`, where core and WA's plain key already agree on "literal" and only the SmartKey
invented a pattern.

**No shape, no fault.** `regex-unterminated` and `regex-empty` are gone: `? /re` and `? //` are literal
terms, exactly as the bare keys `/re` and `//` are literal, so a fault there would have been the
divergence. `regex-invalid` survives, on the one case where the shape IS well-formed and the pattern
will not compile — which is also how `? /(/` stays the dead pattern the bare key is. Diagnostics are
richer inside a SmartKey than outside it (`punctuation-term` reaches `? //`), but no reading differs.

**Flags then weight** — `[gimsuy]*` after the close, then an optional `::N`, as a quoted term takes its
weight after its closing quote. **No `=`/`^` prefix on this branch**: `=` is meaningless on a pattern,
and `^` is a no-op because a regex is already case-sensitive. `/i` is how insensitivity is written.

**A pattern `new RegExp` refuses is a validator error** — a fact about the string, so it clears the
same bar the surviving checks clear rather than guessing at intent.

**A regex is a term for counting and for positivity.** `no-terms` counts it, and `hasPositiveTerm`
treats it as a positive contributor, as it does a spliced `?` subtree. The validator reads `TERM`
tokens alone today, so without this `? /re/` reports `no-terms` and `? /re/ -drill` reports
`negation-only` — both fatal, and `activatableKeys` bars a key that matches perfectly well. The checks
that inspect a term's VALUE still skip it: a pattern is punctuation by nature, so `punctuation-term`
and `stray-quote` would fire on every one.

**A regex term is case-sensitive AND fold-exempt.** `countKey` branches before `foldedHay`, so a
pattern runs on raw text, as core's does. Inside a SmartKey that means mixed folding: `? /Cap'n/ crunch`
has one term that sees `’` and one that does not.

**A path-shaped token reads as every other layer reads it**, which is what the qualifying-close rule
delivers: `? /home/user/file` is the literal string, because that is what the bare key
`/home/user/file` is and what core makes of it too. An earlier draft split it into a pattern plus a
stray term and called the change deliberate; it was neither core's reading nor WA's own.

**The evaluator grows one node.** `REGEX` carries the raw key and its weight, has no `acIndex`, and
skips pass 1 — structurally a `TERM` that never uses the candidate filter. It shares `countRegexKey`
with `countKey`, so `countKey is the only matcher` holds across the regex path too.

**A bare `/re/` key is WA's reading, not core's, and the gap is flagged rather than closed.** Core's
`parseRegexFromString` refuses a pattern whose delimiter appears unescaped inside it — its own comment
gives portability to other regex engines as the reason — and falls back to matching the whole
delimited string as literal text. `REGEX_KEY_RE` does not refuse it, so `/and/or/` is the pattern
`and/or` here and the literal `/and/or/` there. WA keeps its reading: core's refusal is an
implementation detail rather than a meaning, which is the ground every divergence in this document
stands on.

**The two readings are not symmetric, and that decides the message.** Core's fires only where the
whole DELIMITED string occurs — `/(home/user|~/user)/file/`, slashes and all — where WA's fires
wherever the pattern does. That is read off the two expressions, not sampled. Say it as the mechanism
and stop: core's reading CAN hit, so "does nothing" is a verdict about all prose, and an earlier draft
calling the two readings equally live was the same error inverted.

So there are four things an author can have meant, and only one wants anything done. Written for stock
ST as a pattern: core was silently dead and WA repairs it. Meant to evaluate under WA: it already
does. Meant as the literal delimited string: the hatch is the warning's second sentence. Meant as a
literal but authored before WA: same hatch. The message therefore leads with what WA does — leading
with core's reading framed WA as the deviant in three cases out of four — and `\/` is named nowhere
in it, because escaping serves core and nothing else.

**The warning is kept, and on a different footing than it was introduced with.** Bucket 2 removed the
first one: core no longer owns activation (`ownActivation`, default on), and this document's own
principle is that divergence is free once WA owns it. What it rests on now is LEAST SURPRISE — the
principle above requires every divergence to be a NAMED one, and this is where this divergence gets
named to the user whose expectations came from core. That reason does not expire, and does not depend
on the book travelling. It is an extreme edge case (0 keys on disk trigger it) and edge cases are
exactly what a user cannot be expected to predict.

Portability is the separate, practical half, and `SMARTKEYS.md` carries it as a conditional rather
than as advice on the warning: write a pattern with unescaped slashes and plan to port it to a non-WA
system, and you must escape them for vanilla ST to evaluate it. Escaping is free under WA (`\/` and
`/` are one character to a regex), so that is a choice about where the book will run, not a fix.

**The check is one-directional, and stays so.** It catches WA-yes/core-no. The mirror is real and
silent: a body containing a literal newline is a pattern to core (`[\w\W]`) and a plain literal key
to WA (`.`). Recorded rather than closed — a key field does not carry newlines — but the check does
not name every divergence, only the reachable one. `validateSmartKey` warns (`regex-core-refuses`) rather
than either side deciding. `coreReadsAsRegex` in `matcher.mjs` is core's rule mirrored for that
warning, and counts nothing. It reaches SmartKey TERMS as well as bare keys, since the term rule became
the whole-key rule — before that the scan cut a slash-bearing pattern apart before anything could ask
what core made of it. Both messages say what each side does and stop: WA runs the pattern, so there is
nothing to prescribe, and `\/` is a portability choice rather than a fix.

---

## Match window — the haystack is segmented

A setting, `matchWindow`: `scan | message | paragraph`, default `paragraph`. It selects **where WA stops
concatenating**, not an evaluator mode — `scanWindow` returns segments, and `scan` is the degenerate
one-segment array that reproduces today's behaviour exactly.

**Uniform across every matching rule.** SmartKey conjunctions, selective logic, all of it. `keysecondary`
is not a special case: it is evaluated per segment inside `keywordScore`, so it inherits the scope
from the call site, where pinning it to `scan` would need a per-key override nothing else wants — and would aim the
setting at the empty half of the population, since books have `keysecondary` and do not yet have
SmartKeys.

**Both signs scoped.** A negation is a segment-local veto. Whole-window negation carries the same
distance-blindness as whole-window AND and fails worse: `? fire -drill` is silently killed by a drill
five messages back, and a false negative never surfaces, where a false positive is a ranking
contribution that competes and loses.

**Primary keys are unaffected at any setting — except an anchored regex.** A single-word key's
occurrence count is slice-invariant and a multi-word key cannot span the `\n` join, but `keywordScore`
hands `countKey` one segment at a time, so `^` and `$` in a `/regex/` key are SEGMENT-relative.
`/^Doc/` counts 1 paragraph-scoped and 0 at `scan`, while `/^Doc/m` counts 1 either way. That follows
from the anchors: paragraph splitting happens at a blank line, which is a line boundary under both.
Ruled by the uniformity above rather than separately: `/m` is already the setting-independent form, so
exempting regexes from segmentation would buy nothing that is not writable. Authors want `/m` — at
`scan` a bare `^` anchors to exactly one position in the whole window. Everything else the setting
changes lives in selective logic and SmartKey conjunctions.

**Split, do not track positions.** Measured 1.01x for 8 segments against one join (200 patterns, 18KB,
n=2000), so `scanAutomaton` keeps its counts-Map return and `plugin/automaton.mjs` never changes — no
redeploy, and no window where the browser and server halves disagree. The scan cache keys segments BY VALUE, so two
entries segmenting the same window share every scan; `primeScan` raises the cache floor to fit the
window, since evicting a segment mid-pass sends the next entry back to the naive walk. Not
concatenating is faster than before at every setting including `scan`, because match-source
combinations stop re-scanning the whole window.

**Measured, one author's chats, n=1 (392 messages, 79 windows, 780KB):** message-scoping is near a
no-op — p90 is 19 paragraphs per message, and 81.6% of scanned text lives in messages of six paragraphs
or more. Paragraph is unambiguous in 96.2% of messages; the other 3.8% use single newlines only and
degenerate to message-scoped, which is never worse than today. Split on `\n[ \t]*\n`. One corpus is why
this is a default and not a decision.

**Occurrences sum across gate-passing segments and saturate once**, rather than saturating per segment:
a key is as repeated as the window says it is, and `k1` is calibrated against a whole window's counts.
A segment failing its own secondary gate contributes nothing instead of zeroing the entry. At `scan`
this is arithmetically identical to the pre-setting code, which is the invariant `matchwindow-check`
pins.

**Match sources and injects are each their own segment** — nothing may merge a character description
onto the end of chat prose and let a conjunction span the seam. `segment()` is idempotent, so the
per-entry composition re-runs it over the pre-split window and `scan` still collapses to one string.

**The audit segments the same way**, so `unattested` means *not attested in any segment* — the question
the runtime asks. df still counts ENTRIES, not segments, or "how widely is this term used" would start
moving with paragraph length. Measured inert on every book on disk: 8 books, 8,970 distinct keys, 6,353
of them multi-word, and 0 change df or occurrence total — a literal cannot span a paragraph break, so
only a multi-term SmartKey can differ, and those are the keys whose unsegmented answer was wrong.

**The recursion buffer needs no reconstruction** — see bucket 2. WA segments each pass's own entry
contents and reads the pre-joined buffer only at `scan`, where the join is what `scan` produces anyway.

**Rejected — utterance-level.** The right unit, since a multi-sentence quote is one utterance, but it has
no reliable marker: models drop closing quotes, use `—` for dialogue, and write narration unmarked.
Sentence-splitting is not a proxy for it, and the fold supplies false boundaries by turning `…` into
`...`. Rejected as unavailable, not as wrong.

---

## Elsewhere

**Suggester i18n, none of it started.** `ZIPF_EN` scores non-English function words as maximally rare
(`avec`, `toujours`, `siempre`, `porque`, `immer` all absent → z=0), so the gate designed to reject
common words would propose them as prime keys; a few are present with meaningless values (`der` 3.6,
`war` 5.2 as the English noun), which is worse than absent. `stems()` knows English inflections only,
so `tblZ`'s fallback cannot rescue them. Same blindness hits hyphenated compounds — `well-known` is
absent from the table and scores maximally rare.

**The suggester should know when its priors do not apply.** If a large share of an entry's tokens are
absent from `ZIPF_EN`, the book is probably not English and the frequency gate should stand down and
say so rather than invert.

**Accent variants belong here, not in the matcher** — `Gérard`/`Gerard` is a real miss (the model
writes both, and in one corpus the unaccented form more often), but whether stripping is safe depends
on the language, so it wants a human in the loop. Suggest the stripped form as a candidate key.

---

## Standing caveats

- **`plugin/` changes need `node deploy-plugin.mjs` and an ST restart.** The fold lives in
  `plugin/automaton.mjs`, so orthography and NFC are not live on the server half until then.
- **The check suite is run by exit code.** `eq()` sets `process.exitCode`, so a failed assertion and
  a thrown error are the same signal: `for f in eval/*-check.mjs; do node "$f" || …; done`.
- **`sort.mjs` is now genuinely ST-free** and node-importable; it was not, and CLAUDE.md said it was.
- **Nothing here has been verified in a browser** beyond what was tested by hand during the session.
