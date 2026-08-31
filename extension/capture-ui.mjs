// capture-ui.mjs — the CAPTURE COMMANDS: /wa-grade, /wa-super-grade, /wa-super-eval and /wa-versus.
// Popup flows that drive the live pipeline, freeze what it selected, collect grades and write a bundle.
//
// The pure half is grading.mjs — bundleSamples, openBundle, sampleFile, mergeGrades and the schema
// rules. This file is the UI around it: the popups, the tables, the toastr validation, and the
// provenance stamps a capture carries (rater, scene range, versions, chat identity).
//
// IT DRIVES THE PIPELINE RATHER THAN OWNING IT. Six entry points arrive in `host` because a capture has
// to run a real scan and read the config it ran under; nothing here decides retrieval, scoring or
// selection. The pipeline calls none of this back.

import { getContext, extension_settings } from '../../../../extensions.js';
import { getSortedEntries, loadWorldInfo, world_info_budget, world_info_budget_cap, world_info_case_sensitive, world_info_include_names, world_info_match_whole_words } from '../../../../world-info.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { escapeHtml, getCharaFilename, getStringHash, download, uuidv4 } from '../../../../utils.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { runState, settings } from './state.mjs';
import * as matcher from './matcher.mjs';
import * as query from './query.mjs';
import * as layout from './layout.mjs';
import * as selection from './selection.mjs';
import { entryFoldHtml, keyHitsHtml, showEntryText, wiGlyph } from './ui-widgets.mjs';
import { gradeOrder } from './sort.mjs';
import { GRADE_ANCHORS, GRADE_SCALE, armNames, buildSample, bundleSamples, captureParams, gradeValue, keyByUid, mergeGrades, openBundle, rowKey, sampleFile, sceneDiff, searchedBook, splitGraded, toCandidate, unionArms } from './grading.mjs';

/**
 * The pipeline entry points the capture flows drive, injected once at registration.
 *
 * SEVEN, AND THEY ALL POINT ONE WAY. A capture runs a real scan (`dryRun`, `retrieve`), records the
 * config it ran under (`paramSnapshot`, `vectorRequestBody`, `scopedPriority`) and names the book it
 * ran against (`chatBook`), and the budget it would have delivered under (`effectiveTokenBudget`).
 * Nothing in the pipeline reads this module.
 * @typedef {{chatBook: Function, dryRun: Function, effectiveTokenBudget: Function, paramSnapshot: Function,
 *            retrieve: Function, scopedPriority: Function, vectorRequestBody: Function}} CaptureHost
 */
let host = null;

/** Wires the pipeline entry points. Called once from worldsapart.js init, before any command runs. */
export function setCaptureHost(h) { host = h; }

/** The grading scale in one caption line, shared by both grading popups. */
const gradeAnchorLine = () => `Grade 0–4: ${GRADE_ANCHORS.map((a, g) => `${g} = ${a.split(';')[0].toLowerCase()}`).join(' · ')}.`;

/**
 * Best-effort on-disk path of the current chat file, for a graded sample to record.
 *
 * Provenance, but load-bearing provenance: rebuilding the query at a different messageDepth is the one
 * sweep a frozen sample can't do from its own contents, and it needs the chat. Best-effort for the same
 * reason as vectorIndexPath — the browser can't see the data root or the user handle. Group chats live
 * under groupchats/ with no per-character folder.
 * @returns {string} Relative chat path
 */
/**
 * The message span this capture covers, as CHAT FILE RECORD indices — what a scene id is composed from.
 *
 * READ OFF THE WINDOW, not computed as `last - depth`. The query window drops empty and hidden messages,
 * so the two differ exactly when a scene contains any; `queryMessages` tags each kept message with where it
 * came from, which is the only thing that can say where the span really starts.
 *
 * +1 because ST's in-memory chat array is the jsonl MINUS its header line, and a scene id names a span of
 * the FILE — the artifact `sceneChat` points at, and the only one a reader can open and check it against.
 *
 * @returns {{start: number, end: number}}
 */
function sceneRange() {
    const win = runState.lastQueryChat ?? [];
    if (!win.length) {
        // No window captured (a summary-mode run clears it). The last message is the honest fallback: the
        // scene ends where the chat does, and a zero-length span at least does not claim a start it lacks.
        const last = Math.max(0, (getContext().chat?.length ?? 1) - 1) + 1;
        return { start: last, end: last };
    }
    return { start: win[0].i + 1, end: win[win.length - 1].i + 1 };
}

/**
 * WA's RESOLVED version, `<branch>@<git describe>` — what actually ran, not what manifest.json declares.
 *
 * The browser cannot read git, so this comes off the server plugin's /ping, which runs `git describe` over
 * the extension's own third-party directory. Declared versions were what this used to report, and a
 * manifest names the next release rather than the tree serving the page — only a tag makes a version a
 * fact about a commit.
 *
 * Empty with no plugin, and empty rather than falling back to the manifest: a capture naming no version
 * reads as "unknown", where one naming the wrong version reads as a fact. `sourceFP` is the stronger drift
 * signal there anyway, being a hash of the code rather than a name for it.
 *
 * Read off runState rather than fetched: the settings panel pings the plugin at init, so the value is
 * already there by the time any capture runs.
 */
const waVersion = () => runState.pluginWaVersion ?? '';

/**
 * SillyTavern's resolved version, as `<branch>@<commit>` — what actually ran, not what package.json says.
 *
 * ST's declared version only advances on pushes to main, so a staging checkout reports a number with
 * nothing to do with the tree serving the page. `/version` gives the branch and a short HEAD; it has no
 * tags and no dirty flag, so this is the thinner form of the schema's `<branch>@<git describe>` rather
 * than a different convention. Empty when the endpoint cannot be read — an absent field reads as an older
 * capture, and a guessed version would not.
 *
 * Cached: it cannot change without a page reload.
 */
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

/** WHEN A VERDICT WAS PASSED, to the second. Not a day: a second pass over the same rows on the same day
 *  is the adjudication case, and at day granularity it is indistinguishable from the first pass merged
 *  twice — so the writers would drop it. `createdAt` on the document stays a day; that is provenance. */
const today = () => new Date().toISOString();

/**
 * Who a typed grade is signed as: a UUIDv4, minted once and kept in settings.
 *
 * GENERATED LAZILY, on the first grade actually signed, so merely installing WA writes no id. See
 * state.mjs `raterId` for why it is random rather than `<st-user>@<host>` — the short version is that
 * grades are meant to arrive from other users, and every composed identity available in a browser
 * collides across installs.
 *
 * ST's own `uuidv4` rather than `crypto.randomUUID`, which is secure-context only and so undefined when
 * ST is served over plain HTTP on a LAN address; the helper falls back to Math.random there.
 */
function raterId() {
    const s = settings();
    if (!String(s.raterId ?? '').trim()) {
        s.raterId = uuidv4();
        saveSettingsDebounced();
    }
    return s.raterId;
}

function chatFilePath() {
    const ctx = getContext();
    if (!ctx.chatId) {
        return '';
    }
    return ctx.groupId
        ? `data/default-user/groupchats/${ctx.chatId}.jsonl`
        : `data/default-user/chats/${getCharaFilename(ctx.characterId)}/${ctx.chatId}.jsonl`;
}

/**
 * Best-effort on-disk path of a book's vector index, for a graded sample to record.
 *
 * Best-effort because the browser can't see the data root: the user handle is assumed to be
 * `default-user`. The collectionId is exact (same hash syncWorld uses), so a wrong path is a one-field
 * edit in the sample, and graded-scene-grid can also re-derive it from the book name.
 * @param {string} world Book name
 * @returns {string} Relative index path
 */
function vectorIndexPath(world) {
    const body = host.vectorRequestBody();
    return `data/default-user/vectors/${body.source}/wa_${getStringHash(world)}/${body.model || 'default'}/index.json`;
}

