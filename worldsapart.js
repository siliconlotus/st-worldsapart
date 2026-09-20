// worldsapart.js — the ST-coupled half: hooks WORLDINFO_ENTRIES_LOADED, generate_interceptor and
// WORLDINFO_SCAN_DONE to take World Info selection, ranking and budget over from core.

import {
    eventSource,
    event_types,
    getRequestHeaders,
    getMaxPromptTokens,
    is_send_press,
    saveSettingsDebounced,
    substituteParams,
    getExtensionPromptByName,
    extension_prompt_types,
    name1,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { t } from '../../../i18n.js';

import { checkWorldInfo, getSortedEntries, getWorldInfoPrompt, world_names, world_info_include_names, world_info_depth, world_info_max_recursion_steps, world_info_min_activations, world_info_match_whole_words, world_info_case_sensitive, world_info_recursive, selected_world_info, world_info, METADATA_KEY, scan_state } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { getStringHash, escapeHtml, getCharaFilename } from '../../../utils.js';
import { pluginFingerprint, PLUGIN_FILES } from './plugin/fingerprint.mjs';
import { admitCeiling } from './plugin/scoring.mjs';
import * as query from './extension/query.mjs';
import * as entity from './extension/entity.mjs';
import * as matcher from './extension/matcher.mjs';
import { macroMap, registerKeys, resetSmartKeys, setMacros } from './extension/smartkeys.mjs';
import * as selection from './extension/selection.mjs';
import * as layout from './extension/layout.mjs';
import * as delivery from './extension/delivery.mjs';
import { getTokenCountAsync, getTokenizerModel } from '../../../tokenizers.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { oai_settings } from '../../../openai.js';

import { runState, defaultSettings, settings, ensureSettings } from './extension/state.mjs';
import { ensureStudioStyle, makeSortControl, makeTierEditor, pluginFallback, showEntryText, wiGlyph, wiTooltip } from './st/ui-widgets.mjs';
import { PRESENTATION_ALIAS, normPresentation, presentationBaseLabel, reconcileTiers, wiTitleOf } from './extension/sort.mjs';
import { lorebookStudio } from './st/studio.mjs';
import { setCaptureHost, versusCore, gradeScene, superGradeScene, superEvalScene, waVersion, extensionIdentity, POOL_ARMS } from './st/capture-ui.mjs';
import { isDurable } from './extension/grading.mjs';
import { setLanguage, refreshIndex, table } from './extension/lang.mjs';
import { packStore, fetchIndex, fetchPack } from './st/lang-store.mjs';

import { chunkEntry } from './extension/chunking.mjs';
import { buildContentIndex, scoreContent, indexFingerprint, entryKey } from './extension/content-lexical.mjs';
import { buildNameDf, properNames, properShared, properDensity, scoreRelevance, isMemory, fitKey, queryPrefix, postDates, UNFITTED_FALLBACK } from './extension/relevance.mjs';

/** Base of the rewritten `order` sequence, parked above any authored value and ST's default of 100. */
const ORDER_BASE = 99000;

/** A line narrating one turn's own run: off by default, on under `debugLog` and during either slash-command run.
 *  ST's own dry runs fire on every chat load, so they stay silent unless the setting is on. */
const dbg = (...args) => { if (settings().debugLog || runState.dryRunInProgress) console.log(...args); };

// Vector backend — Vector Storage's provider config and ST's own endpoints.

/** Request body for /api/vector/*, from Vector Storage's provider settings.
 *  ponytail: the model key is `${source}_model` except for the cases below; add a case when a provider breaks the pattern. */
function vectorRequestBody(args = {}) {
    const v = extension_settings.vectors ?? {};
    const source = v.source || 'transformers';
    const body = Object.assign({ source }, args);
    const altUrl = (type) => (v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[type]);

    switch (source) {
        case 'extras':
            body.extrasUrl = extension_settings.apiUrl;
            body.extrasKey = extension_settings.apiKey;
            break;
        case 'ollama':
            body.model = v.ollama_model;
            body.apiUrl = altUrl(textgen_types.OLLAMA);
            body.keep = !!v.ollama_keep;
            break;
        case 'llamacpp':
            body.apiUrl = altUrl(textgen_types.LLAMACPP);
            break;
        case 'vllm':
            body.model = v.vllm_model;
            body.apiUrl = altUrl(textgen_types.VLLM);
            break;
        case 'palm':
            body.model = v.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = v.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        case 'workers_ai':
            body.model = v.workers_ai_model || '@cf/baai/bge-m3';
            body.workers_ai_account_id = oai_settings.workers_ai_account_id;
            break;
        case 'siliconflow':
            body.model = v.siliconflow_model;
            body.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
            break;
        default:
            body.model = v[`${source}_model`];
            break;
    }

    return body;
}

/** Mirrors Vector Storage's embed endpoint and model into the Vector Match panel. */
function updateEmbedInfo() {
    const b = vectorRequestBody();
    const endpoint = b.apiUrl || b.extrasUrl || b.siliconflow_endpoint || b.source;
    const model = b.model || t`(provider default)`;
    $('#wa_embed_info').text(t`Embed: ${endpoint} · ${model}`);
}

// Time bounds for the generation path's fetches. A query is one embedding round-trip — legitimate answers arrive in
// well under ten seconds, so past that the endpoint is wedged and the stock fallback or the cosine-free fit is the
// better turn. The bulk embed is the exception: its bound is a hang-detector, not a patience bound, because the
// server finishes and persists the embed regardless of the client, and the next turn's `list` picks the chunks up.
const QUERY_TIMEOUT_MS = 10_000;
const SYNC_TIMEOUT_MS = 300_000;

async function vectorPost(route, args, timeoutMs = QUERY_TIMEOUT_MS) {
    const response = await fetch(`/api/vector/${route}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(vectorRequestBody(args)),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        throw new Error(`WorldsApart: /api/vector/${route} failed with ${response.status}`);
    }

    return response.status === 200 && response.headers.get('content-type')?.includes('json')
        ? await response.json()
        : null;
}


/** Whether the WA server plugin is loaded, checked once; absent is the stock install, not an error. */
async function hasPlugin() {
    if (runState.pluginAvailable !== null) {
        return runState.pluginAvailable;
    }

    try {
        // The extension's own folder name, decoded: a pathname is percent-encoded and a folder name is not.
        const dir = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/\/$/, '').split('/').pop();
        const response = await fetch('/api/plugins/worlds-apart/ping', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ dir }), signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
        runState.pluginAvailable = response.ok;
        if (response.ok) { try { const d = await response.json(); runState.pluginRoot = d?.root ?? null; runState.pluginFP = d?.fingerprint ?? null; } catch { /* older plugin: no root/fingerprint fields */ } }
    } catch {
        runState.pluginAvailable = false;
    }

    console.log(`WorldsApart: server plugin ${runState.pluginAvailable ? 'detected — mean-centered search available' : 'not found, using stock vector search'}`);
    return runState.pluginAvailable;
}

/** Fingerprint of this extension's source plugin files, hashed exactly as the plugin hashes its deployed copy; cached. */
async function computeSourceFingerprint() {
    if (runState.sourceFP !== null) return runState.sourceFP;
    try {
        const texts = await Promise.all(
            // `r.ok` checked, or a 404 hashes the error page: a fetch only rejects at the network layer, so a
            // PLUGIN_FILES entry naming a missing file would fingerprint as drift for ever.
            PLUGIN_FILES.map(([src]) => fetch(new URL(`./plugin/${src}`, import.meta.url), { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) })
                .then(r => { if (!r.ok) throw new Error(`${src}: ${r.status}`); return r.text(); })),
        );
        runState.sourceFP = pluginFingerprint(...texts);
    } catch (error) { console.warn('WorldsApart: could not fingerprint the plugin source, drift unknown —', error); runState.sourceFP = null; }
    return runState.sourceFP;
}

/** The deployed plugin is not the source this extension ships. A null fingerprint — a plugin predating the field, or a
 *  source file that would not load — reads as no drift: the check cannot tell, and a false alarm is worse. */
const pluginDrifted = () => Boolean(runState.pluginAvailable && runState.sourceFP && runState.pluginFP !== runState.sourceFP);

/** Fills the plugin setup box with copyable install and redeploy commands, and the drift banner. */
function renderPluginSetup() {
    const box = $('#wa_plugin_setup');
    if (!box.length) return;
    const extDir = new URL('.', import.meta.url).pathname.replace(/\/+$/, '').split('/').pop();
    const rel = `public/scripts/extensions/third-party/${extDir}/deploy-plugin.mjs`;
    const deployCmd = runState.pluginRoot ? `node "${runState.pluginRoot.replace(/\\/g, '/')}/${rel}"` : `node ${rel}`;
    const row = (cmd) => {
        const r = $('<div class="flex-container alignItemsCenter flexnowrap" style="gap:6px;margin:3px 0;"></div>');
        const code = $('<code style="flex:1;overflow-x:auto;white-space:nowrap;padding:2px 6px;border-radius:4px;background:var(--black30a,rgba(0,0,0,0.2));"></code>').text(cmd);
        const btn = $('<div class="menu_button fa-solid fa-copy" title="Copy" data-i18n="[title]Copy" style="margin:0;flex:0 0 auto;"></div>');
        btn.on('click', async () => {
            try { await navigator.clipboard.writeText(cmd); } catch { /* clipboard blocked; user can select the text */ }
            btn.removeClass('fa-copy').addClass('fa-check');
            setTimeout(() => btn.removeClass('fa-check').addClass('fa-copy'), 1200);
        });
        return r.append(code, btn);
    };
    const alert = $('#wa_plugin_alert').empty();
    // Top of the drawer, so neither state needs the setup box open to be seen.
    const AMBER = 'var(--golden, #e0a86c)', RED = '#e06c6c';
    const banner = (...children) => $('<div style="margin:0 0 8px;padding:6px 8px;border-radius:5px;font-size:0.9em;background:color-mix(in srgb, var(--golden, #e0a86c) 15%, transparent);border:1px solid color-mix(in srgb, var(--golden, #e0a86c) 45%, transparent);"></div>').append(...children);
    const line = (text, colour) => $(`<div style="color:${colour};"></div>`).text(text);
    box.empty();
    if (runState.pluginAvailable === null) { box.text(t`Checking for server plugin…`); return; }
    if (runState.pluginAvailable) {
        const stale = pluginDrifted();
        const warn = t`⚠ Server plugin out of date — the deployed copy differs from this extension's source. Redeploy and restart:`;
        // One box and one command for both facts: a route that failed this load, in red, above the drift it comes with.
        const lines = [];
        const routes = [...runState.pluginFailures].join(', ');
        if (routes) lines.push(line(t`⚠ Server plugin has demonstrated incompatibility with this extension version; WA is falling back to running without it wherever it fails (${routes}).`, RED));
        if (stale) lines.push(line(warn, AMBER));
        if (lines.length) alert.append(banner(...lines, row(deployCmd)));
        if (stale) {
            box.append(line(warn, AMBER));
            box.append(row(deployCmd));
            return;
        }
        box.append($('<div style="color:var(--active,#7ac);"></div>').text(runState.sourceFP ? t`✓ Server plugin active — up to date (build ${runState.sourceFP}).` : t`✓ Server plugin active.`));
        box.append($('<div style="margin-top:3px;"></div>').text(t`After editing plugin code, redeploy and restart SillyTavern:`));
        box.append(row(deployCmd));
        return;
    }
    const absent = t`⚠ Server plugin not installed — retrieval runs on ST's own vector search, without mean-centering or server-side pooling.`;
    alert.append(banner(line(absent, AMBER)));
    box.append($('<div></div>').text(t`${absent} To install:`));
    box.append($('<div style="margin-top:3px;"></div>').text(t`1. Open a terminal in your SillyTavern folder and deploy the plugin (also enables server plugins in config):`));
    box.append(row(deployCmd));
    box.append($('<div style="margin-top:3px;"></div>').text(t`2. Restart SillyTavern. This box will then show the exact redeploy command with your full path.`));
}

/** Multi-collection query through the plugin's mean-centered search, or the no-plugin path (ST's own /api/vector)
 *  when the plugin is absent or errors. */
async function queryCollections(args) {
    // The model's query prefix goes on here and only here: the caller's `searchText` also feeds queryTermWeights.
    const prefix = queryPrefix(vectorRequestBody().model);
    if (prefix) args = { ...args, searchText: prefix + args.searchText };

    // The ceiling is chosen per path here, since the no-plugin path can fire mid-request. Gated on the plugin's
    // presence, not on `meanCentered`, which is a plugin parameter.
    if (await hasPlugin()) {
        try {
            const body = vectorRequestBody({ ...args, topK: admitCeiling(true) });
            const response = await fetch('/api/plugins/worlds-apart/query-multi', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ...body,
                    centered: settings().meanCentered,
                    // Every provider field minus the query fields; narrowing it makes a provider fail on a missing setting.
                    sourceSettings: (({ collectionIds, searchText, centroidUids, topK, ...rest }) => rest)(body),
                }),
                signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
            });

            if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
            const results = await response.json();
            // Only what stage 1 reads: a scored metadata array per collection answered. Anything more is fine.
            if (!results || typeof results !== 'object' || !Object.values(results).every(g => Array.isArray(g?.metadata) && g.metadata.every(x => typeof x?.score === 'number'))) throw new Error('unscored or missing metadata');
            return results;
        } catch (error) {
            pluginFallback('query-multi', error);
        }
    }

    // No threshold and no server-side pooling here, so K counts chunks.
    return await vectorPost('query-multi', { ...args, topK: admitCeiling(false) }) ?? {};
}

// Retrieval

/** Unit Separator — see CLAUDE.md. The same literal grading.mjs's rowKey and studio.mjs's rowId join with. */
const US = '';

/** Chunks a book's entries and brings its vector collection in sync with them.
 *  @returns {Promise<{collectionId: string, owners: Map<number, string[]>}>} owners: chunk hash -> `${world}.${uid}` */
async function syncWorld(world, entries) {
    const collectionId = `wa_${getStringHash(world)}`;
    const saved = await vectorPost('list', { collectionId }) ?? [];

    const items = [];
    /** @type {Map<number, string[]>} A list, because identical (text, uid) in two attached books collides once scoreEntriesUnsafe merges these. */
    const owners = new Map();

    for (const entry of entries) {
        for (const chunk of chunkEntry(entry.content, settings())) {
            const text = chunk.trim();
            if (!text) {
                continue;
            }
            // Identity is (text, uid): core lists and deletes by hash alone, so two entries sharing a chunk need distinct hashes.
            const hash = getStringHash(`${text}${entry.uid}`);
            // A dot, not US: this is core's own `${world}.${uid}` key, which onScanDone looks up in runState.lastScores.
            owners.set(hash, [`${entry.world}.${entry.uid}`]);
            items.push({ hash, text, index: entry.uid });
        }
    }

    const wanted = new Set(items.map(x => x.hash));
    let newItems = items.filter(x => !saved.includes(x.hash));
    const staleHashes = saved.filter(x => !wanted.has(x));

    // The chat-bound book with no rows yet is usually STMemoryBooks' copy-on-branch clone: the plugin copies what a sibling
    // collection holds for the same (text, uid) instead of re-embedding it. Never runs again once the collection has rows.
    if (!saved.length && newItems.length && world === chatBook() && await hasPlugin()) {
        try {
            const sourceSettings = vectorRequestBody();
            const response = await fetch('/api/plugins/worlds-apart/adopt', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ collectionId, hashes: newItems.map(x => x.hash), source: sourceSettings.source, sourceSettings }),
                signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`${response.status}`);
            const j = await response.json();
            if (!Array.isArray(j?.adopted)) throw new Error('no adopted list');
            const adopted = new Set(j.adopted);
            if (adopted.size) {
                newItems = newItems.filter(x => !adopted.has(x.hash));
                console.log(`WorldsApart: adopted ${adopted.size} chunks for "${world}" from another collection under the same model`);
            }
        } catch (error) {
            pluginFallback('adopt', error);
        }
    }

    if (newItems.length) {
        console.log(`WorldsApart: embedding ${newItems.length} new chunks for "${world}"`);
        let announced = false;
        const slow = setTimeout(() => {
            announced = true;
            toastr.info(t`Embedding ${newItems.length} chunks for "${world}". A large embedding model can make the first sync of a big book take several minutes.`, 'WorldsApart', { timeOut: 15000 });
        }, 3000);
        const started = Date.now();
        try {
            await vectorPost('insert', { collectionId, items: newItems }, SYNC_TIMEOUT_MS);
        } finally {
            clearTimeout(slow);
        }
        const secs = Math.round((Date.now() - started) / 1000);
        if (announced) toastr.success(t`Embedded ${newItems.length} chunks for "${world}" in ${secs}s.`, 'WorldsApart', { timeOut: 5000 });
    }

    if (staleHashes.length) {
        console.log(`WorldsApart: dropping ${staleHashes.length} stale chunks for "${world}"`);
        await vectorPost('delete', { collectionId, hashes: staleHashes });
    }

    return { collectionId, owners };
}

