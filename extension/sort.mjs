// sort.mjs — entry-ordering business logic: the field comparators (SORT_FNS), the tiered-grouping
// definitions and tierRank, and the presentation-order vocabulary (labels + aliases). Pure — no DOM,
// only settings() — so the prompt builder's insertion order can depend on it without reaching into a
// UI module. The sort CONTROLS (the widgets that pick a sort) live in ui-widgets.mjs and import this.
import { settings } from './state.mjs';

export const wiTitleOf = e => (e.comment && e.comment.trim()) ? e.comment.trim() : (e.key?.length ? e.key.join(', ') : `UID ${e.uid}`);

// Tier definitions for the explorer's tiered grouping (/wa-studio). `test` is a pure entry predicate; the
// order the user arranges the tiers in IS the precedence order — an entry falls into the first ENABLED
// tier it matches (so a constant+sticky entry lands in Constant when Constant precedes Sticky). The active-
// type tiers guard on !disable so disabled entries sink to the Disabled tier wherever it sits in the list.
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
// Tier rank of an entry under a config: index of the first ENABLED tier it matches (order = precedence);
// entries matching nothing fall to a bucket after them all. Shared by the Studio display and the prompt
// insertion order. (Verified in scratchpad/tier_test.mjs.)
export const tierRank = (e, cfg) => {
    let rank = 0;
    for (const t of cfg) { if (!t.on) continue; if (TIER_DEFS[t.id].test(e)) return rank; rank++; }
    return rank;
};

// --- Shared sort vocabulary --------------------------------------------------------------------------
// Pure entry-field comparators, reused by the Lorebook Studio (display order) AND the prompt builder
// (insertion order). Parity with core's #world_info_sort_order set; each tie-breaks like core (secondary
// = order desc, tertiary = uid asc). Deviations, both improvements: Title uses wiTitleOf so comment-less
// entries still sort by keys/uid; Trigger% treats unset probability as 100 (always-fires) not core's null→0.
const sortPrio = e => e.disable ? 2 : e.constant ? 0 : 1;   // constant → normal → disabled
const sortSec = (a, b) => (Number(b.order) || 0) - (Number(a.order) || 0);
const sortTer = (a, b) => a.uid - b.uid;
const sortWith = primary => (a, b) => primary(a, b) || sortSec(a, b) || sortTer(a, b);
const numAsc = f => (a, b) => (Number(a[f]) || 0) - (Number(b[f]) || 0);
export const SORT_FNS = {
    'priority':   sortWith((a, b) => sortPrio(a) - sortPrio(b)),
    'custom':     sortWith((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0)),
    'title-asc':  sortWith((a, b) => wiTitleOf(a).localeCompare(wiTitleOf(b))),
    'title-desc': sortWith((a, b) => wiTitleOf(b).localeCompare(wiTitleOf(a))),
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
// Combined label (base + tiered prefix) for the renumber dialog's "current sort order" line.
export const presentationLabel = () => (settings().presentationTiered ? 'Tiered · ' : '') + presentationBaseLabel(settings().presentationOrder);
