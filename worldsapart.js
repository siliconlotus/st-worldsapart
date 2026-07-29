/**
 * Worlds Apart — takes over World Info selection, ranking and budget.
 *
 * Core still does the mechanical scanning (keywords, constant, sticky, recursion)
 * and the prompt assembly (positions, depth, roles, outlets, regex, Author's Note).
 * This extension decides which entries survive, in what order, and how many tokens
 * they may spend, by hooking three sanctioned points:
 *
 *   1. WORLDINFO_ENTRIES_LOADED — suppress keyword matching on vectorized entries.
 *   2. generate_interceptor      — chunked vector retrieval, force-activate the winners.
 *   3. WORLDINFO_SCAN_DONE       — rank everything activated, apply budget, rewrite `order`.
 *
 * Prompt order is set at assembly time by sorting on `entry.order` (world-info.js),
 * and the unshift-based build means the FINAL prompt order is ascending `order`.
 */

import {
    eventSource,
    event_types,
    getRequestHeaders,
    getMaxPromptTokens,
    generateRaw,
    saveSettingsDebounced,
    substituteParams,
    getExtensionPromptByName,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getSortedEntries, getWorldInfoPrompt, loadWorldInfo, saveWorldInfo, reloadEditor, duplicateWorldInfoEntry, deleteWorldInfoEntry, getFreeWorldEntryUid, deleteWIOriginalDataValue, deleteWorldInfo, updateWorldInfoList, world_names, world_info_include_names, world_info_depth, world_info_min_activations, world_info_match_whole_words, world_info_case_sensitive, selected_world_info, world_info, METADATA_KEY } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { getStringHash, splitRecursive, escapeHtml, getCharaFilename } from '../../../utils.js';
import { pluginFingerprint, PLUGIN_FILES } from './plugin/fingerprint.mjs';
import * as ranking from './extension/ranking.mjs';
import { registerKeys, resetSmartKeys } from './extension/smartkeys.mjs';
import * as selection from './extension/selection.mjs';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { oai_settings } from '../../../openai.js';

import { runState, defaultSettings, settings, ensureSettings } from './extension/state.mjs';
import { ensureStudioStyle, makeSortControl, makeTierEditor, showCtxMenu, showEntryText, wiGlyph, wiTooltip } from './extension/ui-widgets.mjs';
import { PRESENTATION_ALIAS, SORT_FNS, normPresentation, presentationBaseLabel, presentationLabel, reconcileTiers, tierRank, wiTitleOf } from './extension/sort.mjs';
import { buildKeyPruneScan, llmKeyCandidates, keywordScoresReport, keywordSuggestReport, STUDIO_PRUNE_OPTS, STUDIO_SUGGEST_OPTS } from './extension/keyword-tools.mjs';
import { buildKeySuggest, classifyLlmCand } from './extension/keyword-core.mjs';

/** Base value for the rewritten `order` sequence. WA rewrites every activated entry's order,
 * so only the relative index matters — the base is a fixed pad with no other writer to collide with. */
const ORDER_BASE = 100;

// ---------------------------------------------------------------------------
// Vector backend — reuses Vector Storage's provider config and ST's own endpoints.
// ---------------------------------------------------------------------------

/**
 * Builds the request body for /api/vector/*, borrowing Vector Storage's provider settings.
 * ponytail: model key is derived by `${source}_model` convention, which covers every
 * provider except the special cases below. Add a case if a new one breaks the pattern.
 * @param {object} args Extra body fields
 * @returns {object} Request body
 */
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

/** Mirrors Vector Storage's current embed endpoint + model into the Vector Match panel. Read-only;
 * reuses vectorRequestBody() so the per-provider derivation stays in one place. */
function updateEmbedInfo() {
    const b = vectorRequestBody();
    const endpoint = b.apiUrl || b.extrasUrl || b.siliconflow_endpoint || b.source;
    $('#wa_embed_info').text(`Embed: ${endpoint} · ${b.model || '(provider default)'}`);
}

async function vectorPost(route, args) {
    const response = await fetch(`/api/vector/${route}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(vectorRequestBody(args)),
    });

    if (!response.ok) {
        throw new Error(`Worlds Apart: /api/vector/${route} failed with ${response.status}`);
    }

    return response.status === 200 && response.headers.get('content-type')?.includes('json')
        ? await response.json()
        : null;
}


/**
 * Checks once whether the Worlds Apart server plugin is loaded. It only exists if
 * enableServerPlugins is on in config.yaml, so absence is expected, not an error.
 * @returns {Promise<boolean>} True if the plugin responded
 */
async function hasPlugin() {
    if (runState.pluginAvailable !== null) {
        return runState.pluginAvailable;
    }

    try {
        const response = await fetch('/api/plugins/worlds-apart/ping', { method: 'POST', headers: getRequestHeaders() });
        runState.pluginAvailable = response.ok;
        if (response.ok) { try { const d = await response.json(); runState.pluginRoot = d?.root ?? null; runState.pluginFP = d?.fingerprint ?? null; } catch { /* older plugin: no root/fingerprint fields */ } }
    } catch {
        runState.pluginAvailable = false;
    }

    console.log(`Worlds Apart: server plugin ${runState.pluginAvailable ? 'detected — mean-centered search available' : 'not found, using stock vector search'}`);
    return runState.pluginAvailable;
}

/**
 * Fingerprints this extension's SOURCE plugin files (fetched from its own served directory) with the
 * same hash the running plugin applies to its DEPLOYED files. Comparing the two spots a /plugins copy
 * that drifted from source — no hand-maintained version number. Cached after the first call.
 * @returns {Promise<string|null>}
 */
async function computeSourceFingerprint() {
    if (runState.sourceFP !== null) return runState.sourceFP;
    try {
        const texts = await Promise.all(
            PLUGIN_FILES.map(([src]) => fetch(new URL(`./plugin/${src}`, import.meta.url)).then(r => r.text())),
        );
        runState.sourceFP = pluginFingerprint(...texts);
    } catch { runState.sourceFP = null; }
    return runState.sourceFP;
}

/**
 * Fills the setup box under the mean-centered checkbox with copyable install commands.
 * The plugin ships inside this extension but ST loads server plugins separately, so a
 * fresh install needs: enable plugins in config → deploy the copy → restart. The deploy
 * path is derived from this module's own URL, so it's correct whatever the install folder
 * is named (ST clones into third-party/<repo-name>, which varies).
 */
function renderPluginSetup() {
    const box = $('#wa_plugin_setup');
    if (!box.length) return;
    const extDir = new URL('.', import.meta.url).pathname.replace(/\/+$/, '').split('/').pop();
    // Absolute path when the plugin has reported the ST root (runs from any cwd); otherwise the
    // ST-root-relative form with a note. Cross-platform: deploy-plugin.mjs also enables plugins in config.
    // Absolute path once the plugin has reported the ST root (runs from any cwd) — this is the
    // redeploy loop. Before first install the browser can't know the server's filesystem root
    // (no plugin, and ST core exposes no path), so the fallback is the ST-root-relative command
    // with an explicit "open a terminal there" instruction. Cross-platform; deploy also enables
    // server plugins in config.yaml.
    const rel = `public/scripts/extensions/third-party/${extDir}/deploy-plugin.mjs`;
    const deployCmd = runState.pluginRoot ? `node "${runState.pluginRoot.replace(/\\/g, '/')}/${rel}"` : `node ${rel}`;
    const row = (cmd) => {
        const r = $('<div class="flex-container alignItemsCenter flexnowrap" style="gap:6px;margin:3px 0;"></div>');
        const code = $('<code style="flex:1;overflow-x:auto;white-space:nowrap;padding:2px 6px;border-radius:4px;background:var(--black30a,rgba(0,0,0,0.2));"></code>').text(cmd);
        const btn = $('<div class="menu_button fa-solid fa-copy" title="Copy" style="margin:0;flex:0 0 auto;"></div>');
        btn.on('click', async () => {
            try { await navigator.clipboard.writeText(cmd); } catch { /* clipboard blocked; user can select the text */ }
            btn.removeClass('fa-copy').addClass('fa-check');
            setTimeout(() => btn.removeClass('fa-check').addClass('fa-copy'), 1200);
        });
        return r.append(code, btn);
    };
    box.empty();
    if (runState.pluginAvailable === null) { box.text('Checking for server plugin…'); return; }
    if (runState.pluginAvailable) {
        // Stale only when we have a source fingerprint to compare and it differs (a null runState.pluginFP is an
        // older, pre-fingerprint build, which also differs → flagged). If the source fetch failed
        // (runState.sourceFP null) we can't judge, so don't nag.
        const stale = runState.sourceFP && runState.pluginFP !== runState.sourceFP;
        if (stale) {
            box.append($('<div style="color:var(--warning,#d80);"></div>').text('⚠ Server plugin out of date — the deployed copy differs from this extension\'s source. Redeploy and restart:'));
            box.append(row(deployCmd));
            return;
        }
        box.append($('<div style="color:var(--active,#7ac);"></div>').text('✓ Server plugin active' + (runState.sourceFP ? ` — up to date (build ${runState.sourceFP}).` : '.')));
        box.append($('<div style="margin-top:3px;"></div>').text('After editing plugin code, redeploy and restart SillyTavern:'));
        box.append(row(deployCmd));
        return;
    }
    box.append($('<div></div>').text('⚠ Not detected — mean-centered search is inactive (falling back to stock vector search). To install:'));
    box.append($('<div style="margin-top:3px;"></div>').text('1. Open a terminal in your SillyTavern folder and deploy the plugin (also enables server plugins in config):'));
    box.append(row(deployCmd));
    box.append($('<div style="margin-top:3px;">2. Restart SillyTavern. This box will then show the exact redeploy command with your full path.</div>'));
}

/**
 * Runs a multi-collection query, preferring the plugin's mean-centered search.
 * Falls back to ST's endpoint if the plugin is absent or errors, so the extension
 * works on a stock install.
 * @param {object} args Query arguments
 * @returns {Promise<object>} Grouped results
 */
async function queryCollections(args) {
    if (settings().meanCentered && await hasPlugin()) {
        try {
            const body = vectorRequestBody(args);
            // The plugin needs the provider settings under one key, as the server does.
            const response = await fetch('/api/plugins/worlds-apart/query-multi', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ...body,
                    centered: settings().meanCentered,
                    bm25K1: settings().bm25K1,
                    bm25B: settings().bm25B,
                    termWeights: args.termWeights ?? null,
                    stopwordDf: settings().stopwordDocFreq,
                    // Down-weights general-English words in the lexical IDF. A measured wash under hybrid
                    // fusion (vectors mask it) but a small win for BM25-only, so it's an internal global
                    // keyed to the mode — not a setting. 0.7 for BM25-only, off (1) for hybrid/vector.
                    commonWordWeight: settings().retrievalMode === 'lexical' ? 0.7 : 1,
                    sourceSettings: { apiUrl: body.apiUrl, model: body.model, keep: body.keep },
                }),
            });

            if (response.ok) {
                return await response.json();
            }

            console.warn(`Worlds Apart: plugin query failed (${response.status}), falling back`, await response.text());
        } catch (error) {
            console.warn('Worlds Apart: plugin query threw, falling back', error);
        }
    }

    return await vectorPost('query-multi', args) ?? {};
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Splits entry text into chunks for matching.
 *
 * 'length' mode uses ST's splitRecursive, which splits on paragraph breaks and then
 * greedily merges adjacent paragraphs back together to fill chunkSize — so a chunk
 * routinely spans unrelated topics, and its centroid represents none of them.
 *
 * 'paragraph' mode keeps one paragraph per chunk. Oversized paragraphs are split
 * further; runs of very short ones are joined so stray lines aren't embedded alone.
 *
 * @param {string} content Entry content
 * @returns {string[]} Chunks
 */
function chunkEntry(content) {
    const maxLength = settings().chunkSize;

    if (settings().chunkMode !== 'paragraph') {
        return splitRecursive(content, maxLength);
    }

    const paragraphs = content
        .split(/\n\s*\n/)
        .map(x => x.trim())
        .filter(x => x);

    const chunks = [];
    let pending = '';

    for (const paragraph of paragraphs) {
        const merged = pending ? `${pending}\n\n${paragraph}` : paragraph;

        // Hold on to fragments until they carry enough signal to embed on their own.
        if (merged.length < settings().minChunkSize) {
            pending = merged;
            continue;
        }

        pending = '';

        if (merged.length <= maxLength) {
            chunks.push(merged);
        } else {
            chunks.push(...splitRecursive(merged, maxLength, ['\n', '. ', ' ', '']));
        }
    }

    if (pending) {
        chunks.push(pending);
    }

    return chunks;
}

/**
 * Chunks entries and brings the collection in sync with them.
 * Chunking is for matching only — activation still emits the whole entry.
 * @param {string} world World name
 * @param {object[]} entries Entries belonging to that world
 * @returns {Promise<{collectionId: string, owners: Map<number, string>}>}
 */
async function syncWorld(world, entries) {
    const collectionId = `wa_${getStringHash(world)}`;
    const saved = await vectorPost('list', { collectionId }) ?? [];

    const items = [];
    /** @type {Map<number, string>} chunk hash -> `${world}.${uid}` */
    const owners = new Map();

    for (const entry of entries) {
        for (const chunk of chunkEntry(entry.content)) {
            const text = chunk.trim();
            if (!text) {
                continue;
            }
            const hash = getStringHash(text);
            owners.set(hash, `${entry.world}.${entry.uid}`);
            items.push({ hash, text, index: entry.uid });
        }
    }

    const wanted = new Set(items.map(x => x.hash));
    const newItems = items.filter(x => !saved.includes(x.hash));
    const staleHashes = saved.filter(x => !wanted.has(x));

    if (newItems.length) {
        console.log(`Worlds Apart: embedding ${newItems.length} new chunks for "${world}"`);
        await vectorPost('insert', { collectionId, items: newItems });
    }

    if (staleHashes.length) {
        console.log(`Worlds Apart: dropping ${staleHashes.length} stale chunks for "${world}"`);
        await vectorPost('delete', { collectionId, hashes: staleHashes });
    }

    return { collectionId, owners };
}

// Entity filter (gazetteer + proper-noun-weighted term filter) lives in ranking.mjs — the tuning
// layer, so it stays out of the plugin and its fingerprint. buildGazetteer is pure; buildTermWeights
// takes the proper-noun boost from settings. Rationale/benchmarks are documented in ranking.mjs.
const buildGazetteer = ranking.buildGazetteer;
const buildTermWeights = (queryText, gazetteer) => ranking.buildTermWeights(queryText, gazetteer, settings().properNounBoost);

// Query building lives in ranking.mjs; inject depth + ST's substituteParams.
const buildQuery = (chat) => ranking.buildQuery(chat, { depth: settings().messageDepth, substituteParams });

/**
 * Runs chunked retrieval and force-activates the winning entries.
 * @param {object[]} chat Chat messages
 */
/**
 * Scores every vectorized entry against arbitrary query text.
 * Shared by real retrieval and by /wa-query, so calibration exercises the same path
 * generation does rather than an approximation of it.
 * @param {string} searchText Text to search with
 * @returns {Promise<{targets: object[], scores: Map<string, {score: number, chunk: string}>}>}
 */
/**
 * Serializes retrieval so a second call can't query a half-built index while the
 * first is still inserting. Changing chunk settings triggers a long re-embed, and
 * results read during one are meaningless.
 * @type {Promise<any>}
 */
let retrievalQueue = Promise.resolve();

/**
 * @param {string} searchText Text to search with
 * @returns {Promise<{targets: object[], scores: Map<string, {score: number, chunk: string}>}>}
 */
function scoreEntries(searchText, termWeights = null) {
    const run = () => scoreEntriesUnsafe(searchText, termWeights);
    const result = retrievalQueue.then(run, run);
    retrievalQueue = result.catch(() => {});
    return result;
}

/**
 * @param {string} searchText Text to search with
 * @returns {Promise<{targets: object[], scores: Map<string, {score: number, chunk: string}>}>}
 */
async function scoreEntriesUnsafe(searchText, termWeights = null) {
    const allEntries = await getSortedEntries();
    const targets = allEntries.filter(x => x.vectorized && !x.disable && x.content);
    /** @type {Map<string, {score: number, chunk: string}>} */
    const scores = new Map();

    if (!targets.length || !searchText) {
        return { targets, scores };
    }

    const byWorld = {};
    for (const entry of targets) {
        (byWorld[entry.world] ??= []).push(entry);
    }

    const collectionIds = [];
    /** @type {Map<number, string>} */
    const owners = new Map();

    for (const world of Object.keys(byWorld)) {
        const synced = await syncWorld(world, byWorld[world]);
        collectionIds.push(synced.collectionId);
        synced.owners.forEach((v, k) => owners.set(k, v));
    }

    const topK = Math.max(10, settings().maxVectorEntries * 20);
    const results = await queryCollections({
        collectionIds,
        searchText,
        topK,
        threshold: settings().scoreThreshold,
        termWeights,
    });

    // Score each entry by its BEST chunk — this is the whole point of chunking.
    // `score` is only present if the backend returns it; without that patch we fall
    // back to rank position, which is still correctly ordered within a collection.
    for (const group of Object.values(results)) {
        const metadata = group?.metadata ?? [];
        metadata.forEach((item, index) => {
            const owner = owners.get(Number(item?.hash));
            if (!owner) {
                return;
            }

            const score = typeof item?.score === 'number' ? item.score : 1 - (index / Math.max(1, metadata.length));
            const bm25 = typeof item?.bm25 === 'number' ? item.bm25 : 0;
            const previous = scores.get(owner);

            // Vector and lexical are pooled independently: an entry's best semantic
            // chunk and its best lexical chunk need not be the same one.
            if (!previous || previous.score < score) {
                scores.set(owner, {
                    score,
                    chunk: String(item?.text ?? ''),
                    bm25: Math.max(bm25, previous?.bm25 ?? 0),
                });
            } else if (bm25 > previous.bm25) {
                previous.bm25 = bm25;
            }
        });
    }

    return { targets, scores };
}

/** Summaries keyed by the hash of the raw text they condense. @type {Map<number, string>} */
const summaryCache = new Map();

/**
 * Condenses raw chat text into a scene description, so the query sits at the same
 * level of abstraction as the entries. Cached on the chat state AND every setting that
 * affects the output, so repeated dry runs and rerolls are free but any change that
 * would alter the summary produces a fresh one.
 * @param {string} rawText Raw query text
 * @returns {Promise<string>} Summary, or the raw text if summarization fails
 */
async function summarizeQuery(rawText) {
    const prompt = `${rawText}\n\n${settings().summaryPrompt}`;
    // Key on everything that changes the output, not just the prompt — otherwise editing
    // the temperature, switching profile, or toggling the preset silently reuses the old
    // summary. Anything that would produce a different answer must be in the key.
    const s = settings();
    const key = getStringHash(`${prompt} ${s.summaryProfile} ${s.summaryTemperature} ${s.summaryBypassPreset} ${s.summaryLength}`);

    if (summaryCache.has(key)) {
        console.log('Worlds Apart: reusing cached summary');
        return summaryCache.get(key);
    }

    try {
        const profileId = settings().summaryProfile;
        const profile = profileId
            ? (extension_settings.connectionManager?.profiles ?? []).find(x => x.id === profileId)
            : null;

        const includePreset = !settings().summaryBypassPreset;

        // Empty means "don't send it" — the preset (or the backend default when the
        // preset is bypassed) decides. Only reachable on the profile path; generateRaw
        // takes no generation parameters, so the current-API path can't honour it.
        const temperature = String(settings().summaryTemperature ?? '').trim();
        const overridePayload = temperature === '' ? {} : { temperature: Number(temperature) };

        if (temperature !== '' && !profile) {
            console.warn(`Worlds Apart: summary temperature ${temperature} ignored — it needs a summary profile. The current API's preset governs instead.`);
        }

        console.log(`Worlds Apart: summarizing ${prompt.length} chars via ${profile ? `profile "${profile.name}"${includePreset ? ` with preset "${profile.preset ?? 'none'}"` : ' (preset bypassed)'}` : 'the current API'}${profile && temperature !== '' ? `, temperature ${temperature}` : ''}`);

        // The full prompt is the instruction plus the whole chat slice — thousands of
        // tokens. Only dump it on a debug run, and as an object so devtools collapses it.
        if (runState.verboseRun) {
            console.log('%cWorlds Apart · summarizer prompt', 'font-weight: bold', { prompt });
        }

        let summary;

        if (profile) {
            const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, settings().summaryLength, { includePreset }, overridePayload);
            summary = String(result?.content ?? '').trim();

            // Reasoning models put everything in `reasoning` and return empty content.
            // The reasoning is meta-commentary about the task, so it's not usable as a
            // query even when it contains the right answer — say so rather than guess.
            if (!summary && result?.reasoning) {
                throw new Error(`profile "${profile.name}" is a reasoning model: it returned ${String(result.reasoning).length} chars of reasoning and no content. Pick a profile without ":thinking".`);
            }
        } else {
            summary = String(await generateRaw({
                prompt,
                responseLength: settings().summaryLength,
            })).trim();
        }

        if (!summary) {
            throw new Error('empty summary');
        }

        // ponytail: unbounded cache. Chats end long before this matters.
        summaryCache.set(key, summary);
        return summary;
    } catch (error) {
        console.warn('Worlds Apart: summarization failed, using raw messages', error);
        return rawText;
    }
}

