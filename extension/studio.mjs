// studio.mjs — Lorebook Studio (/wa-studio): the wide two-pane lorebook manager. All books on the
// left, the selected book's entries on the right, with per-entry tools (mode, match flags, sticky,
// ⚡/✨ keyword suggestions, duplicate, delete), prune-coloured click-to-edit keywords, bulk actions,
// search, and the Tool Settings tray.
//
// DOM- and ST-coupled, like keyword-tools.mjs. The pure logic it stands on lives elsewhere and is
// shared with the rest of WA: the keyword classifier/suggester in keyword-core.mjs (via keyword-tools'
// flag-injecting wrapper), the sort vocabulary and tier definitions in sort.mjs, and the shared widgets
// (context menu, sort control, stylesheet) in ui-widgets.mjs — so the Studio and the wand-menu reports
// can never drift on what counts as a weak key or how entries order.
import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { loadWorldInfo, saveWorldInfo, reloadEditor, duplicateWorldInfoEntry, deleteWorldInfoEntry, getFreeWorldEntryUid, deleteWIOriginalDataValue, deleteWorldInfo, updateWorldInfoList, world_names, world_info_match_whole_words, world_info_case_sensitive, selected_world_info, world_info, METADATA_KEY } from '../../../../world-info.js';
import { power_user } from '../../../../power-user.js';
import { escapeHtml } from '../../../../utils.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { runState, settings } from './state.mjs';
import { ensureStudioStyle, makeSortControl, showCtxMenu } from './ui-widgets.mjs';
import { SORT_FNS, normPresentation, reconcileTiers, tierRank, wiTitleOf } from './sort.mjs';
import { buildKeyPruneScan, llmKeyCandidates, STUDIO_PRUNE_OPTS, STUDIO_SUGGEST_OPTS } from './keyword-tools.mjs';
import { buildKeySuggest, classifyLlmCand } from './keyword-core.mjs';

const WA_GREEN = '#7bbf6a';   // "no prune" — a keyword the scan doesn't flag

/**
 * Plan an advanced reorder: place the selected entries (given top-to-bottom in `orderedUids`) into a
 * contiguous UID/order block [start, start+N-1], leaving every unselected entry on its current UID.
 * Pure (no DOM, no mutation) so the destructive UID rebuild in Lorebook Studio stays unit-testable.
 * Returns { conflict: uid } if a target UID is held by an unselected entry (caller must abort — moving
 * onto it would clobber data), otherwise { moves: [[oldUid, newUid], …] } in application order.
 * @param {object} entries  the book's entries object (keyed by uid)
 * @param {number[]} orderedUids  selected uids, on-screen order
 * @param {number} start  first uid of the block
 * @param {boolean} desc  true = top gets the highest value (start+N-1), false = top gets `start`
 */
function planUidReindex(entries, orderedUids, start, desc) {
    const n = orderedUids.length;
    const selUids = new Set(orderedUids);
    const targetOf = i => start + (desc ? n - 1 - i : i);
    for (let i = 0; i < n; i++) { const u = targetOf(i); if ((u in entries) && !selUids.has(u)) return { conflict: u }; }
    return { moves: orderedUids.map((uid, i) => [uid, targetOf(i)]) };
}

/**
 * Lorebook Studio (/wa-studio) — a wide two-pane manager: all books on the left, the selected book's
 * entries on the right, with per-entry tools (mode, flag toggles, sticky, ⚡/✨ suggestions, duplicate,
 * delete), prune-coloured click-to-edit keywords, bulk actions, search, and the Tool Settings tray.
 * @param {string|null} preferredBook Book to open if it still exists — the caller's notion of "current"
 *        (the chat's bound lorebook). Falls back to any attached world, then to nothing selected.
 */
