<!-- refreshed: 2026-08-04 -->
# Architecture

**Analysis Date:** 2026-08-04

## System Overview

Worlds Apart takes over World Info selection, ranking and budget from SillyTavern core. It intercepts three activation points:

1. **WORLDINFO_ENTRIES_LOADED** — suppress keyword matching on vectorized entries
2. **generate_interceptor** — chunked vector retrieval, force-activate top results
3. **WORLDINFO_SCAN_DONE** — rank everything activated, apply budget, rewrite entry order

The architecture splits into two radically different halves:

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    ST-Coupled Layer (DOM + ST API)                  │
│  `worldsapart.js` | `keyword-tools.mjs` | `studio.mjs` | `ui-*.mjs` │
│  Settings / Events / UI / Plugin Discovery                          │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                      │
         ▼                    ▼                      ▼
┌──────────────────┬──────────────────┬──────────────────────┐
│  State & Config  │  Classification  │  UI & Visualization  │
│  `state.mjs`     │  `keyword-*.mjs` │  `studio.mjs`        │
│                  │  `grading.mjs`   │  `sort.mjs`          │
│                  │  `bindings.mjs`  │                      │
└──────────────────┴──────────────────┴──────────────────────┘
         │                    │                      │
         └────────┬───────────┴──────────────────────┘
                  │
         ┌────────▼────────────────────────────────────────┐
         │                                                 │
         │         Pure Isomorphic Core (Node-importable) │
         │  No DOM, no ST imports, deterministic output    │
         │                                                 │
         └────────┬────────────────────────────────────────┘
                  │
      ┌───────────┼──────────────────────────────────────┐
      │           │                                      │
      ▼           ▼                                      ▼
┌──────────────┐ ┌──────────────────┐ ┌────────────────────┐
│ Matching     │ │ Scoring & Fusion │ │ Selection & Ranking│
│              │ │                  │ │                    │
│ smartkeys.mjs│ │ ranking.mjs      │ │ selection.mjs      │
│              │ │ scoring.mjs      │ │ sort.mjs           │
│ chunking.mjs │ │ vector.mjs       │ │ grading.mjs        │
│              │ │ keyword-core.mjs │ │                    │
└──────────────┘ └──────────────────┘ └────────────────────┘
      │                   │                      │
      └───────────────────┼──────────────────────┘
                          │
                 ┌────────▼────────────────────┐
                 │  Shared Matchers & Folding  │
                 │   (plugin/ + re-exported)   │
                 │                            │
                 │ automaton.mjs (literal)    │
                 │ commonwords.js (frequency) │
                 │ lexical.mjs (word shape)   │
                 └────────┬────────────────────┘
                          │
              ┌───────────┴────────────────────┐
              │                                │
              ▼                                ▼
        ┌──────────────┐            ┌────────────────────┐
        │   Plugin     │            │  Server-side Ops   │
        │ (Generated)  │            │                    │
        │              │            │ fingerprint.mjs    │
        └──────────────┘            │ server.js          │
                                    │ lexical.mjs        │
                                    │ automaton.mjs      │
                                    └────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| ST Hook Handler | Intercepts keyword suppression, vector retrieval, ranking | `worldsapart.js` |
| Settings Seam | Single source for WA configuration | `extension/state.mjs` |
| SmartKey Parser | Boolean query syntax for `?`-prefixed keys | `extension/smartkeys.mjs` |
| Keyword Ranker | Entity filter, BM25/TF-IDF, RRF fusion tuning | `extension/ranking.mjs` |
| Selection Cutoff | Elbow/dropoff/count mode: how many results survive | `extension/selection.mjs` |
| Entry Sorter | Tier grouping and sort order definitions | `extension/sort.mjs` |
| Key Classifier | Prune scan, TF-IDF suggestion, LLM candidate filter | `extension/keyword-core.mjs` |
| Key Tools (ST-coupled) | Flag injection, LLM generation plumbing | `extension/keyword-tools.mjs` |
| Studio UI | Lorebook editor: books list, entries, tools, search | `extension/studio.mjs` |
| UI Widgets | Sort controls, tier editor, context menus, stylesheet | `extension/ui-widgets.mjs` |
| Chunker | Entry text splitting before embedding (verbatim ST port) | `extension/chunking.mjs` |
| Literal Matcher | Aho-Corasick automaton for `countKey` | `plugin/automaton.mjs` |
| Vector Scoring | L2 norm, mean-centered cosine similarity | `plugin/vector.mjs` |
| Grading | Scene capture and evaluation bundle assembly | `extension/grading.mjs` |
| Binding Repair | Orphaned chat/character → lorebook detection | `extension/bindings.mjs` |
| Fingerprinting | Plugin deployment integrity | `plugin/fingerprint.mjs` |

