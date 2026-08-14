# ST core's World Info scan: what activates, what survives, where it lands

Reference for core's behaviour, not WA's. WA's own pipeline is the four stages in `CLAUDE.md`; core's
scan is what WA's stage 2 shares the entry list with and what stage 4 deletes from. Matching itself
(`matchKeys`, the fold, whole-word) is covered by `matcher-design.md` *Divergences from ST core* and is
not repeated here. Core defects found while reading this go in `upstream-st.md` in the SillyTavern root.

Read off `public/scripts/world-info.js` and `public/script.js`; identifiers are the contract, line
numbers are a hint.

## The scan is a loop with four states

`checkWorldInfo` runs `while (scanState)` over the whole sorted entry list, once per pass:

- `INITIAL` — the first pass.
- `RECURSION` — a pass whose haystack includes the content of entries activated so far.
- `MIN_ACTIVATIONS` — a pass at increased depth, run when too few entries activated.
- `NONE` (0) — falsy, ends the loop.

Each pass collects `activatedNow`, filters it, and commits survivors to `allActivatedEntries`. Two
entries activated in the same pass never see each other's content; only the next pass does.

The loop ends when a pass sets no next state, or when `world_info_max_recursion_steps` is reached.
That setting and `world_info_min_activations` are mutually exclusive, enforced in the settings panel:
setting either non-zero zeroes the other.

## What an entry is tested against

`WorldInfoBuffer` builds one haystack per entry, per pass:

- **Chat**, `#depthBuffer` — messages newest-first, capped at `MAX_SCAN_DEPTH`. The slice length is
  `entry.scanDepth ?? (world_info_depth + #skew)`; `#skew` is incremented by `advanceScan()` once per
  min-activations pass. `#startDepth` is declared, read as the slice start, and never assigned
  (`upstream-st.md` #8).
- **Global scan data** — persona description, character description, personality, depth prompt,
  scenario, creator notes. Each is appended only for entries that opted in (`matchPersonaDescription`
  and friends), so it is per-entry, not global.
- **Injects** — every extension prompt whose `scan` flag is set, snapshotted before the loop starts.
  This is how the Author's Note and depth injections become scannable.
- **The recursion buffer** — content of entries activated in previous passes, appended *except* during
  a `MIN_ACTIVATIONS` pass.

Segments are joined with `\n\x01` and the string starts with `\x01`, so a key anchored at a message
boundary can be distinguished from one mid-message.

## Sticky is persistence, and persistence is a different question from activation

Everywhere below, "sticky" means `timedEffects.isEffectActive('sticky', entry)` — **this entry
activated in an earlier scan and its window has not run out**. It does not mean the entry has a
`sticky` duration configured. The two never coincide on the pass that matters: the window is written at
the *end* of `checkWorldInfo` by `setTimedEffects`, for every activated entry carrying a `sticky` count,
so an entry that just matched its keys is not sticky-active during the scan that matched them. Keys
activate it once; the window re-activates it on the scans after.

The window is `chat_metadata.timedWorldInfo.sticky[world.uid]` with `start` = chat length at
activation and `end = start + sticky`, evaluated once per scan by `checkTimedEffects`:

- Reaching `end` deletes the window, and if the entry has a `cooldown` that same callback opens it
  immediately and *protected*, so a sticky entry falls straight into its cooldown.
- A window whose `start` is not below the current chat length is deleted as "chat not advanced" unless
  protected — which is what keeps a swipe or a regenerate from consuming the duration.
- An entry the scan cannot find keeps its window until the interval passes, then it is dropped — and
  "cannot find" is by `hash`, which `getSortedEntries` computes over the whole entry object. Editing an
  entry's content, keys or flags mid-window, or reordering entries so its `displayIndex` moves, leaves
  the metadata pointing at a hash nothing matches, and the effect silently stops applying.

`cooldown` is the same machinery inverted. `delay` is *not* persistence at all: it holds no metadata
and is re-derived from `chat.length < entry.delay` on every scan.

**Persistence guarantees activation, not survival.** A persisting entry skips the probability roll and
wins its inclusion group outright, but it is budgeted like anything else and is dropped by an overflow
unless it sets `ignoreBudget`.

## The order of checks decides more than the keys do

This ladder runs inside `for (const entry of sortedEntries)`, once per entry, and first match wins —
so the numbering is branch precedence *within* one entry, deciding which check activates it and which
object and log line result. It ranks nothing against anything else. Priority among the entries that
did activate is the batch sort below, which orders them differently.

1. Already in `allActivatedEntries`, or in `failedProbabilityChecks` — skipped. **A failed probability
   roll is permanent for the rest of the scan**, not re-rolled next pass.
2. `disable`.
3. `triggers` — generation type filter, one of `normal`, `continue`, `impersonate`, `swipe`,
   `regenerate`, `quiet`. An empty list means every type.
4. `characterFilter` names, then tags, each honouring `isExclude`.
5. `delay` — suppressed while `chat.length < entry.delay`. Nothing overrides this, persistence
   included.
6. `cooldown` — suppressed unless the entry is persisting.
7. `delayUntilRecursion` — suppressed outside a recursion pass, and inside one until the current
   delay level reaches the entry's. Persistence overrides both.
8. `excludeRecursion` — suppressed on recursion passes. Persistence overrides.
9. `@@activate` — activates. **This is above `constant` and above every key check.**
10. `@@dont_activate` — suppresses.
11. External activation (`buffer.getExternallyActivated`) — the `WORLDINFO_FORCE_ACTIVATE` route.
12. `constant`.
13. Persisting — activates without consulting keys.
14. No keys — skipped.
15. Primary keys — `find`, so the first match short-circuits.
16. Secondary keys, under `selectiveLogic`: AND_ANY and NOT_ALL short-circuit inside the loop; NOT_ANY
    and AND_ALL are decided after it.

The three suppressors persistence does *not* beat are `delay`, `disable` and `@@dont_activate`.

**`vectorized` appears nowhere in this ladder, or anywhere else in the scan.** Core never reads the
flag: a vectorized entry key-matches exactly like a normal one. All it does is mark the entry for an
extension — Vector Storage indexes only `vectorized` entries, then force-activates what it retrieves
through `WORLDINFO_FORCE_ACTIVATE`, which is step 11 and nothing more. Anything that stops a
vectorized entry from also activating on its keys has to blank those keys before core sees them, which
is what WA's `suppressVectorKeys` does. The flag is a UI tri-state with `constant`, so an entry cannot
be both.

Step 11 also substitutes: `externalActivations` is a static `Map` keyed `world.uid`, and the ladder
adds *the map's* entry object rather than the one it was iterating, so a forcing extension can hand
core a modified copy. It is cleared after every scan.

**Force-activation is a bypass of the key checks, not of the gates above them.** Steps 2-10 all
precede it, so a retrieved entry is still dropped by `disable`, `triggers`, `characterFilter`, `delay`,
`cooldown`, `delayUntilRecursion`, `excludeRecursion` and `@@dont_activate` — and once past the ladder
it still faces the inclusion group, the probability roll, the budget, and the empty-after-regex check
in the assembly. The map is not consumed on read and is cleared only at the end of the scan, so an
entry suppressed by one of those gates is re-offered on every later pass.

Vector Storage's own cutoffs sit before all of that, and they bound the *index*, not the activation.
Entries that are orphaned, `disable`d, empty, or not `vectorized` (unless `enabled_for_all`) are left
out of the collections; each book's collection is then queried at `topK = max_entries`, the results
merged, sorted by descending score, filtered by `score_threshold`, and sliced back to `max_entries`.
So the cap is per collection at query time and global after — at most `max_entries` *hashes*.

Entries, though, are not capped, because the activation loop walks the **unfiltered** entry list and
keeps everything whose content hashes to one of those values. Two consequences, both reachable with
ordinary books:

- Entries with identical content all activate off a single retrieved hash, so the emitted count can
  exceed `max_entries`.
- An entry excluded from the index is activated anyway when its content duplicates a retrieved one.
  Core drops the `disable`d case at step 2, but a **non-`vectorized` entry force-activated this way
  keeps its activation**, keys never consulted.

Nothing downstream dedupes by content — `activatedNow` is a `Set` of objects and `allActivatedEntries`
a `Map` keyed `world.uid` — so every copy is budgeted separately and printed separately, from the front
of the queue. One duplicated entry can therefore spend the whole budget on repeated text and cut every
keyword activation behind it. What it cannot come from is the same book loaded in two slots: core skips
a world already activated elsewhere, and identical `world.uid` collapses in both maps. It takes
genuinely distinct entries — a copy-pasted entry, or a book duplicated under another name.

**No retrieval ranking crosses this boundary.** The event carries a list, not an ordering, and the
rank is already gone before it is emitted: Vector Storage flattens its query results to a set of
hashes — similarity decides only membership, through `topK` and `score_threshold` — then walks
`getSortedEntries()` and pushes whatever matches, so it emits in `order` sequence. Core then discards
even that, because the ladder iterates its own `sortedEntries` and asks the map per entry. Whatever an
extension retrieves, core sees it ranked by `order` within source class, and an extension wanting its
own ranking to survive has to impose it after the scan.

## Selection happens three times, in this order

Everything below runs on one pass's batch, after the loop above.

**Batch order.** Persisting entries first, then by index in `sortedEntries` — which is `getSortedEntries`:
each lore source sorted by `order` descending, sources concatenated as chat lore, persona lore, then
character and global per `world_info_character_strategy`. So a book's source class outranks `order`
across books, and `order` decides within one.

**So the budget queue is: persisting, then force-activated, then everything else by `order`.** Sticky
is the comparator's first term and the index fallback only its tiebreaker, so an active sticky window
outranks a force-activation, while `constant` carries no weight here at all — a constant entry holds a
real `sortedEntries` index and loses to external's -1. Force-activating an entry that is already
constant *promotes* it out of the `order` ranking.

That is the reverse of the ladder, where external (11) sits above `constant` (12) above persisting
(13). The ladder's order barely matters — all three outcomes are "activated", and the only thing it
decides is which object is used and which log line fires. Precedence that changes what reaches the
prompt is the batch order above.

Persistence survives substitution because `isEffectActive` compares `entry.hash`, not object identity.
An extension that hands core a hand-built entry without a matching `hash` loses that standing: the
entry sorts as merely external and stops winning its inclusion group.

**Which pass an entry lands in outranks all of it.** The budget is spent pass by pass and earlier
passes commit first, so anything held back to a later pass — by `delayUntilRecursion`, or by being
reachable only through recursion text or a widened min-activations depth — competes for what is left,
whatever its tier or `order`. The gates in the ladder are not sort keys and have no tier of their own;
they decide entry to a pass, and the pass decides priority.

**Inclusion groups** (`filterByInclusionGroups`), for entries sharing a `group`:

1. Timed effects — a persisting entry in the group wins outright, and every later stage is skipped for
   that group.
2. Scoring — only when `world_info_use_group_scoring` or the entry's `useGroupScoring`; keeps the
   entries whose key match scores highest (`buffer.getScore`).
3. If the group already has an entry in `allActivatedEntries`, the whole group is dropped from this
   batch — a group activates once per scan, not once per pass.
4. `groupOverride` — the highest-`order` prioritized entry wins.
5. Otherwise a weighted random roll on `groupWeight` (default 100).

**Probability**, then **budget**, in one loop over the batch:

- `useProbability` and `probability < 100` roll; persisting entries skip the roll. A failure lands in
  `failedProbabilityChecks` for the whole scan.
- `budget = round(world_info_budget% × maxContext)`, capped by `world_info_budget_cap`, computed once
  before the loop. Accumulated content is tokenized and the entry is refused when
  `textToScanTokens + tokens(newContent) >= budget`, setting `token_budget_overflowed`. After overflow,
  only `ignoreBudget` entries are admitted: a normal entry is skipped while an `ignoreBudget` entry is
  still ahead of it in the batch, and ends the loop once none are.
- Position is not consulted here. A depth entry and a before-char entry compete for the same budget on
  batch order alone.

**Force-activated entries take the budget before everything else.** The batch sort looks each entry up
in a `Map` keyed by *object identity* over `sortedEntries`, falling back to `?? -1`. A force-activated
entry is the object the emitting extension supplied, and `getSortedEntries` ends in `structuredClone`,
so every caller gets fresh objects and the lookup can never hit: the fallback puts external entries at
index -1, ahead of every keyword and constant activation in the same pass. They are not exempt from the
budget — nothing but `ignoreBudget` is — they simply spend it first, and `order` does not apply to them
at all. So a vector retriever's winners are the entries a tight budget keeps, and the keyword
activations are what it cuts.

**The running total is not what reaches the prompt.** Each pass starts from
`textToScanTokens = tokens(allActivatedText)`, and `allActivatedText` accumulates only
`successfulNewEntriesForRecursion` — successful minus `preventRecursion` — and only when the scan is
continuing. Two consequences: a `preventRecursion` entry spends budget in its own pass and is invisible
to every later pass, and an entry *refused* by the budget still counts as successful, so where the scan
continues anyway its text is charged to later passes and pushed into the recurse buffer despite never
being activated.

## What makes the loop run again

- **Recursion** — `world_info_recursive` and at least one newly activated entry without
  `preventRecursion`; their content is pushed into the recurse buffer for the next pass.
- **Min activations** — fewer than `world_info_min_activations` total activated, and depth has not
  passed `world_info_min_activations_depth_max` or the chat length. Advances `#skew` by one.
- **Delayed recursion levels** — when nothing else continues the scan but `delayUntilRecursion` levels
  remain, the next level opens and forces one more recursion pass.
- **Budget overflow blocks the first two, not the third.** Recursion and min activations are both
  guarded on `!token_budget_overflowed`; the delayed-recursion branch is not, so an overflowed scan
  still runs a pass per remaining level — in which only `ignoreBudget` entries can activate.

`WORLDINFO_SCAN_DONE` fires at the end of every pass, and core reads back `state.next`,
`activated.text`, `recursionDelay.currentLevel` and both budget fields from the event args. A listener
can therefore extend, redirect or halt the scan — that is the hook WA's stage 3 runs on.

## Assembly: six sinks, not one list

The tail of `checkWorldInfo` walks the survivors once and drops each into a sink by `position`. There
is no point at which the activated entries exist as one ordered sequence of prompt text.

| `world_info_position` | sink | reaches the prompt as |
| --- | --- | --- |
| `before` (0), `after` (1) | `WIBeforeEntries`, `WIAfterEntries` | two joined strings, `worldInfoBefore` / `worldInfoAfter` |
| `ANTop` (2), `ANBottom` (3) | `ANTopEntries`, `ANBottomEntries` | wrapped around the Author's Note, re-injected via `setExtensionPrompt(NOTE_MODULE_NAME, …)` |
| `atDepth` (4) | `WIDepthEntries`, grouped by `(depth, role)` | one `IN_CHAT` extension prompt per group |
| `EMTop` (5), `EMBottom` (6) | `EMEntries`, tagged `before`/`after` | unshifted/pushed into `mesExamplesArray` |
| `outlet` (7) | `WIOutletEntries[outletName]` | a `NONE`-type extension prompt, rendered where its macro sits |

The AN sinks only fire when `shouldWIAddPrompt`; otherwise those entries are assembled and dropped.
Their placement is the Author's Note's own position, depth and role — they have none of their own.

**`order` reverses between the two halves.** It ranks the budget descending (highest first, via
`sortedEntries`), but the assembly re-sorts descending and then `unshift`s, so within a block the text
reads *ascending*: the highest-`order` entry is evaluated first and printed last. Across positions
`order` is never compared at all, which is why `reportLayout` in `worldsapart.js` groups by position
before ranking.

**The content that lands is not the content that was budgeted.** Macros are substituted in the budget
loop (mutating the entry in place, before counting); regex scripts run in the assembly
(`regex_placement.WORLD_INFO`, with the entry's depth for `atDepth` and `null` elsewhere); an entry
emptied by a regex is then skipped — after spending its budget, and while remaining in
`allActivatedEntries`, so the activation event and the log count both still include it.

**Where the strings go.** Text completion passes them to the story string template as
`wiBefore`/`wiAfter` (aliased `loreBefore`/`loreAfter`); all 34 shipped context presets place `wiBefore`
after the system prompt and `wiAfter` after the scenario, but that is the preset's choice. Chat
completion turns them into two system messages with identifiers `worldInfoBefore`/`worldInfoAfter`,
ordered by the preset's prompt manager. "Before char" names a default layout, not a guarantee.

## Quirks worth knowing

- Depth grouping keys on `entry.depth ?? DEFAULT_DEPTH` but stores the raw `entry.depth`. Entries
  written by ST always carry a depth, so this only bites a book whose `depth` is present and null.
- Outlet entries with no `outletName` are warned about and dropped, after being budgeted.
- A dry run still assembles every block and still fires the AN re-injection. What it suppresses is
  `WORLD_INFO_ACTIVATED` and the sticky/cooldown state writes, which `WorldInfoTimedEffects` skips on
  its own `isDryRun` — `delay` is evaluated either way.