const buildTermWeights = (queryText, gazetteer) => entity.buildTermWeights(queryText, gazetteer, settings().properNounBoost);

/** @type {Map<string, {fingerprint: string, index: object, nameDf: object|null}>} Per-book content-lexical and name indexes, rebuilt when the book's fingerprint moves. */
const contentIndexes = new Map();

/** Both per-book indexes over one book's entries behind one fingerprint; the name index only when `names` is set.
 *  `buildContentIndex` excludes disabled entries and `buildNameDf` includes them, and their N differ, so neither may be read for the other. */
function bookIndexes(world, entries, { names = false } = {}) {
    const fingerprint = indexFingerprint(entries, settings());
    const hit = contentIndexes.get(world);
    if (hit?.fingerprint === fingerprint && (!names || hit.nameDf)) return hit;
    const index = hit?.fingerprint === fingerprint ? hit.index : buildContentIndex(entries, settings());
    const nameDf = names ? buildNameDf(entries) : hit?.fingerprint === fingerprint ? hit.nameDf : null;
    const fresh = { fingerprint, index, nameDf };
    contentIndexes.set(world, fresh);
    if (hit?.fingerprint !== fingerprint) {
        console.log(`WorldsApart: content-lexical index for "${world}" — ${index.entryCount} entries, ${index.docCount} chunks`);
    }
    if (names && nameDf && nameDf !== hit?.nameDf) {
        console.log(`WorldsApart: name index for "${world}" — ${nameDf.ndoc} entries, ${nameDf.df.size} distinct names`);
    }
    return fresh;
}

/** Vector collections on disk that no lorebook in `world_names` hashes to, plus live books built under another
 *  source or model. Reports, never deletes.
 *  @returns {Promise<{unclaimed: object[], staleConfig: object[], live: object[], bytes: number}|null>} */
async function findOrphanCollections() {
    if (!await hasPlugin()) return null;
    let all;
    try {
        const response = await fetch('/api/plugins/worlds-apart/collections', { method: 'POST', headers: getRequestHeaders() });
        if (!response.ok) throw new Error(`${response.status}`);
        all = await response.json();
        // Every field the report reads, on every row.
        if (!Array.isArray(all) || !all.every(c => typeof c?.collectionId === 'string' && typeof c?.source === 'string' && typeof c?.model === 'string' && typeof c?.bytes === 'number' && typeof c?.mtimeMs === 'number')) throw new Error('rows missing fields');
    } catch (error) {
        pluginFallback('collections', error);
        return null;
    }
    const claimed = new Set((world_names ?? []).map(n => `wa_${getStringHash(n)}`));
    const v = extension_settings.vectors ?? {};
    const source = v.source || 'transformers';
    // Per source, not a `??` chain: `ollama_model` carries a non-empty default, so a chain reads it under any source.
    const model = String(({ ollama: v.ollama_model, vllm: v.vllm_model })[source] ?? v[`${source}_model`] ?? '');
    const unclaimed = [], staleConfig = [], live = [];
    for (const c of all) {
        if (!claimed.has(c.collectionId)) unclaimed.push(c);
        else if (c.source !== source || (model && c.model !== model)) staleConfig.push(c);
        else live.push(c);
    }
    return { unclaimed, staleConfig, live, bytes: all.reduce((a, c) => a + c.bytes, 0) };
}

const mib = b => `${(b / 1048576).toFixed(1)} MiB`;

/** Prints the orphan report and returns a one-line summary for the panel. */
async function reportOrphanCollections() {
    const found = await findOrphanCollections();
    if (!found) return t`Needs the server plugin.`;
    const { unclaimed, staleConfig, live, bytes } = found;
    const table = rows => rows.map(c => ({ collection: c.collectionId, source: c.source, model: c.model, size: mib(c.bytes), lastWritten: new Date(c.mtimeMs).toISOString().slice(0, 10) }));
    console.log(`%cWorldsApart · vector collections — ${mib(bytes)} total`, 'font-weight: bold');
    if (live.length) { console.log(`in use by a book you still have, at the current source/model (${live.length}):`); console.table(table(live)); }
    if (staleConfig.length) { console.log(`the book still exists, but these were built under another source or model (${staleConfig.length}) — switching back would use them again:`); console.table(table(staleConfig)); }
    if (unclaimed.length) { console.log(`NO lorebook hashes to these (${unclaimed.length}) — renamed or deleted books. Nothing will ever read them again:`); console.table(table(unclaimed)); }
    const dead = unclaimed.reduce((a, c) => a + c.bytes, 0);
    const stale = staleConfig.reduce((a, c) => a + c.bytes, 0);
    const n = live.length + staleConfig.length + unclaimed.length;
    return unclaimed.length || staleConfig.length
        ? t`${mib(bytes)} in ${n} collections — ${mib(dead)} unclaimed, ${mib(stale)} on another source/model. Listed in the console; delete by hand from data/<user>/vectors/.`
        : t`${mib(bytes)} in ${live.length} collection(s), all claimed.`;
}

/** Per-tier relevance fits for the current embedding model — fetched, never a JSON import; `null` is cached so a 404 is not re-fetched. */
const relevanceModel = { promise: null, value: null, key: null };

function loadRelevanceModel() {
    // Keyed by embedding model: Vector Storage switches model without a page load.
    const key = fitKey(vectorRequestBody());
    if (relevanceModel.key !== key) {
        relevanceModel.key = key;
        relevanceModel.promise = null;
        relevanceModel.value = null;
    }
    // One fit per tier, never shared: the coefficients differ in sign across tiers (F19).
    relevanceModel.promise ??= Promise.all(['memory', 'reference'].map(tier =>
        fetch(new URL(`./extension/relevance-model-${tier}.json`, import.meta.url), { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) })
            .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((file) => {
                // Own fit, else UNFITTED_FALLBACK's, else `noCosine` for a turn with no cosine (no-plugin path, retrieval outage).
                const m = file?.byModel?.[key] ?? file?.byModel?.[UNFITTED_FALLBACK] ?? file?.noCosine ?? null;
                if (m) m.noCosine = file?.noCosine ?? null;
                if (m && !file?.byModel?.[key]) {
                    console.warn(`WorldsApart: no ${tier} relevance fit for embedding model "${key}" — `
                        + `scoring through "${UNFITTED_FALLBACK}"'s (have: ${Object.keys(file?.byModel ?? {}).join(', ') || 'none'}). `
                        + 'Fit this one with eval/relevance-regress.mjs --emit-model.');
                }
                if (!m) {
                    console.warn(`WorldsApart: no ${tier} relevance model for embedding model "${key}" `
                        + `(have: ${Object.keys(file?.byModel ?? {}).join(', ') || 'none'}) — that tier's E[credit] will not be scored, `
                        + `so nothing is cut on relevance. Fit one with eval/relevance-regress.mjs --emit-model.`);
                    return [tier, null];
                }
                console.log(`WorldsApart: relevance model — ${m.tier} tier, ${m.features?.join(', ')}, fitted under ${m.embedModel} (its own best cutoff was ${m.cutoff}; the cut runs at the relevanceCutoff setting)`);
                return [tier, m];
            })
            .catch((e) => {
                console.warn(`WorldsApart: no ${tier} relevance model, that tier's E[credit] will not be scored —`, e.message);
                return [tier, null];
            })))
        .then((pairs) => {
            // Kept resolved: the synchronous paramSnapshot names the fits a capture's eCredit column came out of.
            relevanceModel.value = Object.fromEntries(pairs);
            return relevanceModel.value;
        });
    return relevanceModel.promise;
}

/** Every entry of every book in the scan, grouped by book — the population the per-book statistics are of. */
const entriesByWorld = async (entries = null) => Map.groupBy(entries ?? await getSortedEntries(), e => e.world);

/**
 * Fills the stage-4 relevance column: `properNouns`, `density`, then `E[credit]` per entry. Cuts nothing.
 * @param {Function} windowFor The scan window builder; eval/scene.mjs `haystackFor` calls the same one with the same inputs
 */
async function scoreRelevanceColumn(items, windowFor, entries = null) {
    const models = await loadRelevanceModel();
    if (!models || !windowFor) return;

    const byWorld = await entriesByWorld(entries);

    const depth = Number(settings().messageDepth || world_info_depth);
    const windowNames = properNames(windowFor(depth, {}).join('\n'));

    for (const item of items) {
        const book = bookIndexes(item.entry.world, byWorld.get(item.entry.world) ?? [], { names: true }).nameDf;
        const names = book?.names.get(entryKey(item.entry)) ?? properNames(item.entry.content);
        item.properNouns = book ? properShared(names, windowNames, book) : 0;
        item.density = properDensity(item.entry.content);
    }

    // Per tier: a tier only ever meets its own coefficients.
    for (const [tier, model] of Object.entries(models)) {
        if (!model) continue;
        const rows = items.filter(it => (isMemory(it.entry) ? 'memory' : 'reference') === tier);
        if (!rows.length) continue;
        // Chosen against the rows, not settings: the plugin can fall back mid-request.
        const fit = rows.some(it => Number.isFinite(it.score)) ? model : (model.noCosine ?? model);
        const col = it => ({
            cosine: Number.isFinite(it.score) ? it.score : 0,
            text: Number(it.textScore) || 0,
            keys: Number(it.keywordScore) || 0,
            properNouns: Number(it.properNouns) || 0,
            density: Number(it.density) || 0,
        });
        // The fit's own population (`standardise`), minus constants, as both calibration sites build it.
        const population = (fit.standardise === 'pooled' ? items : rows).filter(it => !it.entry?.constant).map(col);
        const eCredit = scoreRelevance(fit, rows.map(col), population);
        rows.forEach((it, i) => { it.eCredit = eCredit[i]; it.eCreditTier = tier; });
    }

    if (runState.verboseRun) {
        const scored = items.filter(it => Number.isFinite(it.eCredit));
        const cuts = Object.entries(models).filter(([, m]) => m).map(([t]) => `${t} >= ${settings().relevanceCutoff}`).join(', ');
        console.log(`%cWorldsApart · E[credit] over ${scored.length} entries — ${cuts}; the cut runs at selection`, 'font-weight: bold');
        console.table([...scored]
            .sort((a, b) => b.eCredit - a.eCredit)
            .map(it => ({
                entry: it.entry.comment || it.entry.key?.[0] || it.entry.uid,
                tier: it.eCreditTier,
                eCredit: Number(it.eCredit.toFixed(4)),
                clears: it.eCredit >= settings().relevanceCutoff,
                cosine: Number.isFinite(it.score) ? Number(it.score.toFixed(4)) : null,
                text: Number((it.textScore ?? 0).toFixed(3)),
                properNouns: Number(it.properNouns.toFixed(3)),
                density: Number(it.density.toFixed(2)),
            })));
    }
}

/** BM25 of the query against every entry's content — the stage-3 text signal.
 *  @returns {Promise<Map<string, number>>} `${world}.${uid}` -> best chunk score; empty when unavailable */
async function contentTextScores(query, entries = null) {
    if (!query) return new Map();
    entries ??= await getSortedEntries();
    const byWorld = await entriesByWorld(entries);
    if (!byWorld.size) return new Map();

    const s = settings();
    const termWeights = await queryTermWeights(query, { entries });
    const opts = { k1: s.bm25K1, b: s.bm25B, termWeights, stopwordDf: s.stopwordDocFreq };
    const out = new Map();
    for (const [world, entries] of byWorld) {
        for (const [key, score] of scoreContent(bookIndexes(world, entries).index, query, opts)) {
            const prev = out.get(key);
            if (prev === undefined || score > prev) out.set(key, score);
        }
    }
    return out;
}

/** The entity-filter term weights for a query, or null when the filter is off. Nothing else derives them (R19).
 *  @returns {Promise<Record<string, number>|null>} */
async function queryTermWeights(searchText, { entries = null } = {}) {
    if (!settings().entityFilter) {
        return null;
    }

    // The authored keys, not the takeover's blanks: getSortedEntries fires WORLDINFO_ENTRIES_LOADED. A local view, never a write-back.
    const authored = entry => (entry.waKeys || entry.waSecondary)
        ? { ...entry, key: entry.key?.length ? entry.key : (entry.waKeys ?? []), keysecondary: entry.keysecondary?.length ? entry.keysecondary : (entry.waSecondary ?? []) }
        : entry;
    const gazetteer = entity.buildGazetteer((entries ?? await getSortedEntries()).map(authored));
    const termWeights = buildTermWeights(searchText, gazetteer);

    if (runState.verboseRun) {
        const byWeight = Object.entries(termWeights).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        console.log(`WorldsApart: entity filter kept ${byWeight.length} terms (gazetteer has ${gazetteer.size})`);
        console.log(`%cWorldsApart · surviving query terms — what the entity filter kept, ×N is the proper-noun boost (${byWeight.length} terms)`, 'font-weight: bold');
        console.log(byWeight.map(([term, weight]) => (weight > 1 ? `${term}×${weight}` : term)).join(' '));
    }

    return termWeights;
}

/** Serialises retrieval so a query cannot read a half-built index. */
let retrievalQueue = Promise.resolve();

/** Scores every entry with content against arbitrary query text; shared by retrieval and /wa-query.
 *  @returns {Promise<{targets: object[], scores: Map<string, {score: number, chunk: string}>, retrieved: Set<string>}>}
 *           `retrieved` is stage 2's admission set, `scores` the stage-3 cosine column; the no-plugin path fills only the first. */
function scoreEntries(searchText) {
    const run = () => scoreEntriesUnsafe(searchText);
    const result = retrievalQueue.then(run, run);
    // The catch is on the queue, not on `result`: `return result.catch(...)` would make a failure look like retrieve()'s empties.
    retrievalQueue = result.catch(() => {});
    return result;
}

async function scoreEntriesUnsafe(searchText) {
    const allEntries = await getSortedEntries();
    // Every entry with content, not only the vectorized: `vectorized` decides what stage 1 retrieves, a cosine is a column stage 3 reads (F35).
    const targets = allEntries.filter(x => !x.disable && x.content);
    /** @type {Map<string, {score: number, chunk: string}>} */
    const scores = new Map();
    /** @type {Set<string>} Every owner the query returned, scored or not — the same `${world}.${uid}` keys `scores` uses. */
    const retrieved = new Set();

    if (!targets.length || !searchText) {
        return { targets, scores, retrieved };
    }

    const byWorld = Map.groupBy(targets, e => e.world);

    const collectionIds = [];
    /** @type {Map<string, string[]>} `${collectionId}${US}${hash}` -> owning `${world}.${uid}`s; keyed by collection too, since by hash alone the pooling below would credit an owner with another book's score. */
    const owners = new Map();

    for (const [world, entries] of byWorld) {
        const synced = await syncWorld(world, entries);
        collectionIds.push(synced.collectionId);
        synced.owners.forEach((v, k) => owners.set(`${synced.collectionId}${US}${k}`, v));
    }

    // The centroid is the memory tier, per collection; measured flat against `vectorized` (F44).
    const centroidUids = {};
    for (const [world, entries] of byWorld) {
        centroidUids[`wa_${getStringHash(world)}`] = entries.filter(isMemory).map(e => Number(e.uid));
    }

    const results = await queryCollections({
        collectionIds,
        searchText,
        centroidUids,
    });

    // The max is a no-op against a current plugin (one pooled record per entry) and keeps an un-redeployed one, which
    // still returns raw chunks, pooling. `rankOnly` counts chunks with no score: the no-plugin path answered.
    let rankOnly = 0;
    for (const [collectionId, group] of Object.entries(results)) {
        const metadata = group?.metadata ?? [];
        metadata.forEach((item, index) => {
            // Every owner of the chunk, not one: the store keeps one row per hash.
            const chunkOwners = owners.get(`${collectionId}${US}${Number(item?.hash)}`);
            if (!chunkOwners?.length) {
                return;
            }

            // Admission is retrieval identity, not magnitude: the no-plugin path returns the same chunks, so the same
            // entries are stage-2 candidates whichever path answered. The Set is the pooling — K counts chunks there.
            for (const owner of chunkOwners) retrieved.add(owner);

            // No invented score: ST's endpoint drops it, and a rank substitute feeds the fit a number in another unit.
            const score = typeof item?.score === 'number' ? item.score : null;
            if (score === null) { rankOnly++; return; }

            for (const owner of chunkOwners) {
                const previous = scores.get(owner);

                if (!previous || previous.score < score) {
                    scores.set(owner, { score, chunk: String(item?.text ?? '') });
                }
            }
        });
    }

    // Once per load: running without the plugin is a supported configuration, not a per-turn fault.
    if (rankOnly && !runState.noCosineWarned) {
        runState.noCosineWarned = true;
        console.warn(`WorldsApart: ${rankOnly} chunk(s) came back with no score — the no-plugin path answered, so stage 1 has no cosine. `
            + 'Those entries are still activated; the relevance model is running on text, proper nouns and density alone. '
            + 'Check that the server plugin is loaded and that its query is not failing.');
    }

    return { targets, scores, retrieved };
}

