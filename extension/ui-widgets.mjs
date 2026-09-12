// ui-widgets.mjs — DOM controls shared by the settings panel and the Lorebook Studio: sort/tier controls, the
// floating context menu, entry tooltip and fold, and the injected stylesheet.
import { escapeHtml } from '../../../../utils.js';
import { markExcerptText } from './matcher.mjs';
import { DOMPurify } from '../../../../../lib.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { wiTitleOf, TIER_DEFS, SORT_LABELS, SORT_MENU } from './sort.mjs';

export const wiGlyph = e => e.constant ? '🔵' : (e.vectorized ? '🔗' : '🟢');


// Floating context menu: items are leaves {label, fn, danger, active} or parents {label, children}; `mount` is a modal's <dialog> (its top layer) or document.body.
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
    while (ctxPanels.length > depth) ctxPanels.pop().remove();
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
            row.addEventListener('mouseenter', () => { while (ctxPanels.length > depth + 1) ctxPanels.pop().remove(); });
            // Without stopPropagation the click bubbles to ST's autoclose handler and collapses the Extensions drawer.
            row.addEventListener('click', ev => { ev.stopPropagation(); closeCtx(); it.fn?.(); });
        }
        menu.append(row);
    }
    mount.append(menu);
    ctxPanels[depth] = menu;
    const r = menu.getBoundingClientRect();
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

/** Tier-precedence editor (↑/↓ and an enable checkbox), committing live through setCfg/onChange. `getCfg` must
 * return a fresh array each call: the editor mutates it before handing it to setCfg. */