export async function versusCore(named) {
    // RUNS THE DEBUG PIPELINE ITSELF, as /wa-grade does, so the rows this freezes are the selection that
    // actually happened rather than whatever a previous command left behind. `candidates` bounds the
    // captured population the same way and for the same reason; shipped rows are never dropped by it
    // (see the gradeDepth filter in onScanDone), so the comparison itself cannot be truncated.
    const wanted = Math.max(1, Number(named?.candidates ?? 30));
    runState.gradeCutoff = { maxVectorEntries: wanted };
    try {
        await host.dryRun(true);
    } finally {
        runState.gradeCutoff = null;
    }

    const population = runState.lastLayoutOrder;
    if (!runState.lastCandidates?.length || !population?.length) { toastr.info('Nothing ranked \u2014 the scan activated no entries.', 'Worlds Apart'); return; }

    const { entries: coreEntries, viaVectors, vectorsRan } = await coreSelection();

    const keyOf = e => `${e.world}.${e.uid}`;
    const coreKeys = new Set(coreEntries.map(keyOf));
    const waKeys = new Set((runState.lastPromptOrder ?? []).map(x => keyOf(x.item.entry)));
    const byKey = new Map(population.map(x => [keyOf(x.entry), x]));
    for (const e of coreEntries) if (!byKey.has(keyOf(e))) byKey.set(keyOf(e), { entry: e });

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
        // EVERY SIGNAL THE SCORE IS MADE OF, or a disagreement cannot be diagnosed from the export:
        // cosine and keys alone cannot say why a row carrying the highest of both ranks last.
        cosine: Number.isFinite(x.score) ? Number(x.score.toFixed(4)) : null,
        text: Number.isFinite(x.textScore) ? Number(x.textScore.toFixed(3)) : null,
        keys: Number(x.keywordScore) ? Number(x.keywordScore.toFixed(2)) : null,
        properNouns: Number.isFinite(x.properNouns) ? Number(x.properNouns.toFixed(3)) : null,
        density: Number.isFinite(x.density) ? Number(x.density.toFixed(2)) : null,
    });
    const spend = keys => [...byKey.entries()].filter(([k]) => keys.has(k)).reduce((t, [, x]) => t + (x.tokens || 0), 0);
    const both = [...coreKeys].filter(k => waKeys.has(k)).length;

    console.log(`%cWorlds Apart \u00b7 WA vs ST core, message ${(getContext().chat ?? []).length}`, 'font-weight: bold');
    console.log(`  core: ${coreKeys.size} entries, ${spend(coreKeys)} tokens (its own budget: world_info_budget ${world_info_budget}%${Number(world_info_budget_cap) > 0 ? `, cap ${world_info_budget_cap}` : ''})`);
    console.log(`  WA:   ${waKeys.size} entries, ${spend(waKeys)} tokens (budget ${host.effectiveTokenBudget()})`);
    console.log(`  shared ${both}, core only ${coreKeys.size - both}, WA only ${waKeys.size - both}`);

    // CORE'S CUT IS A SORT, and saying so is the difference between reading this table as two
    // rankings disagreeing and reading it as one ranking against `order`. getSortedEntries sorts
    // descending by order (world-info.js sortFn) and the budget loop breaks at overflow, so under a
    // filled budget core ships a PREFIX of that walk. When the two sets separate cleanly by order,
    // the comparison measured the book's authored sequence and not core's judgement of the scene.
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
        // THE SCENE, or none of this is gradeable. A judge scores an entry AGAINST something, and
        // rows plus content is only half of that pair. Same field names as the /wa-grade capture so
        // an offline reader treats the two the same way.
        query: runState.lastQuery,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        sources: runState.lastSources,
        depth: settings().messageDepth,
        // The two JOINING decisions a reader needs to rebuild the window from the pieces above —
        // scanChat stores name and text separately, so neither is recoverable from the text.
        matchWindow: settings().matchWindow,
        includeNames: world_info_include_names,
        rows: union.map(([k, x]) => ({ ...row([k, x]), core: coreKeys.has(k), wa: waKeys.has(k), content: x.entry.content })),
    });
    await versusBundle(union, coreKeys, waKeys, viaVectors);
    toastr.success(`core ${coreKeys.size} / WA ${waKeys.size}, ${coreKeys.size - both} core-only \u2014 see console`, 'WA vs core');
}

/**
 * Writes the comparison as an ordinary two-arm capture bundle.
 *
 * NOTHING ABOUT IT IS SPECIAL. An arm is a configuration and its `candidates` are the population it
 * ranked, each row carrying `cut` — so the DELIVERED SET is `!cut`, exactly as in a /wa-grade capture, and
 * the reviewer, apply-review and any reader of a v3 bundle need no case for it. What distinguishes core
 * from WA is its `params`, which is what params are for.
 *
 * The one asymmetry is real and recorded rather than papered over: `checkWorldInfo` returns the map that
 * SURVIVED its budget walk, so core's activated-but-cut rows do not exist to capture. Core's arm therefore
 * carries its delivered set with every row uncut, and WA's carries its whole ranked population. `unionArms`
 * is built for arms that surfaced different things.
 *
 * @param {Array<[string, object]>} union Rows keyed `world.uid` — the two shipped sets, for the diff
 * @param {Set<string>} coreKeys What core shipped
 * @param {Set<string>} waKeys What WA shipped
 * @param {boolean} viaVectors Whether Vector Storage's WI route was on for core
 */
async function versusBundle(union, coreKeys, waKeys, viaVectors) {
    const books = {};
    for (const world of runState.attachedWorlds) {
        const data = await loadWorldInfo(world);
        if (data?.entries) books[world] = keyByUid(data.entries);
    }

    // WA's arm IS the /wa-grade capture, untouched — same rows, same cut flags, same signals.
    const waRows = runState.lastCandidates;

    // Core's rows reuse WA's where the entry is in both populations, so the signals are the measured ones
    // rather than a second derivation; a row only core activated has none, and an absent signal is not a
    // zero (unionArms fills it).
    const byKey = new Map(waRows.map(r => [`${r.book}\u001f${r.uid}`, r]));
    const coreRows = [...union].filter(([k]) => coreKeys.has(k)).map(([, x], i) => {
        const key = `${x.entry.world}\u001f${x.entry.uid}`;
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
            // EVERY ROW CORE SHIPPED IS UNCUT, because its budget walk already ran — see the docblock.
            cut: false,
            cutBy: null,
        };
    });

    const primaryBook = searchedBook(waRows) ?? host.chatBook() ?? Object.keys(books)[0] ?? '';
    const common = {
        query: runState.lastQuery,
        queryChat: runState.lastQueryChat,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        sources: matcher.usedMatchSources(runState.lastSources, Object.values(books).flatMap(b => Object.values(b))),
        depth: settings().messageDepth,
        pluginFP: runState.pluginFP,
        sourceFP: runState.sourceFP,
        waVersion: waVersion(),
        stVersion: await stVersion(),
        chat: chatFilePath(),
        book: primaryBook ? `data/default-user/worlds/${primaryBook}.json` : '',
        index: primaryBook ? vectorIndexPath(primaryBook) : '',
        primaryBook,
        embedModel: host.vectorRequestBody().model || '',
        snapshot: host.paramSnapshot(),
        books,
        priority: (host.scopedPriority() ?? []).map(x => x.cfg),
        grades: [],
        cutoff: { live: { maxVectorEntries: settings().maxVectorEntries } },
        now: new Date().toISOString(),
    };
    const stParams = {
        caseSensitive: world_info_case_sensitive,
        wholeWords: world_info_match_whole_words,
        includeNames: world_info_include_names,
        allowWIScan: Boolean(extension_settings.note?.allowWIScan),
    };

    const arms = [
        { arm: 'wa', rows: waRows, params: captureParams(settings(), stParams) },
        // WHAT MADE THIS ARM DIFFERENT, in its params and nowhere else: core's own budget percentage and
        // scan depth, and whether Vector Storage's World Info route ran. A reader comparing the two arms
        // reads these rather than inferring from the arm's name.
        { arm: viaVectors ? 'core+vectors' : 'core', rows: coreRows, params: {
            ...captureParams(settings(), stParams),
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
        gradedCandidates: rows.filter(r => r.block === 'dynamic').length,
    }) }));

    const bundle = await bundleSamples(arms, { ...sceneRange(), user: raterId(), captureId: uuidv4() });
    const { filename, content } = sampleFile(bundle);
    download(content, filename, 'application/json');
    toastr.info(`Saved ${filename} — open it with Review bundles to grade these ${union.length} rows.`, 'Worlds Apart', { timeOut: 8000 });
}

/**
 * Default sample name: the chat plus the message the scene ends on.
 *
 * A date is the wrong identity — grade two scenes in one afternoon and both are `scene-<today>`, so the
 * NAME collides even though the browser numbers the downloaded files apart, and every report keys on the
 * name. Chat + last-message index is what actually identifies a scene: distinct across chats, distinct
 * across scenes within a chat, stable if you re-grade the same point, and legible in a results table.
 * @returns {string} Sample name
 */
function defaultSampleName() {
    const ctx = getContext();
    const chat = String(ctx.chatId ?? getCharaFilename(ctx.characterId) ?? 'scene');
    // Chat ids carry timestamps and punctuation ("Isekai - 2026-03-04@14h45"); keep it filesystem- and
    // table-friendly, and short enough to read.
    const slug = chat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return `${slug || 'scene'}-msg${Math.max(0, (ctx.chat?.length ?? 1) - 1)}`;
}


/**
 * Wires a grading table's fold chevrons and their popouts.
 *
 * Shared because the two graders must behave identically here — they show the same rows, and a fold that
 * opened in one and not the other would be a difference in what a grader can see rather than in what the
 * table is for. Called on every /wa-super-grade repaint, which is why it attaches to freshly-queried nodes
 * rather than holding references.
 *
 * @param {HTMLElement} root Container holding the rows
 * @param {(i: number) => object} entryAt Resolves a row's capture index to its entry
 */
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

