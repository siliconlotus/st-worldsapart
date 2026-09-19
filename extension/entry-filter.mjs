// entry-filter.mjs — the Studio Explorer's entry filter: free-text search, the facet groups, and the term
// tabs' search ranking. Pure; the Studio owns the state and passes it in.

import { MINOR, MODERATE, SEVERE } from './keyword-audit.mjs';
import { wiTitleOf } from './sort.mjs';

/** Whether `e` matches the free-text query under `scope`; a scope with nothing ticked admits everything. */
export const matchSearch = (e, query, scope) => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return true;
    const fields = [];
    if (scope.title) fields.push(String(wiTitleOf(e)));
    if (scope.entry) fields.push(String(e.content ?? ''));
    if (scope.keywords) fields.push((Array.isArray(e.key) ? e.key : []).join(' '));
    return !fields.length || fields.some(f => f.toLowerCase().includes(q));
};

/** One facet of the type filter. `scan` is buildKeyPruneScan's; without it the audit facets admit nothing. */
export const facetMatch = (e, f, scan) => {
    switch (f) {
        case 'keyword': return !e.constant && !e.vectorized;
        case 'constant': return !!e.constant;
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
export const rankBySearch = (groups, query, scope) => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return groups;
    const rankOf = g => {
        if (scope.title && String(wiTitleOf(g.entry)).toLowerCase().includes(q)) return 0;
        if (scope.keywords && g.rows.some(r => r.term.toLowerCase().includes(q))) return 1;
        if (scope.entry && String(g.entry.content ?? '').toLowerCase().includes(q)) return 2;
        return -1;
    };
    return groups.map(g => ({ g, r: rankOf(g) })).filter(x => x.r >= 0)
        .sort((a, b) => a.r - b.r)   // stable, so the shared sort survives within each band
        .map(x => x.g);
};
