# Coding Conventions

**Analysis Date:** 2026-08-04

## Module Structure and Purity

**ST-Free Modules (node-importable, used by evals):**
- `extension/ranking.mjs` — keyword matching and query building
- `extension/keyword-core.mjs` — key pruning and suggestion logic
- `extension/selection.mjs` — entry ranking and cutoff logic
- `extension/smartkeys.mjs` — boolean query engine for `?` keys
- `extension/sort.mjs` — entry ordering and comparators
- `plugin/*.mjs` — shared matching engine (automaton.mjs, lexical.mjs, vector.mjs, scoring.mjs, fingerprint.mjs)

All settings and SillyTavern globals are **injected by the caller**, never imported. This separation allows eval harnesses to exercise the real shipped code instead of string-slicing it.

**ST-Coupled Modules:**
- `worldsapart.js` — main extension entry (repo root, not `extension/`)
- `extension/keyword-tools.mjs` — UI layer for keyword analysis (popups, saving)
- `extension/studio.mjs` — Lorebook Studio (/wa-studio) with DOM
- `extension/ui-widgets.mjs` — shared UI controls

These import ST and use globals; they layer on top of ST-free modules without injecting into them.

One exception: `eval/bulk-reorder-check.mjs` string-slices `planUidReindex` out of `studio.mjs` to run under node.

## Naming Patterns

**Functions:**
- camelCase, start with verb: `buildGazetteer()`, `countKey()`, `keywordScore()`, `evaluateSmartKey()`, `scanAutomaton()`
- Follow object-action order: `buildAutomaton()`, `scanAutomaton()`, `cutRetrieved()`

**Variables and Parameters:**
- camelCase: `text`, `foldedText`, `haystack`, `needle`, `threshold`, `threshold`, `entries`
- Short abbreviations OK in tight loops: `f`, `i`, `n`, `k`, `p` (pattern index), `ch` (character), `m` (match)
- Descriptive for module scope: `gazetteer`, `commonwords`, `lexical`, `mean`, `targets`, `trials`

**Constants:**
- UPPERCASE_WITH_UNDERSCORES: `WORD_CHAR`, `REGEX_KEY_RE`, `KEY_TOO_COMMON`, `KEY_SHARED`, `APOSTROPHES`, `COMBINING`, `COMMON_WORDS`
- Export if used across modules: `export const KEY_DUPE_MIN = 0.6;`

**Types and JSDoc:**
- Use `@param {type}` and `@returns {type}` with clear descriptions
- Object parameters document structure: `@param {object} cfg` followed by component fields with type
- Example: `@param {object} cfg` then `@param {string} cfg.mode`, `@param {number} cfg.maxVectorEntries`

**Files:**
- kebab-case: `keyword-core.mjs`, `smartkeys.mjs`, `ui-widgets.mjs`, not `keywordCore.mjs`
- `.mjs` extension for ES modules (even in plugin/), `.js` only for vendored data like `zipf-en.js` and `commonwords.js`
- Test files: `*-check.mjs` (regression tests), `*-grid.mjs` (benchmark tools), `metrics.mjs` (shared test lib)

**Directories:**
- kebab-case: `extension/`, `plugin/`, `eval/`, `eval/fixtures/`, `eval/eval-data/`

## Import Organization

**Order:**
1. Node built-ins: `import { readFileSync } from 'node:fs';`
2. Internal extension modules
3. Plugin modules (shared ST-free code)
4. Named re-exports for public API

**Example from `ranking.mjs`:**
```javascript
import { cachedCount, evaluateSmartKey, fold, normalizeOrthography, primeScan } from './smartkeys.mjs';
```

**Example from `smartkeys.mjs`:**
```javascript
import { escapeRegex, isRegexKey, WORD_CHAR, foldedHay } from './ranking.mjs';
import { buildAutomaton, scanAutomaton, fold, normalizeOrthography, addMessageHits } from '../plugin/automaton.mjs';
export { buildAutomaton, scanAutomaton, fold, normalizeOrthography, addMessageHits };
```

**Path aliases:** No aliases in use. Use relative paths only.

## Error Handling

**SmartKey Queries (never throw):**
- Malformed queries degrade gracefully: unclosed parens, trailing operators, lone operators all pass through
- Lone operator or empty query matches nothing: `matches('? -', 'anything')` → false
- Stray characters (unmatched `"`, `)`): dropped, term continues or skipped
- Invalid weight format `fire::abc` keeps the whole thing as a literal term

**Patterns from code:**
```javascript
// Stray char handling in tokenize():
if (!m) { src = src.slice(1); continue; }  // drop stray, move on

// Absent results are zero, not errors:
const cached = scanAutomaton(aut, text);
if (cached === 0) return 0;

// Flag fallback for unmatched conditions:
if (caseSensitive && !text.match(re)) return 0;  // try non-sensitive
```

**Logging:** Console only. Test files use `console.log()` for output (`ok` or `FAIL`).

