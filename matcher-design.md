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

**The system makes exactly ONE relevance decision, and it makes it at stage 4.** Everything earlier is
either an author's declaration or a mechanical bound, and neither is a judgement WA is entitled to
make on its own. Stage 1 and 2 ADMIT — generously, cheaply, on rules that need no taste; stage 4
arbitrates, once, over the whole heterogeneous set, on the layout ranking that is the only place all
three signals and the real constraint meet.

This is the principle behind most of the queue below, and the queue reads as unrelated items without
it. The stage-1 elbow is a relevance judgement made early, on a ranking that cannot see keys, against
a budget it does not know about. The tier rule removes a population from the only ranking that
arbitrates. Trigger provenance excluding a recursed entry is a judgement dressed as bookkeeping.
`maxVectorEntries` is budget allocation enforced two stages before the budget exists.

What it does NOT absorb, because these are not WA's calls: an author's declarations (`constant`,
`delayUntilRecursion`, `preventRecursion`, `excludeRecursion`, `disable`), core's own gates, and the
admission bound itself — a ceiling that stops a pathological scene feeding a recursion pass is a
safety limit, not a verdict on relevance.

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

**Set metrics on a reference-heavy book are JOINT, and cannot tune routing alone.** A reference entry
reaches the prompt because its key fired, so a key miss and a routing miss both land in the same recall
number with nothing distinguishing them. Split the misses by divergence class (`eval/divergence-audit.mjs`)
before reading an F or recall figure on such a book as a statement about the ranker. The extreme case is
a pure-reference vectorized book, where the tier rule removes 100% of the rows and the score is entirely
about keys.

**This rule is superseded by the two-score split in the queue below** and survives only until it lands.
It removes a population that stage 4 genuinely arbitrates — on Sommers the reference class is ~60% of
the delivered set — so it makes the ranker's largest contention invisible rather than unmeasured.

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

## The queue

Order it by whether a user can see the difference — not by how tidy the fix is, and **not by how many
instances the books on disk hold**. A permitted input occurs whether or not this author has written
one; corpus counts size a known effect and never dismiss a case.

Two items block other work: the **two-score metric redesign** below, which blocks several tuning
decisions and should go first, and **recursion scoring** after it. Recursion ships on reasoning rather
than evidence — `world_info_recursive` is off here and no book in the corpus exercises it — so it waits
on a recursion-using book; the redesign has data waiting for it now.

**Witness spans** and **proximity** are ruled and unimplemented below, and share one collector. The
display half lands first: it is what tells a proximity key's classes apart, and it is worth having
whether or not `~N` ever ships.

---

## Two scores, because one metric cannot grade two populations

**Ruled, unimplemented.** Supersedes the two-tier removal rule in Principles above, which is a
workaround for grading a heterogeneous ranking with a metric that cannot handle one. Under the split
the exclusion is unnecessary in one score and wrong in the other, so it goes rather than gets fixed.

**The vector score** grades `fuseRetrieval`'s output, cut by `cutRetrieved`. Homogeneous by
construction — the collection holds only vectorized entries' chunks — so no exclusion rule is needed,
only the observation that the population is already uniform.

**The layout score** grades `fuseRanks` at the depth the budget actually admits: `nDCG@budget`, over
the DYNAMIC block. Constants and armed stickies are hoisted to the front of `ranked` so every cap is a
prefix cut, which means they consume budget without competing for it — the graded population is
exactly what a cut can reject. Everything else is in, cards included: this score exists to measure the
heterogeneous contention the tier rule was removing.

**Reference entries are GRADED, on the same 0-4 scale as anything else — not reduced to a boolean.**
A two-valued "does it belong" was considered and is wrong: it throws away the only evidence there is
about contention, which is precisely what the layout score reads. The same entry graded 2 in one scene
and 3 in another is not noise to be flattened; at stage 4 that difference is which of two entries keeps
a slot. Where the grades are USED is what differs by score: the vector score never sees them, because a
reference entry has no chunk in the collection and is absent from that ranking by construction rather
than by a removal rule; the layout score consumes them fully.