/**
 * Ranks retrieval results by fusing the vector and lexical rankings.
 *
 * Shared by retrieval and by /wa-query so the calibration view can't disagree with
 * what actually gets activated — sorting the probe by vector score alone hid strong
 * lexical matches at the bottom of the table.
 *
 * @param {Map<string, {score: number, bm25?: number, chunk: string}>} scores Per-entry results
 * @returns {Array<{key: string, value: object, fused: number, vectorRank?: number, textRank?: number}>} Fused ranking
 */
function fuseRetrieval(scores) {
    const entries = [...scores.entries()];
    const k = settings().rrfK;
    const mode = settings().retrievalMode;
    const useVector = mode !== 'lexical';
    const useText = mode !== 'vector';

    const rankOf = (sortKey) => new Map([...entries]
        .sort((a, b) => (b[1][sortKey] ?? 0) - (a[1][sortKey] ?? 0))
        .map(([key], index) => [key, index + 1]));

    const vectorRanks = rankOf('score');
    const textRanks = rankOf('bm25');

    return entries
        .map(([key, value]) => {
            const vectorRank = useVector ? vectorRanks.get(key) : undefined;
            const textRank = useText && value.bm25 > 0 ? textRanks.get(key) : undefined;
            return {
                key,
                value,
                vectorRank,
                textRank,
                fused: (vectorRank ? 1 / (k + vectorRank) : 0)
                    + (textRank ? settings().lexicalWeight / (k + textRank) : 0),
            };
        })
        .sort((a, b) => b.fused - a.fused);
}

/**
 * Runs retrieval against the chat and force-activates the winning entries.
 * @param {object[]} chat Chat messages
 */
async function retrieve(chat) {
    runState.lastScores.clear();
    runState.lastTextScores.clear();

    const rawText = buildQuery(chat);

    if (!rawText) {
        console.log('Worlds Apart: no query text, skipping retrieval');
        return;
    }

    const searchText = settings().queryMode === 'summary'
        ? await summarizeQuery(rawText)
        : rawText;

    runState.lastQueryText = searchText;

    if (settings().queryMode === 'summary') {
        console.log(`Worlds Apart: summarized ${rawText.length} chars into ${searchText.length}: "${searchText}"`);
    } else {
        console.log(`Worlds Apart: query is ${searchText.length} chars from ${settings().messageDepth} message(s), matched against ~${settings().chunkSize}-char entry chunks`);
    }

    // Entity filtering only helps raw chat text; a summary is already salience-selected.
    let termWeights = null;

    if (settings().entityFilter && settings().queryMode !== 'summary') {
        const gazetteer = buildGazetteer(await getSortedEntries());
        termWeights = buildTermWeights(searchText, gazetteer);
        console.log(`Worlds Apart: entity filter kept ${Object.keys(termWeights).length} terms (gazetteer has ${gazetteer.size})`);

        if (runState.verboseRun) {
            const byWeight = Object.entries(termWeights).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            console.log(`%cWorlds Apart · surviving query terms — what the entity filter kept, ×N is the proper-noun boost (${byWeight.length} terms)`, 'font-weight: bold');
            console.log(byWeight.map(([term, weight]) => (weight > 1 ? `${term}×${weight}` : term)).join(' '));
        }
    }

    const { targets, scores } = await scoreEntries(searchText, termWeights);

    if (!scores.size) {
        console.log(`Worlds Apart: nothing cleared the ${settings().scoreThreshold} threshold`);
        return;
    }

    const winnerKeys = new Set(cutRetrieved(fuseRetrieval(scores)).map(x => x.key));

    for (const [key, value] of scores) {
        if (winnerKeys.has(key)) {
            runState.lastScores.set(key, value.score);
            runState.lastTextScores.set(key, value.bm25 ?? 0);
        }
    }

    const activated = targets.filter(x => winnerKeys.has(`${x.world}.${x.uid}`));

    console.log(`Worlds Apart: activating ${activated.length} entries`);
    await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, activated);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Generation interceptor. Runs before the World Info scan.
 * @param {object[]} chat Chat messages
 * @param {number} _maxContext Max context size
 * @param {string} type Generation type
 */
async function intercept(chat, _maxContext, type) {
    if (!settings().enabled || type === 'quiet') {
        return;
    }

    try {
        await retrieve(chat);
    } catch (error) {
        console.error('Worlds Apart: retrieval failed, falling back to core behavior', error);
        runState.lastScores.clear();
    }
}

/**
 * Blanks keys on vectorized entries so the keyword scan skips them.
 * Entries here are freshly-spread objects, so REASSIGNING `key` is safe —
 * mutating the array in place would corrupt the cached world data.
 * @param {object} loaded Lore buckets
 */
