// capture-ui.mjs — the capture commands: /wa-grade, /wa-super-grade, /wa-super-eval and /wa-versus. The popups
// around grading.mjs; drives the pipeline through `host` and is called back by nothing in it.

import { getContext, extension_settings } from '../../../../extensions.js';
import { loadWorldInfo, world_info_budget, world_info_budget_cap, world_info_case_sensitive, world_info_depth, world_info_include_names, world_info_match_whole_words, world_info_max_recursion_steps, world_info_recursive } from '../../../../world-info.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { escapeHtml, getCharaFilename, getStringHash, download, uuidv4 } from '../../../../utils.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { t, translate } from '../../../../i18n.js';
import { runState, settings } from './state.mjs';
import * as matcher from './matcher.mjs';
import { entryFoldHtml, keyHitsHtml, showEntryText, wiGlyph } from './ui-widgets.mjs';
import { entryKey } from './content-lexical.mjs';
import { gradeOrder } from './sort.mjs';
import { GRADE_ANCHORS, GRADE_SCALE, armNames, buildSample, bundleSamples, captureParams, gradeValue, isDurable, keyByUid, mergeGrades, openBundle, rowKey, sampleFile, sceneDiff, searchedBook, splitGraded, toCandidate, unionArms } from './grading.mjs';

/** The pipeline entry points the capture flows drive, injected once at registration.
 * @typedef {{chatBook: Function, coreSelection: Function, dryRun: Function, effectiveTokenBudget: Function, paramSnapshot: Function, scopedPriority: Function, vectorRequestBody: Function}} CaptureHost */
let host = null;

/** Wires the pipeline entry points. Called once from worldsapart.js init, before any command runs. */
export function setCaptureHost(h) { host = h; }

/** The grading scale in one caption line, shared by both grading popups. */
const gradeAnchorLine = () => { const scale = GRADE_ANCHORS.map((a, g) => `${g} = ${translate(a).split(';')[0].toLowerCase()}`).join(' · '); return t`Grade 0–4: ${scale}.`; };

/** HTML-escaping for the grading tables, with null/undefined rendering blank rather than "undefined". */
const esc = s => escapeHtml(String(s ?? ''));
/** A grading table's number cell: a missing value is a dot, never "null". */
const num = n => (n == null ? '·' : String(n));
/** The scissors tooltip on a row the budget cut: one whole sentence per case, so a translation can reorder it. */
const cutTip = ({ cutBy, tokens }) => {
    if (cutBy && tokens) return t`Cut by the budget: the ${cutBy} cap, at ${tokens} tokens.`;
    if (cutBy) return t`Cut by the budget: the ${cutBy} cap.`;
    if (tokens) return t`Cut by the budget, at ${tokens} tokens.`;
    return t`Cut by the budget.`;
};

/** ST's match flags for captureParams. A function, not an object: the imports are live bindings. */
const stParams = () => ({
    caseSensitive: world_info_case_sensitive,
    wholeWords: world_info_match_whole_words,
    includeNames: world_info_include_names,
    allowWIScan: Boolean(extension_settings.note?.allowWIScan),
    recursive: world_info_recursive,
    maxRecursionSteps: world_info_max_recursion_steps,
});

/** The message span this capture covers, as chat file record indices (+1 for the jsonl header); read off the query window, since `last - depth` differs when the span holds an empty or hidden message. */
function sceneRange() {
    const win = runState.lastQueryChat ?? [];
    if (!win.length) {
        const last = Math.max(0, (getContext().chat?.length ?? 1) - 1) + 1;
        return { start: last, end: last };
    }
    return { start: win[0].i + 1, end: win[win.length - 1].i + 1 };
}

/** WA's declared version, out of its own manifest; empty when unreadable, cached for the page. */
let waVersionCache = null;

export async function waVersion() {
    if (waVersionCache !== null) return waVersionCache;
    try {
        const r = await fetch(new URL('../manifest.json', import.meta.url));
        waVersionCache = r.ok ? String((await r.json())?.version ?? '') : '';
    } catch { waVersionCache = ''; }
    return waVersionCache;
}

/** WA's checkout as ST reports it: `<branch>@<short sha> on disk`, and whether origin has more. '' when unreadable. */
let identityCache = null;

export async function extensionIdentity() {
    if (identityCache !== null) return identityCache;
    identityCache = '';
    try {
        // The extension's own folder name, decoded: a pathname is percent-encoded and a folder name is not.
        const path = decodeURIComponent(new URL('..', import.meta.url).pathname);
        const dir = path.replace(/\/$/, '').split('/').pop();
        const r = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            // Global extensions are served from public/scripts/extensions/third-party; a per-user install is not.
            body: JSON.stringify({ extensionName: dir, global: path.includes('/scripts/extensions/third-party/') }),
        });
        const d = r.ok ? await r.json() : null;
        if (d?.currentCommitHash) {
            // `isUpToDate` is also true when the checkout has no remotes, so it means "no update found".
            identityCache = `${d.currentBranchName || '?'}@${String(d.currentCommitHash).slice(0, 7)} on disk`
                + (d.isUpToDate ? '' : ` \u2014 behind origin/${d.currentBranchName}`);
        }
    } catch { /* offline, or not a git checkout: identity unknown is normal */ }
    return identityCache;
}

/** ST's resolved version, `<branch>@<commit>` from /version; empty when unreadable, cached for the page. */
let stVersionCache = null;

async function stVersion() {
    if (stVersionCache !== null) return stVersionCache;
    try {
        const r = await fetch('/version', { headers: getRequestHeaders() });
        const d = r.ok ? await r.json() : null;
        stVersionCache = d?.gitBranch && d?.gitRevision ? `${d.gitBranch}@${d.gitRevision}` : '';
    } catch { stVersionCache = ''; }
    return stVersionCache;
}

/** When a verdict was passed, to the second: a day cannot separate two passes over the same rows. */
const today = () => new Date().toISOString();

/** Who a typed grade is signed as: a UUIDv4 minted on first use (state.mjs `raterId`). ST's uuidv4, since crypto.randomUUID is secure-context only. */
function raterId() {
    const s = settings();
    if (!String(s.raterId ?? '').trim()) {
        s.raterId = uuidv4();
        saveSettingsDebounced();
    }
    return s.raterId;
}

/** Best-effort relative path of the current chat file; the user handle is assumed `default-user`. */
function chatFilePath() {
    const ctx = getContext();
    if (!ctx.chatId) {
        return '';
    }
    return ctx.groupId
        ? `data/default-user/groupchats/${ctx.chatId}.jsonl`
        : `data/default-user/chats/${getCharaFilename(ctx.characterId)}/${ctx.chatId}.jsonl`;
}

/** Best-effort relative path of a book's vector index; the collectionId hash is exact (syncWorld's), the user handle assumed. */
function vectorIndexPath(world) {
    const body = host.vectorRequestBody();
    return `data/default-user/vectors/${body.source}/wa_${getStringHash(world)}/${body.model || 'default'}/index.json`;
}