/**
 * "The rest are zeros" — fills every blank grade field with 0.
 *
 * A grader works a ranked list top-down and past some rank everything is 0 with the occasional 1. Typing
 * two dozen zeros to say so is the reason the field used to default to 0, which fabricated a verdict for
 * every row nobody reached. This is the deliberate version of the same thing: one click at the END of a
 * pass, asserting that the untouched rows were read and judged irrelevant.
 *
 * Writes 0 into the DOM rather than recording a flag, so the sample gains no new semantics: those zeros are
 * ordinary grades the author affirmed, indistinguishable from typed ones because that is what they are.
 * Leaving a row blank still means UNGRADED — the difference is that saying so is now the default and
 * claiming otherwise takes an action.
 *
 * UNDO RE-QUERIES rather than holding element references. /wa-super-grade repaints its table on any
 * prior-round change, which detaches every input, so a captured reference would silently revert nothing.
 * The filled rows are remembered by their identity attribute instead — `data-key` where the table has one,
 * else `data-i` — and resolved against the DOM at the moment undo runs.
 *
 * @param {HTMLElement} root Container holding the .wa-grade inputs
 * @returns {{filled: number, undo: () => number}} Count, and a revert that reads the DOM afresh
 */
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
            // Only revert a row still holding the 0 this put there — a value edited since is the
            // author's and outranks the undo.
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
 * Grades the current scene and writes a self-contained sample for eval/graded-scene-grid.mjs.
 *
 * Runs the real /wa-debug pipeline first, then grades the rows it produced — so the grades attach to the
 * selection that actually happened, at settings that are recorded rather than remembered. n=1 is the
 * standing limitation on every tuning claim in this extension; this exists to make n>1 cheap.
 *
 * Reference rows (constants, configured stickies) are listed but not gradeable: they are always-on or
 * persist-on-trigger, so relevance never chose them and grading them would drag nDCG down for entries the
 * ranking isn't responsible for.
 *
 * @param {object} named Named args: name, books (full|meta|none), notes
 * @returns {Promise<string>} Empty string — output is a downloaded file
 */
export async function gradeScene(named) {


    // Cap the dynamic rows at the depth asked for. Nothing cuts the population for relevance any more, at
    // either stage, so this is purely a grading budget: without it a capture pools the whole admitted set.
    const live = { maxVectorEntries: settings().maxVectorEntries };
    const wanted = Math.max(1, Number(named?.candidates ?? 20));
    runState.gradeCutoff = { maxVectorEntries: wanted };

    let rows = [];
    let entries = [];
    try {
        // The debug run IS the measurement: same retrieval, same ranking — only the cut is widened.
        await host.dryRun(true);
        rows = runState.lastCandidates ?? [];
        entries = runState.lastCandidateEntries ?? [];
    } finally {
        runState.gradeCutoff = null;
    }

    if (!rows.length) {
        toastr.warning('Nothing was activated — nothing to grade.', 'Worlds Apart');
        return '';
    }

    // host.retrieve() records the query as soon as it builds one, whatever retrieval then scores — so an
    // empty lastQuery here means no query text could be built at all (macro-empty messages), and the
    // sample really would be unrunnable. Keyword-only scenes pass: rows from the scan, query frozen.
    if (!runState.lastQuery) {
        toastr.warning('No query text could be built from this chat — the sample would have nothing to score offline.', 'Worlds Apart');
        return '';
    }


    // GRADEABLE MEANS THE RUNTIME CLASS IS `dynamic` — WA chose it this turn. The other two are excluded
    // for different reasons, and neither is a relevance judgement WA can be scored on:
    //   constant  declares relevance unconditionally; there is no per-turn call to make.
    //   sticky    means the effect was ARMED BEFORE THIS SCAN (isEffectActive, line ~1638), so the entry
    //             is in the prompt because a previous turn put it there. Judging it relevant or not is a
    //             verdict on the sticky VALUE — an authoring defect — not on ranking, and pooling those
    //             into the grade set would contaminate a ranker metric with authoring calls.
    // An entry with `sticky` CONFIGURED that fired this scan is not in that class: the effect is not yet
    // armed, so it classifies `dynamic` and grades like any other activation. isDurable() lumps the
    // configured value in with the runtime one; left alone here because the eval side still reads it.
    const gradeable = rows.map((row, i) => ({ row, entry: entries[i], i })).filter(x => x.row.block === 'dynamic');
    const scaffold = rows.length - gradeable.length;
    const esc = s => escapeHtml(String(s ?? ''));

    const wrap = document.createElement('div');
    wrap.innerHTML = '<h3 style="margin:0 0 0.25em;">Grade this scene</h3>'
        + `<small style="display:block;opacity:0.7;margin-bottom:0.5em;">${gradeAnchorLine()} ${gradeable.length} retrieved entries${scaffold ? `; ${scaffold} constant/persisting-sticky row(s) listed but not graded — WA did not choose them this turn` : ''}. Blank means UNGRADED, not 0.</small>`
        + '<details style="margin-bottom:0.75em;"><summary style="cursor:pointer;">Query text — what retrieval actually matched on '
        + `(${runState.lastQuery.length} chars, depth ${settings().messageDepth})</summary>`
        + `<pre style="white-space:pre-wrap;max-height:14em;overflow:auto;font-size:0.85em;opacity:0.85;border:1px solid var(--SmartThemeBorderColor);padding:0.5em;margin-top:0.5em;">${esc(runState.lastQuery)}</pre></details>`
        + '<table style="width:100%;border-collapse:collapse;font-size:0.9em;text-align:left;"><thead><tr style="text-align:left;">'
        + '<th style="width:4em;">Grade</th><th>Entry</th><th style="width:4em;">fused</th><th style="width:4em;">cos</th><th style="width:4em;">text</th><th style="width:4em;">keys</th></tr></thead><tbody>'
        // Presented in block + score order, NOT capture order (see gradeOrder). `i` stays the CAPTURE
        // index because every data-i in this table indexes back into `rows`/`entries`.
        + gradeOrder(rows, r => -(r.score ?? -Infinity)).map(({ row, i }) => {
            const scaff = row.block !== 'dynamic';
            const num = n => (n == null ? '·' : String(n));
            const cell = scaff
                ? `<span style="opacity:0.5;font-size:0.85em;">${row.block === 'constant' ? 'const' : 'sticky'}</span>`
                : `<input type="number" class="wa-grade text_pole" data-i="${i}" min="0" max="4" step="1" placeholder="—" title="${esc(GRADE_ANCHORS.map((a, g) => `${g}: ${a}`).join('\n'))}" style="width:4em;padding:2px 4px;">`;
            return `<tr style="border-top:1px solid var(--SmartThemeBorderColor);${scaff ? 'opacity:0.6;' : ''}">`
                + `<td>${cell}</td>`
                // wiGlyph — the Studio's own 🔵 constant / 🔗 vector / 🟢 keyword mapping, not a local
                // one. These tables show the same entries the Explorer does and must classify them the
                // same way; a second mapping drifts the moment either side gains a class.
                + `<td>${row.cut ? `<i class="fa-solid fa-scissors" style="opacity:0.55;margin-right:0.35em;" title="cut by the budget${row.cutBy ? ` — ${esc(row.cutBy)} cap` : ''}${row.tokens ? `; ${row.tokens} tokens` : ''}"></i>` : ''}${entries[i] ? wiGlyph(entries[i]) + ' ' : ''}${esc(row.title)}<br><small style="opacity:0.5;">${esc(row.book)} · uid ${num(row.uid)}</small>${keyHitsHtml(row.why)}<br><i class="fa-solid fa-chevron-right wa-chevron wa-fold" data-i="${i}" title="Show keys and entry text" style="margin-top:0.35em;"></i></td>`
                + `<td>${num(row.score)}</td><td>${num(row.cosine)}</td><td>${num(row.text)}</td><td>${num(row.keys)}</td>`
                + `</tr>`
                + `<tr class="wa-foldrow" data-i="${i}" style="display:none;"><td colspan="6" style="padding:0.5em 0.75em 0.9em;">${entryFoldHtml(entries[i], i)}</td></tr>`;
        }).join('')
        + '</tbody></table>';

    // Reuses the Studio's entry viewer rather than a second renderer.
    wireFolds(wrap, i => entries[i]);

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { customButtons: [{
        // No `result`, so it acts on the form and leaves the popup open — a pass ends with this and then
        // Save. Sits beside the confirm buttons because it is the LAST thing done, not a table control.
        text: 'Fill blanks with 0', icon: 'fa-0',
        tooltip: 'Every untouched row becomes a graded 0. Leave a row blank to record it as UNGRADED instead.',
        action: () => {
            const { filled, undo } = fillReadZeros(wrap);
            if (!filled) { toastr.info('No blank rows to fill.', 'Worlds Apart'); return; }
            toastr.success(`Filled ${filled} blank row(s) with 0. Click to undo.`, 'Worlds Apart', {
                timeOut: 10000, extendedTimeOut: 10000,
                onclick: () => { const n = undo(); toastr.info(`Reverted ${n} row(s) to ungraded.`, 'Worlds Apart'); },
            });
        },
    }], okButton: 'Save sample', cancelButton: 'Cancel', large: true, wide: true, allowVerticalScrolling: true });
    const result = await popup.show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return '';
    }

    // AN UNTOUCHED FIELD IS NOT A GRADE. The input used to default to 0, so every row the grader never
    // reached was submitted as a considered "definitely not relevant" — fabricating judgements for the
    // whole tail of a partial pass, and making the pool look complete when it was not. Blank rows are
    // omitted, so makeGradeOf returns null for them and every consumer decides what absent means. A
    // TYPED 0 is a real verdict and still lands here.
    const grades = [...wrap.querySelectorAll('.wa-grade')]
        .filter(input => String(input.value).trim() !== '')
        .map(input => {
            const row = rows[Number(input.dataset.i)];
            return { title: row.title, grade: Number(input.value), book: row.book, uid: row.uid };
        });

    // Every attached book, at the requested fidelity — so a later lorebook edit can't move the numbers.
    const books = {};
    for (const world of runState.attachedWorlds) {
        const data = await loadWorldInfo(world);
        if (data?.entries) {
            books[world] = keyByUid(data.entries);
        }
    }

    // Which collection the harness must load. Taken from the ranking (see searchedBook), because the chat's
    // bound book is an ST binding, not a statement about what was retrieved: a book with no entries never
    // appears in attachedWorlds at all, so trusting it here keyed samples to a collection that doesn't
    // exist. The chat book stays the fallback for a keyword-only scene, where nothing was retrieved.
    const primaryBook = searchedBook(rows) ?? host.chatBook() ?? Object.keys(books)[0] ?? '';
    const sample = buildSample({
        name: named?.name || defaultSampleName(),
        notes: named?.notes,
        query: runState.lastQuery,
        queryChat: runState.lastQueryChat,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        // Only the card/persona fields an entry's `matchXxx` actually pulls in — see usedMatchSources.
        sources: matcher.usedMatchSources(runState.lastSources, Object.values(books).flatMap(b => Object.values(b))),
        depth: settings().messageDepth,
        pluginFP: runState.pluginFP,
        sourceFP: runState.sourceFP,
        waVersion: waVersion(),
        stVersion: await stVersion(),
        chat: chatFilePath(),
        book: primaryBook ? `data/default-user/worlds/${primaryBook}.json` : '',
        index: primaryBook ? vectorIndexPath(primaryBook) : '',
        primaryBook,
        embedModel: host.vectorRequestBody().model || '',
        params: captureParams(settings(), {
            caseSensitive: world_info_case_sensitive,
            wholeWords: world_info_match_whole_words,
            includeNames: world_info_include_names,
            allowWIScan: Boolean(extension_settings.note?.allowWIScan),
        }),
        snapshot: host.paramSnapshot(),
        candidates: rows,
        books,
        priority: (host.scopedPriority() ?? []).map(x => x.cfg),
        grades,
        // Kept under its historical name so samples on disk stay readable; it now records only the
        // grading depth, the cliff it also described having been removed.
        cutoff: {
            // The live cap — the configuration being assessed.
            live,
            // The depth this run captured to, i.e. how many rows the grader was shown. An offline arm
            // that keeps more than gradedCandidates is scoring rows nobody judged.
            gradingOverride: { maxVectorEntries: wanted },
        },
        gradedCandidates: gradeable.length,
        now: new Date().toISOString(),
    });

    // ONE SCENE IS A ONE-ELEMENT `scenes` LIST. There is no flat single-arm shape any more, so /wa-grade
    // and /wa-super-grade write the same kind of file and every reader handles both without asking which.
    const bundle = await bundleSamples([{ arm: 'shipped', sample }], { ...sceneRange(), user: raterId(), captureId: uuidv4() });
    const { filename, content } = sampleFile(bundle);
    download(content, filename, 'application/json');
    const graded = grades.filter(g => gradeValue(g) > 0).length;
    toastr.success(`Saved ${filename} — ${graded} of ${grades.length} graded above 0. Move it to eval/eval-data/ and run graded-scene-grid.mjs --sample`, 'Worlds Apart', { timeOut: 8000 });
    console.log(`Worlds Apart: sample "${sample.name}" — ${grades.length} graded rows, ${Object.keys(books).length} book(s) embedded`, sample);

    return '';
}

