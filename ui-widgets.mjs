// ui-widgets.mjs — shared UI machinery used by both the settings panel and the Lorebook Studio:
// the sort vocabulary (field comparators + presentation labels), the tiered-grouping definitions and
// tierRank, the floating context menu, the sort/tier control builders, entry tooltips, and the injected
// stylesheet. DOM-coupled but ST-light: needs only settings() (from state.mjs) and ST's Popup.
import { settings } from './state.mjs';
import { Popup, POPUP_TYPE } from '../../../popup.js';

export const wiTitleOf = e => (e.comment && e.comment.trim()) ? e.comment.trim() : (e.key?.length ? e.key.join(', ') : `UID ${e.uid}`);
export const wiGlyph = e => e.constant ? '🔵' : (e.vectorized ? '🔗' : '🟢');

// Tier definitions for the explorer's tiered grouping (/wa-studio). `test` is a pure entry predicate; the
// order the user arranges the tiers in IS the precedence order — an entry falls into the first ENABLED
// tier it matches (so a constant+sticky entry lands in Constant when Constant precedes Sticky). The active-
// type tiers guard on !disable so disabled entries sink to the Disabled tier wherever it sits in the list.
const TIER_DEFS = {
    constant: { label: 'Constant', test: e => !e.disable && e.constant },
    sticky:   { label: 'Sticky',   test: e => !e.disable && Number(e.sticky) > 0 },
    keyword:  { label: 'Keyword',  test: e => !e.disable && !e.vectorized },
    vector:   { label: 'Vector',   test: e => !e.disable && e.vectorized },
    disabled: { label: 'Disabled', test: e => !!e.disable },
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
const SORT_LABELS = {
    'priority': 'Priority', 'custom': 'Custom', 'title-asc': 'Title A→Z', 'title-desc': 'Title Z→A',
    'tokens-asc': 'Tokens ↑', 'tokens-desc': 'Tokens ↓', 'depth-asc': 'Depth ↑', 'depth-desc': 'Depth ↓',
    'order-asc': 'Order ↑', 'order-desc': 'Order ↓', 'uid-asc': 'UID ↑', 'uid-desc': 'UID ↓',
    'prob-asc': 'Trigger% ↑', 'prob-desc': 'Trigger% ↓',
};
// Grouped for the sort menu: leaves (Priority/Custom) + submenus of ↑/↓ pairs. Keeps the top level short.
const SORT_MENU = [
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

// --- Shared floating context menu (submenus) ---------------------------------------------------------
// Each item is a leaf {label, fn, danger, active} or a parent {label, children:[…]} that flies out on
// hover. `mount` is where panels attach (a modal's <dialog> to stack in its top layer, else document.body).
let ctxPanels = [];   // open panels, root at 0; a submenu at depth d replaces anything deeper
const closeCtx = () => {
    for (const m of ctxPanels) m.remove(); ctxPanels = [];
    document.removeEventListener('mousedown', ctxDown, true);
    document.removeEventListener('keydown', ctxKey, true);
    window.removeEventListener('scroll', closeCtx, true);
};
const ctxDown = ev => { if (!ctxPanels.some(m => m.contains(ev.target))) closeCtx(); };
const ctxKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); closeCtx(); } };
const buildCtxPanel = (items, x, y, depth, mount) => {
    while (ctxPanels.length > depth) ctxPanels.pop().remove();   // drop this level + deeper before reopening
    const menu = document.createElement('div'); menu.className = 'wa-ctx';
    for (const it of items) {
        const row = document.createElement('div'); row.className = 'wa-ctx-item' + (it.danger ? ' wa-ctx-danger' : '') + (it.children ? ' wa-ctx-parent' : '') + (it.active ? ' wa-ctx-active' : '');
        const lbl = document.createElement('span'); lbl.textContent = it.label; row.append(lbl);
        if (it.children) {
            const car = document.createElement('span'); car.className = 'wa-ctx-caret'; car.textContent = '›'; row.append(car);
            const open = () => { const r = row.getBoundingClientRect(); buildCtxPanel(it.children, r.right - 4, r.top - 5, depth + 1, mount); };
            row.addEventListener('mouseenter', open);
            row.addEventListener('click', ev => { ev.stopPropagation(); open(); });   // click also opens (touch / diagonal-miss)
        } else {
            row.addEventListener('mouseenter', () => { while (ctxPanels.length > depth + 1) ctxPanels.pop().remove(); });   // entering a childless row drops any open submenu
            row.addEventListener('click', () => { closeCtx(); it.fn?.(); });
        }
        menu.append(row);
    }
    mount.append(menu);
    ctxPanels[depth] = menu;
    const r = menu.getBoundingClientRect();   // clamp so it never opens off-screen
    menu.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
    return menu;
};
export const showCtxMenu = (items, x, y, mount = document.body) => {
    closeCtx();
    buildCtxPanel(items, x, y, 0, mount);
    document.addEventListener('mousedown', ctxDown, true);
    document.addEventListener('keydown', ctxKey, true);
    window.addEventListener('scroll', closeCtx, true);
};