/** Every attached book keyed by uid, embedded whole into a sample. */
async function loadBooks() {
    const books = {};
    for (const world of runState.attachedWorlds) {
        const data = await loadWorldInfo(world);
        if (data?.entries) books[world] = keyByUid(data.entries);
    }
    return books;
}

/** Resolves an entry out of an embedded book map — how the grading tables find text for a row. */
const entryResolver = books => (world, uid) => books[world]?.[uid];   // keyByUid keys by uid, and a property read coerces a numeric one

/**
 * The provenance stamps every capture writes; `primaryBook` comes off the ranking per arm, the chat's bound book as the keyword-only fallback.
 * @param {object} books loadBooks() output, passed in so /wa-super-grade stamps N arms off one load
 */
async function sceneCommon(rows, books) {
    const primaryBook = searchedBook(rows) ?? host.chatBook() ?? Object.keys(books)[0] ?? '';
    return {
        pluginFP: runState.pluginFP,
        sourceFP: runState.sourceFP,
        waVersion: await waVersion(),
        stVersion: await stVersion(),
        chat: chatFilePath(),
        book: primaryBook ? `data/default-user/worlds/${primaryBook}.json` : '',
        index: primaryBook ? vectorIndexPath(primaryBook) : '',
        primaryBook,
        embedModel: host.vectorRequestBody().model || '',
        books,
        priority: (host.scopedPriority() ?? []).map(x => x.cfg),
    };
}

export async function versusCore(named) {
    // Runs the pipeline itself so the frozen rows are the selection that actually happened; `candidates` bounds the captured population.
    const wanted = Math.max(1, Number(named?.candidates ?? 30));
    runState.gradeCutoff = { maxVectorEntries: wanted };
    try {
        await host.dryRun(true);
    } finally {
        runState.gradeCutoff = null;
    }

    const population = runState.lastLayoutOrder;
    if (!runState.lastCandidates?.length || !population?.length) { toastr.info(t`Nothing ranked — the scan activated no entries.`, 'Worlds Apart'); return; }

    const { entries: coreEntries, viaVectors, vectorsRan } = await host.coreSelection();

    const coreKeys = new Set(coreEntries.map(entryKey));
    const waKeys = new Set((runState.lastPromptOrder ?? []).map(x => entryKey(x.item.entry)));
    const byKey = new Map(population.map(x => [entryKey(x.entry), x]));
    for (const e of coreEntries) if (!byKey.has(entryKey(e))) byKey.set(entryKey(e), { entry: e });

    const tokens = await Promise.all([...byKey.values()].map(x => getTokenCountAsync(x.entry.content ?? '')));
    [...byKey.values()].forEach((x, i) => { x.tokens = tokens[i]; });

    const union = [...byKey.entries()].filter(([k]) => coreKeys.has(k) || waKeys.has(k))
        .sort((a, b) => (b[1].eCredit ?? -1) - (a[1].eCredit ?? -1));
    const row = ([k, x]) => ({
        uid: x.entry.uid, entry: String(x.entry.comment || x.entry.key?.[0] || `uid ${x.entry.uid}`).slice(0, 44),
        book: x.entry.world,
        in: coreKeys.has(k) && waKeys.has(k) ? 'both' : coreKeys.has(k) ? 'core' : 'WA',
        tokens: x.tokens, order: x.entry.waOriginalOrder ?? x.entry.order ?? 0,
        eCredit: Number.isFinite(x.eCredit) ? Number(x.eCredit.toFixed(4)) : null,
        cosine: Number.isFinite(x.score) ? Number(x.score.toFixed(4)) : null,
        text: Number.isFinite(x.textScore) ? Number(x.textScore.toFixed(3)) : null,
        keys: Number(x.keywordScore) ? Number(x.keywordScore.toFixed(2)) : null,
        properNouns: Number.isFinite(x.properNouns) ? Number(x.properNouns.toFixed(3)) : null,
        density: Number.isFinite(x.density) ? Number(x.density.toFixed(2)) : null,
    });
    const spend = keys => [...byKey.entries()].filter(([k]) => keys.has(k)).reduce((sum, [, x]) => sum + (x.tokens || 0), 0);
    const both = [...coreKeys].filter(k => waKeys.has(k)).length;

    console.log(`%cWorlds Apart \u00b7 WA vs ST core, message ${(getContext().chat ?? []).length}`, 'font-weight: bold');
    console.log(`  core: ${coreKeys.size} entries, ${spend(coreKeys)} tokens (its own budget: world_info_budget ${world_info_budget}%${Number(world_info_budget_cap) > 0 ? `, cap ${world_info_budget_cap}` : ''})`);
    console.log(`  WA:   ${waKeys.size} entries, ${spend(waKeys)} tokens (budget ${host.effectiveTokenBudget()})`);
    console.log(`  shared ${both}, core only ${coreKeys.size - both}, WA only ${waKeys.size - both}`);

    const spanOf = keys => { const o = [...byKey.entries()].filter(([k]) => keys.has(k)).map(([, x]) => x.entry.waOriginalOrder ?? x.entry.order ?? 0); return o.length ? [Math.min(...o), Math.max(...o)] : null; };
    const waOnlySpan = spanOf(new Set([...waKeys].filter(k => !coreKeys.has(k))));
    const coreOnlySpan = spanOf(new Set([...coreKeys].filter(k => !waKeys.has(k))));
    if (waOnlySpan && coreOnlySpan) {
        console.log(`  order: core-only ${coreOnlySpan[0]}-${coreOnlySpan[1]}, WA-only ${waOnlySpan[0]}-${waOnlySpan[1]}`
            + (coreOnlySpan[0] > waOnlySpan[1] ? ' — disjoint, so core’s cut was its descending-order walk running out of budget, not a verdict on the scene' : ''));
    }
    console.table(union.map(row));
    console.log(`  Vector Storage's WI route is ${viaVectors ? 'ON' : 'OFF'}${viaVectors ? (vectorsRan ? ' and was invoked for this comparison' : ' but did not run \u2014 core answered on keywords alone') : ' \u2014 core is its keyword route'}.`);
    console.log('%cgradeable union \u2014 right-click \u2192 Copy object', 'font-weight: bold');
    console.log({
        at: (getContext().chat ?? []).length,
        waBudget: host.effectiveTokenBudget(), coreBudgetPercent: Number(world_info_budget) || 25,
        vectorRouteEnabled: Boolean(viaVectors),
        query: runState.lastQuery,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        sources: runState.lastSources,
        depth: settings().messageDepth,
        matchWindow: settings().matchWindow,
        includeNames: world_info_include_names,
        rows: union.map(([k, x]) => ({ ...row([k, x]), core: coreKeys.has(k), wa: waKeys.has(k), content: x.entry.content })),
    });
    await versusBundle(union, coreKeys, waKeys, viaVectors);
    toastr.success(t`core ${coreKeys.size} / WA ${waKeys.size}, ${coreKeys.size - both} core-only — see console`, t`WA vs core`);
}