function suppressKeys(loaded) {
    const entries = Object.values(loaded ?? {}).filter(Array.isArray).flat();

    // Free ride: this hook already sees every entry in scope, so count the exempt ones
    // here rather than loading the lorebooks a second time.
    showExemptCount(entries);

    if (!settings().enabled || !settings().suppressVectorKeys) {
        return;
    }

    for (const entry of entries) {
        if (entry?.vectorized) {
            // Stash before blanking so scoreVectorKeys can rank on the real keys after core is
            // blinded to them. keywordScore only reads primary keys, so that's all we keep.
            entry.waKeys = entry.key;
            entry.key = [];
            entry.keysecondary = [];
        }
    }
}

/**
 * Reports how many entries are exempt from the caps, since that number changes what
 * the caps mean and is otherwise invisible — it lives on individual entries.
 * @param {object[]} entries All entries in scope
 */
function showExemptCount(entries) {
    // These entries are ST's full active set for the chat (chat + character + globals), so
    // their worlds are exactly the books "attached to the chat" — the scope of the priority
    // feature. Refreshed on every WI load and chat/character change, authoritatively (a
    // book-less chat clears it), and before the panel-open check so the /wa-debug book line
    // stays correct with the panel closed.
    runState.attachedWorlds = new Set(entries.map(e => e?.world).filter(Boolean));
    renderWorldPriority();

    const field = $('#wa_exempt_count');

    if (!field.length) {
        return;
    }

    const exempt = entries.filter(x => x?.ignoreBudget).length;

    // Nothing to say when there are none, which is the common case.
    field.text(exempt
        ? `${exempt} of ${entries.length} entries are marked "ignore budget" — never cut, and not counted toward the entry caps.`
        : '');
}

/**
 * Renders the enumerated per-book priority list from settings. Books self-populate as WA
 * sees them (ensureWorldConfigs); this only reflects what's already stored. Weight/offset
 * inputs show only in interleaved mode — sequential uses list order alone.
 */
function renderWorldPriority() {
    const $list = $('#wa_world_priority_list');
    if (!$list.length) {
        return;
    }

    const mode = settings().worldPriorityMode;
    $('#wa_world_priority_mode').val(mode);
    // Scoped to the current character's saved order, filtered to what's attached to this chat.
    // data-i is the index in that stored list, so edits/reorders still land right.
    const scoped = scopedPriority();

    if (scoped == null) {
        $list.html('<small class="opacity50p">No character selected. Lorebook order is per-character — open a character to set one.</small>');
        return;
    }
    if (!scoped.length) {
        $list.html('<small class="opacity50p">No lorebooks attached. Open a chat with a lorebook active, or run /wa-dry.</small>');
        return;
    }

    // Reorder matters only for sequential tiers; weight/offset only for interleaved. The
    // per-book cap is a quota independent of priority, so it shows in every mode.
    const showOrder = mode === 'sequential';
    const showTuning = !showOrder;
    $list.empty();
    scoped.forEach(({ cfg, i, world }) => {
        const label = cfg.world === 'chat' ? `${world} (current chat)` : world;
        const row = $(`
            <div class="flex-container alignItemsCenter flexnowrap wa-world-row" data-i="${i}" style="gap:4px;margin-bottom:2px;">
                <div class="menu_button fa-solid fa-chevron-up wa-world-up ${showOrder ? '' : 'displayNone'}" title="Higher priority"></div>
                <div class="menu_button fa-solid fa-chevron-down wa-world-down ${showOrder ? '' : 'displayNone'}" title="Lower priority"></div>
                <span class="flex1 wa-world-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
                <label class="${showTuning ? '' : 'displayNone'}" title="Relevance multiplier for this book">×<input type="number" class="text_pole wa-world-weight" style="width:4em;" min="0" step="0.1"></label>
                <label class="${showTuning ? '' : 'displayNone'}" title="Prompt-order offset for this book">±<input type="number" class="text_pole wa-world-offset" style="width:4.5em;" step="1"></label>
                <label title="Max dynamic entries from this book (0 = no cap)">≤<input type="number" class="text_pole wa-world-cap" style="width:4em;" min="0" step="1"></label>
            </div>`);
        row.find('.wa-world-name').text(label);
        row.find('.wa-world-weight').val(cfg.weight);
        row.find('.wa-world-offset').val(cfg.offset);
        row.find('.wa-world-cap').val(cfg.cap ?? 0);
        $list.append(row);
    });
}

// ---------------------------------------------------------------------------
// Keyword scoring (BM25-style) and rank fusion
// ---------------------------------------------------------------------------

// Keyword occurrence counting lives in ranking.mjs (same signature, no injection).
const countKey = ranking.countKey;

/**
 * The non-chat texts core's scan buffer can also match against, per entry opt-in flags
 * (matchCharacterDescription, matchScenario, …). "Shane" living in a character card is
 * why an entry fires every turn with nothing in the chat — core scans these, so WA must.
 *
 * characterDepthPrompt is left empty, matching dryRun: it isn't cleanly reachable here
 * and is a rare match source. The rest come straight off the active character/persona.
 * @returns {object} Source texts keyed as core's globalScanData expects
 */
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

/**
 * Text from extension prompts flagged for scanning (Author's Note with "Scan" on, and
 * any extension that injects with scan: true). Core adds these to the scan buffer for
 * every entry — so a keyword living only in the Author's Note fires each turn, and WA
 * has to scan it too or it scores 0.
 *
 * Mirrors core's loop in getWorldInfoPrompt: filter + macro handling come from
 * getExtensionPromptByName, so this is the same text core scanned.
 * @returns {Promise<string>} The scan-enabled inject text, joined
 */
async function scanInjects() {
    const prompts = getContext().extensionPrompts ?? {};
    const parts = [];

    for (const key of Object.keys(prompts)) {
        if (prompts[key]?.scan) {
            const prompt = await getExtensionPromptByName(key);
            if (prompt) {
                parts.push(prompt);
            }
        }
    }

    return parts.join('\n');
}

/** Maps each entry match-flag to the scanSources() field it pulls in, as core's buffer does. */
const MATCH_SOURCE_FIELDS = {
    matchPersonaDescription: 'personaDescription',
    matchCharacterDescription: 'characterDescription',
    matchCharacterPersonality: 'characterPersonality',
    matchCharacterDepthPrompt: 'characterDepthPrompt',
    matchScenario: 'scenario',
    matchCreatorNotes: 'creatorNotes',
};

/**
 * Appends the extra scan sources an entry opted into, so WA scores keywords over the
 * same text core matched against — not just the chat window.
 * @param {string} chatWindow The depth-limited chat text
 * @param {object} entry World Info entry
 * @param {object} sources Output of scanSources()
 * @returns {string} chatWindow plus any opted-in source texts
 */
function withMatchSources(chatWindow, entry, sources) {
    let text = chatWindow;

    for (const [flag, field] of Object.entries(MATCH_SOURCE_FIELDS)) {
        if (entry[flag] && sources[field]) {
            text += `\n${sources[field]}`;
        }
    }

    return text;
}

// Keyword scoring and RRF fusion live in ranking.mjs (the tuning layer). Inject the BM25 k1 + the
// world-info match defaults for scoring, and the fusion weights for fusion — all from settings.
const keywordScore = (entry, text, keys = entry.key) => ranking.keywordScore(entry, text, keys, {
    k1: settings().bm25K1,
    caseSensitiveDefault: world_info_case_sensitive,
    wholeWordsDefault: world_info_match_whole_words,
});
const fuseRanks = (items) => ranking.fuseRanks(items, {
    rrfK: settings().rrfK,
    retrievalMode: settings().retrievalMode,
    weightByOrder: settings().weightByOrder,
    lexicalWeight: settings().lexicalWeight,
});

/**
 * Ranks everything core activated, applies our budget, and rewrites `order`
 * so assembly emits entries in relevance order.
 * @param {object} args Scan state from world-info.js
 */
/**
 * Stable per-character key for the priority order — survives switching chats/branches.
 * Null in a character-less context (nothing selected), which makes the feature inert.
 * Group chats key by group id (also stable, and their attached books are shared).
 */
function priorityKey() {
    const ctx = getContext();
    if (ctx.groupId) return `group:${ctx.groupId}`;
    if (ctx.characterId == null) return null;
    return getCharaFilename(ctx.characterId);
}

/** The current chat's bound lorebook, or null. The `'chat'` sentinel resolves to this. */
function chatBook() {
    return getContext().chatMetadata?.[METADATA_KEY] || null;
}

/**
 * The current character's saved priority list — the live, mutable reference. Seeded on first
 * access from the legacy global list so existing tuning carries over, then diverges per
 * character. Null when nothing is selected: without a character there is nowhere to store an
 * order, so the feature does nothing (the panel shows "no character selected").
 */
function charPriority() {
    const key = priorityKey();
    if (key == null) return null;
    const byChar = (settings().worldPriorityByChar ??= {});
    if (!byChar[key]) {
        // Migration seed: copy the legacy global list once, abstracting the current chat's
        // book to the 'chat' sentinel so the seeded order is already branch-stable.
        const legacy = settings().worldPriority;
        const book = chatBook();
        byChar[key] = legacy?.length
            ? structuredClone(legacy).map(w => (book && w.world === book ? { ...w, world: 'chat' } : w))
            : [];
    }
    return byChar[key];
}

/** Resolve one entry's book name, turning the `'chat'` sentinel into the live chat book. */
function resolvedName(entry) {
    return entry.world === 'chat' ? chatBook() : entry.world;
}

/**
 * The current character's priority entries, in order, each paired with its storage index (so
 * reorder/edit still target the right element) and its resolved book name. Scoped to the books
 * actually attached to this chat, so a book in the saved order but inactive here drops out.
 * Returns `null` when no character is selected — distinct from an empty list (character with
 * no attached books). The `'chat'` sentinel drops out when the chat has no bound book.
 */
function scopedPriority() {
    const list = charPriority();
    if (list == null) return null;
    return list
        .map((cfg, i) => ({ cfg, i, world: resolvedName(cfg) }))
        .filter(x => x.world && runState.attachedWorlds.has(x.world));
}

/**
 * Default sequential-priority rank of a book by its ST binding source: global → persona → character
 * → chat, everything unclassified last. Only used to seed a FRESH list (see ensureWorldConfigs), so
 * it never reorders a hand-arranged one. First match wins if a book is bound in more than one place.
 */
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
    // A fresh (empty) list is seeded in source order; a populated one keeps its order (possibly
    // hand-arranged) and just gets the new books appended. The chat's book is stored as the
    // 'chat' sentinel so the order survives switching chats/branches.
    if (list.length === 0) toAdd.sort((a, b) => worldSourceRank(a) - worldSourceRank(b));
    for (const world of toAdd) list.push({ world: world === book ? 'chat' : world, weight: 1, offset: 0, cap: 0 });
    saveSettingsDebounced();
    renderWorldPriority();
}