/** Prints /wa-query's table: every scored entry by cosine, with the gap between neighbours. */
function reportVectorCandidates(scores, targets, searchText) {
    const byKey = new Map(targets.map(x => [`${x.world}.${x.uid}`, x]));
    const rows = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
    const spread = rows[0][1].score - rows[Math.min(4, rows.length - 1)][1].score;

    console.log(`WorldsApart: query "${searchText.slice(0, 80)}${searchText.length > 80 ? '\u2026' : ''}" (${searchText.length} chars)`);
    console.log(`WorldsApart: ${rows.length} entries scored, cosine order, top-5 spread ${spread.toFixed(5)}`);
    console.log('%cWorldsApart \u00b7 /wa-query \u2014 every scored entry by cosine, best first', 'font-weight: bold');
    console.table(rows.map(([key, value], index) => ({
        gap: index > 0 ? Number((rows[index - 1][1].score - value.score).toFixed(6)) : null,
        title: byKey.get(key)?.comment,
        '#': index + 1,
        vec: Number(value.score.toFixed(5)),
        matchedChunk: value.chunk.slice(0, 70).replace(/\s+/g, ' '),
    })));
}

/** Retrieval over the chat; returns the vectorized entries that scored. The emit is selectAndActivate's. */
async function retrieve(chat) {
    runState.lastScores.clear();
    // Cleared, not just reassigned below: the no-query-text return sits ABOVE that assignment, so a turn with nothing
    // to query on would otherwise leave the PREVIOUS turn's standing for contentTextScores to score BM25 against.
    runState.lastQuery = '';
    runState.lastQueryChat = [];

    // One substitution pass serves both the query and the /wa-grade stash: queryMessages must not run twice per generation.
    const queryChat = query.queryMessages(chat, { depth: settings().messageDepth, substituteParams });
    const rawText = query.joinQueryMessages(queryChat);

    if (!rawText) {
        dbg('WorldsApart: no query text, skipping retrieval');
        return [];
    }

    const searchText = rawText;
    dbg(`WorldsApart: query is ${searchText.length} chars from ${settings().messageDepth} message(s), matched against ~${settings().chunkSize}-char entry chunks`);

    // Before the empties below: a keyword-only scene is still gradeable against the query.
    runState.lastQuery = searchText;
    // ST's own {name, mes} shape, so query.buildQuery can re-run offline at any depth <= this one; not recoverable by splitting `lastQuery`.
    runState.lastQueryChat = queryChat;

    // No entity filter here: stage 1 has no BM25 to spend its terms on (plugin/scoring.mjs).
    const { targets, scores, retrieved } = await scoreEntries(searchText);

    if (!targets.length) {
        console.log('WorldsApart: no entries with content in the active books, so retrieval has nothing to score');
        return [];
    }
    if (!retrieved.size) {
        dbg('WorldsApart: the query matched no chunk in any collection');
        return [];
    }

    // Only a `vectorized` entry is force-activated; every scored entry keeps its cosine for stage 3.
    const vectorizedKeys = new Set(targets.filter(x => x.vectorized).map(x => `${x.world}.${x.uid}`));
    const winnerKeys = new Set([...retrieved].filter(k => vectorizedKeys.has(k)));

    // Every scored entry, not the winners: stage 3 looks its cosine up here.
    for (const [key, value] of scores) {
        runState.lastScores.set(key, value.score);
    }

    return targets.filter(x => winnerKeys.has(`${x.world}.${x.uid}`));
}

/** The macro map for this scan, `{{token}}` -> value over every key the entries carry, evaluated now: {{char}} moves per speaker in a group. */
function applyMacros(entries) {
    const keys = entries.flatMap(e => [...(e.key ?? []), ...(e.keysecondary ?? []), ...(e.waKeys ?? []), ...(e.waSecondary ?? [])]);
    runState.lastMacros = macroMap(keys, substituteParams);
    setMacros(runState.lastMacros);
}

/** The entries WA's own matcher activates over its window; candidacy and the verdict live in matcher.mjs activationAdds. */
async function keywordActivations(chat) {
    const candidates = await getSortedEntries();

    // Live keys: waOwnsScan is false during this fetch, so onEntriesLoaded does not blank them. The SCAN_DONE feed rematches on these.
    runState.waCandidates = candidates;

    const { windowFor } = await scanWindowFor(chat);

    applyMacros(candidates);
    // Register every key up front, secondaries included (K13): a first-seen key mid-loop rebuilds the automaton and drops every cached scan.
    registerKeys(candidates.flatMap(e => {
        const keys = e.disable ? [] : matcher.usableKeys(e.key);
        return keys.length ? [...keys, ...matcher.secondaryKeys(e)] : [];
    }));

    return matcher.activationAdds(candidates, windowFor, activationOpts());
}

/** Distinct failures already surfaced this session, keyed stage␟message (US, never NUL — see CLAUDE.md). */
const reportedFailures = new Set();

/**
 * Toasts a generation-time failure with the top stack frame — once per distinct message per session, or, when `loud`,
 * on every occurrence and stuck until dismissed.
 * @param {string} consequence What the user will observe this turn
 * @param {'error'|'warning'} [severity]
 */
function reportFailure(stage, consequence, error, severity = 'error', loud = false) {
    console.error(`WorldsApart: ${stage} — ${consequence}`, error);
    const cause = String(error?.message ?? error);
    const key = `${stage}${US}${cause}`;
    if (!loud && reportedFailures.has(key)) return;
    reportedFailures.add(key);
    const frame = String(error?.stack ?? '').split('\n')[1]?.trim().replace(/^at\s+/, '');
    // ST sets toastr.options.escapeHtml = true globally, which collapses `\n`; opt out per toast and escape by hand.
    toastr[severity](
        [escapeHtml(consequence),
            escapeHtml(cause) + (frame ? `<br>&nbsp;&nbsp;at ${escapeHtml(frame)}` : ''),
            t`See the browser console for the full trace.`].join('<br><br>'),
        `WorldsApart: ${stage}`,
        { timeOut: loud ? 0 : 20000, extendedTimeOut: loud ? 0 : 15000, escapeHtml: false, closeButton: true, tapToDismiss: !loud },
    );
}

/** Stages 1 and 2: retrieval winners ∪ keyword adds, one FORCE_ACTIVATE emit. The two routes fail independently.
 *  `token` is the generation's identity: after every await a superseded generation bails rather than write scan
 *  state or emit activations into whoever's prompt is now current. A stop bumps the token, so it supersedes too. */
async function selectAndActivate(chat, token) {
    const superseded = () => token !== runState.scanToken;

    chat = dropChatTags(chat);

    // /wa-dry reaches here without the interceptor, so the replayed scan judges the chat it was handed.
    runState.scanChat = chat.slice();

    // waOwnsScan FALSE first: WA's own getSortedEntries calls below fire WORLDINFO_ENTRIES_LOADED, and the blanking must not eat the keys WA matches on.
    runState.waOwnsScan = false;
    runState.waMatched = new Set();
    runState.waRecursionTexts = [];
    runState.waRecursionDepth = 0;
    runState.waMinSkew = 0;
    runState.waCandidates = null;

    let winners = [];
    try {
        winners = await retrieve(chat);
    } catch (error) {
        reportFailure(t`retrieval failed`,
            t`No vectorized entry is activated this turn, so an entry with no keys is absent from the prompt rather than ranked lower. Every entry loses its cosine, and relevance falls back to the cosine-free fit. Keyword matching and constants are unaffected.`,
            error);
        runState.lastScores.clear();
    }
    if (superseded()) return;

    let adds = [];
    try {
        adds = await keywordActivations(chat);
    } catch (error) {
        // Total: waOwnsScan is set below regardless, so core does not match either.
        reportFailure(t`keyword activation failed`,
            t`No entry will activate by key this turn. WA has taken over key matching, so SillyTavern will not match them either — the prompt has only retrieved, constant and sticky entries.`,
            error);
    }
    if (superseded()) return;

    const winnerKeys = new Set(winners.map(e => `${e.world}.${e.uid}`));
    const union = adds.filter(e => !winnerKeys.has(`${e.world}.${e.uid}`));

    const activated = [...winners, ...union];
    if (activated.length) {
        dbg(`WorldsApart: activating ${winners.length} retrieved + ${union.length} keyword-matched entries`);
        await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, activated);
    }
    if (superseded()) return;

    // TRUE last, after WA's own fetches: the next WORLDINFO_ENTRIES_LOADED is core's scan. Cleared on the final SCAN_DONE loop and at generation end.
    for (const e of activated) runState.waMatched.add(`${e.world}.${e.uid}`);
    runState.armedToken = token;
    runState.waOwnsScan = true;
}

// Hooks

/** Generation interceptor. ST calls it (chat, contextSize, abort, type); `abort` is a setter that CANCELS the
 *  generation, never a reader, so it is not taken. Quiet generations scan like visible ones; ST skips its dry runs. */
async function intercept(chat, _maxContext, _abort, type) {
    // A quiet generation never displaces one the user has in flight: it stands down and runs core-native.
    // is_send_press is the send lock the UI paths hold; Generate('quiet') sets it only later, at the prompt build.
    if (type === 'quiet' && is_send_press) {
        return;
    }

    // Before the gates: this chat IS core's scan haystack (regex applied, files appended). Sliced so ST's later in-place splices cannot shift it.
    const token = ++runState.scanToken;
    runState.scanChat = chat.slice();
    // Before the gate: a takeover flag leaked from an aborted scan would blank a disabled generation's keys.
    runState.waOwnsScan = false;

    if (!settings().enabled) {
        return;
    }

    await selectAndActivate(chat, token);
}


/** Blinds core's keyword matcher on a scan WA owns — keys stashed on `waKeys`/`waSecondary`, then blanked — and takes
 *  the budget off core. REASSIGN `key`, never mutate it: the array is loadWorldInfo's cache. */
function onEntriesLoaded(loaded) {
    if (runState.inCoreProbe) return;   // the exemption is lifted on purpose mid-probe
    const entries = Object.values(loaded ?? {}).filter(Array.isArray).flat();

    showExemptCount(entries);

    // Read here and nowhere else: this hook is the last place the `@@` lines still exist. Ungated, a promotion being a property of the entry.
    for (const entry of entries) entry.waPromote = matcher.hasPromoteDecorator(entry);
    for (const entry of entries) entry.waDecorators = matcher.resolveDecorators(entry?.content);

    // Gated: with WA off the install behaves as it would with WA not installed.
    if (settings().enabled) {
        const chatLength = (runState.scanChat ?? getContext().chat ?? []).length;
        // Before the stash below, so waSecondary captures the desugared keysecondary.
        for (const entry of entries) {
            if (entry) Object.assign(entry, matcher.decoratorFields(entry, { chatLength }));
        }
    }

    // Gated on WA actually cutting this generation: core's budget is the backstop on every path where onScanDone returns early.
    if (settings().enabled && !runState.generationIsDryRun) {
        for (const entry of entries) {
            entry.waIgnoreBudget = Boolean(entry.ignoreBudget);   // always set, so authorIgnoreBudget's `??` falls through only on the ungated paths
            entry.ignoreBudget = true;
        }
    }

    if (!settings().enabled) {
        return;
    }

    // Stashed, not deleted, and secondaries too: stage 3 scores the authored keys and gates on the authored condition.
    if (runState.waOwnsScan && !runState.generationIsDryRun) {
        for (const entry of entries) {
            if (!entry || entry.waKeys) continue;   // already stashed and blanked this load
            // Constants and @@activate keep their keys: core short-circuits both before matching, and the inclusion-group filter's getScore reads entry.key.
            if (entry.constant || matcher.hasDecorator(entry, '@@activate')) continue;
            // Copied, not aliased: `entry.key` is loadWorldInfo's cached array.
            entry.waKeys = [...(entry.key ?? [])];
            entry.waSecondary = [...(entry.keysecondary ?? [])];
            entry.key = [];
            entry.keysecondary = [];
        }
    }
}

/** Shows how many entries are exempt from the caps, and refreshes the attached-book set. */
function showExemptCount(entries) {
    // ST's full active set for the chat, so these worlds are the attached books. Before the panel check, so /wa-debug's book line is right with the panel closed.
    runState.attachedWorlds = new Set(entries.map(e => e?.world).filter(Boolean));
    renderWorldPriority();

    const field = $('#wa_exempt_count');

    if (!field.length) {
        return;
    }

    const exempt = entries.filter(delivery.authorIgnoreBudget).length;

    field.text(exempt
        ? t`${exempt} of ${entries.length} entries are marked "ignore budget" — never cut, and not counted toward the entry caps.`
        : '');
}

/** Renders the current character's per-book priority list from settings. */
function renderWorldPriority() {
    const $list = $('#wa_world_priority_list');
    if (!$list.length) {
        return;
    }

    const mode = settings().worldPriorityMode;
    $('#wa_world_priority_mode').val(mode);
    // data-i is the index in the stored list, so edits and reorders land on the right element.
    const scoped = scopedPriority();

    if (scoped == null) {
        $list.empty().append($('<small class="opacity50p"></small>').text(t`No character selected. Lorebook order is per-character. Open a character to set one.`));
        return;
    }
    if (!scoped.length) {
        $list.empty().append($('<small class="opacity50p"></small>').text(t`No lorebooks attached. Open a chat with a lorebook active, or run /wa-dry.`));
        return;
    }

    const showOrder = mode === 'sequential';
    const showTuning = !showOrder;
    $list.empty();
    scoped.forEach(({ cfg, i, world }) => {
        const label = cfg.world === 'chat' ? t`${world} (current chat)` : world;
        const row = $(`
            <div class="flex-container alignItemsCenter flexnowrap wa-world-row" data-i="${i}" style="gap:4px;margin-bottom:2px;">
                <div class="menu_button fa-solid fa-chevron-up wa-world-up ${showOrder ? '' : 'displayNone'}" title="Higher priority" data-i18n="[title]Higher priority"></div>
                <div class="menu_button fa-solid fa-chevron-down wa-world-down ${showOrder ? '' : 'displayNone'}" title="Lower priority" data-i18n="[title]Lower priority"></div>
                <span class="flex1 wa-world-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
                <label class="${showTuning ? '' : 'displayNone'}" title="Relevance multiplier for this book" data-i18n="[title]Relevance multiplier for this book">×<input type="number" class="text_pole wa-world-weight" style="width:4em;" min="0" step="0.1"></label>
                <label class="${showTuning ? '' : 'displayNone'}" title="Prompt-order offset for this book" data-i18n="[title]Prompt-order offset for this book">±<input type="number" class="text_pole wa-world-offset" style="width:4.5em;" step="1"></label>
                <label title="Max dynamic entries from this book (0 = no cap)" data-i18n="[title]Max dynamic entries from this book (0 = no cap)">≤<input type="number" class="text_pole wa-world-cap" style="width:4em;" min="0" step="1"></label>
            </div>`);
        row.find('.wa-world-name').text(label);
        row.find('.wa-world-weight').val(cfg.weight);
        row.find('.wa-world-offset').val(cfg.offset);
        row.find('.wa-world-cap').val(cfg.cap ?? 0);
        $list.append(row);
    });
}

/** The non-chat texts core's scan buffer also matches, per entry opt-in (matchCharacterDescription, …), keyed as
 *  core's globalScanData expects. characterDepthPrompt is left empty, as core's dryRun leaves it. */
function scanSources() {
    const context = getContext();
    const character = context.characters?.[context.characterId];

    return {
        personaDescription: context.powerUserSettings?.persona_description ?? '',
        characterDescription: character?.description ?? '',
        characterPersonality: character?.personality ?? '',
        characterDepthPrompt: '',
        scenario: character?.scenario ?? '',
        creatorNotes: character?.creatorcomment ?? character?.data?.creator_notes ?? '',
    };
}

/** Scan-enabled extension prompts (Author's Note with Scan on, injects with scan: true) — the same text core scans.
 *  @returns {Promise<Array<{key: string, text: string, ambient: boolean, depth: number}>>} `ambient`: no chat position, so no window bounds it (`upstream-st.md` #16) */
async function scanInjects() {
    const prompts = getContext().extensionPrompts ?? {};
    const out = [];

    for (const key of Object.keys(prompts)) {
        if (!prompts[key]?.scan) continue;
        const text = await getExtensionPromptByName(key);
        if (!text) continue;
        out.push({
            key,
            text,
            // Only an IN_CHAT prompt has a chat position; the others' `depth` means nothing as a message index.
            ambient: prompts[key].position !== extension_prompt_types.IN_CHAT,
            depth: Number(prompts[key].depth) || 0,
        });
    }

    return out;
}