## Pattern Overview

**Overall:** Isomorphic core layer + ST-coupled plumbing.

**Key Characteristics:**
- **Pure core** (`extension/*.mjs` excluding `*-tools.mjs`, `studio.mjs`, `ui-*.mjs`, `state.mjs`) runs identically under Node for offline evaluation
- **One matcher** — `countKey()` in `ranking.mjs` is the single source of truth for key firing rules; audit, pruner, and Studio coloring all call it
- **Shared literals** — `automaton.mjs` and `normalizeOrthography` live in `plugin/` so both server and browser run the same matcher without duplication
- **Injected config** — Settings and ST globals are never imported; they're passed by the caller, so the pure layer stays deterministic
- **Unit Separator delimiters** — Composite keys use `\x1F` (US), not NUL, so they're safe for `git diff` and `grep`

## Layers

**ST-Coupled Interface** (`worldsapart.js`):
- Purpose: Bridge SillyTavern API to WA logic; manage plugin lifecycle
- Location: `/worldsapart.js`
- Contains: Event handlers, hook callbacks, plugin deployment verification
- Depends on: ST's `script.js`, `extensions.js`, `world-info.js` + all WA extension modules
- Used by: SillyTavern core at runtime

**Settings & State** (`extension/state.mjs`):
- Purpose: Centralized config and settings accessor
- Location: `extension/state.mjs`
- Contains: `defaultSettings`, `settings()` function, module name
- Depends on: ST's `extension_settings`
- Used by: All other extension modules that need configuration

**Classification Layer** (`extension/keyword-core.mjs`, `extension/keyword-tools.mjs`):
- Purpose: Identify weak keys (TF-IDF, frequency, length), suggest improvements, rate LLM candidates
- Location: `extension/keyword-core.mjs` (pure), `extension/keyword-tools.mjs` (ST-coupled)
- Contains: `buildKeyPruneScan`, `buildKeySuggest`, `classifyLlmCand`, LLM prompt building
- Depends on: `COMMON_WORDS` and Zipf frequency tables from plugin; `countKey` from `ranking.mjs`
- Used by: Studio UI, LLM pipelines, evaluation harnesses

**Ranking & Selection** (`extension/ranking.mjs`, `extension/selection.mjs`):
- Purpose: Score retrieved entries (BM25/TF-IDF), fuse multiple signals (RRF), decide cutoff
- Location: `extension/ranking.mjs` (scores), `extension/selection.mjs` (cutoff modes)
- Contains: Entity filter, vocabulary builder, fusion weights, elbow/dropoff/count modes
- Depends on: SmartKey evaluator (`smartkeys.mjs`), vector similarity (`plugin/vector.mjs`)
- Used by: Main prompt hook, evaluation grid tools

**Matching Engine** (`extension/smartkeys.mjs`, `extension/ranking.mjs`):
- Purpose: Parse `?` queries, match regex/literal keys, decide if a key fires
- Location: `extension/smartkeys.mjs` (query parser), `extension/ranking.mjs` (routing to `countKey`)
- Contains: Boolean query syntax, `countKey()` dispatcher, regex/literal/SmartKey routes
- Depends on: Literal matcher (`plugin/automaton.mjs` re-exported)
- Used by: Audit, pruner, Studio keyword coloring, runtime matching

**Presentation & Sort** (`extension/sort.mjs`):
- Purpose: Define tier grouping, entry ordering, sort vocabulary and labels
- Location: `extension/sort.mjs`
- Contains: `TIER_DEFS`, `SORT_FNS`, presentation labels and aliases, `tierRank`
- Depends on: Nothing (pure)
- Used by: Studio display, prompt builder insertion order, evaluation tools

**Studio UI** (`extension/studio.mjs`, `extension/ui-widgets.mjs`):
- Purpose: Two-pane lorebook editor and tool panels
- Location: `extension/studio.mjs` (logic), `extension/ui-widgets.mjs` (widgets)
- Contains: Entry list display, edit forms, keyword coloring, bulk actions, search
- Depends on: Classification (`keyword-tools.mjs`), sorting (`sort.mjs`), chunking (`chunking.mjs`), matcher (`smartkeys.mjs`)
- Used by: User via `/wa-studio` slash command

**Data Capture & Analysis** (`extension/grading.mjs`, `extension/bindings.mjs`):
- Purpose: Assemble graded scenes for offline evaluation; detect orphaned bindings
- Location: `extension/grading.mjs` (evaluation samples), `extension/bindings.mjs` (binding repair)
- Contains: Scene bundling, book snapshot logic; binding normalization and edit distance
- Depends on: Nothing (pure)
- Used by: Grading UI, evaluation harnesses, plugin reload checks