async function rankActivated(args) {
    const activated = args?.activated?.entries;

    if (!settings().enabled || !(activated instanceof Map)) {
        return;
    }
    if (activated.size === 0) {
        runState.lastLayout = [];
        if (!args?.state?.next) renderWiPanel([]);
        return;
    }

    const items = [...activated.entries()].map(([key, entry]) => {
        // We overwrite `order` below, and this fires once per scan loop — stash the
        // authored value on first sight so later loops don't sort by our own output.
        entry.waOriginalOrder ??= entry.order ?? 0;
        return { key, entry, score: runState.lastScores.get(key), textScore: runState.lastTextScores.get(key) ?? 0 };
    });

    // Books contributing entries to this scan — the priority sorts below rank only among
    // these, and this registers any unseen one so its config can be set. Doubles as the
    // attached set for the ordering path (independent of the async UI-scoping refresh).
    const scanWorlds = new Set(items.map(it => it.entry.world));
    ensureWorldConfigs(scanWorlds);

    if (settings().keywordScoring) {
        const windows = new Map();
        // Core removes hidden/system messages before it scans, then counts depth over
        // what remains. WA must filter them too — otherwise a hidden message in the
        // recent window costs WA a slot core didn't spend, so WA scans less real history
        // and misses a keyword core matched one message further back.
        // (Core also regex-scripts messages and appends file content; not mirrored here.)
        const chat = (getContext().chat ?? []).filter(x => x && !x.is_system);
        const sources = scanSources();
        // Scanned once and shared across depths — core adds injects to the buffer for
        // every entry regardless of scan depth.
        const injectText = await scanInjects();

        // Register every key this pass will score BEFORE the loop, so the smartkeys automaton is
        // built once — a first-seen key mid-loop would rebuild it and throw away every cached scan.
        registerKeys(items.flatMap(it => it.entry.key?.length ? it.entry.key
            : (settings().scoreVectorKeys ? (it.entry.waKeys ?? []) : [])));

        for (const item of items) {
            // Score keywords over the shared message depth. Per-entry scanDepth still wins
            // (as in core), so an entry that declares its own window is honoured; otherwise
            // the unified messageDepth, falling back to core's scan depth only if it's unset.
            const depth = Number(item.entry.scanDepth) || settings().messageDepth || world_info_depth;
            if (!windows.has(depth)) {
                // Include speaker names when core does — otherwise a keyword that only
                // appears as a "Name:" prefix is matched by core and missed here.
                let window = chat.slice(-depth)
                    .map(x => (world_info_include_names && x?.name ? `${x.name}: ${x.mes ?? ''}` : String(x?.mes ?? '')))
                    .join('\n');
                if (injectText) {
                    window += `\n${injectText}`;
                }
                windows.set(depth, window);
            }
            // Append the character/persona/scenario texts this entry opted into scanning.
            const scanText = withMatchSources(windows.get(depth), item.entry, sources);
            // A blanked 🔗 entry has empty keys but its originals in waKeys; score those only
            // when scoreVectorKeys is on. Any entry with live keys (non-vectorized, or 🔗 with
            // suppress off) uses them as before.
            const scoreKeys = item.entry.key?.length ? item.entry.key
                : (settings().scoreVectorKeys ? (item.entry.waKeys ?? []) : []);
            const scored = keywordScore(item.entry, scanText, scoreKeys);
            item.keywordScore = scored.score;
            item.keywordHits = scored.hits;
            item.keywordScanText = scanText;
        }

        // The scan text WA actually searched, so a "WA scored 0" mystery is answered by
        // looking: if the key isn't in here but core matched it, core scanned something
        // WA doesn't mirror (a regex script, an attached file, an extension's inject
        // buffer) or another extension force-activated the entry.
        if (runState.verboseRun) {
            console.log('%cWorlds Apart · keyword scan windows — the exact text WA searched, by depth', 'font-weight: bold');
            console.log(Object.fromEntries([...windows]));
        }
    }

    fuseRanks(items);

    // Budget walk order — NOT prompt order. Stickies and constants are always-on by
    // authorial intent, so they go first and the budget can only ever cut into the
    // retrieved block, weakest match first. Classification is by what an entry IS: a
    // constant that also matched keywords is scaffolding, not a retrieval result.
    const sticky = [];
    const constant = [];
    const results = [];

    for (const item of items) {
        if (args?.timedEffects?.isEffectActive('sticky', item.entry)) {
            sticky.push(item);
        } else if (item.entry.constant) {
            constant.push(item);
        } else {
            results.push(item);
        }
    }

    // Interleaved mode's per-book offset rides on the authored order, so it threads through
    // every layout comparator (and the retention tiebreak) consistently. Sequential mode
    // ignores offset — it groups the layout by book tier instead (below).
    const priorityMode = settings().worldPriorityMode;
    // Resolve the character's saved order (chat sentinel → live book) once, up front, so the
    // sort comparators don't re-resolve per comparison. `cfgOf` defaults for unknown books.
    const priorityList = charPriority() ?? [];
    const cfgByName = new Map(priorityList.map(w => [resolvedName(w), w]).filter(([n]) => n));
    const cfgOf = name => cfgByName.get(name) ?? { weight: 1, offset: 0, cap: 0 };
    // Tier rank scoped to the books in THIS scan only, in saved priority order — a book left
    // over from another chat can neither occupy a tier nor shift the ones actually present.
    const priorityOrder = [...cfgByName.keys()].filter(name => scanWorlds.has(name));
    const rankOf = world => { const i = priorityOrder.indexOf(world); return i < 0 ? priorityOrder.length : i; };
    const orderOf = it => it.entry.waOriginalOrder + (priorityMode === 'sequential' ? 0 : cfgOf(it.entry.world).offset);
    const authored = (a, b) => orderOf(a) - orderOf(b);
    // Insertion order draws from the shared sort vocabulary (SORT_FNS), same as the Studio. Order asc/desc
    // keep the offset-aware `authored` (book offsets + priority modes) rather than plain SORT_FNS['order-*'];
    // relevance (best-first/last) is prompt-only (needs the query-time fused score); everything else adapts
    // SORT_FNS over item.entry, falling back to authored within equal keys so ties stay deterministic.
    const orderKey = normPresentation(settings().presentationOrder);
    const baseCompare =
        orderKey === 'order-asc'  ? authored :
        orderKey === 'order-desc' ? (a, b) => -authored(a, b) :
        orderKey === 'best-first' ? (a, b) => (b.fused - a.fused) || authored(a, b) :
        orderKey === 'best-last'  ? (a, b) => (a.fused - b.fused) || authored(a, b) :
        SORT_FNS[orderKey]        ? (a, b) => SORT_FNS[orderKey](a.entry, b.entry) || authored(a, b) :
        authored;
    // Optional tiered grouping (default off — preserves existing output). Groups by tier first (shared
    // config), base order within. Disabled entries never activate, so that tier is inert here.
    const layoutTierCfg = reconcileTiers(settings().tierCfg);
    const compare = settings().presentationTiered
        ? (a, b) => (tierRank(a.entry, layoutTierCfg) - tierRank(b.entry, layoutTierCfg)) || baseCompare(a, b)
        : baseCompare;

    // Retention order for the dynamic block. Sequential: book tier is the primary key, so a
    // lower book only gets slots the higher books leave. Interleaved: a per-book weight
    // scales fused, so a strong low-book entry can still out-rank a weak high-book one.
    if (priorityMode === 'sequential') {
        results.sort((a, b) => (rankOf(a.entry.world) - rankOf(b.entry.world)) || (b.fused - a.fused) || authored(a, b));
    } else {
        // Interleaved: per-book weight scales fused (weight 1 = plain relevance ranking).
        results.sort((a, b) => (b.fused * cfgOf(b.entry.world).weight - a.fused * cfgOf(a.entry.world).weight) || authored(a, b));
    }
    let ranked = [...sticky.sort(authored), ...constant.sort(authored), ...results];

    const maxTokens = effectiveTokenBudget();
    const maxTotal = settings().maxTotalEntries;
    const maxDynamic = settings().maxDynamicEntries;
    const bookCaps = new Map(priorityList.filter(w => w.cap > 0).map(w => [resolvedName(w), w.cap]).filter(([n]) => n));

    if (maxTokens > 0 || maxTotal > 0 || maxDynamic > 0 || bookCaps.size) {
        const dynamicSet = new Set(results);
        const { survivors, counted, skipped, dropped, budgeted, inPrompt } = await applyBudget({
            ranked,
            isDynamic: item => dynamicSet.has(item),
            maxTokens,
            maxTotal,
            maxDynamic,
            capOf: item => bookCaps.get(item.entry.world) ?? 0,
            tokensOf: item => (maxTokens > 0 ? getTokenCountAsync(item.entry.content ?? '') : 0),
            exemptIsBudgeted: settings().maxTokensIncludesExempt,
            slack: (Number(settings().budgetSlackPercent) || 0) / 100,
            slackOnce: settings().budgetSlackMode !== 'all',
        });

        for (const item of ranked) {
            if (!survivors.has(item)) {
                activated.delete(item.key);
            }
        }

        if (dropped) {
            const caps = [
                maxDynamic > 0 ? `dynamic ${results.filter(x => survivors.has(x) && !x.entry.ignoreBudget).length}/${maxDynamic}` : null,
                maxTotal > 0 ? `total ${counted}/${maxTotal}` : null,
                maxTokens > 0 ? `tokens ${budgeted}/${maxTokens} budgeted${inPrompt !== budgeted ? `, ${inPrompt - budgeted} exempt, ${inPrompt} in prompt` : ''}` : null,
            ].filter(Boolean).join(', ');
            const exempt = survivors.size - counted;
            console.log(`Worlds Apart: budget dropped ${dropped} entries — ${caps}${exempt ? `, plus ${exempt} ignoreBudget (uncapped)` : ''}, ${survivors.size} in prompt`);
        }

        runState.lastSkipped = skipped;
        runState.lastDropped = ranked.filter(x => !survivors.has(x));
        ranked = ranked.filter(x => survivors.has(x));
    } else {
        runState.lastSkipped = [];
        runState.lastDropped = [];
    }

    // Selection is done; now lay the survivors out — one flat sort over everything, so
    // a lorebook that uses `order` to build tiers (reference material above memories,
    // say) keeps those tiers. The blocks above are a budget policy, not a layout: they
    // decide what gets cut, never where the survivors sit.
    //
    // Rewriting `order` rather than leaving it alone keeps entries that share an order
    // value in a deterministic sequence instead of at the mercy of core's tiebreak.
    // Sequential mode groups the whole prompt by book tier — book1's survivors, then
    // book2's — with the chosen layout order applied within each book.
    const layout = priorityMode === 'sequential'
        ? [...ranked].sort((a, b) => (rankOf(a.entry.world) - rankOf(b.entry.world)) || compare(a, b))
        : [...ranked].sort(compare);

    // Assembly sorts descending by `order` then unshifts, so the prompt reads
    // in ASCENDING order value. Index 0 of `layout` therefore lands first. WA owns the
    // whole `order` space (it rewrites every activated entry), so the base is a fixed
    // pad, not a setting — nothing else writes here to collide with.
    layout.forEach((item, index) => {
        item.entry.order = ORDER_BASE + index;
    });

    // Stash for /wa-dry. Classification is recomputed nowhere else, so record it here.
    const blockOf = new Map([
        ...sticky.map(x => [x, 'sticky']),
        ...constant.map(x => [x, 'constant']),
        ...results.map(x => [x, 'dynamic']),
    ]);
    runState.lastLayout = layout.map(item => ({ item, block: blockOf.get(item) ?? 'dynamic' }));
    runState.lastDropped = runState.lastDropped.map(item => ({ item, block: blockOf.get(item) ?? 'dynamic' }));
    runState.lastSkipped = runState.lastSkipped.map(x => ({ ...x, block: blockOf.get(x.item) ?? 'dynamic' }));

    // Reflect the final selection in the active-entries panel. Fires once per scan
    // loop; only the last one (no further state) is the real prompt.
    if (!args?.state?.next) renderWiPanel(runState.lastLayout);

    // A plain /wa-dry has its own selected table below; this one is the selection candidates
    // — everything activated, ranked, before caps cut into it. Only /wa-debug wants this much.
    if (runState.verboseRun) {
        console.log('%cWorlds Apart · selection candidates — every activated entry with its per-signal scores, before caps or layout', 'font-weight: bold');
        console.table(ranked.map((x, i) => ({
            // Columns lead like the selected table — title, then block, sticky, score, uid,
            // wiOrder — then the per-signal scores under the same names (cosine, text, keys), each
            // with its rank. `block` is the RUNTIME budget class (constant / sticky-active /
            // dynamic); `sticky` is the entry's CONFIGURED sticky value (0 = off). The two differ:
            // an entry with sticky configured still shows block `dynamic` on the turn it keyword-
            // activates, and dry runs (/wa-debug) never arm the effect at all — so the eval tiers
            // scaffolding off constant-or-`sticky`, not off the runtime block, which it can't observe.
            // Numeric fields stay numeric so the copied JSON is computable: `null` for "no
            // signal" (distinct from a real 0), rounded (not toFixed strings) for a readable
            // grid, and `sticky` is the count itself (0 = off). Only `block` is categorical.
            title: x.entry.comment,
            block: blockOf.get(x) ?? 'dynamic',
            sticky: x.entry.sticky || 0,
            score: x.fused ? Number(x.fused.toFixed(5)) : null,
            uid: x.entry.uid,
            wiOrder: x.entry.waOriginalOrder,
            cosine: x.score !== undefined ? Number(x.score.toFixed(5)) : null,
            vRank: x.vectorRank ?? null,
            // BM25 over chunk text — the signal doing the work for vectorized entries.
            text: x.textScore ? Number(x.textScore.toFixed(2)) : null,
            tRank: x.textRank ?? null,
            // BM25 over entry keys — only ever non-zero for non-vectorized entries.
            keys: x.keywordScore ? Number(x.keywordScore.toFixed(2)) : null,
            kRank: x.keywordRank ?? null,
            '#': i,
        })));
    }

    // Live generations get the same "what was selected and why" table /wa-dry prints —
    // it answers the question you actually have when watching a real turn. Only on the
    // final loop (this fires once per scan loop, earlier ones are provisional), and never
    // on ST's dry runs — those fire on every chat load and would spam the console.
    if (settings().debugLog && !runState.dryRunInProgress && !runState.generationIsDryRun && !args?.state?.next) {
        await reportLayout(false, maxTokens > 0);
    }
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/**
 * Runs retrieval and a full World Info scan without generating anything.
 *
 * Safe to spam: `setTimedEffects` and `setTimedEffect` both bail on dry runs
 * (WorldInfoTimedEffects.js), so sticky and cooldown state is untouched, and
 * WORLD_INFO_ACTIVATED isn't emitted (world-info.js:900) so other extensions
 * stay quiet. It does refresh the Author's Note extension prompt, which the
 * next real generation overwrites anyway.
 *
 * @returns {Promise<string>} Empty string — output goes to the console table
 */
async function dryRun(verbose = false) {
    const context = getContext();
    const chat = context.chat ?? [];

    if (!chat.length) {
        toastr.warning('No chat to scan.', 'Worlds Apart');
        return '';
    }

    console.log(`%cWorlds Apart: ${verbose ? 'debug run' : 'dry run'}`, 'font-weight: bold', paramSnapshot());

    runState.verboseRun = Boolean(verbose);
    runState.dryRunInProgress = true;

    // Cleared so a scan that activates nothing reports nothing, rather than last run's.
    runState.lastLayout = [];
    runState.lastDropped = [];
    runState.lastSkipped = [];

    await retrieve(chat);

    const chatForWI = chat
        .map(x => (world_info_include_names ? `${x.name}: ${x.mes}` : x.mes))
        .reverse();

    // Print in pipeline order: retrieval → activation ranking → final selection.
    try {
        if (verbose) {
            // Stage 1 — vector candidates: the full retrieved ranking and where the cutoff fell.
            // Re-runs retrieval (not a hot path), so it needs runState.lastQueryText from retrieve().
            await probeQuery({}, runState.lastQueryText);
        }

        // Stage 2 — the scan; rankActivated prints the selection candidates (verbose) as it runs.
        await getWorldInfoPrompt(chatForWI, getMaxPromptTokens(), true, { ...scanSources(), trigger: 'normal' });

        // Stage 3 — selection: what survived caps and layout.
        await reportLayout(verbose);
    } finally {
        runState.verboseRun = false;
        runState.dryRunInProgress = false;
    }

    return '';
}

/** Key in more than this fraction of active entries' content fires almost always — no
 * discrimination, recommend pruning. Flagging is per-key on the key's own text occurrence (df) and
 * does NOT consider whether the key is shared across entries — so a ubiquitous recurring name can be
 * flagged too-common; whitelist it (ban icon) if it's a deliberate continuity trigger. Dead keys
 * (never appearing in any entry's text) are also flagged. */


/**
 * Every setting that can change a result, grouped by pipeline stage, as a plain object.
 *
 * Logged as a JSON object so it collapses in the console and copies cleanly into bug
 * reports (right-click → Copy object). `nonDefaults` lists the scalar settings that differ
 * from the shipped defaults, replacing the old `*` markers — the interesting ones at a glance.
 *
 * @returns {object} Settings snapshot, keyed by pipeline stage
 */
function paramSnapshot() {
    const s = settings();
    // Scoped to the books attached to this chat — the same set the priority actually acts on.
    const attached = (scopedPriority() ?? []).map(x => x.cfg);
    const nonDefaults = Object.keys(defaultSettings)
        .filter(k => typeof s[k] !== 'object' && s[k] !== defaultSettings[k]);


    // Keys are the real setting names so grouped values, `nonDefaults`, and the UI bindings all
    // line up — makes a logged snapshot greppable straight back to the code. Derived rollups
    // (`maxTokens`, `attached`, `presentationOrder` label) have no single backing setting.
    const snap = {
        // commonWordWeight is an internal global derived from the mode (0.7 BM25-only, 1 otherwise), not a
        // setting; logged as the value in effect. It modifies the plugin's BM25 IDF on every query.
        scoring: { retrievalMode: s.retrievalMode, rrfK: s.rrfK, lexicalWeight: s.lexicalWeight, weightByOrder: s.weightByOrder, bm25K1: s.bm25K1, bm25B: s.bm25B, commonWordWeight: s.retrievalMode === 'lexical' ? 0.7 : 1 },
        // The entity filter only runs on raw-message queries — a summary is already
        // salience-selected — so in summary mode its params are inert and omitted.
        matchText: {
            queryMode: s.queryMode, messageDepth: s.messageDepth,
            ...(s.queryMode === 'summary' ? {} : { entityFilter: s.entityFilter, properNounBoost: s.properNounBoost, stopwordDocFreq: s.stopwordDocFreq }),
        },
        // Acquisition: what vectra gives back — the DB-side similarity gate, mean-centering, and
        // how the vectorized text is chunked. Paired with `cutoff` (WA-side selection) below.
        vectors: { scoreThreshold: s.scoreThreshold, meanCentered: s.meanCentered, chunkMode: s.chunkMode, chunkSize: s.chunkSize, minChunkSize: s.minChunkSize, suppressVectorKeys: s.suppressVectorKeys },
        // Selection: the WA-side cliff detector, floor/ceiling, and keyword scoring applied to
        // what was acquired. Mode leads, then the active mode's threshold and floor.
        cutoff: {
            vectorCutoff: s.vectorCutoff,
            ...(s.vectorCutoff === 'elbow' ? { elbowSensitivity: s.elbowSensitivity, minVectorEntries: s.minVectorEntries } : {}),
            ...(s.vectorCutoff === 'dropoff' ? { dropoffThreshold: s.dropoffThreshold, minVectorEntries: s.minVectorEntries } : {}),
            maxVectorEntries: s.maxVectorEntries, keywordScoring: s.keywordScoring, scoreVectorKeys: s.scoreVectorKeys,
        },
        budget: { maxTotalEntries: s.maxTotalEntries || null, maxDynamicEntries: s.maxDynamicEntries || null, maxTokens: tokenBudgetLabel(), maxTokensIncludesExempt: s.maxTokensIncludesExempt, budgetSlackMode: s.budgetSlackMode, budgetSlackPercent: s.budgetSlackPercent || 0 },
        layout: { insertionOrder: presentationBaseLabel(s.presentationOrder), tiered: !!s.presentationTiered },
        books: { worldPriorityMode: s.worldPriorityMode, attached },
    };

    if (s.queryMode === 'summary') {
        const profile = (extension_settings.connectionManager?.profiles ?? []).find(x => x.id === s.summaryProfile);
        snap.summary = { summaryProfile: profile ? profile.name : 'current API', endpoint: profile ? (profile['api-url'] || profile.api || '—') : '—', summaryTemperature: s.summaryTemperature || 'preset', summaryLength: s.summaryLength, summaryBypassPreset: s.summaryBypassPreset };
    }

    snap.nonDefaults = nonDefaults;   // last — the flat exact-name diff list, after the grouped view
    return snap;
}

/**
 * Names the signal that won an entry its place, for the `why` column.
 * @param {object} item Ranked item
 * @param {string} block Which block it was classified into
 * @returns {string} Short explanation
 */
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

    // Resolve only when a percentage is in play — otherwise "2048 = 2048" is noise.
    return s.maxTokensPercent > 0 ? `${parts.join(' & ')} = ${effective}` : parts.join(' & ');
}