/**
 * The arms /wa-super-grade captures: configurations that change WHICH ENTRIES GET SURFACED.
 *
 * NOT a grid, and deliberately not a complete one. An arm's only job is to put entries into the judged pool
 * that the shipped configuration never surfaces, because an unjudged entry scores 0 and any configuration
 * that promotes it is penalised for surfacing something nobody looked at. That is pool bias, and it is what
 * makes a defaults review scored against a single capture's pool indefensible.
 *
 * SO MOST PARAMETERS DO NOT BELONG HERE. k1, b, lexicalWeight, rrfK, properNounBoost, stopwordDocFreq and
 * every cutoff mode are re-derived offline by graded-scene-grid.mjs from the frozen query and the embedded
 * books, over whatever pool exists — running them live would cost an embed and a full WI scan each and return
 * a near-identical population. messageDepth is likewise ablatable from `queryChat`. What earns an arm is
 * being unable to compute the population offline:
 *
 *   no-filter   entityFilter off moves the surviving query terms, so it moves the term weights
 *               content-lexical scores with at STAGE 3, and with them the layout ranking. It no longer
 *               moves ADMISSION — stage 1 has no BM25 and no relevance test — and scene.mjs takes
 *               termWeights as a parameter, so this arm now fails the criterion above. Kept until the
 *               section is resettled; it still cannot ride a preloaded sweep (scene.mjs's guard names
 *               only the gazetteer settings).
 * A SUMMARIZED QUERY cannot be an arm: nothing summarizes one (matcher-design.md, *Stage 1*, for what
 * that measured). Bundles captured under the old `queryMode` still open by name, field read and ignored.
 *
 * ARM COUNT IS NOT A DESIGN CONSTANT. Add an entry here whenever graded-scene-grid.mjs reports a
 * configuration whose top rows are not fully judged; that number is the stopping rule, not this list's
 * length. `arms=` runs a subset when a round only needs to close one gap.
 */
export const POOL_ARMS = {
    shipped: {},
    'no-filter': { entityFilter: false },
};

/**
 * Runs one debug capture under temporarily-overridden settings.
 *
 * The override is a plain assign-and-restore over the live settings object: every module reads through
 * `settings()` at call time, so this reaches the whole pipeline without a parallel injection path, and
 * nothing in the retrieval or scan path calls saveSettingsDebounced, so nothing persists. captureParams and
 * paramSnapshot are read INSIDE the window — they must describe the arm, not the restored baseline.
 *
 * ponytail: the override is live across awaits, so a real generation firing mid-capture would use the arm's
 * settings. Acceptable for a dev eval command driven by hand; the fix if it ever bites is a per-run settings
 * object threaded through host.retrieve(), which is a much larger change than this feature justifies.
 *
 * @param {object} overrides Settings to force for this run
 * @param {number} wanted Candidate depth (the cliff is dropped and the dynamic rows capped, as /wa-grade does)
 * @returns {Promise<object>} The capture: rows, entries, and everything the sample needs to freeze it
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
            params: captureParams(s, {
                caseSensitive: world_info_case_sensitive,
                wholeWords: world_info_match_whole_words,
                includeNames: world_info_include_names,
                allowWIScan: Boolean(extension_settings.note?.allowWIScan),
            }),
            snapshot: host.paramSnapshot(),
            // This arm's own cap, which the grading depth overrode.
            live: { maxVectorEntries: s.maxVectorEntries },
        };
    } finally {
        Object.assign(s, saved);
        runState.gradeCutoff = null;
    }
}

/**
 * Captures several arms, unions what they surfaced, and grades only what no earlier round has judged.
 *
 * WHY NOT JUST RUN /wa-grade N TIMES. Two reasons, and the second is the load-bearing one. The arms overlap
 * heavily, so N separate gradings re-judge the same entries N times. And more importantly a pool assembled
 * from one configuration systematically penalises every configuration far from it (see POOL_ARMS), so the
 * defaults review the pool is meant to support cannot be run against it.
 *
 * Round 2 onwards, load the previous round's samples into the file picker: those grades are subtracted, so
 * only genuinely new entries need a human, and the written samples carry the accumulated grade set. That is
 * what lets the arm list grow without the grading cost growing with it.
 *
 * Writes ONE SAMPLE PER ARM, each with its own `params`, its own candidate rows and its own recorded
 * cutoff — a merged row would carry one arm's signals under another's parameters. They share only the grades.
 *
 * Books default to 'full' despite N samples meaning N copies. 'meta' is lossless for how the harness scores
 * TODAY and far smaller (G10), which made it the obvious default — until the samples started being things other
 * people send you. A sample is only re-scorable by someone who has the vector index, and nobody but the
 * author does; what makes a third-party dump usable is REBUILDING the index from the sample, which needs
 * entry content (plus the chunk params in paramSnapshot and the recorded embedModel, both already carried).
 * 'meta' drops content and so permanently forecloses that. Size is recoverable later; a dump captured at
 * 'meta' is not.
 *
 * @param {object} named Named args: name, books, candidates, arms, notes
 * @returns {Promise<string>} Empty string — output is downloaded files
 */