**Relevance is asymmetric, and the two halves take different bars.** Recall at grade >= 3 — did the
must-deliver material arrive. Precision at grade >= 2 — a 2 is "it won't hurt and it might help", so
delivering one is not an error and charging it as a false positive penalises the ranker for the
contention zone behaving normally. **Measured**, one scene: P@>=3 0.542 against P@>=2 0.708, F1 0.703
against 0.829. The arm ORDERING barely moves, so comparative findings survive; the absolute level does
not. **Measured**, 73 scenes: under the symmetric bar F1 ranked the shallow cuts on top and the
ordering inverted at F4, which read as beta trading recall against precision — under the asymmetric
bar depth wins at every beta and the inversion disappears. A single bar was confounding the beta
sweep with its own denominator.

**What this unblocks**, and why it goes first: whether `elbow` survives at all, whether the stage-1 cut
becomes a fixed bound, what `maxVectorEntries` should default to, and whether reference entries need
contention grades. All four are currently unanswerable because nothing grades stage 4.

**The offline half now exists.** `/wa-grade` records the pre-budget population with per-row `tokens`,
`cut` and `cutBy`, plus the tokenizer in the snapshot, so `applyBudget` replays offline at any budget —
verified exact against the runtime's own verdicts on 315 rows across 7 arms.

---

## Recursion: WA activates on it and then refuses to score it

**A recursed entry cannot currently compete.** Stage 3 builds its scan window from the chat plus
injects plus opted-in match sources, and never the recursion buffer — so an entry whose key matched
another entry's CONTENT is scored against text where that key does not appear. It scores `keys: 0`,
and `vector`/`text` are absent unless retrieval returned it anyway, so it sorts to the bottom of the
layout ranking and the budget drops it first. The budget binds on every graded scene measured, so this
is not a hypothetical: recursion currently activates entries that WA then discards.

The one case where a recursed entry does score is the case where its key is also in the chat — where
it would have activated directly and recursion added nothing.

**This is migration residue, not a decision.** Before bucket 2, core owned recursion activation and WA
never saw the buffer; scoring on chat alone was the only thing available. Bucket 2 removed that
constraint and the scoring window was never revisited. Bucket 2's claim that recursion is "solved"
is true of ACTIVATION only.

