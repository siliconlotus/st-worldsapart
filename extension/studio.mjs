// studio.mjs — Lorebook Studio (/wa-studio): the two-pane lorebook manager, all books on the left and the
// selected book's entries on the right. DOM- and ST-coupled; the logic it stands on is the shared pure modules.
import { saveSettingsDebounced, getRequestHeaders, characters, getCharacters } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { loadWorldInfo, saveWorldInfo, reloadEditor, createWorldInfoEntry, duplicateWorldInfoEntry, deleteWorldInfoEntry, getFreeWorldEntryUid, deleteWIOriginalDataValue, deleteWorldInfo, updateWorldInfoList, world_names, world_info_depth, world_info_include_names, world_info_match_whole_words, world_info_case_sensitive, selected_world_info, world_info, METADATA_KEY } from '../../../../world-info.js';
import { power_user } from '../../../../power-user.js';
import { escapeHtml, getCharaFilename } from '../../../../utils.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { runState, settings } from './state.mjs';
import { ensureStudioStyle, makeSortControl, renderMessageHtml, showCtxMenu, showEntryText, wiGlyph } from './ui-widgets.mjs';
import { SORT_FNS, SORT_LABELS, normPresentation, presentationLabel, reconcileTiers, tierRank, wiTitleOf } from './sort.mjs';
import { buildKeyPruneScan, llmKeyCandidates } from './keyword-tools.mjs';
import { FLAG_PRIORITY, KEY_CHAT_COMMON, MINOR, MODERATE, SEVERE, STUDIO_PRUNE_OPTS, collisionProbes, commonPathProbes, orthoAlternates } from './keyword-audit.mjs';
import { buildKeySuggest, classifyLlmCand, STUDIO_SUGGEST_OPTS } from './keyword-suggest.mjs';
import { validateSmartKey } from './smartkeys.mjs';
import { findOrphanBindings } from './bindings.mjs';
import { WI_LOGIC, countChatHits, dropTags, hasPromoteDecorator, isRegexKey, scanSegments, secondaryKeys, splitKeys, usableKeys, wholeWordAdvice, withPromote } from './matcher.mjs';
import { labScan, runBook } from './lab.mjs';
import { addVariant, deleteKey, hasKey, keyHolders, kwNorm, renameKeyOn, replaceKey } from './keyedit.mjs';

// Fixed, not theme variables: severity is read by hue.
const SEVERITY_COLOR = { severe: '#e06c6c', moderate: '#d9b74a', minor: '#7bbf6a' };
const SEVERITY_RANK = { severe: 3, moderate: 2, minor: 1 };
const ACCENT = 'var(--SmartThemeQuoteColor)';
const INHERIT_TINT = 'color-mix(in srgb, var(--SmartThemeBodyColor) 55%, transparent)';
const WA_GREEN = SEVERITY_COLOR.minor;   // "no prune" — a keyword the scan doesn't flag
const WA_RED = SEVERITY_COLOR.severe;
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
 * @param {string|null} preferredBook Opened if it still exists; else the first attached book, else nothing selected
 * @param {{lab?: boolean, entry?: {world: string, uid: number|string}}|null} open Where to land: `lab` opens the Keyword
 *   Lab tab, `entry` opens that entry in the Explorer.
 */