/** The one scan window builder for every site, with the ST-side inputs it was built from. is_system messages are
 *  dropped before depth is counted, as core drops them.
 *  @returns {Promise<{windowFor: Function, chat: object[], injects: object[], sources: object}>} */
async function scanWindowFor(chat) {
    const scanChat = chat.filter(x => x && !x.is_system);
    const injects = await scanInjects();
    const sources = scanSources();
    return {
        chat: scanChat,
        injects,
        sources,
        windowFor: matcher.makeWindowFor(scanChat, {
            injects,
            sources,
            matchWindow: settings().matchWindow,
            includeNames: world_info_include_names,
        }),
    };
}

/** Match defaults for both activation passes — live settings and ST globals, so it stays a function read at call time. */
const activationOpts = () => ({
    messageDepth: settings().messageDepth,
    fallbackDepth: world_info_depth,
    caseSensitiveDefault: world_info_case_sensitive,
    wholeWordsDefault: world_info_match_whole_words,
    assistantCount: (runState.scanChat ?? []).filter(m => m && !m.is_user && !m.is_system).length,
    // Raw context chat, NOT runState.scanChat like its neighbours: interceptors receive coreChat, already
    // is_system-filtered and swipe-popped, so scanChat[0] is not reliably the greeting. Message 0's swipe_id
    // IS the greeting index; a card with no alternates has no swipes array.
    greetingIndex: getContext().chat?.[0]?.swipe_id ?? 0,
    personaName: name1,
    chatLength: (runState.scanChat ?? []).length,
    fired: firedLatches(),
});

/** Entries that have fired a latch decorator in this chat. */
function firedLatches() {
    const ctx = getContext();
    return matcher.firedUpTo(ctx.chatMetadata?.[matcher.WA_METADATA_KEY]?.fired, ctx.chat?.length ?? 0);
}

/** Records the activated entries carrying a latch decorator. */
function recordLatches(entries) {
    if (runState.generationIsDryRun || runState.dryRunInProgress) return;
    const ctx = getContext();
    const meta = ctx.chatMetadata;
    if (!meta) return;
    const fired = { ...(meta[matcher.WA_METADATA_KEY]?.fired ?? {}) };
    const before = Object.keys(fired).length;
    // The chat length WHEN it fired, so any later moment is a filter and a rewind past it un-latches.
    const at = ctx.chat?.length ?? 0;
    for (const entry of entries) {
        const key = matcher.latchKey(entry);
        if (matcher.hasLatch(entry) && !(key in fired)) fired[key] = at;
    }
    if (Object.keys(fired).length === before) return;
    meta[matcher.WA_METADATA_KEY] = { ...(meta[matcher.WA_METADATA_KEY] ?? {}), fired };
    ctx.saveMetadata?.();
}

/** The chat WA reads with the `dropChatTags` elements gone — the one strip, at intake. Copies, never an edit of ST's
 *  live chat, and the file prefix is left alone so `extra.fileLength` still counts to the same place. */
function dropChatTags(chat) {
    const spec = settings().dropChatTags;
    if (!spec?.trim()) return chat;
    return chat.map(m => {
        const mes = String(m?.mes ?? '');
        const off = m?.extra?.fileLength || 0;
        return { ...m, mes: mes.slice(0, off) + matcher.dropTags(mes.slice(off), spec) };
    });
}

const keywordScore = (entry, text, keys = entry.key) => matcher.keywordScore(entry, text, keys, {
    k1: settings().bm25K1,
    repeatCurve: settings().repeatCurve,
    repeatR: settings().repeatR,
    caseSensitiveDefault: world_info_case_sensitive,
    wholeWordsDefault: world_info_match_whole_words,
});

/** Stable per-character (or per-group) key for the priority order; null with nothing selected. */
function priorityKey() {
    const ctx = getContext();
    if (ctx.groupId) return `group:${ctx.groupId}`;
    if (ctx.characterId == null) return null;
    return getCharaFilename(ctx.characterId);
}



/** Chat messages as `checkWorldInfo`/`getWorldInfoPrompt` want them: script.js's scan-site strings, most-recent-first. */
const forWI = chat => chat.map(x => (world_info_include_names ? `${x.name}: ${x.mes}` : x.mes)).reverse();

/** The current chat's bound lorebook, or null. The `'chat'` sentinel resolves to this. */
function chatBook() {
    return getContext().chatMetadata?.[METADATA_KEY] || null;
}

/** The current character's saved priority list — the live, mutable reference; null with nothing selected. */
function charPriority() {
    const key = priorityKey();
    if (key == null) return null;
    const byChar = (settings().worldPriorityByChar ??= {});
    byChar[key] ??= [];
    return byChar[key];
}

/** Resolve one entry's book name, turning the `'chat'` sentinel into the live chat book. */
function resolvedName(entry) {
    return entry.world === 'chat' ? chatBook() : entry.world;
}

/** The current character's priority entries attached to this chat, each with its storage index `i` and resolved book
 *  name; null with no character, as against an empty list. */
function scopedPriority() {
    const list = charPriority();
    if (list == null) return null;
    return list
        .map((cfg, i) => ({ cfg, i, world: resolvedName(cfg) }))
        .filter(x => x.world && runState.attachedWorlds.has(x.world));
}

/** Default sequential rank of a book by its ST binding source: global → persona → character → chat → unclassified. Seeds a fresh list only. */
function worldSourceRank(name) {
    if (selected_world_info?.includes(name)) return 0;                       // global (world editor)
    if (power_user.persona_description_lorebook === name) return 1;           // persona
    const ctx = getContext();
    const char = ctx.characters?.[ctx.characterId];
    if (char) {
        if (char.data?.extensions?.world === name) return 2;                 // character (primary)
        const file = getCharaFilename(ctx.characterId);
        if (world_info.charLore?.find(e => e.name === file)?.extraBooks?.includes(name)) return 2; // character (additional)
    }
    if (ctx.chatMetadata?.[METADATA_KEY] === name) return 3;                  // chat
    return 4;
}

/** Register books we haven't seen so the priority UI can list them. Saves once if changed. */
function ensureWorldConfigs(worlds) {
    const list = charPriority();
    if (list == null) return;                                  // no character — nowhere to store
    const book = chatBook();
    const known = new Set(list.map(resolvedName).filter(Boolean));
    const toAdd = [...worlds].filter(w => w != null && !known.has(w));
    if (!toAdd.length) return;
    // The chat's book is stored as the 'chat' sentinel, so the order survives switching chats.
    if (list.length === 0) toAdd.sort((a, b) => worldSourceRank(a) - worldSourceRank(b));
    for (const world of toAdd) list.push({ world: world === book ? 'chat' : world, weight: 1, offset: 0, cap: 0 });
    saveSettingsDebounced();
    renderWorldPriority();
}

/** The per-loop feed on an owned scan: rematches the not-yet-emitted candidates over chat + all recursion content so
 *  far and force-emits the winners; core's next loop admits them through its own gates. Never writes `state.next`
 *  (core schedules the next loop itself in every case WA feeds) and never re-emits (externalActivations persists for the scan). */
async function feedScanLoop(args) {
    const activated = args.activated.entries;
    // Already-activated entries never need an emit, and recording them keeps them out of every rematch.
    for (const key of activated.keys()) runState.waMatched.add(key);

    // preventRecursion filtered here, args.new.successful being the list before core's own filter. Inherits world_info_recursive.
    const newTexts = world_info_recursive
        ? (args?.new?.successful ?? [])
            .filter(e => e && !e.preventRecursion)
            .map(e => String(e.content ?? ''))
            .filter(Boolean)
        : [];
    runState.waRecursionTexts.push(...newTexts);

    // Mirrors core's advanceScan: one message wider per min-activation pass.
    const skewed = args?.state?.next === scan_state.MIN_ACTIVATIONS;
    if (skewed) runState.waMinSkew++;
    // Depth is a property of the pass, not of the entry: a min-activations widening found its match in the chat.
    else if (newTexts.length) runState.waRecursionDepth++;

    if (!newTexts.length && !skewed) {
        return;
    }

    const candidates = runState.waCandidates.filter(e => !runState.waMatched.has(`${e.world}.${e.uid}`));
    if (!candidates.length) {
        return;
    }

    const { windowFor } = await scanWindowFor(runState.scanChat ?? []);

    const adds = matcher.activationAdds(candidates,
        matcher.withExtraTexts(windowFor, runState.waRecursionTexts, settings().matchWindow),
        { ...activationOpts(), depthSkew: runState.waMinSkew });

    if (adds.length) {
        for (const e of adds) {
            runState.waMatched.add(`${e.world}.${e.uid}`);
            e.waTriggerDepth = runState.waRecursionDepth;
        }
        dbg(`WorldsApart: activating ${adds.length} keyword-matched entr${adds.length === 1 ? 'y' : 'ies'} on scan loop ${args?.state?.loopCount} (${newTexts.length ? 'recursion text' : 'min-activations widening'})`);
        await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, adds);
    }
}

/** Records what core selected while WA stood down — core's shipped set, WORLDINFO_SCAN_DONE firing after its budget loop. */
function recordCoreSet(activated, args, how) {
    runState.lastCoreSet = {
        at: (getContext().chat ?? []).length,
        how,
        budget: args?.budget?.current ?? null,
        entries: [...activated.entries()].map(([key, entry]) => ({
            key, uid: entry.uid, world: entry.world,
            title: entry.comment || entry.key?.[0] || `uid ${entry.uid}`,
            order: entry.waOriginalOrder ?? entry.order ?? 0,
            constant: Boolean(entry.constant),
        })),
    };
}

/** What ST core selects for this turn with WA standing down: `inCoreProbe` makes onEntriesLoaded return before it blinds
 *  core's keys or takes the budget, so checkWorldInfo reads the authored entries, and it suppresses re-entry via
 *  WORLDINFO_SCAN_DONE. Nothing is saved and restored here: getSortedEntries hands every caller a fresh structuredClone,
 *  so writing `ignoreBudget` on a local copy could not reach the set checkWorldInfo fetches for itself.
 *  @returns {Promise<{entries: object[], viaVectors: boolean, vectorsRan: boolean}>} */
async function coreSelection() {
    const chat = (runState.scanChat ?? getContext().chat ?? []).filter(x => x && !x.is_system);
    let core;
    const viaVectors = Boolean(extension_settings.vectors?.enabled_world_info);
    let vectorsRan = false;
    runState.inCoreProbe = true;
    try {
        // A copy: an interceptor may rearrange what it is handed.
        if (viaVectors && typeof globalThis.vectors_rearrangeChat === 'function') {
            try { await globalThis.vectors_rearrangeChat([...chat], getMaxPromptTokens(), null, 'normal'); vectorsRan = true; }
            catch (error) { console.warn('WorldsApart: Vector Storage declined the probe, core will answer on keywords alone —', error); }
        }
        // Strings, as `checkWorldInfo` takes them; `vectors_rearrangeChat` above wanted message objects.
        core = await checkWorldInfo(forWI(chat), getMaxPromptTokens(), true, { ...scanSources(), trigger: 'normal' });
    } finally {
        runState.inCoreProbe = false;
    }
    return { entries: [...(core?.allActivatedEntries ?? [])], viaVectors, vectorsRan };
}


/** Whether this scan's map is the one that ships: core's loop ends on a falsy `next`, EXCEPT on the
 *  max-recursion-steps break, which ends it with `next` still set. */
function isLastLoop(args) {
    return !args?.state?.next
        || (world_info_max_recursion_steps > 0 && world_info_max_recursion_steps <= (args?.state?.loopCount ?? 0));
}

async function onScanDone(args) {
    const activated = args?.activated?.entries;

    // Silent except under /wa-dry, which otherwise could not tell an empty selection from a declined scan.
    const skip = reason => { if (runState.dryRunInProgress) console.warn(`WorldsApart: did not rank this scan — ${reason}.`); };

    if (!(activated instanceof Map)) {
        skip('the scan carried no activation map');
        return;
    }
    if (runState.inCoreProbe) return;   // core is answering for /wa-versus; ranking it would re-enter
    if (!settings().enabled) {
        recordCoreSet(activated, args, 'WA disabled — core in full, interceptors live');
        return;
    }
    if (runState.generationIsDryRun) {
        skip('it is an ST dry generation');
        // Recorded, never ranked: ranking a keyword-only scan would overwrite the panel and the /wa-dry state.
        recordCoreSet(activated, args, 'ST dry run — keyword route only, interceptors skipped');
        return;
    }

    // A scan ranks only when its generation is the armed one. A superseded generation's late scan — its interceptor
    // bailed, so core matched natively — must not rank with the current generation's scores.
    if (runState.armedToken !== runState.scanToken) {
        skip('the scan is not the armed generation\'s');
        recordCoreSet(activated, args, 'superseded or unarmed generation — core in full');
        return;
    }

    // Past the gates the scan is WA's — the takeover has stashed core's keys and stood core's budget down — so a throw
    // must not pass silently: nothing undecided ships, and the failure is loud on every turn it happens.
    try {
        await rankOwnedScan(activated, args, skip);
    } catch (error) {
        // Last loop only, as every other delete is: core re-activates what it no longer holds, and asks for one more loop.
        if (isLastLoop(args)) delivery.dropUndecided(activated, entry => Boolean(args?.timedEffects?.isEffectActive('sticky', entry)));
        reportFailure(t`activation error`,
            t`Only constant and sticky entries were included. Try again.`,
            error, 'error', true);
    }
}

/** The owned half of a scan: the recursion feed on every loop, then — on the last one — scoring (stage 3), the
 *  relevance cut (4) and the budget (5). Throws are the caller's. */