/**
 * Writes the comparison as an ordinary two-arm bundle: each arm's `candidates` are the population it ranked, delivered is `!cut`.
 * @param {Array<[string, object]>} union Rows keyed `world.uid`
 * Core's arm carries only its delivered set, every row uncut: checkWorldInfo returns what survived its budget walk.
 */
async function versusBundle(union, coreKeys, waKeys, viaVectors) {
    const books = await loadBooks();

    const waRows = runState.lastCandidates;

    // Core's rows reuse WA's where both ranked the entry; a row only core activated has no signals, and unionArms fills an absent one.
    const byKey = new Map(waRows.map(r => [rowKey(r), r]));
    const coreRows = [...union].filter(([k]) => coreKeys.has(k)).map(([, x], i) => {
        const key = rowKey({ book: x.entry.world, uid: x.entry.uid });
        const base = byKey.get(key);
        return {
            ...(base ?? {
                book: x.entry.world,
                uid: x.entry.uid,
                title: x.entry.comment || x.entry.key?.[0] || `uid ${x.entry.uid}`,
                block: x.entry.constant ? 'constant' : 'dynamic',
                tokens: x.tokens,
            }),
            index: i,
            cut: false,
            cutBy: null,
        };
    });

    const common = {
        query: runState.lastQuery,
        queryChat: runState.lastQueryChat,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        sources: matcher.usedMatchSources(runState.lastSources, Object.values(books).flatMap(b => Object.values(b))),
        depth: settings().messageDepth,
        ...await sceneCommon(waRows, books),
        snapshot: host.paramSnapshot(),
        grades: [],
        cutoff: { live: { maxVectorEntries: settings().maxVectorEntries } },
        now: new Date().toISOString(),
    };

    const arms = [
        { arm: 'wa', rows: waRows, params: captureParams(settings(), stParams()) },
        { arm: viaVectors ? 'core+vectors' : 'core', rows: coreRows, params: {
            ...captureParams(settings(), stParams()),
            selector: 'st-core',
            coreBudgetPercent: Number(world_info_budget) || 25,
            coreBudgetCap: Number(world_info_budget_cap) || 0,
            coreScanDepth: Number(world_info_depth) || 0,
            vectorRouteEnabled: Boolean(viaVectors),
            vectorQueryDepth: Number(extension_settings.vectors?.query) || 0,
            vectorMaxEntries: Number(extension_settings.vectors?.max_entries) || 0,
            vectorScoreThreshold: Number(extension_settings.vectors?.score_threshold) || 0,
        } },
    ].map(({ arm, rows, params }) => ({ arm, sample: buildSample({
        ...common,
        params,
        name: `${defaultSampleName()}-versus`,
        notes: `WA against ST core on one turn. Each arm's candidates are the population it ranked; delivered is !cut. Core's vector route was ${viaVectors ? 'ON' : 'OFF'}.`,
        candidates: rows,
        gradedCandidates: rows.filter(r => !isDurable(r)).length,
    }) }));

    const bundle = await bundleSamples(arms, { ...sceneRange(), user: raterId(), captureId: uuidv4() });
    const { filename, content } = sampleFile(bundle);
    download(content, filename, 'application/json');
    toastr.info(t`Saved ${filename} — open it with Review bundles to grade these ${union.length} rows.`, 'Worlds Apart', { timeOut: 8000 });
}

/** Default sample name: chat slug + the message the scene ends on — distinct across scenes, stable on a re-grade. */
function defaultSampleName() {
    const ctx = getContext();
    const chat = String(ctx.chatId ?? getCharaFilename(ctx.characterId) ?? 'scene');
    const slug = chat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return `${slug || 'scene'}-msg${Math.max(0, (ctx.chat?.length ?? 1) - 1)}`;
}


/** Wires a grading table's fold chevrons and popouts; `entryAt` resolves a row's capture index to its entry. Re-queries nodes, since /wa-super-grade repaints its table. */
function wireFolds(root, entryAt) {
    root.querySelectorAll('.wa-fold').forEach(chevron => chevron.addEventListener('click', event => {
        event.preventDefault();
        const fold = root.querySelector(`.wa-foldrow[data-i="${chevron.dataset.i}"]`);
        if (!fold) return;
        const open = fold.style.display === 'none';
        fold.style.display = open ? '' : 'none';
        chevron.classList.toggle('wa-open', open);
    }));
    root.querySelectorAll('.wa-fold-pop').forEach(pop => pop.addEventListener('click', event => {
        event.preventDefault();
        const entry = entryAt(Number(pop.dataset.i));
        if (entry) showEntryText(entry);
    }));
}

/** Fills every blank grade field with 0 (ordinary grades, no new semantics; blank still means ungraded).
 * Undo re-queries the DOM by `data-key`/`data-i`, since a repaint detaches every input. */
/** The entry column of a grading row: the budget's scissors, the entry glyph, its title and book/uid, the key hits, and
 *  the chevron that opens the fold. Shared by both grading tables, which differ only in the signal columns beside it. */
const entryCellHtml = (row, entry, i) => `<td>${row.cut ? `<i class="fa-solid fa-scissors" style="opacity:0.55;margin-right:0.35em;" title="${esc(cutTip(row))}"></i>` : ''}`
    + `${entry ? wiGlyph(entry) + ' ' : ''}${esc(row.title)}<br><small style="opacity:0.5;">${esc(row.book)} · ${esc(t`uid ${num(row.uid)}`)}</small>`
    + `${keyHitsHtml(row.why)}<br><i class="fa-solid fa-chevron-right wa-chevron wa-fold" data-i="${i}" title="${esc(t`Show keys and entry text`)}" style="margin-top:0.35em;"></i></td>`;

/** The grading popups' "Fill blanks with 0" button over `root`. No `result`, so it acts on the form and leaves the popup open. */
const fillZerosButton = root => ({
    text: t`Fill blanks with 0`, icon: 'fa-0',
    tooltip: t`Every untouched row becomes a graded 0. Leave a row blank to record it as UNGRADED instead.`,
    action: () => {
        const { filled, undo } = fillReadZeros(root);
        if (!filled) { toastr.info(t`No blank rows to fill.`, 'Worlds Apart'); return; }
        toastr.success(t`Filled ${filled} blank row(s) with 0. Click to undo.`, 'Worlds Apart', {
            timeOut: 10000, extendedTimeOut: 10000,
            onclick: () => { const n = undo(); toastr.info(t`Reverted ${n} row(s) to ungraded.`, 'Worlds Apart'); },
        });
    },
});

function fillReadZeros(root) {
    const idOf = input => input.dataset.key ?? input.dataset.i;
    const touched = new Set();
    for (const input of root.querySelectorAll('.wa-grade')) {
        if (String(input.value).trim() === '') {
            input.value = '0';
            input.dataset.dirty = '1';
            touched.add(idOf(input));
        }
    }
    const undo = () => {
        let reverted = 0;
        for (const input of root.querySelectorAll('.wa-grade')) {
            // Only a row still holding the 0 this put there; a value edited since is the author's.
            if (touched.has(idOf(input)) && String(input.value).trim() === '0') {
                input.value = '';
                delete input.dataset.dirty;
                reverted += 1;
            }
        }
        touched.clear();
        return reverted;
    };
    return { filled: touched.size, undo };
}