// Reorder / enable tiers (shared). Draft a copy, commit on Save. onSaved fires after persistence.
// Inline tier-precedence editor: ↑/↓ reorder + enable checkbox, committing live via setCfg/onChange.
// Shared by WA settings (mounted inline) and the Studio's Configure-tiers popup. getCfg returns a fresh
// array each call, so mutating a copy and handing it to setCfg is safe.
export function makeTierEditor(getCfg, setCfg, onChange) {
    const wrap = document.createElement('div');
    const commit = next => { setCfg(next); onChange?.(); render(); };
    const render = () => {
        const cfg = getCfg();
        wrap.innerHTML = '';
        cfg.forEach((t, i) => {
            const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;';
            const mv = (cls, dis, dir) => { const x = document.createElement('i'); x.className = 'fa-solid ' + cls; x.style.cssText = `cursor:${dis ? 'default' : 'pointer'};opacity:${dis ? 0.25 : 0.7};padding:2px 4px;`; if (!dis) x.addEventListener('click', () => { const n = getCfg(); [n[i + dir], n[i]] = [n[i], n[i + dir]]; commit(n); }); return x; };
            const up = mv('fa-chevron-up', i === 0, -1);
            const dn = mv('fa-chevron-down', i === cfg.length - 1, +1);
            const lbl = document.createElement('label'); lbl.className = 'checkbox_label'; lbl.style.flex = '1';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = t.on;
            cb.addEventListener('change', () => { const n = getCfg(); n[i] = { ...n[i], on: cb.checked }; commit(n); });
            const sp = document.createElement('span'); sp.textContent = TIER_DEFS[t.id].label;
            lbl.append(cb, sp); row.append(up, dn, lbl); wrap.append(row);
        });
    };
    render();
    return wrap;
}
// Studio's Configure-tiers…: the same inline editor in a popup (live-commit; Close when done).
async function configureTiersPopup(getCfg, setCfg, onSaved) {
    const wrap = document.createElement('div'); wrap.style.textAlign = 'left';
    const hint = document.createElement('div'); hint.style.cssText = 'opacity:0.7;margin-bottom:8px;font-size:0.9em;';
    hint.textContent = 'Entries fall into the first ticked tier they match, top to bottom. ↑/↓ sets precedence; untick to skip a tier. Shared with the prompt insertion order (WA settings).';
    wrap.append(hint, makeTierEditor(getCfg, setCfg, onSaved));
    await new Popup(wrap, POPUP_TYPE.TEXT, '', { okButton: 'Close' }).show();
}