async function rankOwnedScan(activated, args, skip) {
    // Before the size-0 return: a pass that activated nothing can still be followed by a min-activations widening.
    if (runState.waOwnsScan && Array.isArray(runState.waCandidates)) {
        await feedScanLoop(args);
    }

    // Only the feed above is a per-loop job. Stages 3-5 write what the last loop writes again — and core reads
    // `order` back in its inclusion-group prio sort, so the rewrite must not stand while the scan is still running.
    if (!isLastLoop(args)) return;

    if (activated.size === 0) {
        skip('core activated nothing');
        runState.lastPromptOrder = [];
        runState.lastLayoutOrder = [];   // only written past this return, so without it the capture reads the PREVIOUS scan's population
        renderDeliveryPanel([]);
        return;
    }

    // One fetch for the whole loop: getSortedEntries hashes and structuredClones every entry and emits ENTRIES_LOADED,
    // which re-enters WA's own handler, so three calls a scan was three of those.
    const scanEntries = await getSortedEntries();
    const contentText = await contentTextScores(runState.lastQuery, scanEntries);

    // Here because onScanDone owns what survives into the prompt, so one filter covers both routes.
    const at = settings().dropUnavailable ? (getContext().chat?.length ?? NaN) : NaN;
    let postDated = 0;
    for (const [key, entry] of [...activated.entries()]) {
        if (postDates(entry, at)) { activated.delete(key); postDated++; }
    }
    if (postDated) {
        dbg(`WorldsApart: hid ${postDated} entr(ies) summarising messages after this point in the chat (dropUnavailable)`);
    }

    const items = [...activated.entries()].map(([key, entry]) => {
        // Stashed on first sight: `order` is overwritten below, and this fires once per scan loop.
        entry.waOriginalOrder ??= entry.order ?? 0;
        return {
            key,
            entry,
            score: runState.lastScores.get(key),
            textScore: contentText.get(key) ?? 0,
            // Could have scored, not did: every entry carrying content.
            textEligible: Boolean(String(entry.content ?? '').trim()),
        };
    });

    const scanWorlds = new Set(items.map(it => it.entry.world));
    ensureWorldConfigs(scanWorlds);

    // One window, unconditional: the relevance column needs the chat window (eval/scene.mjs `haystackFor`); keyword scoring wraps it.
    let windowFor = null;
    {
        // scanChat is core's transformed haystack; raw context chat only for a scan no WA entry point saw.
        const built = await scanWindowFor(runState.scanChat ?? getContext().chat ?? []);
        const { chat, injects, sources } = built;
        // For the capture: the chat half alone, the injects beside it as their own list.
        runState.lastInjects = injects;
        // Raw; the gate (matcher.usedMatchSources) runs where the attached books are in scope.
        runState.lastSources = sources;
        windowFor = built.windowFor;
        // Keyword scoring only: the buffer is text WA injected, so it must not enter the window properNouns is counted over.
        // excludeRecursion honoured here because core's gate is not in this loop — stage 2 inherits it, stage 3 must not.
        // An entry that fed the buffer must not match its OWN content there: that is the entry naming itself, not the
        // conversation naming it, and core never self-matches because it activates an entry once.
        const recursionTexts = runState.waRecursionTexts ?? [];
        const keywordWindowFor = (depth, entry) => {
            const others = entry?.excludeRecursion ? [] : recursionTexts.filter(x => x !== String(entry?.content ?? ''));
            return others.length
                ? matcher.withExtraTexts(windowFor, others, settings().matchWindow)(depth, entry)
                : windowFor(depth, entry);
        };

        // Live keys, else the takeover's stash; every entry's keys are scored, vectorized included (docs/matching-architecture.md, *Stage 3 — Scoring*).
        const scoreKeysOf = entry => (entry.key?.length ? entry.key : (entry.waKeys ?? []));
        // A local view, never a write-back: restoring keys on core's scan copies mid-scan hands core's next loop the keys the takeover blanked.
        const scoringView = entry => (!entry.keysecondary?.length && entry.waSecondary?.length)
            ? { ...entry, keysecondary: entry.waSecondary }
            : entry;

        applyMacros(items.map(it => it.entry));
        // Registered before the loop, secondaries too, so the automaton is built once.
        registerKeys(items.flatMap(it => {
            const keys = scoreKeysOf(it.entry);
            return keys.length ? [...keys, ...matcher.secondaryKeys(scoringView(it.entry))] : [];
        }));

        for (const item of items) {
            // Per-entry scanDepth wins, as in core. Nullish, not `||`: 0 is core's authored "match nothing from chat".
            const depth = Number(item.entry.scanDepth ?? (settings().messageDepth || world_info_depth));
            const scanText = keywordWindowFor(depth, item.entry);
            const scoreKeys = scoreKeysOf(item.entry);
            const scored = keywordScore(scoringView(item.entry), scanText, scoreKeys);
            // An entry reached at recursion pass d did not have the conversation name it (docs/matching-architecture.md, *Stage 3 — Scoring*).
            item.keywordScore = scored.score / (1 + (Number(item.entry.waTriggerDepth) || 0));
            item.keywordHits = scored.hits;
            // Verbose runs only: where each key matched, for /wa-grade's why column. Flags mirror the keywordScore call above exactly.
            item.keywordWhy = runState.verboseRun
                ? scored.hits.slice(0, 4).map(h => {
                    // Every place it landed; `excerpt` is contexts[0], not a second call, so the line and the hover cannot disagree.
                    const contexts = matcher.keyExcerpts(h.key, scanText, item.entry.caseSensitive, item.entry.matchWholeWords);
                    return { key: h.key, count: h.count, score: h.score, excerpt: contexts[0] ?? null, contexts };
                })
                : undefined;
            // Resolved where `scoreKeys` is decided: an entry with no keys must not be divided by a weight it could not collect.
            item.keysEligible = scoreKeys.length > 0;
        }

        // The messages, not the joined window, so a reader can rebuild any window: `scanWindow(scanChat, {depth})`.
        runState.lastScanChat = chat.slice(-Math.max(1, settings().messageDepth))
            .map(x => ({ name: String(x?.name ?? ''), mes: String(x?.mes ?? '') }));

        if (runState.verboseRun) {
            console.log('%cWorldsApart · keyword scan windows — the exact text WA searched, by depth', 'font-weight: bold');
            console.log(Object.fromEntries([...windowFor.windows]));
            console.log('%cWorldsApart · recursion buffer — the entry contents stage 3 appended to every window', 'font-weight: bold');
            console.log(runState.waRecursionTexts);
        }
    }

    await scoreRelevanceColumn(items, windowFor, scanEntries);

    // Ordering the dynamic block by anything but E[credit] breaks the prefix property applyBudget assumes.
    const priorityList = charPriority() ?? [];
    const priorityMode = settings().worldPriorityMode;
    const { sticky, constant, promoted, results: dynamicRows, compare, bookTierOf } = layout.layoutOrder(items, {
        // A latched @@keep_activate_after_match is sticky by another name, so it is durable too: hoisted past
        // the relevance cut rather than scored and cut like an ordinary activation.
        isArmedSticky: entry => Boolean(args?.timedEffects?.isEffectActive('sticky', entry))
            || matcher.latchActive(entry, firedLatches(), getContext().chat?.length ?? 0),
        isPromoted: entry => Boolean(entry?.waPromote),
        priorityList: priorityList.map(w => ({ ...w, name: resolvedName(w) })).filter(w => w.name),
        priorityMode,
        presentationOrder: settings().presentationOrder,
        presentationTiered: settings().presentationTiered,
        tierCfg: settings().tierCfg,
    });
    let results = dynamicRows;

    // Before the cuts, so a capture holds every row this pass judged; survivors and losers cannot be re-interleaved afterwards.
    runState.lastLayoutOrder = [...sticky, ...constant, ...promoted, ...results];

    // Past the last-loop return above: cutting once the population is complete is what keeps the delivered set
    // independent of recursion depth.
    const cutoffs = relevanceModel.value ?? {};
    const { cut: relevanceCutRows } = selection.relevanceCut(results, {
        scoreOf: it => it.eCredit,
        cutoffOf: it => (cutoffs[isMemory(it.entry) ? 'memory' : 'reference'] ? settings().relevanceCutoff : NaN),
    });
    const cutByRelevance = new Set(relevanceCutRows);
    results = results.filter(it => !cutByRelevance.has(it));
    // Deleted from core's map here: the budget walk deletes only what it walks, and a cut row left behind ships.
    for (const it of relevanceCutRows) {
        activated.delete(it.key);
    }
    if (relevanceCutRows.length) {
        dbg(`WorldsApart: relevance cut dropped ${relevanceCutRows.length} of ${relevanceCutRows.length + results.length} dynamic entries`
            + (promoted.length ? ` (${promoted.length} promoted entr${promoted.length === 1 ? 'y was' : 'ies were'} exempt)` : ''));
    }

    let walk = delivery.walkOrder({ sticky, constant, promoted, results });

    const maxTokens = effectiveTokenBudget();
    const maxTotal = settings().maxTotalEntries;
    const maxDynamic = settings().maxDynamicEntries;
    const maxVectorEntries = settings().maxVectorEntries;
    const bookCaps = new Map(priorityList.filter(w => w.cap > 0).map(w => [resolvedName(w), w.cap]).filter(([n]) => n));

    if (maxTokens > 0 || maxTotal > 0 || maxDynamic > 0 || maxVectorEntries > 0 || bookCaps.size) {
        const dynamicSet = new Set(results);
        const promotedSet = new Set(promoted);
        const { survivors, tokens, counted, dynamic, vector, skipped, dropped, budgeted, inPrompt } = await delivery.applyBudget({
            walk,
            isDynamic: item => dynamicSet.has(item),
            // Capacity's population is dynamic plus promoted: promotion exempts from relevance, not from the caps.
            isCapped: item => dynamicSet.has(item) || promotedSet.has(item),
            // The tag, not retrieval provenance.
            isVector: item => Boolean(item.entry?.vectorized),
            maxTokens,
            maxTotal,
            maxDynamic,
            maxVectorEntries,
            capOf: item => bookCaps.get(item.entry.world) ?? 0,
            tokensOf: item => (maxTokens > 0 ? getTokenCountAsync(item.entry.content ?? '') : 0),
            exemptIsBudgeted: settings().maxTokensIncludesExempt,
            slack: (Number(settings().budgetSlackPercent) || 0) / 100,
            slackOnce: settings().budgetSlackMode !== 'all',
        });

        for (const item of walk) {
            if (!survivors.has(item)) {
                activated.delete(item.key);
            }
        }

        if (dropped) {
            const caps = [
                maxVectorEntries > 0 ? `vector ${vector}/${maxVectorEntries}` : null,
                maxDynamic > 0 ? `dynamic ${dynamic}/${maxDynamic}` : null,
                maxTotal > 0 ? `total ${counted}/${maxTotal}` : null,
                maxTokens > 0 ? `tokens ${budgeted}/${maxTokens} budgeted${inPrompt !== budgeted ? `, ${inPrompt - budgeted} exempt, ${inPrompt} in prompt` : ''}` : null,
            ].filter(Boolean).join(', ');
            const exempt = survivors.size - counted;
            dbg(`WorldsApart: budget dropped ${dropped} entries — ${caps}${exempt ? `, plus ${exempt} ignoreBudget (uncapped)` : ''}, ${survivors.size} in prompt`);
        }

        runState.lastSkipped = skipped;
        // Null unless a token budget was in force: tokensOf short-circuits to 0 when maxTokens is 0, so the counts would all read 0.
        runState.lastBudget = maxTokens > 0 ? { tokens, budgeted, inPrompt, maxTokens } : null;
        walk = walk.filter(x => survivors.has(x));
    } else {
        runState.lastSkipped = [];
        runState.lastBudget = null;
    }

    // Prompt order, not layout order: one flat sort over every survivor.
    const promptOrder = priorityMode === 'sequential'
        ? [...walk].sort((a, b) => (bookTierOf(a.entry.world) - bookTierOf(b.entry.world)) || compare(a, b))
        : [...walk].sort(compare);

    // Assembly sorts descending by `order` then unshifts, so the prompt reads ascending and index 0 lands first.
    promptOrder.forEach((item, index) => {
        item.entry.order = ORDER_BASE + index;
    });

    // Stash for /wa-dry; classification is recomputed nowhere else.
    const blockOf = new Map([
        ...sticky.map(x => [x, 'sticky']),
        ...constant.map(x => [x, 'constant']),
        // Named, not folded into 'dynamic': a harness would read the row as answering to a cut it never reached. Still gradeable.
        ...promoted.map(x => [x, 'promoted']),
        ...results.map(x => [x, 'dynamic']),
    ]);
    runState.lastPromptOrder = promptOrder.map(item => ({ item, block: blockOf.get(item) ?? 'dynamic' }));
    runState.lastSkipped = runState.lastSkipped.map(x => ({ ...x, block: blockOf.get(x.item) ?? 'dynamic' }));

    recordLatches(promptOrder.map(item => item.entry));
    renderDeliveryPanel(runState.lastPromptOrder);

    if (runState.verboseRun) {
        // The pre-cut, pre-budget population, `cut`/`cutBy` recording which side each row fell on. candidates=N caps
        // gradeable rows only — durable rows are listed ungraded — and never drops a row that shipped.
        const kept = new Set(walk);
        let gradeableSeen = 0;
        const gradeDepth = runState.gradeCutoff?.maxVectorEntries ?? 0;
        const population = (runState.lastLayoutOrder ?? walk)
            .filter(x => !gradeDepth || isDurable({ block: blockOf.get(x) ?? 'dynamic' }) || ++gradeableSeen <= gradeDepth || kept.has(x));
        // Why a row was cut, not just that it was: "ordered too low" and "would not fit" are different facts.
        const blockedOf = new Map(
            (runState.lastSkipped ?? []).map(s => [s.item ?? s, (s.blockedBy ?? []).map(b => b.cap).join('+')]),
        );
        // Counted here, not reused from tokensOf, which short-circuits to 0 when maxTokens is 0. Content only, matching applyBudget.
        const tokens = await Promise.all(population.map(x => getTokenCountAsync(x.entry.content ?? '')));
        const rows = population.map((x, i) => ({
            // `block` is the runtime budget class; `sticky` is the configured value, which is what the eval side reads
            // durable off. Numeric fields stay numeric, `null` meaning no signal — never a truthiness test.
            title: x.entry.comment,
            block: blockOf.get(x) ?? 'dynamic',
            sticky: x.entry.sticky || 0,
            score: Number.isFinite(x.eCredit) ? Number(x.eCredit.toFixed(5)) : null,
            uid: x.entry.uid,
            wiOrder: x.entry.waOriginalOrder,
            cosine: x.score !== undefined ? Number(x.score.toFixed(5)) : null,
            pn: Number.isFinite(x.properNouns) ? Number(x.properNouns.toFixed(3)) : null,
            dens: Number.isFinite(x.density) ? Number(x.density.toFixed(2)) : null,
            // Gated on eligibility, not on the cosine: the text score is lexical, so it is present whenever the entry has content, plugin or not.
            text: x.textEligible && Number.isFinite(x.textScore) ? Number(x.textScore.toFixed(2)) : null,
            // Gated on eligibility, not the value: 0 is both a miss and no scorable keys.
            keys: x.keysEligible === false ? null : (Number.isFinite(x.keywordScore) ? Number(x.keywordScore.toFixed(2)) : null),
            tokens: tokens[i],
            cut: !kept.has(x),
            // 'tokens' means it did not FIT, a different fact from ranking too low.
            cutBy: blockedOf.get(x) || null,
            // `index`, matching the bundle candidate's field.
            index: i,
        }));

        // `book` from here on, never `world`: the row, the key and the schema all say book.
        runState.lastCandidates = rows.map((row, i) => ({ ...row, book: population[i].entry.world, why: population[i].keywordWhy }));
        runState.lastCandidateEntries = population.map(x => x.entry);

        console.log('%cWorldsApart · selection candidates — every activated entry, its signals and what cut it. `score` is E[credit]; a cut row with no cap named lost the relevance cut', 'font-weight: bold');
        console.table(rows);
    }

    // Never on ST's dry runs, which fire on every chat load.
    if (settings().debugLog && !runState.dryRunInProgress && !runState.generationIsDryRun) {
        await reportLayout(false, maxTokens > 0);
    }
}

// Dry run

/** Runs retrieval and a full World Info scan without generating. Safe to repeat: a dry-run scan arms no timed effect and emits no WORLD_INFO_ACTIVATED. */
async function dryRun(verbose = false) {
    const context = getContext();
    // is_system first: ST filters them out of `coreChat` before any interceptor, so production never sees them (G9).
    const rawChat = context.chat ?? [];
    const chat = rawChat.filter(x => x && !x.is_system);

    // The only gate on this path: with WA off a dry run would half-run, force-activating into a scan WA does not own.
    if (!settings().enabled) {
        toastr.warning(t`WorldsApart is disabled — turn it on to run a dry run.`, 'WorldsApart');
        return '';
    }

    if (!chat.length) {
        toastr.warning(rawChat.length ? t`Every message in this chat is hidden.` : t`No chat to scan.`, 'WorldsApart');
        return '';
    }

    console.log(`%cWorldsApart ${(await waVersion()) || 'version unknown'}: ${verbose ? 'debug run' : 'dry run'}`, 'font-weight: bold', paramSnapshot());
    // Version and fingerprints stay out of paramSnapshot: a bundle carries them in SHARED_FIELDS, and recording them twice would let the two disagree.
    console.log(`WorldsApart: plugin ${runState.pluginAvailable ? `${runState.pluginFP ?? 'unknown'}, source ${runState.sourceFP ?? 'unknown'}${pluginDrifted() ? ' — OUT OF DATE, redeploy' : ''}` : 'not installed'}`);
    const identity = await extensionIdentity();
    if (identity) console.log(`WorldsApart: ${identity}`);

    runState.verboseRun = Boolean(verbose);
    runState.dryRunInProgress = true;
    // This scan is not ST's, and nothing else clears the flag: GENERATION_ENDED never fires for a dry Generate.
    runState.generationIsDryRun = false;

    // Cleared so a scan that activates nothing reports nothing rather than last run's; the /wa-grade capture too.
    runState.lastPromptOrder = [];
    runState.lastSkipped = [];
    runState.lastBudget = null;
    runState.lastCandidates = [];
    runState.lastCandidateEntries = [];
    runState.lastQuery = '';
    runState.lastScanChat = [];
    runState.lastQueryChat = [];
    runState.lastLayoutOrder = [];

    // retrieve() is inside the try: a throw outside the finally leaves verboseRun/dryRunInProgress stuck true.
    try {
        // The dry run takes the next token: an in-flight generation's continuations stand down rather than interleave.
        const token = ++runState.scanToken;
        await selectAndActivate(chat, token);

        await getWorldInfoPrompt(forWI(chat), getMaxPromptTokens(), true, { ...scanSources(), trigger: 'normal' });

        await reportLayout(verbose);
    } finally {
        runState.verboseRun = false;
        runState.dryRunInProgress = false;
        // An exception before the scan's last loop would otherwise leave the takeover flag armed.
        runState.waOwnsScan = false;
    }

    return '';
}

/** Every setting that can change a result, as a plain object logged as JSON. */
function paramSnapshot() {
    const s = settings();
    const attached = (scopedPriority() ?? []).map(x => x.cfg);
    // Every setting, never an allowlist; it includes `raterId`.
    const snap = {
        // Structured settings are storage, not knobs, and are left out; `derived.attached` carries this character's list scoped to the chat.
        settings: Object.fromEntries(Object.keys(defaultSettings)
            .filter(k => defaultSettings[k] === null || typeof defaultSettings[k] !== 'object')
            .map(k => [k, s[k]])),
        // Values with no single backing setting.
        derived: {
            maxTokens: tokenBudgetLabel(),
            // The entry maxes and per-book caps are not repeated: recording them twice would let the two disagree.
            maxTokensEffective: effectiveTokenBudget(),
            tokenizer: getTokenizerModel(),
            insertionOrder: presentationBaseLabel(s.presentationOrder),
            attached,
            // Which fit the eCredit column came out of; `null` marks the file failing to load.
            relevanceModel: Object.fromEntries(Object.entries(relevanceModel.value ?? {})
                .map(([tier, m]) => [tier, m
                    ? { features: m.features, cutoff: m.cutoff, heldOutAuc: m.heldOutAuc, fittedOn: m.fittedOn }
                    : null])),
        },
    };

    return snap;
}