/**
 * /wa-grade: runs the real pipeline, grades the rows it produced, writes a bundle. Durable rows are listed, not gradeable.
 * @param {object} named Named args: name, candidates, notes
 */
export async function gradeScene(named) {

    // A grading budget only: nothing cuts the population for relevance at either stage.
    const live = { maxVectorEntries: settings().maxVectorEntries };
    const wanted = Math.max(1, Number(named?.candidates ?? 20));
    runState.gradeCutoff = { maxVectorEntries: wanted };

    let rows = [];
    let entries = [];
    try {
        await host.dryRun(true);
        rows = runState.lastCandidates ?? [];
        entries = runState.lastCandidateEntries ?? [];
    } finally {
        runState.gradeCutoff = null;
    }

    if (!rows.length) {
        toastr.warning(t`Nothing was activated — nothing to grade.`, 'Worlds Apart');
        return '';
    }

    // An empty lastQuery means no query text could be built at all; keyword-only scenes pass, their query frozen.
    if (!runState.lastQuery) {
        toastr.warning(t`No query text could be built from this chat — the sample would have nothing to score offline.`, 'Worlds Apart');
        return '';
    }


    // Not-durable rather than is-dynamic: a promoted row is graded, since the exemption is what the grade measures.
    const gradeable = rows.map((row, i) => ({ row, entry: entries[i], i })).filter(x => !isDurable(x.row));
    const scaffold = rows.length - gradeable.length;

    const wrap = document.createElement('div');
    const counts = [t`${gradeable.length} retrieved entries`];
    if (scaffold) counts.push(t`${scaffold} constant or sticky row(s) listed, not graded`);
    wrap.innerHTML = `<h3 style="margin:0 0 0.25em;">${esc(t`Grade this scene`)}</h3>`
        + `<small style="display:block;opacity:0.7;margin-bottom:0.5em;">${esc(gradeAnchorLine())} ${esc(counts.join('; '))}. ${esc(t`Blank means ungraded, not 0.`)}</small>`
        + `<details style="margin-bottom:0.75em;"><summary style="cursor:pointer;">${esc(t`Query text — what retrieval actually matched on`)} `
        + `${esc(t`(${runState.lastQuery.length} chars, depth ${settings().messageDepth})`)}</summary>`
        + `<pre style="white-space:pre-wrap;max-height:14em;overflow:auto;font-size:0.85em;opacity:0.85;border:1px solid var(--SmartThemeBorderColor);padding:0.5em;margin-top:0.5em;">${esc(runState.lastQuery)}</pre></details>`
        + '<table style="width:100%;border-collapse:collapse;font-size:0.9em;text-align:left;"><thead><tr style="text-align:left;">'
        + `<th style="width:4em;">${esc(t`Grade`)}</th><th>${esc(t`Entry`)}</th><th style="width:4em;">${esc(t`fused`)}</th><th style="width:4em;">${esc(t`cos`)}</th><th style="width:4em;">${esc(t`text`)}</th><th style="width:4em;">${esc(t`keys`)}</th></tr></thead><tbody>`
        // Block + score order (gradeOrder); `i` stays the capture index, which every data-i indexes.
        + gradeOrder(rows, r => -(r.score ?? -Infinity)).map(({ row, i }) => {
            const scaff = isDurable(row);
            const cell = scaff
                ? `<span style="opacity:0.5;font-size:0.85em;">${esc(row.block === 'constant' ? t`const` : t`sticky`)}</span>`
                : `<input type="number" class="wa-grade text_pole" data-i="${i}" min="0" max="4" step="1" placeholder="—" title="${esc(GRADE_ANCHORS.map((a, g) => `${g}: ${a}`).join('\n'))}" style="width:4em;padding:2px 4px;">`;
            return `<tr style="border-top:1px solid var(--SmartThemeBorderColor);${scaff ? 'opacity:0.6;' : ''}">`
                + `<td>${cell}</td>`
                // wiGlyph, never a local mapping.
                + entryCellHtml(row, entries[i], i)
                + `<td>${num(row.score)}</td><td>${num(row.cosine)}</td><td>${num(row.text)}</td><td>${num(row.keys)}</td>`
                + `</tr>`
                + `<tr class="wa-foldrow" data-i="${i}" style="display:none;"><td colspan="6" style="padding:0.5em 0.75em 0.9em;">${entryFoldHtml(entries[i], i)}</td></tr>`;
        }).join('')
        + '</tbody></table>';

    wireFolds(wrap, i => entries[i]);

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { customButtons: [fillZerosButton(wrap)], okButton: t`Save sample`, cancelButton: t`Cancel`, large: true, wide: true, allowVerticalScrolling: true });
    const result = await popup.show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return '';
    }

    // Blank rows are omitted: an untouched field is not a grade; a typed 0 is.
    const grades = [...wrap.querySelectorAll('.wa-grade')]
        .filter(input => String(input.value).trim() !== '')
        .map(input => {
            const row = rows[Number(input.dataset.i)];
            return { title: row.title, grade: Number(input.value), book: row.book, uid: row.uid };
        });

    const books = await loadBooks();
    const sample = buildSample({
        name: named?.name || defaultSampleName(),
        notes: named?.notes,
        query: runState.lastQuery,
        queryChat: runState.lastQueryChat,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        sources: matcher.usedMatchSources(runState.lastSources, Object.values(books).flatMap(b => Object.values(b))),
        depth: settings().messageDepth,
        ...await sceneCommon(rows, books),
        params: captureParams(settings(), stParams()),
        snapshot: host.paramSnapshot(),
        candidates: rows,
        grades,
        // The grading depth: what the grader was shown, not a relevance cutoff (bundle-schema.md).
        cutoff: {
            live,   // the configuration being assessed
            gradingOverride: { maxVectorEntries: wanted },   // how many rows the grader was shown
        },
        gradedCandidates: gradeable.length,
        now: new Date().toISOString(),
    });

    const bundle = await bundleSamples([{ arm: 'shipped', sample }], { ...sceneRange(), user: raterId(), captureId: uuidv4() });
    const { filename, content } = sampleFile(bundle);
    download(content, filename, 'application/json');
    const graded = grades.filter(g => gradeValue(g) > 0).length;
    toastr.success(t`Saved ${filename} — ${graded} of ${grades.length} graded above 0. Move it to eval/eval-data/ and run graded-scene-grid.mjs --sample`, 'Worlds Apart', { timeOut: 8000 });
    console.log(`Worlds Apart: sample "${sample.name}" — ${grades.length} graded rows, ${Object.keys(books).length} book(s) embedded`, sample);

    return '';
}

/**
 * The arms /wa-super-grade captures.
 *   no-filter   entityFilter off, which moves the term weights content-lexical scores with and so the layout order.
 * An arm earns its place only by being unable to compute its population offline; everything re-derivable from the frozen query and books stays out.
 * Arm count is not a design constant: add one whenever graded-scene-grid.mjs reports a configuration whose top rows are not fully judged.
 */
