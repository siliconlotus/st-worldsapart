// keyword-tools.mjs — the ST-coupled half of the lorebook keyword analysis feature: the two wand-menu
// reports (keywordScoresReport / keywordSuggestReport) and the LLM generation plumbing. The pure
// classifier/ranker/filter logic lives in keyword-core.mjs (ST-free, node-importable); this module
// surfaces it in popups, persists results, and injects the world-info match flags.
import { generateRaw, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { loadWorldInfo, saveWorldInfo, reloadEditor, world_names, world_info_case_sensitive, world_info_match_whole_words } from '../../../../world-info.js';
import { escapeHtml, splitRecursive } from '../../../../utils.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { runState, settings } from './state.mjs';
import { KEY_TOO_COMMON, KEY_MIN_LENGTH, KEY_SHARED, buildKeyPruneScan as buildKeyPruneScanCore, buildKeySuggest, buildKeyPrompt, classifyLlmCand, parseKeyList } from './keyword-core.mjs';
import { showEntryText } from './ui-widgets.mjs';

/** buildKeyPruneScan with core's world-info match flags injected. A wrapper (not a bound value) so
 * the flags are read at call time — they're live ST settings. */
export const buildKeyPruneScan = (data, opts, ignoreSet) =>
    buildKeyPruneScanCore(data, opts, ignoreSet, { caseSensitiveDefault: world_info_case_sensitive, wholeWordsDefault: world_info_match_whole_words });

// Row title for both reports: entry comment, or a UID/order fallback (unlike wiTitleOf, which
// falls back to the key list — too long for a row header).
const titleOf = e => (e.comment && e.comment.trim()) ? e.comment.trim() : `UID ${e.uid} (order ${e.order ?? 0})`;

/**
 * /wa-keyword-scores — audit one lorebook's keys and prune/rename/ignore the weak ones. Loops
 * between two phases (Back returns to options): (1) pick a book and scan options; (2) a per-entry
 * results list. Each key row prunes (checkbox), renames (pencil → edit → confirm, which re-analyses
 * that term) or ignores (persisted per-book whitelist). Entry headers show clickable active /
 * case-sensitive / whole-word flags; toggling whole-word re-runs that entry's short-key check.
 * Every count honours the owning entry's match flags via countKey, so a whole-word entry's short
 * key can't collide and isn't flagged, and short rows show whole-word / total hits. Reasons are
 * colour-graded by severity. Two independent frequency axes are flagged: how often a key appears in
 * entry TEXT (firing rate) and how many entries LIST it (activation breadth).
 */
export async function keywordScoresReport() {
    const books = [...(world_names ?? [])].sort((a, b) => a.localeCompare(b));
    if (!books.length) { toastr.warning('No lorebooks found.', 'Worlds Apart'); return ''; }

    // Persisted per-book ignore whitelist. Lazy-init so we never mutate defaultSettings' shared
    // object (Object.assign copies the reference); it also stays out of nonDefaults (an object).
    const s = settings();
    if (!s.keywordIgnore) s.keywordIgnore = {};

    // Carried across the Back loop so a return trip keeps the last choices.
    let book = [...runState.attachedWorlds].find(w => books.includes(w)) ?? books[0];
    let opts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: false, pruneDead: true, pruneCommon: true, pruneShort: true, pruneShared: true, ignoreProper: false, stickySkipCommon: true, tooCommon: KEY_TOO_COMMON, minLength: KEY_MIN_LENGTH, sharedKeys: KEY_SHARED };

    // Phase 1: book + scan options. Resolves true to proceed, false to close out.
    const showOptions = async () => {
        const w = document.createElement('div');
        w.style.textAlign = 'left';
        const chk = on => on ? ' checked' : '';
        const numStyle = 'style="width:3.5em;margin:0;"';
        w.innerHTML = '<b>Worlds Apart · keyword prune</b>'
            + '<label style="display:block;margin-top:0.5em;">Lorebook '
            + `<select class="wa-book text_pole" style="max-width:70%;">${books.map(b => `<option value="${escapeHtml(b)}"${b === book ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}</select></label>`
            + '<div style="margin-top:0.7em;font-weight:bold;">Entry types to scan</div>'
            + `<label class="checkbox_label"><input type="checkbox" class="wa-scanKeyword"${chk(opts.scanKeyword)}><span>Keyword (🟢)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-scanVectorized"${chk(opts.scanVectorized)}><span>Vectorized (🔗)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-scanConstant"${chk(opts.scanConstant)}><span>Constant (🔵)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-includeInactive"${chk(opts.includeInactive)}><span>Include inactive</span></label>`
            + '<div style="margin-top:0.5em;font-weight:bold;">Recommend pruning</div>'
            + `<label class="checkbox_label"><input type="checkbox" class="wa-pruneDead"${chk(opts.pruneDead)}><span>Dead keys (in no entry\'s text)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-pruneCommon"${chk(opts.pruneCommon)}><span>Too-common keys (in &gt;<input type="number" class="wa-tooCommon text_pole" ${numStyle} min="1" max="100" step="1" value="${Math.round(opts.tooCommon * 100)}">% of entries)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-pruneShared"${chk(opts.pruneShared)}><span>Over-shared keys (listed by &gt;<input type="number" class="wa-sharedKeys text_pole" ${numStyle} min="1" max="100" step="1" value="${Math.round(opts.sharedKeys * 100)}">% of entries — one hit activates them all)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-pruneShort"${chk(opts.pruneShort)}><span>Short keys (&lt;<input type="number" class="wa-minLen text_pole" ${numStyle} min="1" step="1" value="${opts.minLength}"> chars — substring false positives)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-ignoreProper"${chk(opts.ignoreProper)}><span>Ignore proper nouns (don\'t flag a Name as dead)</span></label>`
            + `<label class="checkbox_label"><input type="checkbox" class="wa-stickySkip"${chk(opts.stickySkipCommon)}><span>Spare sticky entries from lorebook-common (a reference sheet\'s bare-name trigger is meant to be ubiquitous)</span></label>`
            + '<small style="display:block;margin-top:0.5em;opacity:0.6;">Flagging is per-key on its own text frequency; a deliberate recurring name may show as too-common — whitelist it with the ban icon, or mark its reference entry sticky.</small>';
        const p = new Popup(w, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Assess', cancelButton: 'Close',
            onClosing: pp => {
                if (pp.result === POPUP_RESULT.AFFIRMATIVE) {
                    const pct = Number(w.querySelector('.wa-tooCommon').value);
                    const shared = Number(w.querySelector('.wa-sharedKeys').value);
                    const minLen = Number(w.querySelector('.wa-minLen').value);
                    book = w.querySelector('.wa-book').value;
                    opts = {
                        scanKeyword: w.querySelector('.wa-scanKeyword').checked,
                        scanVectorized: w.querySelector('.wa-scanVectorized').checked,
                        scanConstant: w.querySelector('.wa-scanConstant').checked,
                        includeInactive: w.querySelector('.wa-includeInactive').checked,
                        pruneDead: w.querySelector('.wa-pruneDead').checked,
                        pruneCommon: w.querySelector('.wa-pruneCommon').checked,
                        pruneShort: w.querySelector('.wa-pruneShort').checked,
                        pruneShared: w.querySelector('.wa-pruneShared').checked,
                        ignoreProper: w.querySelector('.wa-ignoreProper').checked,
                        stickySkipCommon: w.querySelector('.wa-stickySkip').checked,
                        tooCommon: pct > 0 && pct <= 100 ? pct / 100 : KEY_TOO_COMMON,
                        sharedKeys: shared > 0 && shared <= 100 ? shared / 100 : KEY_SHARED,
                        minLength: minLen >= 1 ? Math.floor(minLen) : KEY_MIN_LENGTH,
                    };
                }
                return true;
            },
        });
        return (await p.show()) === POPUP_RESULT.AFFIRMATIVE;
    };

    for (;;) {
        if (!await showOptions()) return '';

        // Assess: load the book and set up flag-aware scanning + classification.
        const data = await loadWorldInfo(book);
        if (!data?.entries) { toastr.warning(`Couldn't load "${book}".`, 'Worlds Apart'); continue; }
        const ignoreSet = new Set(s.keywordIgnore[book] ?? []);
        // Shared classifier — same one Lorebook Studio uses, so the audit never drifts from it.
        const { entries, nE, classifyEntry, reasonOf, defChecked, effCase, effWhole } = buildKeyPruneScan(data, opts, ignoreSet);

        if (!entries.some(e => classifyEntry(e).length)) {
            toastr.info(`No weak keys across ${nE} ${opts.includeInactive ? '' : 'active '}entries in "${book}".`, 'Worlds Apart');
            continue;
        }

        // Phase 2: results. Structural edits (rename, flag toggles) save immediately; pruning is the
        // batched OK action. render() rebuilds from live entry state, so every edit just re-renders.
        const resWrap = document.createElement('div');
        resWrap.style.cssText = 'text-align:left;width:71rem;max-width:100%;';
        const head = document.createElement('div');
        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;';
        table.innerHTML = '<colgroup><col style="width:3.4em;"><col><col style="width:12.5em;"><col style="width:2.2em;"></colgroup>';
        const bodyEl = document.createElement('tbody');
        table.append(bodyEl);
        resWrap.append(head, table);

        const checks = new Map();          // rowId -> prune checkbox state, kept across renders
        const pruned = new Map();          // uid -> Set of keys pruned this session (stay visible, struck, undoable)
        let editing = null, editVal = '';  // rowId being renamed + its live text
        let dirty = false;                 // a loresheet edit was saved -> reloadEditor on close
        const rowId = (uid, key) => `${uid}${key}`;
        const persistIgnore = () => { s.keywordIgnore[book] = [...ignoreSet]; saveSettingsDebounced(); };

        const syncHeaders = () => {
            bodyEl.querySelectorAll('.wa-grp-cb').forEach(g => {
                const boxes = [...bodyEl.querySelectorAll(`.wa-row-cb[data-g="${g.dataset.g}"]`)];
                const on = boxes.filter(b => b.checked).length;
                g.checked = on > 0 && on === boxes.length;
                g.indeterminate = on > 0 && on < boxes.length;
            });
            const all = [...bodyEl.querySelectorAll('.wa-row-cb')];
            const gcb = head.querySelector('.wa-all-cb');
            if (gcb) {
                const on = all.filter(b => b.checked).length;
                gcb.checked = on > 0 && on === all.length;
                gcb.indeterminate = on > 0 && on < all.length;
            }
        };

        const renderHead = () => {
            const nVis = bodyEl.querySelectorAll('.wa-row-cb').length;
            const recs = [opts.pruneDead && 'dead', opts.pruneCommon && `too-common >${+(opts.tooCommon * 75).toFixed(1)}% (red >${Math.round(opts.tooCommon * 100)}%)`, opts.pruneShared && `over-shared >${+(opts.sharedKeys * 75).toFixed(1)}% (red >${Math.round(opts.sharedKeys * 100)}%)`, opts.pruneShort && `short <${opts.minLength}`].filter(Boolean).join(', ');
            const doc = `Scan: ${opts.includeInactive ? 'all entries' : 'active entries'} · ${recs || 'nothing'}${opts.ignoreProper ? ' · sparing proper-noun dead' : ''}`;
            const list = [...ignoreSet];
            const ign = list.length ? ` · <span style="opacity:0.7;">${list.length} ignored (${escapeHtml(list.join(', '))}) <a class="wa-clear" style="cursor:pointer;text-decoration:underline;">clear</a></span>` : '';
            head.innerHTML = `<b>keyword prune · ${escapeHtml(book)} — ${nVis} weak key(s)</b>`
                + `<div style="opacity:0.6;font-size:0.9em;margin:0.2em 0;">${escapeHtml(doc)}</div>`
                + '<div style="opacity:0.75;font-size:0.9em;">Check to prune · pencil to rename · ban icon to whitelist · x/y = entries containing the term.</div>'
                + `<div style="margin:0.4em 0;"><label class="checkbox_label" style="display:inline-flex;"><input type="checkbox" class="wa-all-cb"><span>Select all</span></label>${ign}</div>`;
            head.querySelector('.wa-all-cb').addEventListener('change', e => {
                bodyEl.querySelectorAll('.wa-row-cb').forEach(cb => { cb.checked = e.target.checked; checks.set(cb.dataset.id, cb.checked); });
                syncHeaders();
            });
            head.querySelector('.wa-clear')?.addEventListener('click', () => { ignoreSet.clear(); persistIgnore(); render(); });
        };

        // White when the flag is on, dim when off; click toggles the entry flag, saves, re-analyses.
        // cls starting "fa-" is a FontAwesome glyph; anything else is rendered as literal text (e.g.
        // "Aa" for case — FA paywalls fa-font-case, and "Aa" is the universal case-toggle signifier).
        const flagIcon = (cls, on, title, onClick) => {
            const i = document.createElement('i');
            const isFa = cls.startsWith('fa-');
            if (isFa) i.className = `fa-solid ${cls}`; else i.textContent = cls;
            i.title = title;
            i.style.cssText = `cursor:pointer;margin-left:0.6em;opacity:${on ? 1 : 0.35};` + (isFa ? '' : 'font-style:normal;font-weight:bold;');
            i.addEventListener('click', onClick);
            return i;
        };

        function render() {
            if (editing) { const inp = bodyEl.querySelector('.wa-term-edit'); if (inp) editVal = inp.value; }
            bodyEl.innerHTML = '';
            for (const e of entries) {
                const rows = classifyEntry(e);
                const prunedKeys = pruned.get(String(e.uid));
                if (!rows.length && !(prunedKeys && prunedKeys.size)) continue;
                const gid = `g${e.uid}`;
                const off = !!e.disable;
                const hc = bodyEl.insertRow().insertCell();
                hc.colSpan = 4;
                hc.style.cssText = 'padding:0.6em 0 0.15em;';
                const wrap = document.createElement('div');
                wrap.style.cssText = 'display:flex;align-items:center;column-gap:5px;';
                const gcb = document.createElement('input');
                gcb.type = 'checkbox'; gcb.className = 'wa-grp-cb'; gcb.dataset.g = gid;
                gcb.addEventListener('change', () => {
                    bodyEl.querySelectorAll(`.wa-row-cb[data-g="${gid}"]`).forEach(cb => { cb.checked = gcb.checked; checks.set(cb.dataset.id, cb.checked); });
                    syncHeaders();
                });
                const tt = document.createElement('span');
                tt.style.cssText = `font-weight:bold;${off ? 'opacity:0.45;' : ''}`;
                tt.textContent = titleOf(e);
                tt.title = (Array.isArray(e.key) && e.key.length) ? `Keywords (${e.key.length}): ${e.key.join(', ')}` : 'No keywords';
                const viewEntry = document.createElement('i');
                viewEntry.className = 'fa-solid fa-file-lines';
                viewEntry.title = 'View entry text';
                viewEntry.style.cssText = 'cursor:pointer;margin-left:0.6em;opacity:0.6;';
                viewEntry.addEventListener('click', () => showEntryText(e));
                wrap.append(gcb, tt, viewEntry,
                    flagIcon('fa-power-off', !off, off ? 'Disabled — click to enable' : 'Active — click to disable', () => { e.disable = !e.disable; dirty = true; saveWorldInfo(book, data, true); render(); }),
                    flagIcon('Aa', effCase(e), `Case-sensitive: ${effCase(e) ? 'on' : 'off'} — click to toggle`, () => { e.caseSensitive = !effCase(e); dirty = true; saveWorldInfo(book, data, true); render(); }),
                    flagIcon('[ab]', effWhole(e), `Match whole words: ${effWhole(e) ? 'on' : 'off'} — click to toggle (re-runs short-key check)`, () => { e.matchWholeWords = !effWhole(e); dirty = true; saveWorldInfo(book, data, true); render(); }),
                    flagIcon('fa-thumbtack', Number(e.sticky) > 0, `Sticky: ${Number(e.sticky) > 0 ? `on (${e.sticky})` : 'off'} — click to toggle (mark a reference sheet; spares its keys from lorebook-common)`, () => { e.sticky = Number(e.sticky) > 0 ? 0 : 1; dirty = true; saveWorldInfo(book, data, true); render(); }),
                );
                hc.append(wrap);

                for (const p of rows) {
                    const id = rowId(e.uid, p.key);
                    if (!checks.has(id)) checks.set(id, defChecked(p));
                    const tr = bodyEl.insertRow();
                    const c0 = tr.insertCell();
                    c0.style.cssText = 'padding-left:1.6em;vertical-align:top;';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox'; cb.className = 'wa-row-cb'; cb.dataset.g = gid; cb.dataset.id = id; cb.checked = checks.get(id);
                    cb.addEventListener('change', () => { checks.set(id, cb.checked); syncHeaders(); });
                    c0.append(cb);
                    const c1 = tr.insertCell();
                    c1.style.overflow = 'hidden';
                    if (editing === id) {
                        const inp = document.createElement('input');
                        inp.type = 'text'; inp.className = 'wa-term-edit text_pole'; inp.style.cssText = 'width:75%;margin:0;'; inp.value = editVal;
                        inp.addEventListener('input', () => { editVal = inp.value; });
                        const ok = document.createElement('i');
                        ok.className = 'fa-solid fa-check'; ok.title = 'Confirm rename'; ok.style.cssText = 'cursor:pointer;margin-left:0.5em;';
                        ok.addEventListener('click', () => {
                            const nv = inp.value.trim();
                            editing = null;
                            if (nv && nv !== p.key) {
                                const idx = e.key.indexOf(p.key);
                                if (idx >= 0) { if (e.key.includes(nv)) e.key.splice(idx, 1); else e.key[idx] = nv; }
                                checks.delete(id); dirty = true; saveWorldInfo(book, data, true);
                            }
                            render();
                        });
                        c1.append(inp, ok);
                    } else {
                        const t = document.createElement('span');
                        t.textContent = String(p.key); t.title = String(p.key);
                        t.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;max-width:calc(100% - 1.6em);vertical-align:bottom;';
                        const pen = document.createElement('i');
                        pen.className = 'fa-solid fa-pencil'; pen.title = 'Rename'; pen.style.cssText = 'cursor:pointer;margin-left:0.5em;opacity:0.7;';
                        pen.addEventListener('click', () => { editing = id; editVal = String(p.key); render(); });
                        c1.append(t, pen);
                    }
                    const c2 = tr.insertCell();
                    const rc = reasonOf(p);
                    c2.style.cssText = `white-space:nowrap;opacity:0.85;${rc.color ? `color:${rc.color};` : ''}`;
                    c2.textContent = rc.text;
                    const c3 = tr.insertCell();
                    c3.style.textAlign = 'right';
                    const ig = document.createElement('i');
                    ig.className = 'fa-solid fa-ban'; ig.title = 'Ignore (whitelist for this book)'; ig.style.cssText = 'cursor:pointer;opacity:0.6;';
                    ig.addEventListener('click', () => { ignoreSet.add(p.key); persistIgnore(); render(); });
                    c3.append(ig);
                }
                // Pruned keys stay listed (struck, no checkbox) so a commit never makes an entry vanish
                // — you can confirm the result, or undo if the edit went wrong.
                if (prunedKeys) for (const key of prunedKeys) {
                    const tr = bodyEl.insertRow();
                    tr.style.opacity = '0.5';
                    tr.insertCell().style.cssText = 'padding-left:1.6em;';   // empty checkbox cell — settled/unchecked
                    const c1 = tr.insertCell();
                    c1.style.overflow = 'hidden';
                    const t = document.createElement('span');
                    t.textContent = String(key); t.title = String(key);
                    t.style.cssText = 'text-decoration:line-through;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;max-width:calc(100% - 1.6em);vertical-align:bottom;';
                    c1.append(t);
                    const c2 = tr.insertCell();
                    c2.style.cssText = 'white-space:nowrap;opacity:0.85;';
                    c2.textContent = 'pruned';
                    const c3 = tr.insertCell();
                    c3.style.textAlign = 'right';
                    const un = document.createElement('i');
                    un.className = 'fa-solid fa-rotate-left'; un.title = 'Undo — restore this key'; un.style.cssText = 'cursor:pointer;opacity:0.6;';
                    un.addEventListener('click', () => {
                        const ent = data.entries[e.uid] ?? data.entries[String(e.uid)];
                        if (ent) { if (!Array.isArray(ent.key)) ent.key = []; if (!ent.key.includes(key)) ent.key.push(key); dirty = true; saveWorldInfo(book, data, true); }
                        prunedKeys.delete(key); if (!prunedKeys.size) pruned.delete(String(e.uid));
                        render();
                    });
                    c3.append(un);
                }
            }
            renderHead();
            syncHeaders();
        }
        render();

        // Prune the checked keys in place and re-render — the dialog stays open so a committed entry
        // never disappears (you can verify it, or undo). Ignored keys never render, so they're safe.
        const pruneChecked = () => {
            const checked = [...bodyEl.querySelectorAll('.wa-row-cb')].filter(cb => cb.checked)
                .map(cb => { const sep = cb.dataset.id.indexOf(''); return { id: cb.dataset.id, uid: cb.dataset.id.slice(0, sep), key: cb.dataset.id.slice(sep + 1) }; });
            let removed = 0;
            const touched = new Set();
            for (const a of checked) {
                if (ignoreSet.has(a.key)) continue;
                const ent = data.entries[a.uid] ?? data.entries[String(a.uid)];
                if (!ent || !Array.isArray(ent.key)) continue;
                const idx = ent.key.indexOf(a.key);
                if (idx < 0) continue;
                ent.key.splice(idx, 1); removed++; touched.add(String(a.uid));
                if (!pruned.has(String(a.uid))) pruned.set(String(a.uid), new Set());
                pruned.get(String(a.uid)).add(a.key);
                checks.delete(a.id);
            }
            if (removed) { dirty = true; saveWorldInfo(book, data, true); render(); toastr.success(`"${book}": pruned ${removed} key(s) from ${touched.size} entr${touched.size === 1 ? 'y' : 'ies'}.`, 'Worlds Apart'); }
            else toastr.info('Nothing checked to prune.', 'Worlds Apart');
        };
        const step2 = new Popup(resWrap, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Prune checked', cancelButton: 'Close', allowVerticalScrolling: true,
            customButtons: [{ text: 'Back', result: POPUP_RESULT.CUSTOM1 }],
            onClosing: pp => {
                if (pp.result === POPUP_RESULT.AFFIRMATIVE) { pruneChecked(); return false; }   // stay open — don't vanish
                return true;
            },
        });
        const res = await step2.show();
        if (dirty) reloadEditor(book);
        if (res === POPUP_RESULT.CUSTOM1) continue;   // Back to options
        return '';
    }
}