**Assertions:** Simple equality checks in tests via `eq()` from `metrics.mjs`:
```javascript
eq(matches('? fire', text), true, 'description');
```

## Comments

**File Headers (required):**
Every module starts with a brief description and design notes:
```javascript
// smartkeys.mjs — boolean query engine for `?`-prefixed World Info keys.
//
// [Purpose and scope]
// [Design decisions and tradeoffs]
// [Coupling notes]
```

See file headers in `extension/*.mjs` and `plugin/*.mjs` for examples.

**Inline Comments:**
- Explain **why**, not what. The code shows the what.
- UPPERCASE SECTION MARKERS for major decision points: `// --- apostrophe normalisation ---`
- Link to CLAUDE.md or design docs when a pattern has a reason: `// See matcher-design.md: the haystack is where distinctions die`

**Measured vs Assertion:**
- Measured claims name their measurement: `"measured: 2 of 3 apostrophe-bearing keys in one book, 2 of 84 in another"`
- Assertions are labeled: `"assertion: this is faster"` or unmarked if uncontroversial
- Large design decisions document their evidence: see comments in `selection.mjs` about elbow vs dropoff cutoff

**JSDoc:**
```javascript
/**
 * Brief description.
 *
 * LONGER EXPLANATION if needed, especially if there are tradeoffs or surprising behavior.
 *
 * @param {type} name Description
 * @param {type} [name] Optional parameter
 * @returns {type} What it returns
 */
```

**Spacing:**
- One blank line between functions
- Two blank lines between major sections (marked with `// ---`)

## Code Style

**Formatting:**
- No linting config committed; style is by convention
- 4 spaces per indent (not tabs)
- Lines are generally <120 characters but readability wins over strict limits
- Semicolons: used

**Operators and spacing:**
```javascript
const result = a + b;  // spaces around binary operators
const y = x > 0 ? yes : no;  // ternaries spaced
if (x) { ... }  // brace style: opening on same line
for (const item of array) { ... }  // prefer `of` over `in`
```

**String formatting:**
- Template literals for multiline or interpolation: `` `text ${var}` ``
- Regular strings for simple concatenation
- Character class pattern for Unicode word boundaries: `[\\p{L}\\p{N}_]` with `u` flag

**Variable Declaration:**
- `const` by default, `let` only when reassigned
- Destructuring for imports and simple object/array unpacking
- Avoid bare `var`

## Composite Keys and Delimiters

**Rule: Use Unit Separator (`\x1F`), never NUL (`\0`):**

From CLAUDE.md: NUL makes git treat files as binary (no `git diff`, no blame, no three-way merge) and truncates in BSD `awk`. Unit Separator has none of those effects and is still a control character.

**Where it's used:**
- Summary cache keys in `summarizeQuery()`: `key = term1 + '\x1F' + term2`
- Row IDs in `studio.mjs` and `keyword-tools.mjs`: joining multiple fields

**Example:**
```javascript
const cacheKey = query + '\x1F' + limit + '\x1F' + options;
```

## The countKey Pattern

**Rule: `countKey()` in `ranking.mjs` is THE ONLY matcher.** Anything reporting on key behavior must call it, not re-derive the rules.

**Why:** The audit, the pruner, and the Studio's keyword colouring all call `countKey()` instead of re-implementing match logic, so they cannot drift from what actually fires at runtime.

**Pattern from code:**
```javascript
// From smartkeys-check.mjs:
import { countKey } from '../extension/ranking.mjs';
const matches = (key, text) => countKey(key, text, false, false) > 0;

// From keyword-core.mjs:
// Anything that reports on how a key will behave calls countKey() rather than re-deriving the rules.
```

## Module Exports

**Named exports only** (no default exports):
```javascript
export function buildGazetteer(entries) { ... }
export const KEY_SHARED = 0.75;
export { buildAutomaton, scanAutomaton } from '../plugin/automaton.mjs';
```

**Barrel files:** `smartkeys.mjs` re-exports automaton.mjs functions so callers need only one import.

## Design Documentation

**Three companion docs record design decisions; update them, don't re-derive:**

1. **`keyword-suggest-design.md`** — what makes a good key, success criteria, which author keys are not evidence
2. **`matcher-design.md`** — SmartKeys grammar, match rules, principles behind activation decisions
3. **`CLAUDE.md`** — eval file types, countKey pattern, composite key delimiters, ST-free module policy

**Writing rule:** Use exact terminology from the docs (seed, expander, renderer, hypernymy, propriolization). A synonym reads as a new concept. Measured claims name their measurement; anything else is labeled assertion.

## Plugin Deployment

**Plugin changes require redeploy:**
- Editing anything in `plugin/` requires `node deploy-plugin.mjs`
- `/plugins/worlds-apart/` is a generated copy; settings panel shows drift banner until fingerprints match
- Changes in `extension/` do NOT need redeploy (browser refresh only)

---

*Convention analysis: 2026-08-04*