export const POOL_ARMS = {
    shipped: {},
    'no-filter': { entityFilter: false },
};

/**
 * Runs one debug capture under temporarily-overridden settings: assign-and-restore on the live settings object, which every module reads at call time.
 * @param {number} wanted Candidate depth
 * captureParams and paramSnapshot must be read inside the window. ponytail: the override is live across awaits, so a generation firing mid-capture would use the arm's settings.
 */
async function captureArm(overrides, wanted) {
    const s = settings();
    const saved = {};
    for (const k of Object.keys(overrides)) saved[k] = s[k];
    Object.assign(s, overrides);
    runState.gradeCutoff = { maxVectorEntries: wanted };

    try {
        await host.dryRun(true);
        return {
            rows: runState.lastCandidates ?? [],
            entries: runState.lastCandidateEntries ?? [],
            query: runState.lastQuery,
            queryChat: runState.lastQueryChat,
            scanChat: runState.lastScanChat,
            injects: runState.lastInjects,
            sources: runState.lastSources,
            depth: s.messageDepth,
            params: captureParams(s, stParams()),
            snapshot: host.paramSnapshot(),
            live: { maxVectorEntries: s.maxVectorEntries },   // this arm's own cap, which the grading depth overrode
        };
    } finally {
        Object.assign(s, saved);
        runState.gradeCutoff = null;
    }
}

/**
 * The super-grade shell shared by /wa-super-grade (live captures) and /wa-super-eval (files): query blocks, prior loading, the editable union table, merged grades.
 * @param {Array<{arm: string, rows: object[], entries: object[], query: string, depth?: number|string}>} args.captures
 * @param {{rows: object[], entries: object[]}} args.union unionArms() output
 * @param {object[]} [args.sections] /wa-super-eval's N bundles, one section each; absent means one scene
 * @returns {Promise<{grades: object[]}|{sections: object[], edited: number}|null>} null on cancel
 */
