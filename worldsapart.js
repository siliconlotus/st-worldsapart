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
import { getSortedEntries, getWorldInfoPrompt, loadWorldInfo, saveWorldInfo, reloadEditor, world_names, world_info_include_names, world_info_depth, world_info_min_activations, world_info_match_whole_words, world_info_case_sensitive, selected_world_info, world_info, METADATA_KEY } from '../../../world-info.js';
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
import { getTokenCountAsync } from '../../../tokenizers.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { oai_settings } from '../../../openai.js';

import { runState, defaultSettings, settings, ensureSettings } from './extension/state.mjs';
import { ensureStudioStyle, makeSortControl, makeTierEditor, showEntryText, wiGlyph, wiTooltip } from './extension/ui-widgets.mjs';
import { PRESENTATION_ALIAS, SORT_FNS, normPresentation, presentationBaseLabel, presentationLabel, reconcileTiers, tierRank, wiTitleOf } from './extension/sort.mjs';
import { keywordScoresReport, keywordSuggestReport } from './extension/keyword-tools.mjs';
import { lorebookStudio } from './extension/studio.mjs';

/** Base value for the rewritten `order` sequence. WA rewrites every activated entry's order, so only
 * the relative index matters and the base is free. It is parked far above any plausible authored value
 * for two reasons: an order in the 99000s is unmistakably WA's when inspecting activated entries, and it
 * cannot collide with authored blocks (lorebooks commonly use `order` as coarse bands — constants in one
 * range, keyword entries in another, memory-index chronology in a third) or with ST's own default of 100,
 * which a late force-activation from another extension would still carry into assembly. */
const ORDER_BASE = 99000;

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
    // Drift is silent breakage (the deployed plugin runs code this extension no longer ships), so it
    // also gets a banner at the top of WA settings — the setup box itself is two collapsed drawers deep.
    // Every other state stays in the box: "not detected" is the expected stock install, not a problem.
    const alert = $('#wa_plugin_alert').empty();
    box.empty();
    if (runState.pluginAvailable === null) { box.text('Checking for server plugin…'); return; }
    if (runState.pluginAvailable) {
        // Stale only when we have a source fingerprint to compare and it differs (a null runState.pluginFP is an
        // older, pre-fingerprint build, which also differs → flagged). If the source fetch failed
        // (runState.sourceFP null) we can't judge, so don't nag.
        const stale = runState.sourceFP && runState.pluginFP !== runState.sourceFP;
        if (stale) {
            const warn = '⚠ Server plugin out of date — the deployed copy differs from this extension\'s source. Redeploy and restart:';
            alert.append($('<div style="margin:0 0 8px;padding:6px 8px;border-radius:5px;font-size:0.9em;background:color-mix(in srgb, #e0a86c 15%, transparent);border:1px solid color-mix(in srgb, #e0a86c 45%, transparent);"></div>')
                .append($('<div style="color:var(--warning,#d80);"></div>').text(warn), row(deployCmd)));
            box.append($('<div style="color:var(--warning,#d80);"></div>').text(warn));
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
            // Identity is (text, uid), not text alone: two entries can produce the same chunk, and
            // hashing text alone made one hash stand for both of them. That broke three things at once
            // — `wanted` below couldn't retire entry A's copy while B still produced the text, `owners`
            // silently overwrote A with B, and the plugin's per-hash dedup dropped one of the two rows.
            // ST core lists and deletes by hash only, so the pair has to live IN the hash.
            const hash = getStringHash(`${text}${entry.uid}`);
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
    const key = getStringHash(`${prompt}${s.summaryProfile}${s.summaryTemperature}${s.summaryBypassPreset}${s.summaryLength}`);

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
            <div id="wa_plugin_alert"></div>
            <label class="checkbox_label" for="wa_enabled">
                <input id="wa_enabled" type="checkbox"><span>Enabled</span>
            </label>
            <label>Prompt insertion order</label>
            <small class="opacity50p">How WA lays out the entries it selected, in every prompt. Pick a base sort and, optionally, tiered grouping. (The Studio's sort views reuse this control but are per-session; this one is saved.)</small>
            <div id="wa_presentation_order_mount" style="margin-top:4px;"></div>

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
                    <b>Tier precedence</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">When tiered grouping is on (in the insertion-order control above or in the Studio), entries group into the first tier they match, top to bottom. ↑/↓ sets precedence; untick to skip a tier. Shared with the Studio.</small>
                    <div id="wa_tier_editor_mount" style="margin-top:4px;"></div>
                </div>
            </div>

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
                        <input id="wa_tokens_include_exempt" type="checkbox"><span>Token budget caps "ignore budget" entries (i.e., tokens never exceeds cap)</span>
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
    $('#wa_studio').on('click', () => { lorebookStudio(chatBook()); });

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
        // Wrapped, not passed by reference: ST hands callbacks (namedArgs, unnamedArgs), which would
        // land in preferredBook.
        callback: () => lorebookStudio(chatBook()),
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
