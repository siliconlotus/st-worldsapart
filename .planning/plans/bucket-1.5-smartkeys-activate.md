# Bucket 1.5 — SmartKeys activate: implementation plan

Authority for WHAT and WHY: `matcher-design.md` § Bucket 1.5. This file is task sequencing only —
when the two disagree, the design doc wins and this file is stale.

Rulings this plan builds on (all in the doc): union force-activation with the two guards;
`messageDepth` supersedes core's depth; deletion ships with no group guard (deleted winner leaves
its group empty, transient until bucket 2); the group fixture is a prerequisite for deletion
(`.planning/todos/pending/group-inclusion-fixture.md`).

## Shape

Two independent directions, shipped in this order:

- **Union (add):** at intercept, WA matches every candidate entry's keys over its own window and
  force-activates the matches alongside the retrieval winners. Superset of core for the default
  substring path; the only route by which a `?` SmartKeys-only entry can ever activate.
- **Prune (remove):** at `WORLDINFO_SCAN_DONE`, WA deletes activated entries its matcher rejects,
  subject to an exemption list. Safe only because of task 3: the interceptor's `chat` argument IS
  core's scan haystack (script.js builds `chatForWI` from the same `coreChat` — regex-scripted,
  file content appended, titles, reasoning merged — that interceptors receive), so once WA scans
  the stashed copy instead of raw `getContext().chat`, a WA no-match over the shared text is a
  rule verdict, not a haystack gap. Ruled: prune is not a setting — it ships on, and the corpus
  audit (task 5) is the debugging instrument that surfaces surprises in data rather than in play
  (residual deltas expected: injects, other extensions' buffer additions).

Depth semantics fall out asymmetrically and that is accepted: union enforces the ruled depth in the
common direction (WA deeper than core = adds). A `messageDepth` narrower than core's depth is the
prune direction; with the shared haystack it is cleanly distinguishable (the match exists in the
stash beyond WA's window), so v1 may enforce it — the group caveat it inherits is already ruled.

## Tasks

### 1. Pure verdict functions + check

In `extension/ranking.mjs` (stays ST-free, node-importable):

- `activationAdds(entries, windowsByDepth, opts)` → entries WA would force-activate.
  Candidacy guards, in order: skip `disable`; skip vectorized entries when
  `opts.suppressVectorKeys` (stage-2 guard — at intercept `onEntriesLoaded` has NOT yet blanked
  keys, so the guard must be applied here, not inferred from empty `key`); skip keys whose
  `validateSmartKey` reports an error **or negation-only** (advisory today only because these
  cannot activate — that stops being true here; verify the validator's return shape and treat
  negation-only as activation-blocking). Match = any key with `countKey > 0` over the entry's
  resolved-depth window (per-entry `scanDepth` || `messageDepth`; core's `world_info_depth` is not
  consulted — the ruled resolution `rankActivated` already uses).
- `activationPrunes(items, exempt, opts)` → keys to delete from the activated map. An item is
  prunable only when: keys eligible (live keys; never judge suppressed-vectorized entries by their
  stashed `waKeys`), zero WA matches over its resolved window, and not in `exempt`. `exempt` is
  built by the caller (task 4) — the pure function just honors it.

Check: `eval/activation-check.mjs`, self-checking, no arguments. Covers: SmartKeys-only entry
admitted; validator-error and negation-only keys skipped; suppressed-vectorized skipped both
directions; per-entry `scanDepth` beats `messageDepth`; `matchWindow` segmentation respected
(a key split across segments does not match); prune exemptions honored.

### 2. Union wiring at intercept

In `worldsapart.js`:

- Restructure `retrieve()` so the keyword union runs even when vector retrieval returns nothing
  (`!rawText` / `!scores.size` early-returns currently skip the emit entirely — on a keyword-only
  book the union IS the feature, per divergence-audit's "window miss" class).
- Build windows the same way stage 3 does (`ranking.scanSegments` over `is_system`-filtered chat,
  plus `scanInjects()` and `withMatchSources` where available at intercept; if injects are not yet
  registered at intercept time, match without them and note it — under-matching only costs an
  addition core may still make itself).
- One `WORLDINFO_FORCE_ACTIVATE` emit: retrieval winners ∪ union adds. Record the union set in
  `runState` (provenance for /wa-debug, and the prune exemption in task 4).
- Core handles everything post-activation: forced entries go through its probability roll and
  group filter (verified in world-info.js — forced entries join `activatedNow`).

Known scope limit, documented not solved: union matches chat text at intercept, so SmartKeys
cannot match recursion text in 1.5. Bucket 2's territory.

### 3. Scan-haystack stash — use the transformed chat WA already receives

`intercept(chat)` receives the transformed `coreChat` (regex scripts applied, file content and
titles appended, reasoning merged) — the exact array core builds `chatForWI` from. `rankActivated`
currently discards it and rebuilds windows from raw `getContext().chat`, which is a standing
stage-3 fidelity gap independent of this bucket: WA scores keys over text core never scanned.

- Stash the received chat in `runState` at the top of `intercept`, before the `quiet` early-return
  (interceptors run on quiet generations too; a quiet scan must not judge against the previous
  generation's stash). Clear or version the stash per generation.
- `rankActivated` builds its windows from the stash, falling back to filtered `getContext().chat`
  only when no stash exists. Delete the "(Core also regex-scripts messages…; not mirrored here)"
  caveat comment — it stops being true.
- Union (task 2) matches over the same received chat by construction, so both directions and
  stage-3 scoring share one haystack.

### 4. Prune wiring in rankActivated

- Judge only entries first seen in the initial scan pass (`args.state` — recursion- and
  min-activation-pass entries are core's prerogative; deleting a recursion activation on a
  chat-window verdict would be flatly wrong). `rankActivated` fires per scan loop, so track
  first-seen state per generation.
- Exemptions: WA's own forced set (retrieval + union), `constant`, sticky
  (`args.timedEffects.isEffectActive`), decorator-activated (`@@activate` in content), and
  externally-forced entries from other extensions if `WorldInfoBuffer.externalActivations` is
  importable — if it is not, note it and accept the risk (rare).
- Delete from `args.activated.entries` before `fuseRanks`/budget, same documented mutation
  `applyBudget` uses. No group guard (ruled). Log deletions in /wa-debug output — the runtime
  must agree with what the tools report, visibly.
- No setting (ruled) — prune is part of what WA's enable means. Neither direction adds a setting;
  the plugin is untouched, no redeploy.
- Lands only after the group fixture exists (task 6's group half) — the ruled prerequisite for
  deletion.

### 5. Corpus prune audit (debugging instrument)

Against the standard chat set (`eval/eval-data/README.md`, usable messages only): for each chat,
enumerate entries core activates that prune deletes, classified by cause where determinable
(rule divergence vs residual haystack delta vs depth). Divergence-audit-style tool or an extension
of it. Not a gate — prune ships on regardless — but every unexplained deletion here is a bug to
chase before it is a mystery in play.

### 6. Fixture certification

- Sentinel fixture: add a `?` SmartKeys-only entry whose audit verdict and Studio behavior are
  written down — certifies the union end to end at the layer the UI uses.
- Group fixture per `.planning/todos/pending/group-inclusion-fixture.md` — prerequisite for
  prune: false winner (`caf` against "café" — ASCII key, non-ASCII adjacent text), clean loser,
  certified group-empty outcome.

### 7. Close out

Flip Bucket 1.5 status in `matcher-design.md` (propose the edit first, per repo convention).
Regression suite stays silent-clean: `for f in eval/*-check.mjs; do node "$f"; done`.

## Order and dependencies

1 → 2+3 (union shippable alone) → 6 group half → 4 (prune) → 5 (audit) → 7. Task 6's sentinel half
can land with task 2; the group half is the ruled prerequisite for prune landing at all.
