# Codebase Structure

**Analysis Date:** 2026-08-04

## Directory Layout

```
WorldsApart/
├── extension/           # Browser-side pure + ST-coupled modules
│   ├── ranking.mjs      # Retrieval tuning (entity filter, BM25, RRF fusion) — PURE
│   ├── keyword-core.mjs # Key classification (prune, suggest, LLM filter) — PURE
│   ├── keyword-tools.mjs# ST-coupled wrapper (flag injection, LLM generation)
│   ├── smartkeys.mjs    # Boolean query parser and evaluator — PURE
│   ├── selection.mjs    # Cutoff modes (elbow/dropoff/count) — PURE
│   ├── sort.mjs         # Tier defs, sort functions, presentation labels — PURE
│   ├── studio.mjs       # Two-pane lorebook editor — ST-coupled
│   ├── ui-widgets.mjs   # Sort controls, tier editor, tooltips, CSS — ST-coupled
│   ├── chunking.mjs     # Entry text splitting (ST verbatim port) — PURE
│   ├── grading.mjs      # Evaluation sample bundling — PURE
│   ├── bindings.mjs     # Orphaned binding detection — PURE
│   ├── state.mjs        # Settings seam and config — ST-coupled
│   └── zipf-en.js       # English word frequency data and POS tables
├── plugin/              # Server-side isomorphic modules (deployed to /plugins/)
│   ├── automaton.mjs    # Aho-Corasick literal matcher — PURE, SHARED
│   ├── vector.mjs       # L2 norm, cosine similarity — PURE
│   ├── scoring.mjs      # BM25 term frequency scoring — PURE
│   ├── lexical.mjs      # Word shape classifier (caps, mixed case) — PURE
│   ├── fingerprint.mjs  # Plugin deployment integrity
│   ├── server.js        # Generated bundle (output of deploy-plugin.mjs)
│   └── commonwords.js   # English stop word list
├── eval/                # Offline evaluation harnesses and regression suite
│   ├── *-check.mjs      # Regression tests (run: `node foo-check.mjs`)
│   ├── scene.mjs        # Library: load and score one graded scene
│   ├── metrics.mjs      # Library: shared statistics and scoring helpers
│   ├── graded-scene-grid.mjs   # Benchmark: grid search over parameter sets
│   ├── paired-arms.mjs  # Benchmark: sign test against baseline
│   ├── keyword-audit.mjs        # Tool: audit all books for weak keys
│   ├── relevance-eval.mjs       # Tool: measure retrieval quality
│   ├── summary-center.mjs       # Tool: analyze summary quality
│   ├── fixtures/        # Synthetic test data
│   │   ├── sentinel-book.jsonl  # Synthetic lorebook
│   │   ├── sentinel-chat.jsonl  # Synthetic chat
│   │   └── install-sentinel.mjs # Symlink fixtures into data/default-user/
│   ├── eval-data/       # Test data and results (gitignored)
│   │   ├── README.md    # Corpus metadata, curation status
│   │   ├── CORPUS-MAP.md        # Which chats are in the standard set
│   │   ├── CURATION-*.md        # Per-book curation notes
│   │   ├── ab-curve.mjs # Shared curve data
│   │   ├── corpus-map.mjs       # Standard chat set
│   │   ├── curation-set.mjs     # Curation flags by book
│   │   └── *.jsonl (samples)    # Graded scenes from /wa-grade captures
│   └── pool-extend.mjs, pool-extend.md  # Pool management helper
├── worldsapart.js       # Main ST extension entry point; hooks + CLI commands
├── CLAUDE.md            # Project discipline, design rules, eval structure
├── matcher-design.md    # SmartKey grammar, activation, key matching rules
├── keyword-suggest-design.md    # Key quality criteria, suggestion logic
├── README.md            # User-facing overview
├── SMARTKEYS.md         # User guide for ?-query syntax
├── manifest.json        # Extension metadata
├── deploy-plugin.mjs    # Build script: bundle plugin/*.mjs → plugin/server.js
├── .claude/             # Project-specific configuration
│   └── agents/entry-vocabulary.md       # Terminology for CI/CD automation
├── .planning/           # GSD codebase mapping output (generated)
│   └── codebase/        # Generated architecture docs
│       ├── ARCHITECTURE.md
│       ├── STRUCTURE.md
│       └── (CONVENTIONS.md, TESTING.md, CONCERNS.md, etc. on demand)
└── .git/
```