/**
 * Names the signal that won an entry its place, for the `why` column.
 * @param {object} item Ranked item
 * @param {string} block Which block it was classified into
 * @returns {string} Short explanation
 */
function whySelected(item, block) {
    if (block !== 'dynamic') {
        return 'always-on';
    }

    const parts = [
        item.vectorRank ? `vec#${item.vectorRank}` : null,
        item.textRank ? `text#${item.textRank}` : null,
        item.keywordRank ? `keys#${item.keywordRank}` : null,
    ].filter(Boolean);

    if (parts.length) {
        return parts.join(' · ');
    }

    // No WA signal at all, yet it is here — so core activated it, not WA. Distinguish the
    // ways that happen, because they need different fixes and look identical otherwise.

    // @@activate fires unconditionally, before keyword matching — so an entry with this
    // decorator was never keyword-activated, and scoring it 0 is correct, not a miss.
    if (Array.isArray(item.entry.decorators) && item.entry.decorators.includes('@@activate')) {
        return 'core (@@activate)';
    }

    // Has keys but WA scored 0. Core matched on evidence WA didn't reproduce. When Min
    // Activations is on, the likely cause is core backfilling below its Scan Depth to
    // hit the entry quota — a region WA never scans — so name that. Otherwise it is a
    // matcher difference (whole-word/regex/case), or a keysecondary/selective-logic hit
    // WA doesn't evaluate, or recursion if it's on.
    const hasKeys = Array.isArray(item.entry.key) && item.entry.key.length > 0;

    if (!hasKeys) {
        return 'core (external)';
    }

    return world_info_min_activations > 0
        ? 'core keyword (below scan depth — min-activations)'
        : 'core keyword (WA scored 0)';
}

/**
 * Turns a rejection into the change that would undo it.
 * @param {object[]} blockedBy Caps that rejected the entry
 * @returns {string} What to do about it
 */
function describeFix(blockedBy, tail = false) {
    return blockedBy.map((block) => {
        switch (block.cap) {
            case 'tokens':
                // In the tail the budget is spent, so per-entry advice is misleading —
                // shortening one entry when nothing more fits changes nothing.
                if (tail) {
                    return `budget spent, ${block.remaining} left`;
                }
                return block.slackSpent
                    ? `${block.shortfall} tokens over; slack already used this scan (set slack to "all"?)`
                    : `+${block.shortfall} tokens, or ${block.slackNeeded}% slack, or shorten the entry`;
            case 'total':
                return 'raise the total entry cap';
            case 'dynamic':
                return 'raise the dynamic entry cap';
            case 'book':
                return `raise "${block.world}" book cap (at ${block.limit})`;
            default:
                return block.cap;
        }
    }).join('; ');
}

/** Human names for `world_info_position`, which is a bare enum on the entry. */
const POSITION_NAMES = ['before char', 'after char', 'AN top', 'AN bottom', '@depth', 'EM top', 'EM bottom', 'outlet'];

/**
 * Prints what the last scan decided: which entries reach the prompt, in prompt order.
 *
 * Entries are grouped by `position` first, because core assembles each position into its
 * own block — `order` only sequences entries WITHIN a position. A single global ranking
 * across mixed positions does not produce one linear prompt.
 */
async function reportLayout(verbose = false, countTokens = true) {
    if (!runState.lastLayout.length) {
        console.log('Worlds Apart: nothing activated.');
        return;
    }

    const rows = [];
    let total = 0;

    for (const { item, block } of runState.lastLayout) {
        const entry = item.entry;
        // Skipped on live generations unless a token cap already made us count: this
        // runs before every turn when debugLog is on, and a remote tokenizer would turn
        // a debug table into one HTTP round trip per entry of added latency.
        const tokens = countTokens ? await getTokenCountAsync(entry.content ?? '') : null;
        total += tokens ?? 0;

        // Column order IS insertion order in console.table. Lead with what identifies a
        // selection — title, composite score, uid, order — so the table is readable
        // without dragging columns; push layout metadata and per-signal scores to the
        // right. `_pos` is a numeric sort key only, stripped before printing.
        // Numeric fields stay numeric (rounded for readability, `null` for "no signal") so the
        // logged JSON is computable — matching the candidates table. `score` is always the fused
        // number now; what used to overload it with the block name lives in the `block` column.
        rows.push({
            title: entry.comment || `uid ${entry.uid}`,
            score: item.fused ? Number(item.fused.toFixed(5)) : null,
            uid: entry.uid,
            // wiOrder is the entry's own WI `order` field (what "WI Order" layout sorts
            // by); waOrder is the value WA writes to control the final prompt sequence.
            wiOrder: entry.waOriginalOrder,
            waOrder: entry.order,
            ...(verbose ? {
                cosine: item.score !== undefined ? Number(item.score.toFixed(5)) : null,
                text: item.textScore ? Number(item.textScore.toFixed(2)) : null,
                keys: item.keywordScore ? Number(item.keywordScore.toFixed(2)) : null,
                // Which keys actually matched, strongest first: "Kyle×3 · pool". Textual by nature.
                hits: item.keywordHits?.length
                    ? item.keywordHits.map(h => (h.count > 1 ? `${h.key}×${h.count}` : h.key)).join(' · ')
                    : null,
            } : {}),
            block,
            why: whySelected(item, block),
            position: POSITION_NAMES[entry.position] ?? `position ${entry.position}`,
            depth: entry.position === 4 ? (entry.depth ?? 4) : null,
            exempt: Boolean(entry.ignoreBudget),
            tokens: tokens ?? null,
            _pos: Number(entry.position) || 0,
        });
    }

    // Position first (each is a separate block in the assembled prompt), then `order`
    // within it — the same two-level sequence core produces.
    rows.sort((a, b) => a._pos - b._pos || a.waOrder - b.waOrder);
    rows.forEach(row => delete row._pos);

    console.log(`%cWorlds Apart · selected — what reaches the prompt, in prompt order (grouped by position, then order): ${rows.length} entries${countTokens ? `, ${total} World Info tokens` : ''}`, 'font-weight: bold');
    console.table(rows);

    if (runState.lastSkipped.length) {
        // Near-misses first: these are the ones where an edit or a nudge to a cap would
        // actually change the outcome. The tail is reported as a block below.
        const nearMiss = runState.lastSkipped.filter(x => !x.tail);
        const tail = runState.lastSkipped.filter(x => x.tail);

        if (nearMiss.length) {
            console.log(`%cWorlds Apart · skipped (fixable) — budget was still available, so an edit or a bigger cap changes the outcome: ${nearMiss.length} entries`, 'font-weight: bold');
            console.table(nearMiss.map(({ item, tokens, blockedBy }) => ({
                blockedBy: blockedBy.map(x => x.cap).join(' + '),
                tokens,
                // What would admit it, so the log points at the fix rather than the symptom.
                fix: describeFix(blockedBy),
                fused: item.fused ? Number(item.fused.toFixed(5)) : null,
                entry: item.entry.comment || `uid ${item.entry.uid}`,
                uid: item.entry.uid,
            })));
        }

        if (tail.length) {
            const smallest = Math.min(...tail.map(x => x.tokens));
            const sum = tail.reduce((total, x) => total + x.tokens, 0);
            const caps = [...new Set(tail.flatMap(x => x.blockedBy.map(y => y.cap)))].join(' + ');

            // Everything after the last admission sees the same leftover room, so any
            // token-blocked tail entry carries it. Fitting the whole tail costs its total
            // MINUS that leftover — quoting the raw sum would overstate it.
            const remaining = tail.find(x => x.blockedBy.some(y => y.cap === 'tokens'))
                ?.blockedBy.find(y => y.cap === 'tokens')?.remaining;
            const toFitAll = remaining === undefined ? null : Math.max(0, sum - remaining);

            console.log(`%cWorlds Apart · cut (exhausted) — ${caps} used up, nothing here fits: ${tail.length} entries, smallest is ${smallest} tokens, ${sum.toLocaleString()} in total${toFitAll === null ? '' : ` (raise the budget by ${toFitAll.toLocaleString()} to fit them all)`}`, 'font-weight: bold');
            console.table(tail.map(({ item, tokens }) => ({
                tokens,
                fused: item.fused ? Number(item.fused.toFixed(5)) : null,
                entry: item.entry.comment || `uid ${item.entry.uid}`,
                uid: item.entry.uid,
            })));
        }
    }
}