/**
 * One-shot text generation over the configured summary profile (or the current API). Mirrors the
 * connection path in summarizeQuery minus the caching/prompt-building/fallback — callers handle
 * failure — so the LLM keyword mode hits the same local model the summariser uses.
 */
async function generateText(prompt, responseLength) {
    const s = settings();
    const profileId = s.summaryProfile;
    const profile = profileId ? (extension_settings.connectionManager?.profiles ?? []).find(x => x.id === profileId) : null;
    if (profile) {
        const includePreset = !s.summaryBypassPreset;
        const temp = String(s.summaryTemperature ?? '').trim();
        const overridePayload = temp === '' ? {} : { temperature: Number(temp) };
        const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, responseLength, { includePreset }, overridePayload);
        const content = String(result?.content ?? '').trim();
        if (!content && result?.reasoning) throw new Error(`profile "${profile.name}" is a reasoning model (returned reasoning, no content). Pick a profile without ":thinking".`);
        return content;
    }
    return String(await generateRaw({ prompt, responseLength })).trim();
}

// A small local model summarises instead of extracting once an entry runs long, so cap the text per
// call and run one pass per chunk, concatenating the raw candidate lines (callers dedupe/filter).
// chunkSize is user-tunable (Recommender settings) since the reliable window varies per model.
export async function llmKeyCandidates(content, avoid, chunkSize = 5000) {
    const text = String(content ?? '');
    const chunks = text.length > chunkSize ? splitRecursive(text, chunkSize, ['\n\n', '\n', '. ', ' ', '']) : [text];
    const out = [];
    for (const c of chunks) out.push(...parseKeyList(await generateText(buildKeyPrompt(c, avoid), 400)));
    return out;
}