async function superGradePopup({ captures, union, entryOf, subtitle = '', okButton = t`Save samples`, sections = null }) {
    let prior = [];   // grades from earlier rounds, loaded by the file picker

    // `data-i` indexes `flat` across sections, not a section's own rows: the same entry appears against several scenes (G10); section membership rides on the row.
    const secs = sections ?? [{ captures, union, entryOf, prior }];
    const multi = Boolean(sections);
    let flat = [], flatIndex = new Map();
    // Rebuilt on every paint: the prior-file picker pushes rows into `union.rows`, and a frozen index resolves those to
    // undefined, so the repaint threw inside the template and left the table showing its pre-load contents.
    const rebuildFlat = () => {
        flat = [];
        for (let s = 0; s < secs.length; s++) {
            const u = secs[s].union;
            for (let i = 0; i < u.rows.length; i++) flat.push({ sec: s, row: u.rows[i], entry: u.entries[i] });
        }
        flatIndex = new Map(flat.map((f, i) => [`${f.sec}:${f.row.book}:${f.row.uid}`, i]));
    };
    rebuildFlat();

    /** The scene-text popouts in one container; `head` is written once, so binding it per paint stacked a popup per load. */
    const wireScenePops = root => root.querySelectorAll('.wa-scene-pop').forEach(pop => pop.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();          // inside a <summary>, or the click also toggles the fold
        const hit = sceneText[Number(pop.dataset.i)];
        if (hit) showEntryText({ content: hit.text, comment: hit.label });
    }));

    const wrap = document.createElement('div');
    const head = document.createElement('div');
    const body = document.createElement('div');
    wrap.append(head, body);

    // Query blocks per distinct text, since the arms do not share a query; `sceneText` is indexed by the popout handler and never cleared, because head and body are written at different times.
    const sceneText = [];
    const sceneRef = (text, label) => {
        const hit = sceneText.findIndex(x => x.text === text);
        return hit >= 0 ? hit : sceneText.push({ text, label }) - 1;
    };
    const queryBlocksFor = sc => {
        const caps = sc.captures ?? [];
        const byQ = new Map();
        for (const cap of caps) {
            if (!cap.query) continue;
            const hit = byQ.get(cap.query) ?? [];
            hit.push(cap.arm);
            byQ.set(cap.query, hit);
        }
        return [...byQ.entries()].map(([text, arms]) => {
            const label = byQ.size === 1 ? t`Query text — what retrieval actually matched on` : t`Query text (${arms.join(', ')})`;
            const si = sceneRef(text, sc.name ?? sc.file ?? t`Scene text`);
            return `<details style="margin-bottom:0.4em;"><summary style="cursor:pointer;">${esc(label)} `
                + `${esc(t`(${text.length} chars, depth ${caps[0]?.depth ?? '?'})`)} `
                + `<i class="fa-solid fa-up-right-and-down-left-from-center wa-scene-pop" data-i="${si}" title="${esc(t`Open the whole scene text`)}" style="opacity:0.55;margin-left:0.35em;cursor:pointer;"></i></summary>`
                + `<pre style="white-space:pre-wrap;max-height:32em;overflow:auto;font-size:0.85em;opacity:0.85;border:1px solid var(--SmartThemeBorderColor);padding:0.5em;margin-top:0.5em;">${esc(text)}</pre></details>`;
        }).join('')
            + (byQ.size > 1 ? `<small style="display:block;opacity:0.6;margin-bottom:0.5em;">${esc(t`${byQ.size} arms retrieved against different text. Grade relevance to the scene, not to any one query.`)}</small>` : '');
    };
    const queryBlocks = multi ? '' : queryBlocksFor(secs[0]);

    const armList = captures.map(c => c.arm).join(', ');
    head.innerHTML = `<h3 style="margin:0 0 0.25em;">${esc(multi ? t`Grade ${secs.length} scenes` : t`Grade this scene`)}</h3>`
        + `${subtitle ? `<small style="display:block;opacity:0.7;margin-bottom:0.25em;">${esc(subtitle)}</small>` : ''}`
        + `<small style="display:block;opacity:0.7;margin-bottom:0.5em;">${esc(gradeAnchorLine())} ${esc(multi
            ? t`${flat.length} rows across ${secs.length} scenes; each section shows its own query text.`
            : t`${union.rows.length} distinct entries from ${captures.length} arm(s): ${armList}.`)}</small>`
        + queryBlocks
        + (multi ? '' : '<div style="margin:0.6em 0;display:flex;align-items:center;gap:0.6em;flex-wrap:wrap;">'
        + `<div class="menu_button wa-sg-pick" style="width:auto;padding:0.3em 0.8em;">${esc(t`Load earlier samples / pool requests…`)}</div>`
        + `<small class="wa-sg-loaded" style="opacity:0.7;">${esc(t`nothing loaded`)}</small>`
        + '<input type="file" class="wa-sg-prior" accept=".json,application/json" multiple style="display:none;">'
        + '</div>'
        + `<small style="display:block;opacity:0.6;margin-bottom:0.5em;">${esc(t`Grades in loaded samples are skipped; pool requests add entries.`)}</small>`);

    wireScenePops(head);   // once: head.innerHTML is written above and never rebuilt

    // Repaint, not patch: priors change which rows are gradeable. Only dirty inputs carry across, or pristine "0"s would shadow the priors.
    const paint = () => {
        rebuildFlat();   // before anything reads flatIndex: a loaded pool request adds rows
        const typed = new Map([...body.querySelectorAll('.wa-grade')].filter(i => i.dataset.dirty).map(i => [i.dataset.key, i.value]));
        // Per section: a shared pool would pre-fill a row from another scene's verdict for the same entry.
        const split = secs.map((sc, si) => splitGraded(sc.union.rows, si === 0 && !multi ? prior : (sc.prior ?? [])));
        const freshN = split.reduce((a, x) => a + x.fresh.filter(r => !isDurable(r)).length, 0);
        const known = split.flatMap(x => x.known);
        const scaffoldN = secs.reduce((a, sc) => a + sc.union.rows.filter(r => isDurable(r)).length, 0);

        const counts = [t`${freshN} to grade`];
        if (known.length) counts.push(t`${known.length} judged in an earlier round (pre-filled — edit any you disagree with, untouched rows carry through as shown)`);
        if (scaffoldN) counts.push(t`${scaffoldN} constant/persisting-sticky row(s) listed but not graded — WA did not choose them this turn`);
        body.innerHTML = `<small style="display:block;opacity:0.7;margin-bottom:0.5em;">${esc(counts.join('; '))}. ${esc(t`Blank means UNGRADED, not 0.`)}</small>`
            + '<table style="width:100%;border-collapse:collapse;font-size:0.9em;text-align:left;"><thead><tr style="text-align:left;">'
            + `<th style="width:4em;">${esc(t`Grade`)}</th><th>${esc(t`Entry`)}</th><th style="width:9em;">${esc(t`surfaced by`)}</th><th style="width:4em;">${esc(t`best#`)}</th><th style="width:4em;">${esc(t`cos`)}</th><th style="width:4em;">${esc(t`text`)}</th><th style="width:4em;">${esc(t`keys`)}</th></tr></thead><tbody>`
            // bestRank is the only cross-arm quantity comparable within a section; not across scenes, hence per section.
            + secs.map((sc, si) => (multi
                ? `<tr><td colspan="7" style="padding:0.9em 0.25em 0.35em;border-top:2px solid var(--SmartThemeBorderColor);">`
                  + `<b>${esc(sc.name ?? sc.file ?? t`scene ${si + 1}`)}</b>`
                  + `<small style="opacity:0.6;"> — ${esc(t`${sc.union.rows.filter(r => !isDurable(r)).length} gradeable, ${split[si].known.length} pre-filled`)}</small>`
                  + queryBlocksFor(sc) + `</td></tr>`
                : '')
            + gradeOrder(sc.union.rows, r => r.bestRank ?? Infinity).map(({ row, i: rowI }) => {
                const i = flatIndex.get(`${si}:${row.book}:${row.uid}`);
                const priorOf = split[si].priorOf;
                // The DOM key is section-qualified; `priorOf` is keyed by plain rowKey within a scene.
                const pkey = rowKey(row);
                const key = `${si}${String.fromCharCode(31)}${pkey}`;
                const done = priorOf.has(pkey);
                // Prior rows are inputs pre-filled with the earlier grade; an edit re-emits the row and mergeGrades is last-wins. A dirty edit stays dirty across repaints.
                const cell = isDurable(row)
                    ? `<span style="opacity:0.5;font-size:0.85em;">${esc(row.block === 'constant' ? t`const` : t`sticky`)}</span>`
                    : `<input type="number" class="wa-grade text_pole" data-key="${esc(key)}" data-i="${i}" min="0" max="4" step="1" ${typed.has(key) ? 'data-dirty="1" ' : ''}value="${esc(typed.get(key) ?? (done ? priorOf.get(pkey) : ''))}" placeholder="—" title="${esc(GRADE_ANCHORS.map((a, g) => `${g}: ${a}`).join('\n'))}" style="width:4em;padding:2px 4px;">`;
                return `<tr style="border-top:1px solid var(--SmartThemeBorderColor);${done ? 'opacity:0.55;' : ''}">`
                    + `<td>${cell}</td>`
                    + entryCellHtml(row, flat[i].entry, i)
                    // The arm that supplied the numbers is underlined; the signal columns are its measurements alone.
                    + `<td><small style="opacity:0.7;">${row.arms.map(a => (a === row.from ? `<u>${esc(a)}</u>` : esc(a))).join(', ')}</small></td>`
                    // A borrowed signal is marked with its arm: absent-filled, never blended (unionArms).
                    + `<td>${num(row.bestRank)}</td>${['cosine', 'text', 'keys'].map(s => `<td>${num(row.scores?.[s])}${row.filled?.[s] ? `<br><small style="opacity:0.5;font-size:0.75em;" title="${esc(t`filled from the ${row.filled[s]} arm`)}">${esc(row.filled[s])}</small>` : ''}</td>`).join('')}`
                    + `</tr>`
                    + `<tr class="wa-foldrow" data-i="${i}" style="display:none;"><td colspan="7" style="padding:0.5em 0.75em 0.9em;">${entryFoldHtml(flat[i].entry, i)}</td></tr>`;
            }).join('')).join('')
            + '</tbody></table>';

        wireFolds(body, i => flat[i].entry);
        wireScenePops(body);   // head is bound once, after its own innerHTML
        body.querySelectorAll('.wa-grade').forEach(input => input.addEventListener('input', () => { input.dataset.dirty = '1'; }));
    };

    // The picker is single-scene only; a multi-scene review's grades arrive in the files.
    head.querySelector('.wa-sg-pick')?.addEventListener('click', () => head.querySelector('.wa-sg-prior').click());
    head.querySelector('.wa-sg-prior')?.addEventListener('change', async event => {
        const loaded = [];
        let added = 0;
        const names = [];
        for (const file of event.target.files ?? []) {
            try {
                const parsed = JSON.parse(await file.text());
                // A previous round's bundle (subtract its grades) or an offline pool request (add its entries), told apart by which array is present.
                if (Array.isArray(parsed?.pending)) {
                    for (const row of parsed.pending) {
                        const key = rowKey(row);
                        if (union.rows.some(r => rowKey(r) === key)) continue;
                        const entry = entryOf(row.book, row.uid);
                        union.rows.push({
                            title: entry?.comment || row.title, book: row.book, uid: row.uid,
                            block: 'dynamic', sticky: 0, score: null, cosine: null, text: null, keys: null,
                            arms: [t`offline: ${(row.doses ?? []).length || '?'} dose(s)`],
                            bestRank: row.bestRank ?? null,
                        });
                        union.entries.push(entry);
                        added++;
                    }
                } else if (Array.isArray(parsed?.scenes)) {
                    // openBundle, not `parsed.grades`: v3 keeps verdicts on the scene's entries.
                    const priorSample = openBundle(parsed);
                    // Scene guard: prior grades pool by rowKey (book + uid), so a bundle from another scene would attach its verdicts to this one (G9). Any arm, since arms can differ in `query`; skipped, not thrown.
                    const off = captures.map(c => sceneDiff(c, priorSample)).sort((x, y) => x.length - y.length)[0] ?? ['query'];
                    if (off.length) {
                        toastr.warning(t`${file.name} was graded against a different scene (${off.join(', ')} differ) — ignored, or its verdicts would be attached to this one`, 'Worlds Apart', { timeOut: 8000 });
                        continue;
                    }
                    loaded.push(...(priorSample.entries ?? []));
                } else {
                    toastr.warning(t`${file.name} has neither graded scenes nor "pending" — ignored`, 'Worlds Apart');
                    continue;
                }
                names.push(file.name);
            } catch {
                toastr.warning(t`Could not parse ${file.name} — ignored`, 'Worlds Apart');
            }
        }
        prior = mergeGrades(prior, loaded, { user: raterId(), now: today() });
        // Whole sentences, and a count whose noun changes is two templates: never an inline "(s)".
        const gradeTxt = prior.length === 1 ? t`1 prior grade.` : t`${prior.length} prior grades.`;
        const priorTxt = added ? `${gradeTxt} ${added === 1 ? t`1 entry requested offline.` : t`${added} entries requested offline.`}` : gradeTxt;
        const loadedTxt = names.length === 1 ? t`1 file: ${priorTxt}` : t`${names.length} files: ${priorTxt}`;
        head.querySelector('.wa-sg-loaded').textContent = names.length ? loadedTxt : t`no usable files — nothing loaded`;
        toastr.info(priorTxt, 'Worlds Apart', { timeOut: 3000 });
        paint();
    });

    paint();

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { customButtons: [fillZerosButton(body)], okButton, cancelButton: t`Cancel`, large: true, wide: true, allowVerticalScrolling: true });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    // Dirty only: a prior row is pre-filled and never blank, so emitting every non-blank input would sign rows nobody read as human verdicts.
    const edited = [...body.querySelectorAll('.wa-grade')]
        .filter(input => String(input.value).trim() !== '' && input.dataset.dirty)
        .map(input => {
            const { sec, row } = flat[Number(input.dataset.i)];
            return { sec, g: { title: row.title, grade: Number(input.value), book: row.book, uid: row.uid } };
        });
    const who = { user: raterId(), now: today() };
    // Per section: mergeGrades keys on world+uid, and a shared merge would land one scene's verdict on another's row.
    if (multi) {
        return {
            sections: secs.map((sc, si) => ({
                file: sc.file ?? sc.name,
                grades: mergeGrades(sc.prior ?? [], edited.filter(e => e.sec === si).map(e => e.g), who),
            })),
            edited: edited.length,
        };
    }
    return { grades: mergeGrades(prior, edited.map(e => e.g), who) };
}