/**
 * Scores entries against arbitrary text and prints the result. Activates nothing.
 * Lets you compare query formulations — raw messages vs. a hand-written summary —
 * against the same corpus.
 * @param {object} _named Named arguments (unused)
 * @param {string} text Query text
 * @returns {Promise<string>} Empty string — output goes to the console table
 */
async function probeQuery(_named, text) {
    const searchText = String(text ?? '').trim();

    if (!searchText) {
        toastr.warning('Provide query text: /wa-query your text here', 'Worlds Apart');
        return '';
    }

    const { targets, scores } = await scoreEntries(searchText);
    const byKey = new Map(targets.map(x => [`${x.world}.${x.uid}`, x]));

    if (!scores.size) {
        console.log(`Worlds Apart: nothing cleared the ${settings().scoreThreshold} threshold for "${searchText.slice(0, 60)}…"`);
        return '';
    }

    const ranked = fuseRetrieval(scores);
    const cut = cutRetrieved(ranked).length;
    const spread = ranked[0].value.score - ranked[Math.min(4, ranked.length - 1)].value.score;

    console.log(`Worlds Apart: query "${searchText.slice(0, 80)}${searchText.length > 80 ? '…' : ''}" (${searchText.length} chars)`);
    console.log(`Worlds Apart: ${ranked.length} entries retrieved, ${settings().retrievalMode} ranking, ${settings().vectorCutoff} cutoff kept ${cut}, top-5 vector spread ${spread.toFixed(5)}`);
    console.log(`%cWorlds Apart · vector candidates — the full ranked list of retrieved vectors, with the gap the cutoff reads (kept = above the cutoff)`, 'font-weight: bold');
    // Lead with the cutoff story — the gap the elbow reads, whether the row was kept,
    // and which entry — so the boundary is legible without dragging columns. Per-signal
    // scores and the matched chunk follow.
    console.table(ranked.slice(0, Math.max(cut, settings().maxVectorEntries) * 2).map((row, index) => ({
        // The gap this row opens below the one above — what the elbow cuts on.
        gap: index > 0 ? Number((ranked[index - 1].fused - row.fused).toFixed(6)) : null,
        kept: index < cut,
        title: byKey.get(row.key)?.comment,
        '#': index + 1,
        vec: Number(row.value.score.toFixed(5)),
        vRank: row.vectorRank ?? null,
        bm25: row.value.bm25 ? Number(row.value.bm25.toFixed(2)) : null,
        kRank: row.textRank ?? null,
        matchedChunk: row.value.chunk.slice(0, 70).replace(/\s+/g, ' '),
    })));

    return '';
}

/**
 * Resolves the token budget from the percentage and absolute settings.
 * Both are optional and both apply; the tighter one wins. 0 means no token budget.
 * @returns {number} Effective budget in tokens
 */
function effectiveTokenBudget() {
    const percent = Number(settings().maxTokensPercent) || 0;
    const absolute = Number(settings().maxTokens) || 0;
    const fromPercent = percent > 0 ? Math.round(getMaxPromptTokens() * percent / 100) : 0;
    const limits = [fromPercent, absolute].filter(x => x > 0);

    return limits.length ? Math.min(...limits) : 0;
}

/**
 * Applies the entry and token caps.
 *
 * The populations are nested — vector ⊆ dynamic ⊆ all — so these are three constraints
 * on one walk rather than three competing policies, and none of them changes what
 * another means. Any cap at 0 is off.
 *
 *   maxDynamic  caps keyword and vector entries; constants and stickies are unaffected
 *   maxTotal    caps everything, so constants consume it before the dynamic entries
 *   maxTokens   caps context usage, which is only meaningful over everything
 *
 * `ranked` must walk stickies and constants first, which makes every cap a prefix cut:
 * once the dynamic count is used up there is nothing but dynamic entries left to reject.
 * Leaving maxTotal at 0 is what guarantees an always-on entry is never dropped.
 *
 * Entries marked ignoreBudget are outside the budgeted population entirely — neither
 * capped nor counted — so the entry caps read as "this many on top of the mandatory
 * ones". They do still spend tokens; see the note at the accounting.
 *
 * @param {object} args Budget arguments
 * @returns {Promise<{survivors: Set, counted: number, dropped: number, budgeted: number, inPrompt: number}>}
 */
async function applyBudget({ ranked, isDynamic, maxTokens, maxTotal, maxDynamic, tokensOf, capOf = () => 0, exemptIsBudgeted = true, slack = 0, slackOnce = true }) {
    const survivors = new Set();
    let counted = 0;
    let dynamic = 0;
    // Per-book quota: a ceiling on how many dynamic entries each book may contribute, so a
    // relevance flood in one book can't crowd the others out. Counts dynamic only — a book's
    // constants are always-on and not subject to it, same as maxDynamic.
    const perWorld = new Map();
    // budgeted: tokens the caps enforce against. inPrompt: tokens actually reaching the
    // prompt. They diverge when exempt entries are not budgeted, and conflating them is
    // how a cap ends up reporting a ceiling the prompt has already gone through.
    //
    // Deliberately no spend/charge/cost vocabulary here: the only thing that literally
    // costs anything is the API call, and these numbers are not that. They count World
    // Info tokens only — no chat, system prompt, persona or examples.
    let budgeted = 0;
    let inPrompt = 0;
    let slackSpent = false;
    let lastAdmitted = -1;
    let index = -1;
    const skipped = [];

    const ceiling = maxTokens > 0 ? maxTokens * (1 + slack) : 0;

    for (const item of ranked) {
        index += 1;
        const itemTokens = await tokensOf(item);
        const exempt = Boolean(item.entry.ignoreBudget);

        // An entry over the budget but within the slack is admitted anyway, so the
        // entry genuinely next in line keeps the last slot instead of yielding it to
        // whatever happens to be small enough to squeeze in.
        const pastBudget = maxTokens > 0 && budgeted + itemTokens > maxTokens;
        const rescuable = pastBudget
            && slack > 0
            && budgeted + itemTokens <= ceiling
            && !(slackOnce && slackSpent);

        // Every cap that would reject this entry, not just the first — an entry blocked
        // by two caps needs both raised, and reporting one sends the user round twice.
        const blockedBy = [];

        if (pastBudget && !rescuable) {
            blockedBy.push({
                cap: 'tokens',
                // What it would take to admit this entry: the extra budget, or the slack
                // percentage that would have covered the overhang.
                shortfall: budgeted + itemTokens - maxTokens,
                slackNeeded: Math.ceil(((budgeted + itemTokens) / maxTokens - 1) * 100),
                slackSpent: slackSpent && slack > 0,
                remaining: Math.max(0, maxTokens - budgeted),
            });
        }
        if (maxTotal > 0 && counted >= maxTotal) {
            blockedBy.push({ cap: 'total', shortfall: 1 });
        }
        if (maxDynamic > 0 && isDynamic(item) && dynamic >= maxDynamic) {
            blockedBy.push({ cap: 'dynamic', shortfall: 1 });
        }
        const bookCap = capOf(item);
        if (bookCap > 0 && isDynamic(item) && (perWorld.get(item.entry?.world) ?? 0) >= bookCap) {
            blockedBy.push({ cap: 'book', shortfall: 1, world: item.entry?.world, limit: bookCap });
        }

        // Skip rather than stop. An entry too big for the remaining tokens shouldn't
        // bar the smaller ones behind it, and stopping early would mean an entry marked
        // ignoreBudget never gets reached — which is the one thing that flag promises.
        if (blockedBy.length && !exempt) {
            skipped.push({ item, tokens: itemTokens, blockedBy, index });
            continue;
        }

        // An entry that can't be cut isn't part of the population being budgeted, so it
        // stays out of the denominator too. Counting it would mean 10 ignoreBudget
        // entries against a cap of 10 silently returns zero retrieval results — a total
        // failure whose cause is a flag on ten unrelated entries. Not counting it means
        // you asked for 10 and got 20, which is visible and proportional.
        //
        // Tokens are the exception by default: they are a real resource with a real
        // consequence, so a mandatory entry's tokens still come off the top and squeeze
        // what fits below. Turning that off makes exemption total.
        if (rescuable) {
            slackSpent = true;
        }

        if (!exempt || exemptIsBudgeted) {
            budgeted += itemTokens;
        }

        inPrompt += itemTokens;

        if (!exempt) {
            counted += 1;
            if (isDynamic(item)) {
                dynamic += 1;
                perWorld.set(item.entry?.world, (perWorld.get(item.entry?.world) ?? 0) + 1);
            }
        }

        survivors.add(item);
        lastAdmitted = index;
    }

    // Two different situations wear the same rejection. If something was admitted after
    // an entry was rejected, the budget still had usable room and that entry simply did
    // not fit — shortening it would work. If nothing after it got in, it is the tail of
    // an exhausted budget, where per-entry advice is noise and only the cap matters.
    for (const skip of skipped) {
        skip.tail = skip.index > lastAdmitted;
    }

    return { survivors, counted, skipped, dropped: ranked.length - survivors.size, budgeted, inPrompt };
}

// Entry selection (count/elbow/dropoff cutoff) lives in selection.mjs; inject the cutoff settings.
// Rationale/benchmarks are documented there.
const cutRetrieved = (ranked) => selection.cutRetrieved(ranked, {
    mode: settings().vectorCutoff,
    maxVectorEntries: settings().maxVectorEntries,
    minVectorEntries: settings().minVectorEntries,
    elbowSensitivity: settings().elbowSensitivity,
    dropoffThreshold: settings().dropoffThreshold,
});

/**
 * Summarizes the current chat and scores the result, so the summary prompt can be
 * tuned against retrieval quality directly. Activates nothing.
 * @returns {Promise<string>} Empty string — output goes to the console
 */