**Evaluation Harnesses** (`eval/`):
- Purpose: Regression suite and offline tuning tools
- Location: `eval/`
- Contains: `*-check.mjs` (regression tests), `graded-scene-grid.mjs` / `paired-arms.mjs` (benchmark tools), libraries (`scene.mjs`, `metrics.mjs`)
- Depends on: Pure core modules (no ST imports); loads books/chats from disk
- Used by: Manual tuning; CI pipeline regression checks

## Data Flow

### Primary Request Path (Vector Retrieval → Selection → Ranking)

1. User sends message → `generate_interceptor` hook (`worldsapart.js:generate`)
2. Chunked query retrieval from vector index → `centeredCosineScores()` in `plugin/vector.mjs`
3. Fused ranking of all activated entries → `ranking.mjs` BM25/TF-IDF scores, RRF combination
4. Selection cutoff applied → `selection.mjs` (elbow/dropoff/count mode)
5. WORLDINFO_SCAN_DONE hook rewrites `order` to final ranking → `worldsapart.js:onWIScanDone`
6. ST core inserts ranked entries into prompt at configured positions

### Keyword Matching Path (Studio Edit → Audit → Coloring)

1. User edits a key in Studio → `studio.mjs` entry form
2. Audit runs `buildKeyPruneScan()` → `keyword-tools.mjs` (flags injected) → `keyword-core.mjs` (classifier)
3. Prune scan reports weak keys (common, too-short, over-share) → colored chips in UI
4. User hovers chip → tooltip explains why it flagged
5. User clicks "Suggest" → `buildKeySuggest()` in `keyword-core.mjs`, optionally LLM fallback
6. Keyword coloring in Studio text uses `countKey()` to show what fires (green/yellow/red)

### SmartKey Evaluation (For `?` Queries)

1. User writes `? fire -water` key → stored in entry's key field
2. At runtime, `countKey()` in `ranking.mjs` detects `?` prefix
3. Routes to `evaluateSmartKey()` in `smartkeys.mjs`
4. Parser builds query tree, evaluator scores matches with Aho-Corasick automaton
5. Result: true/false for entry activation

**State Management:**
- **Persistent**: Settings in `extension_settings`, lorebook data in ST's world-info structures, graded scenes in `eval-data/`
- **Ephemeral**: RunState object in `state.mjs` tracks current book/chat context for the Studio session
- **Derived**: Vector index loaded on demand (not owned by WA; ST/vectra manages it)

## Key Abstractions

**countKey()**:
- Purpose: Single source of truth for whether a key fires in prose
- Examples: `ranking.mjs`, `smartkeys.mjs` route through it; audit/pruner/Studio all call it
- Pattern: Dispatcher that routes to literal/regex/SmartKey matchers based on key form
- Never re-implemented; every caller goes through the one definition

**normalizeOrthography() & fold()**:
- Purpose: Normalize text to a canonical form before matching (apostrophe variants, marks, case-folding)
- Examples: `automaton.mjs` (definition), `smartkeys.mjs` (re-export), `ranking.mjs` (re-export)
- Pattern: Shared between plugin (server) and extension (browser) to stay in sync
- Careful boundary: Only touches orthography (accent marks, quotes, spaces), never semantics

**Tier System**:
- Purpose: Group entries by type (constant, sticky, keyword, vector, disabled) with user-definable order
- Examples: `sort.mjs` defines tiers; `studio.mjs` displays them; prompt builder ranks by tier
- Pattern: Array of `{ id, on, label, test }` where `test` is an entry predicate
- Single precedence rule: Entry matches first enabled tier whose predicate passes

**Scene Bundle** (grading.mjs):
- Purpose: Self-contained snapshot of one evaluation scenario
- Contains: Query text, grades, settings snapshot, book data (full/meta/none), vector index path
- Pattern: JSON with versioning; off-line harnesses load and score it reproducibly
- Advantage: Months later, scores still describe the same configuration (no drift)

## Entry Points

**Browser (Runtime):**
- `worldsapart.js` — ST extension entry; hooks `WORLDINFO_ENTRIES_LOADED`, `generate_interceptor`, `WORLDINFO_SCAN_DONE`
- Initializes on load: settings validation, plugin fingerprint check, event listeners
- Exports: Splash logging, async `init()` and `unload()` for extension lifecycle

**Studio UI:**
- `/wa-studio` slash command → `lorebookStudio()` in `extension/studio.mjs`
- Two-pane editor with book list and entry details
- Persists UX state in runState; saves edits via ST's `saveWorldInfo()`