export async function lorebookStudio(preferredBook = null) {
    if (!(world_names ?? []).length) { toastr.warning('No lorebooks found.', 'Worlds Apart'); return ''; }
    ensureStudioStyle();

    let sortAsc = true;
    // Prefer the current chat's bound lorebook, then any world attached to the active character.
    let selected = (world_names.includes(preferredBook) ? preferredBook : null)
        ?? [...runState.attachedWorlds].find(w => world_names.includes(w)) ?? null;
    let data = null;                 // loaded world-info for `selected`
    let scan = null;                 // buildKeyPruneScan result for `data` (keyword colouring)
    let suggest = null;              // buildKeySuggest result, built lazily on first ⚡/🪄
    let ignoreSet = new Set();       // per-book prune whitelist (shared with the prune popup)
    // Scan + recommender options persist globally (extension_settings), edited via the Tool Settings tray.
    let studioOpts = { ...STUDIO_PRUNE_OPTS, ...(settings().studioScanOpts ?? {}) };
    let suggestOpts = { ...STUDIO_SUGGEST_OPTS, ...(settings().studioSuggestOpts ?? {}) };
    let trayOpen = false;            // Tool Settings disclosure state (session)
    let trayEl = null;               // the mounted tray element, so open/close swaps just it (not the entry list)
    let bulkEl = null;               // the mounted bulk-action bar, swapped in place as selection changes
    let globalTrayOpen = false;      // 🌐 global WI settings drawer (session)
    let globalTrayEl = null;         // the mounted global-tray element, swapped in place on toggle
    const selectedEntries = new Set();   // uids ticked for bulk actions
    let selAnchorUid = null;         // last-ticked entry, for shift-click range selection
    let entryFilter = 'all';         // explorer entry-type filter (all / keyword / constant / vector / enabled / disabled / flagged)
    // Explorer sort view — the CURRENT book's base sort + tiered toggle. Persisted PER-LOREBOOK
    // (settings().studioSortByBook), loaded on open, defaulting to 'insert' (mirror the prompt insertion
    // order). Decoupled from the durable insertion settings. tierCfg is shared/durable with the prompt.
    let entrySort = 'insert';
    let tieredMode = true;
    let tierCfg = reconcileTiers(settings().tierCfg);   // [{id, on}] tier precedence — DURABLE, shared with the prompt builder
    const loadSortView = name => { const v = settings().studioSortByBook?.[name]; entrySort = v?.sort ?? 'insert'; tieredMode = v?.tiered ?? true; };
    const persistSortView = () => { const s = settings(); (s.studioSortByBook ??= {})[selected] = { sort: entrySort, tiered: tieredMode }; saveSettingsDebounced(); };
    let searchQuery = '';            // explorer free-text search
    let visibleUids = [];            // uids of the on-screen list, in sorted+filtered order — the single
                                     // source of truth for "visual order" (shift-range selection, renumber)
    const searchScope = { title: true, entry: true, keywords: true };   // which fields the search looks in
    let pendingUndo = null;          // { books: [{name, data}] } of the last deletion, offered in the nav undo bar
    let undoTimer = null;            // auto-expiry for the undo bar
    const selectedBooks = new Set(); // book names ticked in the nav for book-level bulk actions
    let bookAnchor = null;           // last-ticked book, for shift-click range selection
    let bookBulkMode = false;        // nav "select multiple" mode — reveals row checkboxes + the copy/delete bar
    let dirty = false;               // an edit was saved -> reloadEditor on close
    const entryOpen = new Set();     // level 1: entry expanded (tools + keywords + text) vs. title line only
    const expanded = new Set();      // level 2: entry text expanded (textarea) vs. first-line preview
    const tall = new Set();          // entry uids whose editor is popped out to full Studio height
    const advOpen = new Set();       // entry uids with the Advanced tray (recursion/budget/timing) expanded
    const sugg = new Map();          // uid -> { tfidf:string[], llm:string[] } transient suggestion chips
    const rowEls = new Map();        // uid -> entry row element, so one edit re-renders just that entry

    const root = document.createElement('div');
    root.className = 'wa-studio';
    const nav = document.createElement('div'); nav.className = 'wa-studio-nav';
    const explorer = document.createElement('div'); explorer.className = 'wa-studio-explorer';
    root.append(nav, explorer);

    const firstLine = e => { const t = String(e.content ?? '').trim(); const nl = t.indexOf('\n'); return (nl < 0 ? t : t.slice(0, nl)) || '(empty)'; };
    const save = () => { dirty = true; saveWorldInfo(selected, data, true); };
    const getSugg = uid => { let x = sugg.get(uid); if (!x) sugg.set(uid, x = { tfidf: [], llm: [] }); return x; };
    const rebuildScan = () => { scan = buildKeyPruneScan(data, studioOpts, ignoreSet); };
    // Repaint only the entries whose key list includes one of `keys`. classifyEntry reads the live
    // ignoreSet and the df table is ignore-independent, so whitelisting needs no rescan — just recolour
    // the affected rows (chip colour + collapsed badge reflect the new ignore state).
    const rerenderKeys = keys => { const set = new Set(keys); for (const e of Object.values(data?.entries ?? {})) if ((Array.isArray(e.key) ? e.key : []).some(k => set.has(k))) renderEntry(e); };

    const persistIgnore = () => { const s = settings(); if (!s.keywordIgnore) s.keywordIgnore = {}; s.keywordIgnore[selected] = [...ignoreSet]; saveSettingsDebounced(); };
    const persistOpts = () => { const s = settings(); s.studioScanOpts = studioOpts; s.studioSuggestOpts = suggestOpts; saveSettingsDebounced(); };

    // "⚙ Tool Settings" tray under the explorer header. Scan/prune options apply on the next Scan press;
    // recommender knobs invalidate the cached ranker so the next ⚡/✨ rebuilds with them; the whitelist
    // is this book's prune ignore-set (shared with the /wa-keyword-scores popup). Replaces the old
    // shift-click options popup. All options persist globally to extension_settings.
    const renderTray = () => {
        const wrap = document.createElement('div'); wrap.className = 'wa-tray';
        const head = document.createElement('div'); head.className = 'wa-tray-head';
        const chev = document.createElement('i'); chev.className = 'fa-solid fa-chevron-right wa-chevron' + (trayOpen ? ' wa-open' : '');
        const lbl = document.createElement('span'); lbl.innerHTML = '<i class="fa-solid fa-gear"></i> Tool Settings';
        head.append(chev, lbl);
        head.addEventListener('click', () => { trayOpen = !trayOpen; refreshTray(); });   // swap only the tray, not the entry list
        wrap.append(head);
        if (!trayOpen) return wrap;

        const panel = document.createElement('div'); panel.className = 'wa-tray-panel';
        const check = (obj, key, label, after) => {
            const l = document.createElement('label'); l.className = 'checkbox_label wa-tray-opt';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!obj[key];
            cb.addEventListener('change', () => { obj[key] = cb.checked; persistOpts(); after?.(); });
            const sp = document.createElement('span'); sp.textContent = label;
            l.append(cb, sp); return l;
        };
        const num = (obj, key, before, unit, opt, after) => {
            const { min = 1, max, scale = 1, width = '3.6em' } = opt || {};
            const l = document.createElement('label'); l.className = 'checkbox_label wa-tray-opt wa-tray-num';
            const b = document.createElement('span'); b.textContent = before;
            const inp = document.createElement('input'); inp.type = 'number'; inp.className = 'text_pole';
            inp.style.cssText = `width:${width};margin:0 4px;`; inp.min = min; if (max != null) inp.max = max;
            inp.value = String(Math.round(obj[key] * scale));
            inp.addEventListener('change', () => {
                const v = Number(inp.value) / scale;
                if (!(v > 0)) { inp.value = String(Math.round(obj[key] * scale)); return; }
                obj[key] = scale === 1 ? Math.floor(v) : v; persistOpts(); after?.();
            });
            const u = document.createElement('span'); u.textContent = unit;
            l.append(b, inp, u); return l;
        };
        const col = (title, ...kids) => {
            const c = document.createElement('div'); c.className = 'wa-tray-col';
            const h = document.createElement('div'); h.className = 'wa-tray-sec'; h.textContent = title;
            c.append(h, ...kids); return c;
        };
        const invSuggest = () => { suggest = null; };

        const wl = document.createElement('div');   // whitelist column body: chips row, then a centred Clear
        const chips = document.createElement('div'); chips.className = 'wa-tray-wl';
        if (!ignoreSet.size) { const em = document.createElement('span'); em.style.opacity = '0.55'; em.textContent = 'None — shift-click a keyword’s ✕ to whitelist it.'; chips.append(em); }
        for (const key of [...ignoreSet].sort()) {
            const chip = document.createElement('span'); chip.className = 'wa-kw wa-kw-ignored';
            const t = document.createElement('span'); t.className = 'wa-kw-text'; t.textContent = key; t.style.cursor = 'default';
            const x = document.createElement('i'); x.className = 'fa-solid fa-xmark wa-kw-del'; x.title = 'Remove from whitelist';
            x.addEventListener('click', () => { ignoreSet.delete(key); persistIgnore(); rerenderKeys([key]); refreshTray(); });
            chip.append(t, x); chips.append(chip);
        }
        wl.append(chips);
        if (ignoreSet.size) {
            const clrRow = document.createElement('div'); clrRow.className = 'wa-tray-wl-clear';
            const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'menu_button'; clr.style.margin = '0';
            clr.textContent = 'Clear whitelist';
            clr.addEventListener('click', () => { const cleared = [...ignoreSet]; ignoreSet.clear(); persistIgnore(); rerenderKeys(cleared); refreshTray(); });
            clrRow.append(clr); wl.append(clrRow);
        }

        panel.append(
            col('Keyword audit',
                check(studioOpts, 'scanKeyword', 'Scan Keyword (🟢)'),
                check(studioOpts, 'scanVectorized', 'Scan Vectorized (🔗)'),
                check(studioOpts, 'scanConstant', 'Scan Constant (🔵)'),
                check(studioOpts, 'includeInactive', 'Include inactive entries'),
                check(studioOpts, 'pruneDead', 'Flag dead keys (in no entry text)'),
                check(studioOpts, 'pruneCommon', 'Flag frequent keys'),
                num(studioOpts, 'tooCommon', '↳ frequent: in >', '% of entries', { min: 1, max: 100, scale: 100 }),
                check(studioOpts, 'pruneShort', 'Flag short keys'),
                num(studioOpts, 'minLength', '↳ short: under', 'chars', { min: 1 }),
                check(studioOpts, 'ignoreProper', 'Spare proper nouns from the dead flag'),
                check(studioOpts, 'stickySkipCommon', 'Spare sticky entries from the frequent flag'),
            ),
            col('Recommender (⚡ / ✨)',
                num(suggestOpts, 'dfCeil', 'Skip terms in >', '% of entries', { min: 1, max: 100, scale: 100 }, invSuggest),
                num(suggestOpts, 'maxN', 'Longest phrase', 'words', { min: 1, max: 8 }, invSuggest),
                num(suggestOpts, 'cap', 'Max per entry', '', { min: 1, max: 50 }, invSuggest),
                num(suggestOpts, 'llmChunk', '✨ chunk over', 'chars', { min: 500, width: '5.6em' }),   // longer entries split into this-sized passes
                check(suggestOpts, 'excludeDates', 'Skip date-like terms', invSuggest),
                check(suggestOpts, 'excludeShort', 'Skip short terms', invSuggest),
                check(suggestOpts, 'onlyActive', 'Suggest from active entries only', invSuggest),
            ),
            col(`Whitelist — ${ignoreSet.size} key${ignoreSet.size === 1 ? '' : 's'}`, wl),
        );
        wrap.append(panel);
        return wrap;
    };
    // Open/close (and whitelist edits) rebuild only the tray in place — the entry list is untouched, so
    // toggling stays instant no matter the book size or how many keys are whitelisted.
    const refreshTray = () => { const fresh = renderTray(); if (trayEl?.isConnected) trayEl.replaceWith(fresh); trayEl = fresh; };

    // 🌐 Global World Info settings — the app-wide knobs, surfaced in-context. WA's scan-depth and token
    // budget OVERRIDE core (stored in extension_settings); the activation knobs are core globals, edited
    // by driving core's own inputs so persistence + the min-activations/max-recursion mutual-exclusion
    // come for free. Reading core values from those inputs keeps us in sync without importing internals.
    const refreshGlobalTray = () => { const fresh = renderGlobalTray(); if (globalTrayEl?.isConnected) globalTrayEl.replaceWith(fresh); globalTrayEl = fresh; };
    function renderGlobalTray() {
        if (!globalTrayOpen) return document.createElement('div');   // nothing mounted when closed
        const panel = document.createElement('div'); panel.className = 'wa-tray-panel';
        const col = (title, ...kids) => { const c = document.createElement('div'); c.className = 'wa-tray-col'; const h = document.createElement('div'); h.className = 'wa-tray-sec'; h.textContent = title; c.append(h, ...kids); return c; };
        const numRow = (label, backing, unit, title) => {
            const l = document.createElement('label'); l.className = 'wa-tray-opt wa-tray-num'; if (title) l.title = title;
            const b = document.createElement('span'); b.textContent = label;
            const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.className = 'text_pole'; inp.style.cssText = 'width:4.5em;margin:0 4px;'; inp.value = String(backing.get());
            inp.addEventListener('change', () => backing.set(Math.max(0, Math.floor(Number(inp.value) || 0))));
            const u = document.createElement('span'); u.textContent = unit || ''; u.style.opacity = '0.6';
            l.append(b, inp, u); return l;
        };
        const chkRow = (label, backing, title) => {
            const l = document.createElement('label'); l.className = 'checkbox_label wa-tray-opt'; if (title) l.title = title;
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = backing.get();
            cb.addEventListener('change', () => backing.set(cb.checked));
            const s = document.createElement('span'); s.textContent = label; l.append(cb, s); return l;
        };
        // Backings: WA settings (extension_settings, also mirror the main panel's input); core globals (drive
        // core's #world_info_* input so its handler updates the var, counter, mutual-exclusion, and saves).
        // Native dispatchEvent('input') fires core's jQuery-bound handlers — no jQuery dependency here.
        const el = id => document.querySelector(id);
        const fire = e => { if (e) e.dispatchEvent(new Event('input', { bubbles: true })); };
        const wa = (key, mirrorId) => ({ get: () => Number(settings()[key]) || 0, set: v => { settings()[key] = v; const m = el(mirrorId); if (m) m.value = v; saveSettingsDebounced(); } });
        const coreNum = id => ({ get: () => Number(el(id)?.value) || 0, set: v => { const e = el(id); if (e) { e.value = v; fire(e); } refreshGlobalTray(); } });
        const coreChk = (id, after) => ({ get: () => !!el(id)?.checked, set: v => { const e = el(id); if (e) { e.checked = v; fire(e); } after?.(); } });
        panel.append(
            col('Worlds Apart (overrides core)',
                numRow('Scan depth', wa('messageDepth', '#wa_message_depth'), 'messages', 'Recent messages WA scans / queries — overrides core scan depth'),
                numRow('Budget cap', wa('maxTokens', '#wa_max_tokens'), 'tokens', 'Absolute token budget over all activated entries (0 = leave to core)'),
                numRow('Budget %', wa('maxTokensPercent', '#wa_max_tokens_pct'), '% of max', 'Token budget as a % of max prompt tokens (0 = off); tighter of the two wins'),
            ),
            col('Core activation',
                numRow('Min Inserted Entries', coreNum('#world_info_min_activations'), '', 'Keep scanning back until at least this many entries activate (0 = off). Mutually exclusive with Max Recursions.'),
                numRow('↳ Max Depth', coreNum('#world_info_min_activations_depth_max'), 'messages', 'When Min Inserted Entries > 0, the furthest back the search will reach (0 = no cap)'),
                numRow('Max Recursions', coreNum('#world_info_max_recursion_steps'), '', 'Recursive scan passes (0 = off). Mutually exclusive with Min Inserted Entries.'),
                chkRow('Recursive scanning', coreChk('#world_info_recursive'), 'Let activated entries trigger further entries'),
            ),
            col('Matching defaults',
                // renderExplorer on change so inherited entry icons recolour (light green = on via this default).
                chkRow('Case-sensitive', coreChk('#world_info_case_sensitive', renderExplorer), 'Default for entries that don’t set their own — their Aa icon shows light green when inherited'),
                chkRow('Match whole words', coreChk('#world_info_match_whole_words', renderExplorer), 'Default for entries that don’t set their own — their [ab] icon shows light green when inherited'),
            ),
        );
        return panel;
    }

    // --- Bulk selection + actions ---------------------------------------------------------------
    // A contextual bar in the pinned region (below the tray) appears while any entry is ticked. Actions
    // mutate the selected entries, save once, then repaint just those rows (selection persists). The bar
    // itself is swapped in place (refreshBulkBar) so selecting never rebuilds the entry list.
    const refreshBulkBar = () => { const fresh = renderBulkBar(); if (bulkEl?.isConnected) bulkEl.replaceWith(fresh); bulkEl = fresh; };
    const syncSelCheckboxes = () => { for (const [uid, row] of rowEls) { const cb = row.querySelector('.wa-entry-sel'); if (cb) cb.checked = selectedEntries.has(uid); } refreshBulkBar(); };
    const selectedList = () => [...selectedEntries].map(uid => data?.entries?.[uid]).filter(Boolean);
    const applyBulk = fn => { const sel = selectedList(); if (!sel.length) return; for (const e of sel) fn(e); save(); sel.forEach(renderEntry); };
    const numberPrompt = async (title, label, def, min, max) => {
        const raw = await Popup.show.input(title, label, String(def));
        if (raw == null) return null;
        let v = Number(raw); if (!Number.isFinite(v)) return null;
        if (min != null) v = Math.max(min, v); if (max != null) v = Math.min(max, v);
        return v;
    };
    const bulkSticky = async () => { const v = await numberPrompt('Sticky — selected entries', 'Sticky value (0 = off):', 0, 0); if (v != null) applyBulk(e => e.sticky = Math.floor(v)); };
    const bulkTrigger = async () => { const v = await numberPrompt('Trigger % — selected entries', 'Probability (0–100):', 100, 0, 100); if (v != null) applyBulk(e => { e.probability = Math.round(v); e.useProbability = true; }); };
    const bulkDelay = async () => { const v = await numberPrompt('Delay — selected entries', 'Messages before first activation (0 = none):', 0, 0); if (v != null) applyBulk(e => e.delay = Math.floor(v) || null); };
    const bulkCooldown = async () => { const v = await numberPrompt('Cooldown — selected entries', 'Messages before it can re-activate (0 = none):', 0, 0); if (v != null) applyBulk(e => e.cooldown = Math.floor(v) || null); };
    const bulkScanDepth = async () => { const v = await numberPrompt('Scan depth — selected entries', 'Messages to scan (0 = global default):', 0, 0); if (v != null) applyBulk(e => e.scanDepth = Math.floor(v) > 0 ? Math.floor(v) : null); };
    const bulkRecLevel = async () => { const v = await numberPrompt('Delay until recursion — selected entries', 'Recursion level (0 = any; turns the flag on):', 0, 0); if (v != null) applyBulk(e => e.delayUntilRecursion = Math.floor(v) > 0 ? Math.floor(v) : true); };
    const bulkCopyTo = () => entriesToBook(selectedList(), false);
    const bulkMoveTo = () => entriesToBook(selectedList(), true);
    const bulkOrder = async (advanced = false) => {
        const curOrder = presentationLabel();
        const w = document.createElement('div'); w.style.textAlign = 'left';
        w.innerHTML = (advanced
            ? '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:7px 10px;border-radius:5px;background:#5a1f1f;border:1px solid #e06c6c;color:#ffd9d9;">'
                + '<i class="fa-solid fa-triangle-exclamation" style="color:#e06c6c;"></i>'
                + '<span>Don\'t do this unless you really know what you\'re doing.</span></div>'
            : '')
            + (advanced
            ? 'Advanced reorder: renumber the selected entries into a contiguous block, setting <b>both order and UID</b>, top to bottom.'
            : 'Renumber the selected entries into a contiguous <b>order</b> block, top to bottom.')
            + '<div style="margin-top:8px;">Start at <input type="number" class="wa-bo-start text_pole" style="width:6em;margin:0 6px;" value="1"></div>'
            + '<label class="checkbox_label" style="margin-top:6px;"><input type="radio" name="wa-bo-dir" class="wa-bo-asc" checked><span>Ascending — top gets the start value</span></label>'
            + '<label class="checkbox_label"><input type="radio" name="wa-bo-dir" class="wa-bo-desc"><span>Descending — top gets the highest value</span></label>'
            + (advanced ? '<small style="opacity:0.6;display:block;margin-top:6px;">Sets UID = order per entry. Aborts if the target UID range overlaps an unselected entry.</small>' : '')
            + `<div style="margin-top:8px;opacity:0.7;">Current sort order: <b>${escapeHtml(String(curOrder))}</b></div>`;
        const p = new Popup(w, POPUP_TYPE.CONFIRM, '', { okButton: advanced ? 'Reorder + UIDs' : 'Renumber', cancelButton: 'Cancel' });
        if (await p.show() !== POPUP_RESULT.AFFIRMATIVE) return;
        const startRaw = Number(w.querySelector('.wa-bo-start').value); const start = Number.isFinite(startRaw) ? Math.round(startRaw) : 1;
        const desc = w.querySelector('.wa-bo-desc').checked;
        const ordered = visibleUids.filter(u => selectedEntries.has(u)).map(u => data.entries[u]).filter(Boolean);   // selected, in on-screen (sorted) order
        const n = ordered.length;
        const targetOf = i => start + (desc ? n - 1 - i : i);   // block occupies [start, start+N-1]

        if (!advanced) { ordered.forEach((e, i) => e.order = targetOf(i)); save(); ordered.forEach(renderEntry); return; }

        // --- advanced: renumber UIDs too (uid = order). UID is the entries-object key + entry identity,
        // so this rebuilds data.entries. Guarded against the two ways it could lose data. ---
        if (data.originalData) { toastr.warning('UID renumber isn\'t available for character-embedded books.', 'Worlds Apart'); return; }
        if (start < 0) { toastr.warning('Start must be 0 or greater when renumbering UIDs.', 'Worlds Apart'); return; }
        const plan = planUidReindex(data.entries, ordered.map(e => e.uid), start, desc);
        if (plan.conflict != null) { toastr.warning(`UID ${plan.conflict} is already used by an unselected entry — clear that block or include it in the selection.`, 'Worlds Apart'); return; }
        const byUid = new Map(ordered.map(e => [e.uid, e]));
        const selUids = new Set(byUid.keys());
        const next = {};
        for (const e of Object.values(data.entries)) if (!selUids.has(e.uid)) next[e.uid] = e;   // unselected keep their uid
        for (const [oldUid, newUid] of plan.moves) { const e = byUid.get(oldUid); e.uid = newUid; e.order = newUid; next[newUid] = e; }
        data.entries = next;
        // uids changed -> every per-uid transient (open/expanded/tall/sugg/selection/scan) is stale.
        entryOpen.clear(); expanded.clear(); tall.clear(); advOpen.clear(); sugg.clear(); selectedEntries.clear(); suggest = null; if (scan) rebuildScan();
        save(); renderExplorer();
        toastr.success(`Renumbered ${n} ${n === 1 ? 'entry' : 'entries'} (order + UID).`, 'Worlds Apart');
    };
    const bulkDelete = async () => {
        const n = selectedEntries.size; if (!n) return;
        if (!await Popup.show.confirm(`Delete ${n} selected ${n === 1 ? 'entry' : 'entries'}?`, 'This is irreversible.')) return;
        for (const uid of [...selectedEntries]) { await deleteWorldInfoEntry(data, uid, { silent: true }); sugg.delete(uid); rowEls.delete(uid); }
        selectedEntries.clear();
        save(); suggest = null; if (scan) rebuildScan(); renderExplorer();
    };
    const renderBulkBar = () => {
        const wrap = document.createElement('div'); wrap.className = 'wa-bulk';
        const n = selectedEntries.size;
        if (!n) return wrap;   // nothing selected -> empty element, no visual footprint
        wrap.classList.add('wa-bulk-on');
        const mkBtn = (label, onClick, extra = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button wa-bulk-btn ' + extra; b.textContent = label; b.addEventListener('click', onClick); return b; };
        const sep = () => { const s = document.createElement('span'); s.className = 'wa-bulk-sep'; return s; };
        const all = Object.values(data?.entries ?? {}).filter(filterMatch);   // select-all targets the visible (filtered) set
        const count = document.createElement('span'); count.className = 'wa-bulk-count'; count.textContent = `${n} selected`;
        // "Set… ▾" opens a hierarchical menu covering every per-entry field (the gear tray + mode). Leaves
        // with "…" open a value prompt; the rest apply straight to the selection. Built fresh on open so the
        // Inherit labels reflect the current globals.
        const setMode = v => applyBulk(e => { e.constant = v === 'constant'; e.vectorized = v === 'vector'; });
        const setField = (prop, val) => applyBulk(e => e[prop] = val);
        const setItems = () => {
            const caseG = world_info_case_sensitive ? 'on' : 'off', wholeG = world_info_match_whole_words ? 'on' : 'off';
            const onOff = prop => [{ label: 'On', fn: () => setField(prop, true) }, { label: 'Off', fn: () => setField(prop, false) }];
            const tri = (prop, g) => [{ label: 'On', fn: () => setField(prop, true) }, { label: 'Off', fn: () => setField(prop, false) }, { label: `Inherit (${g})`, fn: () => setField(prop, null) }];
            return [
                { label: 'Mode', children: [{ label: '🟢 Keyword', fn: () => setMode('keyword') }, { label: '🔵 Constant', fn: () => setMode('constant') }, { label: '🔗 Vector', fn: () => setMode('vector') }] },
                { label: 'Sticky…', fn: bulkSticky },
                { label: 'Cooldown…', fn: bulkCooldown },
                { label: 'Delay…', fn: bulkDelay },
                { label: 'Probability', children: [{ label: 'Set %…', fn: bulkTrigger }, { label: 'On', fn: () => setField('useProbability', true) }, { label: 'Off', fn: () => setField('useProbability', false) }] },
                { label: 'Case-sensitive', children: tri('caseSensitive', caseG) },
                { label: 'Whole words', children: tri('matchWholeWords', wholeG) },
                { label: 'Recursion', children: [
                    { label: 'Non-recursable: On', fn: () => setField('excludeRecursion', true) },
                    { label: 'Non-recursable: Off', fn: () => setField('excludeRecursion', false) },
                    { label: 'Prevent further: On', fn: () => setField('preventRecursion', true) },
                    { label: 'Prevent further: Off', fn: () => setField('preventRecursion', false) },
                    { label: 'Delay until: On', fn: () => setField('delayUntilRecursion', true) },
                    { label: 'Delay until: Off', fn: () => setField('delayUntilRecursion', false) },
                    { label: 'Delay until: level…', fn: bulkRecLevel },
                ] },
                { label: 'Ignore budget', children: onOff('ignoreBudget') },
                { label: 'Scan depth…', fn: bulkScanDepth },
            ];
        };
        const setBtn = mkBtn('Set… ▾', () => { const r = setBtn.getBoundingClientRect(); showCtxMenu(setItems(), r.left, r.bottom + 2, ctxMount()); });
        setBtn.title = 'Set a field on all selected entries';
        const reBtn = mkBtn('Renumber…', ev => bulkOrder(ev.shiftKey)); reBtn.title = 'Renumber order — shift-click to also renumber UIDs';
        // One toggle instead of separate Enable/Disable: enable if any selected are off, else disable all.
        const anyDisabled = Object.values(data?.entries ?? {}).some(e => selectedEntries.has(e.uid) && e.disable);
        wrap.append(
            count,
            mkBtn(n === all.length ? 'Select none' : 'Select all', () => { n === all.length ? selectedEntries.clear() : all.forEach(e => selectedEntries.add(e.uid)); syncSelCheckboxes(); }),
            sep(),
            mkBtn(anyDisabled ? 'Enable' : 'Disable', () => { applyBulk(e => e.disable = !anyDisabled); refreshBulkBar(); }),
            setBtn,
            reBtn,
            sep(),
            mkBtn('Copy to…', bulkCopyTo),
            mkBtn('Move to…', bulkMoveTo),
            sep(),
            mkBtn('Delete', bulkDelete, 'wa-bulk-danger'),
        );
        return wrap;
    };

    const ensureSuggest = () => suggest ?? (suggest = buildKeySuggest(data, suggestOpts));
    const hasKey = (e, term) => Array.isArray(e.key) && e.key.some(k => String(k).toLowerCase().trim() === term.toLowerCase().trim());

    const tool = (cls, on, title, onClick) => {
        const i = document.createElement('i');
        if (cls.startsWith('fa-')) i.className = `fa-solid ${cls} wa-tool` + (on ? ' wa-on' : '');
        else { i.className = 'wa-tool' + (on ? ' wa-on' : ''); i.textContent = cls; i.style.fontWeight = 'bold'; }
        i.title = title;
        i.addEventListener('click', ev => { ev.stopPropagation(); onClick(ev); });
        return i;
    };

    // Tiny sticky editor: number box + −/+ steppers + 🚫 reset-to-0.
    const editSticky = async e => {
        const w = document.createElement('div');
        w.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.className = 'text_pole'; inp.style.cssText = 'width:5em;text-align:center;margin:0;';
        inp.value = String(Number(e.sticky) || 0);
        const step = (d, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button'; b.style.margin = '0'; b.textContent = label; b.addEventListener('click', () => { inp.value = String(Math.max(0, (Number(inp.value) || 0) + d)); }); return b; };
        const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'menu_button'; reset.style.margin = '0'; reset.textContent = '🚫'; reset.title = 'Reset to 0'; reset.addEventListener('click', () => { inp.value = '0'; });
        w.append(step(-1, '−'), inp, step(1, '+'), reset);
        const p = new Popup(w, POPUP_TYPE.CONFIRM, '', { okButton: 'Set', cancelButton: 'Cancel' });
        if (await p.show() === POPUP_RESULT.AFFIRMATIVE) { e.sticky = Math.max(0, Math.floor(Number(inp.value) || 0)); save(); renderEntry(e); }
    };

    // Trigger-probability editor: 0–100% number box + −/+ steppers + a reset to 100 (always fire).
    // Setting it turns useProbability on; 100 leaves gating enabled but effectively always-fires.
    const editProbability = async e => {
        const clamp = v => Math.min(100, Math.max(0, Math.floor(Number(v) || 0)));
        const w = document.createElement('div');
        w.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.className = 'text_pole'; inp.style.cssText = 'width:5em;text-align:center;margin:0;';
        inp.value = String(e.probability != null ? clamp(e.probability) : 100);
        const step = (d, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button'; b.style.margin = '0'; b.textContent = label; b.addEventListener('click', () => { inp.value = String(clamp((Number(inp.value) || 0) + d)); }); return b; };
        const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'menu_button'; reset.style.margin = '0'; reset.textContent = '🎯'; reset.title = 'Always fire (100%)'; reset.addEventListener('click', () => { inp.value = '100'; });
        w.append(step(-10, '−'), inp, step(10, '+'), reset);
        const p = new Popup(w, POPUP_TYPE.CONFIRM, 'Trigger probability %', { okButton: 'Set', cancelButton: 'Cancel' });
        if (await p.show() === POPUP_RESULT.AFFIRMATIVE) { e.probability = clamp(inp.value); e.useProbability = true; save(); renderEntry(e); }
    };


    // ⚡ TF-IDF suggestions for one entry (from the whole-book ranker); ✨ local-model reroll.
    // The first click builds the whole-book ranker (a ~1s pre-pass on big books), so dim the bolt and
    // yield a frame first, letting the dim paint before the synchronous pre-pass blocks the thread.
    const suggestTfidf = async (e, btn) => {
        if (btn.dataset.busy) return;
        if (!suggest) { btn.dataset.busy = '1'; btn.style.opacity = '0.25'; await new Promise(r => setTimeout(r, 0)); }
        const s = ensureSuggest();
        btn.dataset.busy = ''; btn.style.opacity = '';
        const pe = s.perEntry.find(p => String(p.entry.uid) === String(e.uid));
        const fresh = (pe?.newRows ?? []).map(r => r.display).filter(t => !hasKey(e, t));
        if (!fresh.length) { toastr.info('No TF-IDF suggestions for this entry.', 'Worlds Apart'); return; }
        const g = getSugg(e.uid);
        const seen = new Set([...g.tfidf, ...g.llm].map(t => s.canon(t)));
        for (const t of fresh) { const c = s.canon(t); if (!seen.has(c)) { g.tfidf.push(t); seen.add(c); } }
        renderEntry(e);
    };
    // Merge raw model candidates into one entry's ✨ tray via the shared classifyLlmCand — the exact
    // filters the single ✨ applies (dedupe, prompt-echo, generic single word, date-like, too-common).
    // Returns the count added.
    const mergeLlmCands = (e, cands, s) => {
        const g = getSugg(e.uid);
        const seen = new Set([...g.tfidf, ...g.llm].map(t => s.canon(t)));
        let added = 0;
        for (const cand of cands) {
            const { term: t, canon: c, reason } = classifyLlmCand(cand, {
                canon: s.canon, exampleCanon: s.exampleCanon, dfSubstr: s.dfSubstr, N: s.N,
                dfCeil: suggestOpts.dfCeil, excludeDates: suggestOpts.excludeDates,
                isDupe: (term, cn) => seen.has(cn) || hasKey(e, term),
            });
            if (reason) continue;
            g.llm.push(t); seen.add(c); added++;
        }
        return added;
    };
    const suggestLlm = async (e, btn) => {
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1'; btn.classList.remove('wa-on'); btn.style.opacity = '0.25';
        const s = ensureSuggest();
        let cands;
        try { cands = await llmKeyCandidates(e.content, s.avoid, suggestOpts.llmChunk); }
        catch (err) { toastr.warning(`Local model: ${String(err?.message ?? err)}`, 'Worlds Apart'); btn.dataset.busy = ''; btn.style.opacity = ''; return; }
        const added = mergeLlmCands(e, cands, s);
        btn.dataset.busy = ''; btn.style.opacity = '';
        toastr[added ? 'success' : 'info'](added ? `${wiTitleOf(e)}: +${added} from model` : 'Model returned nothing usable — click ✨ to retry.', 'Worlds Apart');
        renderEntry(e);
    };
    const acceptSugg = (e, term) => {
        if (!Array.isArray(e.key)) e.key = [];
        if (!hasKey(e, term)) e.key.push(term);
        const g = getSugg(e.uid); g.tfidf = g.tfidf.filter(t => t !== term); g.llm = g.llm.filter(t => t !== term);
        save(); renderEntry(e);
    };

    // Inline "click to edit" for one keyword (commit on Enter/blur, cancel on Escape).
    const editKeyInline = (e, oldKey, span) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'text_pole'; inp.value = oldKey;
        inp.style.cssText = 'width:8em;margin:0;font-size:0.9em;';
        let done = false;
        const commit = ok => {
            if (done) return; done = true;
            const nv = inp.value.trim();
            if (ok && nv && nv !== oldKey && Array.isArray(e.key)) {
                const idx = e.key.indexOf(oldKey);
                if (idx >= 0) { if (hasKey(e, nv)) e.key.splice(idx, 1); else e.key[idx] = nv; save(); }
            }
            renderEntry(e);
        };
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } });
        inp.addEventListener('blur', () => commit(true));
        span.replaceWith(inp); inp.focus(); inp.select();
    };

    // Right-click a keyword chip → book-wide ops on that term (case-insensitive, matching core's default
    // scan). "Delete all" / "Replace all" sweep every entry's primary keys; "Ignore" is the existing
    // per-book whitelist toggle. ponytail: primary keys only (keysecondary isn't surfaced in the Studio).
    const kwNorm = k => String(k).toLowerCase().trim();
    const kwHits = key => { const n = kwNorm(key); return Object.values(data.entries).filter(e => Array.isArray(e.key) && e.key.some(k => kwNorm(k) === n)); };
    const deleteKeyEverywhere = async key => {
        const hits = kwHits(key);
        if (hits.length > 1 && !await Popup.show.confirm(`Delete “${key}” from ${hits.length} entries?`, 'Removes the keyword everywhere it appears in this book.')) return;
        const n = kwNorm(key); let touched = 0;
        for (const e of hits) { const b = e.key.length; e.key = e.key.filter(k => kwNorm(k) !== n); if (e.key.length !== b) touched++; }
        if (touched) { save(); renderExplorer(); toastr.success(`Deleted “${key}” from ${touched} ${touched === 1 ? 'entry' : 'entries'}.`, 'Worlds Apart'); }
    };
    const replaceKeyEverywhere = async key => {
        const next = (await Popup.show.input('Replace keyword', `Replace “${key}” across all entries with:`, key))?.trim();
        if (!next || kwNorm(next) === kwNorm(key)) return;
        const n = kwNorm(key), nn = kwNorm(next); let touched = 0;
        for (const e of kwHits(key)) {
            const idx = e.key.findIndex(k => kwNorm(k) === n);
            if (idx < 0) continue;
            if (e.key.some(k => kwNorm(k) === nn)) e.key.splice(idx, 1); else e.key[idx] = next;   // dedupe if the target key already lives here
            touched++;
        }
        if (touched) { save(); renderExplorer(); toastr.success(`Replaced “${key}” → “${next}” in ${touched} ${touched === 1 ? 'entry' : 'entries'}.`, 'Worlds Apart'); }
    };
    const toggleIgnore = key => { ignoreSet.has(key) ? ignoreSet.delete(key) : ignoreSet.add(key); persistIgnore(); rerenderKeys([key]); if (trayOpen) refreshTray(); };
    // Studio context menus mount in this popup's <dialog> so they stack above the modal (module-scope
    // showCtxMenu defaults to document.body; pass the dialog here).
    const ctxMount = () => pop?.dlg ?? document.body;
    const showKwMenu = (key, x, y) => showCtxMenu([
        { label: `Delete all (${kwHits(key).length})`, fn: () => deleteKeyEverywhere(key), danger: true },
        { label: 'Replace all…', fn: () => replaceKeyEverywhere(key) },
        { label: ignoreSet.has(key) ? 'Un-ignore' : 'Ignore', fn: () => toggleIgnore(key) },
    ], x, y, ctxMount());
    const showEntryMenu = (e, x, y) => showCtxMenu([
        { label: 'Copy', fn: () => dupEntry(e) },
        { label: 'Copy to…', fn: () => copyEntryTo(e) },
        { label: 'Move to…', fn: () => moveEntryTo(e) },
        { label: 'Delete', fn: () => delEntry(e), danger: true },   // destructive → last, away from Copy
    ], x, y, ctxMount());

    // Rebuild one entry's row in place. Two collapse levels: level 1 (the whole entry) shows just the
    // title line when closed; opening it reveals the tools, keywords, and text section. Level 2 is the
    // text section's own preview↔editor toggle. Tools + body are built only when open, so a big book's
    // collapsed list stays a light, skimmable set of title lines.
    const renderEntry = e => {
        const flagged = scan ? new Map(scan.classifyEntry(e).map(r => [r.key, r])) : null;   // null = not scanned yet
        const open = entryOpen.has(e.uid);
        const row = document.createElement('div'); row.className = 'wa-entry' + (open ? ' wa-entry-open' : '');

        // --- Level 1 header: always shown (select, chevron, mode, title, meta) ---
        const h = document.createElement('div'); h.className = 'wa-entry-head';
        const selBox = document.createElement('input'); selBox.type = 'checkbox'; selBox.className = 'wa-entry-sel';
        selBox.checked = selectedEntries.has(e.uid); selBox.title = 'Select for bulk actions';
        selBox.addEventListener('click', ev => {
            ev.stopPropagation();   // don't toggle collapse
            // Shift-click sets the whole range from the anchor to here to this box's new checked state.
            if (ev.shiftKey && selAnchorUid != null && selAnchorUid !== e.uid) {
                const uids = visibleUids;   // range spans the on-screen order, which the sort controls
                const a = uids.indexOf(selAnchorUid), b = uids.indexOf(e.uid);
                if (a >= 0 && b >= 0) {
                    const want = selBox.checked;
                    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) want ? selectedEntries.add(uids[i]) : selectedEntries.delete(uids[i]);
                    syncSelCheckboxes();
                }
            }
            selAnchorUid = e.uid;
        });
        selBox.addEventListener('change', () => { selBox.checked ? selectedEntries.add(e.uid) : selectedEntries.delete(e.uid); refreshBulkBar(); });
        const chev = document.createElement('i');
        chev.className = 'fa-solid fa-chevron-right wa-chevron' + (open ? ' wa-open' : '');
        chev.title = (open ? 'Collapse entry' : 'Expand entry') + ' — shift-click for all entries';
        // Chevron owns its own click so shift-click can bulk-toggle; stopPropagation keeps the header's
        // single-entry toggle from also firing. Shift toggles every OTHER entry (this one is left as-is):
        // collapse the rest to focus on this one, or re-open them if they're already all closed.
        chev.addEventListener('click', ev => {
            ev.stopPropagation();
            if (ev.shiftKey) {
                const others = Object.values(data?.entries ?? {}).filter(x => x.uid !== e.uid);
                const anyOtherOpen = others.some(x => entryOpen.has(x.uid));
                for (const x of others) anyOtherOpen ? entryOpen.delete(x.uid) : entryOpen.add(x.uid);
                renderExplorer(); return;
            }
            open ? entryOpen.delete(e.uid) : entryOpen.add(e.uid); renderEntry(e);
        });
        const mode = document.createElement('select'); mode.className = 'wa-mode';
        const modeOpts = [['keyword', '🟢', 'Keyword'], ['constant', '🔵', 'Constant'], ['vector', '🔗', 'Vector']];
        for (const [val, glyph, word] of modeOpts) {
            const o = document.createElement('option'); o.value = val; o.textContent = glyph; o.title = word; mode.append(o);   // emoji only; word rides the tooltip
        }
        mode.value = e.constant ? 'constant' : (e.vectorized ? 'vector' : 'keyword');
        mode.title = 'Match mode: ' + (modeOpts.find(m => m[0] === mode.value)?.[2] ?? '');
        mode.addEventListener('click', ev => ev.stopPropagation());
        mode.addEventListener('change', () => { e.constant = mode.value === 'constant'; e.vectorized = mode.value === 'vector'; save(); renderEntry(e); });
        const title = document.createElement('span');
        title.className = 'wa-entry-title' + (e.disable ? ' wa-off' : '');
        title.textContent = wiTitleOf(e);
        const keyCount = Array.isArray(e.key) ? e.key.length : 0;
        title.title = keyCount ? `Keywords (${keyCount}): ${e.key.join(', ')}` : 'No keywords';
        // The title line toggles collapse, so renaming needs its own control: pencil -> inline edit of
        // the comment (stopPropagation so it doesn't expand). Blank comment falls back to keys/uid.
        const pencil = document.createElement('i'); pencil.className = 'fa-solid fa-pencil wa-tool wa-title-edit'; pencil.title = 'Rename entry';
        pencil.addEventListener('click', ev => {
            ev.stopPropagation();
            const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'text_pole'; inp.value = e.comment ?? '';
            inp.style.cssText = 'margin:0;font-size:0.95em;';
            const fit = () => { inp.size = Math.max(6, inp.value.length + 2); };   // grow to the text so ✓ stays under the mouse
            fit();
            inp.addEventListener('click', e2 => e2.stopPropagation());
            inp.addEventListener('input', fit);
            let done = false;
            const commit = ok => { if (done) return; done = true; if (ok) { const nv = inp.value.trim(); if (nv !== (e.comment ?? '')) { e.comment = nv; save(); } } renderEntry(e); };
            inp.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { e2.preventDefault(); commit(true); } else if (e2.key === 'Escape') { e2.preventDefault(); commit(false); } });
            inp.addEventListener('blur', () => commit(true));
            const okBtn = document.createElement('i'); okBtn.className = 'fa-solid fa-check wa-tool'; okBtn.title = 'Confirm rename';
            okBtn.addEventListener('mousedown', e2 => e2.preventDefault());   // keep input focus so blur doesn't fire first
            okBtn.addEventListener('click', e2 => { e2.stopPropagation(); commit(true); });
            title.replaceWith(inp); inp.after(okBtn); inp.focus(); inp.select();
        });
        const meta = document.createElement('span'); meta.className = 'wa-entry-meta';
        const prob = e.probability != null ? Number(e.probability) : 100;
        const delay = Number(e.delay) || 0;
        const cooldown = Number(e.cooldown) || 0;
        let metaTxt = `· ${keyCount ? `${keyCount} key${keyCount === 1 ? '' : 's'}` : 'no keys'} · UID ${e.uid} · order ${e.order ?? 100}`;
        if (e.useProbability !== false && prob < 100) metaTxt += ` · ${prob}%`;   // only when it actually gates
        if (delay > 0) metaTxt += ` · delay ${delay}`;
        if (cooldown > 0) metaTxt += ` · cd ${cooldown}`;
        meta.textContent = metaTxt;
        meta.title = `trigger probability ${e.useProbability !== false ? prob : 100}% · delay ${delay} · cooldown ${cooldown} (messages)`;
        h.append(selBox, chev, mode, title, pencil, meta);
        // Collapsed-line badge: how many keys the last scan flagged, so problems show without expanding.
        // Tinted by the most severe flag for glance-triage; dead-only stays neutral, since "dead" is
        // low-signal (plenty of good keys read as dead for corpus reasons).
        if (flagged && flagged.size) {
            const badge = document.createElement('span'); badge.className = 'wa-entry-badge';
            badge.textContent = `${flagged.size} flagged`;
            const RANK = { '#e06c6c': 3, '#d9b74a': 2, '#7bbf6a': 1 };   // red > yellow > green; '' (dead) = 0
            const SEV = { '#e06c6c': 'severe', '#d9b74a': 'moderate', '#7bbf6a': 'minor' };
            let worst = '';
            for (const v of flagged.values()) { const c = scan.reasonOf(v).color; if ((RANK[c] ?? 0) > (RANK[worst] ?? 0)) worst = c; }
            if (worst) { badge.style.background = worst; badge.style.color = worst === '#e06c6c' ? '#fff' : '#111'; }
            badge.title = `Keywords the last scan flagged — worst: ${SEV[worst] || 'dead'}. Expand to see which.`;
            h.append(badge);
        }
        // Whole header line toggles level 1; the mode dropdown and tool icons stopPropagation so they
        // act without collapsing the entry.
        h.addEventListener('click', () => { open ? entryOpen.delete(e.uid) : entryOpen.add(e.uid); renderEntry(e); });
        h.addEventListener('contextmenu', ev => { ev.preventDefault(); showEntryMenu(e, ev.clientX, ev.clientY); });
        row.append(h);

        if (!open) {   // level-1 collapsed: title line only
            const old = rowEls.get(e.uid);
            if (old && old.isConnected) old.replaceWith(row); rowEls.set(e.uid, row);
            return row;
        }

        // --- Tools (right-aligned on the header line) ---
        const tools = document.createElement('div'); tools.className = 'wa-entry-tools';
        const stickyOn = Number(e.sticky) > 0;
        // ⚡/✨ live with the keywords they populate (appended to the keyword paragraph below), not here.
        const boltBtn = tool('fa-bolt', false, 'TF-IDF keyword suggestions', () => suggestTfidf(e, boltBtn));
        const llmBtn = tool('fa-wand-magic-sparkles', false, 'Local-model keyword suggestions', () => suggestLlm(e, llmBtn));
        // Sticky/probability: when active, a plain click DISABLES; when off, click enables/opens the
        // editor; shift-click always opens the editor. Cooldown/delay/recursion/budget live in ⚙ Advanced.
        const stickyTool = tool('fa-thumbtack', stickyOn, `Sticky: ${stickyOn ? `on (${e.sticky})` : 'off'} — click ${stickyOn ? 'disables' : 'enables'}, shift-click sets a value`, ev => { if (ev.shiftKey) { editSticky(e); return; } e.sticky = stickyOn ? 0 : 1; save(); renderEntry(e); });
        if (stickyOn) { stickyTool.classList.add('wa-badge'); stickyTool.dataset.badge = String(e.sticky); }   // show the sticky count
        const probGates = e.useProbability !== false && prob < 100;
        // With a real gate value (<100), click toggles useProbability on/off. At 100% there's nothing to
        // toggle, so click opens the setter instead. Shift-click always opens the setter.
        const probVal = prob < 100;
        const probTool = tool('fa-percent', probGates, `Trigger probability: ${probGates ? `${prob}%` : (probVal ? 'off' : 'always')} — ${probVal ? `click ${e.useProbability === false ? 'enables' : 'disables'}` : 'click to set'}, shift-click edits`, ev => { if (ev.shiftKey || !probVal) { editProbability(e); return; } e.useProbability = (e.useProbability === false); save(); renderEntry(e); });
        if (probGates) { probTool.classList.add('wa-badge'); probTool.dataset.badge = String(prob); }   // show the % value
        // ⚙ Advanced tray toggle — tinted when the entry carries any non-default advanced setting.
        const advParts = [];
        if (cooldown > 0) advParts.push(`cooldown ${cooldown}`);
        if (delay > 0) advParts.push(`delay ${delay}`);
        if (e.excludeRecursion) advParts.push('non-recursable');
        if (e.preventRecursion) advParts.push('prevent recursion');
        if (e.delayUntilRecursion) advParts.push('delay until recursion' + (typeof e.delayUntilRecursion === 'number' && e.delayUntilRecursion > 0 ? ` ${e.delayUntilRecursion}` : ''));
        if (e.ignoreBudget) advParts.push('ignore budget');
        if (e.scanDepth != null) advParts.push(`scan depth ${e.scanDepth}`);
        const advActive = advParts.length > 0;
        // When custom, the tooltip lists the non-default values (one per line); otherwise a generic hint.
        const advTool = tool('fa-gear', advOpen.has(e.uid) || advActive, advActive ? advParts.join('\n') : 'Advanced: recursion, budget, timing', () => { advOpen.has(e.uid) ? advOpen.delete(e.uid) : advOpen.add(e.uid); renderEntry(e); });
        // Case/whole-word show the EFFECTIVE state (entry override ?? global default). When the value is
        // inherited from an active global (entry sets no override), the icon is light green instead of blue.
        // Entry value overrides global (nullish-coalesce in core); global applies only when entry is unset.
        const flagState = (v, g) => `${(v ?? g) ? 'On' : 'Off'} (${v == null ? 'inherited' : 'entry'})`;
        const effCase = e.caseSensitive ?? world_info_case_sensitive;
        const caseInherit = e.caseSensitive == null && !!world_info_case_sensitive;
        const caseTool = tool('Aa', effCase, `Case-sensitive: ${flagState(e.caseSensitive, world_info_case_sensitive)} · shift-click: inherit`, ev => { e.caseSensitive = ev.shiftKey ? null : !effCase; save(); renderEntry(e); });
        if (caseInherit) caseTool.style.color = '#8fce8f';
        const effWhole = e.matchWholeWords ?? world_info_match_whole_words;
        const wholeInherit = e.matchWholeWords == null && !!world_info_match_whole_words;
        const wholeTool = tool('[ab]', effWhole, `Match whole words: ${flagState(e.matchWholeWords, world_info_match_whole_words)} · shift-click: inherit`, ev => { e.matchWholeWords = ev.shiftKey ? null : !effWhole; save(); renderEntry(e); });
        if (wholeInherit) wholeTool.style.color = '#8fce8f';
        tools.append(
            tool('fa-power-off', !e.disable, e.disable ? 'Disabled — click to enable' : 'Active — click to disable', () => { e.disable = !e.disable; save(); renderEntry(e); }),
            caseTool,
            wholeTool,
            stickyTool,
            probTool,
            advTool,
            tool('fa-copy', false, 'Duplicate entry', () => dupEntry(e)),
            tool('fa-trash-can', false, 'Delete entry', () => delEntry(e)),
        );
        h.append(tools);

        const body = document.createElement('div'); body.className = 'wa-entry-body';

        // Keyword paragraph: every key coloured by its prune verdict, click-to-edit, ❎ to delete;
        // ➕ adds one; ⚡/✨ suggestion chips (checkbox accepts, moving the term into the keys).
        const para = document.createElement('div'); para.className = 'wa-kw-para';
        for (const key of (Array.isArray(e.key) ? e.key : [])) {
            const v = flagged?.get(key);
            // Not scanned -> neutral chip. Scanned + unflagged -> green text. Flagged -> blue chip, white
            // text (the reason rides along as annotation + tooltip; the old red text read too aggressive).
            let annot = '';
            const item = document.createElement('span'); item.className = 'wa-kw-item';   // chip + reason wrap as one
            const chip = document.createElement('span'); chip.className = 'wa-kw';
            const text = document.createElement('span'); text.className = 'wa-kw-text'; text.textContent = key;
            // Verdict drives the chip's border + a faint matching fill: green = no flag, red/yellow =
            // too-common/short by severity. Dead is the overwhelming majority of flags and often hits
            // genuinely good keys (corpus limits), so it gets no label and just a slight dim, not a colour.
            const isDead = v && v.flag === 'dead';
            const isIgnored = ignoreSet.has(key);
            // Whitelisted keys are skipped by the scanner (never flagged), so mark them purple to show
            // they're deliberately spared; otherwise verdict drives the colour (green = no flag, red/yellow
            // = too-common/short, dead = slight dim, no colour).
            if (isIgnored) { annot = 'ignored'; chip.classList.add('wa-kw-ignored'); }
            else if (v && !isDead) { const rc = scan.reasonOf(v); annot = rc.text; if (rc.color) { chip.style.borderColor = rc.color; chip.style.background = `color-mix(in srgb, ${rc.color} 18%, transparent)`; } }
            else if (isDead) chip.classList.add('wa-kw-dead');
            else if (flagged) chip.style.borderColor = WA_GREEN;
            text.title = isIgnored ? `${key} — whitelisted (click to edit; shift-click ✕ to un-ignore)` : (v ? `${key} — ${isDead ? 'no entry-text match' : annot} (click to edit)` : `${key} (click to edit)`);
            text.addEventListener('click', () => editKeyInline(e, key, text));
            chip.append(text);   // term only inside the chip
            const del = document.createElement('i'); del.className = 'fa-solid fa-xmark wa-kw-del'; del.title = 'Delete keyword — shift-click to toggle ignore (whitelist)';
            del.addEventListener('click', ev => {
                if (ev.shiftKey) {   // whitelist toggle (mirrors the pruner's ban icon); tray lists/clears these
                    ignoreSet.has(key) ? ignoreSet.delete(key) : ignoreSet.add(key);
                    persistIgnore(); rerenderKeys([key]);   // recolour every entry using this key; no rescan
                    if (trayOpen) refreshTray();            // keep the open drawer's whitelist column in sync
                    return;
                }
                e.key.splice(e.key.indexOf(key), 1); save(); renderEntry(e);
            });
            chip.append(del);
            chip.addEventListener('contextmenu', ev => { ev.preventDefault(); showKwMenu(key, ev.clientX, ev.clientY); });
            item.append(chip);
            if (annot) { const r = document.createElement('span'); r.className = 'wa-kw-reason'; r.textContent = `(${annot})`; item.append(r); }   // reason outside the chip
            para.append(item);
        }
        const g = sugg.get(e.uid);
        if (g) for (const [kind, terms] of [['tfidf', g.tfidf], ['llm', g.llm]]) for (const term of terms) {
            if (hasKey(e, term)) continue;
            const chip = document.createElement('label'); chip.className = 'wa-sugg';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.margin = '0';
            cb.addEventListener('change', () => { if (cb.checked) acceptSugg(e, term); });
            const t = document.createElement('span'); t.textContent = (kind === 'llm' ? '✨ ' : '⚡ ') + term;
            chip.append(cb, t); para.append(chip);
        }
        const add = document.createElement('i'); add.className = 'fa-solid fa-plus wa-tool'; add.title = 'Add a keyword';
        add.addEventListener('click', () => {
            const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'text_pole'; inp.placeholder = 'keyword'; inp.style.cssText = 'width:8em;margin:0;font-size:0.9em;';
            let done = false;
            const commit = ok => { if (done) return; done = true; const nv = inp.value.trim(); if (ok && nv && !hasKey(e, nv)) { if (!Array.isArray(e.key)) e.key = []; e.key.push(nv); save(); } renderEntry(e); };
            inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } });
            inp.addEventListener('blur', () => commit(true));
            add.replaceWith(inp); inp.focus();
        });
        para.append(boltBtn, llmBtn, add);   // suggestion triggers sit just before the add-keyword +

        // --- Level 2: text section with its own chevron (preview line ↔ editor) ---
        const textSec = document.createElement('div'); textSec.className = 'wa-text-sec';
        const thead = document.createElement('div'); thead.className = 'wa-text-head';
        const tchev = document.createElement('i');
        tchev.className = 'fa-solid fa-chevron-right wa-chevron' + (expanded.has(e.uid) ? ' wa-open' : '');
        const preview = document.createElement('span'); preview.className = 'wa-entry-preview'; preview.textContent = firstLine(e);
        thead.append(tchev, preview);
        // Editable entry text — commits on blur (click-off). Colours reflect the last scan, not the live
        // edit; rescan to re-flag. Editor wrapper holds the textarea + a popout that lifts the 8-row cap.
        const fullWrap = document.createElement('div'); fullWrap.className = 'wa-full-wrap';
        const full = document.createElement('textarea'); full.className = 'wa-entry-full' + (tall.has(e.uid) ? ' wa-tall' : ''); full.value = String(e.content ?? '');
        const popBtn = document.createElement('i'); popBtn.className = 'wa-full-pop fa-solid ' + (tall.has(e.uid) ? 'fa-compress' : 'fa-expand');
        popBtn.title = tall.has(e.uid) ? 'Collapse editor to 8 rows' : 'Pop out editor to full height';
        // Size to the RENDERED text height (wrapped prose has few newlines, so counting \n undersizes it).
        // Height = scrollHeight; CSS max-height caps it (8 rows, or full height when popped out) and
        // scrolls beyond — no line-height parsing. scrollHeight is only valid once shown, so size on expand.
        // scrollHeight is only meaningful once the textarea is in the document; sizing it while detached
        // yields 0 and collapses the editor (the keyword paragraph then paints up over it). Skip until mounted.
        const autosize = () => { if (!full.isConnected) return; full.style.height = 'auto'; full.style.height = (full.scrollHeight + 2) + 'px'; };
        popBtn.addEventListener('click', () => {
            const isTall = full.classList.toggle('wa-tall');
            isTall ? tall.add(e.uid) : tall.delete(e.uid);
            popBtn.className = 'wa-full-pop fa-solid ' + (isTall ? 'fa-compress' : 'fa-expand');
            popBtn.title = isTall ? 'Collapse editor to 8 rows' : 'Pop out editor to full height';
            autosize();
        });
        full.addEventListener('input', autosize);
        full.addEventListener('blur', () => { if (full.value !== String(e.content ?? '')) { e.content = full.value; save(); preview.textContent = firstLine(e); } });
        fullWrap.append(popBtn, full);
        const syncText = () => { const t = expanded.has(e.uid); tchev.classList.toggle('wa-open', t); preview.style.display = t ? 'none' : ''; fullWrap.style.display = t ? '' : 'none'; if (t) autosize(); };
        thead.addEventListener('click', () => { expanded.has(e.uid) ? expanded.delete(e.uid) : expanded.add(e.uid); syncText(); });
        textSec.append(thead, fullWrap);
        body.append(textSec, para);   // entry text first, then keywords (reads more naturally)

        // ⚙ Advanced tray: core WI fields we don't surface as icons — inline like the Tool Settings tray.
        // Edits commit on change (number inputs on blur), then re-render the row; the tray stays open.
        if (advOpen.has(e.uid)) {
            const adv = document.createElement('div'); adv.className = 'wa-adv';
            const col = (heading, ...rows) => { const c = document.createElement('div'); c.className = 'wa-adv-col'; const hd = document.createElement('div'); hd.className = 'wa-adv-sec'; hd.textContent = heading; c.append(hd, ...rows); return c; };
            const chk = (label, get, set) => {
                const l = document.createElement('label'); l.className = 'checkbox_label wa-adv-row';
                const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = get();
                cb.addEventListener('change', () => { set(cb.checked); save(); renderEntry(e); });
                const s = document.createElement('span'); s.textContent = label; l.append(cb, s); return l;
            };
            const numRow = (label, get, set, placeholder) => {
                const l = document.createElement('label'); l.className = 'wa-adv-row';
                const s = document.createElement('span'); s.textContent = label;
                const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.className = 'text_pole'; inp.value = get(); if (placeholder) inp.placeholder = placeholder;
                inp.addEventListener('change', () => { set(inp.value); save(); renderEntry(e); });
                l.append(s, inp); return l;
            };
            const toMsg = v => Math.max(0, Math.floor(Number(v) || 0)) || null;   // 0/blank -> null (off), like core
            const clampPct = v => Math.min(100, Math.max(0, Math.floor(Number(v) || 0)));
            const recWarn = () => { const w = document.createElement('div'); w.className = 'wa-adv-warn'; w.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Recursion is off globally — these have no effect.'; return w; };
            // Tri-state select (Inherit / On / Off) for the nullable match flags — the tray equivalent of the
            // icon's click (On/Off) + shift-click (Inherit). Inherit resolves to the global default.
            const triSel = (label, get, set, globalOn) => {
                const l = document.createElement('label'); l.className = 'wa-adv-row';
                const s = document.createElement('span'); s.textContent = label; s.style.whiteSpace = 'nowrap';
                const sel = document.createElement('select'); sel.className = 'text_pole'; sel.style.cssText = 'width:auto;margin:0 0 0 auto;padding:2px 4px;';   // fit the option text, not text_pole's full width
                for (const [val, txt] of [['', `Inherit (${globalOn ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']]) sel.append(new Option(txt, val));
                const cur = get(); sel.value = cur === true ? 'on' : cur === false ? 'off' : '';
                sel.addEventListener('change', () => { set(sel.value === '' ? null : sel.value === 'on'); save(); renderEntry(e); });
                l.append(s, sel); return l;
            };
            const durLevel = (typeof e.delayUntilRecursion === 'number' && e.delayUntilRecursion > 0) ? e.delayUntilRecursion : '';
            adv.append(
                // Sticky + probability also have quick icons; the fields here let you set every number at once.
                col('Timed',
                    numRow('Sticky', () => (Number(e.sticky) > 0 ? Number(e.sticky) : ''), v => e.sticky = toMsg(v), '0'),
                    numRow('Cooldown', () => (cooldown || ''), v => e.cooldown = toMsg(v), '0'),
                    numRow('Delay', () => (delay || ''), v => e.delay = toMsg(v), '0'),
                ),
                col('Trigger',
                    numRow('Probability %', () => (e.probability != null ? Number(e.probability) : 100), v => e.probability = clampPct(v), '100'),
                    chk('Use probability', () => e.useProbability !== false, v => e.useProbability = v),
                ),
                col('Matching',
                    triSel('Case-sensitive', () => e.caseSensitive, v => e.caseSensitive = v, world_info_case_sensitive),
                    triSel('Whole words', () => e.matchWholeWords, v => e.matchWholeWords = v, world_info_match_whole_words),
                ),
                col('Recursion',
                    chk('Non-recursable', () => !!e.excludeRecursion, v => e.excludeRecursion = v),
                    chk('Prevent further recursion', () => !!e.preventRecursion, v => e.preventRecursion = v),
                    chk('Delay until recursion', () => !!e.delayUntilRecursion, v => e.delayUntilRecursion = v ? (durLevel || true) : false),
                    numRow('↳ level', () => durLevel, v => { const n = Math.max(0, Math.floor(Number(v) || 0)); e.delayUntilRecursion = n > 0 ? n : (e.delayUntilRecursion ? true : false); }, 'any'),
                    // These do nothing while global recursion is off — warn instead of silently misleading.
                    ...(document.querySelector('#world_info_recursive')?.checked ? [] : [recWarn()]),
                ),
                col('Budget / scan',
                    chk('Ignore budget', () => !!e.ignoreBudget, v => e.ignoreBudget = v),
                    // 0 (or blank) = global — a literal scan depth of 0 is incoherent (disable the entry instead).
                    numRow('Scan depth', () => (e.scanDepth ? e.scanDepth : ''), v => { const n = Math.floor(Number(v) || 0); e.scanDepth = n > 0 ? n : null; }, 'global'),
                ),
            );
            body.prepend(adv);   // sit directly under the header bar, above the entry text and keywords
        }
        row.append(body);

        const old = rowEls.get(e.uid);
        if (old && old.isConnected) old.replaceWith(row); rowEls.set(e.uid, row);
        syncText();   // after mount, so an expanded editor's autosize sees a real scrollHeight
        return row;
    };

    const dupEntry = e => {
        const ne = duplicateWorldInfoEntry(data, e.uid);
        if (!ne) return;
        save(); suggest = null; if (scan) rebuildScan(); renderExplorer();   // corpus changed -> ranker/scan stale
        // The copy takes the next free uid, which JS sorts into the list wherever it falls (often
        // off-screen), so scroll to it and flash — otherwise the duplicate looks like a no-op.
        const row = rowEls.get(ne.uid);
        if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.add('wa-flash'); setTimeout(() => row.classList.remove('wa-flash'), 1200); }
        toastr.success('Entry duplicated.', 'Worlds Apart');
    };
    const delEntry = async e => {
        if (!await deleteWorldInfoEntry(data, e.uid)) return;   // shows its own confirm
        save(); suggest = null; if (scan) rebuildScan(); sugg.delete(e.uid); rowEls.delete(e.uid); renderExplorer();
    };
    // Pick a target lorebook (any book but the open one) via a select in a confirm popup. null = cancelled.
    const pickBook = async prompt => {
        const others = [...world_names].filter(n => n !== selected).sort((a, b) => a.localeCompare(b));
        if (!others.length) { toastr.info('No other lorebook to target.', 'Worlds Apart'); return null; }
        const wrap = document.createElement('div');
        const lbl = document.createElement('div'); lbl.textContent = prompt; lbl.style.marginBottom = '6px';
        const sel = document.createElement('select'); sel.className = 'text_pole'; sel.style.width = '100%';
        for (const n of others) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.append(o); }
        wrap.append(lbl, sel);
        const p = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'OK', cancelButton: 'Cancel' });
        return (await p.show()) === POPUP_RESULT.AFFIRMATIVE ? sel.value : null;
    };
    // Copy/move a list of entries to another book. One load + one save of the target (not core's
    // per-entry moveWorldInfoEntry, which reloads/saves both books and toasts on every entry). Serves the
    // per-entry context menu (single) and the bulk bar (selection) alike.
    const entriesToBook = async (list, deleteOriginal) => {
        if (!list.length) return;
        const what = list.length === 1 ? `“${wiTitleOf(list[0])}”` : `${list.length} entries`;
        const target = await pickBook(`${deleteOriginal ? 'Move' : 'Copy'} ${what} to:`);
        if (!target) return;
        const tgt = await loadWorldInfo(target);
        if (!tgt?.entries) { toastr.warning(`Couldn't load “${target}”.`, 'Worlds Apart'); return; }
        let maxDisplay = Object.values(tgt.entries).reduce((m, x) => Math.max(m, x.displayIndex ?? -1), -1);
        const copied = [];
        for (const e of list) {
            const uid = getFreeWorldEntryUid(tgt); if (uid == null) break;   // book full (1M entries) — stop, keep what copied
            const clone = structuredClone(e); clone.uid = uid; clone.displayIndex = ++maxDisplay;
            tgt.entries[uid] = clone; copied.push(e);
        }
        await saveWorldInfo(target, tgt, true);
        reloadEditor(target);   // refresh the core WI editor if that book happens to be open there
        if (deleteOriginal) {
            // Only drop what actually landed in the target. deleteWIOriginalDataValue keeps embedded-book
            // originalData in sync (as core's move does); the entries stay in the Studio's `data` until here.
            for (const e of copied) { deleteWIOriginalDataValue(data, String(e.uid)); delete data.entries[e.uid]; sugg.delete(e.uid); rowEls.delete(e.uid); selectedEntries.delete(e.uid); }
            save(); suggest = null; if (scan) rebuildScan(); renderExplorer();
        }
        toastr.success(`${deleteOriginal ? 'Moved' : 'Copied'} ${copied.length} to “${target}”.`, 'Worlds Apart');
    };
    const copyEntryTo = e => entriesToBook([e], false);
    const moveEntryTo = e => entriesToBook([e], true);

    // --- Book-level tools (explorer header) -----------------------------------------------------
    // Free-text search over the scoped fields; empty query (or no scope ticked) is inert.
    const matchSearch = e => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        const fields = [];
        if (searchScope.title) fields.push(String(wiTitleOf(e)));
        if (searchScope.entry) fields.push(String(e.content ?? ''));
        if (searchScope.keywords) fields.push((Array.isArray(e.key) ? e.key : []).join(' '));
        return !fields.length || fields.some(f => f.toLowerCase().includes(q));
    };
    const filterMatch = e => {
        if (!matchSearch(e)) return false;
        switch (entryFilter) {
            case 'keyword': return !e.constant && !e.vectorized;
            case 'constant': return !!e.constant;
            case 'vector': return !!e.vectorized;
            case 'enabled': return !e.disable;
            case 'disabled': return !!e.disable;
            case 'flagged': return !!scan && scan.classifyEntry(e).length > 0;
            default: return true;
        }
    };
    // Explorer display order: base sort (module SORT_FNS), then the tiered modifier buckets by tierRank
    // (base order preserved within each bucket) and flattens. Sort vocabulary + tier logic are shared
    // module-scope (see SORT_FNS / tierRank); this just applies them to the Studio's own state.
    const sortEntries = list => {
        // 'insert' mirrors the durable prompt insertion order (base sort + tiered) from settings; relevance
        // keys have no rest-state score, so they degrade to order-asc for display.
        const insert = entrySort === 'insert';
        const baseKey = insert ? normPresentation(settings().presentationOrder) : entrySort;
        const base = SORT_FNS[baseKey] ?? SORT_FNS['order-asc'];
        const tiered = insert ? !!settings().presentationTiered : tieredMode;
        const sorted = [...list].sort(base);
        if (!tiered) return sorted;
        const buckets = [];
        for (const e of sorted) (buckets[tierRank(e, tierCfg)] ??= []).push(e);
        return buckets.flat();   // sparse holes (empty ranks) are skipped by flat()
    };
    // Copy an arbitrary book (open or not) to a free "X copy[ n]" name. Returns the new name, or null.
    const copyBookByName = async srcName => {
        const src = (srcName === selected) ? data : await loadWorldInfo(srcName);
        if (!src) return null;
        const base = `${srcName} copy`; let name = base, i = 2;
        while (world_names.includes(name)) name = `${base} ${i++}`;
        await saveWorldInfo(name, structuredClone(src), true);
        return name;
    };
    const dupBook = async () => {
        const name = await copyBookByName(selected);
        if (!name) return;
        await updateWorldInfoList();
        renderBooks();
        toastr.success(`Duplicated to “${name}”.`, 'Worlds Apart');
        openBook(name);
    };
    const bulkCopyBooks = async () => {
        const names = [...selectedBooks]; if (!names.length) return;
        for (const n of names) await copyBookByName(n);
        await updateWorldInfoList();
        selectedBooks.clear(); bookAnchor = null;
        renderBooks();
        toastr.success(`Duplicated ${names.length} ${names.length === 1 ? 'lorebook' : 'lorebooks'}.`, 'Worlds Apart');
    };
    // Delete one or more books, keeping full snapshots for the nav undo bar. Switches the open book away
    // if it was among them. `deleteWorldInfo` handles world_names + binding cleanup per book.
    const deleteBooks = async names => {
        const wasOpen = names.includes(selected);
        const books = [];
        for (const n of names) {
            const d = (n === selected) ? data : await loadWorldInfo(n);
            if (d) books.push({ name: n, data: structuredClone(d) });
            await deleteWorldInfo(n);
        }
        if (wasOpen) {
            selected = [...world_names].sort((a, b) => a.localeCompare(b)).find(n => !names.includes(n)) ?? null;
            data = null; scan = null; suggest = null; entryOpen.clear(); expanded.clear(); tall.clear(); advOpen.clear(); sugg.clear(); selectedEntries.clear();
        }
        dirty = false;
        if (undoTimer) clearTimeout(undoTimer);
        pendingUndo = { books };
        undoTimer = setTimeout(() => { pendingUndo = null; undoTimer = null; renderBooks(); }, 30000);
        renderBooks();
        if (wasOpen) { if (selected) openBook(selected); else renderExplorer(); }
    };
    const delBook = async () => {
        if (!await Popup.show.confirm(`Delete lorebook “${selected}”?`, 'This deletes the entire book and every entry in it.')) return;
        await deleteBooks([selected]);
    };
    const bulkDeleteBooks = async () => {
        const names = [...selectedBooks]; if (!names.length) return;
        const list = `<div style="max-height:40vh;overflow-y:auto;text-align:left;margin:6px 0;">${names.map(escapeHtml).join('<br>')}</div>`;
        if (!await Popup.show.confirm(`Delete ${names.length} ${names.length === 1 ? 'lorebook' : 'lorebooks'}?`, `${list}This deletes ${names.length === 1 ? 'the entire book' : 'these books entirely'}.`)) return;
        selectedBooks.clear(); bookAnchor = null; bookBulkMode = false;   // done selecting — drop back to normal nav
        await deleteBooks(names);
    };
    const clearUndo = () => { pendingUndo = null; if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; } };
    const restoreBook = async () => {
        const p = pendingUndo; if (!p) return;
        clearUndo();
        let restored = 0; const skipped = [];
        for (const b of p.books) {
            if (world_names.some(n => n.toLowerCase() === b.name.toLowerCase())) { skipped.push(b.name); continue; }
            await saveWorldInfo(b.name, b.data, true); restored++;
        }
        await updateWorldInfoList();
        if (restored && !selected) selected = p.books.find(b => world_names.includes(b.name))?.name ?? null;
        renderBooks();
        if (selected) openBook(selected); else renderExplorer();
        if (skipped.length) toastr.warning(`Skipped ${skipped.length} (name already exists again): ${skipped.join(', ')}`, 'Worlds Apart');
        if (restored) toastr.success(`Restored ${restored} ${restored === 1 ? 'lorebook' : 'lorebooks'}.`, 'Worlds Apart');
    };
    // Rename a book (open or not), then re-point the bindings we can reach. ST's own renameWorldInfo (not
    // exported) also fixes the active character's *primary* lorebook via the character card; we can't from
    // here, so that one case is called out in the toast. ponytail: reachable-binding retarget, card primary excluded.
    const renameBook = async (srcName = selected) => {
        const oldName = srcName;
        const raw = await Popup.show.input('Rename lorebook', 'New name:', oldName);
        const newName = (raw ?? '').trim();
        if (!newName || newName === oldName) return;
        if (world_names.some(n => n.toLowerCase() === newName.toLowerCase())) { toastr.warning('A lorebook with that name already exists.', 'Worlds Apart'); return; }
        const bookData = (oldName === selected) ? data : await loadWorldInfo(oldName);
        if (!bookData) { toastr.warning(`Couldn't load “${oldName}”.`, 'Worlds Apart'); return; }
        const ctx = getContext();
        const wasSelected = selected_world_info.includes(oldName);
        const wasPersona = power_user.persona_description_lorebook === oldName;
        const wasChat = ctx.chatMetadata?.[METADATA_KEY] === oldName;
        await saveWorldInfo(newName, bookData, true);
        await deleteWorldInfo(oldName);   // clears old's global-select / persona / active-char bindings
        try {
            if (wasSelected && !selected_world_info.includes(newName)) selected_world_info.push(newName);
            for (const cl of (world_info.charLore ?? [])) { const i = cl.extraBooks?.indexOf(oldName) ?? -1; if (i >= 0) cl.extraBooks[i] = newName; }
            if (wasPersona) power_user.persona_description_lorebook = newName;
            ctx.saveSettingsDebounced?.();
            if (wasChat && ctx.chatMetadata) { ctx.chatMetadata[METADATA_KEY] = newName; ctx.saveMetadata?.(); }
        } catch (err) { console.error('[WA] rename retarget', err); }
        runState.attachedWorlds = new Set([...runState.attachedWorlds].map(w => w === oldName ? newName : w));
        if (selectedBooks.delete(oldName)) selectedBooks.add(newName);
        const byBook = settings().studioSortByBook;   // carry the saved per-book sort view across the rename
        if (byBook?.[oldName]) { byBook[newName] = byBook[oldName]; delete byBook[oldName]; saveSettingsDebounced(); }
        dirty = false;
        if (oldName === selected) { renderBooks(); openBook(newName); }
        else { renderBooks(); }
        toastr.success(`Renamed to “${newName}”. If a character used it as its primary lorebook, re-select it on that character.`, 'Worlds Apart');
    };
    // Batch TF-IDF: build the ranker once, drop each entry's suggestions into its ⚡ chips, open those
    // entries so they're reviewable. Yields a frame first so the button can dim before the ~1s build.
    const suggestAll = async btn => {
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1'; btn.style.opacity = '0.5'; await new Promise(r => setTimeout(r, 0));
        let s; try { s = ensureSuggest(); } catch { btn.dataset.busy = ''; btn.style.opacity = ''; toastr.warning('Couldn\'t build suggestions.', 'Worlds Apart'); return; }
        let n = 0;
        for (const pe of s.perEntry) {
            const e = data.entries[pe.entry.uid]; if (!e) continue;
            const fresh = (pe.newRows ?? []).map(r => r.display).filter(t => !hasKey(e, t));
            if (!fresh.length) continue;
            const g = getSugg(e.uid);
            const seen = new Set([...g.tfidf, ...g.llm].map(t => s.canon(t)));
            for (const t of fresh) { const c = s.canon(t); if (!seen.has(c)) { g.tfidf.push(t); seen.add(c); } }
            entryOpen.add(e.uid); n++;
        }
        btn.dataset.busy = ''; btn.style.opacity = '';
        renderExplorer();
        toastr[n ? 'success' : 'info'](n ? `Suggestions added to ${n} ${n === 1 ? 'entry' : 'entries'} — review the ⚡ chips.` : 'No TF-IDF suggestions to add.', 'Worlds Apart');
    };

    // Local-model suggest-all: one ✨ pass per visible non-empty entry, sequential (a small model serves
    // one request at a time), with per-entry progress in the button label. Long entries are chunked.
    const suggestAllLlm = async btn => {
        if (btn.dataset.busy) return;
        const label = btn.innerHTML;
        btn.dataset.busy = '1'; btn.style.opacity = '0.5';
        let s; try { s = ensureSuggest(); } catch { btn.dataset.busy = ''; btn.style.opacity = ''; toastr.warning('Couldn\'t build suggestions.', 'Worlds Apart'); return; }
        const targets = Object.values(data?.entries ?? {}).filter(filterMatch).filter(e => String(e.content ?? '').trim());
        let n = 0, i = 0;
        for (const e of targets) {
            btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${++i}/${targets.length}…`;
            let cands; try { cands = await llmKeyCandidates(e.content, s.avoid, suggestOpts.llmChunk); }
            catch (err) { toastr.warning(`Local model: ${String(err?.message ?? err)}`, 'Worlds Apart'); break; }
            if (mergeLlmCands(e, cands, s)) { n++; entryOpen.add(e.uid); }
        }
        btn.dataset.busy = ''; btn.style.opacity = ''; btn.innerHTML = label;
        renderExplorer();
        toastr[n ? 'success' : 'info'](n ? `Model suggestions added to ${n} ${n === 1 ? 'entry' : 'entries'} — review the ✨ chips.` : 'Model returned nothing usable.', 'Worlds Apart');
    };

    const renderExplorer = () => {
        explorer.innerHTML = ''; rowEls.clear();
        if (!selected) { explorer.innerHTML = '<div style="opacity:0.6;padding:8px;">Select a lorebook on the left.</div>'; return; }
        const total = Object.values(data?.entries ?? {});
        const entries = total.filter(filterMatch);
        const head = document.createElement('div');
        head.className = 'wa-studio-exphead';
        head.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:6px;';
        const label = document.createElement('div');
        const nameB = document.createElement('b'); nameB.textContent = selected;
        const countSpan = document.createElement('span'); countSpan.style.cssText = 'opacity:0.6;margin-left:5px;';
        label.append(nameB, countSpan);
        // Book-level tools: rename / duplicate / delete the whole lorebook.
        const bookTool = (cls, title, onClick, extra = '') => { const i = document.createElement('i'); i.className = `fa-solid ${cls} wa-book-tool ${extra}`; i.title = title; i.addEventListener('click', onClick); return i; };
        const bookTools = document.createElement('span'); bookTools.className = 'wa-book-tools';
        bookTools.append(
            bookTool('fa-pen', 'Rename this lorebook', () => renameBook()),
            bookTool('fa-copy', 'Duplicate this lorebook', () => dupBook()),
            bookTool('fa-trash-can', 'Delete this lorebook', () => delBook(), 'wa-book-tool-danger'),
        );
        label.append(bookTools);
        // Entry-type filter — a compact fa-filter dropdown (single-select). Custom, not a native <select>,
        // so options can carry FA icons (crosshairs, power) a <select> can't render.
        const FILTER_OPTS = [
            ['all', 'fa-filter', 'All'],
            ['keyword', '🟢', 'Keyword'],
            ['constant', '🔵', 'Constant'],
            ['vector', '🔗', 'Vector'],
            ['enabled', 'fa-power-off', 'Enabled'],
            ['disabled', '🚫', 'Disabled'],
            ['flagged', 'fa-crosshairs', 'Flagged'],
        ];
        const iconEl = spec => { if (spec.startsWith('fa-')) { const i = document.createElement('i'); i.className = 'fa-solid ' + spec; return i; } const s = document.createElement('span'); s.textContent = spec; return s; };
        const filterWrap = document.createElement('span'); filterWrap.style.cssText = 'position:relative;display:inline-flex;';
        const filterBtn = document.createElement('button'); filterBtn.type = 'button'; filterBtn.className = 'menu_button wa-filter';
        filterBtn.title = 'Show only entries of a type'; filterBtn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;width:auto;white-space:nowrap;';
        const curFilter = FILTER_OPTS.find(o => o[0] === entryFilter) ?? FILTER_OPTS[0];
        const curLbl = document.createElement('span'); curLbl.textContent = curFilter[2];
        filterBtn.append(iconEl('fa-filter'), curLbl);
        const filterMenu = document.createElement('div');
        filterMenu.style.cssText = 'position:absolute;top:100%;left:0;z-index:5;display:none;flex-direction:column;gap:1px;margin-top:2px;padding:4px;border-radius:5px;min-width:9em;'
            + 'background:var(--SmartThemeBlurTintColor, var(--black70a, rgba(20,20,20,0.97)));border:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));';
        for (const [val, spec, lbl] of FILTER_OPTS) {
            const item = document.createElement('button'); item.type = 'button';
            item.style.cssText = 'display:flex;align-items:center;gap:7px;width:100%;padding:4px 8px;border:none;border-radius:4px;background:' + (val === entryFilter ? 'var(--white20a, rgba(255,255,255,0.1))' : 'transparent') + ';color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer;';
            if (val === entryFilter) item.style.fontWeight = 'bold';
            const t = document.createElement('span'); t.textContent = lbl; item.append(iconEl(spec), t);
            item.addEventListener('mouseenter', () => { if (val !== entryFilter) item.style.background = 'var(--white20a, rgba(255,255,255,0.1))'; });
            item.addEventListener('mouseleave', () => { if (val !== entryFilter) item.style.background = 'transparent'; });
            item.addEventListener('click', () => { entryFilter = val; renderExplorer(); });
            filterMenu.append(item);
        }
        filterBtn.addEventListener('click', () => { filterMenu.style.display = filterMenu.style.display === 'none' ? 'flex' : 'none'; });
        filterWrap.addEventListener('focusout', ev => { if (!filterWrap.contains(ev.relatedTarget)) filterMenu.style.display = 'none'; });
        filterWrap.append(filterBtn, filterMenu);
        // Sort control — shared widget (module makeSortControl). The base sort + tiered toggle are ephemeral
        // view state (not persisted); only the tier config is durable (shared with the prompt builder).
        // "Insert Order" (leadItems) mirrors the durable insertion settings; its tiered state reads from
        // there, and toggling tiered while in it forks to an explicit ephemeral sort (base = the resolved
        // insertion base, clamped to a valid key).
        const sortBtn = makeSortControl({
            getSort: () => entrySort, setSort: k => { entrySort = k; persistSortView(); },
            getTiered: () => entrySort === 'insert' ? !!settings().presentationTiered : tieredMode,
            setTiered: on => { if (entrySort === 'insert') { const k = normPresentation(settings().presentationOrder); entrySort = SORT_FNS[k] ? k : 'order-asc'; } tieredMode = on; persistSortView(); },
            getTierCfg: () => tierCfg, setTierCfg: cfg => { tierCfg = cfg; settings().tierCfg = cfg; saveSettingsDebounced(); },
            leadItems: [{ label: 'Insert Order', key: 'insert' }],
            onChange: renderExplorer, mount: ctxMount,
        });
        const scanBtn = document.createElement('button');
        scanBtn.type = 'button'; scanBtn.className = 'menu_button';
        scanBtn.innerHTML = `<i class="fa-solid fa-stethoscope"></i> ${scan ? 'Re-audit' : 'Keyword audit'}`;
        scanBtn.title = 'Flag dead / frequent / short keywords and colour them by verdict — tune under Tool Settings';
        scanBtn.addEventListener('click', () => { rebuildScan(); renderExplorer(); });
        const allOpen = entries.length > 0 && entries.every(x => entryOpen.has(x.uid));
        // Master disclosure: an icon-only chevron left of the title, echoing the per-entry chevrons.
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button'; expandBtn.className = 'menu_button';
        expandBtn.style.cssText = 'width:auto;padding:3px 7px;flex-shrink:0;';
        expandBtn.innerHTML = `<i class="fa-solid ${allOpen ? 'fa-square-caret-up' : 'fa-square-caret-down'}"></i>`;
        expandBtn.title = `${allOpen ? 'Collapse' : 'Expand'} all entries — shift-click expands only entries with flagged keywords`;
        expandBtn.addEventListener('click', ev => {
            if (ev.shiftKey) {   // expand only flagged entries (scan first if needed), collapse the rest
                if (!scan) rebuildScan();
                entryOpen.clear();
                for (const x of entries) if (scan.classifyEntry(x).length) entryOpen.add(x.uid);
                renderExplorer(); return;
            }
            if (allOpen) entryOpen.clear(); else for (const x of entries) entryOpen.add(x.uid);
            renderExplorer();
        });
        const suggestAllBtn = document.createElement('button');
        suggestAllBtn.type = 'button'; suggestAllBtn.className = 'menu_button';
        suggestAllBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Suggest all';
        suggestAllBtn.title = 'Add TF-IDF keyword suggestions to every entry (review the ⚡ chips before accepting)';
        suggestAllBtn.addEventListener('click', () => suggestAll(suggestAllBtn));
        const suggestAllLlmBtn = document.createElement('button');
        suggestAllLlmBtn.type = 'button'; suggestAllLlmBtn.className = 'menu_button';
        suggestAllLlmBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Suggest all (LLM)';
        suggestAllLlmBtn.title = 'Run local-model keyword suggestions on every visible entry (long entries are chunked; review the ✨ chips before accepting)';
        suggestAllLlmBtn.addEventListener('click', () => suggestAllLlm(suggestAllLlmBtn));
        // Search box + scope checkboxes. Typing re-filters the list in place (applyFilter) rather than
        // re-rendering the header, so the input keeps focus and the caret between keystrokes.
        const searchWrap = document.createElement('span'); searchWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;';
        const search = document.createElement('input'); search.type = 'search'; search.className = 'text_pole wa-filter';
        search.placeholder = 'Search…'; search.value = searchQuery;
        search.style.cssText = 'width:11em;border-top-left-radius:0;border-bottom-left-radius:0;';
        let searchTimer = null;   // debounce so a big book doesn't re-filter on every keystroke
        search.addEventListener('input', () => { searchQuery = search.value; clearTimeout(searchTimer); searchTimer = setTimeout(applyFilter, 180); });
        // Scope picker: a multi-select dropdown hung off the search box — which fields the query looks in.
        const scopeBtn = document.createElement('button'); scopeBtn.type = 'button'; scopeBtn.className = 'menu_button wa-filter';
        scopeBtn.style.cssText = 'width:auto;display:inline-flex;align-items:center;justify-content:center;margin:0 -1px 0 0;padding:3px 8px;border-top-right-radius:0;border-bottom-right-radius:0;';
        scopeBtn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
        const menu = document.createElement('div');
        menu.style.cssText = 'position:absolute;top:100%;left:0;z-index:5;display:none;flex-direction:column;gap:2px;margin-top:2px;padding:6px 8px;border-radius:5px;'
            + 'background:var(--SmartThemeBlurTintColor, var(--black70a, rgba(20,20,20,0.97)));border:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));';
        const SCOPES = [['title', 'Title'], ['entry', 'Entry'], ['keywords', 'Keywords']];
        const syncScopeBtn = () => { const on = SCOPES.filter(([k]) => searchScope[k]).map(([, l]) => l); scopeBtn.title = `Search in: ${on.join(', ') || 'nothing selected'}`; };
        for (const [key, lbl] of SCOPES) {
            const l = document.createElement('label'); l.className = 'checkbox_label'; l.style.cssText = 'font-size:0.85em;white-space:nowrap;';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = searchScope[key];
            cb.addEventListener('change', () => { searchScope[key] = cb.checked; syncScopeBtn(); applyFilter(); });
            const sp = document.createElement('span'); sp.textContent = lbl; l.append(cb, sp); menu.append(l);
        }
        syncScopeBtn();
        scopeBtn.addEventListener('click', () => { menu.style.display = menu.style.display === 'none' ? 'flex' : 'none'; });
        // Close when focus leaves the group — no document-level listener to leak across re-renders.
        searchWrap.addEventListener('focusout', ev => { if (!searchWrap.contains(ev.relatedTarget)) menu.style.display = 'none'; });
        searchWrap.append(scopeBtn, search, menu);
        // Two rows: identity + view controls up top, the batch actions beneath.
        const rowStyle = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const vsep = () => { const s = document.createElement('span'); s.style.cssText = 'align-self:stretch;width:1px;background:color-mix(in srgb, currentColor 22%, transparent);margin:2px;'; return s; };
        const row1 = document.createElement('div'); row1.style.cssText = rowStyle;
        const row2 = document.createElement('div'); row2.style.cssText = rowStyle;
        const spacer = () => { const s = document.createElement('span'); s.style.width = '10px'; return s; };
        // 🌐 Global WI settings toggle — pinned to the far right of the book-header line.
        const globeBtn = document.createElement('button'); globeBtn.type = 'button'; globeBtn.className = 'menu_button wa-filter';
        globeBtn.title = 'Global World Info settings'; globeBtn.style.cssText = 'width:auto;margin-left:auto;padding:3px 8px;flex-shrink:0;';
        globeBtn.innerHTML = '<i class="fa-solid fa-globe"></i>';
        globeBtn.style.color = globalTrayOpen ? '#6ea8fe' : '';
        globeBtn.addEventListener('click', () => { globalTrayOpen = !globalTrayOpen; globeBtn.style.color = globalTrayOpen ? '#6ea8fe' : ''; refreshGlobalTray(); });
        row1.append(label, vsep(), filterWrap, sortBtn, spacer(), searchWrap, globeBtn);
        row2.append(expandBtn, scanBtn, suggestAllBtn, suggestAllLlmBtn);
        head.append(row1, row2);
        // Pinned region (header + Tool Settings drawer) stays put; only wa-studio-entries scrolls.
        const fixed = document.createElement('div'); fixed.className = 'wa-studio-fixed';
        globalTrayEl = renderGlobalTray();
        trayEl = renderTray();
        bulkEl = renderBulkBar();
        fixed.append(head, globalTrayEl, trayEl, bulkEl);
        const list = document.createElement('div'); list.className = 'wa-studio-entries';
        explorer.append(fixed, list);
        // Repaint just the entry list (and the count) for the current type filter + search.
        const applyFilter = () => {
            rowEls.clear();
            const shown = sortEntries(total.filter(filterMatch));
            visibleUids = shown.map(e => e.uid);   // keep the "visual order" source of truth in sync
            countSpan.textContent = (entryFilter !== 'all' || searchQuery.trim())
                ? `(${shown.length} of ${total.length})`
                : `(${total.length} ${total.length === 1 ? 'entry' : 'entries'})`;
            list.innerHTML = '';
            if (!shown.length) { list.innerHTML = `<div style="opacity:0.6;padding:8px;">${total.length ? 'No entries match.' : 'This lorebook has no entries.'}</div>`; return; }
            for (const e of shown) list.append(renderEntry(e));
        };
        applyFilter();
    };

    const openBook = async name => {
        if (dirty && selected) { reloadEditor(selected); dirty = false; }   // refresh the outgoing book's editor
        selected = name; loadSortView(name); entryOpen.clear(); expanded.clear(); tall.clear(); advOpen.clear(); sugg.clear(); selectedEntries.clear(); selAnchorUid = null; suggest = null; scan = null;   // scan is on-demand
        explorer.innerHTML = '<div style="opacity:0.6;padding:8px;">Loading…</div>';
        renderBooks();
        data = await loadWorldInfo(name);
        if (selected !== name) return;   // a faster second click won this race
        if (!data?.entries) { toastr.warning(`Couldn't load "${name}".`, 'Worlds Apart'); return; }
        const s = settings(); if (!s.keywordIgnore) s.keywordIgnore = {};
        ignoreSet = new Set(s.keywordIgnore[name] ?? []);
        renderExplorer();
        // The TF-IDF ranker is built lazily on the first ⚡/🪄 (which dims the button and yields a frame
        // first). We used to warm it here on requestIdleCallback, but buildKeySuggest is synchronous, so
        // once idle fired it still froze the page ~1s right after open — worse than an honest on-demand
        // build. Left cold; the first suggestion click pays the cost with a visible spinner.
    };

    const renderBooks = () => {
        nav.innerHTML = '';
        nav.classList.toggle('wa-nav-wide', bookBulkMode);   // widen to show full titles while selecting
        const head = document.createElement('div');
        head.className = 'wa-studio-navhead';
        head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';
        const ttl = document.createElement('b'); ttl.textContent = 'Lorebooks';
        const sortBtn = document.createElement('i');
        sortBtn.className = `fa-solid ${sortAsc ? 'fa-arrow-down-a-z' : 'fa-arrow-up-a-z'}`;
        sortBtn.title = `Sort ${sortAsc ? 'A→Z' : 'Z→A'} (click to flip)`;
        sortBtn.style.cssText = 'cursor:pointer;opacity:0.7;';
        sortBtn.addEventListener('click', () => { sortAsc = !sortAsc; renderBooks(); });
        const bulkToggle = document.createElement('i');
        bulkToggle.className = 'fa-solid fa-list-check';
        bulkToggle.title = bookBulkMode ? 'Exit select mode' : 'Select multiple books (copy / delete)';
        bulkToggle.style.cssText = `cursor:pointer;opacity:${bookBulkMode ? '1' : '0.6'};`;
        bulkToggle.addEventListener('click', () => { bookBulkMode = !bookBulkMode; if (!bookBulkMode) { selectedBooks.clear(); bookAnchor = null; } renderBooks(); });
        const navtools = document.createElement('span'); navtools.style.cssText = 'display:flex;align-items:center;gap:9px;';
        navtools.append(bulkToggle, sortBtn);
        head.append(ttl, navtools);
        nav.append(head);

        // Temporary undo bar for the last deleted book (auto-expires; dismiss or Undo to clear).
        if (pendingUndo) {
            const bar = document.createElement('div'); bar.className = 'wa-undo-bar';
            const top = document.createElement('div'); top.className = 'wa-undo-top';
            const txt = document.createElement('span'); txt.className = 'wa-undo-text';
            txt.innerHTML = '<i class="fa-solid fa-trash-can-arrow-up"></i> Deleted';
            const x = document.createElement('i'); x.className = 'fa-solid fa-xmark wa-undo-dismiss'; x.title = 'Dismiss';
            x.addEventListener('click', () => { clearUndo(); renderBooks(); });
            top.append(txt, x);
            const label = pendingUndo.books.length === 1 ? pendingUndo.books[0].name : `${pendingUndo.books.length} lorebooks`;
            const name = document.createElement('div'); name.className = 'wa-undo-name'; name.textContent = label; name.title = pendingUndo.books.map(b => b.name).join(', ');
            const undoBtn = document.createElement('button'); undoBtn.type = 'button'; undoBtn.className = 'menu_button wa-undo-btn'; undoBtn.textContent = 'Undo';
            undoBtn.addEventListener('click', restoreBook);
            bar.append(top, name, undoBtn);
            nav.append(bar);
        }

        const names = [...world_names].sort((a, b) => sortAsc ? a.localeCompare(b) : b.localeCompare(a));

        // Book-select mode: copy/delete bar. Buttons appear only once something's ticked.
        if (bookBulkMode) {
            const bar = document.createElement('div'); bar.className = 'wa-bookbulk';
            if (selectedBooks.size) {
                const top = document.createElement('div'); top.className = 'wa-bookbulk-top';
                const cnt = document.createElement('span'); cnt.style.fontWeight = 'bold'; cnt.textContent = `${selectedBooks.size} selected`;
                const clr = document.createElement('i'); clr.className = 'fa-solid fa-xmark wa-undo-dismiss'; clr.title = 'Clear selection';
                clr.addEventListener('click', () => { selectedBooks.clear(); bookAnchor = null; renderBooks(); });
                top.append(cnt, clr);
                const actions = document.createElement('div'); actions.className = 'wa-bookbulk-actions';
                const mk = (label, fn, extra = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button ' + extra; b.textContent = label; b.addEventListener('click', fn); return b; };
                actions.append(mk('Copy', bulkCopyBooks), mk('Delete', bulkDeleteBooks, 'wa-bulk-danger'));
                bar.append(top, actions);
            } else {
                const hint = document.createElement('div'); hint.className = 'wa-bookbulk-hint'; hint.textContent = 'Tick books to copy or delete.';
                bar.append(hint);
            }
            nav.append(bar);
        }

        for (const name of names) {
            const row = document.createElement('div');
            row.className = 'wa-book-row' + (name === selected ? ' wa-sel' : '');
            if (bookBulkMode) {
                const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'wa-book-sel'; cb.checked = selectedBooks.has(name);
                cb.addEventListener('click', ev => {
                    ev.stopPropagation();   // don't open the book
                    if (ev.shiftKey && bookAnchor != null && bookAnchor !== name) {
                        const a = names.indexOf(bookAnchor), b = names.indexOf(name);
                        if (a >= 0 && b >= 0) { const want = cb.checked; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) want ? selectedBooks.add(names[i]) : selectedBooks.delete(names[i]); }
                    }
                    bookAnchor = name;
                });
                cb.addEventListener('change', () => { cb.checked ? selectedBooks.add(name) : selectedBooks.delete(name); renderBooks(); });
                row.append(cb);
            }
            const nm = document.createElement('span'); nm.className = 'wa-book-name'; nm.textContent = name; nm.title = name;
            row.append(nm);
            row.addEventListener('click', () => { if (name !== selected) openBook(name); });
            nav.append(row);
        }
    };

    renderBooks();
    if (selected) await openBook(selected);
    else renderExplorer();

    const pop = new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Close', allowVerticalScrolling: false });
    await pop.show();
    clearUndo();   // drop the pending timer/snapshot when Studio closes
    if (dirty && selected) reloadEditor(selected);
    return '';
}