async function probeSummary() {
    const chat = getContext().chat ?? [];
    const rawText = buildQuery(chat);

    if (!rawText) {
        toastr.warning('No chat to summarize.', 'Worlds Apart');
        return '';
    }

    const summary = await summarizeQuery(rawText);

    console.log(`Worlds Apart: summary (${summary.length} chars):\n%c${summary}`, 'color: #6cf');

    if (summary === rawText) {
        console.warn('Worlds Apart: summarization returned the raw text — it failed, see the error above');
        return '';
    }

    await probeQuery(null, summary);
    return '';
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

const SETTINGS_HTML = `
<style>
/* Nested WA sub-sections read as subordinate to the top "Worlds Apart" header: indented, lighter,
   smaller, with a left rule — so they don't look like their own top-level drawers. */
.worlds-apart-settings .wa-section { margin-left: 10px; border-left: 2px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); padding-left: 8px; }
.worlds-apart-settings .wa-section > .inline-drawer-toggle { font-size: 0.95em; opacity: 0.8; }
.worlds-apart-settings .wa-section > .inline-drawer-toggle b { font-weight: 500; }
</style>
<div class="worlds-apart-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Worlds Apart</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="wa_enabled">
                <input id="wa_enabled" type="checkbox"><span>Enabled</span>
            </label>
            <label>Prompt insertion order</label>
            <small class="opacity50p">How WA lays out the entries it selected, in every prompt. Pick a base sort and, optionally, tiered grouping. (The Studio's sort views reuse this control but are per-session; this one is saved.)</small>
            <div id="wa_presentation_order_mount" style="margin-top:4px;"></div>
            <label style="margin-top:8px;">Tier precedence</label>
            <small class="opacity50p">When tiered grouping is on (here or in the Studio), entries group into the first tier they match, top to bottom. ↑/↓ sets precedence; untick to skip a tier. Shared with the Studio.</small>
            <div id="wa_tier_editor_mount" style="margin-top:4px;"></div>

            <label for="wa_retrieval_mode">Retrieval (which signals the sections below feed)</label>
            <select id="wa_retrieval_mode" class="text_pole">
                <option value="hybrid">Hybrid (BM25 + vector, RRF)</option>
                <option value="lexical">BM25 only</option>
                <option value="vector">Vector only</option>
            </select>

            <label for="wa_query_mode">Query from</label>
            <select id="wa_query_mode" class="text_pole">
                <option value="messages">Raw messages</option>
                <option value="summary">Summarized scene (one LLM call per new turn)</option>
            </select>

            <label for="wa_message_depth">Message depth (recent messages for retrieval + keyword scan)</label>
            <input id="wa_message_depth" type="number" class="text_pole" min="1" max="20" step="1">

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Lorebook priority</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">With several books active, how their entries compete for budget slots and where they sit in the prompt. Books appear here once WA has seen them in a scan.</small>

                    <label for="wa_world_priority_mode">Mode</label>
                    <select id="wa_world_priority_mode" class="text_pole">
                        <option value="interleaved">Interleaved — one relevance-ranked list, optional per-book weight</option>
                        <option value="sequential">Sequential — fill higher books first</option>
                    </select>

                    <div id="wa_world_priority_list" style="margin-top:6px;"></div>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Summary</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">Only applies when Query from = Summarized scene: how the scene summary that becomes the match text is generated.</small>

                    <label for="wa_summary_profile">Summarize with</label>
                    <div class="flex-container alignItemsCenter flexnowrap">
                        <select id="wa_summary_profile" class="text_pole flex1"></select>
                        <div id="wa_refresh_profiles" class="menu_button fa-solid fa-rotate" title="Reload the Connection Manager profile list"></div>
                    </div>

                    <label class="checkbox_label" for="wa_bypass_preset">
                        <input id="wa_bypass_preset" type="checkbox"><span>Bypass the profile's preset</span>
                    </label>

                    <label for="wa_summary_prompt">Summary prompt</label>
                    <textarea id="wa_summary_prompt" class="text_pole textarea_compact" rows="4"></textarea>

                    <label for="wa_summary_temp">Summary temperature (blank = preset default; needs a profile)</label>
                    <input id="wa_summary_temp" type="number" class="text_pole" min="0" max="2" step="0.05" placeholder="preset default">

                    <label for="wa_summary_length">Summary length (tokens)</label>
                    <input id="wa_summary_length" type="number" class="text_pole" min="50" max="2000" step="50">
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Vector Match</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">Embedding similarity between the match text and your entries. Inactive when Retrieval = BM25 only.</small>
                    <div id="wa_embed_info" class="opacity50p" style="margin:0.4em 0;font-size:0.85em;" title="The embedding model and endpoint are configured in the Vector Storage extension settings — change them there."></div>

                    <label class="checkbox_label" for="wa_mean_centered">
                        <input id="wa_mean_centered" type="checkbox"><span>Mean-centered search (needs server plugin)</span>
                    </label>
                    <div id="wa_plugin_setup" style="margin:0.4em 0;font-size:0.85em;opacity:0.75;"></div>

                    <label for="wa_threshold">Score threshold</label>
                    <input id="wa_threshold" type="number" class="text_pole" min="0" max="1" step="0.01">
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>BM25 Match</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">Word-overlap (lexical) matching. Inactive when Retrieval = Vector only.</small>

                    <label class="checkbox_label" for="wa_entity_filter">
                        <input id="wa_entity_filter" type="checkbox"><span>Entity filter — raw messages only (leave on unless testing)</span>
                    </label>

                    <label for="wa_proper_noun_boost">Proper-noun boost</label>
                    <input id="wa_proper_noun_boost" type="number" class="text_pole" min="1" max="10" step="0.5">

                    <label for="wa_stopword_df">Stoplist: drop terms above this doc frequency (0 = off)</label>
                    <input id="wa_stopword_df" type="number" class="text_pole" min="0" max="1" step="0.05">

                    <label for="wa_bm25_k1">BM25 k1 (repetition vs. breadth)</label>
                    <input id="wa_bm25_k1" type="number" class="text_pole" min="0.1" max="10" step="0.1">

                    <label for="wa_bm25_b">BM25 b (length normalisation, 0-1)</label>
                    <input id="wa_bm25_b" type="number" class="text_pole" min="0" max="1" step="0.05">

                    <label for="wa_lexical_weight">Lexical weight (BM25 vs vector in fusion)</label>
                    <input id="wa_lexical_weight" type="number" class="text_pole" min="0" max="5" step="0.1">
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Ranking</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">How the two signals fuse.</small>

                    <label for="wa_rrf_k">RRF k (fusion; lower favors the top ranks)</label>
                    <input id="wa_rrf_k" type="number" class="text_pole" min="1" max="1000" step="1">

                    <label class="checkbox_label" for="wa_weight_by_order">
                        <input id="wa_weight_by_order" type="checkbox"><span>Weight by entry order (order = priority)</span>
                    </label>
                    <small class="opacity50p">Folds each entry's Order into the fused score as another rank, so higher-order entries rank higher — for books that use Order as priority. Order stays a tiebreak either way.</small>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Selection &amp; budget</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_max_entries">Max retrieved entries</label>
                    <input id="wa_max_entries" type="number" class="text_pole" min="1" max="100" step="1">

                    <label for="wa_vector_cutoff">Cutoff</label>
                    <select id="wa_vector_cutoff" class="text_pole">
                        <option value="count">Fixed count (always the max)</option>
                        <option value="elbow">Elbow (cut at a gap vs the mean gap)</option>
                        <option value="dropoff">Dropoff (cut at a fixed score drop)</option>
                    </select>

                    <label for="wa_min_entries">Cliff modes: never keep fewer than</label>
                    <input id="wa_min_entries" type="number" class="text_pole" min="1" max="100" step="1">

                    <label for="wa_elbow_sensitivity">Elbow sensitivity (× mean gap; higher keeps fewer)</label>
                    <input id="wa_elbow_sensitivity" type="number" class="text_pole" min="1" max="10" step="0.1">

                    <label for="wa_dropoff_threshold">Dropoff threshold (fraction of top score; higher keeps fewer)</label>
                    <input id="wa_dropoff_threshold" type="number" class="text_pole" min="0.01" max="1" step="0.01">

                    <label for="wa_max_dynamic">Dynamic entry cap — keyword + vector (0 = no limit)</label>
                    <input id="wa_max_dynamic" type="number" class="text_pole" min="0" max="500" step="1">

                    <label for="wa_max_total">Total entry cap — includes constants (0 = no limit)</label>
                    <input id="wa_max_total" type="number" class="text_pole" min="0" max="500" step="1">

                    <label for="wa_max_tokens_pct">Token budget, % of context (0 = off)</label>
                    <input id="wa_max_tokens_pct" type="number" class="text_pole" min="0" max="100" step="1">

                    <label for="wa_max_tokens">Token budget, absolute (0 = off; tighter of the two wins)</label>
                    <input id="wa_max_tokens" type="number" class="text_pole" min="0" max="100000" step="64">

                    <label for="wa_budget_slack">Budget slack, % over (0 = exact)</label>
                    <input id="wa_budget_slack" type="number" class="text_pole" min="0" max="50" step="1">

                    <label for="wa_slack_mode">Slack applies</label>
                    <select id="wa_slack_mode" class="text_pole">
                        <option value="once">Once — rescues one entry, then the budget is exact</option>
                        <option value="all">All — every entry may use the slack</option>
                    </select>

                    <label class="checkbox_label" for="wa_tokens_include_exempt">
                        <input id="wa_tokens_include_exempt" type="checkbox"><span>Token budget caps "ignore budget" entries</span>
                    </label>

                    <small id="wa_exempt_count" class="opacity50p"></small>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Advanced</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">Set once and forget. Defaults are measured; change only when testing.</small>

                    <label class="checkbox_label" for="wa_suppress_keys">
                        <input id="wa_suppress_keys" type="checkbox"><span>Suppress keywords on 🔗 entries</span>
                    </label>

                    <label class="checkbox_label" for="wa_keyword_scoring">
                        <input id="wa_keyword_scoring" type="checkbox"><span>Score keyword entries (BM25 over keys)</span>
                    </label>

                    <label class="checkbox_label" for="wa_score_vector_keys">
                        <input id="wa_score_vector_keys" type="checkbox"><span>Also score 🔗 entries' keys (double boost; A/B test)</span>
                    </label>

                    <label for="wa_chunk_mode">Chunking</label>
                    <select id="wa_chunk_mode" class="text_pole">
                        <option value="paragraph">Paragraph boundaries</option>
                        <option value="length">Fixed length (ST default)</option>
                    </select>

                    <label for="wa_chunk_size">Max chunk size (chars, matching only)</label>
                    <input id="wa_chunk_size" type="number" class="text_pole" min="50" max="5000" step="50">

                    <label for="wa_min_chunk_size">Min chunk size (chars)</label>
                    <input id="wa_min_chunk_size" type="number" class="text_pole" min="0" max="2000" step="10">

                    <label class="checkbox_label" for="wa_debug_log">
                        <input id="wa_debug_log" type="checkbox"><span>Log selection table on every generation</span>
                    </label>
                </div>
            </div>
        </div>
    </div>
</div>`;

/**
 * Rebuilds the profile dropdown from Connection Manager's current list.
 * Called on init and from the refresh button, since profiles can be added or
 * renamed while ST is running.
 * @param {boolean} notify Show a toast with the result
 */
function populateProfiles(notify = false) {
    const profiles = extension_settings.connectionManager?.profiles ?? [];
    const selected = settings().summaryProfile;

    $('#wa_summary_profile')
        .empty()
        .append([`<option value="">Current API</option>`]
            .concat(profiles.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`))
            .join(''));

    // A deleted profile leaves a dangling id: show the fallback rather than a blank
    // select, but don't silently rewrite the setting.
    const stillExists = !selected || profiles.some(x => x.id === selected);
    $('#wa_summary_profile').val(stillExists ? selected : '');

    if (!stillExists) {
        console.warn(`Worlds Apart: saved summary profile "${selected}" no longer exists, falling back to the current API`);
        toastr.warning('Saved summarization profile no longer exists.', 'Worlds Apart');
    }

    if (notify) {
        toastr.info(`${profiles.length} profile(s) loaded.`, 'Worlds Apart');
    }
}

/**
 * Wires a settings control to its backing value.
 * @param {string} selector Element selector
 * @param {string} key Settings key
 * @param {'checked'|'number'|'string'} kind Value type
 */
function bind(selector, key, kind) {
    const $el = $(selector);

    if (kind === 'checked') {
        $el.prop('checked', settings()[key]);
    } else {
        $el.val(settings()[key]);
    }

    $el.on('input change', () => {
        settings()[key] = kind === 'checked' ? $el.prop('checked')
            : kind === 'number' ? Number($el.val())
                : String($el.val());
        saveSettingsDebounced();
    });
}


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
 * entries on the right. Phase 2 adds per-entry tools (mode, flag toggles, sticky, ⚡/🪄 suggestions,
 * duplicate, delete) and prune-coloured click-to-edit keywords. Bulk actions land later.
 */
async function lorebookStudio() {
    if (!(world_names ?? []).length) { toastr.warning('No lorebooks found.', 'Worlds Apart'); return ''; }
    ensureStudioStyle();

    let sortAsc = true;
    // Prefer the current chat's bound lorebook, then any world attached to the active character.
    let selected = (world_names.includes(chatBook()) ? chatBook() : null)
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

// ---------------------------------------------------------------------------
// Active-entries panel — a book icon (bottom-left) that expands into the list
// WA actually selected, each row tooltipped with its per-signal scores and
// keyword hits, click opening the entry text. Refreshed from runState.lastLayout at the
// end of every real scan (see rankActivated).
// ---------------------------------------------------------------------------
let wiTrigger = null, wiPanel = null;
function ensureWiPanel() {
    if (wiTrigger) return;
    const style = document.createElement('style');
    style.textContent = `
.wa-wi-trigger { position: fixed; left: 10px; bottom: 10px; z-index: 100000; width: 28px; height: 28px;
    line-height: 28px; text-align: center; cursor: pointer; opacity: 0.6; border-radius: 6px;
    background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.4)); }
.wa-wi-trigger:hover { opacity: 1; }
.wa-wi-trigger[data-count]:not([data-count="0"])::after { content: attr(data-count); position: absolute;
    top: -6px; right: -6px; min-width: 14px; height: 14px; line-height: 14px; padding: 0 3px; font-size: 9px;
    text-align: center; color: #fff; background: var(--crimson70a, #b33); border-radius: 8px; }
.wa-wi-panel { position: fixed; left: 10px; bottom: 46px; z-index: 100000; display: none; flex-direction: column;
    gap: 2px; width: 320px; max-width: calc(100vw - 20px); max-height: 60vh; overflow-y: auto; padding: 6px;
    border-radius: 8px; font-size: 0.85em; background: var(--SmartThemeBlurTintColor, rgba(20,20,20,0.92));
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-wi-panel.wa-wi-open { display: flex; }
.wa-wi-entry { display: flex; align-items: baseline; gap: 6px; padding: 3px 5px; border-radius: 5px; cursor: pointer; }
.wa-wi-entry:hover { background: var(--white20a, rgba(255,255,255,0.1)); }
.wa-wi-glyph { flex: 0 0 auto; }
.wa-wi-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-wi-empty { opacity: 0.6; padding: 4px; }`;
    document.head.append(style);

    wiTrigger = document.createElement('div');
    wiTrigger.className = 'wa-wi-trigger fa-solid fa-fw fa-book-atlas';
    wiTrigger.title = 'Worlds Apart — active entries';
    wiTrigger.dataset.count = '0';
    wiPanel = document.createElement('div');
    wiPanel.className = 'wa-wi-panel';
    wiTrigger.addEventListener('click', () => wiPanel.classList.toggle('wa-wi-open'));
    document.body.append(wiTrigger, wiPanel);
}

function renderWiPanel(layout) {
    ensureWiPanel();
    wiTrigger.dataset.count = String(layout.length);
    wiPanel.innerHTML = '';
    if (!layout.length) {
        const empty = document.createElement('div');
        empty.className = 'wa-wi-empty';
        empty.textContent = 'No active entries';
        wiPanel.append(empty);
        return;
    }
    for (const row of layout) {
        const e = row.item.entry;
        const el = document.createElement('div');
        el.className = 'wa-wi-entry';
        el.title = wiTooltip(row);
        const g = document.createElement('span');
        g.className = 'wa-wi-glyph';
        g.textContent = wiGlyph(e);
        const t = document.createElement('span');
        t.className = 'wa-wi-title';
        t.textContent = wiTitleOf(e);
        el.append(g, t);
        el.addEventListener('click', () => showEntryText(e));
        wiPanel.append(el);
    }
}

let initialized = false;

export async function init() {
    // Both `hooks.activate` and the jQuery bootstrap below can reach here, and
    // whichever loses the race would otherwise duplicate the panel, the event
    // listeners and the slash command.
    if (initialized) {
        return;
    }
    initialized = true;

    ensureSettings();
    // 'off' folded into 'interleaved' (identical at weight 1/offset 0); drop the stale value.
    if (settings().worldPriorityMode === 'off') settings().worldPriorityMode = 'interleaved';
    // Legacy presentationOrder ('authored'/'authored-inverse') → shared sort keys; studioTierCfg → shared tierCfg.
    if (settings().presentationOrder in PRESENTATION_ALIAS) settings().presentationOrder = PRESENTATION_ALIAS[settings().presentationOrder];
    if (settings().studioTierCfg && !settings().tierCfg) { settings().tierCfg = settings().studioTierCfg; delete settings().studioTierCfg; }
    delete settings().baselineQuery; delete settings().baselineWeight;   // removed feature — drop orphaned stored values

    $('#extensions_settings').append(SETTINGS_HTML);

    updateEmbedInfo();   // refresh on drawer open so it tracks Vector Storage changes made mid-session
    $('#wa_embed_info').closest('.inline-drawer').children('.inline-drawer-toggle').on('click', updateEmbedInfo);

    // Wand-menu entry for the keyword prune tool (same as /wa-keyword-scores).
    $('#extensionsMenu').append('<div id="wa_keyword_prune" class="list-group-item flex-container flexGap5" title="Worlds Apart — audit &amp; prune lorebook keywords"><div class="fa-solid fa-eraser extensionsMenuExtensionButton"></div><span>WA Keyword Prune</span></div>');
    $('#wa_keyword_prune').on('click', () => { keywordScoresReport(); });

    $('#extensionsMenu').append('<div id="wa_keyword_suggest" class="list-group-item flex-container flexGap5" title="Worlds Apart — TF-IDF keyword suggestions for an entry"><div class="fa-solid fa-bars-staggered extensionsMenuExtensionButton"></div><span>WA Suggest Keys</span></div>');
    $('#wa_keyword_suggest').on('click', () => { keywordSuggestReport(); });

    $('#extensionsMenu').append('<div id="wa_studio" class="list-group-item flex-container flexGap5" title="Worlds Apart — Lorebook Studio: manage all lorebooks and entries"><div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>WA Lorebook Studio</span></div>');
    $('#wa_studio').on('click', () => { lorebookStudio(); });

    bind('#wa_enabled', 'enabled', 'checked');
    bind('#wa_suppress_keys', 'suppressVectorKeys', 'checked');
    // Prompt insertion order — the same sort widget the Studio uses, plus relevance options (prompt-only).
    // The widget's button (.wa-filter) and its popup (.wa-ctx) are styled by ensureStudioStyle, which the
    // Studio injects lazily; the settings control can be used first, so inject here too (idempotent).
    ensureStudioStyle();
    const getTierCfg = () => reconcileTiers(settings().tierCfg);
    const setTierCfg = cfg => { settings().tierCfg = cfg; saveSettingsDebounced(); };
    const presentationMount = document.querySelector('#wa_presentation_order_mount');
    const tierMount = document.querySelector('#wa_tier_editor_mount');
    let tierEditor = null;
    if (presentationMount) presentationMount.append(makeSortControl({
        getSort: () => normPresentation(settings().presentationOrder),
        setSort: k => { settings().presentationOrder = k; saveSettingsDebounced(); },
        getTiered: () => !!settings().presentationTiered,
        setTiered: on => { settings().presentationTiered = on; saveSettingsDebounced(); },
        getTierCfg, setTierCfg,
        extraItems: [{ label: 'Most relevant first', key: 'best-first' }, { label: 'Most relevant last', key: 'best-last' }],
        // Keep the inline tier editor in sync if tiers are reordered from the button's Configure tiers… menu.
        onChange: () => { if (tierEditor) tierEditor.replaceWith(tierEditor = makeTierEditor(getTierCfg, setTierCfg, () => {})); },
        block: true,
    }));
    if (tierMount) tierMount.append(tierEditor = makeTierEditor(getTierCfg, setTierCfg, () => {}));
    bind('#wa_retrieval_mode', 'retrievalMode', 'string');   // commonWordWeight now derives from this at query time (internal global)
    bind('#wa_mean_centered', 'meanCentered', 'checked');
    renderPluginSetup();                     // paints "checking…" then the detected/install state
    // Detect the plugin and fingerprint the source in parallel; re-render once both settle so the box
    // can show up-to-date / out-of-date. Both are cached, so this runs its fetches at most once.
    Promise.all([hasPlugin(), computeSourceFingerprint()]).then(renderPluginSetup);
    bind('#wa_keyword_scoring', 'keywordScoring', 'checked');
    bind('#wa_score_vector_keys', 'scoreVectorKeys', 'checked');
    bind('#wa_debug_log', 'debugLog', 'checked');
    bind('#wa_message_depth', 'messageDepth', 'number');
    bind('#wa_bm25_k1', 'bm25K1', 'number');
    bind('#wa_bm25_b', 'bm25B', 'number');
    bind('#wa_lexical_weight', 'lexicalWeight', 'number');
    bind('#wa_rrf_k', 'rrfK', 'number');
    bind('#wa_weight_by_order', 'weightByOrder', 'checked');
    bind('#wa_summary_profile', 'summaryProfile', 'string');
    bind('#wa_bypass_preset', 'summaryBypassPreset', 'checked');
    bind('#wa_query_mode', 'queryMode', 'string');
    bind('#wa_summary_prompt', 'summaryPrompt', 'string');
    bind('#wa_summary_length', 'summaryLength', 'number');
    bind('#wa_summary_temp', 'summaryTemperature', 'string');
    bind('#wa_chunk_mode', 'chunkMode', 'string');
    bind('#wa_chunk_size', 'chunkSize', 'number');
    bind('#wa_min_chunk_size', 'minChunkSize', 'number');
    bind('#wa_threshold', 'scoreThreshold', 'number');
    bind('#wa_max_entries', 'maxVectorEntries', 'number');
    bind('#wa_vector_cutoff', 'vectorCutoff', 'string');
    bind('#wa_min_entries', 'minVectorEntries', 'number');
    bind('#wa_elbow_sensitivity', 'elbowSensitivity', 'number');
    bind('#wa_dropoff_threshold', 'dropoffThreshold', 'number');
    bind('#wa_entity_filter', 'entityFilter', 'checked');
    bind('#wa_proper_noun_boost', 'properNounBoost', 'number');
    bind('#wa_stopword_df', 'stopwordDocFreq', 'number');
    bind('#wa_max_tokens', 'maxTokens', 'number');
    bind('#wa_max_tokens_pct', 'maxTokensPercent', 'number');
    bind('#wa_budget_slack', 'budgetSlackPercent', 'number');
    bind('#wa_slack_mode', 'budgetSlackMode', 'string');
    bind('#wa_max_dynamic', 'maxDynamicEntries', 'number');
    bind('#wa_max_total', 'maxTotalEntries', 'number');
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
    // Swap with the adjacent VISIBLE row, not the array neighbour — a filtered-out book
    // from another chat sitting between them must not absorb the move.
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

    // ST fires a dry-run generation on chat load and for token estimates; note it so the
    // scan-done handler can stay quiet, since its interceptor (and our retrieval) is skipped.
    eventSource.on(event_types.GENERATION_STARTED, (_type, _options, dryRun) => { runState.generationIsDryRun = Boolean(dryRun); });
    eventSource.on(event_types.GENERATION_ENDED, () => { runState.generationIsDryRun = false; });

    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, suppressKeys);
    // WORLDINFO_ENTRIES_LOADED only fires during a scan, so switching chat/character wouldn't
    // refresh the attached-book set until the next generation. CHAT_CHANGED fires on every
    // switch; re-read the active books then. Also populates once now so it isn't blank on load.
    const refreshAttached = () => getSortedEntries().then(showExemptCount).catch(() => {});
    eventSource.on(event_types.CHAT_CHANGED, refreshAttached);
    // New chat = possibly different books; drop the smartkeys key registry so the automaton
    // tracks the active vocabulary instead of the union of every book ever scanned.
    eventSource.on(event_types.CHAT_CHANGED, resetSmartKeys);
    refreshAttached();
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, rankActivated);

    // Show the active-entries icon right away; it fills in on the next scan.
    if (settings().enabled) renderWiPanel(runState.lastLayout);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-dry',
        callback: () => dryRun(false),
        helpString: 'Worlds Apart: run retrieval and a World Info scan without generating. Reports the settings used and what got selected, in prompt order. Console.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-debug',
        callback: () => dryRun(true),
        helpString: 'Worlds Apart: same as /wa-dry plus every intermediate — query text, surviving term weights, per-signal scores, and the full vector-candidate ranking past the cut. Console.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-keyword-scores',
        callback: keywordScoresReport,
        helpString: 'Worlds Apart: audit one lorebook\'s keys and prune/rename/ignore weak ones. Pick a book and scan options, click Assess; the results list flags dead, too-common, and short (substring-collision) keys per that book\'s own text, honouring each entry\'s match flags. Also on the extensions (wand) menu.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-suggest-keys',
        callback: keywordSuggestReport,
        helpString: 'Worlds Apart: suggest World Info keywords across a whole book. Pick a book and click Assess; every entry with distinctive terms (1–maxN-grams ranked by TF-IDF, dates/function-words/verb-phrases filtered) shows a paragraph of checkbox suggestions with per-entry and global select-all. The ✨ on any entry adds local-model suggestions (incl. paraphrases) for that one entry. Add checked writes across every touched entry at once. Also on the extensions (wand) menu.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-studio',
        callback: lorebookStudio,
        helpString: 'Worlds Apart: open Lorebook Studio — a wide two-pane manager listing every lorebook on the left and the selected book\'s entries on the right. Per-entry tools (mode, flags, sticky, ⚡/✨ keyword suggestions, prune-scan colouring, duplicate/delete), a Tool Settings drawer, bulk selection + actions (enable/disable, mode, sticky, trigger %, renumber, delete), and book tools (rename, duplicate, delete, type filter, suggest-all). Also on the extensions (wand) menu.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-summary',
        callback: probeSummary,
        helpString: 'Worlds Apart: summarize the current chat with the configured prompt and score the result. Activates nothing.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-query',
        callback: probeQuery,
        helpString: 'Worlds Apart: score entries against arbitrary text without activating anything. Usage: /wa-query your query text here',
        returns: 'nothing',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'query text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
    }));

    console.log('Worlds Apart: ready');
}

globalThis.worldsApart_intercept = intercept;

// Third-party extensions are loaded as modules; `hooks.activate` may not fire for
// every ST version, so fall back to the conventional jQuery bootstrap.
jQuery(async () => {
    await init();
});
