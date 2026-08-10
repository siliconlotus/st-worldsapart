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

**Correctness that depends on knowing the language belongs in the reviewed layer.** The matcher is
silent, so it must be language-neutral. The suggester is reviewed by a human before anything is
accepted, so it is where a judgement like "is stripping this accent safe" can live. Hyphens pass that
test (a compound is a compound in any language that hyphenates); accents do not (`du`/`dû`).

**Quoting is the single escape.** It suppresses operator, weight, paren and wildcard interpretation and
marks a punctuation-only term as deliberate. One rule to learn, not four. Quoting a single term never
changes what it matches; quoting *across a space* does, turning a conjunction into a phrase.

**Validator checks read structure, not intent.** Every check that guessed at what an author meant
produced false positives on legitimate literals — `"()"` is a real album, `M*A*S*H` is a real title.
The checks that survive are facts about the query: no terms, no positive term, an unclosed quote,
unbalanced parens. A key that expected a feature WA lacks is dead, and the audit reports it as dead
from the evidence.

**Divergence from core is free where WA owns activation, and costly where core owns it.** While core
activates, every matcher difference makes the Studio's audit report on rules that are not what fires.

---

## Status

**Bucket 1 — matcher and SmartKeys: done.** Parser bugs, the `::` weight delimiter, the validator, the
Studio save gate, the audit change, `weight × count` scoring, the Lucene aliases, and `SMARTKEYS.md`
carrying both halves — the grammar, and the matching behaviour that had no user-facing home.

**Bucket 1.5 — SmartKeys activate: not started.** New term, and the next thing to build. Bucket 2's
first increment rather than an alternative to it: every piece is reused unchanged if bucket 2 follows.

**Bucket 2 — WA owns activation: conditional, not scheduled.** Was "settled, awaiting implementation";
bucket 1.5 covers most of what it was for. Revisit if `keysecondary` scoping measures a win, if variant
expansion earns its place, or on the group asymmetry below.

**Match window — implemented** (`matchWindow` setting, `ranking.scanSegments`/`segment`), and independent
of bucket 2 except where noted.

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
union is powerless. But `filterByInclusionGroups` runs **before** the `WORLDINFO_SCAN_DONE` emit and
discards the losers, so deleting a group winner leaves the group unrepresented, where a matcher that
answered "no match" up front would have promoted a loser. **That gap is the seam's real justification**
— everything else about ownership is reachable from outside. Measured 0 of 2,112 enabled entries in a
group, so it is untestable here without a fixture, and that fixture is a prerequisite either way.

## Bucket 2 — the plan

Core keeps the gates, the timers, recursion control and prompt assembly. WA replaces exactly one
question: *did a key match*.

**The seam.** `getExternallyActivated` is checked inside core's scan loop, after `@@dont_activate` and
before constant/sticky/key-matching. Every other gate — disable, triggers, character and tag filters,
delay, cooldown, `delayUntilRecursion`, `excludeRecursion`, decorators — runs *before* it, so
force-activation inherits all of them rather than bypassing them. `WORLDINFO_FORCE_ACTIVATE` is the
supported way in, and WA already emits it for vector winners.

**Recursion is solved, not blocked.** `WORLDINFO_SCAN_DONE` fires after *each* scan loop, not once at
the end. Its args carry `activated.text` (the accumulated recursion buffer) and a **writable**
`state.next` that core reads back immediately. So WA evaluates against chat + recursion text, emits
`WORLDINFO_FORCE_ACTIVATE` for anything newly matched, and sets `state.next` to run another pass.

**WA emits blindly and lets core reject; two stamped fields settle the loop.** `waMatched`, set on
first hit and never recomputed, and `waEmittedAt`, holding `args.recursionDelay.currentLevel`, so an
entry core refuses is retried exactly once per delay level and core's own advance is what gives it
another chance. WA therefore models none of core's gates — the level is an opaque epoch counter, not a
condition WA evaluates. `sortedEntries` is built once before the loop and re-cloned per generation, so
both fields are free-scoped. **The sticky flag is correct because the haystack only grows**: `addRecurse`
appends and `#skew` only widens, so a verdict goes false→true and never back, and core does not revoke
activation either.