// Sort-control button, shared by the Studio header and the settings panel. Opens `leadItems` (special
// leaves shown first, e.g. the Studio's "Insert Order") + the tiered toggle + Configure tiers… + base
// sorts + any `extraItems` (e.g. relevance, prompt-only). Callbacks read/write the caller's own state so
// the same widget drives display order and insertion order. `mount` (fn → element) targets a modal
// dialog's top layer when needed; omit for document.body. Lead items encapsulate their own tiered state,
// so the "Tiered · " prefix is suppressed for them.
export function makeSortControl({ getSort, setSort, getTiered, setTiered, getTierCfg, setTierCfg, leadItems = [], extraItems = [], onChange, mount, block = false }) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'menu_button wa-filter';
    btn.title = 'Sort order';
    // block = full-width, select-like (label left, caret right) for settings; else compact icon-wide (toolbar).
    btn.style.cssText = block
        ? 'display:flex;align-items:center;gap:6px;width:100%;justify-content:flex-start;white-space:nowrap;'
        : 'display:inline-flex;align-items:center;gap:5px;width:auto;white-space:nowrap;';
    btn.innerHTML = '<i class="fa-solid fa-arrow-down-wide-short"></i>';
    const lblEl = document.createElement('span'); if (block) lblEl.style.cssText = 'flex:1;text-align:left;'; btn.append(lblEl);
    if (block) { const car = document.createElement('span'); car.textContent = '▾'; car.style.opacity = '0.6'; btn.append(car); }
    const named = [...leadItems, ...extraItems];
    const labelFor = k => SORT_LABELS[k] ?? named.find(e => e.key === k)?.label ?? 'Order ↑';
    const refresh = () => { const k = getSort(); const lead = leadItems.some(e => e.key === k); lblEl.textContent = (!lead && getTiered() ? 'Tiered · ' : '') + labelFor(k); };
    refresh();
    const changed = () => { refresh(); onChange?.(); };
    btn.addEventListener('click', () => {
        const cur = getSort();
        const leaf = ex => ({ label: ex.label, active: cur === ex.key, fn: () => { setSort(ex.key); changed(); } });
        const items = [
            ...leadItems.map(leaf),
            { label: `${getTiered() ? '☑' : '☐'} Tiered grouping`, active: getTiered(), fn: () => { setTiered(!getTiered()); changed(); } },
            { label: 'Configure tiers…', fn: () => configureTiersPopup(getTierCfg, setTierCfg, changed) },
            ...SORT_MENU.map(m => m.key
                ? { label: m.label, active: cur === m.key, fn: () => { setSort(m.key); changed(); } }
                : { label: m.label, active: m.kids.some(([, k]) => k === cur), children: m.kids.map(([l, k]) => ({ label: l, active: cur === k, fn: () => { setSort(k); changed(); } })) }),
            ...extraItems.map(leaf),
        ];
        const r = btn.getBoundingClientRect(); showCtxMenu(items, r.left, r.bottom + 2, mount?.());
    });
    return btn;
}