/** `omit` hides tiers that mean nothing where the editor is shown (the panel hides `disabled`: no disabled entry reaches the prompt); moves skip over hidden rows, the config keeps them. */
export function makeTierEditor(getCfg, setCfg, onChange, { omit = [] } = {}) {
    const wrap = document.createElement('div');
    const commit = next => { setCfg(next); onChange?.(); render(); };
    const render = () => {
        const cfg = getCfg();
        wrap.innerHTML = '';
        const vis = cfg.map((t, i) => ({ t, i })).filter(x => !omit.includes(x.t.id));
        vis.forEach(({ t, i }, k) => {
            const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;';
            const mv = (cls, dis, dir) => { const x = document.createElement('i'); x.className = 'fa-solid ' + cls; x.style.cssText = `cursor:${dis ? 'default' : 'pointer'};opacity:${dis ? 0.25 : 0.7};padding:2px 4px;`; if (!dis) x.addEventListener('click', () => { const n = getCfg(); const j = vis[k + dir].i; [n[j], n[i]] = [n[i], n[j]]; commit(n); }); return x; };
            const up = mv('fa-chevron-up', k === 0, -1);
            const dn = mv('fa-chevron-down', k === vis.length - 1, +1);
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
async function configureTiersPopup(getCfg, setCfg, onSaved) {
    const wrap = document.createElement('div'); wrap.style.textAlign = 'left';
    const hint = document.createElement('div'); hint.style.cssText = 'opacity:0.7;margin-bottom:8px;font-size:0.9em;';
    hint.textContent = 'An entry joins the first ticked tier it matches, top to bottom. Untick a tier to skip it. Shared with the settings panel.';
    wrap.append(hint, makeTierEditor(getCfg, setCfg, onSaved));
    await new Popup(wrap, POPUP_TYPE.TEXT, '', { okButton: 'Close' }).show();
}

/** Sort-control button shared by the Studio header and the settings panel; the menu is `leadItems`, the tiered
 * toggle, Configure tiers…, the base sorts, then `extraItems`. `mount` is a fn returning the element the menu attaches to. */
export function makeSortControl({ getSort, setSort, getTiered, setTiered, getTierCfg, setTierCfg, leadItems = [], extraItems = [], onChange, mount, block = false }) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'menu_button wa-filter';
    btn.title = 'Sort order';
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
    if (Number.isFinite(item.eCredit)) lines.push(`E[credit] ${item.eCredit.toFixed(4)}`);
    if (item.score !== undefined) lines.push(`vector ${item.score.toFixed(3)}`);
    if (item.textScore) lines.push(`text ${item.textScore.toFixed(2)}`);
    if (item.keywordScore) lines.push(`keys ${item.keywordScore.toFixed(2)}`);
    if (item.keywordHits?.length) lines.push('hits: ' + item.keywordHits.map(h => `${h.key} ×${h.count}`).join(', '));
    return lines.join('\n');
}

// Marks the span by keyExcerpts' offsets; nothing is parsed back out of the text, which can hold guillemets of its own.
const markExcerpt = ex => (ex && typeof ex === 'object'
    ? escapeHtml(ex.text.slice(0, ex.start))
        + `<span style="color:var(--SmartThemeQuoteColor, #6ea8fe);font-weight:600;opacity:1;">${escapeHtml(ex.text.slice(ex.start, ex.end))}</span>`
        + escapeHtml(ex.text.slice(ex.end))
    : escapeHtml(String(ex ?? '')));

/** The key-hit lines under a grading row's title: key, count, and the excerpt with the matched span coloured. */
export const keyHitsHtml = why => (why ?? []).map(w => {
    // A title attribute is plain text, so the tooltip marks spans with markExcerptText's guillemets, not colour.
    const all = (w.contexts ?? []).filter(Boolean);
    const tip = all.length > 1
        ? ` title="${escapeHtml(all.map(markExcerptText).join('\n'))}"`
        : '';
    // With `color`, the key is drawn as a wa-kw chip; a leading `\u21b3` stays outside it.
    const label = w.color
        ? `${w.key.startsWith('\u21b3') ? '\u21b3 ' : ''}<span class="wa-kw" style="border-color:${escapeHtml(w.color)};`
            + `background:color-mix(in srgb, ${escapeHtml(w.color)} 18%, transparent);">${escapeHtml(w.key.replace(/^\u21b3 ?/, ''))}</span>`
        : `<span style="color:var(--SmartThemeQuoteColor, #6ea8fe);font-weight:600;">${escapeHtml(w.key)}</span>`;
    return `<br><small style="opacity:0.75;text-align:left;">${label}`
        + `${Number.isFinite(w.count) ? ` <span style="color:var(--SmartThemeEmColor, #d9a441);font-weight:600;">${w.count}</span>` : ''}`
        + `${w.excerpt ? ` <span style="opacity:0.6;cursor:${all.length > 1 ? 'help' : 'default'};"${tip}>${markExcerpt(w.excerpt)}</span>` : ''}</small>`;
}).join('');

/** The fold under a grading row, as HTML: the entry's keys, then its text. Reads `waKeys`/`waSecondary` when `key`
 * is empty — the takeover stashes a vectorized entry's keys there. `idx` becomes `data-i` for the caller's popout. */
export function entryFoldHtml(entry, idx) {
    const live = list => (list ?? []).filter(k => String(k).trim());
    const keys = live(entry?.key?.length ? entry.key : entry?.waKeys);
    const sec = live(entry?.keysecondary?.length ? entry.keysecondary : entry?.waSecondary);
    const chip = k => `<code style="background:var(--black30a,rgba(0,0,0,0.25));padding:1px 5px;border-radius:3px;margin:0 3px 3px 0;display:inline-block;font-size:0.85em;">${escapeHtml(k)}</code>`;
    const line = (label, list) => (list.length
        ? `<div style="margin-bottom:0.35em;"><small style="opacity:0.55;">${label}</small><br>${list.map(chip).join('')}</div>`
        : '');
    const pop = `<i class="wa-fold-pop fa-solid fa-expand" data-i="${idx}" title="Open in a larger window" style="cursor:pointer;opacity:0.6;float:right;padding:2px 4px;"></i>`;
    return `<div style="text-align:left;">${pop}`
        + line('keys', keys)
        + line('secondary', sec)
        + (keys.length || sec.length ? '' : '<div style="opacity:0.5;margin-bottom:0.35em;"><small>no keys</small></div>')
        + `<div style="white-space:pre-wrap;max-height:22em;overflow:auto;opacity:0.9;border-left:2px solid var(--SmartThemeBorderColor);padding-left:0.6em;">${escapeHtml(String(entry?.content ?? '') || '(empty)')}</div></div>`;
}

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

/** A tag, an HTML comment or a character entity. A range like the markdown ones, so one a span overlaps can be shown as
 *  text instead of rendered: matching reads `&nbsp;` as six characters, and a mark on them needs somewhere to land. */
const HTML_RANGE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,30});/g;

/** Open and close HTML per range tag. Sorted by this order, so a block tag wraps the inline tags inside it. */
const TAG_HTML = {
    h: ['<strong style="font-size:1.15em;">', '</strong>'],
    quote: ['<span style="border-left:2px solid currentColor;padding-left:7px;opacity:0.85;">', '</span>'],
    pre: ['<code style="white-space:pre-wrap;">', '</code>'],
    q: ['<q>', '</q>'],
    strong: ['<strong>', '</strong>'],
    s: ['<s>', '</s>'],
    em: ['<em>', '</em>'],
    code: ['<code>', '</code>'],
};
const TAG_ORDER = Object.keys(TAG_HTML);
const BLOCK_TAGS = new Set(['h', 'quote', 'pre', 'delim', 'html']);

/** `[regex, tag, m => [from, to]]`: the match is the range, `from`/`to` bound its content, the rest being delimiter.
 *  No list markers: they stay visible. */
const BLOCK_MARKUP = [
    [/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, 'pre', m => [m[0].indexOf('\n') + 1, m[0].length - 3]],
    [/^#{1,6}[ \t]+[^\n]*$/gm, 'h', m => [/^#{1,6}[ \t]+/.exec(m[0])[0].length, m[0].length]],
    [/^[ \t]*>[ \t]?[^\n]*$/gm, 'quote', m => [/^[ \t]*>[ \t]?/.exec(m[0])[0].length, m[0].length]],
];

/** `[regex, tag, d]`, longest delimiter first so `**` is not read as `*`; `d` is the delimiter length at each end. */
const INLINE_MARKUP = [
    [/(?<![\w*])\*\*(?!\s)[^\n]+?(?<!\s)\*\*(?![\w*])/g, 'strong', 2],
    [/(?<![\w~])~~(?!\s)[^\n]+?(?<!\s)~~(?![\w~])/g, 's', 2],
    [/(?<![\w*])\*(?!\s)[^*\n]+?(?<!\s)\*(?![\w*])/g, 'em', 1],
    [/(?<![\w_])_(?!\s)[^_\n]+?(?<!\s)_(?![\w_])/g, 'em', 1],
    [/`[^`\n]+`/g, 'code', 1],
];

/** Every markup range in `src` as offsets: quotes, HTML, block and inline markdown, plus a `delim` range over each
 *  delimiter. Delimiters are ranges rather than removed text, so offsets keep indexing the matched string. */
const proseRanges = src => {
    const out = [];
    for (const m of src.matchAll(/"[^"\n]*"|\u201C[^\u201D\n]*\u201D|\u00AB[^\u00BB\n]*\u00BB/g)) {
        out.push({ start: m.index, end: m.index + m[0].length, tag: 'q' });
    }
    for (const m of src.matchAll(HTML_RANGE)) out.push({ start: m.index, end: m.index + m[0].length, tag: 'html' });
    for (const [re, tag, body] of BLOCK_MARKUP) {
        for (const m of src.matchAll(re)) {
            const [start, end] = [m.index, m.index + m[0].length];
            if (out.some(r => start < r.end && r.start < end)) continue;
            const [from, to] = body(m);
            out.push({ start, end, tag });
            if (from > 0) out.push({ start, end: start + from, tag: 'delim' });
            if (to < m[0].length) out.push({ start: start + to, end, tag: 'delim' });
        }
    }
    // Longest delimiter first, so `**bold**` is not read as emphasis of `*bold*`.
    for (const [re, tag, d] of INLINE_MARKUP) {
        for (const m of src.matchAll(re)) {
            const [start, end] = [m.index, m.index + m[0].length];
            // A block range and a quote may contain an inline one; two inline ranges may not overlap.
            if (out.some(r => r.tag !== 'q' && !BLOCK_TAGS.has(r.tag) && start < r.end && r.start < end)) continue;
            out.push({ start, end, tag }, { start, end: start + d, tag: 'delim' }, { start: end - d, end, tag: 'delim' });
        }
    }
    return out;
};

/** `text` as HTML, rendering quotes, markdown and the HTML in it, with `spans` marked. A delimiter or a tag that no span
 *  overlaps is hidden or rendered; one a span overlaps is shown as text, so the mark has characters to cover. `markSpan(span,
 *  text)` returns the HTML for one mark. `spans` carry `start`/`end` into the NFC form of `text`. `showMarkup` shows every
 *  tag, entity and delimiter. Output is DOMPurify-sanitised; the container needs class `wa-marked` for the tag colours. */
export function renderMessageHtml(text, { spans = [], markSpan = null, showMarkup = false } = {}) {
    const src = String(text).normalize('NFC');
    // The blank lines around a thematic break are consumed with it: the container is pre-wrap, so they would render as
    // blank lines on top of the rule's margins.
    const escapedWithRules = t => escapeHtml(t).replace(/(?:\r?\n)*^[ \t]*-{3,}[ \t]*$(?:\r?\n)*/gm,
        // No border and no colour: ST's `hr` is a gradient, which either would flatten.
        '<hr style="margin:15px 0;opacity:0.75;">');
    const prose = proseRanges(src);
    // Whole-range, not per cut: emitting `<!-- ` alone opens a comment that swallows the mark after it.
    const revealed = new Set(prose.filter(r => r.tag === 'html'
        && (showMarkup || spans.some(sp => sp.start < r.end && r.start < sp.end))));
    const cuts = [...new Set([0, src.length, ...spans.flatMap(sp => [sp.start, sp.end]), ...prose.flatMap(r => [r.start, r.end])])]
        .sort((a, b) => a - b);
    let html = '';
    let codeOpen = null;
    const closeCode = () => { if (codeOpen) { html += '</code>'; codeOpen = null; } };
    for (let i = 0; i + 1 < cuts.length; i++) {
        const [a, b] = [cuts[i], cuts[i + 1]];
        if (a >= b) continue;
            const covering = prose.filter(r => r.start <= a && b <= r.end);
        const sp = markSpan ? spans.find(x => x.start <= a && b <= x.end) : null;
        // A delimiter no span overlaps is not rendered, as chat does not render it.
        if (covering.some(r => r.tag === 'delim') && !sp && !showMarkup) continue;
        // A span overlapping markup shows it as text: a mark inside an attribute, or inside a comment, renders nothing.
        const asMarkup = covering.find(r => r.tag === 'html');
        if (asMarkup) {
            if (!revealed.has(asMarkup)) { closeCode(); html += src.slice(a, b); continue; }
            // One <code> per range, not per cut: ST's `code` has a border and padding, which would repeat per piece.
            if (codeOpen !== asMarkup) { closeCode(); html += '<code>'; codeOpen = asMarkup; }
            html += sp ? markSpan(sp, src.slice(a, b)) : escapeHtml(src.slice(a, b));
            continue;
        }
        closeCode();
        const tags = covering.filter(r => r.tag !== 'delim').map(r => r.tag)
            .sort((x, y) => TAG_ORDER.indexOf(x) - TAG_ORDER.indexOf(y));
        html += `${tags.map(t => TAG_HTML[t][0]).join('')}${sp ? markSpan(sp, src.slice(a, b)) : escapedWithRules(src.slice(a, b))}`
            + `${[...tags].reverse().map(t => TAG_HTML[t][1]).join('')}`;
    }
    closeCode();
    // ST's own config, so this admits what a message admits. data-at/data-to are added: DOMPurify drops unknown attributes.
    return DOMPurify.sanitize(html, { MESSAGE_SANITIZE: true, ADD_ATTR: ['data-at', 'data-to'] });
}

let studioStyled = false;
export function ensureStudioStyle() {
    if (studioStyled) return;
    studioStyled = true;
    const style = document.createElement('style');
    // --wa-severe is the audit's red, as a variable: the script side has it in SEVERITY_COLOR and a sheet cannot read that.
    style.textContent = `
.wa-studio, .wa-ctx-menu, .wa-bulkbar { --wa-severe: #e06c6c; }
/* Focus has to land somewhere when a nested popup (Replace all…, a confirm) closes, and with no OK
   button left it falls to the dialog, then to whichever pane Chrome counts as focusable — it makes
   scroll containers focusable, so the nav or the entry list gets ringed. None of these are controls;
   the ring marks a whole pane and points at nothing actionable. Real controls inside keep theirs.
   Cost: tabbing to a pane to arrow-scroll it shows no indicator. */
dialog.popup:has(.wa-studio), .wa-studio-nav, .wa-studio-explorer, .wa-studio-entries { outline: none; }
.wa-studio { position: relative; display: flex; gap: 0; height: 72vh; text-align: left; }
/* Close corner — the popup's own button row is hidden, so this is the only way out, which is why it's
   a real button: it has to be reachable by keyboard, and it keeps its focus ring. */
.wa-studio-close { position: absolute; top: 0; right: 0; z-index: 2; cursor: pointer; opacity: 0.55;
    padding: 4px 7px; border-radius: 4px; font-size: 1.15em;
    background: none; border: none; color: inherit; line-height: 1; }
.wa-studio-close:hover { opacity: 1; background: var(--white20a, rgba(255,255,255,0.1)); }
/* renderMessageHtml's output, coloured as .mes_text colours a message. <q>'s auto-quotes are off: the quote characters
   are in the text already. */
.wa-marked q { color: var(--SmartThemeQuoteColor); }
.wa-marked em { color: var(--SmartThemeEmColor); }
.wa-marked u { color: var(--SmartThemeUnderlineColor); }
.wa-marked q em, .wa-marked q i, .wa-marked q u, .wa-marked q strong { color: inherit; }
.wa-marked code { font-family: var(--monoFontFamily); font-size: 0.92em; }
.wa-marked q::before, .wa-marked q::after { content: ''; }
.wa-studio-nav { flex: 0 0 20%; min-width: 170px; max-width: 320px; overflow-y: auto;
    border-right: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); padding-right: 6px; }
/* Collapsed to a rail holding the chevron. min-width overrides the rule above. */
.wa-studio-nav.wa-nav-collapsed { flex: 0 0 22px; min-width: 22px; padding-right: 0; overflow: hidden; }
/* Explorer = pinned header/drawer (wa-studio-fixed) + a single scrolling entry list (wa-studio-entries),
   so the header and the Tool Settings drawer stay put (MUI persistent top drawer: docked, pushes the
   list down) while only the entries scroll beneath. */
.wa-studio-explorer { flex: 1 1 auto; display: flex; flex-direction: column; overflow: hidden; padding-left: 12px; min-width: 0; }
.wa-studio-fixed { flex: 0 0 auto; }
.wa-studio-entries { flex: 1 1 auto; overflow-y: auto; min-width: 0; }
.wa-studio-body { flex: 1 1 auto; display: flex; min-height: 0; }
.wa-rail { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; padding: 2px 0 0 8px; }
.wa-rail .menu_button { width: 2.2em; height: 2.2em; padding: 0; margin: 0; display: grid; place-items: center; position: relative; }
.wa-rail-count { position: absolute; bottom: 1px; right: 2px; font-size: 0.55em; line-height: 1; opacity: 0.8; }
.wa-studio-navhead, .wa-studio-exphead { position: sticky; top: 0; z-index: 1; padding: 2px 0 6px;
    background: var(--SmartThemeBlurTintColor, var(--black70a, rgba(20,20,20,0.95))); }
.wa-book-row { display: flex; align-items: center; gap: 5px; padding: 4px 6px; border-radius: 5px;
    cursor: pointer; white-space: nowrap; overflow: hidden; }
.wa-book-row:hover { background: var(--white20a, rgba(255,255,255,0.08)); }
.wa-book-row.wa-sel { background: var(--white30a, rgba(255,255,255,0.14)); font-weight: bold; }
.wa-book-name { overflow: hidden; text-overflow: ellipsis; }
/* Books attached to this chat. The theme accent, not WA_GREEN, which means "no prune" on a keyword chip. */
.wa-book-row.wa-attached .wa-book-name { color: var(--SmartThemeQuoteColor); }
.wa-book-row.wa-attached { box-shadow: inset 2px 0 0 var(--SmartThemeQuoteColor); }
/* Bulk-select mode: size the nav to its content (capped) so full book titles are readable. */
.wa-studio-nav.wa-nav-wide { flex: 0 0 auto; width: max-content; min-width: 200px; max-width: 55%; overflow: auto; }
.wa-nav-wide .wa-book-row { overflow: visible; }
.wa-nav-wide .wa-book-name { overflow: visible; text-overflow: clip; }
/* Tab strip above the explorer pane: Explorer / Cleanup. The active tab is the only
   indicator of which direction a commit runs in, so it reads loudly (underline + colour, not just weight). */
.wa-tabs { display: flex; gap: 2px; flex: 0 0 auto; margin-bottom: 6px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-tab { padding: 5px 14px; cursor: pointer; white-space: nowrap; opacity: 0.6; font-size: 0.9em;
    border: none; background: transparent; color: inherit; font-family: inherit;
    border-bottom: 2px solid transparent; margin-bottom: -1px; }
.wa-tab:hover { opacity: 0.9; background: var(--white20a, rgba(255,255,255,0.06)); }
.wa-tab.wa-tab-on { opacity: 1; font-weight: bold; color: var(--SmartThemeQuoteColor, #6ea8fe);
    border-bottom-color: var(--SmartThemeQuoteColor, #6ea8fe); }
.wa-tab-count { opacity: 0.6; font-weight: normal; margin-left: 5px; font-size: 0.9em; }
/* Key-per-row tables shared by Cleanup and Suggest. */
/* Pinned strip of the book's ignored terms, above the term list. Wraps rather than scrolls — the set is
   normally a handful, and a hidden overflow would defeat the point of pinning it. */
.wa-ign-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4em; padding: 5px 4px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.12)); }
.wa-term-grp { padding: 6px 2px 2px; display: flex; align-items: center; gap: 6px; font-weight: bold;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.08)); }
/* Left-packed with deliberate gaps rather than a stretched term column: term, a thumb's width, the
   whitelist toggle, a wider gap, then the reason. The reason sits far enough from the icon that the
   two read as separate columns without the icon drifting to the far edge on short terms. */
.wa-term-row { display: flex; align-items: center; gap: 0; padding: 2px 2px 2px 22px; }
.wa-term-row:hover { background: var(--white20a, rgba(255,255,255,0.05)); }
.wa-term-name { flex: 0 1 auto; min-width: 0; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-term-why { flex: 0 0 auto; margin-left: 2.5rem; opacity: 0.85; font-size: 0.85em; white-space: nowrap; }
.wa-term-act { flex: 0 0 auto; cursor: pointer; opacity: 0.5; padding: 2px 5px; margin-left: 1rem; }
.wa-term-act:hover { opacity: 1; }
.wa-entry { padding: 5px 4px; border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); }
.wa-entry-head { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.wa-entry-title { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wa-off { opacity: 0.45; }
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
.wa-tool.wa-on { opacity: 1; color: var(--SmartThemeQuoteColor, #6ea8fe); }
.wa-tool.wa-badge { position: relative; }
.wa-tool.wa-badge::after { content: attr(data-badge); position: absolute; top: -3px; right: -4px;
    font-size: 0.6em; font-style: normal; font-weight: bold; line-height: 1.4; padding: 0 3px;
    border-radius: 8px; background: color-mix(in srgb, var(--SmartThemeQuoteColor) 30%, var(--SmartThemeBlurTintColor));
    color: var(--SmartThemeBodyColor); }
.wa-title-edit { font-size: 0.82em; opacity: 0.4; }
.wa-mode { display: inline-block; user-select: none; margin: 0; padding: 1px 2px; font-size: 0.95em; background: transparent;
    border: 1px solid transparent; border-radius: 4px; cursor: pointer; outline: none; }
.wa-mode:hover, .wa-mode:focus-visible { border-color: var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-kw-para { display: flex; flex-wrap: wrap; align-items: flex-start; margin: 6px 0 2px 22px; }
/* Chip outline/fill derive from currentColor (the theme's text colour) so they stay visible on any
   background — a fixed --SmartThemeBorderColor vanished on near-black themes. */
.wa-kw-item { display: inline-flex; flex-direction: column; align-items: flex-start; white-space: nowrap; margin: 0 0.6em 0.5em 0; }
.wa-kw { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px;
    white-space: nowrap; border: 1px solid color-mix(in srgb, currentColor 40%, transparent); border-radius: 11px; }
.wa-kw-dead .wa-kw-text { opacity: 0.8; }
/* A text-only chip: wraps, and breaks a term with no break opportunity in it. inline, since it has no ✕ to lay out. */
.wa-kw-wrap { display: inline; white-space: normal; overflow-wrap: anywhere; }
/* Both jump targets. */
.wa-studio [data-jump], .wa-marked [data-at] { cursor: pointer; }
/* The gate row reads under the keys it gates, so it needs a rule to be a second row at all — two
   paragraphs of chips run together and the secondaries read as more primaries. currentColor for the
   same reason the chips use it: a fixed border colour vanishes on near-black themes. */
.wa-kw-sec { border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding-top: 7px; }
.wa-kw-sec .wa-mode { margin-right: 0.6em; align-self: flex-start; }
/* Whitelisted (ignored) keys: purple so a deliberately-spared key reads apart from an unflagged one. */
.wa-kw-ignored { border-color: #a879e0 !important; background: color-mix(in srgb, #a879e0 18%, transparent); }
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
/* ST draws the tick on :checked only, so an indeterminate box is pixel-identical to an empty one. Same
   mechanism (::before carries the tick colour), a dash instead of the checkmark. */
.wa-tri:indeterminate::before { transform: scale(1); clip-path: polygon(12% 42%, 88% 42%, 88% 58%, 12% 58%); }
/* width:unset, or ST's .menu_button width breaks any two-word label onto a second line (its own popup.css says so). */
.wa-bulk-btn { margin: 0; padding: 3px 10px; font-size: 0.82em; width: unset; white-space: nowrap; }
.wa-bulk-danger { color: var(--wa-severe); }
.wa-bulk-sep { align-self: stretch; width: 1px; background: color-mix(in srgb, currentColor 22%, transparent); margin: 0 3px; }
.wa-book-tools { margin-left: 8px; white-space: nowrap; }
.wa-book-tool { cursor: pointer; opacity: 0.5; padding: 3px 5px; border-radius: 4px; font-size: 0.9em; }
.wa-book-tool:hover { opacity: 1; background: var(--white20a, rgba(255,255,255,0.1)); }
.wa-book-tool-danger:hover { color: var(--wa-severe); }
.wa-filter { margin: 0; padding: 3px 6px; font-size: 0.82em; }
.wa-undo-bar { display: flex; flex-direction: column; gap: 5px; margin: 4px 0 6px; padding: 6px 8px; border-radius: 5px;
    font-size: 0.85em; background: color-mix(in srgb, var(--golden, #e0a86c) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--golden, #e0a86c) 45%, transparent); }
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
    box-shadow: 0 6px 20px var(--SmartThemeShadowColor, rgba(0,0,0,0.45)); font-size: 0.9em; }
.wa-ctx-item { display: flex; align-items: center; gap: 14px; padding: 5px 11px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.wa-ctx-item:hover { background: var(--white20a, rgba(255,255,255,0.12)); }
.wa-ctx-danger:hover { color: var(--wa-severe); }
.wa-ctx-caret { margin-left: auto; opacity: 0.55; font-size: 1.15em; line-height: 1; }
.wa-ctx-active { color: var(--SmartThemeQuoteColor, #6ea8fe); font-weight: 600; }
.wa-sugg { display: inline-flex; align-items: center; gap: 3px; margin: 0 0.7em 0.2em 0; white-space: nowrap; opacity: 0.9; }
/* ➕ takes the candidate as-is; the text rewords it first. Both commit, so both look clickable. */
.wa-sugg-add { cursor: pointer; opacity: 0.55; font-size: 0.85em; }
.wa-sugg-add:hover { opacity: 1; }
.wa-sugg-text { cursor: text; }
.wa-sugg-text:hover { text-decoration: underline dotted; }
.wa-adv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 28px; margin: 6px 0 2px 22px; padding: 8px 10px; border-radius: 5px;
    background: var(--black30a, rgba(0,0,0,0.15)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-adv-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wa-adv-sec { font-weight: bold; font-size: 0.78em; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2px; }
.wa-adv-row { display: flex; align-items: center; gap: 6px; font-size: 0.9em; margin: 0; }
.wa-adv-row input[type=number] { width: 4.5em; margin: 0 0 0 auto; padding: 2px 5px; }
.wa-adv-warn { display: flex; align-items: center; gap: 5px; margin-top: 5px; padding: 4px 6px; border-radius: 4px; font-size: 0.8em;
    background: color-mix(in srgb, var(--golden, #e0a86c) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--golden, #e0a86c) 45%, transparent); }
.wa-adv-warn i { color: var(--golden, #e0a86c); }`;
    document.head.append(style);
}
