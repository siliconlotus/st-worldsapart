// studio.mjs — Lorebook Studio (/wa-studio): the two-pane lorebook manager, all books on the left and the
// selected book's entries on the right. DOM- and ST-coupled; the logic it stands on is the shared pure modules.
import { saveSettingsDebounced, getRequestHeaders, characters, getCharacters } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { loadWorldInfo, saveWorldInfo, reloadEditor, createWorldInfoEntry, duplicateWorldInfoEntry, deleteWorldInfoEntry, getFreeWorldEntryUid, deleteWIOriginalDataValue, deleteWorldInfo, updateWorldInfoList, world_names, world_info_depth, world_info_include_names, world_info_match_whole_words, world_info_case_sensitive, selected_world_info, world_info, METADATA_KEY } from '../../../../world-info.js';
import { power_user } from '../../../../power-user.js';
import { escapeHtml } from '../../../../utils.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { runState, settings } from './state.mjs';
import { ensureStudioStyle, makeSortControl, showCtxMenu, showEntryText, wiGlyph } from './ui-widgets.mjs';
import { SORT_FNS, SORT_LABELS, normPresentation, presentationLabel, reconcileTiers, tierRank, wiTitleOf } from './sort.mjs';
import { buildKeyPruneScan, llmKeyCandidates } from './keyword-tools.mjs';
import { STUDIO_PRUNE_OPTS } from './keyword-audit.mjs';
import { buildKeySuggest, classifyLlmCand, STUDIO_SUGGEST_OPTS } from './keyword-suggest.mjs';
import { buildAutomaton, addMessageHits, fold, validateSmartKey } from './smartkeys.mjs';
import { findOrphanBindings } from './bindings.mjs';
import { WI_LOGIC, dropTags, hasPromoteDecorator, isRegexKey, keyHits, keySpans, scanSegments, secondaryKeys, splitKeys, usableKeys, wholeWordAdvice, withPromote } from './matcher.mjs';

const WA_GREEN = '#7bbf6a';   // "no prune" — a keyword the scan doesn't flag
const WA_RED = '#e06c6c';     // severe — same value keyword-audit's severityOf hands back
// Core's world_info_logic, worded as the sentence the chips beside it complete.
const LOGIC_LABEL = { 0: 'only if any of', 1: 'unless all of', 2: 'unless any of', 3: 'only if all of' };
/** The secondary-key operator select, under core's names. OFF is a fifth position that writes `selective`, not `selectiveLogic`. */
const LOGIC_OPTS = [
    ['off', 'OFF', 'selective: false — the keys are kept and never gate'],
    ['0', 'AND_ANY', LOGIC_LABEL[0]],
    ['3', 'AND_ALL', LOGIC_LABEL[3]],
    ['2', 'NOT_ANY', LOGIC_LABEL[2]],
    ['1', 'NOT_ALL', LOGIC_LABEL[1]],
];

/**
 * Places the selected entries (`orderedUids`, on-screen order) into a contiguous UID/order block [start, start+N-1].
 * Returns `{conflict: uid}` when an unselected entry holds a target UID, else `{moves: [[oldUid, newUid], …]}`.
 * @param {boolean} desc top gets start+N-1 rather than `start`
 * Sliced by eval/bulk-reorder-check.mjs from its `function` line to the first `\n}\n`: keep it a plain function.
 */
function planUidReindex(entries, orderedUids, start, desc) {
    const n = orderedUids.length;
    const selUids = new Set(orderedUids);
    const targetOf = i => start + (desc ? n - 1 - i : i);
    for (let i = 0; i < n; i++) { const u = targetOf(i); if ((u in entries) && !selUids.has(u)) return { conflict: u }; }
    return { moves: orderedUids.map((uid, i) => [uid, targetOf(i)]) };
}

/**
 * Lorebook Studio (/wa-studio).
 * @param {string|null} preferredBook Opened if it still exists; else any attached world, else nothing selected
 */
