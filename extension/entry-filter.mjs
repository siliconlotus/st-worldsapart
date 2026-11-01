// entry-filter.mjs — the Studio Explorer's entry filter: free-text search, the facet groups, and the term
// tabs' search ranking. Pure; the Studio owns the state and passes it in.

import { MINOR, MODERATE, SEVERE } from './keyword-audit.mjs';
import { wiTitleOf } from './sort.mjs';
import { isConstant } from './layout.mjs';
import { buildAst, evaluate } from './smartkeys.mjs';
import { keySpans } from './matcher.mjs';

/** The query as a SmartKey, `?` optional; null when it parses to nothing yet (`-`, `(`), which admits everything. */
const queryAst = (query, scanScope) => {
    try { return buildAst(String(query ?? '').trim(), scanScope); } catch { return null; }
};
const hits = (ast, text) => evaluate(ast, String(text ?? '')).matched;

/** Whether some ticked field of `e` satisfies the whole query on its own; a scope with nothing ticked admits everything.
 *  `scanScope` is createScanScope's: the macros and word boundary the query's terms read. */
export const matchSearch = (e, query, scope, scanScope) => {
    const ast = queryAst(query, scanScope);
    if (!ast) return true;
    const fields = [];
    if (scope.title) fields.push(wiTitleOf(e));
    if (scope.entry) fields.push(e.content);
    if (scope.keywords) fields.push((Array.isArray(e.key) ? e.key : []).join('\n'));
    return !fields.length || fields.some(f => hits(ast, f));
};

/** Where the query lands in `text`, as keySpans' `{ start, end, negated }`, when `field` (default `text`) satisfies the whole
 *  query; none when it does not, so a field the search did not admit is never marked. */
export const searchSpans = (text, query, scanScope, field = text) => {
    const ast = queryAst(query, scanScope);
    if (!ast || !hits(ast, field)) return [];
    return keySpans([`?${String(query).trim().replace(/^\?/, '')}`], String(text ?? ''), false, false, { scope: scanScope });
};

/** One facet of the type filter. `scan` is buildKeyPruneScan's; without it the audit facets admit nothing. */
export const facetMatch = (e, f, scan) => {
    switch (f) {
        case 'keyword': return !isConstant(e) && !e.vectorized;
        case 'constant': return isConstant(e);
        case 'vector': return !!e.vectorized;
        case 'enabled': return !e.disable;
        case 'disabled': return !!e.disable;
        case 'flagged': return !!scan && (scan.classifyEntry(e).length > 0 || scan.unusableKeysOf(e).length > 0);
        // Severity is per key, so this is "holds at least one" — the same reading as `flagged` — over both lists: a refused
        // secondary counts severe here as it does on the badge, and a dead one is neutral, as a dead primary is.
        case SEVERE: case MODERATE: case MINOR:
            return !!scan && [...scan.classifyEntry(e), ...scan.unusableKeysOf(e)].some(p => scan.severityOf(p) === f);
        default: return true;
    }
};

export const FILTER_GROUPS = [['keyword', 'constant', 'vector'], ['enabled', 'disabled'], ['flagged', SEVERE, MODERATE, MINOR]];

/** Any facet of a group admits (OR); every group with a facet picked must admit (AND). `facets` is a Set. */
export const typeMatch = (e, facets, scan) => FILTER_GROUPS.every(g => {
    const sel = g.filter(f => facets.has(f));
    return !sel.length || sel.some(f => facetMatch(e, f, scan));
});

/**
 * Term-tab search: keeps a group whose title, listed terms or (if scoped) text match, ranked title > term > text;
 * rows are never filtered.
 * @param {Array<{entry: object, rows: Array<{term: string}>}>} groups
 */
export const rankBySearch = (groups, query, scope, scanScope) => {
    const ast = queryAst(query, scanScope);
    if (!ast) return groups;
    const rankOf = g => {
        if (scope.title && hits(ast, wiTitleOf(g.entry))) return 0;
        if (scope.keywords && hits(ast, g.rows.map(r => r.term).join('\n'))) return 1;
        if (scope.entry && hits(ast, g.entry.content)) return 2;
        return -1;
    };
    return groups.map(g => ({ g, r: rankOf(g) })).filter(x => x.r >= 0)
        .sort((a, b) => a.r - b.r)   // stable, so the shared sort survives within each band
        .map(x => x.g);
};