function tokenBudgetLabel() {
    const s = settings();
    const parts = [
        s.maxTokensPercent > 0 ? `${s.maxTokensPercent}%*` : null,
        s.maxTokens > 0 ? `${s.maxTokens}*` : null,
    ].filter(Boolean);
    const effective = effectiveTokenBudget();

    if (!parts.length) {
        return '—';
    }

    return s.maxTokensPercent > 0 ? `${parts.join(' & ')} = ${effective}` : parts.join(' & ');
}

/** Names the signal that won an entry its place, for the `why` column. */
function whySelected(item, block) {
    if (isDurable({ block })) {
        return 'always-on';
    }
    // A promoted row still won its place on a signal: the author waived the cut, not the scoring.
    const parts = [
        Number.isFinite(item.eCredit) ? `E[credit] ${item.eCredit.toFixed(3)}` : null,
        Number.isFinite(item.score) ? `vec ${item.score.toFixed(3)}` : null,
        item.textScore ? `text ${item.textScore.toFixed(2)}` : null,
        item.keywordScore ? `keys ${item.keywordScore.toFixed(2)}` : null,
    ].filter(Boolean);

    if (parts.length) {
        return parts.join(' · ');
    }

    // No WA signal, so core activated it. @@activate applies before keyword matching, so its 0 is correct, not a miss.
    if (Array.isArray(item.entry.decorators) && item.entry.decorators.includes('@@activate')) {
        return 'core (@@activate)';
    }

    // Keys, but WA scored 0: with min activations on, core likely backfilled below Scan Depth; otherwise a matcher difference.
    const hasKeys = Array.isArray(item.entry.key) && item.entry.key.length > 0;

    if (!hasKeys) {
        return 'core (external)';
    }

    return world_info_min_activations > 0
        ? 'core keyword (below scan depth — min-activations)'
        : 'core keyword (WA scored 0)';
}

/** Turns a rejection into the change that would undo it. */
function describeFix(blockedBy) {
    return blockedBy.map((block) => {
        switch (block.cap) {
            case 'tokens':
                return block.slackSpent
                    ? `${block.shortfall} tokens over; slack already used this scan (set slack to "all"?)`
                    : `+${block.shortfall} tokens, or ${block.slackNeeded}% slack, or shorten the entry`;
            case 'total':
                return 'raise the total entry cap';
            case 'dynamic':
                return 'raise the dynamic entry cap';
            case 'vector':
                return 'raise the vector entry cap';
            case 'book':
                return `raise "${block.world}" book cap (at ${block.limit})`;
            default:
                return block.cap;
        }
    }).join('; ');
}

/** Human names for `world_info_position`, which is a bare enum on the entry. */
const POSITION_NAMES = ['before char', 'after char', 'AN top', 'AN bottom', '@depth', 'EM top', 'EM bottom', 'outlet'];

/** Prints the last scan's selection in prompt order, grouped by `position` first: core assembles each position into its own block. */
async function reportLayout(verbose = false, countTokens = true) {
    if (!runState.lastPromptOrder.length) {
        console.log('WorldsApart: nothing activated.');
        return;
    }

    const rows = [];
    let total = 0;

    for (const { item, block } of runState.lastPromptOrder) {
        const entry = item.entry;
        // Not counted on live generations unless a token cap already made us: a remote tokenizer is one round trip per entry.
        const tokens = countTokens ? await getTokenCountAsync(entry.content ?? '') : null;
        total += tokens ?? 0;

        // Column order is insertion order; `_pos` is a sort key only, stripped before printing. Numeric fields stay numeric, `null` for no signal.
        rows.push({
            title: entry.comment || `uid ${entry.uid}`,
            score: Number.isFinite(item.eCredit) ? Number(item.eCredit.toFixed(5)) : null,
            uid: entry.uid,
            // wiOrder is the entry's own WI `order`; waOrder is what WA wrote.
            wiOrder: entry.waOriginalOrder,
            waOrder: entry.order,
            ...(verbose ? {
                cosine: item.score !== undefined ? Number(item.score.toFixed(5)) : null,
                text: item.textEligible && Number.isFinite(item.textScore) ? Number(item.textScore.toFixed(2)) : null,
                keys: item.keysEligible === false ? null : (Number.isFinite(item.keywordScore) ? Number(item.keywordScore.toFixed(2)) : null),
                // Full precision: a harness run is compared against these to show the runtime and the fit agree.
                properNouns: Number.isFinite(item.properNouns) ? item.properNouns : null,
                density: Number.isFinite(item.density) ? item.density : null,
                eCredit: Number.isFinite(item.eCredit) ? item.eCredit : null,
                // Which keys matched, strongest first: "Kyle×3 · pool".
                hits: item.keywordHits?.length
                    ? item.keywordHits.map(h => (h.count > 1 ? `${h.key}×${h.count}` : h.key)).join(' · ')
                    : null,
            } : {}),
            block,
            why: whySelected(item, block),
            position: POSITION_NAMES[entry.position] ?? `position ${entry.position}`,
            depth: entry.position === 4 ? (entry.depth ?? 4) : null,
            exempt: delivery.authorIgnoreBudget(entry),
            tokens: tokens ?? null,
            _pos: Number(entry.position) || 0,
        });
    }

    rows.sort((a, b) => a._pos - b._pos || a.waOrder - b.waOrder);
    rows.forEach(row => delete row._pos);

    console.log(`%cWorldsApart · selected — what reaches the prompt, in prompt order (grouped by position, then order): ${rows.length} entries${countTokens ? `, ${total} World Info tokens` : ''}`, 'font-weight: bold');
    console.table(rows);

    if (runState.lastSkipped.length) {
        const nearMiss = runState.lastSkipped.filter(x => !x.tail);
        const tail = runState.lastSkipped.filter(x => x.tail);

        if (nearMiss.length) {
            console.log(`%cWorldsApart · skipped (fixable) — budget was still available, so an edit or a bigger cap changes the outcome: ${nearMiss.length} entries`, 'font-weight: bold');
            console.table(nearMiss.map(({ item, tokens, blockedBy }) => ({
                blockedBy: blockedBy.map(x => x.cap).join(' + '),
                tokens,
                fix: describeFix(blockedBy),
                eCredit: Number.isFinite(item.eCredit) ? Number(item.eCredit.toFixed(5)) : null,
                entry: item.entry.comment || `uid ${item.entry.uid}`,
                uid: item.entry.uid,
            })));
        }

        if (tail.length) {
            const smallest = Math.min(...tail.map(x => x.tokens));
            const sum = tail.reduce((total, x) => total + x.tokens, 0);
            const caps = [...new Set(tail.flatMap(x => x.blockedBy.map(y => y.cap)))].join(' + ');

            // Every tail entry sees the same leftover room, so fitting the whole tail costs its sum minus that.
            const remaining = tail.find(x => x.blockedBy.some(y => y.cap === 'tokens'))
                ?.blockedBy.find(y => y.cap === 'tokens')?.remaining;
            const toFitAll = remaining === undefined ? null : Math.max(0, sum - remaining);

            console.log(`%cWorldsApart · cut (exhausted) — ${caps} used up, nothing here fits: ${tail.length} entries, smallest is ${smallest} tokens, ${sum.toLocaleString()} in total${toFitAll === null ? '' : ` (raise the budget by ${toFitAll.toLocaleString()} to fit them all)`}`, 'font-weight: bold');
            console.table(tail.map(({ item, tokens }) => ({
                tokens,
                eCredit: Number.isFinite(item.eCredit) ? Number(item.eCredit.toFixed(5)) : null,
                entry: item.entry.comment || `uid ${item.entry.uid}`,
                uid: item.entry.uid,
            })));
        }
    }
}

/** /wa-query: scores entries against arbitrary text and prints the result; activates nothing. */
async function probeQuery(_named, text) {
    const searchText = String(text ?? '').trim();

    if (!searchText) {
        toastr.warning(t`Provide query text: /wa-query your text here`, 'WorldsApart');
        return '';
    }

    const { targets, scores, retrieved } = await scoreEntries(searchText);

    if (!scores.size) {
        console.log(retrieved.size
            ? `WorldsApart: ${retrieved.size} entr(ies) came back with no cosine for "${searchText.slice(0, 60)}…" — the no-plugin path answered, so there is no table to print`
            : `WorldsApart: the query matched no chunk for "${searchText.slice(0, 60)}…"`);
        return '';
    }

    reportVectorCandidates(scores, targets, searchText);

    return '';
}


/** The token budget from the percentage and absolute settings; both apply and the tighter wins, 0 = none. */
function effectiveTokenBudget() {
    const percent = Number(settings().maxTokensPercent) || 0;
    const absolute = Number(settings().maxTokens) || 0;
    const fromPercent = percent > 0 ? Math.round(getMaxPromptTokens() * percent / 100) : 0;
    const limits = [fromPercent, absolute].filter(x => x > 0);

    return limits.length ? Math.min(...limits) : 0;
}


// Settings UI