**Scan each pass's new content; retain no text.** At `matchWindow: 'scan'` read core's own
`args.activated.text` instead — one segment either way, and both join with `\n`, so it is core's exact
haystack and the cross-pass conjunction cannot diverge. Otherwise segment per entry, which is
`keyword-core.mjs`'s existing loop pointed at a different array. **Filter `preventRecursion` out first**:
`args.new.successful` is the list *before* that filter, and core builds the recursion buffer from the
list after it, so using it raw restores the propagation the flag exists to stop.

**Inherit `world_info_recursive`.** WA writes `state.next`, so it must check the setting or it forces
recursion the user disabled. The token budget is the opposite case and is not inherited — WA supplants
it (see `worldsapart.js` `onEntriesLoaded`).

**`keysecondary` needs no separate implementation.** `(key, keysecondary, selectiveLogic)` maps onto a
SmartKey expression. This is what bucket 2 buys that bucket 1.5 does not: selective logic inherits
`matchWindow` scoping instead of being whole-window and distance-blind. **Measured** population, books
on disk: 79 entries of 2,112 enabled (3.7%) across 14 books, 77 of them `AND_ANY`. Distribute rather than collapse: **one SmartKey per primary key**, each
`primary + <secondary expression>`, so scoring keeps the per-key granularity that `keywordScore`'s
saturation wants. `AND_ANY` → `(secondaries)`, `AND_ALL` → juxtaposition, `NOT_ANY` → `-a -b`,
`NOT_ALL` → `-(a b)`, every term quoted.

`synthesizeSecondary` in `smartkeys.mjs` does it, fuzzed against `secondaryOk` over 16,000 random
comparisons in `eval/synthesis-check.mjs`. It **refuses rather than approximates** where the grammar
cannot carry a key — a double quote has no escape, and a `/regex/` or `?` key is a different matcher
rather than a term — so a null is "fall back to the old path", never "no secondaries". Reading it as
the latter drops the gate silently, which is worse than not rewriting at all.

**Guard the empty-primary case explicitly.** Core skips an entry with no primary keys *before* reading
its secondaries. Synthesised from an empty `key`, the expression is just the secondary condition, and
`NOT_ANY` over it fires on almost every scan. That guard must be written, not left to fall out.

**Retain `coreChat`; do not mirror it.** WA's `intercept` IS a generation interceptor, and
`runGenerationInterceptors` is called *after* `coreChat` is built — `is_system` filter, swipe-pop,
`getRegexedString`, `appendFileContent`, titles, media, reasoning. So the `chat` parameter already is
that array and there is nothing to reproduce. `rankActivated` throws it away and re-derives from
`getContext().chat`, which is raw.

**That is a standing stage-3 bug, not a bucket 2 prerequisite.** Anyone running a regex script that
rewrites message text has keyword scores computed against text core never matched on, today. Fix it on
its own schedule: stash the intercepted array per generation, keep the `getContext().chat` path for the
dry-run and chat-load cases where interceptors never fired, and remember the stash is a live reference
that later injects mutate.

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

---

## Match window — the haystack is segmented

A setting, `matchWindow`: `scan | message | paragraph`, default `paragraph`. It selects **where WA stops
concatenating**, not an evaluator mode — `scanWindow` returns segments, and `scan` is the degenerate
one-segment array that reproduces today's behaviour exactly.

**Uniform across every matching rule.** SmartKey conjunctions, selective logic, all of it. `keysecondary`
is not a special case: bucket 2 synthesises it into a SmartKey expression, so it inherits the scope for
free, where pinning it to `scan` would need a per-key override nothing else wants — and would aim the
setting at the empty half of the population, since books have `keysecondary` and do not yet have
SmartKeys. The 16,000-comparison equivalence test pins the *mapping* and runs at `scan`, where core's
semantics are reproducible.

**Both signs scoped.** A negation is a segment-local veto. Whole-window negation carries the same
distance-blindness as whole-window AND and fails worse: `? fire -drill` is silently killed by a drill
five messages back, and a false negative never surfaces, where a false positive is a ranking
contribution that competes and loses.

**Primary keys are unaffected at any setting.** A single-word key's occurrence count is slice-invariant,
and a multi-word key cannot span the `\n` join today. Everything the setting changes lives in selective
logic and SmartKey conjunctions.

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
only a multi-term query can differ, and those are the keys whose unsegmented answer was wrong.

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