/**
 * The super-grade grading popup, extracted so /wa-super-grade (live captures) and /wa-super-eval (a graded
 * file, no chat required) share one shell: query blocks, prior loading, the editable union table, and the
 * merged-grade result. Callers own what happens to the grades afterwards.
 *
 * @param {object} args
 * @param {Array<{arm: string, rows: object[], entries: object[], query: string, depth?: number|string}>} args.captures Per-arm captures
 * @param {{rows: object[], entries: object[]}} args.union unionArms() output over those captures
 * @param {(world: string, uid: number) => object|undefined} args.entryOf Entry resolver for the text viewer
 * @param {object[]} [args.prior] Pre-loaded prior grades (pre-filled, editable)
 * @param {string} [args.subtitle] Extra context line under the title (escaped here)
 * @param {string} [args.okButton] Confirm-button label
 * @returns {Promise<{grades: object[], prior: object[]}|null>} Merged grades, or null on cancel
 */
async function superGradePopup({ captures, union, entryOf, prior: prior0 = [], subtitle = '', okButton = 'Save samples', sections = null }) {
    const esc = s => escapeHtml(String(s ?? ''));
    let prior = [...prior0];

    // ONE SECTION OR MANY, through one shell. `sections` is /wa-super-eval reviewing N bundles at once;
    // without it this is the single-scene path exactly as before, expressed as a one-element list so
    // there is no second rendering routine to drift from this one.
    //
    // THE DOM INDEX IS FLAT ACROSS SECTIONS. `data-i` addresses `flat`, not a section's own rows, which
    // is what lets wireFolds, gradeOrder and the row renderer stay untouched — a per-section index would
    // collide the moment the same entry appears against two scenes, which is routine in a review set
    // (G10). Section membership rides on the row instead, for the collector.
    const secs = sections ?? [{ captures, union, entryOf, prior: prior0 }];
    const multi = Boolean(sections);
    const flat = [];
    for (let s = 0; s < secs.length; s++) {
        const u = secs[s].union;
        for (let i = 0; i < u.rows.length; i++) flat.push({ sec: s, row: u.rows[i], entry: u.entries[i] });
    }
    const flatIndex = new Map(flat.map((f, i) => [`${f.sec}:${f.row.book}:${f.row.uid}`, i]));

    const wrap = document.createElement('div');
    const head = document.createElement('div');
    const body = document.createElement('div');
    wrap.append(head, body);

    // THE QUERY TEXT THE MACHINE ACTUALLY MATCHED ON. Grading drifts without it: the human remembers the
    // scene, but relevance was decided against this text, and the two diverge (a scene's emotional centre is
    // often a paragraph the query window never reached). Grouped by distinct text rather than shown once,
    // because the arms do NOT share a query — the summary arm retrieves against model-written text while the
    // rest use raw messages, and an entry can be a fair hit for one and a miss for the other.
    // Per section, because each scene has its own query text — the whole point of reviewing N scenes in one
    // pass is that each section shows the text ITS grades are about.
    // The scene text a row is graded AGAINST, and it is read far more often than any one entry, so it
    // gets the entry text's affordances: a taller default box and a pop-out to the full width. `sceneText`
    // collects each block's text so the handler can find it by index — the blocks are built as HTML
    // strings into two different containers (head for one section, body for many), so a closure cannot
    // reach them.
    // DEDUPED AND NEVER CLEARED, because the two containers are written at different times: `head` gets
    // its block once at setup and `body` is rewritten on every repaint. Clearing per paint would strand
    // the index head already rendered; pushing per paint would leak a copy of the text per keystroke.
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
            const label = byQ.size === 1 ? 'Query text — what retrieval actually matched on' : `Query text (${esc(arms.join(', '))})`;
            const si = sceneRef(text, sc.name ?? sc.file ?? 'Scene text');
            return `<details style="margin-bottom:0.4em;"><summary style="cursor:pointer;">${label} `
                + `(${text.length} chars, depth ${caps[0]?.depth ?? '?'}) `
                + `<i class="fa-solid fa-up-right-and-down-left-from-center wa-scene-pop" data-i="${si}" title="Open the whole scene text" style="opacity:0.55;margin-left:0.35em;cursor:pointer;"></i></summary>`
                + `<pre style="white-space:pre-wrap;max-height:32em;overflow:auto;font-size:0.85em;opacity:0.85;border:1px solid var(--SmartThemeBorderColor);padding:0.5em;margin-top:0.5em;">${esc(text)}</pre></details>`;
        }).join('')
            + (byQ.size > 1 ? `<small style="display:block;opacity:0.6;margin-bottom:0.5em;">${byQ.size} arms retrieved against different text — judge relevance to the SCENE, not to any one query.</small>` : '');
    };
    const queryBlocks = multi ? '' : queryBlocksFor(secs[0]);

    head.innerHTML = `<h3 style="margin:0 0 0.25em;">${multi ? `Grade ${secs.length} scenes` : 'Grade this scene — pooled across arms'}</h3>`
        + `${subtitle ? `<small style="display:block;opacity:0.7;margin-bottom:0.25em;">${esc(subtitle)}</small>` : ''}`
        + `<small style="display:block;opacity:0.7;margin-bottom:0.5em;">${gradeAnchorLine()} ${multi
            ? `${flat.length} rows across ${secs.length} scenes; each section shows its own query text.`
            : `${union.rows.length} distinct entries from ${captures.length} arm(s): ${esc(captures.map(c => c.arm).join(', '))}.`}</small>`
        + queryBlocks
        // A bare <input type="file"> inherits nothing from ST's theme and reads as a paragraph of text, so it
        // went unnoticed. Drive it from a real menu_button instead, and keep a PERSISTENT status line: a
        // toast that has already faded is no way to confirm the priors loaded, and grading a round without
        // them silently means re-judging everything the last round already covered.
        + (multi ? '' : '<div style="margin:0.6em 0;display:flex;align-items:center;gap:0.6em;flex-wrap:wrap;">'
        + '<div class="menu_button wa-sg-pick" style="width:auto;padding:0.3em 0.8em;">Load earlier samples / pool requests…</div>'
        + `<small class="wa-sg-loaded" style="opacity:0.7;">${prior0.length ? `${prior0.length} grade(s) pre-loaded, shown in the table` : 'nothing loaded — grading everything from scratch'}</small>`
        + '<input type="file" class="wa-sg-prior" accept=".json,application/json" multiple style="display:none;">'
        + '</div>'
        + '<small style="display:block;opacity:0.6;margin-bottom:0.5em;">Earlier rounds\' samples: their grades are subtracted so you only judge what is new. Pool requests from eval/pool-extend.mjs: their entries are added.</small>');

    // Repaint rather than patch: loading priors changes which rows are gradeable at all. Only grades the
    // user actually EDITED (data-dirty, set below) are carried across — every row is an input now, so
    // carrying pristine "0"s would shadow the prior grades a freshly loaded file is supposed to pre-fill.
    const paint = () => {
        const typed = new Map([...body.querySelectorAll('.wa-grade')].filter(i => i.dataset.dirty).map(i => [i.dataset.key, i.value]));
        // Split PER SECTION, because splitGraded matches rows against one scene's prior grades and a
        // shared pool would pre-fill a row from another scene's verdict for the same entry.
        const split = secs.map((sc, si) => splitGraded(sc.union.rows, si === 0 && !multi ? prior : (sc.prior ?? [])));
        // Counted over the GRADEABLE subset — the union now carries durable rows for completeness, and
        // "N to grade" must not count rows this table renders as uneditable.
        const freshN = split.reduce((a, x) => a + x.fresh.filter(r => r.block === 'dynamic').length, 0);
        const known = split.flatMap(x => x.known);
        const scaffoldN = secs.reduce((a, sc) => a + sc.union.rows.filter(r => r.block !== 'dynamic').length, 0);

        body.innerHTML = `<small style="display:block;opacity:0.7;margin-bottom:0.5em;">${freshN} to grade`
            + `${known.length ? `; ${known.length} judged in an earlier round (pre-filled — edit any you disagree with, untouched rows carry through as shown)` : ''}`
            + `${scaffoldN ? `; ${scaffoldN} constant/persisting-sticky row(s) listed but not graded — WA did not choose them this turn` : ''}. Blank means UNGRADED, not 0.</small>`
            + '<table style="width:100%;border-collapse:collapse;font-size:0.9em;text-align:left;"><thead><tr style="text-align:left;">'
            + '<th style="width:4em;">Grade</th><th>Entry</th><th style="width:9em;">surfaced by</th><th style="width:4em;">best#</th><th style="width:4em;">cos</th><th style="width:4em;">text</th><th style="width:4em;">keys</th></tr></thead><tbody>'
            // Block + bestRank order WITHIN a section. Fused scores are not comparable across arms, so
            // bestRank is the only cross-arm quantity that means the same thing in every row (see
            // gradeOrder) — and it is not comparable across SCENES either, which is why the ordering is
            // per section rather than over the flattened list.
            + secs.map((sc, si) => (multi
                ? `<tr><td colspan="7" style="padding:0.9em 0.25em 0.35em;border-top:2px solid var(--SmartThemeBorderColor);">`
                  + `<b>${esc(sc.name ?? sc.file ?? `scene ${si + 1}`)}</b>`
                  + `<small style="opacity:0.6;"> — ${sc.union.rows.filter(r => r.block === 'dynamic').length} gradeable, ${split[si].known.length} pre-filled</small>`
                  + queryBlocksFor(sc) + `</td></tr>`
                : '')
            + gradeOrder(sc.union.rows, r => r.bestRank ?? Infinity).map(({ row, i: rowI }) => {
                const i = flatIndex.get(`${si}:${row.book}:${row.uid}`);
                const priorOf = split[si].priorOf;
                // TWO KEYS. `priorOf` comes from splitGraded and is keyed by plain rowKey within a scene;
                // the DOM key is section-qualified, because the same entry appears against several scenes
                // and an unqualified one would carry a typed value onto another section's row on repaint.
                const pkey = rowKey(row);
                const key = `${si}${String.fromCharCode(31)}${pkey}`;
                const num = n => (n == null ? '·' : String(n));
                const done = priorOf.has(pkey);
                // Prior rows are inputs too, pre-filled with the earlier grade: an edit re-emits
                // the row as a fresh grade and mergeGrades is last-wins, so the edit overrides the prior.
                // A carried-over edit stays dirty across repaints, or the next repaint would revert it.
                //
                // Reference rows are LISTED, NOT GRADED, exactly as /wa-grade shows them. unionArms now
                // keeps them so the sample is complete; declining to grade them is this layer's call, and
                // it has to be made here or the grader is asked to judge an always-on entry.
                const cell = row.block !== 'dynamic'
                    ? `<span style="opacity:0.5;font-size:0.85em;">${row.block === 'constant' ? 'const' : 'sticky'}</span>`
                    : `<input type="number" class="wa-grade text_pole" data-key="${esc(key)}" data-i="${i}" min="0" max="4" step="1" ${typed.has(key) ? 'data-dirty="1" ' : ''}value="${esc(typed.get(key) ?? (done ? priorOf.get(pkey) : ''))}" placeholder="—" title="${esc(GRADE_ANCHORS.map((a, g) => `${g}: ${a}`).join('\n'))}" style="width:4em;padding:2px 4px;">`;
                return `<tr style="border-top:1px solid var(--SmartThemeBorderColor);${done ? 'opacity:0.55;' : ''}">`
                    + `<td>${cell}</td>`
                    // wiGlyph, as /wa-grade and the Explorer use it. It matters most in THIS table:
                    // whether a row can carry a keys signal at all depends on being a 🔗 vector entry,
                    // and a non-null cosine is the wrong tell — one that failed retrieval shows none.
                    + `<td>${row.cut ? `<i class="fa-solid fa-scissors" style="opacity:0.55;margin-right:0.35em;" title="cut by the budget${row.cutBy ? ` — ${esc(row.cutBy)} cap` : ''}${row.tokens ? `; ${row.tokens} tokens` : ''}"></i>` : ''}${flat[i].entry ? wiGlyph(flat[i].entry) + ' ' : ''}${esc(row.title)}<br><small style="opacity:0.5;">${esc(row.book)} · uid ${num(row.uid)}</small>${keyHitsHtml(row.why)}<br><i class="fa-solid fa-chevron-right wa-chevron wa-fold" data-i="${i}" title="Show keys and entry text" style="margin-top:0.35em;"></i></td>`
                    // Which arms surfaced a row is the pooling diagnostic: rows only one arm found are where
                    // the overlap assumption is failing, and they are why that arm is in the list. The arm
                    // that SUPPLIED the numbers is underlined, because the signal columns are one arm's
                    // measurements and a six-arm list beside them otherwise reads as "all of these agree".
                    + `<td><small style="opacity:0.7;">${row.arms.map(a => (a === row.from ? `<u>${esc(a)}</u>` : esc(a))).join(', ')}</small></td>`
                    // A borrowed signal is marked with the arm it came from: absent-filled, never blended,
                    // so the reader can tell a measurement from a fill (see unionArms).
                    + `<td>${num(row.bestRank)}</td>${['cosine', 'text', 'keys'].map(s => `<td>${num(row.scores?.[s])}${row.filled?.[s] ? `<br><small style="opacity:0.5;font-size:0.75em;" title="filled from the ${esc(row.filled[s])} arm — this arm could not measure it">${esc(row.filled[s])}</small>` : ''}</td>`).join('')}`
                    + `</tr>`
                    + `<tr class="wa-foldrow" data-i="${i}" style="display:none;"><td colspan="7" style="padding:0.5em 0.75em 0.9em;">${entryFoldHtml(flat[i].entry, i)}</td></tr>`;
            }).join('')).join('')
            + '</tbody></table>';

        wireFolds(body, i => flat[i].entry);
        // BOTH CONTAINERS: one section renders its scene text into `head`, many render into `body`.
        for (const root of [head, body]) {
            root.querySelectorAll('.wa-scene-pop').forEach(pop => pop.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();          // inside a <summary>, or the click also toggles the fold
                const hit = sceneText[Number(pop.dataset.i)];
                if (hit) showEntryText({ content: hit.text, comment: hit.label });
            }));
        }
        // A user edit marks the input dirty; only dirty values survive a repaint (see `typed` above).
        body.querySelectorAll('.wa-grade').forEach(input => input.addEventListener('input', () => { input.dataset.dirty = '1'; }));
    };

    // The prior-load picker is a single-scene control: a multi-scene review's grades arrive in the
    // files themselves, so it is not rendered and must not be wired.
    head.querySelector('.wa-sg-pick')?.addEventListener('click', () => head.querySelector('.wa-sg-prior').click());
    head.querySelector('.wa-sg-prior')?.addEventListener('change', async event => {
        const loaded = [];
        let added = 0;
        const names = [];
        for (const file of event.target.files ?? []) {
            try {
                const parsed = JSON.parse(await file.text());
                // Two shapes through one picker: a previous round's sample/bundle (subtract its grades) or an
                // offline pool request (ADD its entries). Told apart by which array is present.
                if (Array.isArray(parsed?.pending)) {
                    for (const row of parsed.pending) {
                        const key = rowKey(row);
                        if (union.rows.some(r => rowKey(r) === key)) continue;
                        const entry = entryOf(row.book, row.uid);
                        union.rows.push({
                            title: entry?.comment || row.title, book: row.book, uid: row.uid,
                            block: 'dynamic', sticky: 0, score: null, cosine: null, text: null, keys: null,
                            // Labelled so the grader can see this row came from a rebuilt index rather than a
                            // live arm — it is being judged for a configuration this machine isn't running.
                            arms: [`offline: ${(row.doses ?? []).length || '?'} dose(s)`],
                            bestRank: row.bestRank ?? null,
                        });
                        union.entries.push(entry);
                        added++;
                    }
                } else if (Array.isArray(parsed?.scenes)) {
                    // openBundle, not `parsed.grades`: v3 keeps verdicts on the scene's entries, and this
                    // is the one place a previous round's file is read back in the browser.
                    const priorSample = openBundle(parsed);
                    // THE SCENE GUARD. Prior grades are pooled by `rowKey`, which is book + uid — so
                    // without this, loading ANY graded bundle attaches its verdicts to whatever scene is
                    // being graded, and they are written straight through to the new sample. Not
                    // hypothetical: one scene's rows landed on another scene captured minutes later, at
                    // their original values (G9). A book test would have missed the commoner case, two
                    // scenes of one book, since those rows name the same books.
                    //
                    // ANY ARM, because the arms of one capture differ in `query` (the summary arm builds
                    // its own) while sharing the scene. Skipped rather than thrown: one wrong file in a
                    // multi-select should not lose the rest of the load.
                    const off = captures.map(c => sceneDiff(c, priorSample)).sort((x, y) => x.length - y.length)[0] ?? ['query'];
                    if (off.length) {
                        toastr.warning(`${file.name} was graded against a different scene (${off.join(', ')} differ) — ignored, or its verdicts would be attached to this one`, 'Worlds Apart', { timeOut: 8000 });
                        continue;
                    }
                    loaded.push(...(priorSample.entries ?? []));
                } else {
                    toastr.warning(`${file.name} has neither graded scenes nor "pending" — ignored`, 'Worlds Apart');
                    continue;
                }
                names.push(file.name);
            } catch {
                toastr.warning(`Could not parse ${file.name} — ignored`, 'Worlds Apart');
            }
        }
        prior = mergeGrades(prior, loaded, { user: raterId(), now: today() });
        head.querySelector('.wa-sg-loaded').textContent = names.length
            ? `${names.length} file(s): ${prior.length} prior grade(s)${added ? `, ${added} entry(ies) requested offline` : ''}`
            : 'no usable files — nothing loaded';
        toastr.info(`${prior.length} prior grade(s)${added ? `, ${added} entr(y/ies) requested offline` : ''}`, 'Worlds Apart', { timeOut: 3000 });
        paint();
    });

    paint();

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { customButtons: [{
        // No `result`, so it acts on the form and leaves the popup open — a pass ends with this and then
        // Save. Sits beside the confirm buttons because it is the LAST thing done, not a table control.
        text: 'Fill blanks with 0', icon: 'fa-0',
        tooltip: 'Every untouched row becomes a graded 0. Leave a row blank to record it as UNGRADED instead.',
        action: () => {
            const { filled, undo } = fillReadZeros(body);
            if (!filled) { toastr.info('No blank rows to fill.', 'Worlds Apart'); return; }
            toastr.success(`Filled ${filled} blank row(s) with 0. Click to undo.`, 'Worlds Apart', {
                timeOut: 10000, extendedTimeOut: 10000,
                onclick: () => { const n = undo(); toastr.info(`Reverted ${n} row(s) to ungraded.`, 'Worlds Apart'); },
            });
        },
    }], okButton, cancelButton: 'Cancel', large: true, wide: true, allowVerticalScrolling: true });
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    // Blank means ungraded, not 0 — see the /wa-grade collector.
    //
    // DIRTY ONLY, because a human verdict means a human set it. A prior row arrives pre-filled and is
    // never blank, so emitting every non-blank input made opening a review and saving it sign every row
    // in the table, including ones nobody read — and a judge-only row carries no human verdict precisely
    // so that "no human has looked at this" stays readable. mergeGrades APPENDS, so a row skipping
    // `fresh` gains nothing and a row in it replaces nothing.
    // dataset.dirty survives a repaint (see `typed` in paint).
    const edited = [...body.querySelectorAll('.wa-grade')]
        .filter(input => String(input.value).trim() !== '' && input.dataset.dirty)
        .map(input => {
            const { sec, row } = flat[Number(input.dataset.i)];
            return { sec, g: { title: row.title, grade: Number(input.value), book: row.book, uid: row.uid } };
        });
    const who = { user: raterId(), now: today() };
    // PER SECTION, because mergeGrades keys on world+uid and a shared merge would let one scene's verdict
    // land on another scene's row for the same entry. Each section merges onto its own prior and comes back with
    // the file it belongs to, which is what apply-review.mjs needs to put it anywhere.
    if (multi) {
        return {
            sections: secs.map((sc, si) => ({
                file: sc.file ?? sc.name,
                grades: mergeGrades(sc.prior ?? [], edited.filter(e => e.sec === si).map(e => e.g), who),
            })),
            edited: edited.length,
        };
    }
    return { grades: mergeGrades(prior, edited.map(e => e.g), who), prior };
}