const SETTINGS_HTML = `
<style>
/* Nested WA sub-sections read as subordinate to the top "WorldsApart" header: indented, lighter,
   smaller, with a left rule — so they don't look like their own top-level drawers. */
.worlds-apart-settings .wa-section { margin-left: 12px; border-left: 2px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); padding-left: 8px; }
/* Every item under the top header is indented the same as a section is, so top-level and section items read as one level each. */
.worlds-apart-settings > .inline-drawer > .inline-drawer-content > :not(.wa-section) { margin-left: 12px; }
.worlds-apart-settings .checkbox_label { margin-left: 0; }
.worlds-apart-settings .checkbox_label input[type="checkbox"] { margin-left: 0; }
.worlds-apart-settings .wa-section > .inline-drawer-content { padding-bottom: 10px; }
.worlds-apart-settings { padding-bottom: 10px; }
/* The enable state as a switch; still a checkbox underneath, so bind() reads it unchanged. */
.worlds-apart-settings .checkbox_label:has(input.wa-switch) { align-items: center; }
.worlds-apart-settings input.wa-switch { appearance: none; -webkit-appearance: none; display: inline-block; width: 34px; height: 18px; border: 0; border-radius: 9px; background: color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 28%, var(--SmartThemeBlurTintColor, #222)); position: relative; cursor: pointer; vertical-align: middle; margin: 5px 0 0; transition: background 0.15s; }
/* ST paints its tick in ::before with a scaled box-shadow and a clip-path; every one of those is reset so the knob is what shows. */
.worlds-apart-settings input.wa-switch::before, .worlds-apart-settings input.wa-switch:checked::before { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--SmartThemeBodyColor, #fff); outline: 1px solid color-mix(in srgb, var(--SmartThemeBlurTintColor, #222) 60%, transparent); box-shadow: none; clip-path: none; transform: none; transition: left 0.15s; }
.worlds-apart-settings input.wa-switch:checked { background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7aa2f7) 70%, var(--SmartThemeBlurTintColor, #222)); }
.worlds-apart-settings input.wa-switch:checked::before { left: 18px; }
.worlds-apart-settings .wa-section > .inline-drawer-toggle { font-size: 0.95em; opacity: 0.8; }
.worlds-apart-settings .wa-section > .inline-drawer-toggle b { font-weight: 500; }
.worlds-apart-settings small.opacity50p { display: block; margin: 0.15em 0 0.8em; }
.worlds-apart-settings .wa-section > .inline-drawer-content { margin-left: 12px; }
.worlds-apart-settings .wa-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0; }
.worlds-apart-settings .wa-row label { margin: 0; }
.worlds-apart-settings .wa-row input { width: 6em; flex: 0 0 auto; }
</style>
<div class="worlds-apart-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b data-i18n="WorldsApart">WorldsApart</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="wa_plugin_alert"></div>
            <div class="flex-container alignItemsCenter">
                <label class="checkbox_label" for="wa_enabled">
                    <input id="wa_enabled" type="checkbox" class="wa-switch"><span data-i18n="Enabled">Enabled</span>
                </label>
                <small id="wa_version" style="opacity:0.55;margin-left:6px;"></small>
            </div>
            <label><span data-i18n="Prompt insertion order">Prompt insertion order</span> <span class="fa-solid fa-circle-question note-link-span" title="The order selected entries take in the prompt. A base sort, with optional tier grouping. This setting is saved. The Studio's sort views are not." data-i18n="[title]The order selected entries take in the prompt. A base sort, with optional tier grouping. This setting is saved. The Studio's sort views are not."></span></label>
            <div id="wa_presentation_order_mount" style="margin-top:4px;"></div>

            <div class="wa-row"><label for="wa_message_depth" data-i18n="Message depth">Message depth</label><input id="wa_message_depth" type="number" class="text_pole" min="1" max="20" step="1"></div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><span data-i18n="Tier precedence">Tier precedence</span> <span class="fa-solid fa-circle-question note-link-span" title="With tier grouping on, an entry joins the first tier it matches, top to bottom. Untick a tier to skip it. Shared with the Studio." data-i18n="[title]With tier grouping on, an entry joins the first tier it matches, top to bottom. Untick a tier to skip it. Shared with the Studio."></span></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p" id="wa_tier_state"></small>
                    <div id="wa_tier_editor_mount" style="margin-top:4px;"></div>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b data-i18n="Scan window">Scan window</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_drop_chat_tags"><span data-i18n="Ignored tags">Ignored tags</span> <span class="fa-solid fa-circle-question note-link-span" title="Comma-separated HTML or XML tags to be skipped when scanning for keyword hits. You might want to set this to your preset's internal state tracker so your quest tracker doesn't constantly pull entries." data-i18n="[title]Comma-separated HTML or XML tags to be skipped when scanning for key hits. You might want to set this to your preset's internal state tracker so your quest tracker doesn't constantly pull entries."></span></label>
                    <input id="wa_drop_chat_tags" type="text" class="text_pole" placeholder="internal_states, thinking">

                    <label for="wa_match_window"><span data-i18n="Match window">Match window</span> <span class="fa-solid fa-circle-question note-link-span" title="The window within which a key's conditions must all match, e.g. ? apple AND banana must both appear in the same paragraph, message or scan window." data-i18n="[title]The window within which a key's conditions must all match, e.g. ? apple AND banana must both appear in the same paragraph, message or scan window."></span></label>
                    <select id="wa_match_window" class="text_pole">
                    <option value="paragraph" data-i18n="Paragraph">Paragraph</option>
                    <option value="message" data-i18n="Message">Message</option>
                    <option value="scan" data-i18n="Whole scan window (SillyTavern default)">Whole scan window (SillyTavern default)</option>
                    </select>

                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b data-i18n="Matching &amp; relevance">Matching &amp; relevance</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_word_boundary"><span data-i18n="Word boundary">Word boundary</span> <span class="fa-solid fa-circle-question note-link-span" title="Applies to entries with Match Whole Words on and SmartKeys that use =. Permissive: whole-word &quot;Joe&quot; matches &quot;Joe's&quot;. Strict: no match. Neither matches &quot;Joes&quot;." data-i18n="[title]Applies to entries with Match Whole Words on and SmartKeys that use =. Permissive: whole-word &quot;Joe&quot; matches &quot;Joe's&quot;. Strict: no match. Neither matches &quot;Joes&quot;."></span></label>
                    <select id="wa_word_boundary" class="text_pole">
                    <option value="strict" data-i18n="Strict: do not allow apostrophes and hyphens">Strict: do not allow apostrophes and hyphens</option>
                    <option value="permissive" data-i18n="Permissive: whole-word matches allow apostrophes and hyphens">Permissive: whole-word matches allow apostrophes and hyphens</option>
                    </select>

                    <div id="wa_embed_info" class="opacity50p" style="margin:0.4em 0;font-size:0.85em;" title="Set the embedding model in the Vector Storage extension." data-i18n="[title]Set the embedding model in the Vector Storage extension."></div>

                    <label><span data-i18n="Mean-centered search">Mean-centered search</span> <span class="fa-solid fa-circle-question note-link-span" title="Subtracts the collection's average vector before comparing, so wording every entry shares stops dominating similarity. Automatic when the server plugin is installed." data-i18n="[title]Subtracts the collection's average vector before comparing, so wording every entry shares stops dominating similarity. Automatic when the server plugin is installed."></span></label>
                    <div id="wa_plugin_setup" style="margin:0.4em 0;font-size:0.85em;opacity:0.75;"></div>

                    <div id="wa_find_orphans" class="menu_button" style="width:auto;padding:0.3em 0.8em;" title="Lists vector collections no current book claims. Nothing is deleted." data-i18n="Find unused vector collections…;[title]Lists vector collections no current book claims. Nothing is deleted.">Find unused vector collections…</div>
                    <div id="wa_orphans_out" class="opacity50p" style="margin:0.4em 0;font-size:0.85em;"></div>

                    <label class="checkbox_label" for="wa_drop_unavailable">
                    <input id="wa_drop_unavailable" type="checkbox"><span data-i18n="Hide entries from later in the chat">Hide entries from later in the chat</span> <span class="fa-solid fa-circle-question note-link-span" title="On a branch from an earlier point, scene summaries written after that point are hidden. No effect at the latest turn." data-i18n="[title]On a branch from an earlier point, scene summaries written after that point are hidden. No effect at the latest turn."></span>
                    </label>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b data-i18n="Selection &amp; budget">Selection &amp; budget</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_world_priority_mode"><span data-i18n="Lorebook priority">Lorebook priority</span> <span class="fa-solid fa-circle-question note-link-span" title="Interleaved: one ranked list across books, with optional per-book weights. Sequential: higher books fill first. A book appears below after its first scan." data-i18n="[title]Interleaved: one ranked list across books, with optional per-book weights. Sequential: higher books fill first. A book appears below after its first scan."></span></label>
                    <select id="wa_world_priority_mode" class="text_pole">
                    <option value="interleaved" data-i18n="Interleaved">Interleaved</option>
                    <option value="sequential" data-i18n="Sequential">Sequential</option>
                    </select>

                    <label data-i18n="Lorebook order">Lorebook order</label>
                    <div id="wa_world_priority_list" style="margin-top:2px;"></div>

                    <div class="wa-row"><label for="wa_relevance_cutoff"><span data-i18n="Relevance cutoff">Relevance cutoff</span> <span class="fa-solid fa-circle-question note-link-span" title="Entries scoring below this are dropped. Recommend 0.1-0.2: higher drops more, including entries you may want. Lower lets more irrelevant ones through. 0 = none." data-i18n="[title]Entries scoring below this are dropped. Recommend 0.1-0.2: higher drops more, including entries you may want. Lower lets more irrelevant ones through. 0 = none."></span></label><input id="wa_relevance_cutoff" type="number" class="text_pole" min="0" max="1" step="0.01"></div>

                    <div class="wa-row"><label for="wa_max_entries"><span data-i18n="Vector entry cap">Vector entry cap</span> <span class="fa-solid fa-circle-question note-link-span" title="Retrieved entries in the prompt." data-i18n="[title]Retrieved entries in the prompt."></span></label><input id="wa_max_entries" type="number" class="text_pole" min="1" max="100" step="1"></div>

                    <div class="wa-row"><label for="wa_max_dynamic"><span data-i18n="Dynamic entry cap">Dynamic entry cap</span> <span class="fa-solid fa-circle-question note-link-span" title="Vector and keyword entries. 0 = unlimited." data-i18n="[title]Vector and keyword entries. 0 = unlimited."></span></label><input id="wa_max_dynamic" type="number" class="text_pole" min="0" max="500" step="1"></div>

                    <div class="wa-row"><label for="wa_max_total"><span data-i18n="Total entry cap">Total entry cap</span> <span class="fa-solid fa-circle-question note-link-span" title="Including constants and stickies. 0 = unlimited." data-i18n="[title]Including constants and stickies. 0 = unlimited."></span></label><input id="wa_max_total" type="number" class="text_pole" min="0" max="500" step="1"></div>

                    <div class="wa-row"><label for="wa_max_tokens_pct"><span data-i18n="Context %">Context %</span> <span class="fa-solid fa-circle-question note-link-span" title="Token budget as a share of the context. 0 = unlimited." data-i18n="[title]Token budget as a share of the context. 0 = unlimited."></span></label><input id="wa_max_tokens_pct" type="number" class="text_pole" min="0" max="100" step="1"></div>

                    <div class="wa-row"><label for="wa_max_tokens"><span data-i18n="Max tokens">Max tokens</span> <span class="fa-solid fa-circle-question note-link-span" title="Token budget in tokens. The tighter of the two applies. 0 = unlimited." data-i18n="[title]Token budget in tokens. The tighter of the two applies. 0 = unlimited."></span></label><input id="wa_max_tokens" type="number" class="text_pole" min="0" max="100000" step="64"></div>

                    <div class="wa-row"><label for="wa_budget_slack"><span data-i18n="Budget slack">Budget slack</span> <span class="fa-solid fa-circle-question note-link-span" title="% of the budget a slightly-too-big entry may exceed it by. 0 applies the budget strictly." data-i18n="[title]% of the budget a slightly-too-big entry may exceed it by. 0 applies the budget strictly."></span></label><input id="wa_budget_slack" type="number" class="text_pole" min="0" max="50" step="1"></div>

                    <label for="wa_slack_mode" data-i18n="Slack allowed for">Slack allowed for</label>
                    <select id="wa_slack_mode" class="text_pole">
                    <option value="once" data-i18n="One entry">One entry</option>
                    <option value="all" data-i18n="All entries">All entries</option>
                    </select>
                    <label class="checkbox_label" for="wa_tokens_include_exempt">
                    <input id="wa_tokens_include_exempt" type="checkbox"><span data-i18n="Budget-exempt entries spend budget">Budget-exempt entries spend budget</span> <span class="fa-solid fa-circle-question note-link-span" title="On: their tokens still spend the budget, so fewer other entries fit beside them. Off: they ride free, and the prompt may exceed the budget by their size. Either way they are never cut." data-i18n="[title]On: their tokens still spend the budget, so fewer other entries fit beside them. Off: they ride free, and the prompt may exceed the budget by their size. Either way they are never cut."></span>
                    </label>

                    <small id="wa_exempt_count" class="opacity50p"></small>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b data-i18n="Audit &amp; suggestions">Audit &amp; suggestions</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_language"><span data-i18n="Language">Language</span> <span class="fa-solid fa-circle-question note-link-span" title="Language of the lorebook and chat. Selects the word-frequency table the keyword suggester and audit use." data-i18n="[title]Language of the lorebook and chat. Selects the word-frequency table the keyword suggester and audit use."></span></label>
                    <select id="wa_language" class="text_pole">
                    <option value="en" data-i18n="English">English</option>
                    </select>
                    <small class="opacity50p" id="wa_language_state"></small>


                    <label for="wa_llm_profile"><span data-i18n="Suggester LLM profile">Suggester LLM profile</span> <span class="fa-solid fa-circle-question note-link-span" title="One call per entry." data-i18n="[title]One call per entry."></span></label>
                    <div class="flex-container alignItemsCenter flexnowrap">
                    <select id="wa_llm_profile" class="text_pole flex1"></select>
                    <div id="wa_refresh_profiles" class="menu_button fa-solid fa-rotate" title="Reload the Connection Manager profile list" data-i18n="[title]Reload the Connection Manager profile list"></div>
                    </div>

                    <div class="wa-row"><label for="wa_llm_temp"><span data-i18n="Temperature">Temperature</span> <span class="fa-solid fa-circle-question note-link-span" title="No measured effect on suggestion quality. Leave blank for the backend default." data-i18n="[title]No measured effect on suggestion quality. Leave blank for the backend default."></span></label><input id="wa_llm_temp" type="number" class="text_pole" min="0" max="2" step="0.05" placeholder="backend default" data-i18n="[placeholder]backend default"></div>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b data-i18n="Advanced">Advanced</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">


                    <label class="checkbox_label" for="wa_debug_log">
                        <input id="wa_debug_log" type="checkbox"><span data-i18n="Log what WorldsApart does on every generation">Log what WorldsApart does on every generation</span>
                    </label>

                    <label for="wa_rater_id"><span data-i18n="Rater id">Rater id</span> <span class="fa-solid fa-circle-question note-link-span" title="A random anonymous ID your grades are signed with." data-i18n="[title]A random anonymous ID your grades are signed with."></span></label>
                    <input id="wa_rater_id" type="text" class="text_pole" readonly style="opacity:0.55;cursor:default;" placeholder="generated on your first grade" data-i18n="[placeholder]generated on your first grade">


                    <div id="wa_review_bundles" class="menu_button" style="width:auto;padding:0.3em 0.8em;" title="Opens the bundle reviewer without a chat." data-i18n="Review graded bundles…;[title]Opens the bundle reviewer without a chat.">Review graded bundles…</div>
                </div>
            </div>
        </div>
    </div>
</div>`;

