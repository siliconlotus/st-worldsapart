# Testing Patterns

**Analysis Date:** 2026-08-04

## Test Framework

**Assertion Framework:**
- Custom minimal `eq()` function from `eval/metrics.mjs`
- No external test framework (Jest, Vitest, Mocha, etc.)
- Console output only: `console.log()` prints `ok` or `FAIL`

**Run Commands:**
```bash
# Regression test suite (should exit silently)
for f in eval/*-check.mjs; do node "$f"; done

# Single test file
node eval/smartkeys-check.mjs

# Benchmark tool with arguments
node eval/baseline-grid.mjs <index.json> [baseline-text]
OLLAMA_URL=http://localhost:11434 node eval/baseline-grid.mjs <index.json>
```

**Key assertion:**
```javascript
// From eval/metrics.mjs
export const eq = (got, want, label) => 
    console.log(`${got === want ? 'ok  ' : 'FAIL'} ${label}: ${got}${got === want ? '' : ` (want ${want})`}`);

// Usage:
eq(matches('? fire', text), true, 'word "fire" matches');
eq(countKey('cat', 'cat cats', false, false), 3, 'substring count');
```

## Test File Organization

### File Types (from CLAUDE.md)

**Type 1: Regression tests (`*-check.mjs`)**
- Self-checking files, run with no arguments
- Print `ok` or `FAIL` to stdout
- Exit cleanly (zero exit code) on success
- Examples: `smartkeys-check.mjs`, `matcher-check.mjs`, `dupe-check.mjs`, `bindings-check.mjs`
- Full suite: `for f in eval/*-check.mjs; do node "$f"; done` must be silent-clean

**Type 2: Shared test libraries (`scene.mjs`, `metrics.mjs`)**
- Not CLI tools, only imported
- `metrics.mjs` provides `eq()`, ranking metrics (`rankMap`, `hit`, `ndcgAt`, `signTest`), and correlation (Spearman, Jaccard)
- `scene.mjs` loads and scores one graded scene (index, gazetteer, scorers, pool, nDCG); imported by both grid tools

**Type 3: Fixtures (`fixtures/` + `sentinel-check.mjs`)**
- Synthetic book and chat with every audit verdict written down
- `install-sentinel.mjs` SYMLINKS both into `data/default-user/` so they can be opened in the Studio
- Point: integration test via the UI, not just direct function calls
- Three faults shipped behind a green suite because other checks call the classifier directly (one layer below what the UI uses)

**Type 4: Benchmark and analysis tools (`*-grid.mjs`, `*-arms.mjs`, `keyword-audit.mjs`, etc.)**
- Require arguments (vector index, lorebook path, or corpus reference)
- Exit non-zero when run bare (print usage line) — **this is NOT a test failure**
- Examples:
  - `baseline-grid.mjs <index.json> [baseline-text]` — LOO grid over baseline weight
  - `graded-scene-grid.mjs <lorebook.json> <graded-scene.json>` — F1/nDCG over parameter settings
  - `paired-arms.mjs <lorebook.json> <graded-scene.json>` — sign test over scenes for tuning

### Directory Structure

```
eval/
├── *-check.mjs              # Regression tests (20+)
├── *-grid.mjs               # Benchmark grids (baseline, centering, fusion, etc.)
├── paired-arms.mjs          # Paired-scene sign test
├── paired-check.mjs         # Regression for paired-arms logic
├── metrics.mjs              # Shared test library: eq(), ranking metrics, statistics
├── scene.mjs                # Shared test library: load and score one graded scene
├── sentinel-check.mjs       # Symlinked fixture test (integration via UI)
├── install-sentinel.mjs     # Symlink installer for fixtures
├── fixtures/                # Synthetic book and chat
│   ├── FIXTURE_BOOK.json
│   ├── FIXTURE_CHAT.json
│   └── README.md
├── eval-data/               # Standard corpus (gitignored)
│   ├── README.md            # Maps chats, marks unrepresentative ones
│   └── <chat files>
└── *.mjs                    # Other analysis tools
```

## Test Structure

### Pattern: Simple Assertions with Labels

```javascript
// From smartkeys-check.mjs
const matches = (key, text) => countKey(key, text, false, false) > 0;

// Spec acceptance table
eq(matches('moon mission', 'Astronaut on a mission to the moon.'), false, 
   'legacy key: not contiguous, no match');
eq(matches('? moon mission', 'Astronaut on a mission to the moon.'), true, 
   'implicit AND');
eq(matches('? ^=NASA mission', 'NASA completed the mission.'), true, 
   '^= passes on exact-case whole word');
```

### Pattern: Group-Level Setup with Comments