export async function superGradeScene(named) {
    // Sharable dumps need content to be re-indexable by anyone but their author (see above), so a downgrade
    // is allowed but never silent.

    const wanted = Math.max(1, Number(named?.candidates ?? 30));
    const picked = String(named?.arms ?? '').trim()
        ? String(named.arms).split(/[,\s]+/).filter(Boolean)
        : Object.keys(POOL_ARMS);
    const unknown = picked.filter(a => !POOL_ARMS[a]);
    if (unknown.length) {
        toastr.warning(`Unknown arm(s): ${unknown.join(', ')}. Known: ${Object.keys(POOL_ARMS).join(', ')}`, 'Worlds Apart');
        return '';
    }

    const captures = [];
    for (const [n, arm] of picked.entries()) {
        toastr.info(`Arm ${n + 1}/${picked.length}: ${arm}`, 'Worlds Apart', { timeOut: 2500 });
        // Sequential, not Promise.all: the arms share one live settings object and one retrieval pipeline.
        const cap = await captureArm(POOL_ARMS[arm], wanted);
        if (!cap.rows.length) {
            console.warn(`Worlds Apart: arm "${arm}" activated nothing — skipped`);
            continue;
        }
        // Keyword-only under this arm: a sample without a query can't be scored offline (see gradeScene).
        if (!cap.query) {
            console.warn(`Worlds Apart: arm "${arm}" retrieved nothing (no query to freeze) — skipped`);
            continue;
        }
        // CONVERTED HERE, so everything downstream — unionArms, the popup, the sample writer — reads a
        // candidate. /wa-debug's row keeps its flat signals for `console.table`; this is the crossing.
        captures.push({ arm, ...cap, rows: (cap.rows ?? []).map(toCandidate) });
    }

    if (!captures.length) {
        toastr.warning('No arm activated anything — nothing to grade.', 'Worlds Apart');
        return '';
    }

    const union = unionArms(captures);
    // Tested on the gradeable subset, not on the union: since unionArms keeps durable rows, a scene with
    // nothing but constants now has a non-empty union and would have opened an ungradeable popup.
    if (!union.rows.some(r => r.block === 'dynamic')) {
        toastr.warning('Every activated row was constant or a persisting sticky — relevance chose nothing to grade.', 'Worlds Apart');
        return '';
    }

    // Loaded BEFORE the popup, not after: an offline pool request names entries no arm surfaced, so the
    // grading table has to resolve them from the book to show their text.
    const books = {};
    for (const world of runState.attachedWorlds) {
        const data = await loadWorldInfo(world);
        if (data?.entries) {
            books[world] = keyByUid(data.entries);
        }
    }
    const entryOf = (world, uid) => Object.values(books[world] ?? {}).find(e => Number(e.uid) === Number(uid));

    const done = await superGradePopup({ captures, union, entryOf });
    if (!done) {
        return '';
    }
    const { grades, prior } = done;

    const base = named?.name || defaultSampleName();
    const wav = waVersion();
    const stv = await stVersion();
    const built = [];
    for (const cap of captures) {
        // Per arm, because a lexical-only arm can retrieve from a different book than the hybrid one — and the
        // harness loads exactly one collection, so getting this wrong keys a sample to a collection that
        // contributed nothing.
        const primaryBook = searchedBook(cap.rows) ?? host.chatBook() ?? Object.keys(books)[0] ?? '';
        const sample = buildSample({
            name: `${base}--${cap.arm}`,
            notes: named?.notes || `Arm "${cap.arm}" of a ${captures.length}-arm pooled grading (${captures.map(c => c.arm).join(', ')}); ${grades.length} grades pooled across arms and rounds.`,
            query: cap.query,
            queryChat: cap.queryChat,
            scanChat: cap.scanChat,
            injects: cap.injects,
            sources: matcher.usedMatchSources(cap.sources, Object.values(books).flatMap(b => Object.values(b))),
            depth: cap.depth,
            pluginFP: runState.pluginFP,
            sourceFP: runState.sourceFP,
            waVersion: wav,
            stVersion: stv,
            chat: chatFilePath(),
            book: primaryBook ? `data/default-user/worlds/${primaryBook}.json` : '',
            index: primaryBook ? vectorIndexPath(primaryBook) : '',
            primaryBook,
            embedModel: host.vectorRequestBody().model || '',
            params: cap.params,
            snapshot: cap.snapshot,
            candidates: cap.rows,
            books,
            priority: (host.scopedPriority() ?? []).map(x => x.cfg),
            grades,
            cutoff: {
                live: cap.live,
                gradingOverride: { maxVectorEntries: wanted },
            },
            // Every non-durable row of every arm is in the union, and the union is graded in full — so
            // unlike /wa-grade this is an exact count of judged rows rather than a conservative proxy.
            // Counts what a human was actually offered — constants excepted, stickies included, matching
            // the two grading tables. It is the boundary the harness reads to know where grades stop.
            gradedCandidates: cap.rows.filter(r => r.block === 'dynamic').length,
            now: new Date().toISOString(),
        });
        built.push({ arm: cap.arm, sample });
    }

    // ONE download. The arms share the grades and — overwhelmingly the bulk of the bytes — the embedded book
    // copies, so N files meant N browser download prompts and N duplicates of a 300-entry lorebook.
    const bundle = await bundleSamples(built, { ...sceneRange(), user: raterId(), captureId: uuidv4() });
    const { filename, content } = sampleFile({ ...bundle, name: base });
    download(content, filename, 'application/json');
    console.log(`Worlds Apart: ${built.length}-arm bundle -> ${filename}`, bundle);

    const above = grades.filter(g => gradeValue(g) > 0).length;
    toastr.success(
        `Saved ${filename} — ${built.length} arms in one file, ${union.rows.length} rows this round, ${grades.length} pooled, ${above} above 0. `
        + 'Move it to eval/eval-data/ and run graded-scene-grid.mjs --sample (add --arm to pick one); watch judged@10.',
        'Worlds Apart', { timeOut: 12000 },
    );
    return '';
}

