// sort.mjs — entry ordering: the field comparators (SORT_FNS), tiered grouping (TIER_DEFS, tierRank) and the
// presentation-order vocabulary. Pure, no imports; the sort controls live in ui-widgets.mjs.

export const wiTitleOf = e => (e.comment && e.comment.trim()) ? e.comment.trim() : `UID ${e.uid}`;

/** Presentation order for the grading tables, promoted grading with the dynamic block and the durable blocks trailing; `{row, i}` pairs, since every `data-i` indexes the capture-ordered arrays. `rank` orders within block, ascending. */
const GRADE_BLOCK_ORDER = { dynamic: 0, promoted: 0, sticky: 1, constant: 2 };
export const gradeOrder = (rows, rank) => (rows ?? [])
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (GRADE_BLOCK_ORDER[a.row.block] ?? 0) - (GRADE_BLOCK_ORDER[b.row.block] ?? 0) || rank(a.row) - rank(b.row));

/** Tier definitions for the explorer's tiered grouping; the config's order is precedence, first enabled match wins. */
export const TIER_DEFS = {
    constant: { label: 'Constant', test: e => !e.disable && e.constant },
    sticky:   { label: 'Sticky',   test: e => !e.disable && Number(e.sticky) > 0 },
    keyword:  { label: 'Keyword',  test: e => !e.disable && !e.vectorized },
    vector:   { label: 'Vector',   test: e => !e.disable && e.vectorized },
    disabled: { label: 'Disabled Entries', test: e => !!e.disable },
};
const DEFAULT_TIER_ORDER = ['constant', 'sticky', 'keyword', 'vector', 'disabled'];
export const reconcileTiers = cfg => {
    const out = (Array.isArray(cfg) ? cfg : []).filter(t => t && TIER_DEFS[t.id]);
    for (const id of DEFAULT_TIER_ORDER) if (!out.some(t => t.id === id)) out.push({ id, on: true });
    return out;
};
export const tierRank = (e, cfg) => {
    let rank = 0;
    for (const t of cfg) { if (!t.on) continue; if (TIER_DEFS[t.id].test(e)) return rank; rank++; }
    return rank;
};

/** Entry-field comparators, parity with core's #world_info_sort_order and its tie-breaks (order desc, uid asc). Two deviations:
 *  Title files comment-less entries to one end, and Trigger% treats unset probability as 100, not core's null→0. */
const sortPrio = e => e.disable ? 2 : e.constant ? 0 : 1;   // constant → normal → disabled
const sortSec = (a, b) => (Number(b.order) || 0) - (Number(a.order) || 0);
const sortTer = (a, b) => a.uid - b.uid;
const sortWith = primary => (a, b) => primary(a, b) || sortSec(a, b) || sortTer(a, b);
const numAsc = f => (a, b) => (Number(a[f]) || 0) - (Number(b[f]) || 0);
/** The comment, not wiTitleOf: "UID 12" would file among the U-words. */
const titleKey = e => (e.comment ?? '').trim();

export const SORT_FNS = {
    'priority':   sortWith((a, b) => sortPrio(a) - sortPrio(b)),
    'custom':     sortWith((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0)),
    'title-asc':  sortWith((a, b) => titleKey(a).localeCompare(titleKey(b))),
    'title-desc': sortWith((a, b) => titleKey(b).localeCompare(titleKey(a))),
    'tokens-asc': sortWith((a, b) => String(a.content ?? '').length - String(b.content ?? '').length),
    'tokens-desc':sortWith((a, b) => String(b.content ?? '').length - String(a.content ?? '').length),
    'depth-asc':  sortWith(numAsc('depth')),
    'depth-desc': sortWith((a, b) => (Number(b.depth) || 0) - (Number(a.depth) || 0)),
    'order-asc':  sortWith(numAsc('order')),
    'order-desc': sortWith((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0)),
    'uid-asc':    sortWith((a, b) => a.uid - b.uid),
    'uid-desc':   sortWith((a, b) => b.uid - a.uid),
    'prob-asc':   sortWith((a, b) => (a.probability ?? 100) - (b.probability ?? 100)),
    'prob-desc':  sortWith((a, b) => (b.probability ?? 100) - (a.probability ?? 100)),
};
export const SORT_LABELS = {
    'priority': 'Priority', 'custom': 'Custom', 'title-asc': 'Title A→Z', 'title-desc': 'Title Z→A',
    'tokens-asc': 'Tokens ↑', 'tokens-desc': 'Tokens ↓', 'depth-asc': 'Depth ↑', 'depth-desc': 'Depth ↓',
    'order-asc': 'Order ↑', 'order-desc': 'Order ↓', 'uid-asc': 'UID ↑', 'uid-desc': 'UID ↓',
    'prob-asc': 'Trigger% ↑', 'prob-desc': 'Trigger% ↓',
};
export const SORT_MENU = [
    { label: 'Priority', key: 'priority' },
    { label: 'Custom', key: 'custom' },
    { label: 'Title', kids: [['A → Z', 'title-asc'], ['Z → A', 'title-desc']] },
    { label: 'Tokens', kids: [['Short → long', 'tokens-asc'], ['Long → short', 'tokens-desc']] },
    { label: 'Depth', kids: [['Low → high', 'depth-asc'], ['High → low', 'depth-desc']] },
    { label: 'Order', kids: [['Ascending', 'order-asc'], ['Descending', 'order-desc']] },
    { label: 'UID', kids: [['Ascending', 'uid-asc'], ['Descending', 'uid-desc']] },
    { label: 'Trigger %', kids: [['Low → high', 'prob-asc'], ['High → low', 'prob-desc']] },
];
/** Legacy presentationOrder values → sort keys; 'best-first'/'best-last' are relevance keys, not aliases. */
export const PRESENTATION_ALIAS = { 'authored': 'order-asc', 'authored-inverse': 'order-desc' };
export const normPresentation = k => PRESENTATION_ALIAS[k] ?? k ?? 'order-asc';
export const presentationBaseLabel = k => SORT_LABELS[normPresentation(k)] ?? { 'best-first': 'Most relevant first', 'best-last': 'Most relevant last' }[k] ?? k;
export const presentationLabel = s => (s.presentationTiered ? 'Tiered · ' : '') + presentationBaseLabel(s.presentationOrder);
