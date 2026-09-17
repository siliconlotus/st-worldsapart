# ST core's World Info scan: what activates, what survives, where it lands

Reference for core's behaviour, not WA's. WA's own pipeline is the stages in `CLAUDE.md`; core's scan
is what WA's stage 2 shares the entry list with and what stage 4 deletes from. Matching itself
(`matchKeys`, the fold, whole-word) is `docs/matching-architecture.md` *Divergences from ST core*. Core defects go
in `upstream-st.md` in the SillyTavern root. Read off `public/scripts/world-info.js` and
`public/script.js`; identifiers are the contract.

## The scan is a loop with four states

`checkWorldInfo` runs `while (scanState)` over the whole sorted entry list, once per pass:

- `INITIAL` — the first pass.
- `RECURSION` — a pass whose haystack includes the content of entries activated so far.
- `MIN_ACTIVATIONS` — a pass at increased depth, run when too few entries activated.
- `NONE` (0) — falsy, ends the loop.

Each pass collects `activatedNow`, filters it, and commits survivors to `allActivatedEntries`; two
entries activated in the same pass never see each other's content. The loop ends when a pass sets no
next state or `world_info_max_recursion_steps` is reached. That setting and `world_info_min_activations`
are mutually exclusive in the settings panel: setting either non-zero zeroes the other.

## What an entry is tested against

`WorldInfoBuffer` builds one haystack per entry, per pass:

- Chat, `#depthBuffer` — messages newest-first, capped at `MAX_SCAN_DEPTH`; slice length
  `entry.scanDepth ?? (world_info_depth + #skew)`, `#skew` incremented by `advanceScan()` once per
  min-activations pass. `#startDepth` is declared, read as the slice start, and never assigned
  (`upstream-st.md` #8).
- Global scan data — persona description, character description, personality, depth prompt, scenario,
  creator notes — appended per entry that opted in (`matchPersonaDescription` and friends).
- Injects — every extension prompt whose `scan` flag is set, snapshotted before the loop starts; this is
  how the Author's Note and depth injections become scannable.
- The recursion buffer — content of entries activated in previous passes, appended except during a
  `MIN_ACTIVATIONS` pass.

Segments are joined with `\n\x01` and the string starts with `\x01`.

## Sticky is persistence, and persistence is a different question from activation

Below, "sticky" means `timedEffects.isEffectActive('sticky', entry)`: the entry activated in an earlier
scan and its window has not run out, not that it has a `sticky` duration configured. The window is
written at the end of `checkWorldInfo` by `setTimedEffects` for every activated entry carrying a
`sticky` count, so an entry that just matched its keys is not sticky-active during that scan.

The window is `chat_metadata.timedWorldInfo.sticky[world.uid]`, `start` = chat length at activation,
`end = start + sticky`, evaluated once per scan by `checkTimedEffects`:

- Reaching `end` deletes the window; if the entry has a `cooldown`, the same callback opens it
  immediately and protected.
- A window whose `start` is not below the current chat length is deleted as "chat not advanced" unless
  protected, which is what keeps a swipe or regenerate from consuming the duration.
- An entry the scan cannot find keeps its window until the interval passes, then it is dropped. "Cannot
  find" is by `hash`, which `getSortedEntries` computes over the whole entry object, so editing an
  entry's content, keys or flags mid-window, or moving its `displayIndex`, silently ends the effect.

`cooldown` is the same machinery inverted. `delay` holds no metadata and is re-derived from
`chat.length < entry.delay` on every scan.

Persistence guarantees activation, not survival: a persisting entry skips the probability roll and wins
its inclusion group outright, but is budgeted like anything else unless it sets `ignoreBudget`.

## The order of checks decides more than the keys do

This ladder runs inside `for (const entry of sortedEntries)`, once per entry, first match wins; it is
branch precedence within one entry and ranks nothing against anything else.

1. Already in `allActivatedEntries`, or in `failedProbabilityChecks` — skipped. A failed probability
   roll is permanent for the rest of the scan.
2. `disable`.
3. `triggers` — generation type filter, one of `normal`, `continue`, `impersonate`, `swipe`,
   `regenerate`, `quiet`. An empty list means every type.
4. `characterFilter` names, then tags, each honouring `isExclude`.
5. `delay` — suppressed while `chat.length < entry.delay`. Nothing overrides this, persistence included.
6. `cooldown` — suppressed unless the entry is persisting.
7. `delayUntilRecursion` — suppressed outside a recursion pass, and inside one until the current delay
   level reaches the entry's. Persistence overrides both.
8. `excludeRecursion` — suppressed on recursion passes. Persistence overrides.
9. `@@activate` — activates, above `constant` and above every key check.
10. `@@dont_activate` — suppresses.
11. External activation (`buffer.getExternallyActivated`) — the `WORLDINFO_FORCE_ACTIVATE` route.
12. `constant`.
13. Persisting — activates without consulting keys.
14. No keys — skipped.
15. Primary keys — `find`, so the first match short-circuits.
16. Secondary keys, under `selectiveLogic`: AND_ANY and NOT_ALL short-circuit inside the loop; NOT_ANY
    and AND_ALL are decided after it.

The three suppressors persistence does not beat are `delay`, `disable` and `@@dont_activate`.

`vectorized` appears nowhere in the scan: a vectorized entry key-matches like a normal one, and the
flag only marks the entry for an extension — Vector Storage indexes `vectorized` entries and
force-activates what it retrieves through step 11. It is a UI tri-state with `constant`, so an entry
cannot be both.

Step 11 substitutes: `externalActivations` is a static `Map` keyed `world.uid`, and the ladder adds the
map's entry object rather than the one it was iterating, so a forcing extension can hand core a
modified copy. The map is not consumed on read and is cleared after every scan, so an entry suppressed
by a gate is re-offered on every later pass. Force-activation bypasses the key checks, not the gates:
a retrieved entry is still dropped by steps 2-10, and past the ladder still faces the inclusion group,
the probability roll, the budget, and the empty-after-regex check in the assembly.

Vector Storage's own cutoffs bound the index, not the activation. Entries that are orphaned,
`disable`d, empty, or not `vectorized` (unless `enabled_for_all`) are left out of the collections; each
book's collection is queried at `topK = max_entries`, the results merged, sorted by score, filtered by
`score_threshold`, and sliced back to `max_entries` hashes. The activation loop then walks the
unfiltered entry list and keeps everything whose content hashes to one of those values, so entries with
identical content all activate off a single retrieved hash and the emitted count can exceed
`max_entries`, and an entry excluded from the index is activated anyway when its content duplicates a
retrieved one — a non-`vectorized` entry keeps that activation, keys never consulted. Nothing dedupes by
content (`activatedNow` is a `Set` of objects, `allActivatedEntries` a `Map` keyed `world.uid`), so
every copy is budgeted and printed separately; the same book in two slots does not do this, since core
skips a world already activated elsewhere.

No retrieval ranking crosses this boundary. Vector Storage flattens its query results to a set of
hashes, walks `getSortedEntries()` and pushes whatever matches, so it emits in `order` sequence; core
then iterates its own `sortedEntries` and asks the map per entry. An extension wanting its own ranking
to survive has to impose it after the scan.

## Selection happens three times, in this order

Everything below runs on one pass's batch, after the loop above.

Batch order: persisting entries first, then by index in `sortedEntries` — `getSortedEntries`: each lore
source sorted by `order` descending, sources concatenated as chat lore, persona lore, then character
and global per `world_info_character_strategy`, so source class outranks `order` across books. The
index lookup is a `Map` keyed by object identity, falling back to `?? -1`; a force-activated entry is
the object the extension supplied and `getSortedEntries` ends in `structuredClone`, so the lookup never
hits and external entries sort at -1. The budget queue is therefore persisting, then force-activated,
then everything else by `order`: an active sticky window outranks a force-activation, `constant`
carries no weight (a constant entry holds a real index and loses to -1, so force-activating it promotes
it out of the `order` ranking), and `order` does not apply to external entries at all. That is the
reverse of the ladder, whose order decides only which object is used and which log line fires.

Persistence survives substitution because `isEffectActive` compares `entry.hash`, not object identity;
a hand-built entry without a matching `hash` sorts as merely external and stops winning its inclusion
group. Which pass an entry lands in outranks all of it: the budget is spent pass by pass and earlier
passes commit first, so anything held to a later pass — by `delayUntilRecursion`, or by being reachable
only through recursion text or a widened min-activations depth — competes for what is left, whatever
its `order`.

Inclusion groups (`filterByInclusionGroups`), for entries sharing a `group`:

1. Timed effects — a persisting entry in the group wins outright, and every later stage is skipped for
   that group.
2. Scoring — only when `world_info_use_group_scoring` or the entry's `useGroupScoring`; keeps the
   entries whose key match scores highest (`buffer.getScore`).
3. If the group already has an entry in `allActivatedEntries`, the whole group is dropped from this
   batch — a group activates once per scan, not once per pass.
4. `groupOverride` — the highest-`order` prioritized entry wins.
5. Otherwise a weighted random roll on `groupWeight` (default 100).

Probability, then budget, in one loop over the batch:

- `useProbability` and `probability < 100` roll; persisting entries skip the roll. A failure lands in
  `failedProbabilityChecks` for the whole scan.
- `budget = round(world_info_budget% × maxContext)`, capped by `world_info_budget_cap`, computed once
  before the loop. The entry is refused when `textToScanTokens + tokens(newContent) >= budget`, setting
  `token_budget_overflowed`. After overflow only `ignoreBudget` entries are admitted: a normal entry is
  skipped while an `ignoreBudget` entry is still ahead of it in the batch, and ends the loop once none
  are.
- Position is not consulted; a depth entry and a before-char entry compete on batch order alone.
  Force-activated entries are not exempt — nothing but `ignoreBudget` is — they spend it first.

The running total is not what reaches the prompt. Each pass starts from
`textToScanTokens = tokens(allActivatedText)`, and `allActivatedText` accumulates only
`successfulNewEntriesForRecursion` — successful minus `preventRecursion` — and only when the scan is
continuing. So a `preventRecursion` entry spends budget in its own pass and is invisible to every later
pass, and an entry refused by the budget still counts as successful: where the scan continues, its text
is charged to later passes and pushed into the recurse buffer despite never being activated.

## What makes the loop run again

- Recursion — `world_info_recursive` and at least one newly activated entry without
  `preventRecursion`; their content is pushed into the recurse buffer for the next pass.
- Min activations — fewer than `world_info_min_activations` total activated, and depth has not passed
  `world_info_min_activations_depth_max` or the chat length. Advances `#skew` by one.
- Delayed recursion levels — when nothing else continues the scan but `delayUntilRecursion` levels
  remain, the next level opens and forces one more recursion pass.
- Budget overflow blocks the first two, not the third: recursion and min activations are guarded on
  `!token_budget_overflowed`, the delayed-recursion branch is not, so an overflowed scan still runs a
  pass per remaining level in which only `ignoreBudget` entries can activate.

`WORLDINFO_SCAN_DONE` fires at the end of every pass, and core reads back `state.next`,
`activated.text`, `recursionDelay.currentLevel` and both budget fields from the event args, so a
listener can extend, redirect or halt the scan. That is the hook WA's stage 3 runs on.

## Assembly: six sinks, not one list

The tail of `checkWorldInfo` walks the survivors once and drops each into a sink by `position`; the
activated entries never exist as one ordered sequence of prompt text.

| `world_info_position` | sink | reaches the prompt as |
| --- | --- | --- |
| `before` (0), `after` (1) | `WIBeforeEntries`, `WIAfterEntries` | two joined strings, `worldInfoBefore` / `worldInfoAfter` |
| `ANTop` (2), `ANBottom` (3) | `ANTopEntries`, `ANBottomEntries` | wrapped around the Author's Note, re-injected via `setExtensionPrompt(NOTE_MODULE_NAME, …)` |
| `atDepth` (4) | `WIDepthEntries`, grouped by `(depth, role)` | one `IN_CHAT` extension prompt per group |
| `EMTop` (5), `EMBottom` (6) | `EMEntries`, tagged `before`/`after` | unshifted/pushed into `mesExamplesArray` |
| `outlet` (7) | `WIOutletEntries[outletName]` | a `NONE`-type extension prompt, rendered where its macro sits |

The AN sinks only fire when `shouldWIAddPrompt`; otherwise those entries are assembled and dropped, and
their placement is the Author's Note's own position, depth and role. `order` reverses between the two
halves: the budget ranks it descending, but the assembly re-sorts descending and then `unshift`s, so
within a block the highest-`order` entry is evaluated first and printed last; across positions `order`
is never compared, which is why `reportLayout` in `worldsapart.js` groups by position before ranking.

The content that lands is not the content that was budgeted. Macros are substituted in the budget loop,
mutating the entry in place before counting; regex scripts run in the assembly
(`regex_placement.WORLD_INFO`, with the entry's depth for `atDepth` and `null` elsewhere); an entry
emptied by a regex is skipped after spending its budget and while remaining in `allActivatedEntries`,
so the activation event and the log count both still include it.

Text completion passes the strings to the story string template as `wiBefore`/`wiAfter` (aliased
`loreBefore`/`loreAfter`), and every shipped context preset places `wiBefore` after the system prompt
and `wiAfter` after the scenario — the preset's choice. Chat completion turns them into two system
messages, `worldInfoBefore`/`worldInfoAfter`, ordered by the preset's prompt manager. "Before char"
names a default layout, not a guarantee.

## Quirks worth knowing

- Depth grouping keys on `entry.depth ?? DEFAULT_DEPTH` but stores the raw `entry.depth`, which only
  bites a book whose `depth` is present and null.
- Outlet entries with no `outletName` are warned about and dropped, after being budgeted.
- A dry run still assembles every block and still fires the AN re-injection. It suppresses
  `WORLD_INFO_ACTIVATED` and the sticky/cooldown state writes (`WorldInfoTimedEffects` `isDryRun`);
  `delay` is evaluated either way.