## Directory Purposes

**`extension/`:**
- Purpose: Browser-side logic for retrieval, ranking, key analysis, and the Studio UI
- Contains: Pure algorithms (ranking, matching, sorting) and ST-coupled wrappers (UI, settings integration)
- Key files: `ranking.mjs` (main retrieval tuning), `smartkeys.mjs` (key matching), `studio.mjs` (editor)
- Naming: `*-core.mjs` for pure classifier/suggester; `*-tools.mjs` for ST wrapper

**`plugin/`:**
- Purpose: Server-side modules deployed to `/plugins/worlds-apart/` for backend integration
- Contains: Isomorphic pure code that runs on both server (Node.js) and browser
- Key files: `automaton.mjs` (one-copy-always matcher), `vector.mjs` (similarity), `server.js` (generated bundle)
- Naming: `.mjs` for isomorphic ES modules; `.js` for deployed output or legacy

**`eval/`:**
- Purpose: Offline evaluation, regression testing, and parameter tuning
- Contains: Self-checking regression tests, benchmark harnesses, test data, evaluation libraries
- Substructure:
  - `*-check.mjs` — regression suite (CI-runnable)
  - `scene.mjs`, `metrics.mjs` — shared libraries
  - `graded-scene-grid.mjs`, `paired-arms.mjs` — benchmark tools
  - `fixtures/` — synthetic test book and chat; `install-sentinel.mjs` symlinks them for Studio
  - `eval-data/` — corpus metadata, graded scenes, curation notes (gitignored eval-data/*.jsonl)

**`eval-data/`:**
- Purpose: Test corpus and graded evaluation snapshots
- Generated: Partially (graded scenes from `/wa-grade` and `/wa-super-grade` commands)
- Committed: Metadata only (README.md, CORPUS-MAP.md, curation notes); `.jsonl` scene files are gitignored
- Rationale: Graded scenes contain one user's private chats; corpus map records which public books are in the eval set

**`.claude/`:**
- Purpose: Project-specific agent configuration
- Contains: Entry vocabulary for CI/CD automation
- Generated: No; manually maintained

**`.planning/`:**
- Purpose: GSD codebase mapping output (generated by `/gsd-map-codebase`)
- Contains: ARCHITECTURE.md, STRUCTURE.md, and (on demand) CONVENTIONS.md, TESTING.md, CONCERNS.md
- Generated: Yes; overwritten on each mapping run
- Committed: Yes; GSD tools load from here during phases

## Key File Locations

**Entry Points:**
- `worldsapart.js` — Main extension; hooked by ST on load; `init()` entry point
- `extension/studio.mjs:lorebookStudio()` — Called by `/wa-studio` slash command
- `extension/grading.mjs:captureParams()` — Called by `/wa-grade` and `/wa-super-grade` commands
- `eval/*-check.mjs` — CLI entry points for regression tests (no imports)
- `eval/graded-scene-grid.mjs`, `eval/paired-arms.mjs` — CLI benchmark tools (require book + scene path)

**Configuration:**
- `extension/state.mjs` — Single source for settings: `defaultSettings`, `settings()` function
- `manifest.json` — Extension metadata (name, version, author)
- `CLAUDE.md` — Project discipline and design rules (read before modifying module headers)

**Core Logic:**
- `extension/ranking.mjs` — Retrieval tuning: entity filter, vocabulary, BM25/TF-IDF, fusion
- `extension/smartkeys.mjs` — Boolean query parser; routes through `countKey()` for key matching
- `extension/keyword-core.mjs` — Prune classifier, TF-IDF suggester, LLM candidate filter
- `extension/selection.mjs` — Elbow/dropoff/count cutoff modes
- `extension/sort.mjs` — Tier definitions, sort comparators, presentation labels
- `plugin/automaton.mjs` — One-copy-always Aho-Corasick matcher (shared by browser and server)

**Testing & Evaluation:**
- `eval/sentinel-check.mjs` — Regression test for synthetic fixture (always runs first)
- `eval/bindings-check.mjs`, `eval/matcher-check.mjs`, `eval/chunking-check.mjs` — Core functionality checks
- `eval/graded-scene-grid.mjs` — Run: `node eval/graded-scene-grid.mjs eval-data/sample.jsonl` (needs scene file)
- `eval/paired-arms.mjs` — Sign test benchmark (see CLAUDE.md for usage)
- `eval/fixtures/install-sentinel.mjs` — Run to symlink test data for Studio

**Design Docs:**
- `keyword-suggest-design.md` — Authority on key quality; update before proposing changes to `buildKeySuggest`
- `matcher-design.md` — SmartKey grammar, activation rules, matching principles; read before changing `countKey` or `smartkeys.mjs`
- `SMARTKEYS.md` — User guide for boolean query syntax
- `README.md` — User-facing overview

**Plugin Deployment:**
- `plugin/fingerprint.mjs` — Defines which files are in the deployed bundle
- `deploy-plugin.mjs` — Build script; run `node deploy-plugin.mjs` to create `plugin/server.js`
- `/plugins/worlds-apart/` (external) — Deployed copy; WA shows a drift banner if fingerprints don't match

## Naming Conventions

**Files:**
- `*-core.mjs` — Pure classifier or core algorithm (`keyword-core.mjs`, not `keyword-classifier.mjs`)
- `*-tools.mjs` — ST-coupled wrapper that injects flags or plumbing (`keyword-tools.mjs`)
- `*-check.mjs` — Self-checking regression test; prints `ok` on success
- `*-grid.mjs` — Parameter sweep benchmark tool
- `*-design.md` — Design doc carrying architectural decisions (read before modifying code that touches it)

**Variables & Functions:**
- CamelCase for public exports and user-visible functions
- camelCase for internal helpers
- SCREAMING_SNAKE_CASE for constants (e.g., `KEY_TOO_COMMON`, `COMMON_WORDS`)
- `is*`, `can*` prefixes for predicates (`isRegexKey`, `isRegexKey`)
- `build*` for factories/initializers (`buildKeySuggest`, `buildKeyPruneScan`)
- Composite keys use Unit Separator (`\x1F`) to join fields: `${uid}\x1F${property}`

**Test Files:**
- Colocated with source where possible (e.g., check logic lives in `ranking.mjs`, tested by `eval/matcher-check.mjs`)
- Fixtures in `eval/fixtures/`; sample data in `eval-data/` (gitignored for `.jsonl`)
- Check output: print `ok` or `FAIL`; no frameworks, no async test runners

## Where to Add New Code

**New Feature (e.g., a new cutoff mode):**
- **Core logic**: `extension/selection.mjs` (define the mode and its tuning constants)
- **Tests**: `eval/selection-check.mjs` (regression test for the mode) + update `eval/graded-scene-grid.mjs` to include the mode
- **Integration**: `worldsapart.js` passes the setting from ST to `selection.mjs` at retrieval time
- **Documentation**: Update `STRUCTURE.md` (this file) and the module header in `selection.mjs`

**New Evaluation Tool (e.g., analyze overfiring):**
- **Core**: Pure logic in `extension/` (if analyzing entry data) or `eval/` (if analyzing results)
- **Harness**: New file in `eval/foo-grid.mjs` or `eval/foo-audit.mjs` with `import { scene } from './scene.mjs'`
- **Data**: Gitignore the output (`.jsonl` results); commit the tool code
- **Documentation**: Add usage line at the top of the file

**New Matcher or Classifier:**
- **Single matcher**: Update `ranking.mjs:countKey()` and re-export from `smartkeys.mjs`
- **Literal matching rule**: Update `plugin/automaton.mjs` (BOTH sides automatically use it)
- **Frequency/POS classification**: Update `extension/zipf-en.js` or `plugin/commonwords.js`
- **Regression test**: Add a case to `eval/matcher-check.mjs` before modifying the matcher

**New UI Widget:**
- **Definition**: `extension/ui-widgets.mjs` if reusable (sort control, tier editor, context menu)
- **Styling**: Stylesheet bundled in `ui-widgets.mjs:ensureStudioStyle()`
- **Integration**: `studio.mjs` calls the widget builder; pass all state through arguments (no global DOM state)

**New ST Hook or Command:**
- **Handler**: Add to `worldsapart.js` (import the logic from `extension/`)
- **Validation**: Inject settings when calling pure modules; never have pure code import from ST
- **Error handling**: Fail open; log, don't crash
- **Documentation**: Add a `/wa-*` command line to SMARTKEYS.md if user-facing

## Special Directories

**`eval-data/` (gitignored, except metadata):**
- Purpose: Test corpus and graded evaluation snapshots
- Generated: Yes; created by `/wa-grade` and `/wa-super-grade` commands, or manually
- Committed: No (`.jsonl` files are gitignored); only metadata (README.md, CORPUS-MAP.md) is committed
- Staleness: Graded scenes can become stale if the chat or lorebook it references is edited; `eval/graded-scene-grid.mjs` detects this

**`.planning/codebase/` (generated by GSD):**
- Purpose: Codebase mapping documents
- Generated: Yes; overwritten by `/gsd-map-codebase`
- Committed: Yes; `/gsd-plan-phase` and `/gsd-execute-phase` load from here
- Staleness: If you add major files or reorganize, run `/gsd-map-codebase arch` to refresh

**`plugin/` after `deploy-plugin.mjs` runs:**
- `plugin/server.js` is generated; it's a bundled copy of isomorphic modules
- Deployed to `/plugins/worlds-apart/server.js` by the plugin system
- If you edit `plugin/*.mjs`, run `node deploy-plugin.mjs` and restart ST
- The plugin fingerprint (`plugin/fingerprint.mjs`) guards against stale deployments

## Import Patterns

**From Pure Core to ST-Coupled (one-way):**
```js
// ✓ OK — extension/ui-widgets.mjs imports ranking.mjs
import { someFunc } from './ranking.mjs';

// ✗ NEVER — extension/ranking.mjs imports studio.mjs
import { studioFunc } from './studio.mjs';  // FORBIDDEN
```

**From Extension to Plugin (one-way):**
```js
// ✓ OK — extension/smartkeys.mjs re-exports plugin/automaton.mjs
export { buildAutomaton, scanAutomaton, fold } from '../plugin/automaton.mjs';

// ✗ NEVER — plugin/automaton.mjs imports from extension/
import { stFunc } from '../extension/smartkeys.mjs';  // FORBIDDEN
```

**Settings & ST Globals (injected, never imported):**
```js
// ✓ OK in pure modules — settings passed by caller
export function buildKeySuggest(data, opts) {
    // opts contains { caseSensitiveDefault, wholeWordsDefault }
    // Never read from extension_settings directly
}

// ✗ NEVER in pure modules
import { extension_settings } from '../../../../extensions.js';  // FORBIDDEN
const flag = extension_settings.worldsApart.myFlag;
```

**Node vs Browser Boundary:**
```js
// eval/graded-scene-grid.mjs can import from extension/ and plugin/
import * as ranking from '../extension/ranking.mjs';
import { centeredCosineScores } from '../plugin/vector.mjs';
// Because these files have no DOM, no `import.meta.url` shenanigans, no ST imports

// eval/bulk-reorder-check.mjs is an exception — it string-slices studio.mjs
// because studio.mjs imports ST and can't be loaded under node
```

---

*Structure analysis: 2026-08-04*