/**
 * Opens the browser file picker for JSON. Resolves [] when the user cancels. `multiple` picks a batch.
 *
 * The click needs live user activation, and a slash command run with no chat open spends it: ST creates
 * an Assistant chat first, and by the time the callback runs the gesture has expired. The picker is then
 * silently ignored — no `change`, no `cancel` — so the promise never settles and the command hangs. The
 * timeout turns that into a message. A native dialog takes focus off the document, so still having it is
 * what says nothing opened.
 */
const pickJsonFiles = ({ multiple = false } = {}) => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
    // ponytail: focus heuristic, 2s. A dialog that opens without taking focus would be mistaken for a
    // blocked one; nothing cheaper distinguishes them, since a blocked click fires no event at all.
    setTimeout(() => {
        if (!document.hasFocus()) return;
        toastr.warning('The browser blocked the file picker — run it again now that the chat is open.', 'Worlds Apart');
        resolve([]);
    }, 2000);
});

/**
 * /wa-super-eval — chat-independent review of N graded samples/bundles: the super-grade shell, fed entirely
 * from files. Nothing live is read — no chat, no attached books, no settings — so a scene captured
 * offline (or by someone else, or by an LLM judge) can be reviewed without loading the chat it came from.
 * Entry text resolves from each bundle's embedded books and stored grades arrive pre-filled and editable.
 *
 * ONE SECTION PER BUNDLE, ONE SAVE FILE PER RUN. Grading N scenes was N imports and would have been N
 * download prompts; the save is a single file that `eval/synthetic-data/apply-review.mjs` writes back
 * into eval-data. It is SELF-CONTAINED, as a grading bundle is: each section carries the scene, and each
 * graded row the entry text and the judge verdicts it was weighed against, so the review can be read
 * without the bundle it came from. Only graded rows carry that, so it stays small.
 *
 * A PACK — a file whose top level is an ARRAY of bundles — becomes one section per element, so a
 * shortlist spanning N scenes is one pick rather than N. `eval/synthetic-data/slice-bundles.mjs` emits
 * one. Each element names the bundle it was cut from, and that name is what the save records, so a pack
 * of sliced copies still applies to the real bundles in eval-data.
 */