export function wiTooltip({ item, block }) {
    const e = item.entry;
    const lines = [`[${e.world}] ${wiTitleOf(e)}`, block];
    if (item.fused) lines.push(`fused ${item.fused.toFixed(4)}`);
    if (item.score !== undefined) lines.push(`vector ${item.score.toFixed(3)}${item.vectorRank ? ` (#${item.vectorRank})` : ''}`);
    if (item.textScore) lines.push(`text ${item.textScore.toFixed(2)}${item.textRank ? ` (#${item.textRank})` : ''}`);
    if (item.keywordScore) lines.push(`keys ${item.keywordScore.toFixed(2)}${item.keywordRank ? ` (#${item.keywordRank})` : ''}`);
    if (item.keywordHits?.length) lines.push('hits: ' + item.keywordHits.map(h => `${h.key} ×${h.count}`).join(', '));
    return lines.join('\n');
}

// Same "view entry text" popup the keyword suggester opens.
export function showEntryText(entry) {
    const body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;text-align:left;max-height:65vh;overflow:auto;font-size:0.95em;';
    body.textContent = String(entry.content ?? '') || '(empty)';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'text-align:left;width:100%;';
    wrap.innerHTML = `<b>${escapeHtml(wiTitleOf(entry))}</b>`;
    wrap.append(body);
    const vp = new Popup(wrap, POPUP_TYPE.TEXT, '', { large: true, allowVerticalScrolling: true });
    vp.dlg.style.setProperty('width', 'calc(var(--sheldWidth, 90vw) * 0.5)', 'important');
    vp.dlg.style.setProperty('max-width', 'calc(100dvw - 2em)', 'important');
    vp.show();
}

// One-time stylesheet for Lorebook Studio (hover states can't be inlined).
let studioStyled = false;
export function ensureStudioStyle() {
    if (studioStyled) return;
    studioStyled = true;
    const style = document.createElement('style');
    style.textContent = `
.wa-studio { display: flex; gap: 0; height: 72vh; text-align: left; }
.wa-studio-nav { flex: 0 0 20%; min-width: 170px; max-width: 320px; overflow-y: auto;
    border-right: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); padding-right: 6px; }
/* Explorer = pinned header/drawer (wa-studio-fixed) + a single scrolling entry list (wa-studio-entries),
   so the header and the Tool Settings drawer stay put (MUI persistent top drawer: docked, pushes the
   list down) while only the entries scroll beneath. */
.wa-studio-explorer { flex: 1 1 auto; display: flex; flex-direction: column; overflow: hidden; padding-left: 12px; min-width: 0; }
.wa-studio-fixed { flex: 0 0 auto; }
.wa-studio-entries { flex: 1 1 auto; overflow-y: auto; }
.wa-studio-navhead, .wa-studio-exphead { position: sticky; top: 0; z-index: 1; padding: 2px 0 6px;
    background: var(--SmartThemeBlurTintColor, var(--black70a, rgba(20,20,20,0.95))); }
.wa-book-row { display: flex; align-items: center; gap: 5px; padding: 4px 6px; border-radius: 5px;
    cursor: pointer; white-space: nowrap; overflow: hidden; }
.wa-book-row:hover { background: var(--white20a, rgba(255,255,255,0.08)); }
.wa-book-row.wa-sel { background: var(--white30a, rgba(255,255,255,0.14)); font-weight: bold; }
.wa-book-name { overflow: hidden; text-overflow: ellipsis; }
/* Bulk-select mode: size the nav to its content (capped) so full book titles are readable. */
.wa-studio-nav.wa-nav-wide { flex: 0 0 auto; width: max-content; min-width: 200px; max-width: 55%; overflow: auto; }
.wa-nav-wide .wa-book-row { overflow: visible; }
.wa-nav-wide .wa-book-name { overflow: visible; text-overflow: clip; }
.wa-entry { padding: 5px 4px; border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); }
.wa-entry-head { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.wa-entry-title { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wa-entry-title.wa-off { opacity: 0.45; }
.wa-entry-meta { opacity: 0.45; font-size: 0.85em; white-space: nowrap; flex-shrink: 0; }
.wa-entry-badge { font-size: 0.78em; background: var(--wa-kw-flag-bg, #274d78); color: #fff;
    border-radius: 8px; padding: 1px 7px; white-space: nowrap; flex-shrink: 0; }
.wa-entry-body { margin-top: 2px; }
.wa-text-sec { margin-top: 4px; }
.wa-text-head { display: flex; align-items: baseline; gap: 6px; cursor: pointer; margin-left: 22px; }
.wa-entry-preview { opacity: 0.6; font-size: 0.9em; flex: 1; min-width: 0; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
.wa-full-wrap { position: relative; margin: 4px 0 2px 22px; }
.wa-full-pop { position: absolute; top: 7px; right: 7px; z-index: 1; cursor: pointer; opacity: 0.5;
    padding: 2px 5px; border-radius: 4px; font-size: 0.85em; background: var(--black50a, rgba(0,0,0,0.45)); }
.wa-full-pop:hover { opacity: 1; }
textarea.wa-entry-full { display: block; width: 100%; box-sizing: border-box;
    font-size: 0.92em; line-height: 1.35; max-height: calc(1.35em * 8 + 16px); overflow-y: auto; resize: vertical;
    font-family: inherit; color: inherit; background: var(--black30a, rgba(0,0,0,0.2));
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); border-radius: 5px; padding: 5px 7px; }
textarea.wa-entry-full.wa-tall { max-height: 62vh; }
@keyframes wa-flash { from { background: var(--active, rgba(120,180,120,0.35)); } to { background: transparent; } }
.wa-entry.wa-flash { animation: wa-flash 1.2s ease-out; }
.wa-studio-exphead .menu_button { margin: 0; padding: 4px 12px; font-size: 0.82em; width: 9.5rem;
    white-space: normal; line-height: 1.2; }
.wa-studio-exphead .menu_button i { margin-right: 6px; }
.wa-chevron { width: 14px; text-align: center; opacity: 0.7; transition: transform 0.12s; cursor: pointer; }
.wa-chevron.wa-open { transform: rotate(90deg); }
.wa-entry-tools { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.wa-tool { cursor: pointer; padding: 3px 4px; border-radius: 4px; opacity: 0.55; font-style: normal; }
.wa-tool:hover { opacity: 1; background: var(--white20a, rgba(255,255,255,0.1)); }
.wa-tool.wa-on { opacity: 1; color: #6ea8fe; }
.wa-tool.wa-badge { position: relative; }
.wa-tool.wa-badge::after { content: attr(data-badge); position: absolute; top: -3px; right: -4px;
    font-size: 0.6em; font-style: normal; font-weight: bold; line-height: 1.4; padding: 0 3px;
    border-radius: 8px; background: #16305c; color: #fff; }
.wa-title-edit { font-size: 0.82em; opacity: 0.4; }
.wa-mode { margin: 0; padding: 1px 2px; font-size: 0.95em; background: transparent;
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); border-radius: 4px; cursor: pointer; }
.wa-kw-para { display: flex; flex-wrap: wrap; align-items: flex-start; margin: 6px 0 2px 22px; }
/* Chip outline/fill derive from currentColor (the theme's text colour) so they stay visible on any
   background — a fixed --SmartThemeBorderColor vanished on near-black themes. */
.wa-kw-item { display: inline-flex; flex-direction: column; align-items: center; white-space: nowrap; margin: 0 0.6em 0.5em 0; }
.wa-kw { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px;
    white-space: nowrap; border: 1px solid color-mix(in srgb, currentColor 40%, transparent); border-radius: 11px; }
.wa-kw-dead .wa-kw-text { opacity: 0.8; }
/* Whitelisted (ignored) keys: purple so a deliberately-spared key reads apart from an unflagged one. */
.wa-kw-ignored { border-color: #a879e0 !important; background: color-mix(in srgb, #a879e0 18%, transparent); }
.wa-tray { margin: 2px 0 0; }
.wa-tray-head { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; opacity: 0.8; font-size: 0.9em; padding: 2px 0 6px; }
.wa-tray-head:hover { opacity: 1; }
/* Docked top drawer: full-width block below the header, columns so it stays shallow, divider beneath. */
.wa-tray-panel { display: flex; flex-wrap: wrap; gap: 18px; padding: 8px 10px 10px; margin-bottom: 4px;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));
    background: var(--black30a, rgba(0,0,0,0.15)); }
.wa-tray-col { flex: 1 1 210px; min-width: 190px; }
.wa-tray-sec { font-weight: bold; font-size: 0.8em; opacity: 0.7; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.03em; }
.wa-tray-opt { display: flex; align-items: center; margin: 1px 0; font-size: 0.9em; }
.wa-tray-num { gap: 2px; }
.wa-tray-wl { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4em; font-size: 0.9em; }
.wa-tray-wl-clear { text-align: center; margin-top: 8px; }
.wa-entry-sel { margin: 0 2px 0 0; cursor: pointer; flex-shrink: 0; }
.wa-bulk-on { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 4px 8px; margin-bottom: 2px;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-bulk-count { font-weight: bold; margin-right: 2px; }
.wa-bulk-btn, .wa-bulk-mode { margin: 0; padding: 3px 10px; font-size: 0.82em; }
.wa-bulk-mode { padding: 3px 6px; }
.wa-bulk-danger { color: #e06c6c; }
.wa-bulk-sep { align-self: stretch; width: 1px; background: color-mix(in srgb, currentColor 22%, transparent); margin: 0 3px; }
.wa-book-tools { margin-left: 8px; white-space: nowrap; }
.wa-book-tool { cursor: pointer; opacity: 0.5; padding: 3px 5px; border-radius: 4px; font-size: 0.9em; }
.wa-book-tool:hover { opacity: 1; background: var(--white20a, rgba(255,255,255,0.1)); }
.wa-book-tool-danger:hover { color: #e06c6c; }
.wa-filter { margin: 0; padding: 3px 6px; font-size: 0.82em; }
.wa-undo-bar { display: flex; flex-direction: column; gap: 5px; margin: 4px 0 6px; padding: 6px 8px; border-radius: 5px;
    font-size: 0.85em; background: color-mix(in srgb, #e0a86c 15%, transparent); border: 1px solid color-mix(in srgb, #e0a86c 45%, transparent); }
.wa-undo-top { display: flex; align-items: center; gap: 6px; }
.wa-undo-text { flex: 1; min-width: 0; opacity: 0.8; }
.wa-undo-name { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-undo-btn { margin: 0; width: 100%; padding: 3px 10px; font-size: 0.9em; }
.wa-undo-dismiss { cursor: pointer; opacity: 0.55; padding: 2px 4px; flex-shrink: 0; }
.wa-undo-dismiss:hover { opacity: 1; }
.wa-book-sel { margin: 0 5px 0 0; cursor: pointer; flex-shrink: 0; }
.wa-bookbulk { margin: 4px 0 6px; padding: 6px 8px; border-radius: 5px; font-size: 0.85em;
    background: var(--black30a, rgba(0,0,0,0.2)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-bookbulk-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 5px; }
.wa-bookbulk-actions { display: flex; gap: 5px; }
.wa-bookbulk-actions .menu_button { margin: 0; flex: 1; padding: 3px 8px; font-size: 0.9em; }
.wa-bookbulk-hint { opacity: 0.6; }
.wa-kw-reason { opacity: 0.6; font-size: 0.8em; margin: 1px 0 0 0; }
.wa-kw-text { cursor: text; border-bottom: 1px dotted transparent; }
.wa-kw:hover .wa-kw-text { border-bottom-color: currentColor; }
.wa-kw-del { cursor: pointer; opacity: 0.5; font-size: 0.85em; }
.wa-kw-del:hover { opacity: 1; }
/* Right-click keyword menu. Blur-tint idiom (like ST's own menus) so it reads opaque on any theme;
   lives in the Studio dialog's top layer, so a plain high z-index keeps it above the popup content. */
.wa-ctx { position: fixed; z-index: 9999; min-width: 150px; padding: 4px; border-radius: 6px;
    background: var(--SmartThemeBlurTintColor, rgba(30,30,38,0.96));
    backdrop-filter: blur(calc(var(--SmartThemeBlurStrength, 10) * 1px));
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
    box-shadow: 0 6px 20px rgba(0,0,0,0.45); font-size: 0.9em; }
.wa-ctx-item { display: flex; align-items: center; gap: 14px; padding: 5px 11px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.wa-ctx-item:hover { background: var(--white20a, rgba(255,255,255,0.12)); }
.wa-ctx-danger:hover { color: #e06c6c; }
.wa-ctx-caret { margin-left: auto; opacity: 0.55; font-size: 1.15em; line-height: 1; }
.wa-ctx-active { color: #6ea8fe; font-weight: 600; }
.wa-sugg { display: inline-flex; align-items: center; gap: 3px; margin: 0 0.7em 0.2em 0; white-space: nowrap; cursor: pointer; opacity: 0.9; }
.wa-adv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 28px; margin: 6px 0 2px 22px; padding: 8px 10px; border-radius: 5px;
    background: var(--black30a, rgba(0,0,0,0.15)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-adv-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wa-adv-sec { font-weight: bold; font-size: 0.78em; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2px; }
.wa-adv-row { display: flex; align-items: center; gap: 6px; font-size: 0.9em; margin: 0; }
.wa-adv-row input[type=number] { width: 4.5em; margin: 0 0 0 auto; padding: 2px 5px; }
.wa-adv-warn { display: flex; align-items: center; gap: 5px; margin-top: 5px; padding: 4px 6px; border-radius: 4px; font-size: 0.8em;
    background: color-mix(in srgb, #e0a86c 15%, transparent); border: 1px solid color-mix(in srgb, #e0a86c 45%, transparent); }
.wa-adv-warn i { color: #e0a86c; }`;
    document.head.append(style);
}