**Grading UI:**
- `/wa-grade` slash command → `captureParams()` in `worldsapart.js` → bundled sample written to disk
- `/wa-super-grade` — multi-arm capture (union of results from several configurations)
- Samples gitignored; harnesses read them back and score

**Evaluation (Offline):**
- `eval/*-check.mjs` — run with `node eval/foo-check.mjs`, print `ok` or `FAIL`
- `eval/graded-scene-grid.mjs`, `eval/paired-arms.mjs` — require lorebook + scene path arguments
- `eval/scene.mjs`, `eval/metrics.mjs` — shared libraries, no CLI
- `eval/fixtures/install-sentinel.mjs` — symlinks synthetic test data for Studio to open

**Plugin Deployment:**
- `node deploy-plugin.mjs` — reads `plugin/*.mjs`, bundles into `plugin/server.js` for `vector.mjs` import

## Architectural Constraints

- **Threading**: Single-threaded event loop (browser). Plugin side (`plugin/server.js`) runs in a worker thread; async boundaries are request/response.
- **No module-level singletons**: Settings are read from `extension_settings` at call time; no caching of config values. Query state passed through function args.
- **No circular imports**: Pure layer has no backward dependencies. Plugin can import from pure; pure cannot import from plugin (reverse is one-way).
- **Isomorphism requirement**: Functions in `extension/ranking.mjs`, `smartkeys.mjs`, `keyword-core.mjs`, `selection.mjs`, `sort.mjs`, and `plugin/*.mjs` must run identically under Node and in the browser. No DOM, no `import.meta`, no `require()`.
- **One matcher, one fold**: `countKey()` and `normalizeOrthography()` are defined once; duplication is forbidden by CLAUDE.md and enforced by eval checks.
- **Chunk format is frozen**: `chunking.mjs` is a verbatim port of ST's splitter; changing it invalidates all existing vector indexes with no warning signal. Guarded by `eval/chunking-check.mjs` which compares against stored chunks.

## Anti-Patterns

### Re-deriving Match Logic

**What happens:** A new place in the code adds its own check for whether a key fires (e.g., "is this a regex key?", "does this term match?")
**Why it's wrong:** `countKey()` is the single source of truth. Two implementations diverge over time, and when they disagree, the audit reports one thing but runtime fires a different thing.
**Do this instead:** Call `countKey()` from `ranking.mjs`. It routes to the right matcher. If you need to add a matcher type, add it there and route through it.

### Duplicating Matchers or Folding Logic

**What happens:** Copy `automaton.mjs` or `normalizeOrthography()` into a new location
**Why it's wrong:** Server and browser now disagree silently. A chat displays different results on the server side vs. the web side.
**Do this instead:** `automaton.mjs` lives in `plugin/` and is re-exported by `smartkeys.mjs`. Both sides import from there. One copy.

### Caching Settings at Module Load Time

**What happens:** Read `settings()` once and store in a variable, then use the cached value
**Why it's wrong:** Settings change at runtime (user adjusts them in ST settings panel). Cached values are stale and the code silently uses outdated config.
**Do this instead:** Call `settings()` at use time. It's a lookup, not expensive. Offline harnesses inject different values anyway.

### Carrying State in the Plugin

**What happens:** Store the book/chat context or current sort order in a module-level variable in `plugin/` code
**Why it's wrong:** Plugin runs in a worker thread; each request gets fresh state, but a lingering variable would violate that. Offline harnesses can't inject fixtures.
**Do this instead:** Pass all context through function arguments. The caller (extension side) holds the state; plugin is stateless.

## Error Handling

**Strategy:** Fail open and log. WA is optional; a WA crash must not take down the prompt.

**Patterns:**
- Vector retrieval failure → log, return empty array, core's keyword matching still runs
- Plugin fingerprint mismatch → show drift banner, continue (Plugin may be out of date but is still callable)
- LLM generation timeout → abandon that key, return partial suggestion results
- Binding repair failure (orphaned book) → list the orphan, offer manual repair; don't auto-rewrite
- Invalid scene (stale index) → skip it, report which book's index is stale
- Chunking mismatch (check detects staleness) → log drift count, use the old chunks (they're still correct for the stored vectors)

## Cross-Cutting Concerns

**Logging**: Console only. Warnings and errors go to the browser console. Evaluation tools print to stdout. No persistent log files in the extension.

**Validation**: Keys are validated at three points: entry edit (audit shows flags), prompt generation (LLM candidate filter), and runtime matching (`countKey` rejects malformed regex). Entry UIDs are validated against duplication at save time.

**Authentication**: None. WA operates entirely within ST's authentication model. Vector index access is through ST's API; lorebook edits are persisted through ST's save path.

---

*Architecture analysis: 2026-08-04*