**Ruled: trigger provenance is not WA's business.** Where an entry was triggered from does not change
whether it may compete. `delayUntilRecursion` is the author's own and only declaration that an entry
is child-only, so unset — or level 1, which is the first hop — stands on its own. **Measured**, 44
books / 2,699 enabled entries (this author's 41 plus the three public ones): 26 are `true`, one
carries an explicit level 1, and nothing anywhere is authored deeper — so this rule admits everything
on disk and ships unexercised.

**Third-party books suppress recursion far harder than this author's do**, which sizes the whole item.
`excludeRecursion` — the flag that stops an entry being activated BY recursion — is set on 526 of the
579 public-book entries (91%) against 140 of 2,120 here (6.6%), and the public books set
`preventRecursion` and `delayUntilRecursion` on nothing at all. So the population recursion scoring
would touch is small in other people's books by their own choice, and the flags are evidently
understood: this is authors suppressing a mechanism, not authors ignoring it. Read that as a bound on
how much this can matter, not as permission to skip it — a book that leaves recursion on is exactly
the book where an activated-then-discarded entry is invisible and wrong.

**Ruled: stage 3 scores the recursion buffer.** Via the existing `matcher.withExtraTexts`, which the
activation path already uses on the same `runState.waRecursionTexts` — so this closes the divergence
with one call rather than a second code path, and the one-matcher discipline holds. Recursion contents
are per-entry strings and become their own segments, which is the rule match sources and injects
already follow: nothing may merge them onto the end of chat prose and let a conjunction span the seam.

The circularity objection does not survive: chat text is also downstream of what WA injected, one turn
later, and stage 2 already accepts the relation. What is genuinely different is that recursion text is
not opt-in the way `matchPersonaDescription` and its siblings are — it applies to every entry at once,
gated only by the global.

**Open: trigger-depth weighting.** An entry reached at the third recursion pass is three removes from
the conversation, and should not score as though the conversation had named it. The weight is a
per-entry scalar stamped at first match, NOT a per-segment weight — `matchWindow`'s rule that
occurrences sum across gate-passing segments and saturate once stays intact.

Two things this needs, and one trap:

- A pass counter. `feedScanLoop` runs once per `WORLDINFO_SCAN_DONE` of an owned scan, and the point
  where a newly-matched entry joins `waMatched` is where its depth is stamped.
- **The counter advances on RECURSION passes only.** `feedScanLoop` also runs for min-activation
  passes, which widen the chat window rather than feed on entry content — `args.state.next ===
  scan_state.MIN_ACTIVATIONS` already distinguishes them for the depth skew. An entry first matched on
  a min-activation pass was found in the CHAT, just further back; weighting it as depth-2 would punish
  it for being deep in the conversation rather than deep in a chain.
- Depth is a property of the MOMENT, not of the entry: the same entry can be reached at depth 1 in one
  scene and depth 3 in another, since depth depends on what else fired. That is the intended reading —
  distance from this conversation — but it means the weight is a per-scene signal and not a stable
  per-entry prior, and anything averaging it across scenes is averaging two different things.

**The two halves are one change.** Without buffer scoring, the weight has nothing to discount. Without
the weight, buffer scoring admits a depth-3 entry at full strength on text WA itself chose to inject.

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

**A validator error bars a key from SCORING as well as from activating.** `usableKeys` (was
`activatableKeys`) gates both, because filtering only the stage-2 verdicts left a key WA had declared
unfit to fire on still feeding the layout ranking — `? -zebra` scoring a full hit on every scan where
"zebra" is absent, i.e. nearly all of them, for any entry that got in by some other route. Three ways
a key enters a book and only one is guarded: the Studio refuses the write (`keyWriteOk`, errors
abort), core's WI editor has no concept of a `?` key, and an imported book was never asked. So the
runtime is where it has to hold. `countKey` itself stays unfiltered — it answers what an expression
does, and deciding whether to ask is the caller's job.

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

**Orthographic variants for REGEX keys belong to that same pass, and not to the fold.** A regex is the
one key kind that cannot be folded — a pattern is code, so rewriting `…` to `...` turns a literal into
three wildcards and `[a–z]` into a range. Folding only the haystack instead would kill the distinction
for every key at once, which the first principle forbids. So the regex case is not an exception to the
fold; it is the case that shows why the fold works everywhere else: literals fold BOTH sides and meet
in the same space, and a regex has no such second side.

Expansion has no equivalent problem, and the difference is arity. A character class matches exactly one
character, so no rewriting can make `[—]` match `--`; an alternation has no such limit, and
`(?:—|--)` is ordinary. The generated forms therefore cover what folding cannot: `'` widens to the
apostrophe family, `-` to include the en-dash, `--` and `—` to each other, `...` and `…` likewise.
Offsets stay in source space because the haystack is never touched, which is the property the excerpt
path kept losing while this was being worked out.

**Only 1→1 substitutions are generated, and the reason is that a pattern is parsed, not scanned.** A
one-character swap is LOCAL — `o'?k` becomes `o['’ʼ′]?k` and the quantifier still binds to the quote —
and splices into a character class as an ordinary member. A multi-character one is not: in `a--?b` the
two hyphens are a hyphen plus a QUANTIFIED hyphen, so rewriting them to `(?:--|—)?` silently stops
matching `a-b`. Telling those apart needs a real parse, which a substitution pass does not have. `...`
is worse — it is already three wildcards, so expanding it would rewrite a wildcard into a literal.

So the generated set is the apostrophe family, the double-quote family, en-dash ↔ hyphen, and
nbsp ↔ space. Em-dash and ellipsis are left to the author, which is the right cut on intent as well as
on safety: expansion exists to cover variation nobody can anticipate — a model emitting `’` where the
author typed `'` — and `--` against `—` is visible in both the pattern and the prose, and writable as
`(?:--|—)` by anyone who means both.

Structure-aware even so, since a class member must splice rather than nest and escapes must be left
alone — `regexClose`'s ECMA-262 scan already tracks both. **Unimplemented.**

**Measured**, one author's 196 chats (1.28 G chars, 3.28 M possessives): 10.6% use a curly apostrophe
overall, but the share is a property of whoever wrote the chat, not of the corpus — of 144 chats with
at least 200 possessives, **18 are above 90% curly** (worst 97.6%), 91 sit between 5% and 95%, and 44
are under 5%. So `/Sara('s)?/` typed with a straight quote does not degrade by a tenth; on 18 chats it
misses nearly every possessive, and on 91 it misses an unpredictable fraction that moves when the model
does. The mixed chats are the worse failure: a key that fires SOMETIMES reads as weak rather than
broken, and every firing-rate measurement here would score it as weak, since those count what matched
and cannot count what did not.

**The scarcity of regex keys on disk is not evidence against this** — 3 patterns across 44 books
measures ST core's support and discoverability, which is what this project is removing. An author who
did not know regex keys existed has not declined to use them. The chat measurement above is admissible
because it describes the haystack, which is independent of whether anyone has written a pattern yet;
the key count is not.

Which argues for building it BEFORE the keys exist. A pattern authored against a straight-quote chat
works, ships, and silently stops on the next model — the failure mode that no test the author runs at
authoring time can catch.

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

**A regex key is audited like any other key**, on df, by the same machinery that judges a literal and
a SmartKey — `classify` discarded both for years while `runBatch` computed their df anyway. Only the
heuristics that read a key AS A LITERAL STRING stay exempt (English-common, fragment, short), because
the matching surface of `/sal(a|e)/` is its pattern and not the characters it is written with. Without
this a pattern had no oversight anywhere: the validator skips value checks on patterns by design, so
`/\n/` firing on every multi-line message drew not one word from any tool. `registerKeys` skips regex
keys, so they miss the Aho-Corasick batching and pay a compile and a scan per entry; **measured**, 100
regex keys x 300 entries x ~1KB is 9.8 ms when nothing matches and 18.4 ms at 630,000 hits, against a
Studio open already costing hundreds. A compile is ~0.1 microseconds and V8 caches by source, so
caching them would recover ~5 ms of that and is not worth the code.

**A regex is a term for counting and for positivity.** `no-terms` counts it, and `hasPositiveTerm`
treats it as a positive contributor, as it does a spliced `?` subtree. The validator reads `TERM`
tokens alone today, so without this `? /re/` reports `no-terms` and `? /re/ -drill` reports
`negation-only` — both fatal, and `usableKeys` bars a key that matches perfectly well. The checks
that inspect a term's VALUE still skip it: a pattern is punctuation by nature, so `punctuation-term`
and `stray-quote` would fire on every one.

**A regex term is case-sensitive AND fold-exempt, except for NFC.** `countKey` branches before
`foldedHay`, so a pattern runs on raw text, as core's does — fold the haystack and a pattern written
against real text stops working, since `/—/` could never match a copy holding `--`. Case and
orthography therefore stay raw, and the author widens with `/i` and `['’]` when they want to.

Normalisation is not that kind of choice, so the segment is NFC-composed first — and this is LEAST
SURPRISE applied straight, not a divergence bought with an excuse. Two encodings of `é` are the same
letter to everyone who is not implementing Unicode; what would astonish is a key that visibly matches
the text, reports zero, and offers no spelling that fixes it. Core's raw-text behaviour is the
surprising one here, so matching it faithfully would have been the cost.

That also says why case and orthography go the other way under the same principle. `/Cap'n/` missing
`Cap’n` surprises too, but the surprise is visible IN THE PATTERN and the author can act on it, while
`/—/` failing against a folded haystack would be invisible and unfixable. **Fold where the distinction
is not one a writer means, and leave it where they might.** Encoding form is never meant; punctuation
sometimes is.

Measured 0 decomposed sequences across 41 books and 196 chats — unexercised here, which is a statement
about this corpus and not about the case. Inside a SmartKey that means mixed folding: `? /Cap'n/ crunch`
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

**The check is one-directional, and the mirror is now closed rather than recorded.** It catches
WA-yes/core-no, which after this is the only direction there is: `REGEX_KEY_RE` used `.`, so a body
holding a literal newline was a pattern to core (`[\w\W]`) and a plain literal key to WA. That was an
artifact of a character class, not a rule — `new RegExp("a\nb")` is a valid pattern and core admits
it — so the class widened to `[\s\S]` and the two agree. A weird key is still a valid one, and WA had
no reason to refuse where core did not. `validateSmartKey` warns (`regex-core-refuses`) rather
than either side deciding. `coreReadsAsRegex` in `matcher.mjs` is core's rule mirrored for that
warning, and counts nothing. It reaches SmartKey TERMS as well as bare keys, since the term rule became
the whole-key rule — before that the scan cut a slash-bearing pattern apart before anything could ask
what core made of it. Both messages say what each side does and stop: WA runs the pattern, so there is
nothing to prescribe, and `\/` is a portability choice rather than a fix.

---

## Witness spans — what an excerpt may claim

**Ruled, unimplemented.** `keyExcerpts` answers only for a lone `TERM` or `REGEX` and returns null for
every compound key.

**A key's spans are the leaves that CONTRIBUTED, not a whitelist of node types.** The rule is the one
`evaluate` already applies to `scoreBoost`: a leaf's spans survive exactly where its weight does. `OR`
concatenates, a matched `AND` keeps both operands, `XOR` keeps the winner, and a failed `AND` branch
inside a matched `OR` retracts. So `? (a | b | c) -d` is fully excerptable — a negation has an empty
extension, which is not the same as barring the spans beside it.

**Collection rides on `evaluate` rather than mirroring it.** An optional accumulator, absent on the hot
path; `AND` and `XOR` record its length before descending and truncate on failure. A second traversal
would be a second copy of the survival rules, which is what `countKey is the only matcher` forbids.

**Below a negation the algebra is existence, not extension.** The collector never descends into a
`NOT` — it takes `matched` from `evaluate` and stops. Counting a negated term reports how often it
almost matched, a quantity the semantics do not have, and extracting its spans pays the per-character
fold walk to build excerpts that are then discarded.

**Counts belong to the result, never to the node.** `astCache` interns a tree by its raw key on a
module-level scope, so one object serves every segment of the window and every entry sharing that key;
a count written onto it is last-segment-wins and leaks between entries. Weight is the node's, being a
property of the key as written.

**The display takes occurrences and ignores weight.** A witness line answers *how is this key reaching
the text*, which is not what it contributed to the ranking. Per-leaf counts come from the leaf's own
count and not `spans.length`, which is capped for display.

**Overlapping context windows are one window**, rendered as one excerpt with both spans marked. The
cluster count then reads as the diagnostic — one line means the terms were adjacent, two means they
were not — and the only claim being made is a rendering one, never that a particular pair witnessed
the match.

**An `AND`'s leaf spans are already restricted to segments that fired**, since `keywordScore` evaluates
per segment and a failed conjunction retracts its leaves there. A conjunction reports where its terms
co-occurred, not everywhere either term appeared.

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

## Proximity — `(…)~N`

**Ruled, unimplemented.** `? (copper pipe)~5` constrains a group to a window. Parens already group
without order, so the slop attaches to something order-free by construction. `"…"~N` is rejected:
quoting is this grammar's one construct that DOES carry order, and it stays unspent for the ordered
loosened phrase it looks like.

**The unit of completeness is the CONJUNCT, not the leaf.** In `? ((Arthur | Kyle) Porsche)~3` the
window needs one span from `Porsche` and one from either branch. **Measured**, Sommers chat: 60
witnesses against 47 + 16 for the two keys run separately — the sweep takes whichever alternative is
nearer, so a paragraph yields one tighter witness rather than two.

**N is per junction.** Consecutive spans, sorted by position, each within N words. Decided on intent —
an author writing a fuzzy phrase claims the steps are short, not that the whole span is compact — and
the corpus cannot adjudicate it, because re-reading plain multi-word keys as groups puts function
words in the operands, and dropping those takes the key to two terms, where the two readings are
identical. Accepted cost: a k-term group can span (k−1)·N.

**Slop counts words, off `wordChar()`.** **Measured**, standard corpus: a `\b` counter charges a slop
point to `teddy o'neill` and `pack-bond pheromone`, since the apostrophe and hyphen split one word in
two — 2.9pp of two-term co-occurrences at `~0`. One boundary class, or two matchers.

**Occurrences are CLUSTERS.** Three `copper` and two `pipe` are one fact, not six: leftmost minimal
windows, each consumed before the next is sought.

**A negation is a veto over the padded window, and the window must be fixed before it is tested.**
Positives are existential and negatives universal, so one window serves neither — the sweep may always
shrink to a single positive, which contains no negated term by construction. The rule is the positive
witness window, padded N words each side, holding no negated operand. Centring on the padded cluster
and centring on each positive independently are the same region, since the slop bounds every internal
gap by N and radii of N therefore always overlap. `? (-x)~N` has no positive to anchor and is the
existing `negation-only` error.

**The digits are required.** A bare `~` makes a key's behaviour depend on a default it does not show.
**Measured**, Sommers chat: `? ((Arthur|Kyle) Porsche)` yields 16 witnesses at `~3` and 35 at `~10`.

**A group without `~` keeps segment scope**, so no existing key changes meaning. **Measured**, the 26
conjunction SmartKeys in `Sommers_Pack__v22` against their own chat: 720 firings, of which `~5` keeps
39% and `~10` 57%. A slop cannot be retrofitted onto conjunctions written precisely because the terms
are apart.

**The trie answers presence; positions are walked.** `scanAutomaton` computes each match start and
discards it into a counter, so positions are one push away — but recording them changes `plugin/` and
pays an array per pattern per segment for every plain key that never wants one. The walk it saves is
an `indexOf` over one paragraph, after the candidate filter has rejected every segment missing an
operand.

**NEAR is for content terms.** A key reproducing a title stays a plain phrase, and a function word as
an operand is the failure mode — but *is this a stopword* is language-dependent, so it belongs to the
suggester and never to the validator.

**Where it earns its keep is narrow, and two of three bands are not it.** Proper nouns co-occur
genuinely, so a slop filters signal rather than noise. A polyseme's noise sits at slack 0 where no slop
reaches it — **measured**, Sommers: `? Jeffrey =watch` fires 48 times against 395 for `? Jeffrey
watch`, so `=` is worth 7× the slop, and the verb sits closer to the name than the noun does. The band
is terms individually common and jointly specific, where **measured**, standard corpus, `~5` rejects
21.5% of what a segment-scope conjunction admits.

**Negative slack is overlap, and it is the class proximity cannot fix.** A window covering fewer word
starts than it has operands means they landed inside one word. **Measured**, standard corpus: 3.8% of
two-term co-occurrences, led by `moving in` firing 876 times inside the word "moving", plus the
compound written closed (`scrap yard` against `scrap-yard`). All are maximally near, so no slop
excludes them and only per-operand whole-word does.

**Rejected — a finer match window in its place.** **Measured**, Sommers conjunction keys: 3% of firings
have a minimal window spanning a line break, and 138 of the slack-21+ firings sit on a single line. A
`line` mode would buy 3% and leave every distant-pair case untouched.

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

**A grading row's key count is a SCORE wearing a count's name.** `keywordScore` pushes
`hits.count = scoreBoost`, so `? fire::3` displays `3` for a single occurrence and the row reads as
"fired three times". Independent of the witness-span work and fixable on its own.

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