/**
 * /wa-super-grade: captures several arms, unions what they surfaced, grades only what no earlier round judged, and writes one sample per arm sharing the grades.
 * @param {object} named Named args: name, candidates, arms, notes
 * Books are embedded whole in every sample (G10): a dump captured without content cannot rebuild its index.
 */
export async function superGradeScene(named) {
    const wanted = Math.max(1, Number(named?.candidates ?? 30));
    const picked = String(named?.arms ?? '').trim()
        ? String(named.arms).split(/[,\s]+/).filter(Boolean)
        : Object.keys(POOL_ARMS);
    const unknown = picked.filter(a => !POOL_ARMS[a]);
    if (unknown.length) {
        toastr.warning(t`Unknown arm(s): ${unknown.join(', ')}. Known: ${Object.keys(POOL_ARMS).join(', ')}`, 'Worlds Apart');
        return '';
    }

    const captures = [];
    for (const [n, arm] of picked.entries()) {
        toastr.info(t`Arm ${n + 1}/${picked.length}: ${arm}`, 'Worlds Apart', { timeOut: 2500 });
        // Sequential, not Promise.all: the arms share one live settings object and one retrieval pipeline.
        const cap = await captureArm(POOL_ARMS[arm], wanted);
        if (!cap.rows.length) {
            console.warn(`Worlds Apart: arm "${arm}" activated nothing — skipped`);
            continue;
        }
        if (!cap.query) {
            console.warn(`Worlds Apart: arm "${arm}" retrieved nothing (no query to freeze) — skipped`);
            continue;
        }
        // Converted here so everything downstream reads a candidate; /wa-debug's row keeps its flat signals.
        captures.push({ arm, ...cap, rows: (cap.rows ?? []).map(toCandidate) });
    }

    if (!captures.length) {
        toastr.warning(t`No arm activated anything — nothing to grade.`, 'Worlds Apart');
        return '';
    }

    const union = unionArms(captures);
    // On the gradeable subset: unionArms keeps durable rows, so an all-constant scene has a non-empty union.
    if (!union.rows.some(r => !isDurable(r))) {
        toastr.warning(t`Every activated row was constant or a persisting sticky — relevance chose nothing to grade.`, 'Worlds Apart');
        return '';
    }

    // Before the popup: an offline pool request names entries no arm surfaced, resolved from the book for their text.
    const books = await loadBooks();
    const entryOf = entryResolver(books);

    const done = await superGradePopup({ captures, union, entryOf });
    if (!done) {
        return '';
    }
    const { grades } = done;

    const base = named?.name || defaultSampleName();
    const built = [];
    for (const cap of captures) {
        const sample = buildSample({
            name: `${base}--${cap.arm}`,
            notes: named?.notes || `Arm "${cap.arm}" of a ${captures.length}-arm pooled grading (${captures.map(c => c.arm).join(', ')}); ${grades.length} grades pooled across arms and rounds.`,
            query: cap.query,
            queryChat: cap.queryChat,
            scanChat: cap.scanChat,
            injects: cap.injects,
            sources: matcher.usedMatchSources(cap.sources, Object.values(books).flatMap(b => Object.values(b))),
            depth: cap.depth,
            ...await sceneCommon(cap.rows, books),
            params: cap.params,
            snapshot: cap.snapshot,
            candidates: cap.rows,
            grades,
            cutoff: {
                live: cap.live,
                gradingOverride: { maxVectorEntries: wanted },
            },
            // Exact count of judged rows — what a human was offered; the boundary the harness reads.
            gradedCandidates: cap.rows.filter(r => !isDurable(r)).length,
            now: new Date().toISOString(),
        });
        built.push({ arm: cap.arm, sample });
    }

    const bundle = await bundleSamples(built, { ...sceneRange(), user: raterId(), captureId: uuidv4() });
    const { filename, content } = sampleFile({ ...bundle, name: base });
    download(content, filename, 'application/json');
    console.log(`Worlds Apart: ${built.length}-arm bundle -> ${filename}`, bundle);

    const above = grades.filter(g => gradeValue(g) > 0).length;
    toastr.success(
        t`Saved ${filename} — ${built.length} arms in one file, ${union.rows.length} rows this round, ${grades.length} pooled, ${above} above 0.`
        + ' ' + t`Move it to eval/eval-data/ and run graded-scene-grid.mjs --sample (add --arm to pick one); watch judged@10.`,
        'Worlds Apart', { timeOut: 12000 },
    );
    return '';
}