export async function superEvalScene() {
    const files = await pickJsonFiles({ multiple: true });
    if (!files.length) {
        return '';
    }
    // A bad file is skipped by name rather than aborting the batch — picking 15 and losing all of them to
    // one stale export is the failure this command exists to avoid.
    const bundles = [];
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(await file.text());
        } catch {
            toastr.warning(`Could not parse ${file.name} — skipped`, 'Worlds Apart');
            continue;
        }
        for (const m of (Array.isArray(parsed) ? parsed : [parsed])) bundles.push({ name: m?.file ?? file.name, manifest: m });
    }
    const secs = [];
    for (const { name: fileName, manifest } of bundles) {
        // Every arm as a flat sample, through the one adapter. v3 ONLY: the migration was one-shot and
        // took the compatibility path with it, so a pre-v3 pack throws in `openBundle` and lands in the
        // skip below, one toast per section and no mention of the version.
        const names = armNames(manifest);
        const arms = (names.length ? names : [null]).map(n => { try { return openBundle(manifest, n); } catch { return null; } }).filter(Boolean);
        if (!arms.length || !arms[0].candidates?.length || !Array.isArray(arms[0].entries)) {
            toastr.warning(`${fileName} is not a graded scene — skipped`, 'Worlds Apart');
            continue;
        }
        const books = manifest.books ?? {};
        const entryOf = (world, uid) => Object.values(books[world] ?? {}).find(e => Number(e.uid) === Number(uid));
        const captures = arms.map((a, i) => ({
            arm: names[i] ?? manifest.name ?? 'capture',
            rows: a.candidates ?? [],
            entries: (a.candidates ?? []).map(r => entryOf(r.book, r.uid) ?? null),
            query: a.query ?? '',
            depth: a.depth ?? '?',
        }));
        const union = unionArms(captures);
        if (!union.rows.some(r => r.block === 'dynamic')) {
            toastr.warning(`${fileName} has no gradeable rows — skipped`, 'Worlds Apart');
            continue;
        }
        secs.push({ file: fileName, name: manifest.name ?? fileName, manifest, captures, union, entryOf, prior: arms[0].entries });
    }
    if (!secs.length) {
        toastr.warning('No usable graded bundles in that selection.', 'Worlds Apart');
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
            ? `Reviewing ${secs[0].file} (${manifest.createdBy ?? 'unknown grader'}) — loaded from file, no chat required.`
            : `Reviewing ${secs.length} bundles — loaded from files, no chat required.`,
        okButton: 'Save review',
    });
    if (!done) {
        return '';
    }

    // ONE FILE OUT, whatever the section count. N bundle downloads is the same annoyance as N manual
    // imports pointed the other way, which is the whole reason this takes a batch.
    //
    // A REVIEW IS STANDALONE, the same way a grading bundle is: everything needed to interpret a verdict
    // travels with it — the scene the row was graded against, the entry text it was graded on, and what
    // the judges had said. A file recording only {file, grades} is a diff against eval-data, so reading
    // it a month later means finding the exact bundle it was cut from and hoping nothing moved. Only the
    // GRADED rows carry that weight, which is what keeps it cheap: forty rows, not the union.
    //
    // `captureId` is what apply-review.mjs writes back THROUGH, because a basename is a name a user may
    // change and a mis-landed review is not recoverable — the grades look native once written. `file`
    // stays as provenance and as the fallback, but nothing about reading the review depends on it.
    //
    // WHICH RATER GRADED A ROW IS READ OFF WHICH ARRAY THE VERDICT SITS IN: `humanGrades` is written by a
    // person alone, `llmGrades` by a judge alone. A row with both was reviewed; judge verdicts alone mean
    // no human has looked. The shell's rows drop extra fields, so the judge's history is re-attached here
    // per section from the document the section came from.
    const reviewed = done.sections.map((sec, si) => {
        const src = openBundle(secs[si].manifest);
        const priorOf = new Map((src.entries ?? []).map(g => [rowKey(g), g]));
        return {
            // WHAT THE SECTION CAME FROM, id first. `file` is a basename and a well-meaning rename breaks
            // it; `captureId` survives one, and apply-review resolves on it. Both are written because the
            // id only helps if the target document still carries it.
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
                    ...(p.llmGrades ? { llmGrades: p.llmGrades } : {}),
                    // Named for the reviewer rather than the entry, because apply-review strips it: the
                    // bundle's own books are where entry text belongs, and a second copy on the grade row
                    // is the kind of duplicate that goes stale without anyone noticing.
                    ...(entry?.content ? { entryText: String(entry.content) } : {}),
                };
            }),
        };
    });
    const all = reviewed.flatMap(r => r.grades);
    const rel = all.filter(g => gradeValue(g) >= 3).length;
    // WHEN THE REVIEW WAS PASSED, to the millisecond — apply-review stamps every verdict with this, so a
    // day would make two reviews in one day one pass, and taking the CLI's own run time would record the
    // verdict as passed whenever someone got round to applying it. `fileStamp` is the day, for the name
    // only: a filename is not a record of an instant.
    const reviewedAt = new Date().toISOString();
    const stamp = reviewedAt.slice(0, 10);
    // Named for WHAT was reviewed, dated last so a directory of them sorts by subject and not by day.
    // One scene is identified by its own name — which already carries chat and message — and a batch by
    // its size, because a common prefix across fifteen scenes is not an identity anyone would recognise.
    const slug = String(reviewed.length === 1 ? (secs[0].name ?? secs[0].file.replace(/\.json$/, '')) : `${reviewed.length}-scenes`)
        .trim().replace(/\.json$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'scenes';
    const filename = `review-${slug}-${stamp}.json`;
    // `createdBy` so a verdict can say what produced it: a human grade arrives three ways, and nothing
    // downstream could tell them apart without it.
    // WHO PASSED THESE VERDICTS, written here because this is where it is known. Without it apply-review had
    // to be told by hand, and its `--user` defaulted to empty — which signed every verdict as nobody and,
    // since a pass key is rater + instant, matched nothing on a re-run and appended the whole review again.
    download(JSON.stringify({ reviewed, gradeScale: GRADE_SCALE, createdBy: 'wa-super-eval', user: raterId(), reviewedAt }, null, 1), filename, 'application/json');

    // A GRADED BUNDLE BESIDE THE REVIEW: the same merge apply-review does, done here so a capture graded
    // in one sitting is scoreable without a round trip through eval-data — apply-review resolves a
    // section's bundle BY CAPTURE ID over eval-data alone, so a bundle held anywhere else has to be moved
    // there first. The review cannot substitute: it carries verdicts and no arm membership, so nothing
    // offline can tell which arm delivered a row.
    //
    // Agreement is over the rows a human actually reviewed — those carrying BOTH kinds of verdict.
    // Filtering on the judge's alone would drag in every untouched judge row and report it as a
    // disagreement, since it has no human verdict rather than a matching one.
    //
    // Each side resolved by its own rule: the human's LATEST against the judges' MEDIAN, which is what
    // `gradeValue` would return if the other array were absent. Comparing a stored scalar to a stored
    // scalar is what this used to do, and there are no stored scalars any more.
    const both = all.filter(g => (g.llmGrades ?? []).length && (g.humanGrades ?? []).length);
    const pairs = both.map(g => [gradeValue({ humanGrades: g.humanGrades }), gradeValue({ llmGrades: g.llmGrades })]);
    const irr = pairs.length
        ? ` LLM agreement: ${pairs.filter(([h, j]) => h === j).length}/${pairs.length} exact, ${pairs.filter(([h, j]) => Math.abs(h - j) <= 1).length}/${pairs.length} within 1.`
        : '';
    toastr.success(`Saved ${filename} — ${done.edited} row(s) edited across ${reviewed.length} scene(s), ${rel} relevant (>=3).${irr} Apply with: node eval/synthetic-data/apply-review.mjs --write`, 'Worlds Apart', { timeOut: 15000 });
    return '';
}
