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
import { saveSettingsDebounced, getRequestHeaders, characters, getCharacters } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { loadWorldInfo, saveWorldInfo, reloadEditor, createWorldInfoEntry, duplicateWorldInfoEntry, deleteWorldInfoEntry, getFreeWorldEntryUid, deleteWIOriginalDataValue, deleteWorldInfo, updateWorldInfoList, world_names, world_info_match_whole_words, world_info_case_sensitive, selected_world_info, world_info, METADATA_KEY } from '../../../../world-info.js';
import { power_user } from '../../../../power-user.js';
import { escapeHtml } from '../../../../utils.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { runState, settings } from './state.mjs';
import { ensureStudioStyle, makeSortControl, showCtxMenu, showEntryText, wiGlyph } from './ui-widgets.mjs';
import { SORT_FNS, normPresentation, reconcileTiers, tierRank, wiTitleOf } from './sort.mjs';
import { buildKeyPruneScan, llmKeyCandidates, STUDIO_PRUNE_OPTS, STUDIO_SUGGEST_OPTS } from './keyword-tools.mjs';
import { buildKeySuggest, classifyLlmCand } from './keyword-core.mjs';
import { buildAutomaton, addMessageHits, fold, validateSmartKey } from './smartkeys.mjs';
import { findOrphanBindings } from './bindings.mjs';
import { isRegexKey, wholeWordAdvice } from './matcher.mjs';

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
    // --- Tabs -----------------------------------------------------------------------------------
    // Two views over one book: Explorer (entry rows) and Cleanup (flagged keys, key-per-row). Only
    // Cleanup is a selection view, because only removal earns one: audit flags are high-precision, so
    // its rows start ticked and the work is rescuing false positives from a batch you review before
    // committing. Suggestions run the other way — each accept is independent, additive, and lands
    // visibly as a key chip in the same paragraph — so they live inline in the Explorer and commit on
    // click. A "Suggest Terms" tab used to mirror Cleanup's select-then-commit shape for them; at one
    // line per term it read LESS densely than the chips it duplicated, and nobody ever wanted "add all".
    let tab = 'explorer';
    // Cleanup's selection. Deliberately survives tab switches AND rescans: a half-built selection is
    // the user's work, not a cache. A rescan can retire rows (they stop rendering) without discarding
    // the decision, so loosening a threshold back restores the earlier tick. The bulk bar shows counts
    // so a stale selection is visible rather than silent.
    const cleanupChecks = new Map();   // rowId -> bool (defaults from scan.defChecked — mostly ticked)
    let cleanupUndo = null;            // [{uid, key}] from the last prune, restorable until the next one
    // Cleanup normally lists only what the audit flagged. This widens it to every key on every visible
    // entry — the audit is a heuristic, so the term you want to prune, ignore or retitle in bulk is often
    // one it had no opinion about. Unflagged rows never pre-tick; the flags decide what's suspect, this
    // toggle only decides what's REACHABLE.
    let cleanupShowAll = false;
    // CHAT EVIDENCE for the "not in entry text" flag. That flag measures the book's own prose, but keys fire
    // against the CHAT — which is the whole ambiguity: on a hand-authored book ~90% of them are deliberate
    // aliases ("Toriel's House" for "Dreemurr Residence"), on a machine-written one most are stale scene
    // detail. One Aho-Corasick pass settles it per key, so the cost is O(chat) and independent of key count
    // (measured 254ms for 497 keys over 5473 messages; getContext().chat is already in memory).
    //
    // Opt-in, because it is evidence the user asked for rather than a verdict the tool imposes — and because
    // a key with 0 hits still is not proven useless, only unproven. Survives a rescan; cleared on book change.
    let chatHits = null;        // Map<key, count>, null until the scan is run
    let chatMsgs = 0;
    let chatName = '';          // WHICH chat produced those counts — see runChatScan
    const rowId = (uid, term) => `${uid}${term}`;
    // The active term tab's list repaint, or null in the Explorer. Whitelist edits reach the list from
    // three places (the term right-click menu, the tray's per-key ✕, Clear whitelist), and the Explorer's
    // rerenderKeys walks rowEls, which the term tabs never populate — so without this an ignored term
    // just sat there, still showing its reason, until something else forced a rebuild.
    let termRepaint = null;
    const afterIgnoreChange = keys => {
        if (termRepaint) termRepaint(); else rerenderKeys(keys);
        if (trayOpen) refreshTray();   // the whitelist column lives there
    };

    // Chats and character cards naming a lorebook that no longer exists. Computed once per Studio
    // session, in the background, because it needs the whole chat index (one fetch per character) and
    // nothing should wait on it. Null until it has run; a nav row appears only if it finds something,
    // so a clean install never sees this feature at all.
    let orphans = null;
    let orphanView = false;   // showing the list instead of a book — `selected` stays a real book name

    /**
     * The chat index, as cheaply as it can be had.
     *
     * ST's /api/characters/chats reads every line of every chat to count messages and grab the last one
     * — 1.28GB and 3.2s on a real corpus — even though a binding lives on line 0. The plugin route reads
     * only that line (0.06s measured over the same 194 chats) and returns the bindings; card bindings
     * come from the `characters` array, which is already in memory. Falls back to ST's endpoint when the
     * plugin is not deployed, which is correct and slow rather than unavailable.
     */
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
    // Close corner instead of the popup's button row — that row costs a whole line of a 72vh window.
    // Floats over the empty right end of the tab strip, so it collides with nothing. Wired to the
    // Popup once it exists, below.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'fa-solid fa-xmark wa-studio-close';
    closeBtn.title = 'Close'; closeBtn.setAttribute('aria-label', 'Close');
    root.append(nav, explorer, closeBtn);

    const firstLine = e => { const t = String(e.content ?? '').trim(); const nl = t.indexOf('\n'); return (nl < 0 ? t : t.slice(0, nl)) || '(empty)'; };
    const save = () => { dirty = true; saveWorldInfo(selected, data, true); };
    const getSugg = uid => { let x = sugg.get(uid); if (!x) sugg.set(uid, x = { tfidf: [], llm: [] }); return x; };
    // The audit answers the same question the runtime does, so it segments the same way.
    const rebuildScan = () => {
        scan = buildKeyPruneScan(data, studioOpts, ignoreSet, {
            matchWindow: settings().matchWindow,
            // Into the CLASSIFIER, not the cleanup display layer — the Explorer's chips colour from
            // reasonOf/severityOf, and curation happens there. Painted on afterwards it reaches one tab.
            chatScan: chatHits ? { messagesWith: chatHits, messages: chatMsgs } : undefined,
        });
    };
    // A finished chat scan changes what classifyEntry returns, so the scan is rebuilt and everything
    // repainted — the cleanup list via its hook, the Explorer rows directly.
    const afterChatScan = keys => { rebuildScan(); termRepaint?.(); rerenderKeys(keys); };
    /**
     * ONE AUDIT, TWO DISPLAYS. The Explorer and Cleanup must reach identical verdicts for identical
     * keys — same classifier, same evidence, same key set — and differ only in how they show them:
     * chips coloured in place against rows with reasons and a selection. Every drift between the two
     * so far came from something being computed on one side instead of gathered once, and each read as
     * a bug in the surface that showed the weaker answer.
     *
     * The one legitimate exception is the checkbox state (`cleanupChecks`, `defChecked`), which the
     * Explorer has no equivalent of because it has no bulk removal.
     *
     * Every key in the BOOK, which is the key set both scan paths use.
     *
     * Not visibleEntries(): the audit classifies every entry, so evidence gathered from a filtered
     * subset would make a verdict depend on what happened to be on screen when the scan ran — and the
     * Explorer and Cleanup would disagree about the same key. One audit, two displays.
     */
    const bookKeys = () => [...new Set(Object.values(data?.entries ?? {})
        .flatMap(e => (Array.isArray(e.key) ? e.key : []).map(k => String(k).trim())).filter(Boolean))];

    // Chat counts belong to a (book, chat) PAIR. Switching either one makes them describe something else,
    // so they are dropped rather than left on screen attached to the wrong book.
    const clearChatScan = () => { chatHits = null; chatMsgs = 0; chatName = ''; };
    // Repaint only the entries whose key list includes one of `keys`. classifyEntry reads the live
    // ignoreSet and the df table is ignore-independent, so whitelisting needs no rescan — just recolour
    // the affected rows (chip colour + collapsed badge reflect the new ignore state).
    const rerenderKeys = keys => { const set = new Set(keys); for (const e of Object.values(data?.entries ?? {})) if ((Array.isArray(e.key) ? e.key : []).some(k => set.has(k))) renderEntry(e); };

    const persistIgnore = () => { const s = settings(); if (!s.keywordIgnore) s.keywordIgnore = {}; s.keywordIgnore[selected] = [...ignoreSet]; saveSettingsDebounced(); };
    const persistOpts = () => { const s = settings(); s.studioScanOpts = studioOpts; s.studioSuggestOpts = suggestOpts; saveSettingsDebounced(); };

    // "⚙ Tool Settings" tray under the explorer header. Scan/prune options apply on the next Scan press;
    // recommender knobs invalidate the cached ranker so the next ⚡/✨ rebuilds with them; the whitelist
    // is this book's prune ignore-set (settings().keywordIgnore, per book). Replaces the old
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
        // Chips are stashed per entry, so dropping the ranker is enough — the next ⚡ rebuilds it.
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
                check(studioOpts, 'stickySkipCommon', 'Spare sticky entries from the book-common flag'),
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
    // Every bulk action spends the selection rather than leaving it ticked. A set left over from earlier
    // work is invisible once the entries scroll away — worse, once a filter hides them — and the next
    // bulk action then hits more than the user thinks it does. The spent set is offered back as
    // "Reselect N" in the bar, so chaining two actions over the same entries costs one click, and the
    // offer is deliberate rather than a timer nobody can see the state of.
    let lastSel = null;
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
    const bulkRecLevel = async () => { const v = await numberPrompt('Delay until recursion — selected entries', 'Recursion level (0 = any; turns the flag on):', 0, 0); if (v != null) applyBulk(e => e.delayUntilRecursion = Math.floor(v) > 0 ? Math.floor(v) : true); };
    // entriesToBook is shared with the single-entry Copy to… / Move to…, so the selection is spent here
    // rather than inside it.
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

        if (!advanced) { ordered.forEach((e, i) => e.order = targetOf(i)); save(); ordered.forEach(x => renderEntry(x)); consumeSelection(); return; }

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
    // One keyword onto every selected entry — the bulk form of the ➕ in an entry's keyword paragraph,
    // so it skips entries that already carry the term (same case-insensitive hasKey the ➕ uses) rather
    // than duplicating it. No rescan: a new key doesn't change any entry's text, and the per-entry ➕
    // doesn't rescan either.
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
    // The inverse of bulkAddTerm: empty the key list of every selected entry. Unlike a single ✕ this is
    // worth a rescan — the book-common/book-shared flags are df-based, so removing a book's worth of keys
    // changes the verdict on the ones left standing.
    //
    // UNDO rides on the toast rather than the nav's undo bar: that bar belongs to book deletion, lives in
    // a different pane, and survives book switches, none of which fit an edit inside one book's Explorer.
    // The snapshot is by uid, not by entry reference, because a rescan rebuilds rows underneath it — and
    // it refuses outright if the book changed, since save() writes to whatever `selected` is by then.
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
    const renderBulkBar = () => {
        const wrap = document.createElement('div'); wrap.className = 'wa-bulk';
        const n = selectedEntries.size;
        const mkBtn = (label, onClick, extra = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button wa-bulk-btn ' + extra; b.textContent = label; b.addEventListener('click', onClick); return b; };
        const sep = () => { const s = document.createElement('span'); s.className = 'wa-bulk-sep'; return s; };
        if (!n) {   // nothing selected -> the Reselect offer if a bulk action just spent one, else no footprint
            if (!lastSel?.size) return wrap;
            wrap.classList.add('wa-bulk-on');
            const note = document.createElement('span'); note.className = 'wa-bulk-count'; note.textContent = 'Selection cleared';
            const drop = document.createElement('i'); drop.className = 'fa-solid fa-xmark wa-undo-dismiss'; drop.title = 'Dismiss';
            drop.addEventListener('click', () => { lastSel = null; refreshBulkBar(); });
            wrap.append(note, mkBtn(`Reselect ${lastSel.size}`, () => {
                for (const uid of lastSel) if (data?.entries?.[uid]) selectedEntries.add(uid);   // skip anything deleted since
                lastSel = null; syncSelCheckboxes();
            }), drop);
            return wrap;
        }
        wrap.classList.add('wa-bulk-on');
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
        const addTermBtn = mkBtn('Add term…', bulkAddTerm); addTermBtn.title = 'Add one keyword to every selected entry';
        const reBtn = mkBtn('Renumber…', ev => bulkOrder(ev.shiftKey)); reBtn.title = 'Renumber order — shift-click to also renumber UIDs';
        // One toggle instead of separate Enable/Disable: enable if any selected are off, else disable all.
        const anyDisabled = Object.values(data?.entries ?? {}).some(e => selectedEntries.has(e.uid) && e.disable);
        wrap.append(
            count,
            mkBtn(n === all.length ? 'Select none' : 'Select all', () => { if (n === all.length) consumeSelection(); else { lastSel = null; all.forEach(e => selectedEntries.add(e.uid)); syncSelCheckboxes(); } }),
            // The toggle above only clears once everything visible is ticked; a partial selection needs its
            // own way out, and clearing by unticking N boxes is not one. Both clears go through
            // consumeSelection, so an accidental one is a Reselect away.
            ...(n === all.length ? [] : [mkBtn('Clear', consumeSelection)]),
            sep(),
            mkBtn(anyDisabled ? 'Enable' : 'Disable', () => { applyBulk(e => e.disable = !anyDisabled); refreshBulkBar(); }),
            addTermBtn,
            setBtn,
            reBtn,
            sep(),
            mkBtn('Copy to…', bulkCopyTo),
            mkBtn('Move to…', bulkMoveTo),
            sep(),
            mkBtn('Delete all terms', bulkClearTerms, 'wa-bulk-danger'),
            mkBtn('Delete', bulkDelete, 'wa-bulk-danger'),
        );
        return wrap;
    };

    // bgDocs rides in the call, not in suggestOpts — that object is persisted to settings, and the
    // chat would go with it. No chat open = empty = book-only ranking, same as before.
    //
    // The OPEN chat only, and the alternatives were measured rather than assumed. Pooling a
    // character's other chats looks like a free win — on one book the share of candidates that
    // never occur anywhere falls from 51% to 25% — and Aho-Corasick absorbs the size (0.28 s/MB, so
    // 22 MB of pooled history costs ~7s against ~2.5s, linear, not quadratic in term count).
    //
    // By CHARACTER is simply wrong — too coarse. Two chats on one card here are entirely different
    // settings, so one story's vocabulary would vouch for the other's keys.
    //
    // By the chat's BOUND LOREBOOK is correct: chats declaring the same book are one story, and it
    // separates those two settings cleanly. Its VALUE, though, depends on how the book was managed,
    // and both measured cases are real: on a book versioned heavily mid-story the pool collapsed to
    // the open chat itself (5646 messages against 5598, 0.1pp), while on a cleanly bound one it
    // picked up a genuine sibling branch (20045 against 16359, and 32.0% -> 28.2% of candidates
    // never occurring) for a bit over 2x the build — 5.8s against 2.6s.
    //
    // So this is a cost call, not a correctness one: a multi-second synchronous rebuild every time
    // the Studio opens is a worse trade than ~4pp of dead candidates. Worth revisiting if the build
    // ever moves off the main thread, in which case bound-lorebook is the key to group on.
    const ensureSuggest = () => suggest ?? (suggest = buildKeySuggest(data,
        { ...suggestOpts, bgDocs: (getContext().chat ?? []).map(m => String(m?.mes ?? '')).filter(Boolean) }));
    const hasKey = (e, term) => Array.isArray(e.key) && e.key.some(k => String(k).toLowerCase().trim() === term.toLowerCase().trim());

    /**
     * The gate every path that writes a key goes through. An ERROR refuses the write and says why; a
     * WARNING lets it through and says why. Both come from validateSmartKey, so what the Studio blocks
     * and what the audit flags cannot drift apart — one definition, two surfaces.
     *
     * Plain keys get no opinion. A regex key gets exactly one: a warning when core would refuse the
     * pattern and so never activate it. Everything else here is a `?` SmartKey.
     *
     * Refusing rather than warning on the error tier is the point: these are SmartKeys that cannot do
     * what their author meant under any text, and the alternative — saving it and flagging it later —
     * is how a key ends up silently never firing. The author is right here, right now, and can fix it.
     *
     * @returns {boolean} whether the write may proceed
     */
    const keyWriteOk = term => {
        const problems = validateSmartKey(term);
        const err = problems.find(p => p.severity === 'error');
        if (err) { toastr.warning(err.message, 'Worlds Apart', { timeOut: 8000 }); return false; }
        // ONE TOAST PER KIND OF PROBLEM, not one per instance. A key can repeat the same fault dozens of
        // times — paste an unquoted Zalgo string and it shreds into forty-odd punctuation terms, each
        // reporting separately — and forty identical toasts is not forty times the information.
        const byCode = new Map();
        for (const w of problems) {
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

    // Tiny sticky editor: number box + −/+ steppers + 🚫 reset-to-0.
    /**
     * The per-entry tool row (power / case / whole-word / sticky / trigger % / advanced / copy / delete).
     * Shared by the Explorer's entry header and the term tabs' group headers, so an entry exposes the
     * same controls wherever you meet it — and toggling case or whole-word from Cleanup re-classifies
     * that entry's keys, since the scan reads those flags live.
     * @param {object} e Entry
     * @param {(e: object) => void} repaint What to redraw after a change (an entry row, or a term list)
     * @param {{compact?: boolean}} [opt] compact drops sticky + trigger-%, which govern WHEN an entry
     *        fires once matched — a different question from whether its keywords are any good, and the
     *        only two tools carrying badges. Both stay reachable in the gear tray (Timed / Trigger).
     *        Case and whole-word deliberately survive: the scan reads those flags live, so toggling
     *        either re-classifies that entry's keys on the spot.
     */
    const buildEntryTools = (e, repaint, { compact = false } = {}) => {
        const tools = document.createElement('div'); tools.className = 'wa-entry-tools';
        const prob = e.probability != null ? Number(e.probability) : 100;
        const delay = Number(e.delay) || 0;
        const cooldown = Number(e.cooldown) || 0;
        const stickyOn = Number(e.sticky) > 0;
        // Sticky/probability: when active, a plain click DISABLES; when off, click enables/opens the
        // editor; shift-click always opens the editor. Cooldown/delay/recursion/budget live in ⚙ Advanced.
        const stickyTool = tool('fa-thumbtack', stickyOn, `Sticky: ${stickyOn ? `on (${e.sticky})` : 'off'} — click ${stickyOn ? 'disables' : 'enables'}, shift-click sets a value`, ev => { if (ev.shiftKey) { editSticky(e); return; } e.sticky = stickyOn ? 0 : 1; save(); repaint(e); });
        if (stickyOn) { stickyTool.classList.add('wa-badge'); stickyTool.dataset.badge = String(e.sticky); }   // show the sticky count
        const probGates = e.useProbability !== false && prob < 100;
        // With a real gate value (<100), click toggles useProbability on/off. At 100% there's nothing to
        // toggle, so click opens the setter instead. Shift-click always opens the setter.
        const probVal = prob < 100;
        const probTool = tool('fa-percent', probGates, `Trigger probability: ${probGates ? `${prob}%` : (probVal ? 'off' : 'always')} — ${probVal ? `click ${e.useProbability === false ? 'enables' : 'disables'}` : 'click to set'}, shift-click edits`, ev => { if (ev.shiftKey || !probVal) { editProbability(e); return; } e.useProbability = (e.useProbability === false); save(); repaint(e); });
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
        const advTool = tool('fa-gear', advOpen.has(e.uid) || advActive, advActive ? advParts.join('\n') : 'Advanced: recursion, budget, timing', () => { advOpen.has(e.uid) ? advOpen.delete(e.uid) : advOpen.add(e.uid); repaint(e); });
        // Case/whole-word show the EFFECTIVE state (entry override ?? global default). When the value is
        // inherited from an active global (entry sets no override), the icon is light green instead of blue.
        // Entry value overrides global (nullish-coalesce in core); global applies only when entry is unset.
        const flagState = (v, g) => `${(v ?? g) ? 'On' : 'Off'} (${v == null ? 'inherited' : 'entry'})`;
        const effCase = e.caseSensitive ?? world_info_case_sensitive;
        const caseInherit = e.caseSensitive == null && !!world_info_case_sensitive;
        const caseTool = tool('Aa', effCase, `Case-sensitive: ${flagState(e.caseSensitive, world_info_case_sensitive)} · shift-click: inherit`, ev => { e.caseSensitive = ev.shiftKey ? null : !effCase; save(); repaint(e); });
        if (caseInherit) caseTool.style.color = '#8fce8f';
        const effWhole = e.matchWholeWords ?? world_info_match_whole_words;
        const wholeInherit = e.matchWholeWords == null && !!world_info_match_whole_words;
        // Structural advice about THIS entry's keys under the flag — a narrowing core would not have
        // applied, or a script with no word boundaries to find. Computed from the entry alone, so it
        // costs nothing and cannot disagree with the matcher: same module, same rules.
        const wholeAdvice = wholeWordAdvice(e.key, effWhole);
        const wholeTool = tool('[ab]', effWhole, `Match whole words: ${flagState(e.matchWholeWords, world_info_match_whole_words)} · shift-click: inherit${wholeAdvice.map(a => `\n\n${a}`).join('')}`, ev => { e.matchWholeWords = ev.shiftKey ? null : !effWhole; save(); repaint(e); });
        if (wholeInherit) wholeTool.style.color = '#8fce8f';
        // A badge, not a colour, and not red: both triggers are advisories on entries that may be
        // working exactly as intended. The tooltip carries the sentence; the badge is what makes
        // anyone read it. COLOUR IS ALREADY SPOKEN FOR — it is the flag's own state, and tinting here
        // overwrote the light green that says "inherited from the global", so an advisory entry read
        // as one that had set the flag itself. Two channels, two questions.
        if (wholeAdvice.length) { wholeTool.classList.add('wa-badge'); wholeTool.dataset.badge = '!'; }
        tools.append(
            tool('fa-power-off', !e.disable, e.disable ? 'Disabled — click to enable' : 'Active — click to disable', () => { e.disable = !e.disable; save(); repaint(e); }),
            caseTool,
            wholeTool,
            ...(compact ? [] : [stickyTool, probTool]),
            advTool,
            tool('fa-copy', false, 'Duplicate entry', () => dupEntry(e)),
            tool('fa-trash-can', false, 'Delete entry', () => delEntry(e)),
        );
        return tools;
    };

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
                canon: s.canon, exampleCanon: s.exampleCanon, exampleWords: s.exampleWords, entryText: e.content, dfSubstr: s.dfSubstr, N: s.N,
                dfCeil: suggestOpts.dfCeil, excludeDates: suggestOpts.excludeDates,
                isDupe: (term, cn) => seen.has(cn) || hasKey(e, term),
            });
            if (reason) continue;
            g.llm.push(t); seen.add(c); added++;
        }
        return added;
    };
    // `after` is how the caller repaints: the Explorer rebuilds just that entry's row, while a
    // book-wide run repaints the whole list once at the end.
    const suggestLlm = async (e, btn, after = renderEntry) => {
        if (btn.dataset.busy) return;
        btn.dataset.busy = '1'; btn.classList.remove('wa-on'); btn.style.opacity = '0.25';
        const s = ensureSuggest();
        let cands;
        try { cands = await llmKeyCandidates(e.content, s.avoid, suggestOpts.llmChunk); }
        catch (err) { toastr.warning(`Local model: ${String(err?.message ?? err)}`, 'Worlds Apart'); btn.dataset.busy = ''; btn.style.opacity = ''; return; }
        const added = mergeLlmCands(e, cands, s);
        btn.dataset.busy = ''; btn.style.opacity = '';
        toastr[added ? 'success' : 'info'](added ? `${wiTitleOf(e)}: +${added} from model` : 'Model returned nothing usable — click ✨ to retry.', 'Worlds Apart');
        after(e);
    };
    const acceptSugg = (e, term, after = renderEntry) => {
        // Through the same gate as everything else. A suggester is not supposed to be able to emit a
        // `?` or `/re/` key, but the REWORD path beside this one was already gated, so accepting a
        // candidate verbatim skipped the check that editing it to the same string applied.
        if (!keyWriteOk(term)) return;
        if (!Array.isArray(e.key)) e.key = [];
        if (!hasKey(e, term)) e.key.push(term);
        const g = getSugg(e.uid); g.tfidf = g.tfidf.filter(t => t !== term); g.llm = g.llm.filter(t => t !== term);
        save(); after(e);
    };
    // Reword a candidate before taking it — trimming "Lord Harcot" to "Harcot", which equal-frequency
    // subsumption swallowed. Editing IS accepting: nobody rewords a term they mean to ignore. The
    // original leaves the tray too, so the key doesn't sit beside the phrasing it replaced.
    const acceptEdited = (e, oldTerm, newTerm) => {
        const g = getSugg(e.uid);
        g.tfidf = g.tfidf.filter(t => t !== oldTerm); g.llm = g.llm.filter(t => t !== oldTerm);
        acceptSugg(e, newTerm);
    };

    // Inline "click to edit" for one keyword (commit on Enter/blur, cancel on Escape).
    const editKeyInline = (e, oldKey, span) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'text_pole'; inp.value = oldKey;
        // Sized to the text, not a fixed 8em. A SmartKey is routinely longer than that, and a fixed
        // width made the field scroll internally — so on blur it snapped back to character 0 and the
        // end of what you had typed went out of view. Same `size` idiom as the title editor. Capped,
        // because the keyword paragraph wraps and one very long key should take a line, not the pane.
        // width:auto is load-bearing: .text_pole is width:100%, which beats `size` and made the field
        // take a whole line of the keyword paragraph instead of sitting inline with the chips.
        inp.style.cssText = 'margin:0;font-size:0.9em;width:auto;';
        const fit = () => { inp.size = Math.min(64, Math.max(8, inp.value.length + 2)); };
        fit();
        inp.addEventListener('input', fit);
        let done = false;
        const commit = (ok, viaBlur) => {
            if (done) return;
            const nv = inp.value.trim();
            // A REFUSED key keeps the editor open with the text still in it. The commit fires on blur,
            // so discarding here meant clicking away silently threw the work out and the chip snapped
            // back — the toast explained a problem with text that no longer existed. Escape still
            // cancels outright, because ok=false never reaches the check.
            //
            // Focus is only reclaimed on an explicit Enter. Grabbing it back on blur traps the cursor:
            // every attempt to click away re-fires the blur and yanks it home again. On blur the editor
            // simply stays where it is, holding the text, and can be returned to or escaped.
            if (ok && nv && nv !== oldKey && !keyWriteOk(nv)) { if (!viaBlur) inp.focus(); return; }
            done = true;
            if (ok && nv && nv !== oldKey && Array.isArray(e.key)) {
                const idx = e.key.indexOf(oldKey);
                // The dupe test has to skip the key being edited, or a capitalisation fix ("bob" → "Bob")
                // collides with itself and merges the key away instead of rewriting it.
                if (idx >= 0) { if (e.key.some((k, i) => i !== idx && kwNorm(k) === kwNorm(nv))) e.key.splice(idx, 1); else e.key[idx] = nv; save(); }
            }
            renderEntry(e);
        };
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } });
        inp.addEventListener('blur', () => commit(true, true));
        span.replaceWith(inp); inp.focus(); inp.select();
    };

    // Right-click a keyword chip → book-wide ops on that term (case-insensitive, matching core's default
    // scan). "Delete all" / "Replace all" / "Add variant" sweep every entry's primary keys; "Ignore" is
    // the existing per-book whitelist toggle. ponytail: primary keys only (keysecondary isn't surfaced
    // in the Studio).
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
            // dedupe if the target key already lives here — but not against the key being replaced, which
            // is what a capitalisation fix would otherwise collide with
            if (e.key.some((k, i) => i !== idx && kwNorm(k) === nn)) e.key.splice(idx, 1); else e.key[idx] = next;
            touched++;
        }
        if (touched) { save(); renderExplorer(); toastr.success(`Replaced “${key}” → “${next}” in ${touched} ${touched === 1 ? 'entry' : 'entries'}.`, 'Worlds Apart'); }
    };
    // Adds a SECOND term beside the clicked one, on the entries that already carry it — the alias case
    // ("Marjorie" is tagged, "Marjorie Jones" should be too). Same hasKey the ➕ and bulkAddTerm use, so
    // an entry that already has the variant is skipped rather than given a duplicate. No rescan, for
    // bulkAddTerm's reason: a new key changes no entry's text.
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
    // Studio context menus mount in this popup's <dialog> so they stack above the modal (module-scope
    // showCtxMenu defaults to document.body; pass the dialog here).
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

    // Rebuild one entry's row in place. Two collapse levels: level 1 (the whole entry) shows just the
    // title line when closed; opening it reveals the tools, keywords, and text section. Level 2 is the
    // text section's own preview↔editor toggle. Tools + body are built only when open, so a big book's
    // collapsed list stays a light, skimmable set of title lines.
    // `mount` is the parent for a row that has no predecessor to replace (a fresh list build). The row
    // must be in the document before syncText, or the editor's autosize measures a detached textarea,
    // bails, and every open entry paints at the textarea's default two rows.
    const renderEntry = (e, mount) => {
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
        // Building a new selection by hand retires the Reselect offer — it belongs to the set that was
        // spent, and restoring it into a fresh one is never what was meant.
        selBox.addEventListener('change', () => { lastSel = null; selBox.checked ? selectedEntries.add(e.uid) : selectedEntries.delete(e.uid); refreshBulkBar(); });
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
        // Near-duplicate marker, from the audit scan. Entry-level rather than key-level, so it rides the
        // title instead of the Cleanup list — and it is advisory: it says "these two say the same thing,
        // pick one", never which one. Absent until an audit has run, like every other scan-derived mark.
        const twins = scan?.dupes?.get(e.uid);
        const dupMark = twins?.length ? (() => {
            const dup = document.createElement('i');
            dup.className = 'fa-solid fa-clone wa-tool wa-badge';
            if (twins.length > 1) dup.dataset.badge = String(twins.length);
            dup.title = 'Near-duplicate of:\n' + twins.map(t =>
                `${Math.round(t.sim * 100)}% — ${t.title || `UID ${t.uid}`}${t.disabled ? ' (disabled)' : ''}`).join('\n');
            // Same scroll-and-flash the duplicate action uses, so "show me the twin" behaves the way
            // "show me the copy I just made" already does.
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
        h.append(selBox, chev, mode, title, ...(dupMark ? [dupMark] : []), pencil, meta);
        // Collapsed-line badge: how many keys the last scan flagged, so problems show without expanding.
        // Tinted by the most severe flag for glance-triage; unattested-only stays neutral, since it is
        // low-signal (on a hand-authored book ~90% of those are deliberate aliases).
        // COUNTS PROBLEMS, NOT WARNINGS. Yellow is the 0.75x band — "probably not harming, your call" — and
        // green shorts cannot collide at all, so neither belongs in a number the eye reads as a defect count.
        // They still appear on expansion with their colour; only the headline excludes them.
        const RANK = { '#e06c6c': 3, '#d9b74a': 2, '#7bbf6a': 1 };   // red > yellow > green; '' (dead) = 0
        const SEV = { '#e06c6c': 'severe', '#d9b74a': 'moderate', '#7bbf6a': 'minor' };
        const counted = flagged ? [...flagged.values()].filter(v => { const c = scan.severityOf(v); return c !== '#d9b74a' && c !== '#7bbf6a'; }) : [];
        if (counted.length) {
            const badge = document.createElement('span'); badge.className = 'wa-entry-badge';
            badge.textContent = `${counted.length} flagged`;
            let worst = '';
            for (const v of counted) { const c = scan.severityOf(v); if ((RANK[c] ?? 0) > (RANK[worst] ?? 0)) worst = c; }
            if (worst) { badge.style.background = worst; badge.style.color = worst === '#e06c6c' ? '#fff' : '#111'; }
            const softer = (flagged?.size ?? 0) - counted.length;
            // No colour means every counted flag is the uncoloured one, so name it from reasonOf rather
            // than restating it here — same reason the chip tooltips do.
            badge.title = `Keywords the last scan flagged — worst: ${SEV[worst] || scan.reasonOf(counted[0]).text}.${softer ? ` ${softer} more are warnings, not counted here.` : ''} Expand to see which.`;
            h.append(badge);
        }
        // Whole header line toggles level 1; the mode dropdown and tool icons stopPropagation so they
        // act without collapsing the entry.
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

        // ⚡/✨ live with the keywords they populate (appended to the keyword paragraph below), not in
        // the tool row.
        const boltBtn = tool('fa-bolt', false, 'TF-IDF keyword suggestions', () => suggestTfidf(e, boltBtn));
        const llmBtn = tool('fa-wand-magic-sparkles', false, 'Local-model keyword suggestions', () => suggestLlm(e, llmBtn));

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
            const isDead = v && v.flag === 'unattested';
            const isIgnored = ignoreSet.has(key);
            // Whitelisted keys are skipped by the scanner (never flagged), so mark them purple to show
            // they're deliberately spared; otherwise verdict drives the colour (green = no flag, red/yellow
            // = too-common/short, dead = slight dim, no colour).
            // The verdict's WORDING comes from reasonOf in every case, dead included. Dead still shows no
            // visible label — there are too many of them and they are often good keys — but the tooltip
            // has to carry the real sentence, because it is the only place the Explorer says which
            // evidence was checked: "not in entry text" and "not in entry text or chat" are different
            // claims. This line used to hardcode "no entry-text match" for dead keys, a second phrasing
            // of a verdict the classifier already words, so a chat scan changed nothing visible here.
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
        // Candidate chips: ➕ takes the term as-is, clicking the term itself rewords it first (the
        // ranker's span is sometimes longer than the useful key). Either way it commits on the spot
        // and reappears as a real keyword chip above, verdict colour and ✕ included — which is the
        // undo, and the record of what you have already vetted. A checkbox used to stand in for the
        // ➕: it read as "select for later" while actually committing immediately.
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
            t.addEventListener('click', () => {
                const inp = document.createElement('input');
                inp.type = 'text'; inp.className = 'text_pole'; inp.value = term;
                inp.style.cssText = 'margin:0;font-size:0.9em;width:auto;';
                const fit = () => { inp.size = Math.min(64, Math.max(8, inp.value.length + 2)); };   // see editKeyInline
                fit();
                inp.addEventListener('input', fit);
                let done = false;
                const commit = ok => {
                    if (done) return; done = true;
                    const nv = inp.value.trim();
                    if (ok && nv && nv !== term) acceptEdited(e, term, nv); else renderEntry(e);
                };
                inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } });
                inp.addEventListener('blur', () => commit(true));
                t.replaceWith(inp); inp.focus(); inp.select();
            });
            chip.append(take, t); para.append(chip);
        }
        const add = document.createElement('i'); add.className = 'fa-solid fa-plus wa-tool'; add.title = 'Add a keyword';
        add.addEventListener('click', () => {
            const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'text_pole'; inp.placeholder = 'keyword';
            inp.style.cssText = 'margin:0;font-size:0.9em;width:auto;';
            const fit = () => { inp.size = Math.min(64, Math.max(8, inp.value.length + 2)); };   // see editKeyInline
            fit();
            inp.addEventListener('input', fit);
            let done = false;
            const commit = (ok, viaBlur) => {
                if (done) return;
                const nv = inp.value.trim();
                // Keep the editor and the text; reclaim focus only on Enter (see editKeyInline).
                if (ok && nv && !hasKey(e, nv) && !keyWriteOk(nv)) { if (!viaBlur) inp.focus(); return; }
                done = true;
                if (ok && nv && !hasKey(e, nv)) { if (!Array.isArray(e.key)) e.key = []; e.key.push(nv); save(); }
                renderEntry(e);
            };
            inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } });
            inp.addEventListener('blur', () => commit(true, true));
            add.replaceWith(inp); inp.focus();
        });
        para.append(add, boltBtn, llmBtn);   // manual + first, then the suggestion triggers

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
        // Editing the text changes the corpus the ranker was built from, so the next ⚡ has to rebuild —
        // otherwise it scores the edited entry against the document frequencies of the text it replaced.
        // The scan is left alone on purpose (see above): its colours are explicitly last-scan, not live.
        full.addEventListener('blur', () => { if (full.value !== String(e.content ?? '')) { e.content = full.value; save(); suggest = null; preview.textContent = firstLine(e); } });
        fullWrap.append(popBtn, full);
        const syncText = () => { const t = expanded.has(e.uid); tchev.classList.toggle('wa-open', t); preview.style.display = t ? 'none' : ''; fullWrap.style.display = t ? '' : 'none'; if (t) autosize(); };
        thead.addEventListener('click', () => { expanded.has(e.uid) ? expanded.delete(e.uid) : expanded.add(e.uid); syncText(); });
        textSec.append(thead, fullWrap);
        body.append(textSec, para);   // entry text first, then keywords (reads more naturally)

        if (advOpen.has(e.uid)) body.prepend(buildAdvancedTray(e, renderEntry));   // above the text + keywords
        row.append(body);

        const old = rowEls.get(e.uid);
        // A repaint builds a fresh textarea, so every keyword edit would jump a scrolled editor back
        // to the top. Carry the scroll over from the row being replaced (after syncText, whose
        // autosize resets it).
        const st = old?.querySelector('.wa-entry-full')?.scrollTop ?? 0;
        if (old && old.isConnected) old.replaceWith(row); else mount?.append(row);
        rowEls.set(e.uid, row);
        syncText();   // after mount, so an expanded editor's autosize sees a real scrollHeight
        if (st) full.scrollTop = st;
        return row;
    };

    /**
     * ⚙ Advanced tray: core WI fields we don't surface as icons — inline like the Tool Settings tray.
     * Edits commit on change (number inputs on blur), then repaint; the tray stays open. Shared by the
     * Explorer and the term tabs, so the gear does the same thing wherever the tool row appears.
     * @param {object} e Entry
     * @param {(e: object) => void} repaint What to redraw after a change
     */
    const buildAdvancedTray = (e, repaint) => {
        const delay = Number(e.delay) || 0;
        const cooldown = Number(e.cooldown) || 0;
        {
            const adv = document.createElement('div'); adv.className = 'wa-adv';
            const col = (heading, ...rows) => { const c = document.createElement('div'); c.className = 'wa-adv-col'; const hd = document.createElement('div'); hd.className = 'wa-adv-sec'; hd.textContent = heading; c.append(hd, ...rows); return c; };
            const chk = (label, get, set) => {
                const l = document.createElement('label'); l.className = 'checkbox_label wa-adv-row';
                const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = get();
                cb.addEventListener('change', () => { set(cb.checked); save(); repaint(e); });
                const s = document.createElement('span'); s.textContent = label; l.append(cb, s); return l;
            };
            const numRow = (label, get, set, placeholder) => {
                const l = document.createElement('label'); l.className = 'wa-adv-row';
                const s = document.createElement('span'); s.textContent = label;
                const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.className = 'text_pole'; inp.value = get(); if (placeholder) inp.placeholder = placeholder;
                inp.addEventListener('change', () => { set(inp.value); save(); repaint(e); });
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
                sel.addEventListener('change', () => { set(sel.value === '' ? null : sel.value === 'on'); save(); repaint(e); });
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
            return adv;
        }
    };

    /**
     * New blank entry, from core's template so it carries exactly the field set core would give it —
     * a hand-rolled object would drift the moment core adds a field.
     *
     * Opened, expanded and title-editing on arrival: a blank entry has nothing to look at and its
     * whole point is that you are about to type into it. Same scroll-and-flash as duplicate, for the
     * same reason — the new uid sorts wherever it falls, which is often off-screen.
     */
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
        // The copy takes the next free uid, which JS sorts into the list wherever it falls (often
        // off-screen), so scroll to it and flash — otherwise the duplicate looks like a no-op.
        const row = rowEls.get(ne.uid);
        if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.add('wa-flash'); setTimeout(() => row.classList.remove('wa-flash'), 1200); }
        toastr.success('Entry duplicated.', 'Worlds Apart');
    };
    const delEntry = async e => {
        if (!await deleteWorldInfoEntry(data, e.uid)) return;   // shows its own confirm
        // Drop the uid from the selection too: core hands freed uids back out (getFreeWorldEntryUid), so a
        // uid left behind here would re-point at whatever entry is created next, pre-selected and unnoticed.
        selectedEntries.delete(e.uid); lastSel?.delete(e.uid);
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
            for (const e of copied) { deleteWIOriginalDataValue(data, String(e.uid)); delete data.entries[e.uid]; sugg.delete(e.uid); rowEls.delete(e.uid); selectedEntries.delete(e.uid); lastSel?.delete(e.uid); }
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
    const typeMatch = e => {
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
    const filterMatch = e => matchSearch(e) && typeMatch(e);
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
    /** The default duplicate name: "X copy", then "X copy 2", … until one is free. */
    const freeCopyName = src => { const base = `${src} copy`; let name = base, i = 2; while (world_names.includes(name)) name = `${base} ${i++}`; return name; };
    const nameTaken = n => world_names.some(x => x.toLowerCase() === n.toLowerCase());

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
     * Confirm a duplication, asking whether the source's ignored terms come along.
     *
     * A copy is usually a continuation of the same curation, so it defaults to carrying them — but a
     * fork you intend to re-audit from scratch wants a clean slate, and that's not knowable from here.
     * The question only appears when there is something to carry.
     * @param {string} prompt Confirmation line
     * @param {string[]} names Source books
     * @param {string|null} [defaultName] Editable target name — single-book duplication only; a bulk
     *        copy has one name per source, so there is nothing for one field to mean.
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
            // Validate in place rather than failing after the fact: returning false keeps the dialog
            // open with what they typed, so a clash is one edit away instead of a redo.
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
     * Re-points every CLOSED chat bound to `oldName`. The open one is handled by its own metadata save,
     * which is cheaper and does not race ST's in-memory copy.
     *
     * A chat's binding lives in line 0 of its .jsonl, and the only way to change it is to round-trip the
     * whole chat through /api/chats/get and /api/chats/save — there is no metadata-only endpoint. That is
     * ST's own save path, so it backs the file up and integrity-checks against a concurrent edit rather
     * than clobbering; a chat that fails is reported rather than skipped silently.
     *
     * ponytail: the whole chat crosses the wire per binding, which on a 5MB history is a real pause. It
     * happens once per rename and the alternative is leaving the chats pointed at a book that no longer
     * exists, which is silent and permanent. Revisit if ST ever exposes a metadata-only write.
     *
     * @returns {Promise<{moved: string[], failed: string[]}>}
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

    /**
     * Re-points every character card whose PRIMARY lorebook is `oldName`.
     *
     * WA was said not to be able to do this, here and in two other places, on the grounds that ST's
     * renameWorldInfo owns the field and is not exported. The helper is not, but the write is:
     * /api/characters/merge-attributes takes `{ avatar, data: { extensions: { world } } }`, deep-merges
     * it into the card and validates before writing — it is what ST's own /char-set runs.
     *
     * Single mode per card rather than the bulk form: a rename touches one or two cards, the shape of
     * the bulk `data` payload is ambiguous where the single one is exactly what /char-set sends, and a
     * per-card result says which failed.
     */
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

    // Rename a book (open or not), then re-point every binding to it: global-select, charLore, all
    // personas, the open chat, every closed chat, and every character card whose primary lorebook it was.
    // The card case was excluded for a long time on the grounds that ST's renameWorldInfo owns that field
    // and is not exported — true of the helper, false of the write, which /char-set does through
    // /api/characters/merge-attributes. WA's rename is now a superset of core's.
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
            // Every OTHER persona too, which core's updateWorldInfoLinks does and this did not — the
            // active persona's binding lives in a different field from the rest, so fixing only that one
            // looks complete and silently orphans every inactive persona pointed at the book.
            for (const p of Object.keys(power_user.personas ?? {})) {
                const d = power_user.persona_descriptions?.[p];
                if (d?.lorebook === oldName) d.lorebook = newName;
            }
            ctx.saveSettingsDebounced?.();
            if (wasChat && ctx.chatMetadata) { ctx.chatMetadata[METADATA_KEY] = newName; ctx.saveMetadata?.(); }
        } catch (err) { console.error('[WA] rename retarget', err); }
        runState.attachedWorlds = new Set([...runState.attachedWorlds].map(w => w === oldName ? newName : w));
        if (selectedBooks.delete(oldName)) selectedBooks.add(newName);
        // Per-book state follows the rename unconditionally — it's the same book under a new name, so
        // nothing here is a decision worth asking about (unlike duplication, which forks it).
        const byBook = settings().studioSortByBook;   // saved sort view
        if (byBook?.[oldName]) { byBook[newName] = byBook[oldName]; delete byBook[oldName]; saveSettingsDebounced(); }
        const ign = settings().keywordIgnore;         // ignored terms
        if (ign?.[oldName]) { ign[newName] = ign[oldName]; delete ign[oldName]; saveSettingsDebounced(); }
        dirty = false;
        if (oldName === selected) { renderBooks(); openBook(newName); }
        else { renderBooks(); }
        // Closed chats bound to the old name are orphaned by the rename and nothing else will ever fix
        // them: the binding is a string in a file, and a book that no longer exists produces no error,
        // just a chat that silently stops receiving it.
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

    // The entry set the term tabs work over: type filter + the shared sort, WITHOUT the Explorer's
    // search — those tabs rank by search match rather than filtering on it (see rankBySearch).
    const visibleEntries = () => sortEntries(Object.values(data?.entries ?? {}).filter(typeMatch));

    /**
     * Search semantics for the term tabs, which differ from the Explorer's on purpose.
     *
     * A query keeps an entry if its TITLE matches, or if one of the terms THIS TAB lists matches
     * (flagged keys in Cleanup — every key under "Show all terms" — candidates in Suggest), or — if
     * the Entry scope is ticked — its text.
     * Title hits sort first, then term hits, then text hits; within a band the normal sort order holds.
     *
     * Rows are never filtered. Locating an entry shows ALL of its terms, because deciding about one
     * term almost always means looking at its siblings — filtering to just the matched row would hide
     * the context the decision needs.
     *
     * @param {Array<{entry: object, rows: Array<{term: string}>}>} groups
     * @returns {Array} the surviving groups, ranked
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

    // --- Shared header controls -----------------------------------------------------------------
    // Built here rather than inline in one view because all three tabs mount the same search box and
    // type filter; they read/write the same module state, so a query typed in Explorer still applies
    // after switching to Cleanup.
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
     * Sort control — shared widget (module makeSortControl), and shared STATE: all three tabs read the
     * same entrySort/tieredMode/tierCfg through sortEntries, so a sort chosen in one applies in the
     * others. The base sort + tiered toggle are ephemeral view state (persisted per book only as a
     * convenience); the tier config is durable and shared with the prompt builder.
     *
     * "Insert Order" (leadItems) mirrors the durable insertion settings; its tiered state reads from
     * there, and toggling tiered while in it forks to an explicit ephemeral sort (base = the resolved
     * insertion base, clamped to a valid key).
     * @param {() => void} onChange Repaint after a sort change; the control relabels itself.
     */
    const buildSortControl = onChange => makeSortControl({
        getSort: () => entrySort, setSort: k => { entrySort = k; persistSortView(); },
        getTiered: () => entrySort === 'insert' ? !!settings().presentationTiered : tieredMode,
        setTiered: on => { if (entrySort === 'insert') { const k = normPresentation(settings().presentationOrder); entrySort = SORT_FNS[k] ? k : 'order-asc'; } tieredMode = on; persistSortView(); },
        getTierCfg: () => tierCfg, setTierCfg: cfg => { tierCfg = cfg; settings().tierCfg = cfg; saveSettingsDebounced(); },
        leadItems: [{ label: 'Insert Order', key: 'insert' }],
        onChange, mount: ctxMount,
    });

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

    // --- Cleanup / Suggest: shared key-per-row plumbing ------------------------------------------
    // Both tabs render the same shape (entry group header, then one row per term) and differ only in
    // where the rows come from, which way the checkbox defaults, and what the commit button does.
    // `reg` collects the checkbox elements so a tick can update state in place. Rebuilding the list on
    // every click would be correct but throws away scroll position, which is unusable on a big book
    // when the whole job is working down a long list of terms.
    // `onChange` re-syncs the checkboxes (cheap); `onEntryChange` rebuilds the whole list, which the
    // entry tools need — toggling case/whole-word/disable changes how the scan classifies that entry.
    const termGroupHeader = (e, rows, checks, reg, onChange, onEntryChange, extraActs = []) => {
        const head = document.createElement('div'); head.className = 'wa-term-grp';
        const ids = rows.map(r => rowId(e.uid, r.term));
        if (ids.length) {
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.margin = '0';
            // Whole-entry toggle: unticking a group is how you spare an entry in one click, which is the
            // common Cleanup move (a reference sheet whose "weak" keys are all deliberate).
            cb.addEventListener('change', () => { for (const id of ids) checks.set(id, cb.checked); onChange(); });
            reg.grp.push({ cb, ids });
            head.append(cb);
        } else {
            const pad = document.createElement('span'); pad.style.width = '13px'; head.append(pad);   // keep titles aligned
        }
        // Match mode matters when judging a term: a key on a 🔗 vector entry behaves differently from one
        // on a 🟢 keyword entry, and 🔵 constants don't need triggers at all.
        const glyph = document.createElement('span'); glyph.textContent = wiGlyph(e);
        glyph.title = e.constant ? 'Constant' : e.vectorized ? 'Vectorized' : 'Keyword';
        glyph.style.cssText = 'flex:0 0 auto;font-size:0.85em;';
        const title = document.createElement('span'); title.textContent = wiTitleOf(e); title.title = wiTitleOf(e);
        // Shrinkable, so a long title ellipsises instead of pushing the tools off the row.
        title.style.cssText = `flex:0 1 auto;min-width:3em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${e.disable ? 'opacity:0.5;' : ''}`;
        const meta = document.createElement('span'); meta.className = 'wa-tab-count'; meta.style.flex = '0 0 auto';
        meta.textContent = rows.length ? `${rows.length} term${rows.length === 1 ? '' : 's'}` : 'no candidates';
        // Reading the entry is what you actually need while judging its terms, so this opens the text in
        // a popup rather than jumping to the Explorer (which landed you at the top of an unscrolled list).
        const view = document.createElement('i'); view.className = 'fa-solid fa-file-lines wa-term-act';
        view.title = 'View this entry\'s text';
        view.addEventListener('click', () => showEntryText(e));
        // The same tool row the Explorer shows, right-aligned by .wa-entry-tools' margin-left:auto — so
        // the identity block (title, count, view, ✨) packs left and the tools sit at the far edge, where
        // they land in the Explorer too.
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
        // Per-term actions live in the right-click menu, the same place the Explorer's keyword chips put
        // them — so there's one way to delete/replace/whitelist a term wherever you meet it, and no row
        // icon competing with the reason for the same strip of space.
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
     * The book's ignored terms, as removable chips. Pinned in the term tabs rather than left to the
     * Tool Settings drawer: an ignored term is invisible in these views by construction — it stops
     * being a row — so with the drawer shut there was nothing on screen saying why a key you remember
     * flagging isn't listed, or how to get it back.
     * @param {HTMLElement} host Container to (re)fill
     * @param {() => void} onChange Repaint after un-ignoring
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
    const barBtn = (label, onClick, extra = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button wa-bulk-btn ' + extra; b.textContent = label; b.addEventListener('click', onClick); return b; };

    // --- Cleanup tab ----------------------------------------------------------------------------
    // One pass over the current chat for every "not in entry text" key at once. Deduped by FOLDED form,
    // since two keys can fold together (apostrophe normalisation) and the automaton indexes the pattern list
    // it was handed. Cost is O(chat), independent of key count.
    /**
     * Which chats does THIS BOOK reach? Studio is a lorebook manager, not a chat view — the open chat is
     * whatever happened to be loaded and may have nothing to do with the book being edited, so scanning it
     * answers the wrong question. A book binds three ways and they cost very differently to enumerate:
     *
     *   chat-bound       chat_metadata.world_info, line 0 of the .jsonl. /api/characters/chats with
     *                    metadata:true returns it without transferring any chat body.
     *   character-bound  characters[i].data.extensions.world — already in memory, free.
     *   global           selected_world_info, which means EVERY chat. Never pre-ticked: on a real corpus
     *                    that is 190 chats and 1.2GB, and the individual files run 12-17MB.
     *
     * Returns candidates with their size so the cost is visible before anything is fetched.
     */
    /**
     * Confirm which chats to scan, with sizes, pre-ticked by binding.
     *
     * Shown even when there is one candidate: the whole point is that "0 hits in chat" is only meaningful if
     * you know which chats produced it. Character-bound chats are pre-ticked with their chat-bound siblings
     * because both are real bindings; the currently-open chat is offered unticked, since including it by
     * assumption is exactly the bug this replaces.
     */
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
        // Count only, no size warning: with the plugin deployed the scan runs where the files already are and
        // nothing but the key list and the counts moves.
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

    // Per-character chat metadata, cached for the Studio session. This is the expensive half of resolution
    // — one request per character, each streaming line 0 of every chat file — and it is BOOK-INDEPENDENT:
    // only the filter below changes when you switch books, so switching costs nothing after the first scan.
    //
    // ponytail: session-scoped, no invalidation. Binding a book to a chat while Studio is open will not show
    // up until it is reopened. Refresh-on-demand if that turns out to bite; the cheap fix is closing Studio.
    let chatIndex = null;   // [{ char, avatar, charWorld, chats: [...] }]
    const loadChatIndex = async () => {
        if (chatIndex) return chatIndex;
        const list = (characters ?? []).filter(c => c?.avatar);
        // Parallel, not sequential: these are independent reads and a served instance pays a round-trip each.
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
        // Global books are listed in ST's settings, not in the lorebook file — the book itself has no idea.
        // A globally-active book genuinely applies to every chat, so those are OFFERED but never pre-ticked:
        // on a real corpus that is 190 chats and 1.2GB, and not everyone runs ST on localhost.
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

    /** Fallback path only: pull a chat's messages over HTTP. Used when the server plugin is not deployed,
     *  where the scan cannot happen where the files live. Correct, just wasteful off localhost. */
    const fetchChatMessages = async ({ char, avatar, file }) => {
        const r = await fetch('/api/chats/get', {
            method: 'POST', headers: getRequestHeaders(), cache: 'no-cache',
            body: JSON.stringify({ ch_name: char, file_name: String(file).replace(/\.jsonl$/, ''), avatar_url: avatar }),
        });
        if (!r.ok) return [];
        const j = await r.json();
        return (Array.isArray(j) ? j : []).map(m => String(m?.mes ?? '')).filter(Boolean);
    };

    /**
     * Scans a chosen set of chats and installs the result. THE one gatherer — the picker path and the
     * audit's automatic path both come here, so which button was pressed cannot change the evidence.
     * Returns a summary for the caller to phrase; it does not toast or repaint.
     */
    const scanChats = async (picked, label) => {
        // LITERALS ONLY. The scan is one Aho-Corasick pass over folded literals, so a `?` SmartKey or a
        // /regex/ key goes in as the characters it is written with and can never match — it would come
        // back 0 and be reported as absent from a chat nobody actually asked about it. Omitted from the
        // map instead, which chatRateOf reads as "not checked": no suppression, and the reason text keeps
        // saying only that entry text was searched. Evaluating them properly needs countKey per message,
        // which the server route cannot do — it has the messages but not the matcher — and doing it on
        // the client path alone would put the two halves back out of step.
        const keys = bookKeys().filter(k => !k.startsWith('?') && !isRegexKey(k));
        if (!keys.length || !picked?.length) return null;

        // PLUGIN FIRST: it scans the files where they already live and returns only counts, so a 1.2GB
        // history never crosses the wire. The client-side path below is the fallback for an undeployed
        // plugin — correct, just wasteful, which only matters off localhost.
        const onDisk = picked.filter(c => !c.open && c.avatar);
        if (runState.pluginAvailable && onDisk.length === picked.length) {
            const r = await fetch('/api/plugins/worlds-apart/scan-chats', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ keys, chats: onDisk.map(c => ({ dir: c.avatar.replace(/\.png$/, ''), file: c.file })) }),
            });
            if (r.ok) {
                const j = await r.json();
                const seen = Number(j.messages) || 0;
                // Zero messages means the route resolved no files, not that the chats are silent. Installing
                // that would set every key's share to undefined-by-division and quietly disable the whole
                // signal while the toast claimed a scan had happened.
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
        // Same accumulator the server route uses — a hit is a MESSAGE, and the two must not drift.
        for (const t of msgs) addMessageHits(aut, t, counts);
        chatHits = new Map(keys.map(k => [k, counts.get(idxOf.get(fold(k))) ?? 0]));
        chatMsgs = msgs.length;
        chatName = label;
        return { keys, live: [...chatHits.values()].filter(n => n > 0).length, via: 'client' };
    };

    /** Every chat BOUND to this book — the set worth scanning without being asked. Excludes chats that
     *  only qualify because the book is globally active: that is 190 chats on a real corpus, which is
     *  what the picker is for. */
    const boundChats = async () => {
        let bound = (await findBookChats()).filter(c => c.bound);
        // The index is cached for the Studio's lifetime (see loadChatIndex), so a chat bound — or a
        // fixture linked — while it was open reads as absent. Finding nothing is cheap to disbelieve
        // once: drop the cache and look again, rather than reporting "no bound chats" from a snapshot.
        if (!bound.length) { chatIndex = null; bound = (await findBookChats()).filter(c => c.bound); }
        return bound;
    };

    const runChatScan = async () => {
        if (!scan) { toastr.info('Run the audit first.', 'Worlds Apart'); return; }
        toastr.info('Finding chats that use this book…', 'Worlds Apart', { timeOut: 2000 });
        const found = await findBookChats();
        // The open chat is offered too, unticked, for the case the metadata does not capture — but it is
        // never assumed, which was the bug in the first cut of this.
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

    /**
     * What both audit buttons do: gather the free evidence, then re-derive.
     *
     * Scans every chat BOUND to this book, through the same gatherer the picker uses — the audits in
     * the Explorer and in Cleanup have to be identical, so the evidence cannot depend on which button
     * started it. Skipped once a scan exists, since the user's own pick may be wider than this.
     *
     * It reports what it used. The difference between "not in entry text" and "not in entry text or
     * chat" is otherwise invisible, and indistinguishable from a scan that ran and found nothing.
     */
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
        // matchWindow is in here because it reached the classifier for the first time in fefaa62 — the
        // wrapper had been dropping it, so the audit ran at 'scan' while the setting said otherwise and
        // nothing on screen disagreed. A setting that silently does nothing is the thing this line is for.
        console.log('Worlds Apart: audit evidence —', {
            book: selected, matchWindow: settings().matchWindow, boundChats: bound.length,
            scanned: got?.via ?? 'none', messages: chatMsgs, keys: chatHits?.size ?? 0, firing: got?.live ?? 0,
        });
        // SECONDARY keys the matcher drops, which no other surface in here can show: a chip is painted
        // per PRIMARY key — where `unusable` now lands like any other verdict — and a secondary has no
        // chip to be painted on, so the entry just quietly gates on fewer keys than its author wrote.
        // A separate toast rather than a clause on the ones below: it is a fact about the book, true
        // whether or not a chat was scanned, and the only warning-severity thing this button reports.
        const unusable = (scan?.entries ?? []).flatMap(e => scan.unusableKeysOf(e));
        if (unusable.length) {
            console.table(unusable.map(u => ({ entry: u.uid, key: u.key, problem: u.code, why: u.message })));
            const n = unusable.length;
            toastr.warning(`${n} secondary key${n === 1 ? '' : 's'} in this book cannot match and ${n === 1 ? 'is' : 'are'} ignored — see the console table for which entries. Secondary keys are not editable here; fix them in SillyTavern's own World Info editor.`,
                'Worlds Apart', { timeOut: 12000 });
        }
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
                // Chat evidence used to be applied HERE — a green row and a hit count bolted onto an
                // `unattested` verdict the classifier had already reached. It lives in the classifier
                // now, so a chat-attested key never reaches this list to be recoloured, and the reason
                // text carries what was checked. Nothing local left to add; the denominator is in the
                // bulk bar, where it is the same for every row.
                return { term: p.key, why: rc.text, color: rc.color, p };
            });
            // Show-all: append the keys classifyEntry didn't return — unflagged, whitelisted, or on an
            // entry the audit's scope excluded. Flagged rows stay on top, so widening the list never
            // buries the problems it found.
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
    // Whitelisting is the PERSISTENT form of "don't clean this" — unticking only spares a term for this
    // run, while the whitelist survives the session and stops the scanner flagging it at all.
    const ignoreChecked = () => {
        let n = 0;
        for (const g of cleanupGroups()) for (const r of g.rows) {
            if (cleanupChecks.get(rowId(g.entry.uid, r.term)) && !ignoreSet.has(r.term)) { ignoreSet.add(r.term); n++; }
        }
        if (!n) { toastr.info('Nothing selected to ignore.', 'Worlds Apart'); return; }
        persistIgnore(); rebuildScan(); renderExplorer();
        toastr.success(`Now ignoring ${n} term${n === 1 ? '' : 's'} in "${selected}" — they won't be flagged again.`, 'Worlds Apart');
    };
    // Both term tabs open on a synchronous whole-book pre-pass (the audit scan / the TF-IDF ranker),
    // which blocks the thread for up to a second on a large book. Paint the tab's shell with a working
    // note FIRST, yield one turn so the browser actually renders it, then do the work and repaint —
    // otherwise the click looks like it did nothing at all.
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
        // Search repaints only the list: rebuilding the header would replace the input mid-keystroke
        // and drop focus. The type filter can rebuild, since its own label has to change anyway.
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
            // Same contract as the audit popup: a tick is a suggestion. "Dead" is measured against entry
            // text, not the chat, so it has a real false-positive rate on keys the story actually uses.
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
                // Cleanup terms ARE live keys, so the Explorer's keyword menu applies unchanged.
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
            // runAudit, not rebuildScan: this is the OTHER place an audit gets built from scratch, and an
            // audit that gathered no chat evidence is a different audit. Opening Cleanup first and then
            // switching to the Explorer used to leave the chips reading verdicts from entry text alone,
            // with the Explorer's own button the only way to get the rest — two surfaces, two audits.
            await runAudit();
            auditBtn.innerHTML = '<i class="fa-solid fa-stethoscope"></i> Re-audit';
        }
        repaint();
    };

    const TABS = [['explorer', 'Explorer'], ['cleanup', 'Cleanup']];
    const renderTabBar = () => {
        const bar = document.createElement('div'); bar.className = 'wa-tabs';
        for (const [id, label] of TABS) {
            const b = document.createElement('button'); b.type = 'button';
            b.className = 'wa-tab' + (tab === id ? ' wa-tab-on' : '');
            b.textContent = label;
            // Ticked-row counts live in the tab strip so a selection left on another tab is never silent.
            const pending = id === 'cleanup' ? [...cleanupChecks.values()].filter(Boolean).length : 0;
            if (pending) { const c = document.createElement('span'); c.className = 'wa-tab-count'; c.textContent = `${pending} selected`; b.append(c); }
            b.addEventListener('click', () => { if (tab !== id) { tab = id; renderExplorer(); } });
            bar.append(b);
        }
        bar.append(closeBtn);   // tab order: straight after the last tab. It's positioned, so no layout effect
        return bar;
    };

    // A full repaint throws away the scrolling list, so anything that redraws the whole Explorer (Suggest
    // all, audit, expand all, a bulk edit) would dump the user back at the top. Carry the offset over the
    // rebuild; a book/tab change lands on a list that doesn't exist yet and starts at 0 on its own.
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

    /**
     * The orphaned-bindings list: what is broken, what it probably meant, and the repairs.
     *
     * Two book-level repairs, because only the author knows which happened. RENAME the existing book
     * back — the chats were right and the rename was the mistake — which now re-points everything on the
     * way past. Or DUPLICATE it under the old name, when both books should exist. Below that, the chats,
     * tickable, for the case where neither is true and they simply belong to a different book.
     */
    const renderOrphans = () => {
        explorer.innerHTML = '';
        explorer.append(closeBtn);
        const wrap = document.createElement('div'); wrap.style.cssText = 'padding:10px 12px;max-width:780px;';
        const h = document.createElement('h3'); h.style.cssText = 'margin:0 0 10px;';
        h.innerHTML = '<i class="fa-solid fa-link-slash"></i> Orphaned bindings';
        wrap.append(h);

        const btn = (label, fn, cls = '') => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button ' + cls;
            b.style.cssText = 'width:auto;padding:2px 8px;'; b.textContent = label;
            b.addEventListener('click', fn); return b;
        };

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
                // Both buttons do the same thing — make the missing name exist again — and differ only in
                // what happens to the existing book. Labelled by that outcome, because naming the OTHER
                // book made them read as "point the old name at the new one", which is the opposite: it
                // is the missing name that has to come back, since that is what the chats ask for.
                // "might be related to", not "looks renamed from": the match is a name similarity and
                // nothing more. A rename is only the likeliest explanation, and stating it as the finding
                // would put the tool's guess ahead of the evidence in the one place a wrong reading gets
                // acted on. Same icons the book toolbar uses for the same two verbs — fa-pen renames,
                // fa-copy duplicates — so they read as operations already known from there.
                const tool = (cls, title, fn) => {
                    const i = document.createElement('i');
                    i.className = `fa-solid ${cls} wa-book-tool`;
                    i.title = title;
                    i.addEventListener('click', fn);
                    return i;
                };
                row.append(sug,
                    tool('fa-pen', `Rename “${g.nearest}” back to “${g.name}”. The chats resolve immediately, and anything still bound to “${g.nearest}” is re-pointed with it — one book, under the old name.`,
                        async () => { await renameBook(g.nearest, g.name); await refreshOrphans(); }),
                    tool('fa-copy', `Copy “${g.nearest}” to a new book called “${g.name}”. Both books exist afterwards with the same contents — for when the rename was deliberate and these chats want the old one.`,
                        async () => { await copyBookByName(g.nearest, false, g.name); await updateWorldInfoList(); await refreshOrphans(); }));
                box.append(row);
            }

            if (g.cards.length) {
                // Its own control, not the chat dropdown: a card binding is a different write
                // (/api/characters/merge-attributes) and a different decision — the chats under a
                // character may belong somewhere other than the character itself does.
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
                // A dropdown, not a typed name: the target is always an EXISTING book, so there is
                // nothing to type and nothing to mistype. Defaults to the suggestion when there is one.
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
        const listTop = explorer.querySelector('.wa-studio-entries')?.scrollTop ?? 0;
        explorer.innerHTML = ''; rowEls.clear();
        // The close button lives in the tab bar (for tab order), so the no-book branch — which paints no
        // tab bar — has to re-adopt it or the wipe above takes the only way out with it.
        if (!selected) { explorer.innerHTML = '<div style="opacity:0.6;padding:8px;">Select a lorebook on the left.</div>'; explorer.append(closeBtn); return; }
        termRepaint = null;   // the term views below claim it; the Explorer leaves it null
        explorer.append(renderTabBar());
        const pane = document.createElement('div');
        pane.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;overflow:hidden;min-height:0;';
        explorer.append(pane);
        // Cleanup runs its own audit pre-pass and is async so it can paint a working note before
        // blocking — nothing here awaits it; it repaints itself.
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
        // Book-level tools: rename / duplicate / delete the whole lorebook.
        const bookTool = (cls, title, onClick, extra = '') => { const i = document.createElement('i'); i.className = `fa-solid ${cls} wa-book-tool ${extra}`; i.title = title; i.addEventListener('click', onClick); return i; };
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
        // The tooltip carries WHICH evidence the verdicts rest on. A chip reading "not in entry text"
        // and one reading "not in entry text or chat" are different claims, and nothing else on this
        // screen says whether a chat was searched.
        scanBtn.title = chatHits
            ? `Flag dead / common / short keywords — tune under Tool Settings.\nChat evidence: "${chatName}", ${chatMsgs} messages.`
            : 'Flag dead / common / short keywords and colour them by verdict — tune under Tool Settings.\nNo chat searched yet: bind this book to the open chat, or use Cleanup → "Check against chats".';
        scanBtn.addEventListener('click', async () => { await runAudit(); renderExplorer(); });
        const allOpen = entries.length > 0 && entries.every(x => entryOpen.has(x.uid));
        // Master disclosure: an icon-only chevron left of the title, echoing the per-entry chevrons.
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
        // Typing re-filters the list in place (applyFilter) rather than re-rendering the header, so the
        // input keeps focus and the caret between keystrokes.
        const searchWrap = buildSearchBox(() => applyFilter());
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
        // Creating an entry had no home in the Studio at all — you could duplicate one but not make one,
        // so a new book could only be filled from core's editor. Sits far right, away from the batch
        // actions: authoring one entry at a time is the rarer errand here, and it is the only button on
        // the row that writes rather than analyses.
        const newBtn = document.createElement('button');
        newBtn.type = 'button'; newBtn.className = 'menu_button';
        newBtn.style.cssText = 'width:auto;padding:3px 9px;flex-shrink:0;';
        newBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New entry';
        newBtn.title = 'Add a blank entry to this lorebook';
        newBtn.addEventListener('click', () => newEntry());
        // A flex spacer rather than margin-left:auto. The row wraps, and an auto-margin still applies on
        // whatever line the button lands on — so once the row was too narrow, New entry hung alone off
        // the right of a second line. Line-breaking uses flex-basis, and this basis is 0, so the spacer
        // never affects where the wrap falls: it grows to push the button right while everything fits,
        // and once the button wraps it simply starts the next line at the left.
        const grow = document.createElement('span'); grow.style.cssText = 'flex:1 1 0;min-width:0;';
        row2.append(expandBtn, scanBtn, suggestAllBtn, suggestAllLlmBtn, grow, newBtn);
        head.append(row1, row2);
        // Pinned region (header + Tool Settings drawer) stays put; only wa-studio-entries scrolls.
        const fixed = document.createElement('div'); fixed.className = 'wa-studio-fixed';
        globalTrayEl = renderGlobalTray();
        trayEl = renderTray();
        bulkEl = renderBulkBar();
        fixed.append(head, globalTrayEl, trayEl, bulkEl);
        const list = document.createElement('div'); list.className = 'wa-studio-entries';
        pane.append(fixed, list);
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

        // Broken bindings, at the foot and only when there are some. Not a book: it is a fact about
        // chats, and the selector is the only place in a book-oriented tool where a chat-shaped fact
        // can hang without interrupting whatever book you are actually working on.
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

    // Escape dismisses inside Studio; it never closes the window. A close throws away scroll position,
    // which entries are open, and the selection — too much to lose to a stray keypress when the ✕ is
    // right there. Bubble phase, so an inline keyword editor or an open context menu handles its own
    // Escape first (both preventDefault); we only swallow the <dialog>'s close and, failing anything
    // else to dismiss, drop the selection.
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