```javascript
// --- apostrophe normalisation ---
// A key typed with ASCII ' never matched prose written with U+2019...
const CURLY = String.fromCharCode(0x2019);
eq(countKey("Cap'n Joe", `the ${CURLY}n is silent at Cap${CURLY}n Joe${CURLY}s`, false, false), 1, 
   'straight key matches curly text');
eq(countKey(`Cap${CURLY}n Joe`, "docked at Cap'n Joe's", false, false), 1, 
   'curly key matches straight text');
```

### Pattern: Inline Test Objects

```javascript
// From matcher-check.mjs
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const e = logic => ({ key: ['cosmonaut'], keysecondary: ['apollo', 'soyuz'], selectiveLogic: logic });
    const T = { none: 'the cosmonaut waited', one: 'the cosmonaut boarded apollo', all: 'cosmonaut apollo soyuz' };
    const on = (logic, t) => keywordScore(e(logic), T[t], undefined, cfg).score > 0;
    
    const table = { 0: [false, true, true], 1: [true, true, false], /* ... */ };
    for (const [logic, want] of Object.entries(table)) {
        ['none', 'one', 'all'].forEach((t, i) =>
            eq(on(Number(logic), t), want[i], `${names[logic]}: ${t} secondary present`));
    }
}
```

### Pattern: Comments Between Test Groups

```javascript
console.log('ok   malformed operator positions degrade to no-ops, not dead keys');
console.log('ok   weight delimiter is ::, single colon is ordinary text');
```

## Mocking and Test Doubles

**No mocking framework.** Instead:

**Test harnesses inject dependencies:**
```javascript
// From matcher-check.mjs: inject config instead of calling settings()
const keywordScore = (e, t, k) => 
    rankKeywordScore(e, t, k, { k1: 2, caseSensitiveDefault: false, wholeWordsDefault: false });

// From elbow-check.mjs: inject cutoff options
const result = cutRetrieved(ranked, { 
    mode: 'elbow', 
    maxVectorEntries: 20, 
    minVectorEntries: 1, 
    elbowSensitivity: 1.5 
});
```

**ST-free modules are tested directly:**
Because `ranking.mjs`, `smartkeys.mjs`, `keyword-core.mjs`, etc. take no ST imports, test harnesses can `import { ... } from '../extension/...'` and exercise the real shipped code instead of mocking it.

**Fixtures for integration tests:**
- `sentinel-check.mjs` and the synthetic book/chat let the Studio open and display them
- The checker verifies that every audit verdict is what's written down
- This catches faults that direct classifier calls would miss (one layer up from the function)

**No mocks needed for:**
- Lexical matchers: tested with known strings in the test file
- Scoring functions: tested with known numeric results
- Automaton: tested with known pattern hits

## Test Data

### Graded Scenes