/** Opens the browser file picker for JSON; resolves [] on cancel.
 * A click without live user activation (a slash command with no chat open) fires no event at all, so the timeout turns a still-focused document into a message. */
const pickJsonFiles = ({ multiple = false } = {}) => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.multiple = multiple;
    // Cancelled by either event, or a pick inside the window still warns that the picker it just used was blocked.
    let timer = null;
    const settle = v => { clearTimeout(timer); resolve(v); };
    input.addEventListener('change', () => settle([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => settle([]), { once: true });
    input.click();
    // ponytail: focus heuristic, 2s; a dialog that opens without taking focus reads as blocked.
    timer = setTimeout(() => {
        if (!document.hasFocus()) return;
        toastr.warning(t`The browser blocked the file picker — run it again now that the chat is open.`, 'Worlds Apart');
        resolve([]);
    }, 2000);
});

/** /wa-super-eval: reviews N graded bundles from files alone (no chat, books or settings read) through the super-grade shell, one section per
 * bundle — a pack, a top-level array of bundles, is one section per element — and writes one standalone review file for apply-review.mjs. */
export async function superEvalScene() {
    const files = await pickJsonFiles({ multiple: true });
    if (!files.length) {
        return '';
    }
    const bundles = [];
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(await file.text());
        } catch {
            toastr.warning(t`Could not parse ${file.name} — skipped`, 'Worlds Apart');
            continue;
        }
        for (const m of (Array.isArray(parsed) ? parsed : [parsed])) bundles.push({ name: m?.file ?? file.name, manifest: m });
    }
    const secs = [];
    for (const { name: fileName, manifest } of bundles) {
        // Every arm as a flat sample; a pre-v3 pack throws in openBundle and lands in the skip below.
        const names = armNames(manifest);
        const arms = (names.length ? names : [null]).map(n => { try { return openBundle(manifest, n); } catch { return null; } }).filter(Boolean);
        if (!arms.length || !arms[0].candidates?.length || !Array.isArray(arms[0].entries)) {
            toastr.warning(t`${fileName} is not a graded scene — skipped`, 'Worlds Apart');
            continue;
        }
        const entryOf = entryResolver(manifest.books ?? {});
        const captures = arms.map((a, i) => ({
            arm: names[i] ?? manifest.name ?? 'capture',
            rows: a.candidates ?? [],
            entries: (a.candidates ?? []).map(r => entryOf(r.book, r.uid) ?? null),
            query: a.query ?? '',
            depth: a.depth ?? '?',
        }));
        const union = unionArms(captures);
        if (!union.rows.some(r => !isDurable(r))) {
            toastr.warning(t`${fileName} has no gradeable rows — skipped`, 'Worlds Apart');
            continue;
        }
        secs.push({ file: fileName, name: manifest.name ?? fileName, manifest, captures, union, entryOf, prior: arms[0].entries });
    }
    if (!secs.length) {
        toastr.warning(t`No usable graded bundles in that selection.`, 'Worlds Apart');
        return '';
    }
    const manifest = secs[0].manifest;
    const { captures, union, entryOf } = secs[0];

    const done = await superGradePopup({
        captures,
        union,
        entryOf,
        sections: secs,
        subtitle: secs.length === 1
            ? t`Reviewing ${secs[0].file} (${manifest.createdBy ?? translate('unknown grader')}) — loaded from file, no chat required.`
            : t`Reviewing ${secs.length} bundles — loaded from files, no chat required.`,
        okButton: t`Save review`,
    });
    if (!done) {
        return '';
    }

    // One standalone file: each section carries its scene, each graded row its entry text and the judge verdicts it was weighed against.
    // `captureId` is what apply-review resolves on (a basename can be renamed); the judge's prior verdicts ride along for the reviewer and apply-review strips them.
    const reviewed = done.sections.map((sec, si) => {
        const src = openBundle(secs[si].manifest);
        const priorOf = new Map((src.entries ?? []).map(g => [rowKey(g), g]));
        return {
            captureId: secs[si].manifest?.captureId,
            file: sec.file,
            name: secs[si].name,
            sceneChat: src.sceneChat,
            generatedFrom: src.generatedFrom,
            query: src.query ?? '',
            scanChat: src.scanChat ?? [],
            grades: sec.grades.map(g => {
                const p = priorOf.get(rowKey(g)) ?? {};
                const entry = secs[si].entryOf(g.book, g.uid);
                return {
                    ...g,
                    ...(p.grades?.length ? { grades: p.grades } : {}),
                    // `entryText` is for the reviewer; apply-review strips it, the bundle's books being where entry text lives.
                    ...(entry?.content ? { entryText: String(entry.content) } : {}),
                };
            }),
        };
    });
    const all = reviewed.flatMap(r => r.grades);
    const rel = all.filter(g => Number(g.grade) >= 3).length;
    // To the millisecond: apply-review stamps every verdict with this, and a pass key is rater + instant.
    const reviewedAt = new Date().toISOString();
    const stamp = reviewedAt.slice(0, 10);
    const slug = String(reviewed.length === 1 ? (secs[0].name ?? secs[0].file.replace(/\.json$/, '')) : `${reviewed.length}-scenes`)
        .trim().replace(/\.json$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'scenes';
    const filename = `review-${slug}-${stamp}.json`;
    // `createdBy` and `user` travel with the file: apply-review's `--user` defaults to empty, and a pass key of nobody + instant matches nothing on a re-run.
    download(JSON.stringify({ reviewed, gradeScale: GRADE_SCALE, createdBy: 'wa-super-eval', user: raterId(), reviewedAt }, null, 1), filename, 'application/json');

    // Agreement over the rows a human graded that also carry judge verdicts; the judge side resolves by gradeValue's median rule.
    const both = all.filter(g => g.grade !== undefined && (g.grades ?? []).some(v => v.kind === 'llm'));
    const pairs = both.map(g => [Number(g.grade), gradeValue({ grades: g.grades.filter(v => v.kind === 'llm') })]);
    const exact = pairs.filter(([h, j]) => h === j).length, near = pairs.filter(([h, j]) => Math.abs(h - j) <= 1).length;
    const irr = pairs.length ? ' ' + t`LLM agreement: ${exact}/${pairs.length} exact, ${near}/${pairs.length} within 1.` : '';
    toastr.success(t`Saved ${filename} — ${done.edited} row(s) edited across ${reviewed.length} scene(s), ${rel} relevant (>=3).` + irr + ' ' + t`Apply with: node eval/synthetic-data/apply-review.mjs --write`, 'Worlds Apart', { timeOut: 15000 });
    return '';
}