/** Rebuilds the profile dropdown from Connection Manager's current list; `notify` toasts the result. */
function populateProfiles(notify = false) {
    const profiles = extension_settings.connectionManager?.profiles ?? [];
    const selected = settings().llmProfile;

    $('#wa_llm_profile')
        .empty()
        // Not a neutral fallback: without a profile generateText uses generateRaw, which takes no generation parameters.
        .append([`<option value="">${escapeHtml(t`Current chat API`)}</option>`]
            .concat(profiles.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`))
            .join(''));

    // A deleted profile leaves a dangling id: show the fallback, but do not rewrite the setting.
    const stillExists = !selected || profiles.some(x => x.id === selected);
    $('#wa_llm_profile').val(stillExists ? selected : '');

    if (!stillExists) {
        console.warn(`WorldsApart: saved LLM profile "${selected}" no longer exists, falling back to the current API`);
        toastr.warning(t`Saved LLM profile no longer exists.`, 'WorldsApart');
    }

    if (notify) {
        toastr.info(t`${profiles.length} profile(s) loaded.`, 'WorldsApart');
    }
}

/** Wires a settings control to its backing value.
 *  @param {'checked'|'number'|'string'} kind */
function bind(selector, key, kind) {
    const $el = $(selector);

    if (kind === 'checked') {
        $el.prop('checked', settings()[key]);
    } else {
        $el.val(settings()[key]);
    }

    $el.on('input change', ev => {
        if (kind === 'number') {
            const raw = String($el.val()).trim(), n = Number(raw);
            // A cleared box is mid-edit, never a zero: `relevanceCutoff` 0 admits every row, and a cap of 0 is "off".
            // On commit the box snaps back to the value in force rather than showing a blank that was never stored.
            if (!raw || !Number.isFinite(n)) { if (ev.type === 'change') $el.val(settings()[key]); return; }
            settings()[key] = n;
        } else {
            settings()[key] = kind === 'checked' ? $el.prop('checked') : String($el.val());
        }
        saveSettingsDebounced();
    });
}



// The Delivery panel: a bottom-left icon expanding into stage 5's delivered set, in prompt order, from
// runState.lastPromptOrder.
let deliveryTrigger = null, deliveryPanel = null;
function ensureDeliveryPanel() {
    if (deliveryTrigger) return;
    const style = document.createElement('style');
    style.textContent = `
.wa-delivery-trigger { position: fixed; left: 10px; bottom: 10px; z-index: 100000; width: 28px; height: 28px;
    line-height: 28px; text-align: center; cursor: pointer; opacity: 0.6; border-radius: 6px;
    background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.4)); }
.wa-delivery-trigger:hover { opacity: 1; }
.wa-delivery-trigger[data-count]:not([data-count="0"])::after { content: attr(data-count); position: absolute;
    top: -6px; right: -6px; min-width: 14px; height: 14px; line-height: 14px; padding: 0 3px; font-size: 9px;
    text-align: center; color: #fff; background: var(--crimson70a, #b33); border-radius: 8px; }
.wa-delivery-panel { position: fixed; left: 10px; bottom: 46px; z-index: 100000; display: none; flex-direction: column;
    gap: 2px; width: 320px; max-width: calc(100vw - 20px); max-height: 60vh; overflow-y: auto; padding: 6px;
    border-radius: 8px; font-size: 0.85em; background: var(--SmartThemeBlurTintColor, rgba(20,20,20,0.92));
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-delivery-panel.wa-delivery-open { display: flex; }
.wa-delivery-entry { display: flex; align-items: baseline; gap: 6px; padding: 3px 5px; border-radius: 5px; cursor: pointer; }
.wa-delivery-entry:hover { background: var(--white20a, rgba(255,255,255,0.1)); }
.wa-delivery-glyph { flex: 0 0 auto; }
.wa-delivery-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-delivery-tokens { flex: 0 0 auto; margin-left: auto; opacity: 0.55; font-variant-numeric: tabular-nums; }
.wa-delivery-budget { padding: 4px 5px; opacity: 0.7; border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-delivery-empty { opacity: 0.6; padding: 4px; }
.wa-delivery-warning { padding: 4px 5px; color: #d9b74a; border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }`;
    document.head.append(style);

    deliveryTrigger = document.createElement('div');
    deliveryTrigger.className = 'wa-delivery-trigger fa-solid fa-fw fa-book-atlas';
    deliveryTrigger.title = t`WorldsApart — Entries delivered in the most recent turn`;
    deliveryTrigger.dataset.count = '0';
    deliveryPanel = document.createElement('div');
    deliveryPanel.className = 'wa-delivery-panel';
    deliveryTrigger.addEventListener('click', () => deliveryPanel.classList.toggle('wa-delivery-open'));
    document.body.append(deliveryTrigger, deliveryPanel);
}

function renderDeliveryPanel(layout) {
    ensureDeliveryPanel();
    const budget = runState.lastBudget;
    deliveryTrigger.dataset.count = String(layout.length);
    deliveryPanel.innerHTML = '';
    // Appended last: the panel opens upward, so the bottom row is nearest the icon.
    const lab = document.createElement('div');
    lab.className = 'wa-delivery-entry';
    lab.title = t`Open the Studio on the Key Lab`;
    lab.innerHTML = '<span class="wa-delivery-glyph fa-solid fa-flask"></span>'
        + `<span class="wa-delivery-title">${escapeHtml(t`Open the Key Lab`)}</span>`;
    lab.addEventListener('click', () => lorebookStudio(chatBook(), { lab: true }));
    // While a plugin route has fallen back this load; the route and cause are on the console.
    const warnRow = () => {
        if (!runState.pluginFailures.size) return [];
        const w = document.createElement('div');
        w.className = 'wa-delivery-warning';
        w.textContent = t`⚠ Plugin incompatible; ran without it.`;
        return [w];
    };
    if (!layout.length) {
        const empty = document.createElement('div');
        empty.className = 'wa-delivery-empty';
        empty.textContent = t`Nothing delivered yet`;
        deliveryPanel.append(empty, ...warnRow(), lab);
        return;
    }
    for (const row of layout) {
        const e = row.item.entry;
        const el = document.createElement('div');
        el.className = 'wa-delivery-entry';
        el.title = wiTooltip(row) + '\n\n' + t`Click: open in the Explorer · Shift-click: show the text`;
        const g = document.createElement('span');
        g.className = 'wa-delivery-glyph';
        g.textContent = wiGlyph(e);
        const ttl = document.createElement('span');
        ttl.className = 'wa-delivery-title';
        ttl.textContent = wiTitleOf(e);
        el.append(g, ttl);
        const cost = budget?.tokens.get(row.item);
        if (cost !== undefined) {
            const tok = document.createElement('span');
            tok.className = 'wa-delivery-tokens';
            tok.textContent = String(cost);
            tok.title = t`Tokens this entry costs`;
            el.append(tok);
        }
        // Click opens the entry in the Explorer; shift-click shows its text alone.
        el.addEventListener('click', ev => {
            if (ev.shiftKey) { showEntryText(e); return; }
            lorebookStudio(e.world ?? chatBook(), { entry: { world: e.world, uid: e.uid } });
        });
        deliveryPanel.append(el);
    }
    if (budget) {
        const missed = runState.lastSkipped.reduce((a, x) => a + (x.tokens ?? 0), 0);
        const foot = document.createElement('div');
        foot.className = 'wa-delivery-budget';
        // `budgeted`, not `inPrompt`: headroom is what the cap still has, and an exempt entry may not charge it.
        const num = x => Number(x).toLocaleString();
        // Headroom is what the cap still has; `over` is delivery past the cap, which exempt entries can do.
        const remain = Math.max(0, budget.maxTokens - budget.budgeted), over = Math.max(0, budget.inPrompt - budget.maxTokens);
        const parts = [remain && t`${num(remain)} remain`, missed && t`${num(missed)} cut`, over && t`${num(over)} over`].filter(Boolean);
        foot.textContent = t`Budget: ${num(budget.inPrompt)}/${num(budget.maxTokens)} tokens` + (parts.length ? ` (${parts.join(', ')})` : '');
        deliveryPanel.append(foot);
    }
    deliveryPanel.append(...warnRow(), lab);
}

let initialized = false;

export async function init() {
    // Both `hooks.activate` and the jQuery bootstrap below can reach here.
    if (initialized) {
        return;
    }
    initialized = true;
    // A failed init stays half-registered for the rest of the session — surfaced here, never retried: a retry would
    // double-register everything that succeeded before the throw.
    try {
        await initBody();
    } catch (error) {
        console.error('WorldsApart: init failed — the extension is partially active', error);
        toastr.error(t`WorldsApart failed to initialize — see the browser console.`, 'WorldsApart');
    }
}

async function initBody() {
    // Handed the pipeline's entry points once, here, so the dependency runs one way.
    setCaptureHost({ chatBook, coreSelection, dryRun, effectiveTokenBudget, paramSnapshot, scopedPriority, vectorRequestBody });

    ensureSettings(extension_settings);
    // Migrations of stored values from earlier settings shapes.
    if (settings().worldPriorityMode === 'off') settings().worldPriorityMode = 'interleaved';
    if (settings().presentationOrder in PRESENTATION_ALIAS) settings().presentationOrder = PRESENTATION_ALIAS[settings().presentationOrder];
    if (settings().studioTierCfg && !settings().tierCfg) { settings().tierCfg = settings().studioTierCfg; delete settings().studioTierCfg; }
    // Removed features — drop the orphaned stored values, or ensureSettings merges them over the defaults forever.
    for (const k of ['baselineQuery', 'baselineWeight', 'queryMode', 'summaryPrompt', 'summaryLength', 'uncenteredGate', 'keywordScoring']) delete settings()[k];
    // Not awaited: an unstored pack is a network fetch with no timeout, and ST awaits each extension's activate hook in
    // turn — blocking here holds up every later extension while the interceptor is already live and the scan hooks are
    // not yet registered. The pack applies when it lands; until then `table()` is the English one.
    setLanguage(settings().language, { fetchPack, store: packStore }).catch(() => {});
    // The one place wordBoundary crosses into the matcher, which holds it module-level; re-pushed by the select's handler below.
    matcher.setBoundaryMode(settings().wordBoundary);

    $('#extensions_settings').append(SETTINGS_HTML);

    updateEmbedInfo();   // refresh on drawer open so it tracks Vector Storage changes made mid-session
    $('#wa_embed_info').closest('.inline-drawer').children('.inline-drawer-toggle').on('click', updateEmbedInfo);

    $('#extensionsMenu').append('<div id="wa_studio" class="list-group-item flex-container flexGap5" title="WorldsApart Lorebook Studio: Manage lorebooks, entries, and keys." data-i18n="[title]WorldsApart Lorebook Studio: Manage lorebooks, entries, and keys."><div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span data-i18n="WA Lorebook Studio">WA Lorebook Studio</span></div>');
    $('#wa_studio').on('click', () => { lorebookStudio(chatBook()); });

    bind('#wa_enabled', 'enabled', 'checked');
    // ensureStudioStyle styles the sort widget; the Studio injects it lazily and this control can be used first (idempotent).
    ensureStudioStyle();
    const getTierCfg = () => reconcileTiers(settings().tierCfg);
    const setTierCfg = cfg => { settings().tierCfg = cfg; saveSettingsDebounced(); };
    const presentationMount = document.querySelector('#wa_presentation_order_mount');
    const tierMount = document.querySelector('#wa_tier_editor_mount');
    let tierEditor = null;
    const tierState = () => { $('#wa_tier_state').text(settings().presentationTiered ? t`Tiered grouping is on: the prompt groups entries by these tiers.` : t`Tiered grouping is off: this order applies in the Studio only.`); };
    if (presentationMount) presentationMount.append(makeSortControl({
        getSort: () => normPresentation(settings().presentationOrder),
        setSort: k => { settings().presentationOrder = k; saveSettingsDebounced(); },
        getTiered: () => !!settings().presentationTiered,
        setTiered: on => { settings().presentationTiered = on; saveSettingsDebounced(); tierState(); },
        getTierCfg, setTierCfg,
        extraItems: [{ label: t`Most relevant first`, key: 'best-first' }, { label: t`Most relevant last`, key: 'best-last' }],
        // Inside the settings root, or ST's autoclose reads a menu click as outside the Extensions drawer and shuts it.
        mount: () => document.querySelector('.worlds-apart-settings') ?? document.body,
        // Keeps the inline tier editor in sync when tiers are reordered from the button's menu.
        onChange: () => { if (tierEditor) tierEditor.replaceWith(tierEditor = makeTierEditor(getTierCfg, setTierCfg, () => {}, { omit: ['disabled'] })); },
        block: true,
    }));
    if (tierMount) tierMount.append(tierEditor = makeTierEditor(getTierCfg, setTierCfg, () => {}, { omit: ['disabled'] }));
    tierState();
    renderPluginSetup();                     // paints "checking…" then the detected/install state
    document.addEventListener('wa-plugin-fallback', () => renderPluginSetup());   // the first fallback of the load repaints the alert
    waVersion().then(v => { if (v) document.querySelector('#wa_version').textContent = v; });
    Promise.all([hasPlugin(), computeSourceFingerprint()]).then(() => {
        renderPluginSetup();
        // The settings banner only shows once somebody opens settings, and a drifted plugin answers with stale code meanwhile.
        if (pluginDrifted()) toastr.warning(t`Server plugin is out of date. Redeploy it and restart SillyTavern.`, 'WorldsApart', { timeOut: 0, extendedTimeOut: 0 });
    });
    bind('#wa_debug_log', 'debugLog', 'checked');
    document.querySelector('#wa_find_orphans')?.addEventListener('click', async () => {
        const out = document.querySelector('#wa_orphans_out');
        if (out) out.textContent = t`Looking…`;
        try { const line = await reportOrphanCollections(); if (out) out.textContent = line; }
        catch (error) { if (out) out.textContent = t`Failed: ${error.message}`; }
    });
    $('#wa_rater_id').val(settings().raterId);
    bind('#wa_message_depth', 'messageDepth', 'number');
    bind('#wa_match_window', 'matchWindow', 'string');
    bind('#wa_language', 'language', 'string');
    const languageState = () => {
        const tb = table();
        $('#wa_language_state').text(tb.loaded ? t`${tb.label} — ${tb.zipf.size} words` : t`${tb.lang}: pack not loaded — every word reads rare until it is`);
    };
    $('#wa_language').on('change', async () => { await setLanguage(settings().language, { fetchPack, store: packStore }); languageState(); });
    // The index is read only here, when the panel fills its list; a stored pack the index has moved is refreshed then.
    (async () => {
        const index = await refreshIndex({ fetchIndex, fetchPack, store: packStore });
        const $sel = $('#wa_language');
        const known = new Set(['en']);
        for (const [lang, meta] of Object.entries(index ?? {})) { if (!known.has(lang)) { known.add(lang); $sel.append(new Option(meta.label, lang)); } }
        // A language the store holds but the index no longer lists stays selectable while it is the setting.
        if (!known.has(settings().language)) $sel.append(new Option(settings().language, settings().language));
        $sel.val(settings().language);
        languageState();
    })();
    bind('#wa_drop_chat_tags', 'dropChatTags', 'string');
    bind('#wa_word_boundary', 'wordBoundary', 'string');
    $('#wa_word_boundary').on('change', () => matcher.setBoundaryMode(settings().wordBoundary));
    bind('#wa_llm_profile', 'llmProfile', 'string');
    bind('#wa_llm_temp', 'llmTemperature', 'string');
    bind('#wa_max_entries', 'maxVectorEntries', 'number');
    bind('#wa_max_tokens', 'maxTokens', 'number');
    bind('#wa_max_tokens_pct', 'maxTokensPercent', 'number');
    bind('#wa_budget_slack', 'budgetSlackPercent', 'number');
    bind('#wa_slack_mode', 'budgetSlackMode', 'string');
    bind('#wa_relevance_cutoff', 'relevanceCutoff', 'number');
    bind('#wa_max_dynamic', 'maxDynamicEntries', 'number');
    bind('#wa_max_total', 'maxTotalEntries', 'number');
    bind('#wa_drop_unavailable', 'dropUnavailable', 'checked');
    bind('#wa_tokens_include_exempt', 'maxTokensIncludesExempt', 'checked');

    bind('#wa_world_priority_mode', 'worldPriorityMode', 'string');
    $('#wa_world_priority_mode').on('change', renderWorldPriority);
    const $wp = $('#wa_world_priority_list');
    const editField = (field, el) => {
        const l = charPriority();
        if (!l) return;
        l[$(el).closest('.wa-world-row').data('i')][field] = Number($(el).val());
        saveSettingsDebounced();
    };
    $wp.on('input change', '.wa-world-weight', function () { editField('weight', this); });
    $wp.on('input change', '.wa-world-offset', function () { editField('offset', this); });
    $wp.on('input change', '.wa-world-cap', function () { editField('cap', this); });
    // Swap with the adjacent VISIBLE row, not the array neighbour: a filtered-out book between them must not absorb the move.
    const moveWorld = (i, dir) => {
        const scoped = scopedPriority();
        if (!scoped) return;
        const p = scoped.findIndex(x => x.i === i);
        const target = scoped[p + dir];
        if (!target) return;
        const l = charPriority();
        [l[i], l[target.i]] = [l[target.i], l[i]];
        saveSettingsDebounced();
        renderWorldPriority();
    };
    $wp.on('click', '.wa-world-up', function () { moveWorld($(this).closest('.wa-world-row').data('i'), -1); });
    $wp.on('click', '.wa-world-down', function () { moveWorld($(this).closest('.wa-world-row').data('i'), 1); });
    renderWorldPriority();

    // After bind(), so the dropdown's value survives being rebuilt.
    populateProfiles();
    $('#wa_refresh_profiles').on('click', () => populateProfiles(true));
    $('#wa_review_bundles').on('click', () => superEvalScene());

    eventSource.on(event_types.GENERATION_STARTED, (_type, _options, dryRun) => { runState.generationIsDryRun = Boolean(dryRun); });
    eventSource.on(event_types.GENERATION_ENDED, () => { runState.generationIsDryRun = false; runState.waOwnsScan = false; });
    // A stopped generation is superseded: the interceptor's `abort` cannot be read, so the token carries the stop.
    eventSource.on(event_types.GENERATION_STOPPED, () => { runState.scanToken++; });

    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);

    // WORLDINFO_ENTRIES_LOADED only fires during a scan, so CHAT_CHANGED refreshes the attached-book set.
    const refreshAttached = () => getSortedEntries().then(showExemptCount).catch(() => {});
    eventSource.on(event_types.CHAT_CHANGED, refreshAttached);
    // Wrapped, not passed by reference: CHAT_CHANGED emits the chat id, which would land in resetSmartKeys's `scope`.
    eventSource.on(event_types.CHAT_CHANGED, () => resetSmartKeys());
    // The panel survives dry-run scans untouched, so it would carry the previous chat's selection across a switch.
    eventSource.on(event_types.CHAT_CHANGED, () => { runState.lastPromptOrder = []; runState.lastLayoutOrder = []; renderDeliveryPanel([]); });
    refreshAttached();
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, onScanDone);
    // After onScanDone, so the feed sees the flag while the scan is live. Cleared on the final loop, not only at
    // GENERATION_ENDED, so a between-scans getSortedEntries escapes the blanking.
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, (args) => {
        if (!args?.state?.next) runState.waOwnsScan = false;
    });

    if (settings().enabled) renderDeliveryPanel(runState.lastPromptOrder);

    /** Registers a command under its name plus the `wa=` twin of it, keeping any aliases the props already carry. */
    const addWaCommand = props => SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        ...props,
        aliases: [...(props.aliases ?? []), props.name.replace(/^wa-/, 'wa=')],
    }));

    addWaCommand({
        name: 'wa-versus',
        callback: async (named) => { await versusCore(named); return ''; },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'how many of WA\u2019s ranked entries to carry beyond the two delivered sets, for grading depth', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '30' }),
        ],
        helpString: 'WorldsApart: what WA delivered on this turn against what ST core + Vector Storage would have, at their own budgets. Runs /wa-debug first, prints the difference, and downloads an ordinary two-arm capture bundle \u2014 grade it with Review bundles, apply with eval/synthetic-data/apply-review.mjs, then score with eval/versus-score.mjs.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-core',
        callback: () => {
            const c = runState.lastCoreSet;
            if (!c) { toastr.info(t`No core selection recorded yet — it is captured on ST’s own dry runs, so send or receive a message first.`, 'WorldsApart'); return ''; }
            console.log(`%cWorldsApart \u00b7 ST core's own selection at message ${c.at} \u2014 ${c.entries.length} entries, core budget ${c.budget ?? 'unknown'}`, 'font-weight: bold');
            console.table(c.entries.map(e => ({ uid: e.uid, order: e.order, constant: e.constant, book: e.world, entry: e.title })));
            console.log(`uids for eval/core-compare.mjs --core-uids:\n${c.entries.map(e => e.uid).join(',')}`);
            toastr.success(t`${c.entries.length} entries — see console`, t`ST core selection`);
            return '';
        },
        helpString: 'WorldsApart: what ST core selected on its own, with WA standing down. Captured from ST\u2019s dry runs, where interceptors are skipped and core runs its own budget \u2014 so it is core\u2019s shipped set, keyword route only. Console.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-dry',
        callback: () => dryRun(false),
        helpString: 'WorldsApart: run retrieval and a World Info scan without generating. Reports the settings used and what got selected, in prompt order. Console.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-debug',
        callback: () => dryRun(true),
        helpString: 'WorldsApart: same as /wa-dry plus every intermediate — query text, surviving term weights, per-signal scores, and the full vector-candidate ranking past the cut. Console.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-grade',
        callback: gradeScene,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'name', description: 'sample name, used as the filename', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'scene-<date>' }),
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'how many retrieved entries to surface for grading (the cliff is switched off for the run, so the sample can assess every cutoff mode offline)', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '20' }),
            SlashCommandNamedArgument.fromProps({ name: 'notes', description: 'free-text note stored in the sample', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        helpString: 'WorldsApart: grade this scene for the offline evals. Runs /wa-debug, then opens a window listing every activated entry with the query text and per-signal scores, for grading 0-5 (constants and stickies are listed but not graded — relevance never chose them). Saving downloads a self-contained sample: query text, settings snapshot, candidate ranking, grades, and copies of every attached lorebook, so later chat/lorebook/settings edits cannot move the numbers. Drop it in eval/eval-data/ and run eval/graded-scene-grid.mjs --sample.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-super-grade',
        callback: superGradeScene,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'name', description: 'base sample name; each arm gets "<name>--<arm>.json"', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'chat-msgN' }),
            SlashCommandNamedArgument.fromProps({ name: 'arms', description: 'which arms to capture, comma-separated (default: all)', typeList: [ARGUMENT_TYPE.STRING], enumList: Object.keys(POOL_ARMS) }),
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'candidate depth per arm (the cliff is switched off for each run)', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '30' }),
            SlashCommandNamedArgument.fromProps({ name: 'notes', description: 'free-text note stored in every sample written', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        helpString: 'WorldsApart: grade this scene against SEVERAL configurations at once, for a pool that isn\'t biased toward the current defaults. Runs /wa-debug once per arm (arms change which entries get surfaced — entity filter, retrieval mode, threshold, key suppression, summary queries), unions the entries they surfaced, dedupes, and opens one grading window over the union with a "surfaced by" column. Load earlier rounds\' samples into the file picker and their grades are subtracted, so each round only judges what is new. Saves one sample per arm — each with its own params and candidate rows, all sharing the pooled grades. Drop them in eval/eval-data/, run eval/graded-scene-grid.mjs --sample on each, and add arms until the judged@10 column stops showing gaps.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-super-eval',
        callback: superEvalScene,
        helpString: 'WorldsApart: review graded samples/bundles from their FILES, chat-independent — nothing live is read, so scenes captured offline or graded by an LLM judge open without loading their chat. Pick several and each becomes a section with its own query text; stored grades arrive pre-filled and editable, entry text comes from the embedded books. Save downloads ONE review file for the whole run; apply it with node eval/synthetic-data/apply-review.mjs <file> --write.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-studio',
        // Wrapped: ST hands callbacks (namedArgs, unnamedArgs), which would land in preferredBook.
        callback: () => lorebookStudio(chatBook()),
        helpString: 'WorldsApart: open Lorebook Studio — a wide two-pane manager listing every lorebook on the left and the selected book\'s entries on the right. Per-entry tools (mode, flags, sticky, ⚡/✨ keyword suggestions, prune-scan colouring, duplicate/delete), a Tool Settings drawer, bulk selection + actions (enable/disable, mode, sticky, trigger %, renumber, delete), and book tools (rename, duplicate, delete, type filter, suggest-all). Also on the extensions (wand) menu.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-query',
        callback: probeQuery,
        helpString: 'WorldsApart: score entries against arbitrary text without activating anything. Usage: /wa-query your query text here',
        returns: 'nothing',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'query text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
    });

    console.log('WorldsApart: ready');
}

globalThis.worldsApart_intercept = intercept;

// `hooks.activate` may not fire on every ST version; the jQuery bootstrap is the fallback.
jQuery(async () => {
    await init();
});
