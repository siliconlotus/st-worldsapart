// sort.mjs — entry-ordering business logic: the field comparators (SORT_FNS), the tiered-grouping
// definitions and tierRank, and the presentation-order vocabulary (labels + aliases). Pure — no DOM,
// no imports at all — so the prompt builder's insertion order can depend on it without reaching into a
// UI module, and eval/ can import it under node. The sort CONTROLS (the widgets that pick a sort) live
// in ui-widgets.mjs and import this.

/**
 * An entry's display name: its comment, or `UID n`.
 *
 * Never its keys: a joined key list reads as a title the author wrote when they wrote none, and
 * duplicates the chips sitting underneath it. "UID 12" is honest about there being no name.
 */
export const wiTitleOf = e => (e.comment && e.comment.trim()) ? e.comment.trim() : `UID ${e.uid}`;

/**
 * Presentation order for the two grading tables (/wa-grade, /wa-super-grade): gradeable rows first, then
 * persisting stickies, then constants — and inside each block, best first.
 *
 * Not capture order: the budget walk hoists stickies and constants to the front in authored order, which
 * would head the grading list for a structural reason rather than a relevance one.
 *
 * `rank` is the caller's because the two graders have different orderings available. /wa-grade covers one
 * arm, so its fused `score` is meaningful and sorts descending; a /wa-super-grade union spans arms whose
 * fused scores are not comparable, so it sorts on `bestRank`, the only cross-arm quantity that means the
 * same thing in every row.
 *
 * Returns `{row, i}` pairs carrying the original index, because every `data-i` in those tables indexes
 * back into the capture-ordered rows and entries arrays; sorting the rows alone would misattribute
 * every grade.
 *
 * @param {object[]} rows Candidate rows, in capture order
 * @param {(row: object) => number} rank Within-block ordering, ascending
 * @returns {{row: object, i: number}[]} Rows paired with their capture index, in presentation order
 */
// Promoted rows sit with the dynamic ones: both are this turn's activations and both get graded. The
// two durable blocks trail, being listed rather than graded.
const GRADE_BLOCK_ORDER = { dynamic: 0, promoted: 0, sticky: 1, constant: 2 };
export const gradeOrder = (rows, rank) => (rows ?? [])
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (GRADE_BLOCK_ORDER[a.row.block] ?? 0) - (GRADE_BLOCK_ORDER[b.row.block] ?? 0) || rank(a.row) - rank(b.row));

// Tier definitions for the explorer's tiered grouping (/wa-studio). `test` is a pure entry predicate; the
// order the user arranges the tiers in is the precedence order — an entry falls into the first enabled
// tier it matches. The active-type tiers guard on !disable so disabled entries sink to the Disabled tier
// wherever it sits in the list.
export const TIER_DEFS = {
    constant: { label: 'Constant', test: e => !e.disable && e.constant },
    sticky:   { label: 'Sticky',   test: e => !e.disable && Number(e.sticky) > 0 },
    keyword:  { label: 'Keyword',  test: e => !e.disable && !e.vectorized },
    vector:   { label: 'Vector',   test: e => !e.disable && e.vectorized },
    disabled: { label: 'Disabled Entries', test: e => !!e.disable },
};
const DEFAULT_TIER_ORDER = ['constant', 'sticky', 'keyword', 'vector', 'disabled'];
// Keep a persisted config valid across versions: drop unknown ids, append any missing known tier (enabled).
export const reconcileTiers = cfg => {
    const out = (Array.isArray(cfg) ? cfg : []).filter(t => t && TIER_DEFS[t.id]);
    for (const id of DEFAULT_TIER_ORDER) if (!out.some(t => t.id === id)) out.push({ id, on: true });
    return out;
};
// Tier rank of an entry under a config: index of the first enabled tier it matches (order = precedence);
// entries matching nothing fall to a bucket after them all. Shared by the Studio display and the prompt
// insertion order.
export const tierRank = (e, cfg) => {
    let rank = 0;
    for (const t of cfg) { if (!t.on) continue; if (TIER_DEFS[t.id].test(e)) return rank; rank++; }
    return rank;
};

// --- Shared sort vocabulary --------------------------------------------------------------------------
// Pure entry-field comparators, reused by the Lorebook Studio (display order) and the prompt builder
// (insertion order). Parity with core's #world_info_sort_order set; each tie-breaks like core (secondary
// = order desc, tertiary = uid asc). Two deviations: Title sorts comment-less entries to one end rather
// than scattering them, and Trigger% treats unset probability as 100 rather than core's null→0.
const sortPrio = e => e.disable ? 2 : e.constant ? 0 : 1;   // constant → normal → disabled
const sortSec = (a, b) => (Number(b.order) || 0) - (Number(a.order) || 0);
const sortTer = (a, b) => a.uid - b.uid;
const sortWith = primary => (a, b) => primary(a, b) || sortSec(a, b) || sortTer(a, b);
const numAsc = f => (a, b) => (Number(a[f]) || 0) - (Number(b[f]) || 0);
/**
 * The sort key for a title, which is not the display name: sorting on "UID 12" would file an untitled
 * entry among the U-words, where sorting on the empty comment puts every untitled entry at one end.
 */
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
// Grouped for the sort menu: leaves (Priority/Custom) + submenus of ↑/↓ pairs. Keeps the top level short.
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
// Legacy presentationOrder values → shared sort keys. 'best-first'/'best-last' stay as-is (relevance).
export const PRESENTATION_ALIAS = { 'authored': 'order-asc', 'authored-inverse': 'order-desc' };
export const normPresentation = k => PRESENTATION_ALIAS[k] ?? k ?? 'order-asc';
// Human label for a presentation-order key (base sort only; relevance keys keep their own names).
export const presentationBaseLabel = k => SORT_LABELS[normPresentation(k)] ?? { 'best-first': 'Most relevant first', 'best-last': 'Most relevant last' }[k] ?? k;
// Combined label (base + tiered prefix) for the renumber dialog's "current sort order" line. Takes the
// settings rather than importing them, like everything else here: importing state.mjs would cost the
// whole file its node-importability, and eval/ any coverage of the comparators.
export const presentationLabel = s => (s.presentationTiered ? 'Tiered · ' : '') + presentationBaseLabel(s.presentationOrder);