export async function keywordSuggestReport() {
    const books = [...(world_names ?? [])].sort((a, b) => a.localeCompare(b));
    if (!books.length) { toastr.warning('No lorebooks found.', 'Worlds Apart'); return ''; }

    const GRN = '#7bbf6a';

    let book = [...runState.attachedWorlds].find(w => books.includes(w)) ?? books[0];
    let dfCeil = 0.15;   // drop terms in more than this fraction of the corpus
    let maxN = 4;        // longest n-gram
    let excludeDates = true;
    let excludeShort = true;   // drop short single-word terms (substring false positives), like the pruner
    let onlyActive = true;   // scan only enabled entries
    let cap = 8;             // max suggestions shown per entry

    // Phase 1: book + knobs (whole-book batch — no per-entry picker).
    const showOptions = async () => {
        const w = document.createElement('div');
        w.style.textAlign = 'left';
        w.innerHTML = '<b>Worlds Apart · suggest keywords (whole book)</b>'
            + '<label style="display:block;margin-top:0.5em;">Lorebook '
            + `<select class="wa-book text_pole" style="max-width:70%;">${books.map(b => `<option value="${escapeHtml(b)}"${b === book ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}</select></label>`
            + `<label style="display:block;margin-top:0.5em;">Drop terms in &gt;<input type="number" class="wa-dfceil text_pole" style="width:3.5em;margin:0;" min="1" max="100" step="1" value="${Math.round(dfCeil * 100)}">% of entries</label>`
            + `<label style="display:block;margin-top:0.5em;">Longest phrase (n-gram) <input type="number" class="wa-maxn text_pole" style="width:3.5em;margin:0;" min="1" max="8" step="1" value="${maxN}"> words</label>`
            + `<label style="display:block;margin-top:0.5em;">Max suggestions per entry <input type="number" class="wa-cap text_pole" style="width:3.5em;margin:0;" min="1" max="50" step="1" value="${cap}"></label>`
            + `<label class="checkbox_label" style="margin-top:0.5em;"><input type="checkbox" class="wa-active"${onlyActive ? ' checked' : ''}><span>Only active entries (skip disabled)</span></label>`
            + `<label class="checkbox_label" style="margin-top:0.5em;"><input type="checkbox" class="wa-nodates"${excludeDates ? ' checked' : ''}><span>Exclude dates (poor triggers; they stay in the entry text)</span></label>`
            + `<label class="checkbox_label" style="margin-top:0.5em;"><input type="checkbox" class="wa-noshort"${excludeShort ? ' checked' : ''}><span>Exclude short single words (&lt;4 chars — substring false positives)</span></label>`
            + '<small style="display:block;margin-top:0.6em;opacity:0.6;">TF-IDF over the whole book: every entry\'s distinctive terms (1–maxN-grams, tf&ge;2, function words derived, longer phrases boosted), skipping any that the pruner would call too-common. The ✨ on any entry adds local-model suggestions for that one entry.</small>';
        const p = new Popup(w, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Assess', cancelButton: 'Close',
            onClosing: pp => {
                if (pp.result === POPUP_RESULT.AFFIRMATIVE) {
                    book = w.querySelector('.wa-book').value;
                    const pct = Number(w.querySelector('.wa-dfceil').value);
                    dfCeil = pct > 0 && pct <= 100 ? pct / 100 : 0.15;
                    const mn = Number(w.querySelector('.wa-maxn').value);
                    maxN = mn >= 1 && mn <= 8 ? Math.floor(mn) : 4;
                    excludeDates = w.querySelector('.wa-nodates').checked;
                    excludeShort = w.querySelector('.wa-noshort').checked;
                    onlyActive = w.querySelector('.wa-active').checked;
                    const cp = Number(w.querySelector('.wa-cap').value);
                    cap = cp >= 1 && cp <= 50 ? Math.floor(cp) : 8;
                }
                return true;
            },
        });
        return (await p.show()) === POPUP_RESULT.AFFIRMATIVE;
    };

    for (;;) {
        if (!await showOptions()) return '';

        const data = await loadWorldInfo(book);
        if (!data?.entries) { toastr.warning(`Couldn't load "${book}".`, 'Worlds Apart'); continue; }
        // Shared ranker — same one Lorebook Studio uses. onlyActive rides in via opts.
        const { entries, N, perEntry, canon, dfSubstr, avoid, exampleCanon } =
            buildKeySuggest(data, { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap });

        // Results.
        const resWrap = document.createElement('div');
        resWrap.style.cssText = 'width:100%;text-align:left;';
        const head = document.createElement('div');
        head.innerHTML = `<b>keyword suggestions · ${escapeHtml(book)}</b>`
            + `<div style="opacity:0.75;font-size:0.9em;margin:0.2em 0;">${perEntry.length} of ${N} entries have suggestions · 1–${maxN}-grams, tf&ge;2, df&le;${Math.round(dfCeil * 100)}%${excludeDates ? ', dates excluded' : ''}</div>`
            + (perEntry.length ? '' : '<div style="opacity:0.6;">No new suggestions — every distinctive term is already a key.</div>');
        resWrap.append(head);

        const list = document.createElement('div');
        const sparkRunners = [];   // one reroll fn per entry, for the "LLM all" sweep
        let dirty = false;         // a live key was renamed -> reloadEditor on close
        if (perEntry.length) {
            const bar = document.createElement('div');
            bar.style.cssText = 'display:flex;align-items:center;gap:0.9em;margin:0.2em 0 0.5em;';
            const allWrap = document.createElement('label');
            allWrap.style.cssText = 'display:inline-flex;align-items:center;gap:0.4em;cursor:pointer;';
            const allCb = document.createElement('input'); allCb.type = 'checkbox'; allCb.style.margin = '0';
            allCb.addEventListener('change', () => list.querySelectorAll('.wa-row-cb, .wa-grp-cb').forEach(cb => { cb.checked = allCb.checked; }));
            allWrap.append(allCb, document.createTextNode('Select all'));
            const llmAll = document.createElement('button');
            llmAll.type = 'button'; llmAll.className = 'menu_button'; llmAll.style.margin = '0';
            llmAll.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> LLM all';
            llmAll.title = 'Run local-model suggestions for every entry, one after another';
            llmAll.addEventListener('click', async () => {
                llmAll.disabled = true;
                for (let i = 0; i < sparkRunners.length; i++) { toastr.info(`LLM all: ${i + 1}/${sparkRunners.length}…`, 'Worlds Apart', { timeOut: 1200 }); await sparkRunners[i](); }
                toastr.success('LLM all: done.', 'Worlds Apart'); llmAll.disabled = false;
            });
            bar.append(allWrap, llmAll);
            resWrap.append(bar);
        }

        for (const pe of perEntry) {
            const block = document.createElement('div');
            block.style.cssText = 'margin:0.5em 0;padding-bottom:0.45em;border-bottom:1px solid rgba(128,128,128,0.2);';
            const hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;align-items:center;gap:0.5em;margin-bottom:0.25em;';
            const grp = document.createElement('input'); grp.type = 'checkbox'; grp.className = 'wa-grp-cb'; grp.style.margin = '0';
            grp.addEventListener('change', () => block.querySelectorAll('.wa-row-cb').forEach(cb => { cb.checked = grp.checked; }));
            const ttl = document.createElement('span');
            ttl.textContent = titleOf(pe.entry);
            ttl.style.cssText = `font-weight:bold;${pe.entry.disable ? 'opacity:0.5;' : ''}`;
            const view = document.createElement('i');
            view.className = 'fa-solid fa-file-lines';
            view.title = 'View entry text';
            view.style.cssText = 'cursor:pointer;opacity:0.55;';
            view.addEventListener('click', () => showEntryText(pe.entry));
            const spark = document.createElement('i');
            spark.className = 'fa-solid fa-wand-magic-sparkles';
            spark.title = 'Model suggestions — click to (re)roll; checked ✨ chips are kept, unchecked ones replaced';
            spark.style.cssText = 'cursor:pointer;opacity:0.55;';
            const plus = document.createElement('i');
            plus.className = 'fa-solid fa-plus';
            plus.title = 'Add a keyword manually';
            plus.style.cssText = 'cursor:pointer;opacity:0.55;';
            hdr.append(grp, ttl, view, plus, spark);
            if (pe.keyedRows.length) { const k = document.createElement('span'); k.textContent = `· ${pe.keyedRows.length} keyed`; k.style.cssText = 'opacity:0.5;font-size:0.85em;'; hdr.append(k); }
            block.append(hdr);

            const para = document.createElement('div');
            para.style.cssText = 'line-height:2;';
            const shown = new Set();

            // One chip. kind: 'tfidf' | 'llm' | 'manual' are addable (checkbox, committed on "Add
            // checked"); 'keyed' is a live key (green, no checkbox). The pencil edits any chip inline:
            // a suggestion is just relabelled; a keyed chip's rename mutates entry.key and saves now.
            const chip = (term0, kind, { checked = false, df = null } = {}) => {
                let term = term0;
                const keyed = kind === 'keyed';
                const lab = document.createElement('label');
                lab.className = 'wa-chip'; lab.dataset.kind = kind;
                lab.style.cssText = `display:inline-flex;align-items:center;gap:0.25em;margin:0 0.9em 0.2em 0;white-space:nowrap;${keyed ? `color:${GRN};font-size:0.9em;` : 'cursor:pointer;'}`;
                if (df != null) lab.title = `appears in ${df} of ${N} entries`;
                let cb = null;
                if (!keyed) {
                    cb = document.createElement('input');
                    cb.type = 'checkbox'; cb.className = 'wa-row-cb'; cb.dataset.uid = pe.entry.uid; cb.dataset.term = term; cb.checked = checked; cb.style.margin = '0';
                    lab.append(cb);
                }
                const nm = document.createElement('span');
                nm.textContent = (kind === 'llm' ? '✨ ' : '') + term;
                const pen = document.createElement('i');
                pen.className = 'fa-solid fa-pencil'; pen.title = keyed ? 'Rename this key' : 'Edit term';
                pen.style.cssText = 'cursor:pointer;opacity:0.45;font-size:0.8em;margin-left:0.15em;';
                pen.addEventListener('click', ev => {
                    ev.preventDefault();
                    const inp = document.createElement('input');
                    inp.type = 'text'; inp.className = 'text_pole'; inp.value = term; inp.style.cssText = 'width:9em;margin:0;font-size:0.9em;';
                    const ok = document.createElement('i');
                    ok.className = 'fa-solid fa-check'; ok.title = 'Confirm'; ok.style.cssText = 'cursor:pointer;margin-left:0.3em;';
                    const commit = () => {
                        const nv = inp.value.trim();
                        inp.replaceWith(nm); ok.replaceWith(pen);
                        if (!nv) { if (kind === 'manual' && !term) { shown.delete(canon(term)); lab.remove(); } return; }
                        if (nv === term) return;
                        if (keyed) {
                            const arr = Array.isArray(pe.entry.key) ? pe.entry.key : (pe.entry.key = []);
                            const idx = arr.indexOf(term);
                            if (idx >= 0) { if (arr.includes(nv)) arr.splice(idx, 1); else arr[idx] = nv; }
                            pe.existing.delete(canon(term)); pe.existing.add(canon(nv));
                            dirty = true; saveWorldInfo(book, data, true);
                        } else {
                            shown.delete(canon(term)); shown.add(canon(nv)); cb.dataset.term = nv;
                        }
                        term = nv;
                        nm.textContent = (kind === 'llm' ? '✨ ' : '') + term;
                    };
                    ok.addEventListener('click', commit);
                    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
                    nm.replaceWith(inp); pen.replaceWith(ok); inp.focus(); inp.select();
                });
                lab.append(nm, pen);
                if (term) shown.add(canon(term));
                return lab;
            };

            for (const r of pe.newRows) para.append(chip(r.display, 'tfidf', { df: r.df }));
            for (const r of pe.keyedRows) para.append(chip(r.display, 'keyed', { df: r.df }));
            block.append(para);

            plus.addEventListener('click', () => {
                const lab = chip('', 'manual', { checked: true });
                para.append(lab);
                lab.querySelector('.fa-pencil').click();   // drop straight into edit
            });

            // Spark = reroll (unlimited): drop unchecked ✨ chips, keep checked ✨ chips, generate again.
            const runSpark = async () => {
                if (spark.dataset.busy) return;
                spark.dataset.busy = '1'; spark.style.pointerEvents = 'none'; spark.style.opacity = '0.25';
                para.querySelectorAll('.wa-chip[data-kind="llm"]').forEach(lab => {
                    const c = lab.querySelector('.wa-row-cb');
                    if (c && !c.checked) { shown.delete(canon(c.dataset.term)); lab.remove(); }
                });
                let raw = '';
                try { raw = await generateText(buildKeyPrompt(String(pe.entry.content ?? ''), avoid), 400); }
                catch (e) { toastr.warning(`Local model: ${String(e?.message ?? e)}`, 'Worlds Apart'); spark.dataset.busy = ''; spark.style.pointerEvents = ''; spark.style.opacity = '0.55'; return; }
                let added = 0, echoed = false, dupes = 0;
                for (const cand of parseKeyList(raw)) {
                    const { term: t, df, reason } = classifyLlmCand(cand, {
                        canon, exampleCanon, dfSubstr, N, dfCeil, excludeDates,
                        isDupe: (term, c) => shown.has(c) || pe.existing.has(c),
                    });
                    if (reason === 'dupe') { dupes++; continue; }   // already keyed/suggested — not garbage
                    if (reason === 'echo') { echoed = true; continue; }
                    if (reason) continue;
                    para.append(chip(t, 'llm', { df }));
                    added++;
                }
                if (added) toastr.success(`${titleOf(pe.entry)}: +${added} from model`, 'Worlds Apart');
                else toastr.warning(echoed ? 'Model echoed the examples — reroll ✨ to retry.'
                    : dupes ? `Model returned only terms already keyed (${dupes}) — reroll ✨.`
                        : 'Model returned nothing usable — reroll ✨?', 'Worlds Apart');
                spark.dataset.busy = ''; spark.style.pointerEvents = ''; spark.style.opacity = '0.55';
            };
            spark.addEventListener('click', runSpark);
            sparkRunners.push(runSpark);
            list.append(block);
        }
        resWrap.append(list);

        let adds = [];
        const pop = new Popup(resWrap, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Add checked', cancelButton: 'Close', allowVerticalScrolling: true,
            customButtons: [{ text: 'Back', result: POPUP_RESULT.CUSTOM1 }],
            onClosing: pp => {
                if (pp.result === POPUP_RESULT.AFFIRMATIVE) {
                    adds = [...list.querySelectorAll('.wa-row-cb')].filter(cb => cb.checked && cb.dataset.term.trim()).map(cb => ({ uid: cb.dataset.uid, term: cb.dataset.term.trim() }));
                }
                return true;
            },
        });
        // Size the dialog itself to ~75% of the chat column (not a full-width box with 75% content).
        pop.dlg.style.setProperty('width', 'calc(var(--sheldWidth, 90vw) * 0.75)', 'important');
        pop.dlg.style.setProperty('max-width', 'calc(100dvw - 2em)', 'important');
        const res = await pop.show();
        if (res === POPUP_RESULT.CUSTOM1) { if (dirty) reloadEditor(book); continue; }   // Back to options
        if (!adds.length) { if (dirty) reloadEditor(book); return ''; }

        const byUid = new Map();
        for (const a of adds) { if (!byUid.has(a.uid)) byUid.set(a.uid, []); byUid.get(a.uid).push(a.term); }
        let added = 0, touched = 0;
        for (const [uid, terms] of byUid) {
            const ent = data.entries[uid] ?? data.entries[String(uid)] ?? entries.find(e => String(e.uid) === String(uid));
            if (!ent) continue;
            if (!Array.isArray(ent.key)) ent.key = [];
            let n = 0;
            for (const term of terms) { if (ent.key.some(k => String(k).toLowerCase().trim() === term.toLowerCase())) continue; ent.key.push(term); n++; }
            if (n) { added += n; touched++; }
        }
        if (added) {
            await saveWorldInfo(book, data, true);
            reloadEditor(book);
            toastr.success(`"${book}": added ${added} key(s) across ${touched} entr${touched === 1 ? 'y' : 'ies'}.`, 'Worlds Apart');
        } else if (dirty) { reloadEditor(book); }   // rename-only session still needs the editor refreshed
        return '';
    }
}

// Studio scans every entry (all modes, active + inactive) so every entry's keywords get a verdict;
// suggestions use the pruner's own dfCeil so a suggested key can't be one the pruner would then flag.
export const STUDIO_PRUNE_OPTS = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneDead: true, pruneCommon: true, pruneShort: true, pruneShared: true, ignoreProper: false, stickySkipCommon: true, tooCommon: KEY_TOO_COMMON, minLength: KEY_MIN_LENGTH, sharedKeys: KEY_SHARED };
export const STUDIO_SUGGEST_OPTS = { dfCeil: 0.15, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: false, cap: 8, llmChunk: 5000 };