export async function lorebookStudio(preferredBook = null, open = null) {
    if (!(world_names ?? []).length) { toastr.warning('No lorebooks found.', 'Worlds Apart'); return ''; }
    ensureStudioStyle();

    /** The books ST has active for this chat: global, the character's own and its charLore extras, the chat's, the persona's.
     *  Mirrors getGlobalLore/getCharacterLore/getChatLore/getPersonaLore, which are private, because the exported
     *  getSortedEntries emits WORLDINFO_ENTRIES_LOADED (upstream-st.md #18). The Set drops the duplicate core also skips.
     *  In a group this unions the enabled members, where core takes one member per generation. */
    const attachedBookNames = () => {
        const ctx = getContext();
        const names = new Set(selected_world_info ?? []);
        const addCharacter = (character, avatar) => {
            if (character?.data?.extensions?.world) names.add(character.data.extensions.world);
            const file = getCharaFilename(null, { manualAvatarKey: avatar ?? character?.avatar });
            for (const b of (file && world_info.charLore?.find(e => e.name === file)?.extraBooks) ?? []) names.add(b);
        };
        const group = ctx.groupId ? ctx.groups?.find(g => String(g.id) === String(ctx.groupId)) : null;
        if (group) {
            // Core resolves one member's books per generation, from this_chid as the group sets it per speaker. The union
            // over the members that can speak is what any turn of this chat could scan.
            for (const avatar of group.members ?? []) {
                if ((group.disabled_members ?? []).includes(avatar)) continue;
                addCharacter(characters?.find(c => c?.avatar === avatar), avatar);
            }
        } else if (ctx.characterId != null) {
            addCharacter(characters?.[ctx.characterId]);
        }
        const chatWorld = ctx.chatMetadata?.[METADATA_KEY];
        if (chatWorld) names.add(chatWorld);
        if (power_user.persona_description_lorebook) names.add(power_user.persona_description_lorebook);
        return [...names].filter(Boolean).filter(n => world_names.includes(n));
    };

    let sortAsc = true;
    let selected = (world_names.includes(preferredBook) ? preferredBook : null)
        ?? attachedBookNames()[0] ?? null;
    let data = null;                 // loaded world-info for `selected`
    let scan = null;                 // buildKeyPruneScan result for `data` (keyword colouring)
    const staleTerms = new Set();    // rowIds renamed since the audit: their verdict is the OLD term's, so it is not shown as live
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
    let entryFilter = 'all';         // explorer entry filter: type, state, or worst-flag severity — see FILTER_OPTS
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
    let chatTyped = null;       // the same count for each key AS WRITTEN, its variants excluded
    let chatMsgs = 0;
    let chatName = '';          // WHICH chat produced those counts — see runChatScan
    let chatNames = [];         // the same, unabbreviated: chatName collapses to "N chats" and only the tooltip can name them
    // Quoted only when it IS a name: quotes around "2 chats" read as scare quotes.
    const chatLabel = () => (chatNames.length === 1 ? `"${chatName}"` : chatName);
    const rowId = (uid, term) => `${uid}${term}`;
    let termRepaint = null;   // the active term tab's list repaint; null in the Explorer, whose rerenderKeys walks rowEls instead
    const afterIgnoreChange = keys => {
        if (termRepaint) termRepaint(); else rerenderKeys(keys);
        if (trayOpen) refreshTray();   // the whitelist column lives there
    };

    let orphans = null;       // findOrphanBindings result, computed once in the background; null until it has run
    let orphanView = false;   // showing the list instead of a book — `selected` stays a real book name

    /** The "additional lorebooks" a character carries: world_info.charLore, keyed by avatar filename. */
    const extraBooksOf = avatar => {
        const file = getCharaFilename(null, { manualAvatarKey: avatar });
        return (file && world_info.charLore?.find(e => e.name === file)?.extraBooks) ?? [];
    };
    const humanSize = n => (!Number.isFinite(n) ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

    /** The chat index: the plugin's chat-bindings route (reads line 0 only, P1), else ST's endpoint via loadChatIndex,
     *  which reads every chat whole for its metadata. Same shape either way: [{ char, avatar, charWorld, extraBooks, chats }]. */
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
                            const avatar = c?.avatar ?? `${dir}.png`;
                            out.set(dir, e = { char: c?.name ?? dir, avatar, charWorld: c?.data?.extensions?.world ?? null, extraBooks: extraBooksOf(avatar), chats: [] });
                        }
                        return e;
                    };
                    for (const c of characters ?? []) if (c?.avatar) entry(String(c.avatar).replace(/\.png$/, ''));
                    for (const b of bindings ?? []) entry(b.dir).chats.push({ file_name: b.file, file_size: humanSize(b.size), chat_metadata: { world_info: b.world_info } });
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

    let navCollapsed = false;   // view state for this session, like `tab`; the rail keeps the way back visible
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
        // Every term is judged below, so an edited row drops the false the edit forced and rejoins the pre-tick policy.
        // Only those: a tick the user set is theirs, and survives a rescan on purpose.
        for (const id of staleTerms) cleanupChecks.delete(id);
        staleTerms.clear();
        scan = buildKeyPruneScan(data, studioOpts, ignoreSet, {
            matchWindow: settings().matchWindow,
            // Into the classifier, not painted on in Cleanup: the Explorer's chips colour from reasonOf/severityOf.
            chatScan: chatHits ? { messagesWith: chatHits, typedWith: chatTyped, messages: chatMsgs } : undefined,
        });
    };
    const afterChatScan = keys => { rebuildScan(); termRepaint?.(); rerenderKeys(keys); };
    /** Every key in the book — the whole book, not visibleEntries(), so a verdict never depends on the filter. */
    const bookKeys = () => [...new Set(Object.values(data?.entries ?? {})
        .flatMap(e => (Array.isArray(e.key) ? e.key : []).map(k => String(k).trim())).filter(Boolean))];

    const clearChatScan = () => { chatHits = null; chatTyped = null; chatMsgs = 0; chatName = ''; chatNames = []; staleTerms.clear(); };
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
        if (!trayOpen) return document.createElement('div');   // nothing mounted when closed
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
                check(studioOpts, 'pruneUnattested', 'Flag unattested keys (aliases and typos)'),
                check(studioOpts, 'pruneCommon', 'Flag english-common keys'),
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
        return panel;
    };
    const refreshTray = () => { const fresh = renderTray(); if (trayEl?.isConnected) trayEl.replaceWith(fresh); trayEl = fresh; };
    /** The tray's toggle, which both headers carry: the panel itself mounts below them. */
    const trayBtn = () => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button wa-filter';
        b.title = 'Audit thresholds, recommender knobs and this book\'s ignored terms';
        b.style.cssText = 'width:auto;padding:3px 8px;flex-shrink:0;';
        b.innerHTML = '<i class="fa-solid fa-gear"></i>';
        b.style.color = trayOpen ? ACCENT : '';
        b.addEventListener('click', () => { trayOpen = !trayOpen; b.style.color = trayOpen ? ACCENT : ''; refreshTray(); });
        return b;
    };

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
            ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:7px 10px;border-radius:5px;`
                + `background:color-mix(in srgb, ${SEVERITY_COLOR.severe} 25%, transparent);border:1px solid ${SEVERITY_COLOR.severe};">`
                + `<i class="fa-solid fa-triangle-exclamation" style="color:${SEVERITY_COLOR.severe};"></i>`
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
        if (caseInherit) caseTool.style.color = INHERIT_TINT;
        const effWhole = e.matchWholeWords ?? world_info_match_whole_words;
        const wholeInherit = e.matchWholeWords == null && !!world_info_match_whole_words;
        const wholeAdvice = wholeWordAdvice(e.key, effWhole);
        const wholeTool = tool('[ab]', effWhole, `Match whole words: ${flagState(e.matchWholeWords, world_info_match_whole_words)} · shift-click: inherit${wholeAdvice.map(a => `\n\n${a}`).join('')}`, ev => { e.matchWholeWords = ev.shiftKey ? null : !effWhole; save(); repaint(e); });
        if (wholeInherit) wholeTool.style.color = INHERIT_TINT;
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
    const yieldFrame = () => new Promise(r => setTimeout(r, 0));
    /** Dims `btn` while `fn` runs, re-entrant-guarded; `label` also swaps its content for the duration. The yield is
     *  load-bearing: these bodies block the thread for seconds, so without it neither the dim nor the label paints. */
    const withBusy = async (btn, dim, fn, label = null) => {
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1'; btn.style.opacity = dim;
        const was = label === null ? null : btn.innerHTML;
        if (label !== null) btn.innerHTML = label;
        try { await yieldFrame(); return await fn(); }
        finally { btn.dataset.busy = ''; btn.style.opacity = ''; if (was !== null) btn.innerHTML = was; }
    };

    const suggestTfidf = (e, btn) => withBusy(btn, '0.25', async () => {
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

    /** `after` is the caller's repaint, handed the new term when one was written and null otherwise; the Explorer
     *  redraws one entry row, the term tabs their whole list. */
    const editKeyInline = (e, oldKey, span, list = 'key', after = null) => {
        inlineInput(span, (nv, ok) => {
            if (ok && nv && nv !== oldKey && !keyWriteOk(nv, list, e)) return false;
            const renamed = ok && nv && nv !== oldKey && renameKeyOn(e, oldKey, nv, list);
            if (renamed) save();
            if (after) after(renamed ? nv : null); else renderEntry(e);
        }, { value: oldKey });
    };

    /** Runs an in-place rebuild without losing the reader's place: .wa-studio-entries is the scroller, and it is either
     *  replaced or emptied, both of which reset scrollTop. Not for a book switch, where the top is the right answer. */
    const keepScroll = fn => {
        const at = document.querySelector('.wa-studio-entries')?.scrollTop ?? 0;
        fn();
        if (at) { const el = document.querySelector('.wa-studio-entries'); if (el) el.scrollTop = at; }
    };

    // Book-wide ops on a keyword chip, case-insensitive like core's default scan; primary keys only.
    const kwHits = key => keyHolders(Object.values(data.entries), key);
    const deleteKeyEverywhere = async key => {
        const hits = kwHits(key);
        if (hits.length > 1 && !await Popup.show.confirm(`Delete “${key}” from ${hits.length} entries?`, 'Removes the keyword everywhere it appears in this book.')) return;
        const touched = deleteKey(Object.values(data.entries), key);
        if (touched) { save(); keepScroll(renderExplorer); toastr.success(`Deleted “${key}” from ${touched} ${touched === 1 ? 'entry' : 'entries'}.`, 'Worlds Apart'); }
    };
    const replaceKeyEverywhere = async key => {
        const next = (await Popup.show.input('Replace keyword', `Replace “${key}” across all entries with:`, key))?.trim();
        if (!next || next === key) return;   // exact-match only: a case-only rewrite is a real edit, not a no-op
        if (!keyWriteOk(next)) return;
        const touched = replaceKey(Object.values(data.entries), key, next);
        if (touched) { save(); keepScroll(renderExplorer); toastr.success(`Replaced “${key}” → “${next}” in ${touched} ${touched === 1 ? 'entry' : 'entries'}.`, 'Worlds Apart'); }
    };
    // A second term on every entry keyed `key` — the alias case.
    const addVariantEverywhere = async key => {
        const hits = kwHits(key);
        const raw = await Popup.show.input('Add variant', `Keyword to add to the ${hits.length} ${hits.length === 1 ? 'entry' : 'entries'} keyed “${key}”:`);
        const term = String(raw ?? '').trim();
        if (!term || !keyWriteOk(term)) return;
        const added = addVariant(Object.values(data.entries), key, term);
        if (added) { save(); keepScroll(renderExplorer); }
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
        const counted = flagged ? [...flagged.values()].filter(v => scan.severityOf(v) === SEVERE) : [];
        // Unusable secondaries count too, as severe: the entry gates on fewer keys than written.
        const secBad = scan ? scan.unusableKeysOf(e).length : 0;
        if (counted.length + secBad) {
            const badge = document.createElement('span'); badge.className = 'wa-entry-badge';
            badge.textContent = `${counted.length + secBad} flagged`;
            let worst = secBad ? SEVERE : '';
            for (const v of counted) {
                const sev = scan.severityOf(v);
                if ((SEVERITY_RANK[sev] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) worst = sev;
            }
            if (worst) {
                badge.style.background = SEVERITY_COLOR[worst];
                // Against SEVERITY_COLOR as the ground.
                badge.style.color = worst === SEVERE ? '#fff' : '#111';
            }
            const softer = (flagged?.size ?? 0) - counted.length;
            // No colour means the uncoloured flag; name it from reasonOf.
            badge.title = `Keywords the last scan flagged — worst: ${worst || scan.reasonOf(counted[0]).text}.${secBad ? ` Includes ${secBad} secondary key${secBad === 1 ? '' : 's'} the matcher cannot run.` : ''}${softer ? ` ${softer} more are warnings, not counted here.` : ''} Expand to see which.`;
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
            // Tooltip wording comes from reasonOf even for dead: the (book) and (book/chat) scopes are different claims.
            const why = v && !isIgnored ? scan.reasonOf(v).text : '';
            if (isIgnored) { annot = 'ignored'; chip.classList.add('wa-kw-ignored'); }
            else if (v && !isDead) {
                const rc = scan.reasonOf(v); annot = why;
                const c = SEVERITY_COLOR[rc.severity];
                if (c) { chip.style.borderColor = c; chip.style.background = `color-mix(in srgb, ${c} 18%, transparent)`; }
            }
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
    // `withSelected` includes the open book, which a copy/move target must not offer.
    const pickBook = async (prompt, withSelected = false) => {
        const others = [...world_names].filter(n => withSelected || n !== selected).sort((a, b) => a.localeCompare(b));
        if (!others.length) { toastr.info('No other lorebook to target.', 'Worlds Apart'); return null; }
        const wrap = document.createElement('div');
        const lbl = document.createElement('div'); lbl.textContent = prompt; lbl.style.marginBottom = '6px';
        const sel = document.createElement('select'); sel.className = 'text_pole'; sel.style.width = '100%';
        const attached = new Set(attachedBookNames());
        for (const n of others) {
            const o = document.createElement('option'); o.value = n; o.selected = n === selected;
            o.textContent = attached.has(n) ? `${n} \u2014 attached` : n;
            if (attached.has(n)) o.style.color = 'var(--SmartThemeQuoteColor)';
            sel.append(o);
        }
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
            // Severity is per key, so this is "holds at least one" — the same reading as `flagged`. An unusable
            // secondary counts severe here as it does on the badge: the entry gates on fewer keys than written.
            case SEVERE: case MODERATE: case MINOR:
                if (!scan) return false;
                if (entryFilter === SEVERE && scan.unusableKeysOf(e).length) return true;
                return scan.classifyEntry(e).some(p => scan.severityOf(p) === entryFilter);
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
        chatIndex = null;   // a rename invalidates the fallback's cache, and this is the one place that must not read stale
        for (const c of await bindingIndex()) {
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
        [SEVERE, 'fa-triangle-exclamation', 'Severe', SEVERITY_COLOR[SEVERE]],
        [MODERATE, 'fa-circle-exclamation', 'Moderate', SEVERITY_COLOR[MODERATE]],
        [MINOR, 'fa-circle-info', 'Minor', SEVERITY_COLOR[MINOR]],
    ];
    const iconEl = (spec, color = '') => {
        if (!spec.startsWith('fa-')) { const s = document.createElement('span'); s.textContent = spec; return s; }
        const i = document.createElement('i'); i.className = 'fa-solid ' + spec;
        if (color) i.style.color = color;
        return i;
    };
    const buildFilterBtn = onChange => {
        const wrap = document.createElement('span'); wrap.style.cssText = 'position:relative;display:inline-flex;';
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'menu_button wa-filter';
        btn.title = 'List only some entries — by type, by state, or by the severity of a flag they carry'; btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;width:auto;white-space:nowrap;';
        const cur = FILTER_OPTS.find(o => o[0] === entryFilter) ?? FILTER_OPTS[0];
        const lbl = document.createElement('span'); lbl.textContent = cur[2];
        btn.append(iconEl('fa-filter', cur[3] ?? ''), lbl);
        const menu = document.createElement('div');
        menu.style.cssText = 'position:absolute;top:100%;left:0;z-index:5;display:none;flex-direction:column;gap:1px;margin-top:2px;padding:4px;border-radius:5px;min-width:9em;'
            + 'background:var(--SmartThemeBlurTintColor, var(--black70a, rgba(20,20,20,0.97)));border:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));';
        for (const [val, spec, text, color] of FILTER_OPTS) {
            const item = document.createElement('button'); item.type = 'button';
            item.style.cssText = 'display:flex;align-items:center;gap:7px;width:100%;padding:4px 8px;border:none;border-radius:4px;background:' + (val === entryFilter ? 'var(--white20a, rgba(255,255,255,0.1))' : 'transparent') + ';color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer;';
            if (val === entryFilter) item.style.fontWeight = 'bold';
            const t = document.createElement('span'); t.textContent = text; item.append(iconEl(spec, color ?? ''), t);
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
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.margin = '0'; cb.className = 'wa-tri';
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
    /** `onEdit` is the list's repaint; given, the term becomes click-to-edit and the row gains a delete, as the chips have. */
    const termRow = (e, r, checks, reg, onChange, onContext = null, onEdit = null) => {
        const row = document.createElement('div'); row.className = 'wa-term-row';
        const id = rowId(e.uid, r.term);
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.margin = '0';
        cb.addEventListener('change', () => { checks.set(id, cb.checked); onChange(); });
        reg.row.set(id, cb);
        const name = document.createElement('span'); name.className = 'wa-term-name';
        name.textContent = r.term; name.title = onEdit ? `${r.term} (click to edit)` : r.term;
        const why = document.createElement('span'); why.className = 'wa-term-why';
        why.textContent = r.why ?? ''; if (r.color) why.style.color = r.color;
        if (onContext) row.addEventListener('contextmenu', ev => { ev.preventDefault(); onContext(e, r, ev.clientX, ev.clientY); });
        // Renamed since the audit: the verdict judged the term that is gone, so it is replaced rather than shown stale.
        if (staleTerms.has(id)) {
            name.style.opacity = '0.6'; name.style.fontStyle = 'italic';
            why.textContent = 'edited';
            why.style.color = ''; why.style.opacity = '0.6'; why.style.fontStyle = 'italic';
            why.title = 'Renamed since the audit — re-audit to judge this term';
        }
        row.append(cb, name);
        if (onEdit) {
            name.style.cursor = 'pointer';
            // The new term has no df in the cached scan, so the row is marked stale rather than re-judged (a rebuild is seconds).
            name.addEventListener('click', () => editKeyInline(e, r.term, name, 'key', next => {
                if (next) {
                    const to = rowId(e.uid, next);
                    staleTerms.add(to);
                    checks.delete(id);
                    // Explicitly false, so cleanupGroups' defChecked does not tick it: an edited term reads unattested
                    // in the cached scan, and pre-ticking it for deletion on that is exactly the wrong answer.
                    checks.set(to, false);
                }
                onEdit();
            }));
            const del = document.createElement('i'); del.className = 'fa-solid fa-xmark wa-term-act';
            del.title = 'Delete this keyword — shift-click to ignore it instead';
            del.style.marginLeft = '0.4rem';
            del.addEventListener('click', ev => {
                if (ev.shiftKey) { toggleIgnore(r.term); return; }   // afterIgnoreChange repaints the list itself
                const i = (Array.isArray(e.key) ? e.key : []).indexOf(r.term);
                if (i >= 0) { e.key.splice(i, 1); save(); }
                onEdit();
            });
            row.append(del);
        }
        row.append(why);
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
    /** Confirms which chats to scan, grouped by card and pre-ticked by binding; global candidates and the open chat start unticked. */
    const pickChats = async candidates => {
        const wrap = document.createElement('div');
        // Scrolls: the shift-click list is every chat on the install, which is hundreds of rows on a real one (P1).
        wrap.style.cssText = 'text-align:left;max-width:44rem;max-height:60vh;overflow-y:auto;';
        wrap.innerHTML = `<h3 style="margin:0 0 0.6em;">Check keys against which chats?</h3>`;
        // Grouped by card, keyed on the avatar: two cards can carry the same name, and a chat belongs to the file it lives beside.
        const groups = new Map();
        const keyFor = c => {
            if (c.avatar) return c.avatar;
            // The open chat carries no avatar; it joins its own card's group rather than forming a second one under the same name.
            for (const [k, g] of groups) if (g.char === c.char) return k;
            return c.char || '';
        };
        candidates.forEach((c, i) => {
            const k = keyFor(c);
            if (!groups.has(k)) groups.set(k, { char: c.char, items: [] });
            groups.get(k).items.push({ c, i });
        });
        // Nothing is pre-ticked in the all list: binding is what makes a chat this book's evidence, and there it means nothing.
        const preTick = c => !!c.bound && !candidates.all;
        const rows = [], syncers = [];
        // Cards holding something pre-ticked first, so the shift-click list does not open on a wall of unrelated cards.
        for (const g of [...groups.values()].sort((a, b) => Number(b.items.some(x => x.c.bound)) - Number(a.items.some(x => x.c.bound)))) {
            const det = document.createElement('details');
            det.style.cssText = 'margin:0.15em 0;';
            const sum = document.createElement('summary');
            sum.style.cssText = 'cursor:pointer;user-select:none;';
            det.append(sum);
            const boxes = g.items.map(({ c, i }) => {
                const lab = document.createElement('label');
                lab.className = 'checkbox_label';
                lab.style.cssText = 'display:flex;gap:0.5em;align-items:baseline;margin:0.15em 0 0.15em 1.2em;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = preTick(c);   // bound chats on; global candidates and the merely-open one off
                cb.dataset.i = String(i);
                const txt = document.createElement('span');
                txt.innerHTML = `${escapeHtml(c.file.replace(/\.jsonl$/, ''))} <small style="opacity:0.6;">· ${escapeHtml(String(c.size))} · ${escapeHtml(c.why)}</small>`;
                lab.append(cb, txt);
                det.append(lab);
                rows.push(cb);
                return cb;
            });
            // Closed, except a card holding a pre-ticked chat: what the scan is about to read is never hidden behind a twisty.
            det.open = g.items.some(({ c }) => preTick(c));
            const sync = () => {
                const on = boxes.filter(b => b.checked).length;
                sum.innerHTML = `${escapeHtml(String(g.char || '—'))} <small style="opacity:0.6;">· ${boxes.length} chat${boxes.length === 1 ? '' : 's'}${on ? ` · ${on} selected` : ''}</small>`;
            };
            syncers.push(sync); sync();
            wrap.append(det);
        }
        const tot = document.createElement('div');
        tot.style.cssText = 'margin-top:0.6em;opacity:0.8;font-size:0.9em;';
        const syncTot = () => {
            const on = rows.filter(cb => cb.checked).length;
            tot.textContent = `${on} chat(s) selected`;
            for (const s of syncers) s();
        };
        rows.forEach(cb => cb.addEventListener('change', syncTot));
        wrap.append(tot); syncTot();
        if (candidates.isGlobal && !candidates.all) {
            const g = document.createElement('small');
            g.style.cssText = 'display:block;opacity:0.75;margin-top:0.4em;';
            g.textContent = 'This book is globally active, so it reaches every chat.';
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
            return { char: c.name, avatar: c.avatar, charWorld: c?.data?.extensions?.world ?? null, extraBooks: extraBooksOf(c.avatar), chats };
        }));
        return chatIndex;
    };

    /** Chats this book could plausibly be checked against; `all` drops the binding filter and lists every chat on the install. */
    const findBookChats = async (all = false) => {
        // A book binds four ways: chat (chat_metadata.world_info), character (data.extensions.world), the character's
        // additional lorebooks (world_info.charLore[].extraBooks, keyed by avatar filename), global (selected_world_info,
        // never pre-ticked). The same four attachedBookNames reads.
        const isGlobal = (selected_world_info ?? []).includes(selected);
        const out = [];
        // bindingIndex, not loadChatIndex: line 0 of each chat where the plugin is present, never the whole file.
        for (const c of await bindingIndex()) {
            const cardBound = c.charWorld === selected;
            const auxBound = !cardBound && (c.extraBooks ?? []).includes(selected);
            const charBound = cardBound || auxBound;
            for (const ch of c.chats) {
                const chatBound = ch?.chat_metadata?.world_info === selected;
                if (!chatBound && !charBound && !isGlobal && !all) continue;
                out.push({ char: c.char, avatar: c.avatar, file: ch.file_name, size: ch.file_size ?? '?',
                    why: chatBound ? 'chat-bound' : cardBound ? 'character-bound' : auxBound ? 'character-bound (additional lorebook)' : isGlobal ? 'global (book is always active)' : 'not bound',
                    bound: chatBound || charBound });
            }
        }
        out.isGlobal = isGlobal;
        out.all = all;
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

    /** One pass of `keys` over `picked`: counts by both routes, merged. Plugin route for whatever is on disk — it runs this
     *  same countChatHits where the files live and returns counts only, so a 25MB chat never crosses the wire; the open
     *  chat has no file, so it is always the browser's. Results merge by summing every field (countChatHits), so the two
     *  routes can split the picked chats between them. */
    const scanKeys = async (keys, picked) => {
        const totals = new Map(keys.map(k => [k, 0])), typedTotals = new Map();
        let seen = 0, via = '';
        const add = got => {
            for (const [k, n] of got.messagesWith) totals.set(k, (totals.get(k) ?? 0) + n);
            for (const [k, n] of got.typedWith ?? []) typedTotals.set(k, (typedTotals.get(k) ?? 0) + n);
            seen += got.messages;
        };
        let onDisk = picked.filter(c => !c.open && c.avatar);
        if (runState.pluginAvailable && onDisk.length) {
            const r = await fetch('/api/plugins/worlds-apart/scan-chats', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ keys, wordBoundary: settings().wordBoundary, chats: onDisk.map(c => ({ dir: c.avatar.replace(/\.png$/, ''), file: c.file })) }),
            });
            const j = r.ok ? await r.json() : null;
            // 0 messages means the route resolved no files; taking it would zero every key's share, so the browser retries them.
            if (Number(j?.messages)) {
                for (const k of keys) {
                    totals.set(k, Number(j.counts?.[k]) || 0);
                    if (j.typed && k in j.typed) typedTotals.set(k, Number(j.typed[k]) || 0);
                }
                seen = Number(j.messages);
                via = 'server';
            } else {
                console.warn('Worlds Apart: /scan-chats returned nothing, falling back to client-side scan', j);
                onDisk = [];
            }
        } else {
            onDisk = [];
        }
        const served = new Set(onDisk);
        const ctx = getContext();
        const msgs = [];
        for (const c of picked) {
            if (served.has(c)) continue;
            const got = c.open
                ? (ctx.chat ?? []).filter(m => m && !m.is_system).map(m => String(m.mes ?? '')).filter(Boolean)
                : await fetchChatMessages(c);
            msgs.push(...got);
        }
        if (msgs.length) {
            add(countChatHits(keys, msgs));
            via = via ? 'server + browser' : 'browser';
        }
        return { totals, typedTotals, seen, via };
    };

    /** Scans the chosen chats and installs the counts — the one gatherer for the picker and the audit; returns a summary, no toast or repaint. */
    const scanChats = async (picked, label) => {
        const own = bookKeys();
        if (!own.length || !picked?.length) return null;
        // The orthographic alternates ride along as ordinary keys: the audit can only cite chat evidence for a pattern
        // somebody counted, and both routes scan whatever list they are handed.
        // Common-path probes ride in the first pass ungated: only a SmartKey with two or more common paths has any, a
        // handful per book, and each is a conjunction of common words that the automaton pass already tallies.
        const keys = [...new Set([...own, ...own.flatMap(k => orthoAlternates(k).map(a => a.alt)), ...own.flatMap(commonPathProbes)])];
        const first = await scanKeys(keys, picked);
        if (!first.seen) return null;
        const { totals, typedTotals, seen } = first;
        let via = first.via;
        // Second pass, probes only for the keys over the gate: a probe is a SmartKey evaluated per message, and the gate
        // admits a handful of keys where the book has thousands.
        const gate = studioOpts.chatCommon ?? KEY_CHAT_COMMON;
        const probes = own.filter(k => (totals.get(k) ?? 0) / seen >= gate).flatMap(collisionProbes);
        if (probes.length) {
            const second = await scanKeys(probes, picked);
            for (const [k, n] of second.totals) totals.set(k, n);
            if (second.via && second.via !== via) via = 'server + browser';
        }
        chatHits = totals;
        chatTyped = typedTotals;
        chatMsgs = seen;
        chatName = label;
        chatNames = picked.map(c => String(c.file).replace(/\.jsonl$/, ''));
        return { keys, live: [...totals.values()].filter(n => n > 0).length, via };
    };

    /** Every chat BOUND to this book; excludes chats that qualify only because the book is global. */
    const boundChats = async () => {
        let bound = (await findBookChats()).filter(c => c.bound);
        // The index is session-cached, so a chat bound since reads as absent: drop the cache and look again.
        if (!bound.length) { chatIndex = null; bound = (await findBookChats()).filter(c => c.bound); }
        return bound;
    };

    const runChatScan = async (all = false) => {
        if (!scan) { toastr.info('Run the audit first.', 'Worlds Apart'); return; }
        toastr.info(all ? 'Listing every chat…' : 'Finding chats that use this book…', 'Worlds Apart', { timeOut: 2000 });
        const found = await findBookChats(all);
        // The open chat is offered too, unticked, for the case the metadata does not capture — never assumed.
        const ctx = getContext();
        const openName = String(ctx.chatId ?? '');
        if (openName && !found.some(f => f.file.startsWith(openName))) {
            found.push({ char: ctx.name2 ?? '', avatar: null, file: openName, size: `${(ctx.chat ?? []).length} msgs`, why: 'currently open', open: true });
        }
        if (!found.length) {
            toastr.warning(all ? 'No chats found.' : `No chat is bound to "${selected}". Shift-click to pick any chat.`,
                'Worlds Apart', { timeOut: 9000 });
            return;
        }

        const picked = await pickChats(found);
        if (!picked?.length) return;
        const label = picked.length === 1 ? picked[0].file.replace(/\.jsonl$/, '') : `${picked.length} chats`;
        const got = await scanChats(picked, label);
        if (!got) { toastr.warning('Those chats returned no messages.', 'Worlds Apart'); return; }
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
        // Only the absence is worth saying: the bulk bar carries the counts when there are any.
        if (!got && !chatHits) toastr.info(`Audited against entry text only — no chat is bound to "${selected}".`, 'Worlds Apart', { timeOut: 6000 });
    };

    const cleanupGroups = () => {
        if (!scan) return [];
        const out = [];
        for (const e of visibleEntries()) {
            const rows = scan.classifyEntry(e).map(p => {
                const rc = scan.reasonOf(p);
                const id = rowId(e.uid, p.key);
                if (!cleanupChecks.has(id)) cleanupChecks.set(id, scan.defChecked(p));   // pre-tick policy shared with the pruner
                return { term: p.key, why: rc.text, color: SEVERITY_COLOR[rc.severity] ?? '', sev: rc.severity, p };
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
        if (!removed.length) { toastr.info('Nothing selected.', 'Worlds Apart'); return; }
        cleanupUndo = removed;
        save(); rebuildScan(); suggest = null; renderExplorer();
        toastr.success(`Deleted ${removed.length} keyword${removed.length === 1 ? '' : 's'} — Undo is in the bar.`, 'Worlds Apart');
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
            ? `Re-run the keyword audit with the current Tool Settings.\nChat evidence: ${chatLabel()}, ${chatMsgs} messages.`
            : 'Re-run the keyword audit with the current Tool Settings.\nNo chat searched yet.';
        auditBtn.addEventListener('click', async () => { await withBusy(auditBtn, '0.5', runAudit, '<i class="fa-solid fa-spinner fa-spin"></i> Auditing…'); renderExplorer(); });
        // Search repaints only the list: rebuilding the header would drop the input's focus mid-keystroke.
        row1.append(auditBtn, buildFilterBtn(renderExplorer), buildSortControl(() => repaint()), buildSearchBox(() => repaint()), trayBtn());
        head.append(row1);
        const fixed = document.createElement('div'); fixed.className = 'wa-studio-fixed';
        trayEl = renderTray();
        const bar = document.createElement('div'); bar.className = 'wa-bulk-on';
        const ignStrip = document.createElement('div'); ignStrip.className = 'wa-ign-strip';
        const flagStrip = document.createElement('div'); flagStrip.className = 'wa-ign-strip';
        fixed.append(head, trayEl, bar, flagStrip, ignStrip);
        const list = document.createElement('div'); list.className = 'wa-studio-entries';
        pane.append(fixed, list);

        let groups = [], allIds = [], reg = { row: new Map(), grp: [] };
        // Repaints the list, not just the bar: it changes which rows exist.
        const showAllBtn = () => {
            const b = barBtn(cleanupShowAll ? 'Flagged only' : 'Show all', () => { cleanupShowAll = !cleanupShowAll; repaint(); });
            b.title = cleanupShowAll ? 'List only the keys the audit flagged' : 'List every key on every visible entry, flagged or not';
            return b;
        };
        const chatScanBtn = () => {
            const b = barBtn(chatHits ? 'Rescan chats' : 'Scan chats',
                ev => runChatScan(ev?.shiftKey).catch(e => { console.error('Worlds Apart: chat scan failed', e); toastr.error(String(e?.message ?? e), 'Worlds Apart'); }));
            b.title = 'Count how many chat messages each key matches, over the chats this book is bound to.\nShift-click to pick from every chat on this install instead.';
            return b;
        };
        const paintBar = () => {
            const on = allIds.filter(id => cleanupChecks.get(id)).length;
            const allOn = allIds.length > 0 && on === allIds.length;
            bar.innerHTML = '';
            const count = document.createElement('span'); count.className = 'wa-bulk-count';
            count.textContent = `${on}/${allIds.length} selected`;
            count.title = 'Ticked by the audit, not by hand.';
            bar.append(count,
                barBtn(allOn ? 'Select none' : 'Select all', () => {
                    for (const id of allIds) cleanupChecks.set(id, !allOn);
                    sync();
                }),
                barBtn('Delete', pruneChecked, 'wa-bulk-danger'),
                barBtn('Ignore', ignoreChecked),
                showAllBtn(),
                chatScanBtn(),
            );
            if (chatHits) {
                const note = document.createElement('span'); note.className = 'wa-bulk-count';
                note.textContent = `· ${[...chatHits.values()].filter(n => n > 0).length}/${chatHits.size} fire in ${chatLabel()} (${chatMsgs} msgs)`;
                // Only when the label collapsed them; at one chat the note already says which.
                if (chatNames.length > 1) note.title = chatNames.slice(0, 20).join('\n') + (chatNames.length > 20 ? `\n+${chatNames.length - 20} more` : '');
                bar.append(note);
            }
            if (cleanupUndo?.length) bar.append(barBtn(`Undo (${cleanupUndo.length})`, undoPrune));
        };
        /** One tri-state box per verdict present, in the classifier's own priority order, so triage runs a flag at a time. */
        const paintFlags = () => {
            flagStrip.innerHTML = '';
            const buckets = new Map();
            for (const g of groups) for (const r of g.rows) {
                const name = r.p?.flag ?? r.why;   // show-all rows carry no verdict: "not flagged", or "ignored"
                if (!buckets.has(name)) buckets.set(name, []);
                buckets.get(name).push({ id: rowId(g.entry.uid, r.term), sev: r.sev });
            }
            if (buckets.size < 2) { flagStrip.style.display = 'none'; return; }   // one flag is the Select all button
            flagStrip.style.display = 'flex';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'opacity:0.7;font-size:0.85em;white-space:nowrap;';
            lbl.textContent = 'Flags:';
            flagStrip.append(lbl);
            const rank = n => { const i = FLAG_PRIORITY.indexOf(n); return i < 0 ? FLAG_PRIORITY.length : i; };
            for (const name of [...buckets.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
                const rows = buckets.get(name);
                const on = rows.filter(r => cleanupChecks.get(r.id)).length;
                const wrap = document.createElement('label');
                wrap.className = 'checkbox_label';
                wrap.style.cssText = 'display:flex;gap:0.35em;align-items:center;margin:0;white-space:nowrap;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'wa-tri';
                cb.checked = on > 0 && on === rows.length;
                cb.indeterminate = on > 0 && on < rows.length;
                cb.addEventListener('change', () => { for (const r of rows) cleanupChecks.set(r.id, cb.checked); sync(); });
                const txt = document.createElement('span');
                let worst = '';
                for (const r of rows) if ((SEVERITY_RANK[r.sev] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) worst = r.sev;
                if (SEVERITY_COLOR[worst]) txt.style.color = SEVERITY_COLOR[worst];
                txt.innerHTML = `${escapeHtml(name)} <small style="opacity:0.6;">${on}/${rows.length}</small>`;
                wrap.append(cb, txt);
                flagStrip.append(wrap);
            }
        };
        const sync = () => { syncTermChecks(cleanupChecks, reg); paintBar(); paintFlags(); };
        const repaint = () => keepScroll(() => {
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
                    (e, row, x, y) => showKwMenu(row.term, x, y), repaint));
            }
            sync();
        });
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

    // --- Keyword Lab ---
    /** Seven hues, one per colour family, none in the red band SEVERITY_COLOR uses. labInk indexes them and desaturates on
     *  the second pass, so fourteen positions run before a colour repeats. */
    const LAB_HUES = [215, 120, 305, 35, 180, 265, 58];
    const labInk = (i, a = 1) => {
        const pastel = i % (LAB_HUES.length * 2) >= LAB_HUES.length;
        return `hsl(${LAB_HUES[i % LAB_HUES.length]} ${pastel ? 45 : 80}% ${pastel ? 68 : 50}%${a < 1 ? ` / ${a}` : ''})`;
    };

    /** `sg`'s window text with every hit in it guillemeted, «so» for a positive and »so« for a negative, for a title
     *  attribute, which takes no markup. Over 320 characters it is clipped to 110 either side of `ex`. */
    const windowTip = (sg, ex) => {
        const src = String(sg.text ?? '');
        const wide = src.length > 320;
        const from = wide ? Math.max(0, ex.at - 110) : 0;
        const to = wide ? Math.min(src.length, ex.to + 110) : src.length;
        let out = '', at = from;
        for (const x of [...sg.excerpts].sort((a, b) => a.at - b.at)) {
            if (x.at < from || x.to > to) continue;
            const [open, close] = x.negated ? ['\u00bb', '\u00ab'] : ['\u00ab', '\u00bb'];
            out += `${src.slice(at, x.at)}${open}${src.slice(x.at, x.to)}${close}`;
            at = x.to;
        }
        out = `${out}${src.slice(at, to)}`.replace(/\s+/g, ' ').trim();
        return `${from > 0 ? '\u2026' : ''}${out}${to < src.length ? '\u2026' : ''}`;
    };

    /** A markSpan for renderMessageHtml: the key's ink, or SEVERITY_COLOR.severe for a negated span. */
    const labMark = ink => (sp, text) => {
        const fill = sp.negated ? `color-mix(in srgb, ${WA_RED} 40%, transparent)` : ink(sp, 0.4);
        const edge = sp.negated ? WA_RED : ink(sp);
        const label = k => `${k.negated ? '\u2212 ' : ''}${k.term && k.term !== k.key ? `${k.key} \u2014 ${k.term}` : k.key}`;
        // Outline as well as wash: rendered HTML in the text sets its own background, which the wash disappears into.
        return `<span data-at="${sp.start}" data-to="${sp.end}" data-key="${escapeHtml(sp.key)}"`
            + ` title="${escapeHtml(sp.keys.map(label).join('\n'))}"`
            + ` style="background:${fill};outline:1px solid ${edge};border-radius:2px;`
            + `border-bottom:2px solid ${edge};color:inherit;">${escapeHtml(text)}</span>`;
    };

    /** The haystack rendered as a message, with every span marked in its key's colour. Offsets are keyExcerpts', into NFC. */
    const markedHtml = (text, spans, ink) => renderMessageHtml(text, { spans, markSpan: labMark(ink), showMarkup: labShowMarkup });

    let labHay = '', labKeys = '';
    let labCase = !!world_info_case_sensitive, labWhole = !!world_info_match_whole_words;
    // `message` cuts on MESSAGE_BREAK lines, which the chat import writes.
    let labWindow = settings().matchWindow;
    let labCommitted = false;
    let labRepaint = null;   // the Lab's repaint, claimed by renderLabView: an applied run is triggered from outside it
    let labRun = null;   // an applied book: { book, entries: [{ entry, rows }] }, shown in place of the typed keys' result
    let labShowMarkup = false;
    let labSkipVector = false;   // entries meant to arrive by cosine, left out of a run
    let labRunSource = null;     // how to re-read what the last run ran over: `{ label, load }`, so a re-run sees the books
                                 // as they are now: a snapshot taken at apply time would still hold a key since deleted   // the source behind the rendering: every tag, entity and delimiter shown at once
    let labSec = '', labLogic = String(WI_LOGIC.AND_ANY);

    /** The chat as WA reads it for a scan: is_system dropped, dropChatTags applied, the last `messageDepth` messages —
     *  `override` messages instead when given — names included per world_info_include_names. Joined on MESSAGE_BREAK rules. */
    const chatHaystack = (override) => {
        const spec = settings().dropChatTags;
        const raw = getContext().chat ?? [];
        const chat = raw
            .filter(m => m && !m.is_system)
            .map(m => (spec?.trim() ? { ...m, mes: dropTags(String(m.mes ?? ''), spec) } : m));
        const depth = Number(override ?? (settings().messageDepth || world_info_depth));
        const messages = scanSegments(chat, { depth, includeNames: world_info_include_names, matchWindow: 'message' });
        // Reports depth and the is_system drop: neither is visible in the pane, and both change the count.
        const hidden = raw.length - chat.length;
        toastr.info(`${messages.length} message${messages.length === 1 ? '' : 's'} at depth ${depth}`
            + `${hidden ? `, ${hidden} hidden message${hidden === 1 ? '' : 's'} skipped` : ''}`
            // dropChatTags removes the named element WITH its contents, so a tracker block leaves a gap in the pane.
            + `${spec?.trim() ? `. Dropped, with contents: ${escapeHtml(spec)}` : ''}`, 'Keyword Lab');
        return messages.join(`\n\n${'-'.repeat(24)}\n\n`);
    };

    /** `{ keys, sec, logic }` from an entry of any book, as the entry spells them. Null when nothing was chosen. */
    const pickEntryKeys = async () => {
        const w = document.createElement('div');
        w.style.cssText = 'text-align:left;';
        w.innerHTML = 'Take the keys of an entry in'
            + '<div style="margin-top:8px;"><select class="wa-lab-book text_pole" style="width:100%;">'
            + [...world_names].sort((a, b) => a.localeCompare(b))
                .map(n => `<option value="${escapeHtml(n)}"${n === selected ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')
            + '</select></div>'
            + '<div style="margin-top:8px;"><select class="wa-lab-entry text_pole" style="width:100%;"></select></div>';
        const bookSel = w.querySelector('.wa-lab-book');
        const entrySel = w.querySelector('.wa-lab-entry');

        let book = null;
        const fill = async () => {
            entrySel.innerHTML = '<option value="">Loading…</option>';
            // `data` for the open book; any other is loaded on the change.
            book = bookSel.value === selected ? data : await loadWorldInfo(bookSel.value);
            const entries = Object.values(book?.entries ?? {}).filter(e => usableKeys(e?.key).length).sort(SORT_FNS['title-asc']);
            entrySel.innerHTML = entries.length
                ? entries.map(e => `<option value="${escapeHtml(String(e.uid))}">${escapeHtml(wiTitleOf(e))} \u2014 ${escapeHtml(usableKeys(e.key).join(', '))}</option>`).join('')
                : '<option value="">(no entry in this book has keys)</option>';
        };
        bookSel.addEventListener('change', () => { fill(); });
        await fill();

        const p = new Popup(w, POPUP_TYPE.CONFIRM, '', { okButton: 'Import keys', cancelButton: 'Cancel' });
        if (await p.show() !== POPUP_RESULT.AFFIRMATIVE) return null;
        const e = book?.entries?.[entrySel.value];
        if (!e) return null;
        const sec = e.selective ? secondaryKeys(e) : [];
        return { keys: usableKeys(e.key), sec, logic: String(e.selectiveLogic ?? WI_LOGIC.AND_ANY) };
    };

    /** One keyHits row as HTML: a chip, its tally, and a block per window holding that window's branch counts and
     *  excerpts. A window the key did not match in is dimmed. `entry` stamps data-uid/data-world for the chip menu. */
    /** Key text with a break opportunity before each operator and a non-breaking space after it, so a wrapped SmartKey
     *  starts its line on the operator. */
    const keyChipText = key => escapeHtml(key)
        .replace(/ \| /g, '<wbr> |\u00a0')
        .replace(/ &amp; /g, '<wbr> &amp;\u00a0')
        .replace(/ (?=[-!+(])/g, '<wbr> ');

    const labKeyHtml = (r, color, entry = null) => {
        const chip = `<span class="wa-kw wa-kw-wrap" style="border-color:${escapeHtml(color)};background:color-mix(in srgb, ${escapeHtml(color)} 18%, transparent);">${keyChipText(r.key)}</span>`;
        const num = n => `<span style="color:var(--SmartThemeEmColor, #d9a441);font-weight:600;">${n}</span>`;
        if (r.message) return `<div style="margin-bottom:8px;">${chip} <small style="opacity:0.75;">${escapeHtml(r.message)}</small></div>`;
        if (!r.segments.length) return `<div style="margin-bottom:8px;">${chip} ${num(r.count)}</div>`;
        const span = (e, sg) => `<div style="margin-left:8px;" data-jump="${sg.at + e.at}" title="${escapeHtml(windowTip(sg, e))}">`
            + `<small style="opacity:0.75;">${escapeHtml(e.text.slice(0, e.start))}`
            + `<span style="color:${e.negated ? WA_RED : escapeHtml(color)};font-weight:600;">${escapeHtml(e.text.slice(e.start, e.end))}</span>`
            + `${escapeHtml(e.text.slice(e.end))}</small></div>`;
        const seg = (sg, i) => `<div style="margin:5px 0 0 6px;${i ? 'padding-top:5px;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);' : ''}`
            + `${sg.matched ? '' : 'opacity:0.55;'}">`
            + `<small>${sg.leaves.map(l => `${escapeHtml(l.negated ? `-${l.term}` : l.term)} ${num(l.n)}`).join(', ')}</small>`
            + sg.excerpts.map(e => span(e, sg)).join('')
            + '</div>';
        // labExpanded carries the open state across the repaint that rebuilds this element.
        // A key with one positive branch cannot be filtered by a window, so its tally is occurrences.
        const oneBranch = r.segments.every(sg => sg.leaves.length === 1 && !sg.leaves[0].negated);
        const filtered = r.segments.filter(sg => !sg.matched).length;
        const tally = oneBranch
            ? num(r.count)
            : `${num(`${r.segments.length - filtered} matched`)}${filtered ? `<small style="opacity:0.5;">, ${filtered} filtered</small>` : ''}`;
        // keyHits gives a single-branch key every occurrence, so these are listed flat rather than per window.
        const body = oneBranch
            ? r.segments.flatMap(sg => sg.excerpts.map(e => span(e, sg))).join('')
            : r.segments.map((sg, i) => seg(sg, i)).join('');
        const entryAttrs = entry ? ` data-uid="${escapeHtml(String(entry.uid))}" data-world="${escapeHtml(entry.world ?? '')}"` : '';
        return `<details${labExpanded.has(r.key) ? ' open' : ''} data-k="${escapeHtml(r.key)}"${entryAttrs} style="margin-bottom:8px;">`
            + `<summary style="cursor:pointer;">${chip} ${tally}</summary>${body}</details>`;
    };

    /** Key texts the reader has opened; shut is the default. Survives the repaint, and the tab and popout share it. */
    const labExpanded = new Set();

    /** Re-attaches the collapse state to a freshly painted digest, and the Explorer's shift-click-for-all to its summaries. */
    const bindCollapse = host => {
        const blocks = [...host.querySelectorAll('details[data-k]')];
        for (const d of blocks) {
            d.addEventListener('toggle', () => (d.open ? labExpanded.add(d.dataset.k) : labExpanded.delete(d.dataset.k)));
            const sum = d.querySelector('summary');
            if (!sum) continue;
            sum.title = 'Shift-click for every other key';
            // preventDefault leaves the clicked block as it was; setting `open` fires each other block's own toggle.
            sum.addEventListener('click', ev => {
                if (!ev.shiftKey) return;
                ev.preventDefault();
                const others = blocks.filter(x => x !== d);
                const anyOpen = others.some(x => x.open);
                for (const x of others) x.open = !anyOpen;
            });
        }
    };

    /** Runs `entries` against the haystack and shows the result; `label` names what ran, for the header. */
    const applyFrom = async (label, load) => {
        labRunSource = { label, load };
        const run = runBook(await load(), labHay, {
            matchWindow: labWindow,
            context: 30,
            defaults: { caseSensitive: world_info_case_sensitive, wholeWords: world_info_match_whole_words },
            skipVectorized: labSkipVector,
        });
        labRun = { label, ...run };
        toastr.info(`${run.entries.length} of ${run.scanned} keyed ${run.scanned === 1 ? 'entry' : 'entries'} matched`, 'Keyword Lab');
        labRepaint?.();
    };

    /** One book by name, for the arbitrary-book path; the open one is already loaded. */
    const bookEntries = async name => Object.values((name === selected ? data : await loadWorldInfo(name))?.entries ?? {})
        .map(e => ({ ...e, world: e.world ?? name }));

    const applyOneBook = async name => applyFrom(name, () => bookEntries(name));

    /** Applies every attached book. Falls back to the picker when none is attached. */
    const applyAttached = async ({ pickIfNone = false } = {}) => {
        const names = attachedBookNames();
        if (!names.length) {
            // Only on a click. Opening the Lab is not a request for a dialog, and one raised here lands behind the Studio.
            if (!pickIfNone) { toastr.info('No lorebook is attached to this chat.', 'Keyword Lab'); return; }
            const name = await pickBook('Nothing is attached to this chat. Apply which lorebook?', true);
            if (name) await applyOneBook(name);
            return;
        }
        await applyFrom(`${names.length} attached ${names.length === 1 ? 'book' : 'books'}`,
            async () => (await Promise.all(names.map(bookEntries))).flat());
    };

    /** labRun as HTML: a tally line, then a collapsible block per hit entry holding its keys' rows. */
    const labRunHtml = () => {
        const { label, entries, scanned, books, keyList } = labRun;
        const where = books.length > 1 ? `${books.length} books` : (books[0] ?? label);
        const head = `<div style="margin-bottom:8px;"><b>${entries.length}/${scanned}</b>`
            + `<small style="opacity:0.6;"> ${scanned === 1 ? 'entry' : 'entries'} in ${escapeHtml(where)}</small>`
            + ' <i class="fa-solid fa-xmark wa-run-clear" title="Back to the typed keys" style="cursor:pointer;opacity:0.6;"></i></div>';
        // scanned 0 and entries 0 both read as 0/0, so the no-keys case says so.
        if (!scanned) return `${head}<div style="opacity:0.6;">No entry there has a key to match with.</div>`;
        if (!entries.length) return head;
        return head + entries.map(({ entry, rows }) => {
            const title = `<b style="overflow-wrap:anywhere;">${escapeHtml(wiTitleOf(entry))}</b>`
                + `<small style="opacity:0.6;"> ${rows.length} key${rows.length === 1 ? '' : 's'}</small>`;
            const bookLine = entry.world ? `<div><small style="opacity:0.45;">${escapeHtml(entry.world)}</small></div>` : '';
            return `<details open style="margin-bottom:8px;"><summary style="cursor:pointer;">${title}${bookLine}</summary>`
                + `<div style="margin-left:10px;">${rows.map(r => labKeyHtml(r, labInk(Math.max(0, keyList.indexOf(r.key))), entry)).join('')}</div></details>`;
        }).join('');
    };

    /** A digest line jumps to its hit in `textEl`. The offset may land inside a span that starts earlier — an overlap folds
     *  to one mark — so the mark that contains it is the target, not one that begins at it. */
    /** Right-click a key block that came from an entry: the operations, on that entry's book. */
    const bindKwMenu = digestEl => digestEl.addEventListener('contextmenu', ev => {
        const block = ev.target.closest('details[data-k][data-world]');
        if (!block) return;
        ev.preventDefault();
        showLabKwMenu(block.dataset.k, block.dataset.uid, block.dataset.world, ev.clientX, ev.clientY);
    });

    const bindJump = (digestEl, textEl) => {
        digestEl.addEventListener('click', ev => {
            const line = ev.target.closest('[data-jump]');
            if (!line || !textEl?.isConnected) return;
            const n = Number(line.dataset.jump);
            const mark = [...textEl.querySelectorAll('[data-at]')].find(x => Number(x.dataset.at) <= n && n < Number(x.dataset.to));
            if (mark) revealIn(mark);
        });
    };

    /** Loads the book `world`, hands its entries to `mutate`, and saves it if anything changed. The open book is the one in
     *  hand — mutating a fresh copy of it would be lost the next time the Explorer saves — and any other is read and written
     *  on its own. `mutate` returns how many entries it touched. */
    const applyToBook = async (world, mutate) => {
        const isOpen = world === selected;
        const book = isOpen ? data : await loadWorldInfo(world);
        if (!book?.entries) { toastr.warning(`Could not load “${world}”.`, 'Worlds Apart'); return 0; }
        const touched = mutate(Object.values(book.entries), book);
        if (!touched) return 0;
        // Not while the Lab is up: renderExplorer rebuilds the tab, discarding the Lab's panes and run.
        if (isOpen) { save(); if (tab !== 'lab') renderExplorer(); } else await saveWorldInfo(world, book, true);
        return touched;
    };

    /** One book, then a re-run so the digest and the text agree with what is now on disk. */
    const editInBook = async (world, mutate) => {
        const n = await applyToBook(world, mutate);
        if (n) rerunLab();
        return n;
    };

    /** Every attached book in turn, and one re-run at the end rather than one per book. */
    const editInAttached = async mutate => {
        let n = 0;
        for (const world of attachedBookNames()) n += await applyToBook(world, mutate);
        if (n) rerunLab();
        return n;
    };

    /** The three book-wide operations at one scope: `apply(mutate)` runs it over a book or over the attached set. */
    const bookWideOps = (key, scopeLabel, apply) => [
        {
            label: `Delete across ${scopeLabel}…`,
            danger: true,
            // No count: it would take loading every book to know.
            fn: async () => {
                if (!await Popup.show.confirm(`Delete “${key}” from every entry in ${scopeLabel}?`,
                    'Removes the keyword everywhere it appears there.')) return;
                const n = await apply(es => deleteKey(es, key));
                toastr[n ? 'success' : 'info'](n
                    ? `Deleted “${key}” from ${n} ${n === 1 ? 'entry' : 'entries'}.`
                    : `Nothing in ${scopeLabel} is keyed “${key}”.`, 'Worlds Apart');
            },
        },
        {
            label: `Replace across ${scopeLabel}…`,
            fn: async () => {
                const next = (await Popup.show.input('Replace keyword', `Replace “${key}” across ${scopeLabel} with:`, key))?.trim();
                if (!next || next === key || !keyWriteOk(next)) return;
                const n = await apply(es => replaceKey(es, key, next));
                toastr[n ? 'success' : 'info'](n
                    ? `Replaced “${key}” → “${next}” in ${n} ${n === 1 ? 'entry' : 'entries'}.`
                    : `Nothing in ${scopeLabel} is keyed “${key}”.`, 'Worlds Apart');
            },
        },
        {
            label: `Add variant across ${scopeLabel}…`,
            fn: async () => {
                const raw = await Popup.show.input('Add variant', `Keyword to add to every entry in ${scopeLabel} keyed “${key}”:`);
                const term = String(raw ?? '').trim();
                if (!term || !keyWriteOk(term)) return;
                const n = await apply(es => addVariant(es, key, term));
                toastr[n ? 'success' : 'info'](n
                    ? `“${term}” added to ${n} ${n === 1 ? 'entry' : 'entries'} keyed “${key}”.`
                    : `Every entry in ${scopeLabel} keyed “${key}” already has “${term}”.`, 'Worlds Apart');
            },
        },
    ];

    /** The Explorer's chip operations, scoped to the book the entry came from and to the attached set. No Ignore: that is the
     *  pruner's whitelist, and this view is a list of hits rather than a verdict on a key. */
    const showLabKwMenu = (key, uid, world, x, y) => {
        const attached = attachedBookNames();
        showCtxMenu([
            {
                label: 'Edit…',
                fn: async () => {
                    const next = (await Popup.show.input('Edit keyword', `Rename “${key}” in this entry:`, key))?.trim();
                    if (!next || next === key || !keyWriteOk(next)) return;
                    const n = await editInBook(world, es => {
                        const e = es.find(x => String(x.uid) === String(uid));
                        const held = e?.key?.find(k => kwNorm(k) === kwNorm(key));
                        return held && renameKeyOn(e, held, next) ? 1 : 0;
                    });
                    if (n) toastr.success(`“${key}” → “${next}”.`, 'Worlds Apart');
                },
            },
            {
                label: 'Delete from this entry',
                danger: true,
                fn: async () => {
                    await editInBook(world, es => {
                        const e = es.find(x => String(x.uid) === String(uid));
                        return e ? deleteKey([e], key) : 0;
                    });
                },
            },
            ...bookWideOps(key, `“${world}”`, mutate => editInBook(world, mutate)),
            // Omitted at one attached book, where it repeats the scope above.
            ...(attached.length > 1
                ? bookWideOps(key, `all ${attached.length} attached books`, editInAttached)
                : []),
        ], x, y, ctxMount());
    };

    /** Opens the Lab tab. Loads nothing: reading a chat is the chat tool's job, on a click. */
    const openLabTab = () => {
        tab = 'lab';
        renderExplorer();
    };

    /** Re-runs the last applied books, re-reading them: an edit or a setting change is what asks for this. */
    const rerunLab = () => { if (labRunSource) applyFrom(labRunSource.label, labRunSource.load); };

    /** Scrolls `el` into view and rings it briefly, opening whatever it is folded inside. */
    const revealIn = el => {
        for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const was = el.style.outline;
        el.style.outline = '2px solid currentColor';
        setTimeout(() => { el.style.outline = was; }, 1200);
    };

    /** The other direction: a mark in the text jumps to what reported it. The key names the block, and the hit line inside it
     *  is the one whose offset falls in the mark — a key with many hits has a line per window, and any of them may be the one. */
    const bindMarkJump = (textEl, digestEl) => {
        textEl.addEventListener('click', ev => {
            const mark = ev.target.closest('[data-at]');
            if (!mark || !digestEl?.isConnected) return;
            const [at, to] = [Number(mark.dataset.at), Number(mark.dataset.to)];
            const block = [...digestEl.querySelectorAll('details[data-k]')].find(d => d.dataset.k === mark.dataset.key);
            if (block) block.open = true;
            const scope = block ?? digestEl;
            const line = [...scope.querySelectorAll('[data-jump]')].find(x => Number(x.dataset.jump) >= at && Number(x.dataset.jump) < to);
            revealIn(line ?? block?.querySelector('summary') ?? block ?? digestEl);
        });
    };

    /** The Lab's result plus the colour to draw it in, from whatever the panes hold now. */
    const scanLab = () => {
        const r = labScan({
            hay: labHay,
            keys: labKeys,
            sec: labSec,
            logic: labLogic,
            matchWindow: labWindow,
            caseSensitive: labCase,
            wholeWords: labWhole,
            context: 30,
            run: labRun,
            defaults: { caseSensitive: world_info_case_sensitive, wholeWords: world_info_match_whole_words },
        });
        const ink = (sp, a) => labInk(Math.max(0, r.keys.indexOf(sp.key)), a);
        for (const row of r.rows) row.color = ink({ key: row.key });
        return { ...r, ink };
    };

    /** The haystack at full width with every match marked, and the digest under it. The tab keeps only the digest: the
     *  marked text needs the room, and the pane above it already shows the same characters unmarked. */
    const showMarkedText = () => {
        const { ink, rows, spans } = scanLab();
        const wrap = document.createElement('div');
        wrap.style.cssText = 'text-align:left;width:100%;display:flex;gap:12px;align-items:stretch;';
        const body = document.createElement('div');
        body.className = 'wa-marked';
        body.style.cssText = 'flex:1.6 1 0;white-space:pre-wrap;line-height:1.6;max-height:78vh;overflow:auto;font-size:0.95em;min-width:0;';
        body.innerHTML = markedHtml(labHay, spans, ink) || '<span style="opacity:0.6;">(no text)</span>';
        const digest = document.createElement('div');
        digest.style.cssText = 'flex:1 1 0;max-height:78vh;overflow:auto;min-width:0;'
            + 'padding-left:12px;border-left:1px solid color-mix(in srgb, currentColor 15%, transparent);';
        digest.innerHTML = labRun ? labRunHtml() : rows.map(r => labKeyHtml(r, r.color)).join('');
        bindCollapse(digest);
        bindJump(digest, body);
        bindMarkJump(body, digest);
        bindKwMenu(digest);
        wrap.append(body, digest);
        const vp = new Popup(wrap, POPUP_TYPE.TEXT, '', { large: true, allowVerticalScrolling: true });
        vp.dlg.style.setProperty('width', 'calc(var(--sheldWidth, 90vw) * 0.9)', 'important');
        vp.dlg.style.setProperty('max-width', 'calc(100dvw - 2em)', 'important');
        vp.show();
    };

    const renderLabView = pane => {
        const panes = document.createElement('div');
        panes.style.cssText = 'flex:5 1 0;display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;';
        const box = (placeholder, get, set) => {
            const t = document.createElement('textarea'); t.className = 'text_pole';
            t.placeholder = placeholder; t.value = get();
            t.style.cssText = 'flex:1 1 0;height:100%;min-height:0;resize:none;font-family:var(--monoFontFamily);overflow:auto;';
            t.addEventListener('input', () => { set(t.value); repaint(); });
            return t;
        };
        const hayBox = box('Paste any text to match against… a line of dashes separates one message from the next', () => labHay, v => { labHay = v; });
        hayBox.style.flex = '1 1 auto';
        // The same box, read-only and marked: text_pole so it keeps the border and padding the textarea had. height and
        // margin beat .text_pole's `fit-content` and `5px 0`, which would let it hug its content and never scroll.
        const hayRead = document.createElement('div'); hayRead.className = 'text_pole wa-marked';
        hayRead.style.cssText = 'flex:1 1 auto;height:100%;min-height:0;margin:0;overflow:auto;white-space:pre-wrap;line-height:1.5;'
                + 'border-style:dashed;background-color:transparent;cursor:default;';
        const hayWrap = document.createElement('div');
        hayWrap.style.cssText = 'flex:3 1 0;position:relative;display:flex;min-height:0;overflow:hidden;margin:5px 0;';
        // Outside hayRead, which scrolls: a child of it would scroll away from the text.
        const hayToggle = document.createElement('i');
        hayToggle.style.cssText = 'position:absolute;top:5px;right:9px;cursor:pointer;opacity:0.6;padding:3px 5px;border-radius:4px;'
            + 'background:var(--black30a, rgba(0,0,0,0.3));font-size:0.85em;z-index:1;';
        hayToggle.addEventListener('click', () => {
            if (!labHay.trim()) return;
            labCommitted = !labCommitted;
            repaint();
            if (!labCommitted) hayBox.focus();
        });
        // Beside the pencil, and only while the marked view is up: there is no rendering to see behind in a textarea.
        const srcToggle = document.createElement('i');
        srcToggle.className = 'fa-solid fa-code';
        srcToggle.style.cssText = 'position:absolute;top:5px;right:34px;cursor:pointer;padding:3px 5px;border-radius:4px;'
            + 'background:var(--black30a, rgba(0,0,0,0.3));font-size:0.85em;z-index:1;';
        srcToggle.addEventListener('click', () => { labShowMarkup = !labShowMarkup; repaint(); });
        hayWrap.append(hayBox, hayRead, srcToggle, hayToggle);
        const keyBox = box('Keys, comma- or newline-separated — plain, /regex/flags or ?SmartKey', () => labKeys, v => { labKeys = v; });
        const gateBox = document.createElement('details');
        gateBox.style.cssText = 'flex:0 0 auto;margin-bottom:4px;';
        const gateSum = document.createElement('summary');
        gateSum.style.cssText = 'cursor:pointer;font-size:0.9em;opacity:0.8;padding:2px 0;';
        gateBox.append(gateSum);
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
        gateBox.append(logicSel, secBox);
        // Two lines to start, growing with what is typed to six and scrolling after: min/max do the clamping, so the
        // handler only ever asks for the content's own height.
        keyBox.style.cssText += 'flex:0 0 auto;min-height:3em;max-height:8.8em;height:3em;';
        const growKeys = () => { keyBox.style.height = 'auto'; keyBox.style.height = `${keyBox.scrollHeight}px`; };
        keyBox.addEventListener('input', growKeys);
        // What an applied run is matching with, in place of the keys pane it is not using. Dashed and unfilled like the
        // committed haystack, since it states what ran rather than taking input.
        const bookList = document.createElement('div'); bookList.className = 'text_pole';
        bookList.style.cssText = 'flex:0 0 auto;margin:5px 0;max-height:6em;overflow:auto;font-size:0.9em;'
            + 'border-style:dashed;background-color:transparent;cursor:default;height:auto;';
        // The same ✕ as the digest header's: the list is where you look to see what a run is matching with, so it is where
        // you reach to stop.
        bookList.addEventListener('click', ev => {
            if (!ev.target.closest('.wa-run-clear')) return;
            labRun = null;
            repaint();
        });
        panes.append(hayWrap, keyBox, gateBox, bookList);

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
            flag('Skip vector entries', () => labSkipVector, v => { labSkipVector = v; rerunLab(); }),
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
        win.addEventListener('change', () => { labWindow = win.value; rerunLab(); repaint(); });
        winLabel.append(document.createTextNode('Match window'), win);
        const labTool = (icon, title, onClick, marginLeft) => {
            const i = document.createElement('i');
            i.className = `fa-solid ${icon}`; i.title = title;
            i.style.cssText = `cursor:pointer;padding:2px 4px;opacity:0.7;${marginLeft ? 'margin-left:auto;' : ''}`;
            i.addEventListener('click', onClick);
            return i;
        };
        opts.append(
            winLabel,
            labTool('fa-comments', 'Load the current chat, as deep as the message-depth setting reads — shift-click for a depth',
                async ev => {
                    const depth = ev.shiftKey
                        ? await numberPrompt('Load chat', 'How many messages deep?', settings().messageDepth || world_info_depth, 1)
                        : undefined;
                    if (ev.shiftKey && depth == null) return;
                    labHay = chatHaystack(depth);
                    hayBox.value = labHay;
                    labCommitted = true;   // imported text is for reading, not editing
                    repaint();
                }),
            labTool('fa-key', 'Take the keys of an entry in any book, secondary condition and all', async () => {
                const picked = await pickEntryKeys();
                if (!picked?.keys.length) return;
                labKeys = picked.keys.join('\n');
                labSec = picked.sec.join(', ');
                labLogic = picked.logic;
                keyBox.value = labKeys; secBox.value = labSec; logicSel.value = labLogic;
                growKeys();
                if (picked.sec.length) gateBox.open = true;   // an imported gate must not land shut and invisible
                repaint();
            }),
            labTool('fa-book', 'Apply the books attached to this chat, hits only — shift-click to pick any book instead',
                async ev => {
                    if (!ev.shiftKey) { await applyAttached({ pickIfNone: true }); return; }
                    const name = await pickBook('Apply which lorebook?', true);
                    if (name) await applyOneBook(name);
                }),
            labTool('fa-expand', 'Show the text with every match marked', () => showMarkedText()),
        );
        const out = document.createElement('div');
        out.style.cssText = 'flex:2 1 0;overflow:auto;min-width:0;min-height:0;';
        const repaint = () => {
            const { ink, rows, spans } = scanLab();
            const digestTop = out.scrollTop;   // an edit repaints the digest, and the row acted on is wherever it was
            out.innerHTML = labRun
                ? labRunHtml()
                : (rows.length
                    ? rows.map(r => labKeyHtml(r, r.color)).join('')
                    : '<div style="opacity:0.6;padding:6px 0;">Keys you type on the right are matched against the text on the left.</div>');
            bindCollapse(out);
            out.scrollTop = digestTop;
            out.querySelector('.wa-run-clear')?.addEventListener('click', () => { labRun = null; repaint(); });
            // Committed with nothing in the box would leave no way back, so an empty haystack is always the editable one.
            const reading = labCommitted && !!labHay.trim();
            hayBox.style.display = reading ? 'none' : '';
            hayRead.style.display = reading ? '' : 'none';
            // A shut gate must still say it is filtering, or a key reading 0 has no visible cause. Read off the pane, not off
            // scanLab, whose applied-run branch has no gate to report.
            const secN = splitKeys(labSec).length;
            gateSum.textContent = secN
                ? `Secondary keys — ${logicSel.selectedOptions[0]?.textContent.split(' \u2014 ')[0] ?? ''}, ${secN} term${secN === 1 ? '' : 's'}`
                : 'Secondary keys';
            gateSum.style.opacity = secN ? '1' : '0.6';
            // An applied run matches with books, not with what is typed, so the keys and the gate step aside for the list.
            const running = !!labRun;
            keyBox.style.display = running ? 'none' : '';
            gateBox.style.display = running ? 'none' : '';
            bookList.style.display = running ? '' : 'none';
            if (running) {
                bookList.innerHTML = `${escapeHtml(labRun.books.join(', ') || labRun.label)}`
                    + ' <i class="fa-solid fa-xmark wa-run-clear" title="Back to the typed keys" style="cursor:pointer;opacity:0.6;"></i>';
            }
            hayToggle.className = `fa-solid ${reading ? 'fa-pen' : 'fa-check'}`;
            hayToggle.title = reading ? 'Edit the text' : 'Mark up the text';
            hayToggle.style.display = labHay.trim() ? '' : 'none';
            srcToggle.style.display = reading ? '' : 'none';
            srcToggle.style.opacity = labShowMarkup ? '1' : '0.5';
            srcToggle.title = labShowMarkup ? 'Hide the markup again' : 'Show every tag, entity and marker in the text';
            if (reading) {
                const top = hayRead.scrollTop;
                hayRead.innerHTML = markedHtml(labHay, spans, ink);
                hayRead.scrollTop = top;
            }
        };
        labRepaint = repaint;
        // Once, not per repaint: the listener is on `out`, which survives its own innerHTML. Lands only while the marked
        // view is up, hayRead holding no marks otherwise.
        bindJump(out, hayRead);
        bindMarkJump(hayRead, out);
        bindKwMenu(out);
        repaint();
        growKeys();   // the pane keeps its text across a tab switch, so it is not always empty on the first paint
        const body = document.createElement('div');
        body.style.cssText = 'flex:1 1 auto;display:flex;gap:10px;padding:0 8px 8px;min-height:0;';
        body.append(panes, out);
        pane.append(opts, body);
    };

    const TABS = [['explorer', 'Explorer'], ['cleanup', 'Bulk Cleanup'], ['lab', 'Keyword Lab']];
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
        termRepaint = null;   // the term views below claim it; the Explorer leaves it null
        // The tab bar first, and with no book too: it carries the close button, and the Lab needs no book to paint.
        explorer.append(renderTabBar());
        const pane = document.createElement('div');
        pane.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;overflow:hidden;min-height:0;';
        explorer.append(pane);
        if (tab === 'lab') { renderLabView(pane); return; }
        if (!selected) { pane.innerHTML = '<div style="opacity:0.6;padding:8px;">Select a lorebook on the left.</div>'; return; }
        // Cleanup is async (paints a note, then blocks) and repaints itself; nothing awaits it.
        if (tab === 'cleanup') { renderCleanupView(pane); return; }
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
            ? `Flag dead / common / short keywords — tune under Tool Settings.\nChat evidence: ${chatLabel()}, ${chatMsgs} messages.`
            : 'Flag dead / common / short keywords and colour them by verdict — tune under Tool Settings.\nNo chat searched yet.';
        scanBtn.addEventListener('click', async () => { await withBusy(scanBtn, '0.5', runAudit, '<i class="fa-solid fa-spinner fa-spin"></i> Auditing…'); renderExplorer(); });
        const allOpen = entries.length > 0 && entries.every(x => entryOpen.has(x.uid));
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button'; expandBtn.className = 'menu_button';
        expandBtn.style.cssText = 'width:auto;padding:3px 7px;flex-shrink:0;';
        expandBtn.innerHTML = `<i class="fa-solid ${allOpen ? 'fa-square-caret-up' : 'fa-square-caret-down'}"></i>`;
        expandBtn.title = `${allOpen ? 'Collapse' : 'Expand'} all entries — shift-click expands only entries with flagged keywords`;
        expandBtn.addEventListener('click', async ev => {
            if (ev.shiftKey) {   // expand only flagged entries (scan first if needed), collapse the rest
                if (!scan) await withBusy(expandBtn, '0.5', runAudit);   // building an audit here means building the SAME audit
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
        globeBtn.style.color = globalTrayOpen ? ACCENT : '';
        globeBtn.addEventListener('click', () => { globalTrayOpen = !globalTrayOpen; globeBtn.style.color = globalTrayOpen ? ACCENT : ''; refreshGlobalTray(); });
        row1.append(label, vsep(), filterWrap, sortBtn, spacer(), searchWrap, trayBtn(), globeBtn);
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

    /** Opens one entry in the Explorer: its book if that is not the open one, then the entry expanded, scrolled to and
     *  flashed. Its book may not be the one the Studio landed on, since a delivered entry comes from any attached book. */
    const revealEntry = async ({ world, uid }) => {
        if (world && world !== selected && world_names.includes(world)) await openBook(world);
        const entry = Object.values(data?.entries ?? {}).find(e => String(e.uid) === String(uid));
        if (!entry) return;
        tab = 'explorer';
        entryOpen.add(entry.uid);
        renderExplorer();
        const row = rowEls.get(entry.uid);
        if (!row) return;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add('wa-flash');
        setTimeout(() => row.classList.remove('wa-flash'), 1200);
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
        nav.classList.toggle('wa-nav-wide', bookBulkMode && !navCollapsed);   // widen to show full titles while selecting
        nav.classList.toggle('wa-nav-collapsed', navCollapsed);
        const navToggle = document.createElement('i');
        navToggle.className = `fa-solid ${navCollapsed ? 'fa-angles-right' : 'fa-angles-left'}`;
        navToggle.title = navCollapsed ? 'Show the lorebook list' : 'Collapse the lorebook list';
        navToggle.style.cssText = 'cursor:pointer;opacity:0.6;padding:2px;';
        navToggle.addEventListener('click', () => { navCollapsed = !navCollapsed; renderBooks(); });
        // Collapsed, the rail holds nothing but the way back.
        if (navCollapsed) { nav.append(navToggle); return; }
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
        navtools.append(bulkToggle, sortBtn, navToggle);
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

        const attached = new Set(attachedBookNames());
        for (const name of names) {
            const row = document.createElement('div');
            row.className = 'wa-book-row' + (name === selected ? ' wa-sel' : '') + (attached.has(name) ? ' wa-attached' : '');
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
            const nm = document.createElement('span'); nm.className = 'wa-book-name'; nm.textContent = name;
            nm.title = attached.has(name) ? `${name}\n\nAttached to this chat` : name;
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
    // After the book is open: the Lab's run reads `data` for whichever attached book that is, and an entry reveal needs its
    // book loaded and its row painted.
    if (open?.lab) openLabTab();
    else if (open?.entry) await revealEntry(open.entry);

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