- Located in `eval/eval-data/` (gitignored, one person's chats)
- Scene files contain index of entries, gazetteer, human relevance grades (0-3), and nDCG targets
- Each scene has a **pool**: the union of all entries surfaced across multiple ranked retrieval arms
- Pool methodology: `/wa-super-grade` captures several population-changing arms, unions what they surfaced, grades the union once

### Standard Chat Corpus

- Listed in `eval/eval-data/README.md`
- Spans memory vs reference books and genre vocabulary vs unmarked prose
- Chats are marked as representative or not
- Measurement rule: count **usable** messages (drop `is_system`), not raw lines

### Fixtures (Synthetic)

```javascript
// fixtures/FIXTURE_BOOK.json and fixtures/FIXTURE_CHAT.json
// Example from dupe-check.mjs:
const mk = es => ({ 
    entries: Object.fromEntries(
        es.map((e, i) => [String(i), { uid: i, comment: '', content: '', key: [], ...e }])
    ) 
});

let scan = buildKeyPruneScan(mk([
    { comment: '180 - Integration Breakfast', content: body(60, 'a') },
    { comment: '181 - Autopilot', content: body(60, 'a') },
    { comment: '999 - Unrelated', content: body(0, 'c') },
]), OPTS, new Set());
```

## Coverage and Regression

### Regression Suite

Files matching `*-check.mjs` form the regression suite:
```bash
for f in eval/*-check.mjs; do node "$f"; done
```

All must exit cleanly and print only `ok` lines (or grouped success messages). Any `FAIL` or error output indicates a regression.

**Files in suite:**
- `smartkeys-check.mjs` — SmartKeys boolean query engine
- `matcher-check.mjs` — countKey() matching logic vs core
- `dupe-check.mjs` — near-duplicate detection
- `bindings-check.mjs` — chat/character binding validity
- `keyword-common-check.mjs` — common word flag logic
- `pooling-check.mjs` — scene pooling math
- `paired-check.mjs` — paired-arms sign test logic
- `reindex-check.mjs` — UID reindexing
- `priority-check.mjs` — entry priority logic
- `grading-check.mjs` — graded scene loading
- `chunking-check.mjs` — text chunking
- `genre-check.mjs` — genre vocabulary matching
- `budget-check.mjs` — message budget calculation
- `matchwindow-check.mjs` — message window matching
- `synthesis-check.mjs` — synthetic data generation
- `keyword-extract-check.mjs` — keyword extraction
- `elbow-check.mjs` — elbow cutoff logic
- `bm25-commonword-check.mjs` — BM25 with common word handling
- `wa-priority-check.mjs` — WA-specific entry priority
- `sentinel-check.mjs` — fixture verification (integration)

### What NOT to Test

Benchmark grids and analysis tools exit non-zero when run without arguments — this is normal, not a failure. They are not part of the regression suite:
- `baseline-grid.mjs` — requires vector index
- `bm25-grid.mjs` — requires index
- `centering-grid.mjs` — requires index
- `fusion-grid.mjs` — requires index and corpus
- `graded-scene-grid.mjs` — requires lorebook and scene
- `keyword-audit.mjs` — requires lorebook
- `relevance-eval.mjs` — requires data
- `summary-center.mjs` — requires data

## Common Test Patterns

### Exact Equality

```javascript
eq(result, expected, 'label');
eq(result, expected, 'label with context: ' + context);
```

### Boolean Matching

```javascript
const matches = (key, text) => countKey(key, text, caseSensitive, wholeWord) > 0;
eq(matches(key, text), true, 'should match');
eq(matches(key, text), false, 'should not match');
```

### Numeric Scoring

```javascript
eq(countKey('cat', 'cat cats scatter', false, false), 3, 'substring counts three');
eq(countKey('? fire::2.5', 'fire fire', false, false), 5, '2.5 weight on two hits');
```

### Array/Set Comparisons

```javascript
eq([...hits.keys()].sort().join(','), '0,1,3', 'aho-corasick finds three hits');
eq(scanAutomaton(aut, 'hi shore').size, 0, 'no false hits');
```

### Paired-Scene Testing

```javascript
// From metrics.mjs: signTest() for small n
const deltas = scenes.map(scene => armResult[scene] - baselineResult[scene]);
const result = signTest(deltas);
// Returns: { plus, minus, ties, n, p, mean, consistent }
```

**Pattern:** Sign test instead of absolute scores, because n is single-digit and absolute nDCG varies far more between scenes than between settings. Pairing each scene against its own baseline cancels scene variance.

### Correlation Checks

```javascript
// From metrics.mjs: spearman() for rank correlation
const correlation = spearman(scoresList, ranksList);
eq(correlation > 0, true, 'correlation is positive');
```

### Set Overlap

```javascript
// From metrics.mjs: jaccard() for set similarity
const overlap = jaccard(set1, set2);
eq(overlap > 0.8, true, 'sets overlap significantly');
```

## Error Handling in Tests

**No try/catch.** Tests that should not throw:
```javascript
// From smartkeys-check.mjs
eq(matches('(moon', 'moon landing'), true, 'unclosed paren tolerated');
eq(matches('?', 'anything'), false, 'empty query matches nothing');
eq(matches('? -', 'anything'), false, 'lone operator matches nothing');
```

**Malformed input handling:** SmartKeys parse and evaluate never throw; they degrade gracefully (unclosed parens kept, stray operators absorbed, lone operator skipped).

## Measurement Discipline

### Measured vs Assertion

Every tuning claim states whether it's measured or an assumption:

```javascript
// From selection.mjs:
/**
 * MEASURED, 3 graded scenes (eval/graded-scene-grid.mjs, F1 over grade>=3 as a % of the best possible
 * prefix cut of the same ranking — "%oracle"). ...
 */
```

### Stopping Rules for Grading

- `judged@10` in `graded-scene-grid.mjs` is the stopping rule for new scenes
- Add arms until cells you care about stop showing gaps
- Cannot always reach 10/10 if offline re-derivation ranks rows the deployed system rejects

### Limiting Factors

- **Single-digit n:** Argmax over a grid is unavailable. Use `paired-arms.mjs` (sign test) instead.
- **Scene variance:** Absolute nDCG is not comparable across scenes. Use paired deltas and sign test.
- **Pool effects:** A pool built from one configuration penalizes every configuration far from it. Use `/wa-super-grade` to union arms and avoid bias.

---

*Testing analysis: 2026-08-04*