export async function lorebookStudio(preferredBook = null) {
    if (!(world_names ?? []).length) { toastr.warning('No lorebooks found.', 'Worlds Apart'); return ''; }
    ensureStudioStyle();

    let sortAsc = true;
    let selected = (world_names.includes(preferredBook) ? preferredBook : null)
        ?? [...runState.attachedWorlds].find(w => world_names.includes(w)) ?? null;
    let data = null;                 // loaded world-info for `selected`
    let scan = null;                 // buildKeyPruneScan result for `data` (keyword colouring)
    let suggest = null;              // buildKeySuggest result, built lazily on first ⚡/🪄
    let ignoreSet = new Set();       // per-book prune whitelist (shared with the prune popup)
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
    let entrySort = 'insert';        // 'insert' mirrors the prompt insertion order; persisted per book
    let tieredMode = true;
    let tierCfg = reconcileTiers(settings().tierCfg);   // tier precedence, shared with the prompt builder
    const loadSortView = name => { const v = settings().studioSortByBook?.[name]; entrySort = v?.sort ?? 'insert'; tieredMode = v?.tiered ?? true; };
    const persistSortView = () => { const s = settings(); (s.studioSortByBook ??= {})[selected] = { sort: entrySort, tiered: tieredMode }; saveSettingsDebounced(); };
    let searchQuery = '';            // explorer free-text search
    let visibleUids = [];            // on-screen order — the source of truth for shift-range selection and renumber
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
    let tab = 'explorer';            // 'explorer' | 'cleanup' | 'lab'
    const cleanupChecks = new Map();   // rowId -> bool, defaulting from scan.defChecked; survives rescans and tab switches on purpose
    let cleanupUndo = null;            // [{uid, key}] from the last prune, restorable until the next one
    let cleanupShowAll = false;        // Cleanup lists every key on the visible entries, not only the flagged ones
    let chatHits = null;        // Map<key, count> from the chat scan, null until one has run; survives a rescan, cleared on book change
    let chatMsgs = 0;
    let chatName = '';          // WHICH chat produced those counts — see runChatScan
    const rowId = (uid, term) => `${uid}${term}`;
    let termRepaint = null;   // the active term tab's list repaint; null in the Explorer, whose rerenderKeys walks rowEls instead
    const afterIgnoreChange = keys => {
        if (termRepaint) termRepaint(); else rerenderKeys(keys);
        if (trayOpen) refreshTray();   // the whitelist column lives there
    };

    let orphans = null;       // findOrphanBindings result, computed once in the background; null until it has run
    let orphanView = false;   // showing the list instead of a book — `selected` stays a real book name

    /** The chat index: the plugin's chat-bindings route (reads line 0 only, P1), else ST's endpoint via loadChatIndex. */
    const bindingIndex = async () => {
        if (runState.pluginAvailable) {
            try {
                const r = await fetch('/api/plugins/worlds-apart/chat-bindings', { method: 'POST', headers: getRequestHeaders() });
                if (r.ok) {
                    const { bindings } = await r.json();
                    const byDir = new Map();
                    for (const c of characters ?? []) {
                        if (c?.avatar) byDir.set(String(c.avatar).replace(/\.png$/, ''), c);
                    }
                    const out = new Map();
                    const entry = dir => {
                        let e = out.get(dir);
                        if (!e) {
                            const c = byDir.get(dir);
                            out.set(dir, e = { char: c?.name ?? dir, avatar: c?.avatar ?? `${dir}.png`, charWorld: c?.data?.extensions?.world ?? null, chats: [] });
                        }
                        return e;
                    };
                    for (const c of characters ?? []) if (c?.avatar) entry(String(c.avatar).replace(/\.png$/, ''));
                    for (const b of bindings ?? []) entry(b.dir).chats.push({ file_name: b.file, chat_metadata: { world_info: b.world_info } });
                    return [...out.values()];
                }
            } catch (err) { console.warn('[WA] chat-bindings route unavailable, falling back', err); }
        }
        return loadChatIndex();
    };

    const checkOrphans = async () => {
        try {
            const r = findOrphanBindings(await bindingIndex(), world_names);
            if (!r.chatCount && !r.cardCount) return;
            orphans = r;
            renderBooks();
        } catch (err) { console.warn('[WA] orphan check', err); }
    };

    const root = document.createElement('div');
    root.className = 'wa-studio';
    const nav = document.createElement('div'); nav.className = 'wa-studio-nav';
    const explorer = document.createElement('div'); explorer.className = 'wa-studio-explorer';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'fa-solid fa-xmark wa-studio-close';
    closeBtn.title = 'Close'; closeBtn.setAttribute('aria-label', 'Close');
    root.append(nav, explorer, closeBtn);

    const firstLine = e => { const t = String(e.content ?? '').trim(); const nl = t.indexOf('\n'); return (nl < 0 ? t : t.slice(0, nl)) || '(empty)'; };
    const save = () => { dirty = true; saveWorldInfo(selected, data, true); };
    const getSugg = uid => { let x = sugg.get(uid); if (!x) sugg.set(uid, x = { tfidf: [], llm: [] }); return x; };
    const rebuildScan = () => {
        scan = buildKeyPruneScan(data, studioOpts, ignoreSet, {
            matchWindow: settings().matchWindow,
            // Into the classifier, not painted on in Cleanup: the Explorer's chips colour from reasonOf/severityOf.
            chatScan: chatHits ? { messagesWith: chatHits, messages: chatMsgs } : undefined,
        });
    };
    const afterChatScan = keys => { rebuildScan(); termRepaint?.(); rerenderKeys(keys); };
    /** Every key in the book — the whole book, not visibleEntries(), so a verdict never depends on the filter. */
    const bookKeys = () => [...new Set(Object.values(data?.entries ?? {})
        .flatMap(e => (Array.isArray(e.key) ? e.key : []).map(k => String(k).trim())).filter(Boolean))];

    const clearChatScan = () => { chatHits = null; chatMsgs = 0; chatName = ''; };
    // Repaints the entries carrying any of `keys`; classifyEntry reads ignoreSet live, so whitelisting needs no rescan.
    const rerenderKeys = keys => { const set = new Set(keys); for (const e of Object.values(data?.entries ?? {})) if ((Array.isArray(e.key) ? e.key : []).some(k => set.has(k))) renderEntry(e); };

    const persistIgnore = () => { const s = settings(); if (!s.keywordIgnore) s.keywordIgnore = {}; s.keywordIgnore[selected] = [...ignoreSet]; saveSettingsDebounced(); };
    const persistOpts = () => { const s = settings(); s.studioScanOpts = studioOpts; s.studioSuggestOpts = suggestOpts; saveSettingsDebounced(); };

    const trayCol = (colCls, secCls, title, ...kids) => {
        const c = document.createElement('div'); c.className = colCls;
        const h = document.createElement('div'); h.className = secCls; h.textContent = title;
        c.append(h, ...kids); return c;
    };
    const trayChk = (rowCls, label, checked, onChange, title = '') => {
        const l = document.createElement('label'); l.className = 'checkbox_label ' + rowCls; if (title) l.title = title;
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked;
        cb.addEventListener('change', () => onChange(cb.checked));
        const s = document.createElement('span'); s.textContent = label;
        l.append(cb, s); return l;
    };

    // ⚙ Tool Settings tray: audit options, recommender knobs, this book's ignored terms.
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
        const check = (obj, key, label, after) => trayChk('wa-tray-opt', label, !!obj[key], v => { obj[key] = v; persistOpts(); after?.(); });
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
        const col = (title, ...kids) => trayCol('wa-tray-col', 'wa-tray-sec', title, ...kids);
        const invSuggest = () => { suggest = null; };

        const wl = document.createElement('div');   // whitelist column body: chips row, then a centred Clear
        const chips = document.createElement('div'); chips.className = 'wa-tray-wl';
        if (!ignoreSet.size) { const em = document.createElement('span'); em.style.opacity = '0.55'; em.textContent = 'None — right-click a term to ignore it.'; chips.append(em); }
        for (const key of [...ignoreSet].sort()) {
            const chip = document.createElement('span'); chip.className = 'wa-kw wa-kw-ignored';
            const t = document.createElement('span'); t.className = 'wa-kw-text'; t.textContent = key; t.style.cursor = 'default';
            const x = document.createElement('i'); x.className = 'fa-solid fa-xmark wa-kw-del'; x.title = 'Stop ignoring this term';
            x.addEventListener('click', () => { ignoreSet.delete(key); persistIgnore(); afterIgnoreChange([key]); refreshTray(); });
            chip.append(t, x); chips.append(chip);
        }
        wl.append(chips);
        if (ignoreSet.size) {
            const clrRow = document.createElement('div'); clrRow.className = 'wa-tray-wl-clear';
            const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'menu_button'; clr.style.margin = '0';
            clr.textContent = 'Clear ignored';
            clr.addEventListener('click', () => { const cleared = [...ignoreSet]; ignoreSet.clear(); persistIgnore(); afterIgnoreChange(cleared); refreshTray(); });
            clrRow.append(clr); wl.append(clrRow);
        }

        panel.append(
            col('Keyword audit',
                check(studioOpts, 'scanKeyword', 'Scan Keyword (🟢)'),
                check(studioOpts, 'scanVectorized', 'Scan Vectorized (🔗)'),
                check(studioOpts, 'scanConstant', 'Scan Constant (🔵)'),
                check(studioOpts, 'includeInactive', 'Include inactive entries'),
                check(studioOpts, 'pruneUnattested', 'Flag keys not in entry text (aliases and typos)'),
                check(studioOpts, 'pruneCommon', 'Flag english-common and book-common keys'),
                num(studioOpts, 'bookCommon', '↳ book common: in >', '% of entry TEXT', { min: 1, max: 100, scale: 100 }),
                num(studioOpts, 'chatCommon', '↳ chat common: in >', '% of MESSAGES', { min: 1, max: 100, scale: 100 }),
                check(studioOpts, 'pruneShared', 'Flag book-shared keys'),
                num(studioOpts, 'bookShared', '↳ book shared: LISTED by >', '% of entries', { min: 1, max: 100, scale: 100 }),
                check(studioOpts, 'pruneShort', 'Flag short keys'),
                num(studioOpts, 'minLength', '↳ short: under', 'chars', { min: 1 }),
                check(studioOpts, 'ignoreProper', 'Spare proper nouns from the dead flag'),
            ),
            col('Recommender (⚡ / ✨)',
                num(suggestOpts, 'dfCeil', 'Skip terms in >', '% of entries', { min: 1, max: 100, scale: 100 }, invSuggest),
                num(suggestOpts, 'maxN', 'Longest phrase', 'content words', { min: 1, max: 8 }, invSuggest),
                num(suggestOpts, 'cap', 'Max per entry', '', { min: 1, max: 50 }, invSuggest),
                num(suggestOpts, 'llmChunk', '✨ chunk over', 'chars', { min: 500, width: '5.6em' }),   // longer entries split into this-sized passes
                check(suggestOpts, 'excludeDates', 'Skip date-like terms', invSuggest),
                check(suggestOpts, 'excludeShort', 'Skip short terms', invSuggest),
                check(suggestOpts, 'onlyActive', 'Suggest from active entries only', invSuggest),
            ),
            col(`Ignored terms — ${ignoreSet.size}`, wl),
        );
        wrap.append(panel);
        return wrap;
    };
    const refreshTray = () => { const fresh = renderTray(); if (trayEl?.isConnected) trayEl.replaceWith(fresh); trayEl = fresh; };

    // 🌐 Global WI settings. Core's knobs are edited by driving core's own inputs, never by assigning the globals.
    const refreshGlobalTray = () => { const fresh = renderGlobalTray(); if (globalTrayEl?.isConnected) globalTrayEl.replaceWith(fresh); globalTrayEl = fresh; };
    function renderGlobalTray() {
        if (!globalTrayOpen) return document.createElement('div');   // nothing mounted when closed
        const panel = document.createElement('div'); panel.className = 'wa-tray-panel';
        const col = (title, ...kids) => trayCol('wa-tray-col', 'wa-tray-sec', title, ...kids);
        const numRow = (label, backing, unit, title) => {
            const l = document.createElement('label'); l.className = 'wa-tray-opt wa-tray-num'; if (title) l.title = title;
            const b = document.createElement('span'); b.textContent = label;
            const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.className = 'text_pole'; inp.style.cssText = 'width:4.5em;margin:0 4px;'; inp.value = String(backing.get());
            inp.addEventListener('change', () => backing.set(Math.max(0, Math.floor(Number(inp.value) || 0))));
            const u = document.createElement('span'); u.textContent = unit || ''; u.style.opacity = '0.6';
            l.append(b, inp, u); return l;
        };
        const chkRow = (label, backing, title) => trayChk('wa-tray-opt', label, backing.get(), v => backing.set(v), title);
        // Core globals go through core's #world_info_* inputs: a native 'input' event fires its jQuery handlers, which persist and enforce the exclusion.
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
                chkRow('Case-sensitive', coreChk('#world_info_case_sensitive', renderExplorer), 'Default for entries that don’t set their own — their Aa icon shows light green when inherited'),
                chkRow('Match whole words', coreChk('#world_info_match_whole_words', renderExplorer), 'Default for entries that don’t set their own — their [ab] icon shows light green when inherited'),
            ),
        );
        return panel;
    }

    // --- Bulk selection + actions ---
    const refreshBulkBar = () => { const fresh = renderBulkBar(); if (bulkEl?.isConnected) bulkEl.replaceWith(fresh); bulkEl = fresh; };
    const syncSelCheckboxes = () => { for (const [uid, row] of rowEls) { const cb = row.querySelector('.wa-entry-sel'); if (cb) cb.checked = selectedEntries.has(uid); } refreshBulkBar(); };
    const selectedList = () => [...selectedEntries].map(uid => data?.entries?.[uid]).filter(Boolean);
    let lastSel = null;   // the selection a bulk action spent, offered back as "Reselect N"
    const consumeSelection = () => { if (!selectedEntries.size) return; lastSel = new Set(selectedEntries); selectedEntries.clear(); syncSelCheckboxes(); };
    const applyBulk = fn => { const sel = selectedList(); if (!sel.length) return; for (const e of sel) fn(e); save(); sel.forEach(x => renderEntry(x)); consumeSelection(); };
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
    const bulkOrderSet = async () => { const v = await numberPrompt('Order — selected entries', 'Order value for every selected entry:', 100); if (v != null) applyBulk(e => e.order = Math.floor(v)); };
    const bulkRecLevel = async () => { const v = await numberPrompt('Delay until recursion — selected entries', 'Recursion level (0 = any; turns the flag on):', 0, 0); if (v != null) applyBulk(e => e.delayUntilRecursion = Math.floor(v) > 0 ? Math.floor(v) : true); };
    const bulkCopyTo = async () => { const l = selectedList(); consumeSelection(); await entriesToBook(l, false); };
    const bulkMoveTo = async () => { const l = selectedList(); consumeSelection(); await entriesToBook(l, true); };
    const bulkOrder = async (advanced = false) => {
        const curOrder = presentationLabel(settings());
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
            + '<div style="margin-top:8px;">In order of <select class="wa-bo-sort text_pole" style="width:auto;margin-left:6px;">'
            + '<option value="">On screen</option>'
            + Object.entries(SORT_LABELS).map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v)}</option>`).join('')
            + '</select></div>'
            + '<label class="checkbox_label" style="margin-top:6px;"><input type="radio" name="wa-bo-dir" class="wa-bo-asc" checked><span>Ascending — top gets the start value</span></label>'
            + '<label class="checkbox_label"><input type="radio" name="wa-bo-dir" class="wa-bo-desc"><span>Descending — top gets the highest value</span></label>'
            + (advanced ? '<small style="opacity:0.6;display:block;margin-top:6px;">Sets UID = order per entry. Aborts if the target UID range overlaps an unselected entry.</small>' : '')
            + `<div style="margin-top:8px;opacity:0.7;">Current sort order: <b>${escapeHtml(String(curOrder))}</b></div>`;
        const p = new Popup(w, POPUP_TYPE.CONFIRM, '', { okButton: advanced ? 'Reorder + UIDs' : 'Renumber', cancelButton: 'Cancel' });
        if (await p.show() !== POPUP_RESULT.AFFIRMATIVE) return;
        const startRaw = Number(w.querySelector('.wa-bo-start').value); const start = Number.isFinite(startRaw) ? Math.round(startRaw) : 1;
        const desc = w.querySelector('.wa-bo-desc').checked;
        const ordered = visibleUids.filter(u => selectedEntries.has(u)).map(u => data.entries[u]).filter(Boolean);   // selected, in on-screen (sorted) order
        const sortKey = w.querySelector('.wa-bo-sort').value;
        if (SORT_FNS[sortKey]) ordered.sort(SORT_FNS[sortKey]);
        const n = ordered.length;
        const targetOf = i => start + (desc ? n - 1 - i : i);   // block occupies [start, start+N-1]

        if (!advanced) { ordered.forEach((e, i) => e.order = targetOf(i)); save(); ordered.forEach(x => renderEntry(x)); consumeSelection(); return; }

        // UID is the entries-object key and the entry's identity, so this rebuilds data.entries.
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
        entryOpen.clear(); expanded.clear(); tall.clear(); advOpen.clear(); sugg.clear(); selectedEntries.clear(); lastSel = null; suggest = null; if (scan) rebuildScan();
        save(); renderExplorer();
        toastr.success(`Renumbered ${n} ${n === 1 ? 'entry' : 'entries'} (order + UID).`, 'Worlds Apart');
    };
    const bulkDelete = async () => {
        const n = selectedEntries.size; if (!n) return;
        if (!await Popup.show.confirm(`Delete ${n} selected ${n === 1 ? 'entry' : 'entries'}?`, 'This is irreversible.')) return;
        for (const uid of [...selectedEntries]) { await deleteWorldInfoEntry(data, uid, { silent: true }); sugg.delete(uid); rowEls.delete(uid); }
        selectedEntries.clear(); lastSel = null;   // no Reselect offer: those uids don't exist any more
        save(); suggest = null; if (scan) rebuildScan(); renderExplorer();
    };
    const bulkAddTerm = async () => {
        const raw = await Popup.show.input('Add term — selected entries', 'Keyword to add to every selected entry:');
        const term = String(raw ?? '').trim();
        if (!term || !keyWriteOk(term)) return;
        let added = 0;
        const n = selectedEntries.size;   // applyBulk spends the selection, so count before it runs
        applyBulk(e => { if (!hasKey(e, term)) { if (!Array.isArray(e.key)) e.key = []; e.key.push(term); added++; } });
        const skipped = n - added;
        toastr[added ? 'success' : 'info'](added ? `“${term}” added to ${added} ${added === 1 ? 'entry' : 'entries'}${skipped ? ` (${skipped} already had it)` : ''}.` : `Every selected entry already has “${term}”.`, 'Worlds Apart');
    };
    // Undo restores by uid (a rescan rebuilds rows) and refuses if the book changed, since save() writes to `selected`.
    const bulkClearTerms = async () => {
        const sel = selectedList(); if (!sel.length) return;
        const total = sel.reduce((n, e) => n + (Array.isArray(e.key) ? e.key.length : 0), 0);
        if (!total) { toastr.info('The selected entries have no keywords.', 'Worlds Apart'); return; }
        if (!await Popup.show.confirm(`Delete all ${total} keyword${total === 1 ? '' : 's'} from ${sel.length} selected ${sel.length === 1 ? 'entry' : 'entries'}?`, 'Undoable from the toast for 20 seconds.')) return;
        const book = selected, before = sel.map(e => [e.uid, Array.isArray(e.key) ? [...e.key] : []]);
        applyBulk(e => e.key = []);
        suggest = null; if (scan) { rebuildScan(); sel.forEach(x => renderEntry(x)); }
        const undo = () => {
            if (selected !== book) { toastr.warning(`That undo belongs to “${book}” — reopen it first.`, 'Worlds Apart'); return; }
            let n = 0;
            for (const [uid, keys] of before) { const e = data?.entries?.[uid]; if (!e) continue; e.key = keys; n += keys.length; }
            save(); suggest = null; if (scan) rebuildScan(); renderExplorer();
            toastr.success(`Restored ${n} keyword${n === 1 ? '' : 's'}.`, 'Worlds Apart');
        };
        toastr.success(`Deleted ${total} keyword${total === 1 ? '' : 's'} — click to undo.`, 'Worlds Apart', { timeOut: 20000, extendedTimeOut: 10000, onclick: undo });
    };
    const menuBtn = (label, onClick, cls = '', style = '') => {
        const b = document.createElement('button'); b.type = 'button';
        b.className = 'menu_button ' + cls;
        b.textContent = label;
        if (style) b.style.cssText = style;
        b.addEventListener('click', onClick); return b;
    };
    const barBtn = (label, onClick, extra = '') => menuBtn(label, onClick, 'wa-bulk-btn ' + extra);

    const renderBulkBar = () => {
        const wrap = document.createElement('div');
        const n = selectedEntries.size;
        const sep = () => { const s = document.createElement('span'); s.className = 'wa-bulk-sep'; return s; };
        if (!n) {   // nothing selected -> the Reselect offer if a bulk action just spent one, else no footprint
            if (!lastSel?.size) return wrap;
            wrap.classList.add('wa-bulk-on');
            const note = document.createElement('span'); note.className = 'wa-bulk-count'; note.textContent = 'Selection cleared';
            const drop = document.createElement('i'); drop.className = 'fa-solid fa-xmark wa-undo-dismiss'; drop.title = 'Dismiss';
            drop.addEventListener('click', () => { lastSel = null; refreshBulkBar(); });
            wrap.append(note, barBtn(`Reselect ${lastSel.size}`, () => {
                for (const uid of lastSel) if (data?.entries?.[uid]) selectedEntries.add(uid);   // skip anything deleted since
                lastSel = null; syncSelCheckboxes();
            }), drop);
            return wrap;
        }
        wrap.classList.add('wa-bulk-on');
        const all = Object.values(data?.entries ?? {}).filter(filterMatch);   // select-all targets the visible (filtered) set
        const count = document.createElement('span'); count.className = 'wa-bulk-count'; count.textContent = `${n} selected`;
        // "Set… ▾": one menu over every per-entry field, built on open so the Inherit labels read the current globals.
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
                { label: 'Order…', fn: bulkOrderSet },
                { label: 'Scan depth…', fn: bulkScanDepth },
            ];
        };
        const setBtn = barBtn('Set… ▾', () => { const r = setBtn.getBoundingClientRect(); showCtxMenu(setItems(), r.left, r.bottom + 2, ctxMount()); });
        setBtn.title = 'Set a field on all selected entries';
        const addTermBtn = barBtn('Add term…', bulkAddTerm); addTermBtn.title = 'Add one keyword to every selected entry';
        const reBtn = barBtn('Renumber…', ev => bulkOrder(ev.shiftKey)); reBtn.title = 'Renumber order — shift-click to also renumber UIDs';
        const anyDisabled = Object.values(data?.entries ?? {}).some(e => selectedEntries.has(e.uid) && e.disable);
        wrap.append(
            count,
            barBtn(n === all.length ? 'Select none' : 'Select all', () => { if (n === all.length) consumeSelection(); else { lastSel = null; all.forEach(e => selectedEntries.add(e.uid)); syncSelCheckboxes(); } }),
            ...(n === all.length ? [] : [barBtn('Clear', consumeSelection)]),
            sep(),
            barBtn(anyDisabled ? 'Enable' : 'Disable', () => { applyBulk(e => e.disable = !anyDisabled); refreshBulkBar(); }),
            addTermBtn,
            setBtn,
            reBtn,
            sep(),
            barBtn('Copy to…', bulkCopyTo),
            barBtn('Move to…', bulkMoveTo),
            sep(),
            barBtn('Delete all terms', bulkClearTerms, 'wa-bulk-danger'),
            barBtn('Delete', bulkDelete, 'wa-bulk-danger'),
        );
        return wrap;
    };

    // bgDocs rides in the call, not in suggestOpts, which is persisted to settings; the open chat only (P2).
    const ensureSuggest = () => suggest ?? (suggest = buildKeySuggest(data,
        { ...suggestOpts, bgDocs: (getContext().chat ?? []).map(m => String(m?.mes ?? '')).filter(Boolean) }));
    const hasKey = (e, term) => Array.isArray(e.key) && e.key.some(k => String(k).toLowerCase().trim() === term.toLowerCase().trim());

    /**
     * The gate every key write goes through: an error refuses the write, a warning lets it through; both from validateSmartKey.
     * @returns {boolean} whether the write may proceed
     */
    const keyWriteOk = (term, list = 'key', entry = null) => {
        const problems = validateSmartKey(term);
        // Which codes are fatal depends on position and operator — asked of matcher.mjs, never re-listed here; the probe carries the entry's logic and deliberately not its `selective`.
        const usable = list === 'keysecondary'
            ? secondaryKeys({ keysecondary: [term], selectiveLogic: entry?.selectiveLogic }).length
            : usableKeys([term]).length;
        const err = usable ? null : problems.find(p => p.severity === 'error');
        if (err) { toastr.warning(err.message, 'Worlds Apart', { timeOut: 8000 }); return false; }
        // One toast per code, not per instance.
        const byCode = new Map();
        for (const w of problems) {
            if (w.severity === 'error') continue;   // tolerated in this position; not advice about it
            const seen = byCode.get(w.code);
            if (seen) seen.n++; else byCode.set(w.code, { message: w.message, n: 1 });
        }
        for (const { message, n } of byCode.values()) {
            toastr.info(n > 1 ? `${message} (${n} terms)` : message, 'Worlds Apart', { timeOut: 6000 });
        }
        return true;
    };

    const tool = (cls, on, title, onClick) => {
        const i = document.createElement('i');
        if (cls.startsWith('fa-')) i.className = `fa-solid ${cls} wa-tool` + (on ? ' wa-on' : '');
        else { i.className = 'wa-tool' + (on ? ' wa-on' : ''); i.textContent = cls; i.style.fontWeight = 'bold'; }
        i.title = title;
        i.addEventListener('click', ev => { ev.stopPropagation(); onClick(ev); });
        return i;
    };
    const bookTool = (cls, title, onClick, extra = '') => { const i = document.createElement('i'); i.className = `fa-solid ${cls} wa-book-tool ${extra}`; i.title = title; i.addEventListener('click', onClick); return i; };

    /**
     * The per-entry tool row, shared by the Explorer header and the term tabs' group headers.
     * @param {(e: object) => void} repaint What to redraw after a change
     * @param {{compact?: boolean}} [opt] compact drops sticky and trigger-%
     */
    const buildEntryTools = (e, repaint, { compact = false } = {}) => {
        const tools = document.createElement('div'); tools.className = 'wa-entry-tools';
        const prob = e.probability != null ? Number(e.probability) : 100;
        const delay = Number(e.delay) || 0;
        const cooldown = Number(e.cooldown) || 0;
        const stickyOn = Number(e.sticky) > 0;
        const stickyTool = tool('fa-thumbtack', stickyOn, `Sticky: ${stickyOn ? `on (${e.sticky})` : 'off'} — click ${stickyOn ? 'disables' : 'enables'}, shift-click sets a value`, ev => { if (ev.shiftKey) { editSticky(e); return; } e.sticky = stickyOn ? 0 : 1; save(); repaint(e); });
        if (stickyOn) { stickyTool.classList.add('wa-badge'); stickyTool.dataset.badge = String(e.sticky); }   // show the sticky count
        const probGates = e.useProbability !== false && prob < 100;
        const probVal = prob < 100;
        const probTool = tool('fa-percent', probGates, `Trigger probability: ${probGates ? `${prob}%` : (probVal ? 'off' : 'always')} — ${probVal ? `click ${e.useProbability === false ? 'enables' : 'disables'}` : 'click to set'}, shift-click edits`, ev => { if (ev.shiftKey || !probVal) { editProbability(e); return; } e.useProbability = (e.useProbability === false); save(); repaint(e); });
        if (probGates) { probTool.classList.add('wa-badge'); probTool.dataset.badge = String(prob); }   // show the % value
        const advParts = [];
        if (cooldown > 0) advParts.push(`cooldown ${cooldown}`);
        if (delay > 0) advParts.push(`delay ${delay}`);
        if (e.excludeRecursion) advParts.push('non-recursable');
        if (e.preventRecursion) advParts.push('prevent recursion');
        if (e.delayUntilRecursion) advParts.push('delay until recursion' + (typeof e.delayUntilRecursion === 'number' && e.delayUntilRecursion > 0 ? ` ${e.delayUntilRecursion}` : ''));
        if (e.ignoreBudget) advParts.push('ignore budget');
        if (e.scanDepth != null) advParts.push(`scan depth ${e.scanDepth}`);
        const advActive = advParts.length > 0;
        const advTool = tool('fa-gear', advOpen.has(e.uid) || advActive, advActive ? advParts.join('\n') : 'Advanced: recursion, budget, timing', () => { advOpen.has(e.uid) ? advOpen.delete(e.uid) : advOpen.add(e.uid); repaint(e); });
        // `??`, not `||`: an explicit false is an entry override, null is inherit.
        const flagState = (v, g) => `${(v ?? g) ? 'On' : 'Off'} (${v == null ? 'inherited' : 'entry'})`;
        const effCase = e.caseSensitive ?? world_info_case_sensitive;
        const caseInherit = e.caseSensitive == null && !!world_info_case_sensitive;
        const caseTool = tool('Aa', effCase, `Case-sensitive: ${flagState(e.caseSensitive, world_info_case_sensitive)} · shift-click: inherit`, ev => { e.caseSensitive = ev.shiftKey ? null : !effCase; save(); repaint(e); });
        if (caseInherit) caseTool.style.color = '#8fce8f';
        const effWhole = e.matchWholeWords ?? world_info_match_whole_words;
        const wholeInherit = e.matchWholeWords == null && !!world_info_match_whole_words;
        const wholeAdvice = wholeWordAdvice(e.key, effWhole);
        const wholeTool = tool('[ab]', effWhole, `Match whole words: ${flagState(e.matchWholeWords, world_info_match_whole_words)} · shift-click: inherit${wholeAdvice.map(a => `\n\n${a}`).join('')}`, ev => { e.matchWholeWords = ev.shiftKey ? null : !effWhole; save(); repaint(e); });
        if (wholeInherit) wholeTool.style.color = '#8fce8f';
        // A badge, not a tint: colour already carries the inherited/entry state.
        if (wholeAdvice.length) { wholeTool.classList.add('wa-badge'); wholeTool.dataset.badge = '!'; }
        // Promote is a content decorator (@@promote), not a field.
        const promoted = hasPromoteDecorator(e);
        const promoteTool = tool('fa-crown', promoted, promoted
            ? 'Promoted: activation is enough — this entry skips the relevance cut. Click to un-promote.'
            : 'Not promoted — this entry answers to the relevance cut like any other. Click to promote.',
            () => { e.content = withPromote(e.content, !promoted); save(); repaint(e); });

        tools.append(
            tool('fa-power-off', !e.disable, e.disable ? 'Disabled — click to enable' : 'Active — click to disable', () => { e.disable = !e.disable; save(); repaint(e); }),
            caseTool,
            wholeTool,
            promoteTool,
            ...(compact ? [] : [stickyTool, probTool]),
            advTool,
            tool('fa-copy', false, 'Duplicate entry', () => dupEntry(e)),
            tool('fa-trash-can', false, 'Delete entry', () => delEntry(e)),
        );
        return tools;
    };

    const clampMsg = v => Math.max(0, Math.floor(Number(v) || 0));
    const clampPct = v => Math.min(100, Math.max(0, Math.floor(Number(v) || 0)));
    /** Number box + −/+ steppers + reset, committed on OK; `commit` is handed the clamped value. */
    const stepperPopup = async (e, { value, step, clamp, reset, resetLabel, resetTitle, max, title, commit }) => {
        const w = document.createElement('div');
        w.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; if (max != null) inp.max = String(max);
        inp.className = 'text_pole'; inp.style.cssText = 'width:5em;text-align:center;margin:0;';
        inp.value = String(value);
        const stepBtn = (d, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button'; b.style.margin = '0'; b.textContent = label; b.addEventListener('click', () => { inp.value = String(clamp((Number(inp.value) || 0) + d)); }); return b; };
        const rst = document.createElement('button'); rst.type = 'button'; rst.className = 'menu_button'; rst.style.margin = '0'; rst.textContent = resetLabel; rst.title = resetTitle; rst.addEventListener('click', () => { inp.value = String(reset); });
        w.append(stepBtn(-step, '−'), inp, stepBtn(step, '+'), rst);
        const p = new Popup(w, POPUP_TYPE.CONFIRM, title, { okButton: 'Set', cancelButton: 'Cancel' });
        if (await p.show() === POPUP_RESULT.AFFIRMATIVE) { commit(clamp(inp.value)); save(); renderEntry(e); }
    };
    const editSticky = e => stepperPopup(e, {
        value: Number(e.sticky) || 0, step: 1, clamp: clampMsg,
        reset: 0, resetLabel: '🚫', resetTitle: 'Reset to 0', title: '',
        commit: v => e.sticky = v,
    });
    const editProbability = e => stepperPopup(e, {
        value: e.probability != null ? clampPct(e.probability) : 100, step: 10, clamp: clampPct, max: 100,
        reset: 100, resetLabel: '🎯', resetTitle: 'Always fire (100%)', title: 'Trigger probability %',
        commit: v => { e.probability = v; e.useProbability = true; },
    });


    /** Refuses a re-entrant click and dims the button; undims on every exit, a throw included. */
    const withBusy = async (btn, dim, fn) => {
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1'; btn.style.opacity = dim;
        try { return await fn(); } finally { btn.dataset.busy = ''; btn.style.opacity = ''; }
    };

    // Yields a frame before the synchronous ranker build so the dim paints first.
    const suggestTfidf = (e, btn) => withBusy(btn, '0.25', async () => {
        if (!suggest) await new Promise(r => setTimeout(r, 0));
        const s = ensureSuggest();
        const pe = s.perEntry.find(p => String(p.entry.uid) === String(e.uid));
        const fresh = (pe?.newRows ?? []).map(r => r.display).filter(t => !hasKey(e, t));
        if (!fresh.length) { toastr.info('No TF-IDF suggestions for this entry.', 'Worlds Apart'); return; }
        const g = getSugg(e.uid);
        const seen = new Set([...g.tfidf, ...g.llm].map(t => s.canon(t)));
        for (const t of fresh) { const c = s.canon(t); if (!seen.has(c)) { g.tfidf.push(t); seen.add(c); } }
        renderEntry(e);
    });
    // Filters raw model candidates through classifyLlmCand, the same filters the single ✨ applies; returns the count added.
    const mergeLlmCands = (e, cands, s) => {
        const g = getSugg(e.uid);
        const seen = new Set([...g.tfidf, ...g.llm].map(t => s.canon(t)));
        let added = 0;
        for (const cand of cands) {
            const { term: t, canon: c, reason } = classifyLlmCand(cand, {
                canon: s.canon, exampleCanon: s.exampleCanon, exampleWords: s.exampleWords, entryText: e.content, dfSubstr: s.dfSubstr, N: s.N,
                dfCeil: suggestOpts.dfCeil, excludeDates: suggestOpts.excludeDates,
                isDupe: (term, cn) => seen.has(cn) || hasKey(e, term),
            });
            if (reason) continue;
            g.llm.push(t); seen.add(c); added++;
        }
        return added;
    };
    // `after` is the caller's repaint: one row in the Explorer, the whole list at the end of a book-wide run.
    const suggestLlm = (e, btn, after = renderEntry) => withBusy(btn, '0.25', async () => {
        btn.classList.remove('wa-on');
        const s = ensureSuggest();
        let cands;
        try { cands = await llmKeyCandidates(e.content, s.avoid, suggestOpts.llmChunk); }
        catch (err) { toastr.warning(`Local model: ${String(err?.message ?? err)}`, 'Worlds Apart'); return; }
        const added = mergeLlmCands(e, cands, s);
        toastr[added ? 'success' : 'info'](added ? `${wiTitleOf(e)}: +${added} from model` : 'Model returned nothing usable — click ✨ to retry.', 'Worlds Apart');
        after(e);
    });
    const acceptSugg = (e, term, after = renderEntry) => {
        // Through keyWriteOk even verbatim: accepting must not skip the check the reword path applies.
        if (!keyWriteOk(term)) return;
        if (!Array.isArray(e.key)) e.key = [];
        if (!hasKey(e, term)) e.key.push(term);
        const g = getSugg(e.uid); g.tfidf = g.tfidf.filter(t => t !== term); g.llm = g.llm.filter(t => t !== term);
        save(); after(e);
    };
    // Editing is accepting; the original leaves the tray too.
    const acceptEdited = (e, oldTerm, newTerm) => {
        const g = getSugg(e.uid);
        g.tfidf = g.tfidf.filter(t => t !== oldTerm); g.llm = g.llm.filter(t => t !== oldTerm);
        acceptSugg(e, newTerm);
    };

    /**
     * Inline click-to-edit in place of `anchor`: commits on Enter and blur, cancels on Escape, fires `commit` once.
     * @param {(value: string, ok: boolean, viaBlur?: boolean) => boolean|void} commit Trimmed text; return false to refuse
     * @returns {{inp: HTMLInputElement, finish: (ok: boolean, viaBlur?: boolean) => void}}
     * A refusal keeps the editor open with its text, since commit fires on blur; width:auto in `css` is load-bearing, .text_pole being width:100%.
     */
    const inlineInput = (anchor, commit, { value = '', placeholder = '',
        css = 'margin:0;font-size:0.9em;width:auto;',
        fit = x => Math.min(64, Math.max(8, x.value.length + 2)) } = {}) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'text_pole';
        if (value) inp.value = value;
        if (placeholder) inp.placeholder = placeholder;
        inp.style.cssText = css;
        const size = () => { inp.size = fit(inp); };
        size();
        inp.addEventListener('input', size);
        let done = false;
        // Set before the commit runs: a commit repaints, and a blur fired on removal would re-enter and write twice.
        const finish = (ok, viaBlur) => {
            if (done) return;
            done = true;
            if (commit(inp.value.trim(), ok, viaBlur) === false) { done = false; if (!viaBlur) inp.focus(); }
        };
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); } });
        inp.addEventListener('blur', () => finish(true, true));
        anchor.replaceWith(inp); inp.focus(); inp.select();
        return { inp, finish };
    };

    const editKeyInline = (e, oldKey, span, list = 'key') => {
        inlineInput(span, (nv, ok) => {
            if (ok && nv && nv !== oldKey && !keyWriteOk(nv, list, e)) return false;
            if (ok && nv && nv !== oldKey && Array.isArray(e[list])) {
                const idx = e[list].indexOf(oldKey);
                // The dupe test skips the key being edited, or a case fix collides with itself and merges the key away.
                if (idx >= 0) { if (e[list].some((k, i) => i !== idx && kwNorm(k) === kwNorm(nv))) e[list].splice(idx, 1); else e[list][idx] = nv; save(); }
            }
            renderEntry(e);
        }, { value: oldKey });
    };

    // Book-wide ops on a keyword chip, case-insensitive like core's default scan; primary keys only.
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
        if (!next || next === key) return;   // exact-match only: a case-only rewrite is a real edit, not a no-op
        if (!keyWriteOk(next)) return;
        const n = kwNorm(key), nn = kwNorm(next); let touched = 0;
        for (const e of kwHits(key)) {
            const idx = e.key.findIndex(k => kwNorm(k) === n);
            if (idx < 0) continue;
            // not against the key being replaced, or a case fix collides with itself
            if (e.key.some((k, i) => i !== idx && kwNorm(k) === nn)) e.key.splice(idx, 1); else e.key[idx] = next;
            touched++;
        }
        if (touched) { save(); renderExplorer(); toastr.success(`Replaced “${key}” → “${next}” in ${touched} ${touched === 1 ? 'entry' : 'entries'}.`, 'Worlds Apart'); }
    };
    // A second term on every entry keyed `key` — the alias case.
    const addVariantEverywhere = async key => {
        const hits = kwHits(key);
        const raw = await Popup.show.input('Add variant', `Keyword to add to the ${hits.length} ${hits.length === 1 ? 'entry' : 'entries'} keyed “${key}”:`);
        const term = String(raw ?? '').trim();
        if (!term || !keyWriteOk(term)) return;
        let added = 0;
        for (const e of hits) if (!hasKey(e, term)) { e.key.push(term); added++; }
        if (added) { save(); renderExplorer(); }
        toastr[added ? 'success' : 'info'](added
            ? `“${term}” added to ${added} ${added === 1 ? 'entry' : 'entries'} keyed “${key}”.`
            : `Every entry keyed “${key}” already has “${term}”.`, 'Worlds Apart');
    };
    const toggleIgnore = key => { ignoreSet.has(key) ? ignoreSet.delete(key) : ignoreSet.add(key); persistIgnore(); afterIgnoreChange([key]); };
    // Menus mount in this popup's <dialog> so they stack above the modal.
    const ctxMount = () => pop?.dlg ?? document.body;
    const showKwMenu = (key, x, y) => showCtxMenu([
        { label: `Delete all (${kwHits(key).length})`, fn: () => deleteKeyEverywhere(key), danger: true },
        { label: 'Replace all…', fn: () => replaceKeyEverywhere(key) },
        { label: 'Add variant…', fn: () => addVariantEverywhere(key) },
        { label: ignoreSet.has(key) ? 'Un-ignore' : 'Ignore', fn: () => toggleIgnore(key) },
    ], x, y, ctxMount());
    const showEntryMenu = (e, x, y) => showCtxMenu([
        { label: 'Copy', fn: () => dupEntry(e) },
        { label: 'Copy to…', fn: () => copyEntryTo(e) },
        { label: 'Move to…', fn: () => moveEntryTo(e) },
        { label: 'Delete', fn: () => delEntry(e), danger: true },   // destructive → last, away from Copy
    ], x, y, ctxMount());

    /**
     * Rebuilds one entry's row in place; two collapse levels, the entry and then its text.
     * @param {HTMLElement} [mount] Parent for a row with no predecessor to replace
     * The row must be in the document before syncText, or the editor's autosize measures a detached textarea and bails.
     */
    const renderEntry = (e, mount) => {
        const flagged = scan ? new Map(scan.classifyEntry(e).map(r => [r.key, r])) : null;   // null = not scanned yet
        const open = entryOpen.has(e.uid);
        const row = document.createElement('div'); row.className = 'wa-entry';

        // --- Level 1 header ---
        const h = document.createElement('div'); h.className = 'wa-entry-head';
        const selBox = document.createElement('input'); selBox.type = 'checkbox'; selBox.className = 'wa-entry-sel';
        selBox.checked = selectedEntries.has(e.uid); selBox.title = 'Select for bulk actions';
        selBox.addEventListener('click', ev => {
            ev.stopPropagation();   // don't toggle collapse
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
        // A hand-built selection retires the Reselect offer.
        selBox.addEventListener('change', () => { lastSel = null; selBox.checked ? selectedEntries.add(e.uid) : selectedEntries.delete(e.uid); refreshBulkBar(); });
        const chev = document.createElement('i');
        chev.className = 'fa-solid fa-chevron-right wa-chevron' + (open ? ' wa-open' : '');
        chev.title = (open ? 'Collapse entry' : 'Expand entry') + ' — shift-click for all entries';
        // Shift toggles every OTHER entry; this one is left as-is.
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
        // Near-duplicate marker from the audit, advisory: it says "pick one", never which.
        const twins = scan?.dupes?.get(e.uid);
        const dupMark = twins?.length ? (() => {
            const dup = document.createElement('i');
            dup.className = 'fa-solid fa-clone wa-tool wa-badge';
            if (twins.length > 1) dup.dataset.badge = String(twins.length);
            dup.title = 'Near-duplicate of:\n' + twins.map(t =>
                `${Math.round(t.sim * 100)}% — ${t.title || `UID ${t.uid}`}${t.disabled ? ' (disabled)' : ''}`).join('\n');
            dup.addEventListener('click', ev => {
                ev.stopPropagation();
                const row = rowEls.get(twins[0].uid);
                if (!row) return;
                row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                row.classList.add('wa-flash'); setTimeout(() => row.classList.remove('wa-flash'), 1200);
            });
            return dup;
        })() : null;
        const pencil = document.createElement('i'); pencil.className = 'fa-solid fa-pencil wa-tool wa-title-edit'; pencil.title = 'Rename entry';
        pencil.addEventListener('click', ev => {
            ev.stopPropagation();
            const { inp, finish } = inlineInput(title, (nv, ok) => {
                if (ok && nv !== (e.comment ?? '')) { e.comment = nv; save(); }
                renderEntry(e);
            }, {
                value: e.comment ?? '', css: 'margin:0;font-size:0.95em;',
                fit: x => Math.max(6, x.value.length + 2),   // grow to the text so ✓ stays under the mouse
            });
            inp.addEventListener('click', e2 => e2.stopPropagation());
            const okBtn = document.createElement('i'); okBtn.className = 'fa-solid fa-check wa-tool'; okBtn.title = 'Confirm rename';
            okBtn.addEventListener('mousedown', e2 => e2.preventDefault());   // keep input focus so blur doesn't fire first
            okBtn.addEventListener('click', e2 => { e2.stopPropagation(); finish(true); });
            inp.after(okBtn);
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
        h.append(selBox, chev, mode, title, ...(dupMark ? [dupMark] : []), pencil, meta);
        // Collapsed-line badge: flagged-key count tinted by the worst flag; counts problems, not warnings (yellow, green).
        const RANK = { '#e06c6c': 3, '#d9b74a': 2, '#7bbf6a': 1 };   // red > yellow > green; '' (dead) = 0
        const SEV = { '#e06c6c': 'severe', '#d9b74a': 'moderate', '#7bbf6a': 'minor' };
        const counted = flagged ? [...flagged.values()].filter(v => { const c = scan.severityOf(v); return c !== '#d9b74a' && c !== '#7bbf6a'; }) : [];
        // Unusable secondaries count too, as severe: the entry gates on fewer keys than written.
        const secBad = scan ? scan.unusableKeysOf(e).length : 0;
        if (counted.length + secBad) {
            const badge = document.createElement('span'); badge.className = 'wa-entry-badge';
            badge.textContent = `${counted.length + secBad} flagged`;
            let worst = secBad ? WA_RED : '';
            for (const v of counted) { const c = scan.severityOf(v); if ((RANK[c] ?? 0) > (RANK[worst] ?? 0)) worst = c; }
            if (worst) { badge.style.background = worst; badge.style.color = worst === '#e06c6c' ? '#fff' : '#111'; }
            const softer = (flagged?.size ?? 0) - counted.length;
            // No colour means the uncoloured flag; name it from reasonOf.
            badge.title = `Keywords the last scan flagged — worst: ${SEV[worst] || scan.reasonOf(counted[0]).text}.${secBad ? ` Includes ${secBad} secondary key${secBad === 1 ? '' : 's'} the matcher cannot run.` : ''}${softer ? ` ${softer} more are warnings, not counted here.` : ''} Expand to see which.`;
            h.append(badge);
        }
        h.addEventListener('click', () => { open ? entryOpen.delete(e.uid) : entryOpen.add(e.uid); renderEntry(e); });
        h.addEventListener('contextmenu', ev => { ev.preventDefault(); showEntryMenu(e, ev.clientX, ev.clientY); });
        row.append(h);

        if (!open) {   // level-1 collapsed: title line only
            const old = rowEls.get(e.uid);
            if (old && old.isConnected) old.replaceWith(row); else mount?.append(row);
            rowEls.set(e.uid, row);
            return row;
        }

        h.append(buildEntryTools(e, renderEntry));

        const boltBtn = tool('fa-bolt', false, 'TF-IDF keyword suggestions', () => suggestTfidf(e, boltBtn));
        const llmBtn = tool('fa-wand-magic-sparkles', false, 'Local-model keyword suggestions', () => suggestLlm(e, llmBtn));

        const body = document.createElement('div'); body.className = 'wa-entry-body';

        // Keyword paragraph: chips coloured by verdict, click-to-edit, ✕ deletes, ➕ adds, then the suggestion chips.
        const para = document.createElement('div'); para.className = 'wa-kw-para';
        for (const key of (Array.isArray(e.key) ? e.key : [])) {
            const v = flagged?.get(key);
            let annot = '';
            const item = document.createElement('span'); item.className = 'wa-kw-item';   // chip + reason wrap as one
            const chip = document.createElement('span'); chip.className = 'wa-kw';
            const text = document.createElement('span'); text.className = 'wa-kw-text'; text.textContent = key;
            // Dead is dimmed with no label; ignored gets its own marking.
            const isDead = v && v.flag === 'unattested';
            const isIgnored = ignoreSet.has(key);
            // Tooltip wording comes from reasonOf even for dead: "not in entry text" and "not in entry text or chat" are different claims.
            const why = v && !isIgnored ? scan.reasonOf(v).text : '';
            if (isIgnored) { annot = 'ignored'; chip.classList.add('wa-kw-ignored'); }
            else if (v && !isDead) { const rc = scan.reasonOf(v); annot = why; if (rc.color) { chip.style.borderColor = rc.color; chip.style.background = `color-mix(in srgb, ${rc.color} 18%, transparent)`; } }
            else if (isDead) chip.classList.add('wa-kw-dead');
            else if (flagged) chip.style.borderColor = WA_GREEN;
            text.title = isIgnored ? `${key} — ignored (click to edit; shift-click ✕ to un-ignore)` : (v ? `${key} — ${why} (click to edit)` : `${key} (click to edit)`);
            text.addEventListener('click', () => editKeyInline(e, key, text));
            chip.append(text);   // term only inside the chip
            const del = document.createElement('i'); del.className = 'fa-solid fa-xmark wa-kw-del'; del.title = 'Delete keyword — shift-click to ignore it instead';
            del.addEventListener('click', ev => {
                if (ev.shiftKey) {   // whitelist toggle (mirrors the pruner's ban icon); tray lists/clears these
                    toggleIgnore(key);   // recolours every entry using this key and syncs the tray; no rescan
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
        // Candidate chips: ➕ takes the term as-is, clicking the text rewords it first; either commits on the spot.
        const g = sugg.get(e.uid);
        if (g) for (const [kind, terms] of [['tfidf', g.tfidf], ['llm', g.llm]]) for (const term of terms) {
            if (hasKey(e, term)) continue;
            const chip = document.createElement('span'); chip.className = 'wa-sugg';
            const take = document.createElement('i'); take.className = 'fa-solid fa-plus wa-sugg-add';
            take.title = `Add “${term}” to this entry`;
            take.addEventListener('click', () => acceptSugg(e, term));
            const t = document.createElement('span'); t.className = 'wa-sugg-text';
            t.textContent = (kind === 'llm' ? '✨ ' : '⚡ ') + term;
            t.title = `${term} — click to reword, then it's added`;
            t.addEventListener('click', () => inlineInput(t, (nv, ok) => {
                if (ok && nv && nv !== term) acceptEdited(e, term, nv); else renderEntry(e);
            }, { value: term }));
            chip.append(take, t); para.append(chip);
        }
        const add = document.createElement('i'); add.className = 'fa-solid fa-plus wa-tool'; add.title = 'Add a keyword';
        add.addEventListener('click', () => inlineInput(add, (nv, ok) => {
            if (ok && nv && !hasKey(e, nv) && !keyWriteOk(nv)) return false;
            if (ok && nv && !hasKey(e, nv)) { if (!Array.isArray(e.key)) e.key = []; e.key.push(nv); save(); }
            renderEntry(e);
        }, { placeholder: 'keyword' }));
        para.append(add, boltBtn, llmBtn);   // manual + first, then the suggestion triggers

        // --- Secondary keys: rendered only when present, and only the `unusable` verdict is painted, a gate not being a trigger.
        // ponytail: a secondary that matches nowhere is not painted; whether that is a fault depends on the logic.
        let secPara = null;
        if (Array.isArray(e.keysecondary) && e.keysecondary.length) {
            const gated = e.selective !== false;
            const bad = new Map((scan?.unusableKeysOf(e) ?? []).map(r => [r.key, r]));
            const sec = document.createElement('div');
            sec.className = 'wa-kw-para wa-kw-sec';

            // OFF is `selective: false`, not a fifth logic; switching off leaves `selectiveLogic` alone so switching back restores the operator.
            const logic = document.createElement('select'); logic.className = 'wa-mode';
            for (const [val, word, core] of LOGIC_OPTS) {
                const o = document.createElement('option'); o.value = val; o.textContent = word; o.title = core; logic.append(o);
            }
            logic.value = gated ? String(e.selectiveLogic ?? WI_LOGIC.AND_ANY) : 'off';
            logic.title = gated
                ? 'How the secondary keys gate the primaries above. They never activate on their own.'
                : 'Switched off: ST and Worlds Apart both ignore these keys. Pick an operator to gate on them again.';
            // A negation-only secondary changes meaning per operator with no visible change; warn at the moment it moves.
            const negOnly = e.keysecondary.filter(k => validateSmartKey(k).some(f => f.code === 'negation-only'));
            logic.addEventListener('change', () => {
                if (logic.value === 'off') { e.selective = false; }
                else { e.selective = true; e.selectiveLogic = Number(logic.value); }
                if (negOnly.length && logic.value !== 'off' && logic.value !== String(WI_LOGIC.AND_ALL)) {
                    const names = negOnly.join(', ');
                    toastr.warning(logic.value === String(WI_LOGIC.AND_ANY)
                        ? `${names} — a negation is satisfied by absence, so AND_ANY would never gate on it. Dropped under this operator; the key is kept, and counts again under any other.`
                        : `${names} — ${LOGIC_OPTS.find(o => o[0] === logic.value)?.[1]} negates the key again, so it now REQUIRES the term it excludes.`,
                    'Worlds Apart', { timeOut: 9000 });
                }
                save(); renderEntry(e);
            });
            sec.append(logic);
            for (const key of e.keysecondary) {
                const v = bad.get(key);
                const item = document.createElement('span'); item.className = 'wa-kw-item' + (gated ? '' : ' wa-off');
                const chip = document.createElement('span'); chip.className = 'wa-kw';
                const text = document.createElement('span'); text.className = 'wa-kw-text'; text.textContent = key;
                const why = v ? `unusable — ${v.code}` : '';
                if (v) { chip.style.borderColor = WA_RED; chip.style.background = `color-mix(in srgb, ${WA_RED} 18%, transparent)`; }
                // Green means the key is doing its job; a switched-off key takes the dimmed neutral instead.
                else if (scan && gated) chip.style.borderColor = WA_GREEN;
                text.title = v ? `${key} — ${v.message} (click to edit)` : `${key} (click to edit)`;
                text.addEventListener('click', () => editKeyInline(e, key, text, 'keysecondary'));
                chip.append(text);
                const del = document.createElement('i'); del.className = 'fa-solid fa-xmark wa-kw-del'; del.title = 'Delete this secondary key';
                del.addEventListener('click', () => { e.keysecondary.splice(e.keysecondary.indexOf(key), 1); save(); renderEntry(e); });
                chip.append(del);
                item.append(chip);
                if (why) { const r = document.createElement('span'); r.className = 'wa-kw-reason'; r.textContent = `(${why})`; item.append(r); }
                sec.append(item);
            }
            const addSec = document.createElement('i'); addSec.className = 'fa-solid fa-plus wa-tool'; addSec.title = 'Add a secondary key';
            addSec.addEventListener('click', () => inlineInput(addSec, (nv, ok) => {
                if (ok && nv && !keyWriteOk(nv, 'keysecondary', e)) return false;
                if (ok && nv && !e.keysecondary.some(k => kwNorm(k) === kwNorm(nv))) { e.keysecondary.push(nv); save(); }
                renderEntry(e);
            }, { placeholder: 'secondary key' }));
            sec.append(addSec);
            secPara = sec;
        }

        // --- Level 2: text section ---
        const textSec = document.createElement('div'); textSec.className = 'wa-text-sec';
        const thead = document.createElement('div'); thead.className = 'wa-text-head';
        const tchev = document.createElement('i');
        tchev.className = 'fa-solid fa-chevron-right wa-chevron' + (expanded.has(e.uid) ? ' wa-open' : '');
        const preview = document.createElement('span'); preview.className = 'wa-entry-preview'; preview.textContent = firstLine(e);
        thead.append(tchev, preview);
        // Text commits on blur; colours reflect the last scan, not the live edit.
        const fullWrap = document.createElement('div'); fullWrap.className = 'wa-full-wrap';
        const full = document.createElement('textarea'); full.className = 'wa-entry-full' + (tall.has(e.uid) ? ' wa-tall' : ''); full.value = String(e.content ?? '');
        const popBtn = document.createElement('i'); popBtn.className = 'wa-full-pop fa-solid ' + (tall.has(e.uid) ? 'fa-compress' : 'fa-expand');
        popBtn.title = tall.has(e.uid) ? 'Collapse editor to 8 rows' : 'Pop out editor to full height';
        // scrollHeight is 0 while detached and would collapse the editor, so skip until mounted.
        const autosize = () => { if (!full.isConnected) return; full.style.height = 'auto'; full.style.height = (full.scrollHeight + 2) + 'px'; };
        popBtn.addEventListener('click', () => {
            const isTall = full.classList.toggle('wa-tall');
            isTall ? tall.add(e.uid) : tall.delete(e.uid);
            popBtn.className = 'wa-full-pop fa-solid ' + (isTall ? 'fa-compress' : 'fa-expand');
            popBtn.title = isTall ? 'Collapse editor to 8 rows' : 'Pop out editor to full height';
            autosize();
        });
        full.addEventListener('input', autosize);
        // The ranker rebuilds on the next ⚡; the scan is deliberately left last-scan.
        full.addEventListener('blur', () => { if (full.value !== String(e.content ?? '')) { e.content = full.value; save(); suggest = null; preview.textContent = firstLine(e); } });
        fullWrap.append(popBtn, full);
        const syncText = () => { const t = expanded.has(e.uid); tchev.classList.toggle('wa-open', t); preview.style.display = t ? 'none' : ''; fullWrap.style.display = t ? '' : 'none'; if (t) autosize(); };
        thead.addEventListener('click', () => { expanded.has(e.uid) ? expanded.delete(e.uid) : expanded.add(e.uid); syncText(); });
        textSec.append(thead, fullWrap);
        body.append(textSec, para);   // entry text first, then keywords (reads more naturally)
        if (secPara) body.append(secPara);   // the gate reads under the keys it gates

        if (advOpen.has(e.uid)) body.prepend(buildAdvancedTray(e, renderEntry));   // above the text + keywords
        row.append(body);

        const old = rowEls.get(e.uid);
        // Carry the editor's scrollTop over from the replaced row, read before syncText's autosize resets it.
        const st = old?.querySelector('.wa-entry-full')?.scrollTop ?? 0;
        if (old && old.isConnected) old.replaceWith(row); else mount?.append(row);
        rowEls.set(e.uid, row);
        syncText();   // after mount, so an expanded editor's autosize sees a real scrollHeight
        if (st) full.scrollTop = st;
        return row;
    };

    /**
     * ⚙ Advanced tray: the core WI fields with no icon; edits commit on change and repaint with the tray open.
     * @param {(e: object) => void} repaint What to redraw after a change
     */
    const buildAdvancedTray = (e, repaint) => {
        const delay = Number(e.delay) || 0;
        const cooldown = Number(e.cooldown) || 0;
        const adv = document.createElement('div'); adv.className = 'wa-adv';
        const col = (heading, ...rows) => trayCol('wa-adv-col', 'wa-adv-sec', heading, ...rows);
        const chk = (label, get, set) => trayChk('wa-adv-row', label, get(), v => { set(v); save(); repaint(e); });
        const numRow = (label, get, set, placeholder) => {
            const l = document.createElement('label'); l.className = 'wa-adv-row';
            const s = document.createElement('span'); s.textContent = label;
            const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.className = 'text_pole'; inp.value = get(); if (placeholder) inp.placeholder = placeholder;
            inp.addEventListener('change', () => { set(inp.value); save(); repaint(e); });
            l.append(s, inp); return l;
        };
        const toMsg = v => Math.max(0, Math.floor(Number(v) || 0)) || null;   // 0/blank -> null (off), like core
        const recWarn = () => { const w = document.createElement('div'); w.className = 'wa-adv-warn'; w.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Recursion is off globally — these have no effect.'; return w; };
        // Tri-state select for the nullable match flags: Inherit / On / Off.
        const triSel = (label, get, set, globalOn) => {
            const l = document.createElement('label'); l.className = 'wa-adv-row';
            const s = document.createElement('span'); s.textContent = label; s.style.whiteSpace = 'nowrap';
            const sel = document.createElement('select'); sel.className = 'text_pole'; sel.style.cssText = 'width:auto;margin:0 0 0 auto;padding:2px 4px;';   // fit the option text, not text_pole's full width
            for (const [val, txt] of [['', `Inherit (${globalOn ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']]) sel.append(new Option(txt, val));
            const cur = get(); sel.value = cur === true ? 'on' : cur === false ? 'off' : '';
            sel.addEventListener('change', () => { set(sel.value === '' ? null : sel.value === 'on'); save(); repaint(e); });
            l.append(s, sel); return l;
        };
        const durLevel = (typeof e.delayUntilRecursion === 'number' && e.delayUntilRecursion > 0) ? e.delayUntilRecursion : '';
        adv.append(
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
                ...(document.querySelector('#world_info_recursive')?.checked ? [] : [recWarn()]),
            ),
            col('Budget / scan',
                chk('Ignore budget', () => !!e.ignoreBudget, v => e.ignoreBudget = v),
                numRow('Scan depth', () => (e.scanDepth ? e.scanDepth : ''), v => { const n = Math.floor(Number(v) || 0); e.scanDepth = n > 0 ? n : null; }, 'global'),
            ),
        );
        return adv;
    };

    /** New blank entry from core's createWorldInfoEntry — never a hand-rolled object, so the field set cannot drift. */
    const newEntry = () => {
        const ne = createWorldInfoEntry(selected, data);
        if (!ne) { toastr.warning('Couldn\'t create an entry — this book may be full.', 'Worlds Apart'); return; }
        save(); suggest = null; if (scan) rebuildScan();   // corpus changed -> ranker/scan stale
        entryOpen.add(ne.uid); expanded.add(ne.uid);
        renderExplorer();
        const row = rowEls.get(ne.uid);
        if (row) {
            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
            row.classList.add('wa-flash'); setTimeout(() => row.classList.remove('wa-flash'), 1200);
            row.querySelector('.wa-title-edit')?.click();   // straight into renaming it
        }
    };
    const dupEntry = e => {
        const ne = duplicateWorldInfoEntry(data, e.uid);
        if (!ne) return;
        save(); suggest = null; if (scan) rebuildScan(); renderExplorer();   // corpus changed -> ranker/scan stale
        // The copy sorts wherever its uid falls, often off-screen, so scroll to it and flash.
        const row = rowEls.get(ne.uid);
        if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.add('wa-flash'); setTimeout(() => row.classList.remove('wa-flash'), 1200); }
        toastr.success('Entry duplicated.', 'Worlds Apart');
    };
    const delEntry = async e => {
        if (!await deleteWorldInfoEntry(data, e.uid)) return;   // shows its own confirm
        // Drop the uid from the selection: core hands freed uids back out, so it would re-point at the next entry created.
        selectedEntries.delete(e.uid); lastSel?.delete(e.uid);
        save(); suggest = null; if (scan) rebuildScan(); sugg.delete(e.uid); rowEls.delete(e.uid); renderExplorer();
    };
    // Picks a target lorebook (any but the open one); null = cancelled.
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
    // Copies or moves entries to another book with one load and one save of the target; serves the context menu and the bulk bar.
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
            // Only what landed in the target is dropped; deleteWIOriginalDataValue keeps embedded-book originalData in sync.
            for (const e of copied) { deleteWIOriginalDataValue(data, String(e.uid)); delete data.entries[e.uid]; sugg.delete(e.uid); rowEls.delete(e.uid); selectedEntries.delete(e.uid); lastSel?.delete(e.uid); }
            save(); suggest = null; if (scan) rebuildScan(); renderExplorer();
        }
        toastr.success(`${deleteOriginal ? 'Moved' : 'Copied'} ${copied.length} to “${target}”.`, 'Worlds Apart');
    };
    const copyEntryTo = e => entriesToBook([e], false);
    const moveEntryTo = e => entriesToBook([e], true);

    // --- Book-level tools (explorer header) ---
    const matchSearch = e => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        const fields = [];
        if (searchScope.title) fields.push(String(wiTitleOf(e)));
        if (searchScope.entry) fields.push(String(e.content ?? ''));
        if (searchScope.keywords) fields.push((Array.isArray(e.key) ? e.key : []).join(' '));
        return !fields.length || fields.some(f => f.toLowerCase().includes(q));
    };
    const typeMatch = e => {
        switch (entryFilter) {
            case 'keyword': return !e.constant && !e.vectorized;
            case 'constant': return !!e.constant;
            case 'vector': return !!e.vectorized;
            case 'enabled': return !e.disable;
            case 'disabled': return !!e.disable;
            case 'flagged': return !!scan && (scan.classifyEntry(e).length > 0 || scan.unusableKeysOf(e).length > 0);
            default: return true;
        }
    };
    const filterMatch = e => matchSearch(e) && typeMatch(e);
    // Explorer display order: base sort, then tiered buckets by tierRank with base order kept within each.
    const sortEntries = list => {
        // 'insert' mirrors the prompt insertion order from settings; relevance keys have no rest-state score and degrade to order-asc.
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
    /** The default duplicate name: "X copy", then "X copy 2", … until one is free. */
    const freeCopyName = src => { const base = `${src} copy`; let name = base, i = 2; while (world_names.includes(name)) name = `${base} ${i++}`; return name; };
    const nameTaken = n => world_names.some(x => x.toLowerCase() === n.toLowerCase());

    // Copy an arbitrary book (open or not) to a free name. Returns the new name, or null.
    const copyBookByName = async (srcName, carryIgnored = false, asName = null) => {
        const src = (srcName === selected) ? data : await loadWorldInfo(srcName);
        if (!src) return null;
        const name = asName || freeCopyName(srcName);
        await saveWorldInfo(name, structuredClone(src), true);
        if (carryIgnored) {
            const from = settings().keywordIgnore?.[srcName];
            if (from?.length) { (settings().keywordIgnore ??= {})[name] = [...from]; saveSettingsDebounced(); }
        }
        return name;
    };

    /**
     * Confirms a duplication, asking whether the source's ignored terms come along (only when there are any).
     * @param {string|null} [defaultName] Editable target name — single-book duplication only
     * @returns {Promise<{ok: boolean, carry: boolean, name: string|null}>}
     */
    const confirmDuplicate = async (prompt, names, defaultName = null) => {
        const n = names.reduce((a, b) => a + (settings().keywordIgnore?.[b]?.length ?? 0), 0);
        const wrap = document.createElement('div'); wrap.style.textAlign = 'left';
        const msg = document.createElement('div'); msg.textContent = prompt; wrap.append(msg);
        let inp = null;
        if (defaultName != null) {
            const l = document.createElement('label'); l.style.cssText = 'display:block;margin-top:0.7em;';
            const t = document.createElement('div'); t.textContent = 'New lorebook name'; t.style.marginBottom = '0.2em';
            inp = document.createElement('input'); inp.type = 'text'; inp.className = 'text_pole'; inp.value = defaultName;
            inp.style.cssText = 'width:100%;margin:0;';
            l.append(t, inp); wrap.append(l);
        }
        let cb = null;
        if (n) {
            const l = document.createElement('label'); l.className = 'checkbox_label'; l.style.marginTop = '0.7em';
            cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
            const sp = document.createElement('span'); sp.textContent = `Also copy ${n} ignored term${n === 1 ? '' : 's'}`;
            l.append(cb, sp); wrap.append(l);
        }
        const res = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Duplicate', cancelButton: 'Cancel',
            // Returning false from onClosing keeps the dialog open with what was typed.
            onClosing: pp => {
                if (pp.result !== POPUP_RESULT.AFFIRMATIVE || !inp) return true;
                const v = inp.value.trim();
                if (!v) { toastr.warning('Give the copy a name.', 'Worlds Apart'); return false; }
                if (nameTaken(v)) { toastr.warning(`A lorebook named “${v}” already exists.`, 'Worlds Apart'); return false; }
                return true;
            },
        }).show();
        return { ok: res === POPUP_RESULT.AFFIRMATIVE, carry: !!cb?.checked, name: inp ? inp.value.trim() : null };
    };
    const dupBook = async () => {
        const ask = await confirmDuplicate(`Duplicate “${selected}”?`, [selected], freeCopyName(selected));
        if (!ask.ok) return;
        const name = await copyBookByName(selected, ask.carry, ask.name);
        if (!name) return;
        await updateWorldInfoList();
        renderBooks();
        toastr.success(`Duplicated to “${name}”.`, 'Worlds Apart');
        openBook(name);
    };
    const bulkCopyBooks = async () => {
        const names = [...selectedBooks]; if (!names.length) return;
        const { ok, carry } = await confirmDuplicate(`Duplicate ${names.length} ${names.length === 1 ? 'lorebook' : 'lorebooks'}?`, names);
        if (!ok) return;
        for (const n of names) await copyBookByName(n, carry);
        await updateWorldInfoList();
        selectedBooks.clear(); bookAnchor = null;
        renderBooks();
        toastr.success(`Duplicated ${names.length} ${names.length === 1 ? 'lorebook' : 'lorebooks'}.`, 'Worlds Apart');
    };
    // Deletes books, keeping snapshots for the nav undo bar; switches the open book away if it was among them.
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
            data = null; scan = null; suggest = null; entryOpen.clear(); expanded.clear(); tall.clear(); advOpen.clear(); sugg.clear(); selectedEntries.clear(); lastSel = null;
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
    /**
     * Re-points one closed chat's binding by round-tripping the whole chat through /api/chats/get and /api/chats/save; ST has no metadata-only write.
     * ponytail: the whole chat crosses the wire per binding; revisit if ST exposes a metadata-only endpoint.
     */
    const repointOne = async ({ char, avatar, file }, newName) => {
        const name = String(file ?? '').replace(/\.jsonl$/, '');
        if (!name) return false;
        try {
            const got = await fetch('/api/chats/get', {
                method: 'POST', headers: getRequestHeaders(), cache: 'no-cache',
                body: JSON.stringify({ ch_name: char, file_name: name, avatar_url: avatar }),
            });
            const chat = got.ok ? await got.json() : null;
            if (!Array.isArray(chat) || !chat.length) return false;
            chat[0].chat_metadata = { ...(chat[0].chat_metadata ?? {}), [METADATA_KEY]: newName };
            const put = await fetch('/api/chats/save', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ ch_name: char, file_name: name, avatar_url: avatar, chat }),
            });
            return put.ok;
        } catch (err) { console.error('[WA] repoint', name, err); return false; }
    };

    /** Re-points every character card whose primary lorebook is `oldName`, through /api/characters/merge-attributes (what /char-set runs), one card per call. */
    const repointCards = async (oldName, newName) => {
        const targets = (characters ?? []).filter(c => c?.avatar && c?.data?.extensions?.world === oldName);
        const moved = [], failed = [];
        for (const c of targets) {
            try {
                const r = await fetch('/api/characters/merge-attributes', {
                    method: 'POST', headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar: c.avatar, data: { extensions: { world: newName } } }),
                });
                (r.ok ? moved : failed).push(c.name ?? c.avatar);
            } catch (err) { console.error('[WA] repoint card', c.avatar, err); failed.push(c.name ?? c.avatar); }
        }
        if (moved.length) await getCharacters();   // ST's in-memory copy is now stale
        return { moved, failed };
    };

    const repointChats = async (oldName, newName) => {
        const moved = [], failed = [];
        const openFile = String(getContext().chatId ?? '');
        chatIndex = null;   // a rename invalidates it, and this is the one place that must not read stale
        for (const c of await loadChatIndex()) {
            for (const ch of c.chats) {
                if (ch?.chat_metadata?.world_info !== oldName) continue;
                const file = String(ch.file_name ?? '').replace(/\.jsonl$/, '');
                if (!file || file === openFile) continue;   // the open chat goes through saveMetadata
                (await repointOne({ char: c.char, avatar: c.avatar, file }, newName) ? moved : failed).push(file);
            }
        }
        chatIndex = null;   // the bindings just changed under it
        return { moved, failed };
    };

    // Renames a book and re-points every binding: global-select, charLore, every persona, the open chat, closed chats, character cards.
    const renameBook = async (srcName = selected, prefill = null) => {
        const oldName = srcName;
        const raw = await Popup.show.input('Rename lorebook', 'New name:', prefill ?? oldName);
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
            // Every persona, as core's updateWorldInfoLinks does: the active persona's binding lives in a different field from the rest.
            for (const p of Object.keys(power_user.personas ?? {})) {
                const d = power_user.persona_descriptions?.[p];
                if (d?.lorebook === oldName) d.lorebook = newName;
            }
            ctx.saveSettingsDebounced?.();
            if (wasChat && ctx.chatMetadata) { ctx.chatMetadata[METADATA_KEY] = newName; ctx.saveMetadata?.(); }
        } catch (err) { console.error('[WA] rename retarget', err); }
        runState.attachedWorlds = new Set([...runState.attachedWorlds].map(w => w === oldName ? newName : w));
        if (selectedBooks.delete(oldName)) selectedBooks.add(newName);
        const byBook = settings().studioSortByBook;   // saved sort view
        if (byBook?.[oldName]) { byBook[newName] = byBook[oldName]; delete byBook[oldName]; saveSettingsDebounced(); }
        const ign = settings().keywordIgnore;         // ignored terms
        if (ign?.[oldName]) { ign[newName] = ign[oldName]; delete ign[oldName]; saveSettingsDebounced(); }
        dirty = false;
        if (oldName === selected) { renderBooks(); openBook(newName); }
        else { renderBooks(); }
        const { moved, failed } = await repointChats(oldName, newName);
        const cards = await repointCards(oldName, newName);
        const bits = [];
        if (moved.length) bits.push(`${moved.length} ${moved.length === 1 ? 'chat' : 'chats'}`);
        if (cards.moved.length) bits.push(`${cards.moved.length} character ${cards.moved.length === 1 ? 'card' : 'cards'}`);
        const also = bits.length ? ` Re-pointed ${bits.join(' and ')}.` : '';
        toastr.success(`Renamed to “${newName}”.${also}`, 'Worlds Apart');
        const stuck = [...failed, ...cards.failed];
        if (stuck.length) toastr.warning(`Still bound to “${oldName}”: ${stuck.join(', ')}. Re-point by hand, or they will not see this book.`, 'Worlds Apart', { timeOut: 12000 });
    };
    // Batch TF-IDF into every entry's ⚡ chips; yields a frame first so the button can dim before the build.
    const suggestAll = btn => withBusy(btn, '0.5', async () => {
        await new Promise(r => setTimeout(r, 0));
        let s; try { s = ensureSuggest(); } catch { toastr.warning('Couldn\'t build suggestions.', 'Worlds Apart'); return; }
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
        renderExplorer();
        toastr[n ? 'success' : 'info'](n ? `Suggestions added to ${n} ${n === 1 ? 'entry' : 'entries'} — review the ⚡ chips.` : 'No TF-IDF suggestions to add.', 'Worlds Apart');
    });

    // One ✨ pass per visible non-empty entry, sequential: a small model serves one request at a time.
    const suggestAllLlm = btn => withBusy(btn, '0.5', async () => {
        const label = btn.innerHTML;
        let s; try { s = ensureSuggest(); } catch { toastr.warning('Couldn\'t build suggestions.', 'Worlds Apart'); return; }
        const targets = Object.values(data?.entries ?? {}).filter(filterMatch).filter(e => String(e.content ?? '').trim());
        let n = 0, i = 0;
        for (const e of targets) {
            btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${++i}/${targets.length}…`;
            let cands; try { cands = await llmKeyCandidates(e.content, s.avoid, suggestOpts.llmChunk); }
            catch (err) { toastr.warning(`Local model: ${String(err?.message ?? err)}`, 'Worlds Apart'); break; }
            if (mergeLlmCands(e, cands, s)) { n++; entryOpen.add(e.uid); }
        }
        btn.innerHTML = label;
        renderExplorer();
        toastr[n ? 'success' : 'info'](n ? `Model suggestions added to ${n} ${n === 1 ? 'entry' : 'entries'} — review the ✨ chips.` : 'Model returned nothing usable.', 'Worlds Apart');
    });

    // The term tabs' entry set: type filter + the shared sort, without the search — those tabs rank by it (rankBySearch).
    const visibleEntries = () => sortEntries(Object.values(data?.entries ?? {}).filter(typeMatch));

    /**
     * Term-tab search: keeps a group whose title, listed terms or (if scoped) text match, ranked title > term > text; rows are never filtered.
     * @param {Array<{entry: object, rows: Array<{term: string}>}>} groups
     */
    const rankBySearch = groups => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return groups;
        const rankOf = g => {
            if (searchScope.title && String(wiTitleOf(g.entry)).toLowerCase().includes(q)) return 0;
            if (searchScope.keywords && g.rows.some(r => r.term.toLowerCase().includes(q))) return 1;
            if (searchScope.entry && String(g.entry.content ?? '').toLowerCase().includes(q)) return 2;
            return -1;
        };
        return groups.map(g => ({ g, r: rankOf(g) })).filter(x => x.r >= 0)
            .sort((a, b) => a.r - b.r)   // stable, so the shared sort survives within each band
            .map(x => x.g);
    };

    // --- Shared header controls: the search box and type filter read and write the same state on every tab ---
    const buildSearchBox = onChange => {
        const wrap = document.createElement('span'); wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;';
        const search = document.createElement('input'); search.type = 'search'; search.className = 'text_pole wa-filter';
        search.placeholder = 'Search…'; search.value = searchQuery;
        search.style.cssText = 'width:11em;border-top-left-radius:0;border-bottom-left-radius:0;';
        let timer = null;   // debounce so a big book doesn't re-filter on every keystroke
        search.addEventListener('input', () => { searchQuery = search.value; clearTimeout(timer); timer = setTimeout(onChange, 180); });
        const scopeBtn = document.createElement('button'); scopeBtn.type = 'button'; scopeBtn.className = 'menu_button wa-filter';
        scopeBtn.style.cssText = 'width:auto;display:inline-flex;align-items:center;justify-content:center;margin:0 -1px 0 0;padding:3px 8px;border-top-right-radius:0;border-bottom-right-radius:0;';
        scopeBtn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
        const menu = document.createElement('div');
        menu.style.cssText = 'position:absolute;top:100%;left:0;z-index:5;display:none;flex-direction:column;gap:2px;margin-top:2px;padding:6px 8px;border-radius:5px;'
            + 'background:var(--SmartThemeBlurTintColor, var(--black70a, rgba(20,20,20,0.97)));border:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));';
        const SCOPES = [['title', 'Title'], ['entry', 'Entry'], ['keywords', 'Keywords']];
        const syncBtn = () => { const on = SCOPES.filter(([k]) => searchScope[k]).map(([, l]) => l); scopeBtn.title = `Search in: ${on.join(', ') || 'nothing selected'}`; };
        for (const [key, lbl] of SCOPES) {
            const l = document.createElement('label'); l.className = 'checkbox_label'; l.style.cssText = 'font-size:0.85em;white-space:nowrap;';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = searchScope[key];
            cb.addEventListener('change', () => { searchScope[key] = cb.checked; syncBtn(); onChange(); });
            const sp = document.createElement('span'); sp.textContent = lbl; l.append(cb, sp); menu.append(l);
        }
        syncBtn();
        scopeBtn.addEventListener('click', () => { menu.style.display = menu.style.display === 'none' ? 'flex' : 'none'; });
        // Close when focus leaves the group — no document-level listener to leak across re-renders.
        wrap.addEventListener('focusout', ev => { if (!wrap.contains(ev.relatedTarget)) menu.style.display = 'none'; });
        wrap.append(scopeBtn, search, menu);
        return wrap;
    };
    /**
     * The shared sort control over entrySort/tieredMode/tierCfg; "Insert Order" mirrors the insertion settings, and toggling tiered inside it forks to an explicit sort.
     * @param {() => void} onChange Repaint after a sort change
     */
    const buildSortControl = onChange => makeSortControl({
        getSort: () => entrySort, setSort: k => { entrySort = k; persistSortView(); },
        getTiered: () => entrySort === 'insert' ? !!settings().presentationTiered : tieredMode,
        setTiered: on => { if (entrySort === 'insert') { const k = normPresentation(settings().presentationOrder); entrySort = SORT_FNS[k] ? k : 'order-asc'; } tieredMode = on; persistSortView(); },
        getTierCfg: () => tierCfg, setTierCfg: cfg => { tierCfg = cfg; settings().tierCfg = cfg; saveSettingsDebounced(); },
        leadItems: [{ label: 'Insert Order', key: 'insert' }],
        onChange, mount: ctxMount,
    });

    // Entry-type filter: a custom dropdown, not a <select>, so options can carry FA icons.
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
    const buildFilterBtn = onChange => {
        const wrap = document.createElement('span'); wrap.style.cssText = 'position:relative;display:inline-flex;';
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'menu_button wa-filter';
        btn.title = 'Show only entries of a type'; btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;width:auto;white-space:nowrap;';
        const cur = FILTER_OPTS.find(o => o[0] === entryFilter) ?? FILTER_OPTS[0];
        const lbl = document.createElement('span'); lbl.textContent = cur[2];
        btn.append(iconEl('fa-filter'), lbl);
        const menu = document.createElement('div');
        menu.style.cssText = 'position:absolute;top:100%;left:0;z-index:5;display:none;flex-direction:column;gap:1px;margin-top:2px;padding:4px;border-radius:5px;min-width:9em;'
            + 'background:var(--SmartThemeBlurTintColor, var(--black70a, rgba(20,20,20,0.97)));border:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));';
        for (const [val, spec, text] of FILTER_OPTS) {
            const item = document.createElement('button'); item.type = 'button';
            item.style.cssText = 'display:flex;align-items:center;gap:7px;width:100%;padding:4px 8px;border:none;border-radius:4px;background:' + (val === entryFilter ? 'var(--white20a, rgba(255,255,255,0.1))' : 'transparent') + ';color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer;';
            if (val === entryFilter) item.style.fontWeight = 'bold';
            const t = document.createElement('span'); t.textContent = text; item.append(iconEl(spec), t);
            item.addEventListener('mouseenter', () => { if (val !== entryFilter) item.style.background = 'var(--white20a, rgba(255,255,255,0.1))'; });
            item.addEventListener('mouseleave', () => { if (val !== entryFilter) item.style.background = 'transparent'; });
            item.addEventListener('click', () => { entryFilter = val; onChange(); });
            menu.append(item);
        }
        btn.addEventListener('click', () => { menu.style.display = menu.style.display === 'none' ? 'flex' : 'none'; });
        wrap.addEventListener('focusout', ev => { if (!wrap.contains(ev.relatedTarget)) menu.style.display = 'none'; });
        wrap.append(btn, menu);
        return wrap;
    };

    /**
     * Entry group header for the term list: whole-entry checkbox, glyph, title, count, view, tool row.
     * @param {{row: Map, grp: object[]}} reg Checkbox registry, so a tick updates in place without a rebuild
     * @param {() => void} onChange Re-syncs the boxes; `onEntryChange` rebuilds the list, which the tools need
     */
    const termGroupHeader = (e, rows, checks, reg, onChange, onEntryChange, extraActs = []) => {
        const head = document.createElement('div'); head.className = 'wa-term-grp';
        const ids = rows.map(r => rowId(e.uid, r.term));
        if (ids.length) {
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.margin = '0';
            cb.addEventListener('change', () => { for (const id of ids) checks.set(id, cb.checked); onChange(); });
            reg.grp.push({ cb, ids });
            head.append(cb);
        } else {
            const pad = document.createElement('span'); pad.style.width = '13px'; head.append(pad);   // keep titles aligned
        }
        const glyph = document.createElement('span'); glyph.textContent = wiGlyph(e);
        glyph.title = e.constant ? 'Constant' : e.vectorized ? 'Vectorized' : 'Keyword';
        glyph.style.cssText = 'flex:0 0 auto;font-size:0.85em;';
        const title = document.createElement('span'); title.textContent = wiTitleOf(e); title.title = wiTitleOf(e);
        title.style.cssText = `flex:0 1 auto;min-width:3em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${e.disable ? 'opacity:0.5;' : ''}`;
        const meta = document.createElement('span'); meta.className = 'wa-tab-count'; meta.style.flex = '0 0 auto';
        meta.textContent = rows.length ? `${rows.length} term${rows.length === 1 ? '' : 's'}` : 'no candidates';
        const view = document.createElement('i'); view.className = 'fa-solid fa-file-lines wa-term-act';
        view.title = 'View this entry\'s text';
        view.addEventListener('click', () => showEntryText(e));
        head.append(glyph, title, meta, view, ...extraActs.map(f => f(e)), buildEntryTools(e, onEntryChange, { compact: true }));
        return head;
    };
    const termRow = (e, r, checks, reg, onChange, onContext = null) => {
        const row = document.createElement('div'); row.className = 'wa-term-row';
        const id = rowId(e.uid, r.term);
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.margin = '0';
        cb.addEventListener('change', () => { checks.set(id, cb.checked); onChange(); });
        reg.row.set(id, cb);
        const name = document.createElement('span'); name.className = 'wa-term-name';
        name.textContent = r.term; name.title = r.term;
        const why = document.createElement('span'); why.className = 'wa-term-why';
        why.textContent = r.why ?? ''; if (r.color) why.style.color = r.color;
        if (onContext) row.addEventListener('contextmenu', ev => { ev.preventDefault(); onContext(e, r, ev.clientX, ev.clientY); });
        row.append(cb, name, why);
        return row;
    };
    // Push `checks` back into the rendered boxes (rows, then group tri-states) without rebuilding rows.
    const syncTermChecks = (checks, reg) => {
        for (const [id, cb] of reg.row) cb.checked = !!checks.get(id);
        for (const g of reg.grp) {
            const on = g.ids.filter(id => checks.get(id)).length;
            g.cb.checked = on > 0 && on === g.ids.length;
            g.cb.indeterminate = on > 0 && on < g.ids.length;
        }
    };
    const emptyNote = text => { const d = document.createElement('div'); d.style.cssText = 'opacity:0.6;padding:10px 4px;'; d.textContent = text; return d; };
    /**
     * The book's ignored terms as removable chips, pinned in the term tabs where an ignored term is otherwise invisible.
     * @param {HTMLElement} host Container to (re)fill
     */
    const paintIgnoredStrip = (host, onChange) => {
        host.innerHTML = '';
        if (!ignoreSet.size) { host.style.display = 'none'; return; }
        host.style.display = 'flex';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'opacity:0.7;font-size:0.85em;white-space:nowrap;';
        lbl.textContent = `Ignored (${ignoreSet.size}):`;
        host.append(lbl);
        for (const key of [...ignoreSet].sort()) {
            const chip = document.createElement('span'); chip.className = 'wa-kw wa-kw-ignored';
            const t = document.createElement('span'); t.className = 'wa-kw-text'; t.textContent = key; t.style.cursor = 'default';
            const x = document.createElement('i'); x.className = 'fa-solid fa-xmark wa-kw-del'; x.title = 'Stop ignoring this term';
            x.addEventListener('click', () => { ignoreSet.delete(key); persistIgnore(); onChange(); if (trayOpen) refreshTray(); });
            chip.append(t, x); host.append(chip);
        }
    };
    // --- Cleanup tab ---
    /** Confirms which chats to scan, pre-ticked by binding; global candidates and the open chat start unticked. */
    const pickChats = async candidates => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'text-align:left;max-width:44rem;';
        wrap.innerHTML = `<h3 style="margin:0 0 0.3em;">Check keys against which chats?</h3>`
            + `<small style="display:block;opacity:0.75;margin-bottom:0.6em;">Keys flagged “not in entry text” are checked against these. A key that fires somewhere is doing its job — usually an alias your prose never spells out. Only the chats you tick are read.</small>`;
        const rows = candidates.map((c, i) => {
            const lab = document.createElement('label');
            lab.className = 'checkbox_label';
            lab.style.cssText = 'display:flex;gap:0.5em;align-items:baseline;margin:0.15em 0;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!c.bound;   // bound chats on; global candidates and the merely-open one off
            cb.dataset.i = String(i);
            const txt = document.createElement('span');
            txt.innerHTML = `${escapeHtml(c.file.replace(/\.jsonl$/, ''))} <small style="opacity:0.6;">· ${escapeHtml(String(c.char || ''))} · ${escapeHtml(String(c.size))} · ${escapeHtml(c.why)}</small>`;
            lab.append(cb, txt);
            wrap.append(lab);
            return cb;
        });
        const tot = document.createElement('div');
        tot.style.cssText = 'margin-top:0.6em;opacity:0.8;font-size:0.9em;';
        const syncTot = () => {
            const on = rows.filter(cb => cb.checked).length;
            tot.textContent = `${on} chat(s) selected`;
        };
        rows.forEach(cb => cb.addEventListener('change', syncTot));
        wrap.append(tot); syncTot();
        if (candidates.isGlobal) {
            const g = document.createElement('small');
            g.style.cssText = 'display:block;opacity:0.75;margin-top:0.4em;';
            g.textContent = 'This book is globally active, so it reaches every chat — all of them are listed, none pre-ticked. Tick only the ones whose history is relevant.';
            wrap.append(g);
        }
        const pop = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Scan selected', cancelButton: 'Cancel', wide: false });
        if (await pop.show() !== POPUP_RESULT.AFFIRMATIVE) return null;
        return rows.filter(cb => cb.checked).map(cb => candidates[Number(cb.dataset.i)]);
    };

    let chatIndex = null;   // [{ char, avatar, charWorld, chats }], cached for the Studio session and book-independent
    const loadChatIndex = async () => {
        if (chatIndex) return chatIndex;
        const list = (characters ?? []).filter(c => c?.avatar);
        // Parallel: independent reads, one round-trip each.
        chatIndex = await Promise.all(list.map(async c => {
            let chats = [];
            try {
                const r = await fetch('/api/characters/chats', {
                    method: 'POST', headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: c.avatar, metadata: true }),
                });
                if (r.ok) { const j = await r.json(); if (Array.isArray(j)) chats = j; }
            } catch { /* a character with no chats dir just yields nothing */ }
            return { char: c.name, avatar: c.avatar, charWorld: c?.data?.extensions?.world ?? null, chats };
        }));
        return chatIndex;
    };

    const findBookChats = async () => {
        // A book binds three ways: chat (chat_metadata.world_info), character (data.extensions.world), global (selected_world_info, never pre-ticked).
        const isGlobal = (selected_world_info ?? []).includes(selected);
        const out = [];
        for (const c of await loadChatIndex()) {
            const charBound = c.charWorld === selected;
            for (const ch of c.chats) {
                const chatBound = ch?.chat_metadata?.world_info === selected;
                if (!chatBound && !charBound && !isGlobal) continue;
                out.push({ char: c.char, avatar: c.avatar, file: ch.file_name, size: ch.file_size ?? '?',
                    why: chatBound ? 'chat-bound' : charBound ? 'character-bound' : 'global (book is always active)',
                    bound: chatBound || charBound });
            }
        }
        out.isGlobal = isGlobal;
        return out;
    };

    /** No-plugin path: pulls a chat's messages over HTTP. */
    const fetchChatMessages = async ({ char, avatar, file }) => {
        const r = await fetch('/api/chats/get', {
            method: 'POST', headers: getRequestHeaders(), cache: 'no-cache',
            body: JSON.stringify({ ch_name: char, file_name: String(file).replace(/\.jsonl$/, ''), avatar_url: avatar }),
        });
        if (!r.ok) return [];
        const j = await r.json();
        return (Array.isArray(j) ? j : []).map(m => String(m?.mes ?? '')).filter(Boolean);
    };

    /** Scans the chosen chats and installs the counts — the one gatherer for the picker and the audit; returns a summary, no toast or repaint. */
    const scanChats = async (picked, label) => {
        // Literals only: one Aho-Corasick pass over folded literals, so a `?` or /regex/ key is omitted (reads as "not checked"), never reported absent.
        const keys = bookKeys().filter(k => !k.startsWith('?') && !isRegexKey(k));
        if (!keys.length || !picked?.length) return null;

        // Plugin route first: it scans where the files live and returns counts only.
        const onDisk = picked.filter(c => !c.open && c.avatar);
        if (runState.pluginAvailable && onDisk.length === picked.length) {
            const r = await fetch('/api/plugins/worlds-apart/scan-chats', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ keys, chats: onDisk.map(c => ({ dir: c.avatar.replace(/\.png$/, ''), file: c.file })) }),
            });
            if (r.ok) {
                const j = await r.json();
                const seen = Number(j.messages) || 0;
                // 0 messages means the route resolved no files; installing it would zero every key's share.
                if (!seen) { console.warn('Worlds Apart: /scan-chats read 0 messages', j); return null; }
                chatHits = new Map(keys.map(k => [k, Number(j.counts?.[k]) || 0]));
                chatMsgs = seen;
                chatName = label;
                return { keys, live: [...chatHits.values()].filter(n => n > 0).length, via: 'server' };
            }
            console.warn('Worlds Apart: /scan-chats unavailable, falling back to client-side scan');
        }

        const ctx = getContext();
        const msgs = [];
        for (const c of picked) {
            const got = c.open
                ? (ctx.chat ?? []).filter(m => m && !m.is_system).map(m => String(m.mes ?? '')).filter(Boolean)
                : await fetchChatMessages(c);
            msgs.push(...got);
        }
        if (!msgs.length) return null;
        const folded = [...new Set(keys.map(fold))];
        const idxOf = new Map(folded.map((f, i) => [f, i]));
        const aut = buildAutomaton(folded);
        const counts = new Map();
        // Same accumulator the server route uses — a hit is a message, and the two must not drift.
        for (const t of msgs) addMessageHits(aut, t, counts);
        chatHits = new Map(keys.map(k => [k, counts.get(idxOf.get(fold(k))) ?? 0]));
        chatMsgs = msgs.length;
        chatName = label;
        return { keys, live: [...chatHits.values()].filter(n => n > 0).length, via: 'client' };
    };

    /** Every chat BOUND to this book; excludes chats that qualify only because the book is global. */
    const boundChats = async () => {
        let bound = (await findBookChats()).filter(c => c.bound);
        // The index is session-cached, so a chat bound since reads as absent: drop the cache and look again.
        if (!bound.length) { chatIndex = null; bound = (await findBookChats()).filter(c => c.bound); }
        return bound;
    };

    const runChatScan = async () => {
        if (!scan) { toastr.info('Run the audit first.', 'Worlds Apart'); return; }
        toastr.info('Finding chats that use this book…', 'Worlds Apart', { timeOut: 2000 });
        const found = await findBookChats();
        // The open chat is offered too, unticked, for the case the metadata does not capture — never assumed.
        const ctx = getContext();
        const openName = String(ctx.chatId ?? '');
        if (openName && !found.some(f => f.file.startsWith(openName))) {
            found.push({ char: ctx.name2 ?? '', avatar: null, file: openName, size: `${(ctx.chat ?? []).length} msgs`, why: 'currently open', open: true });
        }
        if (!found.length) { toastr.warning(`No chat uses "${selected}" — it is not bound to any chat or character, and not globally active. Bind it, or open a chat that uses it.`, 'Worlds Apart', { timeOut: 9000 }); return; }
        if (!found.some(f => f.bound) && !found.isGlobal) { toastr.info(`"${selected}" is not bound to any chat; only the open one is offered.`, 'Worlds Apart', { timeOut: 6000 }); }

        const picked = await pickChats(found);
        if (!picked?.length) return;
        const label = picked.length === 1 ? picked[0].file.replace(/\.jsonl$/, '') : `${picked.length} chats`;
        const got = await scanChats(picked, label);
        if (!got) { toastr.warning('Those chats returned no messages.', 'Worlds Apart'); return; }
        toastr.success(`${got.live} of ${got.keys.length} fire in "${label}" (${chatMsgs} messages${got.via === 'server' ? ', scanned server-side' : ''}).`, 'Worlds Apart', { timeOut: 6000 });
        afterChatScan(got.keys);
    };

    /** What both audit buttons do: scan every bound chat through the same gatherer (skipped once a scan exists), then re-derive. */
    const runAudit = async () => {
        let got = null, bound = [];
        if (!chatHits) {
            bound = await boundChats();
            if (bound.length) {
                const label = bound.length === 1 ? bound[0].file.replace(/\.jsonl$/, '') : `${bound.length} chats`;
                got = await scanChats(bound, label);
            }
        }
        rebuildScan();
        console.log('Worlds Apart: audit evidence —', {
            book: selected, matchWindow: settings().matchWindow, boundChats: bound.length,
            scanned: got?.via ?? 'none', messages: chatMsgs, keys: chatHits?.size ?? 0, firing: got?.live ?? 0,
        });
        if (got) {
            toastr.success(`Audited against entry text + "${chatName}" — ${got.live} of ${got.keys.length} keys fire in its ${chatMsgs} messages.`, 'Worlds Apart', { timeOut: 6000 });
        } else if (!chatHits) {
            toastr.info(`Audited against entry text only — no chat is bound to "${selected}". Cleanup → "Check against chats" can search the open chat, or every chat if the book is globally active.`, 'Worlds Apart', { timeOut: 8000 });
        }
    };

    const cleanupGroups = () => {
        if (!scan) return [];
        const out = [];
        for (const e of visibleEntries()) {
            const rows = scan.classifyEntry(e).map(p => {
                const rc = scan.reasonOf(p);
                const id = rowId(e.uid, p.key);
                if (!cleanupChecks.has(id)) cleanupChecks.set(id, scan.defChecked(p));   // pre-tick policy shared with the pruner
                return { term: p.key, why: rc.text, color: rc.color, p };
            });
            // Show-all appends the keys classifyEntry did not return; flagged rows stay on top.
            if (cleanupShowAll) {
                const shown = new Set(rows.map(r => r.term));
                for (const key of (Array.isArray(e.key) ? e.key : [])) {
                    if (shown.has(key)) continue;
                    shown.add(key);
                    const id = rowId(e.uid, key);
                    if (!cleanupChecks.has(id)) cleanupChecks.set(id, false);   // never pre-tick what the audit didn't flag
                    rows.push({ term: key, why: ignoreSet.has(key) ? 'ignored' : 'not flagged', color: '' });
                }
            }
            if (rows.length) out.push({ entry: e, rows });
        }
        return rankBySearch(out);
    };
    const pruneChecked = () => {
        const removed = [];
        for (const g of cleanupGroups()) {
            for (const r of g.rows) {
                const id = rowId(g.entry.uid, r.term);
                if (!cleanupChecks.get(id)) continue;
                const i = (Array.isArray(g.entry.key) ? g.entry.key : []).indexOf(r.term);
                if (i < 0) continue;
                g.entry.key.splice(i, 1);
                removed.push({ uid: g.entry.uid, key: r.term });
                cleanupChecks.delete(id);
            }
        }
        if (!removed.length) { toastr.info('Nothing selected to prune.', 'Worlds Apart'); return; }
        cleanupUndo = removed;
        save(); rebuildScan(); suggest = null; renderExplorer();
        toastr.success(`Pruned ${removed.length} keyword${removed.length === 1 ? '' : 's'}. Undo is in the bar until the next prune.`, 'Worlds Apart');
    };
    const undoPrune = () => {
        if (!cleanupUndo?.length) return;
        let n = 0;
        for (const { uid, key } of cleanupUndo) {
            const e = data?.entries?.[uid]; if (!e) continue;
            if (!Array.isArray(e.key)) e.key = [];
            if (!hasKey(e, key)) { e.key.push(key); n++; }
        }
        cleanupUndo = null;
        save(); rebuildScan(); suggest = null; renderExplorer();
        toastr.success(`Restored ${n} keyword${n === 1 ? '' : 's'}.`, 'Worlds Apart');
    };
    // Whitelists the ticked terms — persistent, where unticking spares a term for this run only.
    const ignoreChecked = () => {
        let n = 0;
        for (const g of cleanupGroups()) for (const r of g.rows) {
            if (cleanupChecks.get(rowId(g.entry.uid, r.term)) && !ignoreSet.has(r.term)) { ignoreSet.add(r.term); n++; }
        }
        if (!n) { toastr.info('Nothing selected to ignore.', 'Worlds Apart'); return; }
        persistIgnore(); rebuildScan(); renderExplorer();
        toastr.success(`Now ignoring ${n} term${n === 1 ? '' : 's'} in "${selected}" — they won't be flagged again.`, 'Worlds Apart');
    };
    // Both term tabs paint a working note, yield a frame, then run the synchronous pre-pass.
    const yieldFrame = () => new Promise(r => setTimeout(r, 0));

    const renderCleanupView = async pane => {
        const head = document.createElement('div'); head.className = 'wa-studio-exphead';
        head.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:6px;';
        const row1 = document.createElement('div'); row1.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const bookLbl = document.createElement('b'); bookLbl.textContent = selected;
        bookLbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:16em;';
        row1.append(bookLbl);
        const auditBtn = document.createElement('button'); auditBtn.type = 'button'; auditBtn.className = 'menu_button';
        auditBtn.innerHTML = `<i class="fa-solid fa-stethoscope"></i> ${scan ? 'Re-audit' : 'Run audit'}`;
        auditBtn.title = chatHits
            ? `Re-run the keyword audit with the current Tool Settings.\nChat evidence: "${chatName}", ${chatMsgs} messages.`
            : 'Re-run the keyword audit with the current Tool Settings.\nNo chat searched yet.';
        auditBtn.addEventListener('click', async () => { await runAudit(); renderExplorer(); });
        // Search repaints only the list: rebuilding the header would drop the input's focus mid-keystroke.
        row1.append(auditBtn, buildFilterBtn(renderExplorer), buildSortControl(() => repaint()), buildSearchBox(() => repaint()));
        head.append(row1);
        const fixed = document.createElement('div'); fixed.className = 'wa-studio-fixed';
        trayEl = renderTray();
        const bar = document.createElement('div'); bar.className = 'wa-bulk-on';
        const ignStrip = document.createElement('div'); ignStrip.className = 'wa-ign-strip';
        fixed.append(head, trayEl, bar, ignStrip);
        const list = document.createElement('div'); list.className = 'wa-studio-entries';
        pane.append(fixed, list);

        let groups = [], allIds = [], reg = { row: new Map(), grp: [] };
        // Repaints the list, not just the bar: it changes which rows exist.
        const showAllBtn = () => {
            const b = barBtn(cleanupShowAll ? 'Flagged only' : 'Show all terms', () => { cleanupShowAll = !cleanupShowAll; repaint(); });
            b.title = cleanupShowAll ? 'List only the keys the audit flagged' : 'List every key on every visible entry, flagged or not';
            return b;
        };
        const paintBar = () => {
            const on = allIds.filter(id => cleanupChecks.get(id)).length;
            const allOn = allIds.length > 0 && on === allIds.length;
            bar.innerHTML = '';
            const count = document.createElement('span'); count.className = 'wa-bulk-count';
            count.textContent = `${on} of ${allIds.length} ${cleanupShowAll ? '' : 'flagged '}term${allIds.length === 1 ? '' : 's'} selected`;
            count.title = 'Pre-ticked terms are suggestions, not verified problems. "Not in entry text" means exactly that — keys match against the chat, so a key your story uses but your prose never spells out reads as dead and is usually worth keeping. Review before applying.';
            bar.append(count,
                barBtn(allOn ? 'Select none' : 'Select all', () => {
                    for (const id of allIds) cleanupChecks.set(id, !allOn);
                    sync();
                }),
                barBtn('Prune selected', pruneChecked, 'wa-bulk-danger'),
                barBtn('Ignore selected', ignoreChecked),
                showAllBtn(),
                barBtn(chatHits ? 'Re-check chats' : 'Check against chats', () => runChatScan().catch(e => { console.error('Worlds Apart: chat scan failed', e); toastr.error(String(e?.message ?? e), 'Worlds Apart'); })),
            );
            if (chatHits) {
                const note = document.createElement('span'); note.className = 'wa-bulk-count';
                note.textContent = `· ${[...chatHits.values()].filter(n => n > 0).length}/${chatHits.size} fire in "${chatName}" (${chatMsgs} msgs)`;
                note.title = `Counts come from "${chatName}" only. A key with 0 hits there may still be used in another chat that shares this book — check each one.`;
                bar.append(note);
            }
            if (cleanupUndo?.length) bar.append(barBtn(`Undo (${cleanupUndo.length})`, undoPrune));
        };
        const sync = () => { syncTermChecks(cleanupChecks, reg); paintBar(); };
        const repaint = () => {
            paintIgnoredStrip(ignStrip, repaint);   // classifyEntry reads ignoreSet live — no rescan needed
            groups = cleanupGroups();
            allIds = groups.flatMap(g => g.rows.map(r => rowId(g.entry.uid, r.term)));
            reg = { row: new Map(), grp: [] };
            list.innerHTML = '';
            if (!scan) list.append(emptyNote('Run the audit to flag weak keywords — tune what counts as weak under Tool Settings.'));
            else if (!groups.length) list.append(emptyNote(cleanupShowAll ? 'The visible entries have no keywords at all.' : 'No flagged keywords in the visible entries — “Show all terms” lists the rest.'));
            else for (const g of groups) {
                list.append(termGroupHeader(g.entry, g.rows, cleanupChecks, reg, sync, repaint));
                if (advOpen.has(g.entry.uid)) list.append(buildAdvancedTray(g.entry, repaint));
                for (const r of g.rows) list.append(termRow(g.entry, r, cleanupChecks, reg, sync,
                    (e, row, x, y) => showKwMenu(row.term, x, y)));
            }
            sync();
        };
        termRepaint = repaint;
        if (!scan) {
            bar.textContent = 'Auditing…';
            list.append(emptyNote('Auditing keywords…'));
            await yieldFrame();
            if (!pane.isConnected || tab !== 'cleanup') return;   // switched away while we were blocked
            // runAudit, not rebuildScan: an audit that gathered no chat evidence is a different audit from the Explorer's.
            await runAudit();
            auditBtn.innerHTML = '<i class="fa-solid fa-stethoscope"></i> Re-audit';
        }
        repaint();
    };

    // --- Keyword Lab: any keys against any text, with no entry and no book behind them ---
    /** A key's colour is its position in the list: one hue per family — blue, green, magenta, orange, cyan, violet, yellow —
     *  since two hues from one family are hard to tell apart however far apart the numbers are. Clear of red, severity here.
     *  A second pass over the same hues in pastel gives fourteen before a colour repeats. */
    const LAB_HUES = [215, 120, 305, 35, 180, 265, 58];
    const labInk = (i, a = 1) => {
        const pastel = i % (LAB_HUES.length * 2) >= LAB_HUES.length;
        return `hsl(${LAB_HUES[i % LAB_HUES.length]} ${pastel ? 45 : 80}% ${pastel ? 68 : 50}%${a < 1 ? ` / ${a}` : ''})`;
    };

    /** The haystack with every span wrapped, in the colour of the first key that reached it; the rest are named in the tooltip.
     *  Offsets are keyExcerpts', which are into the NFC form. */
    const markedHtml = (text, spans, ink) => {
        const src = String(text).normalize('NFC');
        let html = '', at = 0;
        for (const sp of spans) {
            // A negated span is what stopped a key, not what matched it: WA_RED, the same colour severity wears in the Explorer.
            const fill = sp.negated ? `color-mix(in srgb, ${WA_RED} 28%, transparent)` : ink(sp.key, 0.28);
            const edge = sp.negated ? WA_RED : ink(sp.key);
            const label = k => `${k.negated ? '\u2212 ' : ''}${k.term && k.term !== k.key ? `${k.key} \u2014 ${k.term}` : k.key}`;
            html += escapeHtml(src.slice(at, sp.start))
                + `<span title="${escapeHtml(sp.keys.map(label).join('\n'))}"`
                + ` style="background:${fill};border-bottom:2px solid ${edge};">${escapeHtml(src.slice(sp.start, sp.end))}</span>`;
            at = sp.end;
        }
        return html + escapeHtml(src.slice(at));
    };

    let labHay = '', labKeys = '';
    let labCase = !!world_info_case_sensitive, labWhole = !!world_info_match_whole_words;
    // The unit a key must match within, as the running setting has it. A pasted text has no messages, so `message` is
    // `scan` here; it is still offered, and still stored, because it is the setting the Lab is standing in for.
    let labWindow = settings().matchWindow;
    // The secondary condition, in core's own terms: a term list and one of world_info_logic's four operators, gating every key.
    let labSec = '', labLogic = String(WI_LOGIC.AND_ANY);

    /** The chat as WA reads it for a scan: is_system gone, dropChatTags applied, the depth setting's last messages, names
     *  included as core would. Joined with a blank line, so the paragraph window breaks at a message boundary as it does live. */
    const chatHaystack = () => {
        const spec = settings().dropChatTags;
        const chat = (getContext().chat ?? [])
            .filter(m => m && !m.is_system)
            .map(m => (spec?.trim() ? { ...m, mes: dropTags(String(m.mes ?? ''), spec) } : m));
        const depth = Number(settings().messageDepth || world_info_depth);
        return scanSegments(chat, { depth, includeNames: world_info_include_names, matchWindow: 'message' }).join('\n\n');
    };

    /** One entry of the selected book, as the Lab's key list plus its secondary condition — the entry's own spelling, not a
     *  SmartKey rewrite of it. Returns null when nothing was chosen. */
    const pickEntryKeys = async () => {
        const entries = Object.values(data?.entries ?? {}).filter(e => usableKeys(e?.key).length);
        if (!entries.length) { toastr.info('No entry in this book has keys to import.', 'Worlds Apart'); return null; }
        entries.sort(SORT_FNS['title-asc']);
        const w = document.createElement('div');
        w.style.cssText = 'text-align:left;';
        w.innerHTML = 'Take the keys of<div style="margin-top:8px;"><select class="wa-lab-entry text_pole" style="width:100%;">'
            + entries.map(e => `<option value="${escapeHtml(String(e.uid))}">${escapeHtml(wiTitleOf(e))} — ${escapeHtml(usableKeys(e.key).join(', '))}</option>`).join('')
            + '</select></div>';
        const p = new Popup(w, POPUP_TYPE.CONFIRM, '', { okButton: 'Import keys', cancelButton: 'Cancel' });
        if (await p.show() !== POPUP_RESULT.AFFIRMATIVE) return null;
        const e = data.entries[w.querySelector('.wa-lab-entry').value];
        const sec = e?.selective ? secondaryKeys(e) : [];
        return { keys: usableKeys(e?.key), sec, logic: String(e?.selectiveLogic ?? WI_LOGIC.AND_ANY) };
    };

    /** One key's result as HTML: the key as a chip with its count, then a block per segment — every branch with that segment's
     *  count, and under it the first place each branch that fired landed. A segment the key failed in is dimmed. */
    const labKeyHtml = (r, color) => {
        const chip = `<span class="wa-kw" style="border-color:${escapeHtml(color)};background:color-mix(in srgb, ${escapeHtml(color)} 18%, transparent);">${escapeHtml(r.key)}</span>`;
        const num = n => `<span style="color:var(--SmartThemeEmColor, #d9a441);font-weight:600;">${n}</span>`;
        if (r.message) return `<div style="margin-bottom:8px;">${chip} <small style="opacity:0.75;">${escapeHtml(r.message)}</small></div>`;
        const seg = sg => `<div style="margin:3px 0 0 14px;${sg.matched ? '' : 'opacity:0.55;'}">`
            + `<small>${sg.leaves.map(l => `${escapeHtml(l.negated ? `-${l.term}` : l.term)} ${num(l.n)}`).join(', ')}</small>`
            + sg.excerpts.map(e => `<div style="margin-left:14px;"><small style="opacity:0.75;">${escapeHtml(e.text.slice(0, e.start))}`
                + `<span style="color:${e.negated ? WA_RED : escapeHtml(color)};font-weight:600;">${escapeHtml(e.text.slice(e.start, e.end))}</span>`
                + `${escapeHtml(e.text.slice(e.end))}</small></div>`).join('')
            + '</div>';
        return `<div style="margin-bottom:8px;">${chip} ${num(r.count)}${r.segments.map(seg).join('')}</div>`;
    };

    /** The rows and the colour they share with the marks, from whatever the panes hold now. */
    const scanLab = () => {
        const keys = splitKeys(labKeys);
        const ink = (key, a) => labInk(Math.max(0, keys.indexOf(key)), a);
        const gate = { keys: splitKeys(labSec), logic: Number(labLogic) };
        const rows = keyHits(keys, labHay, labCase, labWhole, { context: 30, matchWindow: labWindow, gate });
        for (const r of rows) r.color = ink(r.key);
        return { keys, ink, rows, gate };
    };

    /** The haystack at full width with every match marked, and the digest under it. The tab keeps only the digest: the
     *  marked text needs the room, and the pane above it already shows the same characters unmarked. */
    const showMarkedText = () => {
        const { keys, ink, rows, gate } = scanLab();
        const wrap = document.createElement('div');
        wrap.style.cssText = 'text-align:left;width:100%;';
        const body = document.createElement('div');
        body.style.cssText = 'white-space:pre-wrap;line-height:1.6;max-height:55vh;overflow:auto;font-size:0.95em;';
        body.innerHTML = markedHtml(labHay, keySpans(keys, labHay, labCase, labWhole, { matchWindow: labWindow, gate }), ink)
            || '<span style="opacity:0.6;">(no text)</span>';
        const digest = document.createElement('div');
        digest.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid color-mix(in srgb, currentColor 15%, transparent);max-height:25vh;overflow:auto;';
        digest.innerHTML = rows.map(r => labKeyHtml(r, r.color)).join('');
        wrap.append(body, digest);
        const vp = new Popup(wrap, POPUP_TYPE.TEXT, '', { large: true, allowVerticalScrolling: true });
        vp.dlg.style.setProperty('width', 'calc(var(--sheldWidth, 90vw) * 0.7)', 'important');
        vp.dlg.style.setProperty('max-width', 'calc(100dvw - 2em)', 'important');
        vp.show();
    };

    const renderLabView = pane => {
        const panes = document.createElement('div');
        panes.style.cssText = 'display:flex;gap:6px;padding:8px 8px 0;flex:0 0 auto;height:45%;min-height:180px;';
        const box = (placeholder, get, set) => {
            const t = document.createElement('textarea'); t.className = 'text_pole';
            t.placeholder = placeholder; t.value = get();
            t.style.cssText = 'flex:1 1 0;height:100%;min-height:0;resize:none;font-family:var(--monoFontFamily);overflow:auto;';
            t.addEventListener('input', () => { set(t.value); repaint(); });
            return t;
        };
        const hayBox = box('Paste any text to match against…', () => labHay, v => { labHay = v; });
        hayBox.style.flex = '2 1 0';
        const keyBox = box('Keys, comma- or newline-separated — plain, /regex/flags or ?SmartKey', () => labKeys, v => { labKeys = v; });
        // Keys, the operator, then the secondaries it gates them by — one column, reading downward as the condition does.
        const keyCol = document.createElement('div');
        keyCol.style.cssText = 'flex:1 1 0;display:flex;flex-direction:column;gap:4px;min-width:0;min-height:0;';
        const logicSel = document.createElement('select'); logicSel.className = 'text_pole';
        logicSel.style.cssText = 'width:100%;margin:0;flex:0 0 auto;';
        // Core's own operator names and the sentence each completes, as the entry editor shows them. OFF is not offered: an
        // empty secondary pane is already off.
        for (const [v, name, hint] of LOGIC_OPTS.filter(([id]) => id !== 'off')) {
            const o = document.createElement('option'); o.value = v; o.textContent = `${name} — ${hint}`; o.title = hint;
            o.selected = labLogic === v;
            logicSel.append(o);
        }
        logicSel.addEventListener('change', () => { labLogic = logicSel.value; repaint(); });
        const secBox = box('Secondary keys', () => labSec, v => { labSec = v; });
        secBox.style.cssText += 'flex:0 0 auto;height:4.4em;';
        keyCol.append(keyBox, logicSel, secBox);
        panes.append(hayBox, keyCol);

        const opts = document.createElement('div');
        opts.style.cssText = 'display:flex;gap:14px;padding:6px 8px;flex:0 0 auto;opacity:0.8;font-size:0.9em;';
        const flag = (label, get, set) => {
            const l = document.createElement('label'); l.style.cssText = 'display:flex;gap:4px;align-items:center;cursor:pointer;';
            const c = document.createElement('input'); c.type = 'checkbox'; c.checked = get();
            c.addEventListener('change', () => { set(c.checked); repaint(); });
            l.append(c, document.createTextNode(label));
            return l;
        };
        opts.append(
            flag('Case sensitive', () => labCase, v => { labCase = v; }),
            flag('Match whole words', () => labWhole, v => { labWhole = v; }),
        );
        const winLabel = document.createElement('label');
        winLabel.style.cssText = 'display:flex;gap:6px;align-items:center;';
        winLabel.title = 'The unit a key has to match within, as the Match window setting has it';
        const win = document.createElement('select'); win.className = 'text_pole';
        win.style.cssText = 'width:auto;margin:0;';
        for (const [v, label] of [['paragraph', 'Paragraph'], ['message', 'Message'], ['scan', 'Whole scan window']]) {
            const o = document.createElement('option'); o.value = v; o.textContent = label; o.selected = labWindow === v;
            win.append(o);
        }
        win.addEventListener('change', () => { labWindow = win.value; repaint(); });
        winLabel.append(document.createTextNode('Match window'), win);
        const tool = (icon, title, onClick, marginLeft) => {
            const i = document.createElement('i');
            i.className = `fa-solid ${icon}`; i.title = title;
            i.style.cssText = `cursor:pointer;padding:2px 4px;opacity:0.7;${marginLeft ? 'margin-left:auto;' : ''}`;
            i.addEventListener('click', onClick);
            return i;
        };
        opts.append(
            winLabel,
            tool('fa-comments', 'Load the current chat, as deep as the message-depth setting reads', () => {
                labHay = chatHaystack();
                hayBox.value = labHay;
                repaint();
            }, true),
            tool('fa-key', 'Take the keys of an entry in this book, secondary condition and all', async () => {
                const picked = await pickEntryKeys();
                if (!picked?.keys.length) return;
                labKeys = picked.keys.join('\n');
                labSec = picked.sec.join(', ');
                labLogic = picked.logic;
                keyBox.value = labKeys; secBox.value = labSec; logicSel.value = labLogic;
                repaint();
            }),
            tool('fa-expand', 'Show the text with every match marked', () => showMarkedText()),
        );
        const out = document.createElement('div');
        out.style.cssText = 'flex:1 1 auto;overflow:auto;padding:0 8px 8px;min-height:0;';
        const repaint = () => {
            const { rows } = scanLab();
            out.innerHTML = rows.length
                ? rows.map(r => labKeyHtml(r, r.color)).join('')
                : '<div style="opacity:0.6;padding:6px 0;">Keys you type on the right are matched against the text on the left.</div>';
        };
        repaint();
        pane.append(panes, opts, out);
    };

    const TABS = [['explorer', 'Explorer'], ['cleanup', 'Cleanup'], ['lab', 'Keyword Lab']];
    const renderTabBar = () => {
        const bar = document.createElement('div'); bar.className = 'wa-tabs';
        for (const [id, label] of TABS) {
            const b = document.createElement('button'); b.type = 'button';
            b.className = 'wa-tab' + (tab === id ? ' wa-tab-on' : '');
            b.textContent = label;
            const pending = id === 'cleanup' ? [...cleanupChecks.values()].filter(Boolean).length : 0;
            if (pending) { const c = document.createElement('span'); c.className = 'wa-tab-count'; c.textContent = `${pending} selected`; b.append(c); }
            b.addEventListener('click', () => { if (tab !== id) { tab = id; renderExplorer(); } });
            bar.append(b);
        }
        bar.append(closeBtn);   // tab order: straight after the last tab. It's positioned, so no layout effect
        return bar;
    };

    const orphanChecks = new Set();   // `${avatar}\u001F${file}` for chats ticked to re-point

    /** Re-run the scan and repaint, after anything that changes a binding. */
    const refreshOrphans = async () => {
        chatIndex = null;
        orphanChecks.clear();
        const r = findOrphanBindings(await bindingIndex(), world_names);
        orphans = (r.chatCount || r.cardCount) ? r : null;
        if (!orphans) orphanView = false;
        renderBooks();
        renderExplorer();
    };

    /** The orphaned-bindings list: each missing name with its nearest match, the two book-level repairs, the cards, and the tickable chats. */
    const renderOrphans = () => {
        explorer.innerHTML = '';
        explorer.append(closeBtn);
        const wrap = document.createElement('div'); wrap.style.cssText = 'padding:10px 12px;max-width:780px;';
        const h = document.createElement('h3'); h.style.cssText = 'margin:0 0 10px;';
        h.innerHTML = '<i class="fa-solid fa-link-slash"></i> Orphaned bindings';
        wrap.append(h);

        const btn = (label, fn) => menuBtn(label, fn, '', 'width:auto;padding:2px 8px;');

        for (const g of orphans?.missing ?? []) {
            const box = document.createElement('div');
            box.style.cssText = 'border:1px solid var(--SmartThemeBorderColor);border-radius:6px;padding:8px 10px;margin-bottom:10px;';

            const name = document.createElement('div');
            name.style.cssText = 'font-weight:bold;word-break:break-all;margin-bottom:4px;';
            name.textContent = g.name;
            box.append(name);

            if (g.nearest) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;';
                const sug = document.createElement('span'); sug.style.cssText = 'word-break:break-all;';
                sug.innerHTML = `<span class="opacity50p">might be related to</span> ${escapeHtml(g.nearest)}`;
                // Labelled by what happens to the existing book; "might be related to" because the match is a name similarity and nothing more.
                row.append(sug,
                    bookTool('fa-pen', `Rename “${g.nearest}” back to “${g.name}”. The chats resolve immediately, and anything still bound to “${g.nearest}” is re-pointed with it — one book, under the old name.`,
                        async () => { await renameBook(g.nearest, g.name); await refreshOrphans(); }),
                    bookTool('fa-copy', `Copy “${g.nearest}” to a new book called “${g.name}”. Both books exist afterwards with the same contents — for when the rename was deliberate and these chats want the old one.`,
                        async () => { await copyBookByName(g.nearest, false, g.name); await updateWorldInfoList(); await refreshOrphans(); }));
                box.append(row);
            }

            if (g.cards.length) {
                // Cards get their own control: a different write (merge-attributes) and a different decision from the chats.
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;';
                const lbl = document.createElement('span');
                lbl.innerHTML = `<b>Characters:</b> ${escapeHtml(g.cards.join(', '))}`;
                const sel = document.createElement('select'); sel.className = 'text_pole';
                sel.style.cssText = 'width:auto;max-width:280px;';
                for (const n of [...world_names].sort((a, b) => a.localeCompare(b))) {
                    const o = document.createElement('option'); o.value = n; o.textContent = n;
                    if (n === g.nearest) o.selected = true;
                    sel.append(o);
                }
                const go = btn(`Re-point ${g.cards.length === 1 ? 'card' : `${g.cards.length} cards`}`, async () => {
                    const target = sel.value; if (!target) return;
                    const r = await repointCards(g.name, target);
                    if (r.moved.length) toastr.success(`Re-pointed ${r.moved.join(', ')} to “${target}”.`, 'Worlds Apart');
                    if (r.failed.length) toastr.warning(`Could not re-point: ${r.failed.join(', ')}`, 'Worlds Apart', { timeOut: 12000 });
                    await refreshOrphans();
                });
                go.title = `Set the primary lorebook on ${g.cards.length === 1 ? 'this card' : 'these cards'} to the chosen book. `
                    + 'SillyTavern shows a broken binding as no binding at all, so this cannot be seen — let alone fixed — from the character panel.';
                row.append(lbl, sel, go);
                box.append(row);
            }

            const idOf = c => `${c.avatar}\u001F${c.file}`;
            const ticked = g.chats.filter(c => orphanChecks.has(idOf(c)));

            if (g.chats.length > 1) {
                const all = document.createElement('label');
                all.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:0.9em;cursor:pointer;opacity:0.75;';
                const cb = document.createElement('input'); cb.type = 'checkbox';
                cb.checked = ticked.length === g.chats.length;
                cb.indeterminate = ticked.length > 0 && ticked.length < g.chats.length;
                cb.addEventListener('change', () => {
                    for (const c of g.chats) cb.checked ? orphanChecks.add(idOf(c)) : orphanChecks.delete(idOf(c));
                    renderOrphans();
                });
                const t = document.createElement('span'); t.textContent = `All ${g.chats.length}`;
                all.append(cb, t);
                box.append(all);
            }

            for (const c of g.chats) {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:0.9em;cursor:pointer;';
                const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = orphanChecks.has(idOf(c));
                cb.addEventListener('change', () => { cb.checked ? orphanChecks.add(idOf(c)) : orphanChecks.delete(idOf(c)); renderOrphans(); });
                const t = document.createElement('span'); t.style.cssText = 'word-break:break-all;';
                t.textContent = `${c.char} — ${c.file.replace(/\.jsonl$/, '')}`;
                row.append(cb, t);
                box.append(row);
            }

            if (ticked.length) {
                const bar = document.createElement('div');
                bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;';
                const sel = document.createElement('select'); sel.className = 'text_pole';
                sel.style.cssText = 'width:auto;max-width:340px;';
                for (const n of [...world_names].sort((a, b) => a.localeCompare(b))) {
                    const o = document.createElement('option'); o.value = n; o.textContent = n;
                    if (n === g.nearest) o.selected = true;
                    sel.append(o);
                }
                bar.append(sel, btn(`Re-point ${ticked.length} ${ticked.length === 1 ? 'chat' : 'chats'}`, async () => {
                    const target = sel.value;
                    if (!target) return;
                    const open = String(getContext().chatId ?? '');
                    let ok = 0; const bad = [];
                    for (const c of ticked) {
                        if (c.file.replace(/\.jsonl$/, '') === open) { bad.push(`${c.file} (open — switch away first)`); continue; }
                        (await repointOne(c, target)) ? ok++ : bad.push(c.file);
                    }
                    if (ok) toastr.success(`Re-pointed ${ok} ${ok === 1 ? 'chat' : 'chats'} to “${target}”.`, 'Worlds Apart');
                    if (bad.length) toastr.warning(`Could not re-point: ${bad.join(', ')}`, 'Worlds Apart', { timeOut: 12000 });
                    await refreshOrphans();
                }));
                box.append(bar);
            }
            wrap.append(box);
        }
        explorer.append(wrap);
    };

    const renderExplorer = () => {
        if (orphanView) return renderOrphans();
        // Carry the list's scrollTop over the rebuild.
        const listTop = explorer.querySelector('.wa-studio-entries')?.scrollTop ?? 0;
        explorer.innerHTML = ''; rowEls.clear();
        // The no-book branch paints no tab bar, so it re-adopts the close button the wipe removed.
        if (!selected) { explorer.innerHTML = '<div style="opacity:0.6;padding:8px;">Select a lorebook on the left.</div>'; explorer.append(closeBtn); return; }
        termRepaint = null;   // the term views below claim it; the Explorer leaves it null
        explorer.append(renderTabBar());
        const pane = document.createElement('div');
        pane.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;overflow:hidden;min-height:0;';
        explorer.append(pane);
        // Cleanup is async (paints a note, then blocks) and repaints itself; nothing awaits it.
        if (tab === 'cleanup') { renderCleanupView(pane); return; }
        if (tab === 'lab') { renderLabView(pane); return; }
        renderExplorerView(pane);
        if (listTop) { const l = explorer.querySelector('.wa-studio-entries'); if (l) l.scrollTop = listTop; }
    };

    const renderExplorerView = pane => {
        const total = Object.values(data?.entries ?? {});
        const entries = total.filter(filterMatch);
        const head = document.createElement('div');
        head.className = 'wa-studio-exphead';
        head.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:6px;';
        const label = document.createElement('div');
        const nameB = document.createElement('b'); nameB.textContent = selected;
        const countSpan = document.createElement('span'); countSpan.style.cssText = 'opacity:0.6;margin-left:5px;';
        label.append(nameB, countSpan);
        const bookTools = document.createElement('span'); bookTools.className = 'wa-book-tools';
        bookTools.append(
            bookTool('fa-pen', 'Rename this lorebook', () => renameBook()),
            bookTool('fa-copy', 'Duplicate this lorebook', () => dupBook()),
            bookTool('fa-trash-can', 'Delete this lorebook', () => delBook(), 'wa-book-tool-danger'),
        );
        label.append(bookTools);
        const filterWrap = buildFilterBtn(renderExplorer);
        const sortBtn = buildSortControl(renderExplorer);
        const scanBtn = document.createElement('button');
        scanBtn.type = 'button'; scanBtn.className = 'menu_button';
        scanBtn.innerHTML = `<i class="fa-solid fa-stethoscope"></i> ${scan ? 'Re-audit' : 'Keyword audit'}`;
        scanBtn.title = chatHits
            ? `Flag dead / common / short keywords — tune under Tool Settings.\nChat evidence: "${chatName}", ${chatMsgs} messages.`
            : 'Flag dead / common / short keywords and colour them by verdict — tune under Tool Settings.\nNo chat searched yet: bind this book to the open chat, or use Cleanup → "Check against chats".';
        scanBtn.addEventListener('click', async () => { await runAudit(); renderExplorer(); });
        const allOpen = entries.length > 0 && entries.every(x => entryOpen.has(x.uid));
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button'; expandBtn.className = 'menu_button';
        expandBtn.style.cssText = 'width:auto;padding:3px 7px;flex-shrink:0;';
        expandBtn.innerHTML = `<i class="fa-solid ${allOpen ? 'fa-square-caret-up' : 'fa-square-caret-down'}"></i>`;
        expandBtn.title = `${allOpen ? 'Collapse' : 'Expand'} all entries — shift-click expands only entries with flagged keywords`;
        expandBtn.addEventListener('click', async ev => {
            if (ev.shiftKey) {   // expand only flagged entries (scan first if needed), collapse the rest
                if (!scan) await runAudit();   // building an audit here means building the SAME audit
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
        // Typing re-filters in place (applyFilter), not the header, so the input keeps focus.
        const searchWrap = buildSearchBox(() => applyFilter());
        const rowStyle = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const vsep = () => { const s = document.createElement('span'); s.style.cssText = 'align-self:stretch;width:1px;background:color-mix(in srgb, currentColor 22%, transparent);margin:2px;'; return s; };
        const row1 = document.createElement('div'); row1.style.cssText = rowStyle;
        const row2 = document.createElement('div'); row2.style.cssText = rowStyle;
        const spacer = () => { const s = document.createElement('span'); s.style.width = '10px'; return s; };
        const globeBtn = document.createElement('button'); globeBtn.type = 'button'; globeBtn.className = 'menu_button wa-filter';
        globeBtn.title = 'Global World Info settings'; globeBtn.style.cssText = 'width:auto;margin-left:auto;padding:3px 8px;flex-shrink:0;';
        globeBtn.innerHTML = '<i class="fa-solid fa-globe"></i>';
        globeBtn.style.color = globalTrayOpen ? '#6ea8fe' : '';
        globeBtn.addEventListener('click', () => { globalTrayOpen = !globalTrayOpen; globeBtn.style.color = globalTrayOpen ? '#6ea8fe' : ''; refreshGlobalTray(); });
        row1.append(label, vsep(), filterWrap, sortBtn, spacer(), searchWrap, globeBtn);
        const newBtn = document.createElement('button');
        newBtn.type = 'button'; newBtn.className = 'menu_button';
        newBtn.style.cssText = 'width:auto;padding:3px 9px;flex-shrink:0;';
        newBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New entry';
        newBtn.title = 'Add a blank entry to this lorebook';
        newBtn.addEventListener('click', () => newEntry());
        // A flex spacer with basis 0, not margin-left:auto: it never affects where the row wraps.
        const grow = document.createElement('span'); grow.style.cssText = 'flex:1 1 0;min-width:0;';
        row2.append(expandBtn, scanBtn, suggestAllBtn, suggestAllLlmBtn, grow, newBtn);
        head.append(row1, row2);
        const fixed = document.createElement('div'); fixed.className = 'wa-studio-fixed';
        globalTrayEl = renderGlobalTray();
        trayEl = renderTray();
        bulkEl = renderBulkBar();
        fixed.append(head, globalTrayEl, trayEl, bulkEl);
        const list = document.createElement('div'); list.className = 'wa-studio-entries';
        pane.append(fixed, list);
        // Repaints just the entry list and the count for the current filter + search.
        const applyFilter = () => {
            rowEls.clear();
            const shown = sortEntries(total.filter(filterMatch));
            visibleUids = shown.map(e => e.uid);   // keep the "visual order" source of truth in sync
            countSpan.textContent = (entryFilter !== 'all' || searchQuery.trim())
                ? `(${shown.length} of ${total.length})`
                : `(${total.length} ${total.length === 1 ? 'entry' : 'entries'})`;
            list.innerHTML = '';
            if (!shown.length) { list.innerHTML = `<div style="opacity:0.6;padding:8px;">${total.length ? 'No entries match.' : 'This lorebook has no entries.'}</div>`; return; }
            for (const e of shown) renderEntry(e, list);   // mounts as it builds — see renderEntry
        };
        applyFilter();
    };

    const openBook = async name => {
        orphanView = false;
        if (dirty && selected) { reloadEditor(selected); dirty = false; }   // refresh the outgoing book's editor
        selected = name; loadSortView(name); entryOpen.clear(); expanded.clear(); tall.clear(); advOpen.clear(); sugg.clear(); selectedEntries.clear(); lastSel = null; selAnchorUid = null; suggest = null; scan = null; clearChatScan();   // scan is on-demand; chat counts belong to a (book, chat) pair
        explorer.innerHTML = '<div style="opacity:0.6;padding:8px;">Loading…</div>'; explorer.append(closeBtn);   // same re-adopt as the no-book branch
        renderBooks();
        data = await loadWorldInfo(name);
        if (selected !== name) return;   // a faster second click won this race
        if (!data?.entries) { toastr.warning(`Couldn't load "${name}".`, 'Worlds Apart'); return; }
        const s = settings(); if (!s.keywordIgnore) s.keywordIgnore = {};
        ignoreSet = new Set(s.keywordIgnore[name] ?? []);
        renderExplorer();
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

        if (bookBulkMode) {
            const bar = document.createElement('div'); bar.className = 'wa-bookbulk';
            if (selectedBooks.size) {
                const top = document.createElement('div'); top.className = 'wa-bookbulk-top';
                const cnt = document.createElement('span'); cnt.style.fontWeight = 'bold'; cnt.textContent = `${selectedBooks.size} selected`;
                const clr = document.createElement('i'); clr.className = 'fa-solid fa-xmark wa-undo-dismiss'; clr.title = 'Clear selection';
                clr.addEventListener('click', () => { selectedBooks.clear(); bookAnchor = null; renderBooks(); });
                top.append(cnt, clr);
                const actions = document.createElement('div'); actions.className = 'wa-bookbulk-actions';
                actions.append(menuBtn('Copy', bulkCopyBooks), menuBtn('Delete', bulkDeleteBooks, 'wa-bulk-danger'));
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

        if (orphans) {
            const row = document.createElement('div');
            row.className = 'wa-book-row' + (orphanView ? ' wa-sel' : '');
            row.style.cssText = 'margin-top:6px;opacity:0.85;';
            const nm = document.createElement('span'); nm.className = 'wa-book-name';
            nm.innerHTML = `<i class="fa-solid fa-link-slash"></i> Orphaned bindings (${orphans.chatCount + orphans.cardCount})`;
            nm.title = `${orphans.chatCount} chat${orphans.chatCount === 1 ? '' : 's'} and ${orphans.cardCount} character card${orphans.cardCount === 1 ? '' : 's'} name a lorebook that no longer exists`;
            row.append(nm);
            row.addEventListener('click', () => { orphanView = true; renderBooks(); renderExplorer(); });
            nav.append(row);
        }
    };

    renderBooks();
    if (selected) await openBook(selected);
    else renderExplorer();
    checkOrphans();   // background; adds a nav row only if something is broken

    // Escape never closes the window: it swallows the <dialog>'s close and, if nothing else claimed it, drops the selection.
    root.addEventListener('keydown', ev => {
        if (ev.key !== 'Escape') return;
        const claimed = ev.defaultPrevented;
        ev.preventDefault();
        if (claimed) return;
        consumeSelection();   // recoverable from the bar, same as any other clear
    });

    const pop = new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, okButton: false, allowVerticalScrolling: false });
    pop.buttonControls.style.display = 'none';   // hiding the OK button alone leaves the row's padding
    closeBtn.addEventListener('click', () => pop.complete(POPUP_RESULT.AFFIRMATIVE));
    await pop.show();
    clearUndo();   // drop the pending timer/snapshot when Studio closes
    if (dirty && selected) reloadEditor(selected);
    return '';
}
