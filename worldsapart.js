/**
 * Worlds Apart — takes over World Info selection, ranking and budget.
 *
 * Core still does the mechanical scanning (keywords, constant, sticky, recursion)
 * and the prompt assembly (positions, depth, roles, outlets, regex, Author's Note).
 * This extension decides which entries survive, in what order, and how many tokens
 * they may spend, by hooking three sanctioned points:
 *
 *   1. WORLDINFO_ENTRIES_LOADED — take the budget; blank keys so core's matcher stays out of what
 *                                  WA owns (vectorized entries always; every keyword-activating
 *                                  entry on a WA-run scan; constants and @@activate keep theirs for
 *                                  group scoring).
 *   2. generate_interceptor      — chunked vector retrieval + WA's keyword matches, force-activate both.
 *   3. WORLDINFO_SCAN_DONE       — feed the scan loop (recursion / min-activation matches, owned scans),
 *                                  then rank everything activated, apply budget, rewrite `order`.
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
    extension_prompt_types,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

import { checkWorldInfo, getSortedEntries, getWorldInfoPrompt, loadWorldInfo, saveWorldInfo, reloadEditor, world_names, world_info_include_names, world_info_depth, world_info_budget, world_info_budget_cap, world_info_min_activations, world_info_match_whole_words, world_info_case_sensitive, world_info_recursive, selected_world_info, world_info, METADATA_KEY, scan_state } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { getStringHash, escapeHtml, getCharaFilename, download, uuidv4 } from '../../../utils.js';
import { pluginFingerprint, PLUGIN_FILES } from './plugin/fingerprint.mjs';
import { admitCeiling } from './plugin/scoring.mjs';
import * as ranking from './extension/ranking.mjs';
import * as matcher from './extension/matcher.mjs';
import { registerKeys, resetSmartKeys } from './extension/smartkeys.mjs';
import * as selection from './extension/selection.mjs';
import { getTokenCountAsync, getTokenizerModel } from '../../../tokenizers.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { oai_settings } from '../../../openai.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

import { runState, defaultSettings, settings, ensureSettings } from './extension/state.mjs';
import { ensureStudioStyle, entryFoldHtml, keyHitsHtml, makeSortControl, makeTierEditor, showEntryText, wiGlyph, wiTooltip } from './extension/ui-widgets.mjs';
import { PRESENTATION_ALIAS, SORT_FNS, gradeOrder, normPresentation, presentationBaseLabel, presentationLabel, reconcileTiers, tierRank, wiTitleOf } from './extension/sort.mjs';
import { lorebookStudio } from './extension/studio.mjs';
import { armNames, buildSample, bundleSamples, captureParams, GRADE_ANCHORS, GRADE_SCALE, gradeValue, keyByUid, mergeGrades, openBundle, rowKey, sampleFile, sceneDiff, searchedBook, splitGraded, toCandidate, unionArms } from './extension/grading.mjs';

/** The grading scale in one caption line, shared by both grading popups. */
const gradeAnchorLine = () => `Grade 0–4: ${GRADE_ANCHORS.map((a, g) => `${g} = ${a.split(';')[0].toLowerCase()}`).join(' · ')}.`;
// Chunking is WA's own, not ST's: it is unreachable under node and it determines every stored vector, so an
// upstream edit would silently invalidate existing indexes. See extension/chunking.mjs.
import { chunkEntry } from './extension/chunking.mjs';
import { buildContentIndex, scoreContent, indexFingerprint, entryKey } from './extension/content-lexical.mjs';
import { buildNameDf, properNames, properShared, properDensity, scoreRelevance, isMemory, modelKey, queryPrefix, postDates } from './extension/relevance.mjs';

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
        if (response.ok) { try { const d = await response.json(); runState.pluginRoot = d?.root ?? null; runState.pluginHost = d?.hostname ?? null; runState.pluginFP = d?.fingerprint ?? null; } catch { /* older plugin: no root/hostname/fingerprint fields */ } }
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
 * Runs a multi-collection query, preferring the plugin's mean-centered search. Takes the NO-PLUGIN PATH
 * — ST's own /api/vector — when the plugin is absent or errors, so the extension works on a stock install.
 * @param {object} args Query arguments
 * @returns {Promise<object>} Grouped results
 */
async function queryCollections(args) {
    // THE MODEL'S QUERY PREFIX GOES ON HERE, and only here. The caller's `searchText` also feeds
    // queryTermWeights, where an instruction would land in the BM25 term weights and the gazetteer as if
    // the user had written it; and applying it inside this function rather than at the call site is what
    // gets it onto BOTH transports below, including the no-plugin path that re-asks after a failure.
    //
    // `queryPrefix` returns '' for any model whose contract WA cannot honour in full — see relevance.mjs.
    const prefix = queryPrefix(vectorRequestBody().model);
    if (prefix) args = { ...args, searchText: prefix + args.searchText };

    // ENTRIES or CHUNKS depending on which path answers — plugin/scoring.mjs admitCeiling carries both
    // numbers and why they differ. Chosen HERE rather than by the caller because the fallback below can
    // fire mid-request, and a ceiling picked before the attempt would ask for entries and be handed
    // chunks. A safety limit on what a pathological scene may feed core's scan loop, not a verdict on
    // any entry — stage 4 makes the only relevance decision.
    if (settings().meanCentered && await hasPlugin()) {
        try {
            const body = vectorRequestBody({ ...args, topK: admitCeiling(true) });
            // The plugin needs the provider settings under one key, as the server does.
            const response = await fetch('/api/plugins/worlds-apart/query-multi', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ...body,
                    centered: settings().meanCentered,
                    sourceSettings: { apiUrl: body.apiUrl, model: body.model, keep: body.keep },
                }),
            });

            if (response.ok) {
                return await response.json();
            }

            console.warn(`Worlds Apart: plugin query failed (${response.status}), taking the no-plugin path`, await response.text());
        } catch (error) {
            console.warn('Worlds Apart: plugin query threw, taking the no-plugin path', error);
        }
    }

    // No threshold to pass: WA has no admission gate at either path, and ST's endpoint defaults its own
    // to 0, which admits everything — the same contract the plugin path now has.
    // No server-side pooling here, so K counts chunks and must run deep enough for each entry's best
    // one to survive. Re-asked rather than inherited from a failed plugin attempt.
    return await vectorPost('query-multi', { ...args, topK: admitCeiling(false) }) ?? {};
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** Unit Separator — see CLAUDE.md. The same literal grading.mjs's rowKey and studio.mjs's rowId join with. */
const US = '';

/**
 * Chunks entries and brings the collection in sync with them.
 * Chunking is for matching only — activation still emits the whole entry.
 * @param {string} world World name
 * @param {object[]} entries Entries belonging to that world
 * @returns {Promise<{collectionId: string, owners: Map<number, string[]>}>}
 */
async function syncWorld(world, entries) {
    const collectionId = `wa_${getStringHash(world)}`;
    const saved = await vectorPost('list', { collectionId }) ?? [];

    const items = [];
    /**
     * Chunk hash -> owning `${world}.${uid}`(s). Hashes carry (text, uid), so within one world every hash
     * has exactly one owner; it stays a LIST because identical (text, uid) in two attached books still
     * collides after the cross-world merge in scoreActivated concats these maps. Resolving ownership here,
     * off the hashes we just computed from the live entries, keeps it independent
     * of how the collection happened to be built (fresh syncs store one row per entry, incremental ones one
     * row total — see eval/reindex-check.mjs on path-dependence).
     * @type {Map<number, string[]>}
     */
    const owners = new Map();

    for (const entry of entries) {
        for (const chunk of chunkEntry(entry.content, settings())) {
            const text = chunk.trim();
            if (!text) {
                continue;
            }
            // Identity is (text, uid), not text alone: two entries can produce the same chunk, and
            // hashing text alone made one hash stand for both of them. That broke three things at once
            // — `wanted` below couldn't retire entry A's copy while B still produced the text, `owners`
            // silently overwrote A with B, and the plugin's per-hash dedup dropped one of the two rows.
            // ST core lists and deletes by hash only, so the pair has to live IN the hash.
            const hash = getStringHash(`${text}${entry.uid}`);
            // DOT, not the US of CLAUDE.md's composite-key rule, and it must stay a dot: this is ST core's
            // key format, not ours (world-info.js builds `${entry.world}.${entry.uid}` for
            // allActivatedEntries and externalActivations). rankActivated is handed that map and looks its
            // keys up in runState.lastScores, so a "tidier" separator here would silently return undefined
            // for every score — and fuseRanks drops rows whose score is undefined, so the vector signal
            // would vanish from the layout ranking with nothing thrown. Use grading.mjs's US-separated
            // rowKey for anything that is ours alone.
            // With uid in the hash, one world yields one owner per hash; still a LIST because identical
            // (text, uid) in two attached books collides, and the cross-world merge concats owners.
            owners.set(hash, [`${entry.world}.${entry.uid}`]);
            items.push({ hash, text, index: entry.uid });
        }
    }

    const wanted = new Set(items.map(x => x.hash));
    const newItems = items.filter(x => !saved.includes(x.hash));
    const staleHashes = saved.filter(x => !wanted.has(x));

    if (newItems.length) {
        console.log(`Worlds Apart: embedding ${newItems.length} new chunks for "${world}"`);
        // Timed, not counted: ms/chunk is the endpoint's, not the book's — measured 110ms on 8B over
        // MLX against 910ms over llama.cpp, so no chunk count means "slow" for every user
        // (embedding-models.md). Indeterminate because the insert is one awaited call; a percentage
        // would need it batched client-side.
        let announced = false;
        const slow = setTimeout(() => {
            announced = true;
            toastr.info(`Embedding ${newItems.length} chunks for "${world}". A large embedding model can make the first sync of a big book take several minutes.`, 'Worlds Apart', { timeOut: 15000 });
        }, 3000);
        const started = Date.now();
        try {
            await vectorPost('insert', { collectionId, items: newItems });
        } finally {
            clearTimeout(slow);
        }
        if (announced) toastr.success(`Embedded ${newItems.length} chunks for "${world}" in ${Math.round((Date.now() - started) / 1000)}s.`, 'Worlds Apart', { timeOut: 5000 });
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

/**
 * Builds the entity-filter term weights for a query — or null when the filter is off, or when the
 * query is a summary (already salience-selected, so filtering it only loses context).
 *
 * ONE owner, because two callers drifted. Retrieval filtered the query; the /wa-query probe did not,
 * and /wa-debug's stage-1 "vector candidates" table IS that probe. So the table reported BM25 from a
 * different term set than the retrieval it was explaining — and since its `gap` and `kept` columns come
 * from fusing those scores, the cutoff it showed could differ from the one live retrieval actually
 * applied. Measured on a real scene, unfiltered BM25 ran ~2x the filtered value (101.06 vs 46.11), which
 * reorders the ranking the cutoff reads. Anything that scores a query goes through here.
 *
 * @param {string} searchText Query text
 * @param {object} [opts]
 * @param {boolean} [opts.log] Log the kept-term count and (in a verbose run) the surviving terms
 * @returns {Promise<Record<string, number>|null>} Term weights, or null to leave the query unfiltered
 */
/**
 * Content-lexical indexes, one per book, rebuilt when that book's fingerprint moves.
 *
 * PER BOOK, not one index across the attached set, because IDF is a corpus statistic and the vector path
 * is already per collection — a term common in one book and rare in another must not average. The scores
 * are merged after pooling, exactly as scoreActivated merges the vector path's.
 *
 * Built from EVERY entry in the book, not the activated ones: an index over the turn's activations would
 * recompute IDF against a population that changes every turn, so the same entry's score would move
 * because its neighbours did.
 * @type {Map<string, {fingerprint: string, index: object}>}
 */
const contentIndexes = new Map();

function contentIndexFor(world, entries) {
    return bookIndexes(world, entries).index;
}

/**
 * Both per-book indexes over one book's entries, behind one fingerprint.
 *
 * THE NAME INDEX RIDES THIS CACHE rather than getting its own, because it is the same kind of quantity:
 * a corpus statistic over the book's entries, query-independent, stale exactly when the book changes.
 * It is not persisted the way the vector collection is — embeddings cost network calls, name extraction
 * is local string work over text already in memory, so a store would be a staleness bug bought with
 * nothing.
 *
 * TWO WALKS, NOT ONE, AND DELIBERATELY: `buildContentIndex` excludes disabled entries because it is
 * asking what can be RETRIEVED, while `buildNameDf` includes them because df asks how DISTINCTIVE a name
 * is in the book's vocabulary (matcher-design.md, *Stage 4 predicts per-entry relevance*, measured).
 * Their document counts also differ — chunks against entries — so neither N may be read for the other.
 *
 * The name index is built only when something wants it: it is a whole-book pass, and the fingerprint
 * would otherwise pay for it on every book of every scan for a column nothing reads.
 */
function bookIndexes(world, entries, { names = false } = {}) {
    const fingerprint = indexFingerprint(entries, settings());
    const hit = contentIndexes.get(world);
    if (hit?.fingerprint === fingerprint && (!names || hit.nameDf)) return hit;
    const index = hit?.fingerprint === fingerprint ? hit.index : buildContentIndex(entries, settings());
    const nameDf = names ? buildNameDf(entries) : hit?.fingerprint === fingerprint ? hit.nameDf : null;
    const fresh = { fingerprint, index, nameDf };
    contentIndexes.set(world, fresh);
    if (hit?.fingerprint !== fingerprint) {
        console.log(`Worlds Apart: content-lexical index for "${world}" — ${index.entryCount} entries, ${index.docCount} chunks`);
    }
    if (names && nameDf && nameDf !== hit?.nameDf) {
        console.log(`Worlds Apart: name index for "${world}" — ${nameDf.ndoc} entries, ${nameDf.df.size} distinct names`);
    }
    return fresh;
}

/**
 * Which vector collections on disk nothing claims any more.
 *
 * NOTHING HAS EVER REMOVED A COLLECTION. `syncWorld` prunes stale CHUNKS, but only for a book it is
 * currently syncing — so a renamed, deleted or detached book leaves its whole collection behind, and so
 * does a switch of embedding source or model, since both are path components. Orphans are invisible to
 * chunk pruning by construction.
 *
 * A BOOK THAT IS NOT ATTACHED IS NOT AN ORPHAN. The test is whether any lorebook the user still HAS
 * hashes to that collection id — `world_names`, not this chat's attached set — because a book you have
 * not opened in a month is not garbage. What that cannot tell apart is a live book whose vectors were
 * built under a different source or model: those are listed as `stale config` rather than unclaimed,
 * since switching back would use them again.
 *
 * REPORTS, NEVER DELETES. Somebody paid embedding time for these.
 * @returns {Promise<{unclaimed: object[], staleConfig: object[], live: object[], bytes: number}|null>}
 */
async function findOrphanCollections() {
    if (!await hasPlugin()) return null;
    const response = await fetch('/api/plugins/worlds-apart/collections', { method: 'POST', headers: getRequestHeaders() });
    if (!response.ok) return null;
    const all = await response.json();
    const claimed = new Set((world_names ?? []).map(n => `wa_${getStringHash(n)}`));
    const v = extension_settings.vectors ?? {};
    const source = v.source || 'transformers';
    // PER SOURCE, not a `??` chain over all of them: `ollama_model` carries a non-empty DEFAULT, so a
    // chain reads it even when the source is vllm and every collection then looks like it was built
    // under another model. `<source>_model` is ST's own naming for the rest; unknown means empty, which
    // compares source alone rather than guessing.
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
    if (!found) return 'Needs the server plugin.';
    const { unclaimed, staleConfig, live, bytes } = found;
    const table = rows => rows.map(c => ({ collection: c.collectionId, source: c.source, model: c.model, size: mib(c.bytes), lastWritten: new Date(c.mtimeMs).toISOString().slice(0, 10) }));
    console.log(`%cWorlds Apart · vector collections — ${mib(bytes)} total`, 'font-weight: bold');
    if (live.length) { console.log(`in use by a book you still have, at the current source/model (${live.length}):`); console.table(table(live)); }
    if (staleConfig.length) { console.log(`the book still exists, but these were built under another source or model (${staleConfig.length}) — switching back would use them again:`); console.table(table(staleConfig)); }
    if (unclaimed.length) { console.log(`NO lorebook hashes to these (${unclaimed.length}) — renamed or deleted books. Nothing will ever read them again:`); console.table(table(unclaimed)); }
    const dead = unclaimed.reduce((a, c) => a + c.bytes, 0);
    const stale = staleConfig.reduce((a, c) => a + c.bytes, 0);
    return unclaimed.length || staleConfig.length
        ? `${mib(bytes)} in ${live.length + staleConfig.length + unclaimed.length} collections — ${mib(dead)} unclaimed, ${mib(stale)} on another source/model. Listed in the console; delete by hand from data/<user>/vectors/.`
        : `${mib(bytes)} in ${live.length} collection(s), all claimed.`;
}

/**
 * The fitted relevance model, loaded once.
 *
 * FETCHED RATHER THAN IMPORTED. A JSON module import would tie the whole extension's load to a syntax
 * not every browser accepts, so a user on an older build would lose WA entirely rather than lose one
 * column. `import.meta.url` keeps the path independent of where ST mounts the extension.
 *
 * A MISSING OR MALFORMED FILE DISABLES THE COLUMN, it does not throw: this is a scoring signal, and a
 * scan that cannot read it should rank exactly as it did before the model existed. `null` is cached too,
 * so a 404 is not re-fetched every turn.
 * @type {{promise: Promise<object|null>|null}}
 */
const relevanceModel = { promise: null, value: null };

function loadRelevanceModel() {
    // ONE FILE PER TIER, because the tiers do not carry the same signals and do not agree on their
    // sign. `density` fits +0.21 on memory and -0.58 on reference — an entry thick with names is a
    // specific scene there and a roster here — so a shared coefficient would carry the wrong sign
    // rather than merely being imprecise. Reference also drops `cosine` entirely: it is absent on 124
    // of 135 of its entries, so a fitted slope reads "nobody computed one" as evidence and would
    // invert on exactly the vectorized reference entries where the number is real.
    relevanceModel.promise ??= Promise.all(['memory', 'reference'].map(tier =>
        fetch(new URL(`./extension/relevance-model-${tier}.json`, import.meta.url))
            .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((file) => {
                // PER EMBEDDING MODEL. Coefficients are fitted against one embedder's cosines and do not
                // carry to another — measured, memory-tier cosine ran +0.3113 under bge-m3 and +0.7460
                // under Qwen3-Embedding-8B, with text and properNouns falling to compensate. So the file
                // is a map keyed by relevance.mjs `modelKey`, and a model with no fit gets NO fit rather
                // than another model's: stage 4 then makes no relevance cut for that tier, which is the
                // documented behaviour for an unscored row, instead of cutting on numbers from elsewhere.
                const key = modelKey(vectorRequestBody().model);
                const m = file?.byModel?.[key] ?? null;
                if (!m) {
                    console.warn(`Worlds Apart: no ${tier} relevance model for embedding model "${key}" `
                        + `(have: ${Object.keys(file?.byModel ?? {}).join(', ') || 'none'}) — that tier's E[credit] will not be scored, `
                        + `so nothing is cut on relevance. Fit one with eval/relevance-regress.mjs --emit-model.`);
                    return [tier, null];
                }
                console.log(`Worlds Apart: relevance model — ${m.tier} tier, ${m.features?.join(', ')}, cutoff ${m.cutoff}, fitted under ${m.embedModel}`);
                return [tier, m];
            })
            .catch((e) => {
                console.warn(`Worlds Apart: no ${tier} relevance model, that tier's E[credit] will not be scored —`, e.message);
                return [tier, null];
            })))
        .then((pairs) => {
            // Kept resolved so paramSnapshot, which is synchronous, can name the fits a capture's
            // eCredit column came out of. A refit changes those numbers and a bundle that does not
            // record WHICH fit produced them cannot be compared across one — the same argument the
            // `tokenizer` field carries for the per-row token counts.
            relevanceModel.value = Object.fromEntries(pairs);
            return relevanceModel.value;
        });
    return relevanceModel.promise;
}

/**
 * Stage 4's relevance column: the two signals the fitted model needs that nothing else computes, then
 * `E[credit]` per entry.
 *
 * MEASURED AND RECORDED, NOT ACTED ON. Nothing here drops an entry. The runtime's `properNouns` and
 * `density` have to be shown to agree with the harness's before a cut placed on them means anything,
 * and the way to show that is to capture both and compare — so this fills the column and stops.
 *
 * THE SAME WINDOW THE FIT SAW, at the GLOBAL depth with a plain entry: proper-noun overlap is a property
 * of the SCENE, so an entry's own opted-in sources are its and not the scene's. `eval/scene.mjs`
 * `haystackFor` calls the same builder with the same inputs, which is why `windowFor` is passed in
 * rather than rebuilt.
 *
 * SCORED PER BOOK, because standardisation is per SCENE and the model is per TIER — but df is a
 * statistic of one book, so an entry's names are weighted against its own corpus and never against the
 * pooled attached set. That is the same one-index rule content-lexical rests on.
 *
 * MEMORY TIER ONLY. The shipped fit is memory's; reference has neither a fit nor a cutoff, and `density`
 * measured INVERTED there (-0.935 against +0.215), so scoring reference rows through these coefficients
 * would carry the wrong sign rather than merely being imprecise.
 */
async function scoreRelevanceColumn(items, windowFor) {
    const models = await loadRelevanceModel();
    if (!models || !windowFor) return;

    // Every entry of every book in the scan, which is what df is a statistic OF — not the activated
    // subset, whose population changes every turn and would move an entry's weight because its
    // neighbours did.
    const byWorld = new Map();
    for (const entry of await getSortedEntries()) {
        if (!byWorld.has(entry.world)) byWorld.set(entry.world, []);
        byWorld.get(entry.world).push(entry);
    }

    const depth = Number(settings().messageDepth || world_info_depth);
    const windowNames = properNames(windowFor(depth, {}).join('\n'));

    for (const item of items) {
        const book = bookIndexes(item.entry.world, byWorld.get(item.entry.world) ?? [], { names: true }).nameDf;
        // The entry's names come off the book walk that built df, so they are extracted once per book
        // rather than once per turn per entry.
        const names = book?.names.get(entryKey(item.entry)) ?? properNames(item.entry.content);
        item.properNouns = book ? properShared(names, windowNames, book) : 0;
        item.density = properDensity(item.entry.content);
    }

    // ONE SCENE, ONE STANDARDISATION — PER TIER. The columns are centred over the rows being scored
    // together, which is what the coefficients are in units of, and each fit standardised over its OWN
    // tier's rows. So memory rows are centred among memory rows and reference among reference; pooling
    // them would score every row on a scale neither fit was built in.
    for (const [tier, model] of Object.entries(models)) {
        if (!model) continue;
        const rows = items.filter(it => (isMemory(it.entry) ? 'memory' : 'reference') === tier);
        if (!rows.length) continue;
        const eCredit = scoreRelevance(model, rows.map(it => ({
            cosine: Number.isFinite(it.score) ? it.score : 0,
            text: Number(it.textScore) || 0,
            keys: Number(it.keywordScore) || 0,
            properNouns: Number(it.properNouns) || 0,
            density: Number(it.density) || 0,
        })));
        rows.forEach((it, i) => { it.eCredit = eCredit[i]; it.eCreditTier = tier; });
    }

    if (runState.verboseRun) {
        const scored = items.filter(it => Number.isFinite(it.eCredit));
        const cuts = Object.entries(models).filter(([, m]) => m).map(([t, m]) => `${t} ${t === 'memory' ? `>= ${m.cutoff}` : 'uncut'}`).join(', ');
        console.log(`%cWorlds Apart · E[credit] over ${scored.length} entries — ${cuts}; the cut runs at selection`, 'font-weight: bold');
        console.table([...scored]
            .sort((a, b) => b.eCredit - a.eCredit)
            .map(it => ({
                entry: it.entry.comment || it.entry.key?.[0] || it.entry.uid,
                tier: it.eCreditTier,
                eCredit: Number(it.eCredit.toFixed(4)),
                clears: it.eCredit >= models[it.eCreditTier].cutoff,
                cosine: Number.isFinite(it.score) ? Number(it.score.toFixed(4)) : null,
                text: Number((it.textScore ?? 0).toFixed(3)),
                properNouns: Number(it.properNouns.toFixed(3)),
                density: Number(it.density.toFixed(2)),
            })));
    }
}

/**
 * BM25 of the scan's query against every entry's CONTENT — the stage-3 text signal, for keyword and
 * vectorized entries alike.
 *
 * SCORING, NEVER ADMISSION: this runs on entries core has already activated. Stage 1 does not consult it,
 * so no amount of lexical overlap can surface an entry whose keys never fired.
 *
 * The same term weights stage 1 used, because the entity filter decides which query terms count at all —
 * scoring the two stages on different term sets would make the text signal disagree with the admission it
 * was supposed to refine.
 *
 * @returns {Promise<Map<string, number>>} `${world}.${uid}` -> best chunk score; empty when unavailable.
 */
async function contentTextScores(query) {
    if (!query) return new Map();
    const byWorld = new Map();
    for (const entry of await getSortedEntries()) {
        if (!byWorld.has(entry.world)) byWorld.set(entry.world, []);
        byWorld.get(entry.world).push(entry);
    }
    if (!byWorld.size) return new Map();

    const s = settings();
    const termWeights = await queryTermWeights(query, { log: false });
    const opts = { k1: s.bm25K1, b: s.bm25B, termWeights, stopwordDf: s.stopwordDocFreq };
    const out = new Map();
    for (const [world, entries] of byWorld) {
        for (const [key, score] of scoreContent(contentIndexFor(world, entries), query, opts)) {
            const prev = out.get(key);
            if (prev === undefined || score > prev) out.set(key, score);
        }
    }
    return out;
}

async function queryTermWeights(searchText, { log = true } = {}) {
    if (!settings().entityFilter || settings().queryMode === 'summary') {
        return null;
    }

    // THE AUTHORED VOCABULARY, not whatever the mutation left behind. getSortedEntries emits
    // WORLDINFO_ENTRIES_LOADED, and this runs at stage 3 with waOwnsScan true, so the entries it hands
    // back have had key/keysecondary blanked into the stash by the takeover — building from them would
    // make "the lorebook's own vocabulary" mean titles plus whatever core exempts, decided by when this
    // happens to be called rather than by anything. A local view, never a write-back.
    const authored = entry => (entry.waKeys || entry.waSecondary)
        ? { ...entry, key: entry.key?.length ? entry.key : (entry.waKeys ?? []), keysecondary: entry.keysecondary?.length ? entry.keysecondary : (entry.waSecondary ?? []) }
        : entry;
    const gazetteer = buildGazetteer((await getSortedEntries()).map(authored));
    const termWeights = buildTermWeights(searchText, gazetteer);

    if (log) {
        console.log(`Worlds Apart: entity filter kept ${Object.keys(termWeights).length} terms (gazetteer has ${gazetteer.size})`);

        if (runState.verboseRun) {
            const byWeight = Object.entries(termWeights).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            console.log(`%cWorlds Apart · surviving query terms — what the entity filter kept, ×N is the proper-noun boost (${byWeight.length} terms)`, 'font-weight: bold');
            console.log(byWeight.map(([term, weight]) => (weight > 1 ? `${term}×${weight}` : term)).join(' '));
        }
    }

    return termWeights;
}

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
function scoreEntries(searchText) {
    const run = () => scoreEntriesUnsafe(searchText);
    const result = retrievalQueue.then(run, run);
    // The catch is on the QUEUE, deliberately not on `result` — it stops one rejection from poisoning
    // every later call, while the rejection still reaches the caller. Do not "tidy" this into
    // `return result.catch(...)`: that turns every retrieval failure into a silent empty, which is
    // indistinguishable from the two legitimate empties in retrieve() and is exactly the conflation
    // reportFailure exists to prevent.
    retrievalQueue = result.catch(() => {});
    return result;
}

/**
 * @param {string} searchText Text to search with
 * @returns {Promise<{targets: object[], scores: Map<string, {score: number, chunk: string}>}>}
 */
async function scoreEntriesUnsafe(searchText) {
    const allEntries = await getSortedEntries();
    // EVERY ENTRY WITH CONTENT IS EMBEDDED AND SCORED. Computing a cosine is not vectorizing an entry:
    // `vectorized` decides what stage 1 RETRIEVES, and a cosine is a column stage 3 reads. An entry that
    // arrives by keyword had no cosine at all before this, which left the relevance model reading an
    // absence as evidence — measured on the reference tier, a column fitted on the entries that happened
    // to carry one runs solo AUC 0.442, below chance, and inverts on the entries where it is real.
    const targets = allEntries.filter(x => !x.disable && x.content);
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
    /**
     * `${collectionId}${US}${hash}` -> every owning `${world}.${uid}` in THAT collection (see syncWorld).
     *
     * SCOPED BY COLLECTION, because a score only means something inside the corpus it was computed in. A
     * collection is one book: the plugin centers each one on its own centroid and derives its own BM25 IDF
     * (plugin/vector.mjs, extension/lexical.mjs), so two books sharing a paragraph score it differently and
     * neither number transfers. Keyed by hash alone, a row scored in Foxbridge also credited the Sommers
     * entry holding the same text, and the max-pooling below handed each of them whichever book flattered
     * the chunk more — which defeats IDF exactly where it does its job: a phrase that is boilerplate in a
     * 400-chunk book looks rare in a 10-chunk one, and the max takes the rare reading. Both entries still
     * get credited when both books are attached; each is now credited from its own corpus.
     * @type {Map<string, string[]>}
     */
    const owners = new Map();

    for (const world of Object.keys(byWorld)) {
        const synced = await syncWorld(world, byWorld[world]);
        collectionIds.push(synced.collectionId);
        synced.owners.forEach((v, k) => owners.set(`${synced.collectionId}${US}${k}`, v));
    }

    // THE CENTROID IS THE MEMORY TIER, named per collection. Widening what is STORED must not widen what
    // mean-centering subtracts — the mean carries most of an embedding's mass — so the population is named
    // here rather than inherited from whatever the collection happens to hold.
    //
    // MEMORY, NOT `vectorized`. Centering removes a corpus's shared direction, which only means something
    // over one REGISTER: memory entries are narrative summaries and reference entries are encyclopedic, and
    // a blend of the two fully removes neither, leaving each tilted toward the other. `vectorized` is a
    // retrievability flag, so it selected a register-mixed population for reasons unrelated to centering —
    // it was the pre-backfill comparison set, frozen, from before scoreEntriesUnsafe scored every entry.
    // Reading the tier makes this consistent with every other per-tier thing downstream (relevance.mjs's
    // two fits, its within-tier standardisation, stage 4's per-tier cutoff).
    //
    // CHOSEN ON CONSISTENCY, MEASURED FLAT — the two populations produce near-identical means, so this is
    // not a performance change and should not be reported as one. Measured over 104 graded scenes on 4
    // lineages, paired: -0.0003 n@10 and -0.0016 F2, neither significant. The centroids themselves sit at
    // cosine 0.99873-1.00000 of each other across 6 books (eval/scene.mjs centroidPopulation runs the
    // contrast; 'vectorized' restores this line's old behaviour). That closeness is also why the memory
    // tier's fitted cosine coefficient needs no refit: 0.002 of centroid movement is far below what it
    // could read.
    const centroidUids = {};
    for (const [world, entries] of Object.entries(byWorld)) {
        centroidUids[`wa_${getStringHash(world)}`] = entries.filter(isMemory).map(e => Number(e.uid));
    }

    const results = await queryCollections({
        collectionIds,
        searchText,
        centroidUids,
    });

    // The plugin now returns one pooled record per entry, so this loop's max-taking is a no-op against a
    // current plugin. It stays because it is also what unpacks the response into `scores` at all, and because
    // it keeps an un-redeployed plugin (which still returns raw chunks) pooling correctly rather than letting
    // the last chunk of each entry win. `score` is only present if the backend returns it; without that patch
    // we fall back to rank position, which is still correctly ordered within a collection.
    // ENTRIES, not values: the collectionId is the key, and it is half the owner lookup — a chunk's score is
    // only meaningful against the corpus it was computed in (see `owners`).
    // Chunks the backend returned with no score at all. Counted rather than ignored: it means the
    // no-plugin path answered, so stage 1 has no cosine to give stage 3 and the relevance model is
    // running on its other three signals.
    let rankOnly = 0;
    for (const [collectionId, group] of Object.entries(results)) {
        const metadata = group?.metadata ?? [];
        metadata.forEach((item, index) => {
            // EVERY owner of the chunk within this collection, not one. The store keeps at most one row per
            // hash on an incremental sync, so two entries in the same book sharing a chunk come back once;
            // crediting only one of them made the other unreachable through that text. This is not
            // over-crediting — each of these entries genuinely contains the chunk — and the max-pooling
            // below means an entry with a better chunk of its own still wins on that one.
            const chunkOwners = owners.get(`${collectionId}${US}${Number(item?.hash)}`);
            if (!chunkOwners?.length) {
                return;
            }

            // NO INVENTED SCORE. This used to fall back to `1 - index/metadata.length` when the backend
            // returned none, which was harmless while the value only had to ORDER things — and is not
            // harmless now that a fitted coefficient multiplies it. ST's own endpoint drops the score
            // (`src/endpoints/vectors.js` maps `x.item.metadata`), so on the no-plugin path every
            // "cosine" became a rank position in [0,1] fed to a model expecting a centred cosine around
            // [-0.01, 0.42]. Observed: a whole capture where the column was 1 - rank/3332, exact to the
            // rounding, and the relevance cut ran on it.
            //
            // Absent is the honest value. A row with no cosine is a row the model scores on its other
            // signals, which is a claim it can make; a rank wearing a cosine's units is not.
            const score = typeof item?.score === 'number' ? item.score : null;
            if (score === null) { rankOnly++; return; }

            for (const owner of chunkOwners) {
                const previous = scores.get(owner);

                // One signal, so one maximum. This used to pool vector and lexical independently, because
                // an entry's best semantic chunk and its best lexical chunk need not be the same one; stage
                // 1 is cosine-only now (plugin/scoring.mjs) and the server sends no bm25 to pool.
                if (!previous || previous.score < score) {
                    scores.set(owner, { score, chunk: String(item?.text ?? '') });
                }
            }
        });
    }

    // LOUD, because the failure is silent by nature: the stock endpoint answers, the rows come back in
    // the right ORDER, and nothing looks wrong until a fitted coefficient multiplies a score that was
    // never computed. `reportFailure` (matcher-design.md, *Open work*) is the general form of this.
    if (rankOnly) {
        console.warn(`Worlds Apart: ${rankOnly} chunk(s) came back with no score — the no-plugin path answered, so stage 1 has no cosine. `
            + 'The relevance model is running on text, proper nouns and density alone. Check that the server plugin is loaded and that its query is not failing.');
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
    // the temperature or switching profile silently reuses the old summary. Anything that
    // would produce a different answer must be in the key.
    const s = settings();
    const key = getStringHash(`${prompt}${s.llmProfile}${s.llmTemperature}${s.summaryLength}`);

    if (summaryCache.has(key)) {
        console.log('Worlds Apart: reusing cached summary');
        return summaryCache.get(key);
    }

    try {
        const profileId = settings().llmProfile;
        const profile = profileId
            ? (extension_settings.connectionManager?.profiles ?? []).find(x => x.id === profileId)
            : null;

        // Empty means "don't send it" — the preset (or the backend default when the
        // preset is bypassed) decides. Only reachable on the profile path; generateRaw
        // takes no generation parameters, so the current-API path can't honour it.
        const temperature = String(settings().llmTemperature ?? '').trim();
        const overridePayload = temperature === '' ? {} : { temperature: Number(temperature) };

        if (temperature !== '' && !profile) {
            console.warn(`Worlds Apart: summary temperature ${temperature} ignored — it needs a summary profile. The current API's preset governs instead.`);
        }

        console.log(`Worlds Apart: summarizing ${prompt.length} chars via ${profile ? `profile "${profile.name}" (preset bypassed)` : 'the current API'}${profile && temperature !== '' ? `, temperature ${temperature}` : ''}`);

        // The full prompt is the instruction plus the whole chat slice — thousands of
        // tokens. Only dump it on a debug run, and as an object so devtools collapses it.
        if (runState.verboseRun) {
            console.log('%cWorlds Apart · summarizer prompt', 'font-weight: bold', { prompt });
        }

        let summary;

        if (profile) {
            // includePreset false, always — see keyword-tools.mjs generateText for why the preset
            // is business logic rather than a setting (it contributes samplers, not prompt text).
            const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, settings().summaryLength, { includePreset: false }, overridePayload);
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
 * Prints /wa-query's table: every scored entry by cosine, with the gap between neighbours.
 *
 * Takes the scores retrieval computed rather than re-scoring. /wa-debug used to render this by calling the
 * probe, which scored the query a SECOND time and could disagree with the retrieval it was explaining (it
 * did: the probe skipped the entity filter).
 *
 * @param {Map<string, {score: number, chunk: string}>} scores Per-entry results
 * @param {object[]} targets Entries in the active books
 * @param {string} searchText The query
 */
function reportVectorCandidates(scores, targets, searchText) {
    const byKey = new Map(targets.map(x => [`${x.world}.${x.uid}`, x]));
    const rows = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
    const spread = rows[0][1].score - rows[Math.min(4, rows.length - 1)][1].score;

    console.log(`Worlds Apart: query "${searchText.slice(0, 80)}${searchText.length > 80 ? '\u2026' : ''}" (${searchText.length} chars)`);
    console.log(`Worlds Apart: ${rows.length} entries scored, cosine order, top-5 spread ${spread.toFixed(5)}`);
    console.log('%cWorlds Apart \u00b7 /wa-query \u2014 every scored entry by cosine, best first', 'font-weight: bold');
    // SORTED HERE, NOT RANKED UPSTREAM. Stage 1 assigns no rank any more: it admits everything it scores,
    // so a stored rank ordered nothing. This is a presentation order for one command, computed where it
    // is displayed, which is the only place the question "what is most similar to this text" is asked.
    console.table(rows.map(([key, value], index) => ({
        gap: index > 0 ? Number((rows[index - 1][1].score - value.score).toFixed(6)) : null,
        title: byKey.get(key)?.comment,
        '#': index + 1,
        vec: Number(value.score.toFixed(5)),
        matchedChunk: value.chunk.slice(0, 70).replace(/\s+/g, ' '),
    })));
}

/**
 * Runs retrieval against the chat and returns the winning entries. Emission is
 * selectAndActivate's — retrieval is one of two activation routes, not the owner of the emit.
 * @param {object[]} chat Chat messages
 * @returns {Promise<object[]>} Entries retrieval selected for activation
 */
async function retrieve(chat) {
    runState.lastScores.clear();

    // One substitution pass over the chat serves both the query string and the /wa-grade stash below —
    // queryMessages runs ST's macro engine over every message, so it must not run twice per generation.
    const queryChat = ranking.queryMessages(chat, { depth: settings().messageDepth, substituteParams });
    const rawText = ranking.joinQueryMessages(queryChat);

    if (!rawText) {
        console.log('Worlds Apart: no query text, skipping retrieval');
        return [];
    }

    const searchText = settings().queryMode === 'summary'
        ? await summarizeQuery(rawText)
        : rawText;


    if (settings().queryMode === 'summary') {
        console.log(`Worlds Apart: summarized ${rawText.length} chars into ${searchText.length}: "${searchText}"`);
    } else {
        console.log(`Worlds Apart: query is ${searchText.length} chars from ${settings().messageDepth} message(s), matched against ~${settings().chunkSize}-char entry chunks`);
    }

    // Recorded for /wa-grade BEFORE the retrieval outcome is known: a book with no vectorized
    // entries legitimately scores nothing below, but the query exists the moment it is built, and a
    // keyword-only scene is still gradeable against it. Recording only on the success path made
    // /wa-grade refuse every scene on such a book ("Retrieval activated nothing") even though the
    // keyword route had activated rows to grade.
    runState.lastQuery = searchText;
    // The MESSAGES the query was built from, macros already resolved, in ST's own {name, mes} shape so
    // ranking.buildQuery can be re-run over them offline at any depth <= this one. This is what makes a
    // depth ablation possible from a single capture: capture wide, then narrow. It cannot be recovered by
    // splitting `lastQuery`, because messages contain blank lines and the join separator is '\n\n'.
    runState.lastQueryChat = queryChat;

    // No entity filter here: it produces BM25 query terms, and stage 1 has no BM25 to spend them on
    // (plugin/scoring.mjs). It still runs at stage 3, where content-lexical reads it — see
    // contentTextScores. Building the gazetteer per generation for nobody was the leftover.
    const { targets, scores } = await scoreEntries(searchText);

    // Two different empties, and conflating them sent people off to tune a threshold that was never
    // involved (and no longer exists): a book with nothing vectorized has no candidates at all.
    if (!targets.length) {
        console.log('Worlds Apart: no entries with content in the active books, so retrieval has nothing to score');
        return [];
    }
    if (!scores.size) {
        console.log('Worlds Apart: the query scored no chunk in any collection');
        return [];
    }

    // NO RETRIEVAL RANKING. Stage 1 admits everything it ADMITS, so an ordering here decided nothing
    // except which entries survive `admitCeiling` — and that bound is the plugin's, applied before these
    // scores ever reach the client.
    //
    // ADMISSION IS NARROWER THAN SCORING NOW, and the two must not be confused. Every entry with content
    // is embedded and scored, so a keyword-activated entry has a cosine for stage 3 to read — but only a
    // `vectorized` entry is force-activated here. The author's flag is what says an entry should be
    // RETRIEVABLE; a cosine is just a number computed about it. Admitting on the score instead would put
    // every entry of every attached book into the prompt's candidate set on the strength of a similarity
    // nobody asked for it to have.
    const vectorizedKeys = new Set(targets.filter(x => x.vectorized).map(x => `${x.world}.${x.uid}`));
    const winnerKeys = new Set([...scores.keys()].filter(k => vectorizedKeys.has(k)));

    // NO STAGE-1 TABLE. It printed the admitted ranking, the neighbour gaps and each entry's matched
    // chunk, which was worth reading while stage 1 CHOSE something. It no longer does: admission is
    // unconditional and the cosine ranking's order now decides nothing except which entries survive
    // `admitCeiling`, which no measured book approaches (largest: 208 vectorized entries). So the table
    // was one row per entry in the book, ranked by a quantity with no consequence — and the per-entry
    // cosine it carried is in the stage-3/4 table beside the signals it is actually weighed against.
    // `/wa-query` still renders it, where an explicit ranking of arbitrary text IS the answer.

    // EVERY admitted entry, not a surviving prefix. Stage 3 looks its vector score up from here, so
    // stashing only survivors would leave every entry stage 4 has yet to judge without the signal it was
    // admitted on — and a missing signal reads as a low score rather than as an error.
    for (const [key, value] of scores) {
        runState.lastScores.set(key, value.score);
    }

    // winnerKeys is the VECTORIZED half of what scored. targets includes entries the query never scored
    // at all (absent from the response, or absent from the store's); admitting those would return an
    // entry with no vector score for stage 3 to look up.
    return targets.filter(x => winnerKeys.has(`${x.world}.${x.uid}`));
}

/**
 * The union direction: entries WA's matcher activates over its own
 * window, which core cannot or would not — `?` SmartKeys have no core semantics, the fold and
 * messageDepth are supersets. This function only extracts ST context; the candidacy rules and the
 * verdict live in matcher.mjs (activationAdds), where the check suite exercises them.
 * @param {object[]} chat The interceptor's chat — core's own scan haystack
 * @returns {Promise<object[]>} Entries to force-activate
 */
async function keywordActivations(chat) {
    const candidates = await getSortedEntries();

    // Under the takeover: these copies (live keys — waOwnsScan is false during WA's own fetch, so
    // onEntriesLoaded's takeover blanking never touches them) are what the SCAN_DONE feed
    // rematches on every recursion and min-activation pass.
    runState.waCandidates = candidates;

    const windowFor = matcher.makeWindowFor(chat.filter(x => x && !x.is_system), {
        injects: await scanInjects(),
        sources: scanSources(),
        matchWindow: settings().matchWindow,
        includeNames: world_info_include_names,
    });

    // Register every key this pass will match up front so the smartkeys automaton is built once — a
    // first-seen key mid-loop dirties it, and the rebuild throws away every cached scan.
    //
    // SECONDARIES COUNT. countSelective interns their literals too, so leaving them to be primed per
    // entry meant a rebuild for the first entry carrying a novel secondary, and another for the next:
    // measured 102 ms against 2 ms over 200 entries x 20 segments. Filtered exactly as the matching
    // path filters them, so nothing is registered that will never be asked — and an entry with no
    // usable primary is skipped whole, as activationAdds skips it.
    //
    // Registering here also pre-covers stage 3's registerKeys for this generation.
    registerKeys(candidates.flatMap(e => {
        const keys = e.disable ? [] : matcher.usableKeys(e.key);
        return keys.length ? [...keys, ...matcher.secondaryKeys(e)] : [];
    }));

    return matcher.activationAdds(candidates, windowFor, {
        messageDepth: settings().messageDepth,
        fallbackDepth: world_info_depth,
        caseSensitiveDefault: world_info_case_sensitive,
        wholeWordsDefault: world_info_match_whole_words,
    });
}

/** Distinct failures already surfaced this session, keyed stage␟message (US, never NUL — see CLAUDE.md). */
const reportedFailures = new Set();

/**
 * A generation-time failure the USER has to see, not just the console.
 *
 * WHY A TOAST. The realistic trigger is not a bad key — the matcher catches its own regex and null
 * cases — but the ST surface around it: `getSortedEntries`, the inject API, the `world_info_*`
 * globals. So this fires after someone updates SillyTavern, and it presents to them as "I updated ST
 * and my lorebook stopped working". A console line does not reach that person.
 *
 * WHAT IT CARRIES. Stage, consequence in plain terms, the error's own message, and the top stack
 * frame — the frame is what separates "ST changed an API" from "WA has a bug", and without it the
 * only report anyone can file is "WA broke". The console keeps the full trace.
 *
 * ONCE PER DISTINCT MESSAGE PER SESSION. This throws every generation once it starts, and a toast
 * per turn trains the user to dismiss it unread, which is the same as not showing it at all.
 *
 * @param {string} stage Which half failed, as the toast title
 * @param {string} consequence What the user will observe this turn
 * @param {unknown} error
 * @param {'error'|'warning'} [severity]
 */
function reportFailure(stage, consequence, error, severity = 'error') {
    console.error(`Worlds Apart: ${stage} — ${consequence}`, error);
    const cause = String(error?.message ?? error);
    const key = `${stage}${cause}`;
    if (reportedFailures.has(key)) return;
    reportedFailures.add(key);
    const frame = String(error?.stack ?? '').split('\n')[1]?.trim().replace(/^at\s+/, '');
    // ST sets toastr.options.escapeHtml = true globally (script.js), which collapses `\n` to a space
    // and would run all three parts together on one line — so opt out per-toast and escape the parts
    // by hand. `cause` and `frame` come from an exception, which can carry anything.
    // closeButton too: the global default is false, and a 20s error the user cannot dismiss is its
    // own annoyance.
    toastr[severity](
        [escapeHtml(consequence),
            escapeHtml(cause) + (frame ? `<br>&nbsp;&nbsp;at ${escapeHtml(frame)}` : ''),
            'See the browser console for the full trace.'].join('<br><br>'),
        `Worlds Apart: ${stage}`,
        { timeOut: 20000, extendedTimeOut: 15000, escapeHtml: false, closeButton: true },
    );
}

/**
 * Stage 1+2 orchestrator: retrieval winners ∪ keyword adds, one FORCE_ACTIVATE emit.
 * The two routes fail independently — a vector-plugin outage must not cost keyword
 * activation, and vice versa.
 * @param {object[]} chat Chat messages
 */
async function selectAndActivate(chat) {
    // /wa-dry reaches here without the interceptor running — its replayed scan must judge
    // against the chat it was handed, not a previous generation's stash. Redundant (same
    // array) on the intercept path.
    runState.scanChat = chat.slice();

    // Per-scan takeover state. waOwnsScan goes FALSE first — WA's own getSortedEntries calls
    // below fire WORLDINFO_ENTRIES_LOADED, and the takeover blanking must not eat the keys WA
    // is about to match on (a stale true from an aborted scan would).
    runState.waOwnsScan = false;
    runState.waMatched = new Set();
    runState.waRecursionTexts = [];
    runState.waMinSkew = 0;
    runState.waCandidates = null;

    let winners = [];
    try {
        winners = await retrieve(chat);
    } catch (error) {
        // A DEGRADATION, not a break: keyword matching still runs below and the takeover still
        // engages, so keys are handled — only the vector half of this turn is missing.
        reportFailure('retrieval failed',
            'Vectorized entries will not be retrieved this turn. Keyword matching is unaffected.',
            error, 'warning');
        runState.lastScores.clear();
    }

    let adds = [];
    try {
        adds = await keywordActivations(chat);
    } catch (error) {
        // TOTAL, and the message must say so: waOwnsScan is set below regardless, blanking every key,
        // so core does not match either. WA owns its failure states — it does not hand matching back
        // per turn, it fails visibly.
        reportFailure('keyword activation failed',
            'No entry will activate by keyword this turn. WA has taken over key matching, so SillyTavern will not match them either — the prompt has only retrieved, constant and sticky entries.',
            error);
    }

    // Union provenance: keys WA activated by keyword match alone. Always reassigned (even empty)
    // so a stale set never outlives its generation; task-4's prune exempts winners ∪ this set.
    const winnerKeys = new Set(winners.map(e => `${e.world}.${e.uid}`));
    const union = adds.filter(e => !winnerKeys.has(`${e.world}.${e.uid}`));
    runState.lastKeywordAdds = new Set(union.map(e => `${e.world}.${e.uid}`));

    const activated = [...winners, ...union];
    if (activated.length) {
        console.log(`Worlds Apart: activating ${winners.length} retrieved + ${union.length} keyword-matched entries`);
        await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, activated);
    }

    // The takeover flag goes TRUE last, after WA's own fetches are done: the next
    // WORLDINFO_ENTRIES_LOADED is core's scan, and that is the one whose keys get blanked.
    // Cleared on the scan's final SCAN_DONE loop and at generation end.
    for (const e of activated) runState.waMatched.add(`${e.world}.${e.uid}`);
    runState.waOwnsScan = true;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Generation interceptor. Runs before the World Info scan.
 *
 * QUIET GENERATIONS ARE ORDINARY GENERATIONS HERE. A `type === 'quiet'` run (Summarize, the SD
 * prompt generator, the LLM expression classifier, /gen and the st-context API) scans World Info
 * exactly like a visible one — `skipWIAN` gates only whether depth/outlet entries are injected,
 * never the scan — and ST runs interceptors for it deliberately, gating them on `!dryRun` alone
 * and passing `type` through so an extension can decide for itself. So WA governs it too: if the
 * scan happens, WA's selection is what it should return.
 *
 * WA used to return early on quiet, which was half a skip and incoherent — retrieval and the union
 * were skipped, but `onEntriesLoaded` still took core's budget and still blinded core to
 * vectorized entries' keys, and `rankActivated` still ranked and budgeted the result against
 * `lastScores` left over from the PREVIOUS real generation. A vectorized entry could therefore
 * never activate on a quiet run (no retrieval, keys blanked), while the entries that did activate
 * were cut by a budget walk reading another turn's scores.
 *
 * Neither summarization route re-enters this: `generateRaw` and ConnectionManagerRequestService
 * both bypass `Generate` (no interceptors, no WI scan), so summary mode cannot recurse.
 *
 * Dry runs are upstream's call, not WA's — `runGenerationInterceptors` is skipped for them
 * entirely, so WA is never offered the chance and core's matcher and budget are what those
 * token estimates see.
 *
 * @param {object[]} chat Chat messages
 * @param {number} _maxContext Max context size
 * @param {string} _type Generation type
 */
async function intercept(chat, _maxContext, _type) {
    // Stashed BEFORE the gates: the received chat IS core's scan haystack (script.js builds
    // chatForWI from this same coreChat — regex scripts applied, file content and titles
    // appended, reasoning merged). Sliced so ST's later in-place splices (jailbreak injects)
    // can't shift membership under a SCAN_DONE consumer.
    runState.scanChat = chat.slice();
    // BEFORE the gate: a disabled generation's scan is core's, and a takeover flag leaked from
    // an aborted scan would blank its keys with no WA union behind them.
    runState.waOwnsScan = false;

    if (!settings().enabled) {
        return;
    }

    await selectAndActivate(chat);
}


/**
 * Blinds core's keyword matcher on a scan WA owns — every keyword-activating entry's keys are stashed
 * and blanked, so WA's force-emit is the only keyword route into `activated` — and takes the budget
 * off core.
 * Entries here are freshly-spread objects, so REASSIGNING `key` is safe —
 * mutating the array in place would corrupt the cached world data.
 * @param {object} loaded Lore buckets
 */
function onEntriesLoaded(loaded) {
    if (runState.inCoreProbe) return;   // the exemption is lifted on purpose mid-probe
    const entries = Object.values(loaded ?? {}).filter(Array.isArray).flat();

    // Free ride: this hook already sees every entry in scope, so count the exempt ones
    // here rather than loading the lorebooks a second time.
    showExemptCount(entries);

    // Gated on WA actually cutting this generation, because core's budget is the BACKSTOP: on any
    // path where rankActivated returns early, core's cut is the only thing still bounding the
    // prompt. Dry runs (PromptManager token counts, chat load) are exactly that path.
    if (settings().enabled && !runState.generationIsDryRun) {
        for (const entry of entries) {
            entry.waIgnoreBudget = Boolean(entry.ignoreBudget);   // always set, so `??` above only
            entry.ignoreBudget = true;                            // falls through for the ungated paths
        }
    }

    if (!settings().enabled) {
        return;
    }

    // On a scan WA intercepted, core's keyword matcher goes blind:
    // every keyword-activating entry's keys are stashed and blanked, so the only keyword route
    // into `activated` is WA's force-emit and the group filter runs over WA's verdicts (the
    // matcher-before-group-filter ordering 1.5 could not have). waOwnsScan is only true between
    // the end of selectAndActivate and the scan's last loop, so WA's own fetches and the dry-run
    // scans WA is never offered keep live keys and core behaviour. Secondaries are stashed too:
    // stage 3's secondary gate must judge the same condition the author wrote, not an empty one.
    if (runState.waOwnsScan && !runState.generationIsDryRun) {
        for (const entry of entries) {
            if (!entry || entry.waKeys) continue;   // already stashed and blanked this load
            // Constants and @@activate entries KEEP their keys. Core's scan loop short-circuits
            // both before its key-matching path, so live keys cannot leak a core keyword
            // activation — and the inclusion-group filter's getScore reads entry.key, so blanking
            // them would make a grouped constant score 0 under group scoring and lose ties it
            // should win. The other group classes need nothing: sticky winners skip scoring
            // entirely (filterGroupsByTimedEffects), and every keyword-activated entry reaches
            // the filter as WA's live-key copy via the external-activation map.
            if (entry.constant || matcher.hasDecorator(entry, '@@activate')) continue;
            // COPIED, not aliased. getGlobalLore builds each entry with a shallow spread, so `entry.key`
            // is still the same array object as loadWorldInfo's cached book data — blanking is safe
            // because it rebinds the field, but holding the reference would put a live handle on the
            // cache one in-place sort or splice away from corrupting the lorebook for the session.
            entry.waKeys = [...(entry.key ?? [])];
            entry.waSecondary = [...(entry.keysecondary ?? [])];
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

    const exempt = entries.filter(selection.authorIgnoreBudget).length;

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
const countKey = matcher.countKey;

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
 *
 * WHERE EACH ONE SITS COMES BACK WITH IT, which core throws away. `addInject` takes a bare string, so by
 * the time core's buffer assembles a window the depth is unrecoverable and every inject is ambient — the
 * defect in `upstream-st.md` #16. `ambient` collapses the position to the one question a window has to
 * ask, and keeps matcher.mjs ST-free; `makeWindowFor` decides what that means.
 *
 * @returns {Promise<Array<{key: string, text: string, ambient: boolean, depth: number}>>} Scan-enabled injects
 */
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
            // Only an IN_CHAT prompt has a chat position to bound. IN_PROMPT, BEFORE_PROMPT and NONE
            // carry a `depth` that means nothing as a message index, so testing it would be inventing a
            // position core never gave them.
            ambient: prompts[key].position !== extension_prompt_types.IN_CHAT,
            depth: Number(prompts[key].depth) || 0,
        });
    }

    return out;
}

// withMatchSources and MATCH_SOURCE_FIELDS live in ranking.mjs now (pure window assembly, shared
// by activation and scoring); callers pass settings().matchWindow.
const withMatchSources = (chatWindow, entry, sources) =>
    matcher.withMatchSources(chatWindow, entry, sources, settings().matchWindow);

// Keyword scoring lives in matcher.mjs (match semantics), RRF fusion in ranking.mjs (the tuning
// layer). Inject the BM25 k1 + the world-info match defaults for scoring, and the fusion weights
// for fusion — all from settings.
const keywordScore = (entry, text, keys = entry.key) => matcher.keywordScore(entry, text, keys, {
    k1: settings().bm25K1,
    repeatCurve: settings().repeatCurve,
    repeatR: settings().repeatR,
    caseSensitiveDefault: world_info_case_sensitive,
    wholeWordsDefault: world_info_match_whole_words,
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
/** WHAT WA WAS, from its own manifest. The extension cannot read git — it runs in the browser — so the
 *  declared version is what there is, and a declared one is at least honest about being declared.
 *
 *  THROUGH import.meta.url, not a fixed path: ST clones into third-party/<repo-name> and that name varies
 *  with whatever the clone was called, so a hard-coded folder reads nothing on half the installs.
 *
 *  Cached, and an empty string on failure rather than a guess: a capture naming no version is readable as
 *  "unknown", while one naming the wrong version is not readable as anything. */
let waVersionCache = null;
async function waVersion() {
    if (waVersionCache !== null) return waVersionCache;
    try {
        const r = await fetch(new URL('./manifest.json', import.meta.url));
        const d = r.ok ? await r.json() : null;
        waVersionCache = d?.version ? String(d.version) : '';
    } catch { waVersionCache = ''; }
    return waVersionCache;
}

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
    const body = vectorRequestBody();
    return `data/default-user/vectors/${body.source}/wa_${getStringHash(world)}/${body.model || 'default'}/index.json`;
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
    // A key with no list starts EMPTY, and ensureWorldConfigs seeds it in source order from the books
    // actually in the scan. There was a `worldPriority` array before this was scoped, copied in here
    // once per key; it is gone, having nothing left to seed.
    byChar[key] ??= [];
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

/**
 * The per-loop feed: with core's keyword matcher blanked, WA answers
 * "did a key match" for every scan loop after the initial pass — recursion text and min-activation
 * widening. Runs on each WORLDINFO_SCAN_DONE of an owned scan, matches the not-yet-emitted
 * candidates over chat + all recursion content so far, and force-emits the winners; core's next
 * loop admits them through its own gates (probability, delay levels, group filter, triggers).
 *
 * Two things this deliberately does NOT do, both verified against core's loop:
 *  - No `state.next` writes. Core schedules the next loop itself in every case WA feeds: a pass
 *    with recursion-eligible successes sets RECURSION, a REMAINING delay level sets RECURSION, and
 *    min-activations sets MIN_ACTIVATIONS — and WA only ever has something new to emit in exactly
 *    those cases (its matches come from that pass's content or that pass's widening).
 *
 *    THE TAKEOVER DOES NOT STARVE THAT. Core's scheduler reads `successfulNewEntriesForRecursion`,
 *    which it builds from `activatedNow` — and an externally-activated entry is added to
 *    `activatedNow` by the same walk (world-info.js, the `getExternallyActivated` branch). So WA's
 *    emits drive core's loop exactly as core's own keyword matches used to.
 *  - No re-emission. WorldInfoBuffer.externalActivations is a static map cleared only at scan end,
 *    so one emit is standing for the whole scan — core re-checks it every loop, which is how an
 *    entry refused at one delay level is admitted at a later one.
 *
 * @param {object} args WORLDINFO_SCAN_DONE args
 */
async function feedScanLoop(args) {
    const activated = args.activated.entries;
    // Already-activated entries (constant, sticky, other extensions' forces) never need an emit;
    // recording them also keeps them out of every rematch.
    for (const key of activated.keys()) runState.waMatched.add(key);

    // This pass's recursion-eligible content. preventRecursion is filtered FIRST:
    // args.new.successful is the list before core's own filter, and core builds its recursion
    // buffer from the filtered list — using it raw would restore the propagation the flag stops.
    // Inherit world_info_recursive: WA matching recursion text would force recursion the user
    // disabled. Contents are macro-substituted and decorator-stripped by the time they get here.
    const newTexts = world_info_recursive
        ? (args?.new?.successful ?? [])
            .filter(e => e && !e.preventRecursion)
            .map(e => String(e.content ?? ''))
            .filter(Boolean)
        : [];
    runState.waRecursionTexts.push(...newTexts);

    // Core widens its min-activations window one message per pass (advanceScan); mirror the skew
    // on WA's default depth so the widening actually reaches WA's matcher — with core's keys
    // blanked, this feed is the only thing min activations can pull from.
    const skewed = args?.state?.next === scan_state.MIN_ACTIVATIONS;
    if (skewed) runState.waMinSkew++;

    if (!newTexts.length && !skewed) {
        return;
    }

    const candidates = runState.waCandidates.filter(e => !runState.waMatched.has(`${e.world}.${e.uid}`));
    if (!candidates.length) {
        return;
    }

    const windowFor = matcher.makeWindowFor(
        (runState.scanChat ?? []).filter(x => x && !x.is_system), {
            injects: await scanInjects(),
            sources: scanSources(),
            matchWindow: settings().matchWindow,
            includeNames: world_info_include_names,
        });

    const adds = matcher.activationAdds(candidates,
        matcher.withExtraTexts(windowFor, runState.waRecursionTexts, settings().matchWindow), {
            messageDepth: settings().messageDepth,
            fallbackDepth: world_info_depth,
            caseSensitiveDefault: world_info_case_sensitive,
            wholeWordsDefault: world_info_match_whole_words,
            depthSkew: runState.waMinSkew,
        });

    if (adds.length) {
        for (const e of adds) {
            runState.waMatched.add(`${e.world}.${e.uid}`);
            runState.lastKeywordAdds.add(`${e.world}.${e.uid}`);
        }
        console.log(`Worlds Apart: activating ${adds.length} keyword-matched entr${adds.length === 1 ? 'y' : 'ies'} on scan loop ${args?.state?.loopCount} (${newTexts.length ? 'recursion text' : 'min-activations widening'})`);
        await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, adds);
    }
}

/**
 * What core selected while WA stood down — recorded, never acted on.
 *
 * WA disabled captures the full counterfactual (every interceptor runs); a dry run is free but
 * keyword-only, since ST skips interceptors. Either way it is core's SHIPPED set: WORLDINFO_SCAN_DONE
 * fires after core's budget loop and neither path lets WA mark entries `ignoreBudget`.
 */
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

/**
 * WA against ST core on this turn: core selects for itself and WA diffs the two.
 *
 * `checkWorldInfo` is core's whole selection — inclusion groups, probability, timed effects, its own
 * budget — so nothing here models it. Two things must be undone for the call and are restored after:
 * the `ignoreBudget` takeover WA applies in `onEntriesLoaded` (or core's walk cuts nothing), and
 * re-entry via WORLDINFO_SCAN_DONE, which `inCoreProbe` suppresses.
 *
 * Vector Storage activates World Info from its generate_interceptor, exposed as
 * `globalThis.vectors_rearrangeChat`; calling it leaves force-activations that `checkWorldInfo` then
 * consumes and clears.
 *
 * Emits the union of both sets with content, so a turn can be graded once and scored twice.
 */
/**
 * What ST core selects for this turn, with WA standing down for the call.
 *
 * `checkWorldInfo` is core's whole selection — inclusion groups, probability, timed effects, its own
 * budget — so nothing here models it. Two things must be undone for the call and are restored after:
 * the `ignoreBudget` takeover WA applies in `onEntriesLoaded`, and re-entry via WORLDINFO_SCAN_DONE,
 * which `inCoreProbe` suppresses.
 *
 * @returns {Promise<{entries: object[], viaVectors: boolean, vectorsRan: boolean}>}
 */
async function coreSelection() {
    const chat = (runState.scanChat ?? getContext().chat ?? []).filter(x => x && !x.is_system);
    const entries = await getSortedEntries();
    let core;
    const viaVectors = Boolean(extension_settings.vectors?.enabled_world_info);
    let vectorsRan = false;
    runState.inCoreProbe = true;
    try {
        for (const e of entries) if (e.waIgnoreBudget !== undefined) e.ignoreBudget = e.waIgnoreBudget;
        // A copy: an interceptor may rearrange what it is handed, and this is not the real prompt.
        if (viaVectors && typeof globalThis.vectors_rearrangeChat === 'function') {
            try { await globalThis.vectors_rearrangeChat([...chat], getMaxPromptTokens(), null, 'normal'); vectorsRan = true; }
            catch (error) { console.warn('Worlds Apart: Vector Storage declined the probe, core will answer on keywords alone —', error); }
        }
        // ST'S HAYSTACK SHAPE, NOT THE INTERCEPTOR'S. `vectors_rearrangeChat` above is a generate
        // interceptor and reads message objects; `checkWorldInfo` takes `chatForWI` — the same strings
        // core builds at script.js's scan site, most-recent-first — and calls .trim() on them. Sources
        // ride along so the probe scans what WA's own dry run scans rather than core's empty default.
        const chatForWI = chat.map(x => (world_info_include_names ? `${x.name}: ${x.mes}` : x.mes)).reverse();
        core = await checkWorldInfo(chatForWI, getMaxPromptTokens(), true, { ...scanSources(), trigger: 'normal' });
    } finally {
        for (const e of entries) if (e.waIgnoreBudget !== undefined) e.ignoreBudget = true;
        runState.inCoreProbe = false;
    }
    return { entries: [...(core?.allActivatedEntries ?? [])], viaVectors, vectorsRan };
}

async function versusCore(named) {
    // RUNS THE DEBUG PIPELINE ITSELF, as /wa-grade does, so the rows this freezes are the selection that
    // actually happened rather than whatever a previous command left behind. `candidates` bounds the
    // captured population the same way and for the same reason; shipped rows are never dropped by it
    // (see the gradeDepth filter in rankActivated), so the comparison itself cannot be truncated.
    const wanted = Math.max(1, Number(named?.candidates ?? 30));
    runState.gradeCutoff = { maxVectorEntries: wanted };
    try {
        await dryRun(true);
    } finally {
        runState.gradeCutoff = null;
    }

    const population = runState.lastRanked;
    if (!runState.lastCandidates?.length || !population?.length) { toastr.info('Nothing ranked \u2014 the scan activated no entries.', 'Worlds Apart'); return; }

    const { entries: coreEntries, viaVectors, vectorsRan } = await coreSelection();

    const keyOf = e => `${e.world}.${e.uid}`;
    const coreKeys = new Set(coreEntries.map(keyOf));
    const waKeys = new Set((runState.lastLayout ?? []).map(x => keyOf(x.item.entry)));
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
    console.log(`  WA:   ${waKeys.size} entries, ${spend(waKeys)} tokens (budget ${effectiveTokenBudget()})`);
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
        waBudget: effectiveTokenBudget(), coreBudgetPercent: Number(world_info_budget) || 25,
        vectorRouteEnabled: Boolean(viaVectors),
        // THE SCENE, or none of this is gradeable. A judge scores an entry AGAINST something, and
        // rows plus content is only half of that pair. Same field names as the /wa-grade capture so
        // an offline reader treats the two the same way.
        query: runState.lastQuery,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        sources: runState.lastSources,
        depth: settings().messageDepth,
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

    const primaryBook = searchedBook(waRows) ?? chatBook() ?? Object.keys(books)[0] ?? '';
    const common = {
        query: runState.lastQuery,
        queryChat: runState.lastQueryChat,
        scanChat: runState.lastScanChat,
        injects: runState.lastInjects,
        sources: matcher.usedMatchSources(runState.lastSources, Object.values(books).flatMap(b => Object.values(b))),
        depth: settings().messageDepth,
        pluginFP: runState.pluginFP,
        sourceFP: runState.sourceFP,
        waVersion: await waVersion(),
        stVersion: await stVersion(),
        chat: chatFilePath(),
        book: primaryBook ? `data/default-user/worlds/${primaryBook}.json` : '',
        index: primaryBook ? vectorIndexPath(primaryBook) : '',
        primaryBook,
        embedModel: vectorRequestBody().model || '',
        snapshot: paramSnapshot(),
        books,
        priority: (scopedPriority() ?? []).map(x => x.cfg),
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

async function rankActivated(args) {
    const activated = args?.activated?.entries;

    // Silent returns, EXCEPT under /wa-dry: every one of them leaves lastLayout untouched, so the
    // user's own dry run reports "nothing activated" with no way to tell a real empty selection from
    // a scan WA declined to rank. `enabled` is not among them — dryRun refuses outright when WA is
    // off, so that branch cannot be reached from a dry run at all.
    const skip = reason => { if (runState.dryRunInProgress) console.warn(`Worlds Apart: did not rank this scan — ${reason}.`); };

    if (!(activated instanceof Map)) {
        skip('the scan carried no activation map');
        return;
    }
    if (runState.inCoreProbe) return;   // core is answering for /wa-versus; ranking it would re-enter
    if (!settings().enabled) {
        // WA off is the honest stand-down: core did everything, including its own budget, with every
        // interceptor live. This is the comparison baseline `/wa-core` exists to capture.
        recordCoreSet(activated, args, 'WA disabled — core in full, interceptors live');
        return;
    }
    // ST's dry-run generations (PromptManager token counts after every received message,
    // chat load) skip generate interceptors, so retrieval never ran and the scan holds
    // keyword activations only. Ranking it would overwrite the panel and the /wa-dry//wa-grade
    // state with that keyword-only selection — leave the last real scan's state alone.
    if (runState.generationIsDryRun) {
        skip('it is an ST dry generation');
        // CORE'S OWN ANSWER, FREE, ON EVERY GENERATION. A dry run is the one path where WA stands down
        // completely: interceptors are skipped so retrieval never force-activates, `onEntriesLoaded`
        // gates its budget takeover on the same flag so core's own budget walk runs, and this returns
        // before anything is deleted. `WORLDINFO_SCAN_DONE` fires AFTER core's budget loop
        // (world-info.js), so the map is core's SHIPPED set rather than what it nominated.
        //
        // KEYWORD ROUTE ONLY, and that is the whole of core for a default install: Vector Storage
        // activates World Info from inside `vectors_rearrangeChat`, a generate_interceptor, which a dry
        // run skips — and `enabled_world_info` is false out of the box regardless. A vectors-enabled
        // baseline needs a real generation with WA told to stand down; this is not that.
        //
        // RECORDED, NEVER ACTED ON. Ranking it would overwrite the panel and the /wa-dry state with a
        // keyword-only selection; the last real scan's state is left alone.
        recordCoreSet(activated, args, 'ST dry run — keyword route only, interceptors skipped');
        return;
    }

    // Feed the scan loop BEFORE the size-0 return — a pass that activated nothing can
    // still be followed by a min-activations widening WA has to answer.
    if (runState.waOwnsScan && Array.isArray(runState.waCandidates)) {
        await feedScanLoop(args);
    }

    if (activated.size === 0) {
        skip('core activated nothing');
        runState.lastLayout = [];
        if (!args?.state?.next) renderWiPanel([]);
        return;
    }

    // The text signal comes from content-lexical, which covers every entry rather than only the ones in
    // the vector collection. It is now the ONLY source: the plugin's BM25 was the fallback, and stage 1
    // stopped computing it (plugin/scoring.mjs), so the fallback was reading an absent field and would
    // have supplied 0 while looking like a safety net. An empty index means no entry has content, and
    // there is nothing for either source to score.
    const contentText = await contentTextScores(runState.lastQuery);

    // ENTRIES THAT HAVE NOT BEEN WRITTEN YET, at this point in the chat. Inert at the latest turn and
    // load-bearing on a branch: the book still holds every summary written later, so without this WA
    // ranks descriptions of events the character has not lived through. Applied HERE because
    // `rankActivated` owns what survives into the prompt — it deletes the rest from core's `activated`
    // map — so one filter covers both the retrieval route and the keyword one.
    const at = settings().dropUnavailable ? (getContext().chat?.length ?? NaN) : NaN;
    let postDated = 0;
    for (const [key, entry] of [...activated.entries()]) {
        if (postDates(entry, at)) { activated.delete(key); postDated++; }
    }
    if (postDated) {
        console.log(`Worlds Apart: hid ${postDated} entr(ies) summarising messages after this point in the chat (dropUnavailable)`);
    }

    const items = [...activated.entries()].map(([key, entry]) => {
        // We overwrite `order` below, and this fires once per scan loop — stash the
        // authored value on first sight so later loops don't sort by our own output.
        entry.waOriginalOrder ??= entry.order ?? 0;
        return {
            key,
            entry,
            score: runState.lastScores.get(key),
            textScore: contentText.get(key) ?? 0,
            // Eligible means COULD have scored, not did: every entry carrying content.
            textEligible: Boolean(String(entry.content ?? '').trim()),
        };
    });

    // Books contributing entries to this scan — the priority sorts below rank only among
    // these, and this registers any unseen one so its config can be set. Doubles as the
    // attached set for the ordering path (independent of the async UI-scoping refresh).
    const scanWorlds = new Set(items.map(it => it.entry.world));
    ensureWorldConfigs(scanWorlds);

    // THE SCAN WINDOW IS SHARED AND UNCONDITIONAL. It used to be built only for keyword scoring; the
    // relevance column needs the SAME window, because that is what the model was fitted against
    // (`eval/scene.mjs` `haystackFor` builds it with this builder and these inputs), and a second
    // window here would be a second definition of what WA searched.
    let windowFor = null;
    {
        // The stash from intercept IS core's transformed scan haystack — regex scripts
        // applied, file content and titles appended, reasoning merged — so WA matches the
        // text core matched. Raw context chat is the fallback only for a scan no WA entry
        // point saw. Core removes hidden/system messages before it scans, then counts depth
        // over what remains; WA filters them too — otherwise a hidden message in the recent
        // window costs WA a slot core didn't spend, so WA scans less real history and misses
        // a keyword core matched one message further back.
        const chat = (runState.scanChat ?? getContext().chat ?? []).filter(x => x && !x.is_system);
        const sources = scanSources();
        // Collected once and reused across depths. WHICH of them a given depth scans is makeWindowFor's
        // call: an inject placed in the chat is bounded by the window, an ambient one is not
        // (`upstream-st.md` #16). Core appends all of them to every window regardless.
        const injects = await scanInjects();
        // Stashed for the capture. The frozen haystack is the CHAT half alone (`windowFor.windows` is
        // chat-only); the injects ride beside it as their own list, so a reader RECONSTRUCTS the window
        // at any depth by admitting them, instead of trying to pick them back out of a joined blob. It
        // also stops the same inject text being written once per depth.
        runState.lastInjects = injects;
        // Beside them, and RAW: which of the six a capture keeps depends on the books it attaches, so the
        // gate (matcher.usedMatchSources) runs where those are in scope rather than here.
        runState.lastSources = sources;
        windowFor = matcher.makeWindowFor(chat, {
            injects,
            sources,
            matchWindow: settings().matchWindow,
            includeNames: world_info_include_names,
        });
        if (settings().keywordScoring) {

            // The keys an activated entry is scored on: live keys, else the takeover's stash — blanking was
            // an activation mechanism, not a scoring opinion.
            //
            // EVERY ENTRY'S KEYS ARE SCORED, including a vectorized one's. The value is MEASURED here and
            // RECORDED in the capture; whether anything acts on it is the model's business, and the shipped
            // fit does not carry the column (matcher-design.md, *Scoring memory's keys*). A setting that
            // suppressed the measurement made the column null in every bundle it was off for, which is the
            // one thing that cannot be recovered later — and left every contributed bundle ambiguous about
            // whether a blank meant "no keys fired" or "nobody looked".
            const scoreKeysOf = entry => (entry.key?.length ? entry.key : (entry.waKeys ?? []));
            // Same restoration for the secondary gate: a blanked entry's secondaries live in
            // waSecondary, and the per-segment gate must judge the condition the author wrote, not an
            // empty one. A local view, never a write-back — restoring keys on core's scan copies
            // mid-scan would hand core's next loop the keys the takeover blanked.
            const scoringView = entry => (!entry.keysecondary?.length && entry.waSecondary?.length)
                ? { ...entry, keysecondary: entry.waSecondary }
                : entry;

            // Register every key this pass will score BEFORE the loop, so the smartkeys automaton is
            // built once — a first-seen key mid-loop would rebuild it and throw away every cached scan.
            // Secondaries too, off the restored view keywordScore will actually gate against, and only for
            // entries whose keys are scored at all: keywordScore returns on an empty key list before it
            // primes anything.
            registerKeys(items.flatMap(it => {
                const keys = scoreKeysOf(it.entry);
                return keys.length ? [...keys, ...matcher.secondaryKeys(scoringView(it.entry))] : [];
            }));

            for (const item of items) {
                // Score keywords over the shared message depth. Per-entry scanDepth still wins
                // (as in core), so an entry that declares its own window is honoured; otherwise
                // the unified messageDepth, falling back to core's scan depth only if it's unset.
                // Nullish on scanDepth: 0 is core's authored "match nothing from chat" (the entry
                // lives on injects/sources), not an unset value to fall through.
                const depth = Number(item.entry.scanDepth ?? (settings().messageDepth || world_info_depth));
                // ONE window builder, not a second copy of it. This open-coded its own memo + inject push +
                // withMatchSources, which is exactly makeWindowFor — and a second copy is where the depth
                // bound would have been applied on one path and not the other.
                const scanText = windowFor(depth, item.entry);
                const scoreKeys = scoreKeysOf(item.entry);
                const scored = keywordScore(scoringView(item.entry), scanText, scoreKeys);
                item.keywordScore = scored.score;
                item.keywordHits = scored.hits;
                // Debug-class runs only: WHERE each key matched, for /wa-grade's "why did this pop"
                // column. Flags mirror the keywordScore call above exactly — same entry overrides,
                // same defaults — so the excerpt localises the match that was actually scored.
                item.keywordWhy = runState.verboseRun
                    ? scored.hits.slice(0, 4).map(h => {
                        // Every place it landed, not just the first. One excerpt cannot tell a key firing
                        // thirteen times on one phrase from one firing across thirteen scenes, and that is
                        // the judgement being made. `excerpt` is contexts[0] rather than a second call, so
                        // the displayed line and the hover can never disagree.
                        const contexts = matcher.keyExcerpts(h.key, scanText, item.entry.caseSensitive, item.entry.matchWholeWords);
                        return { key: h.key, count: h.count, score: h.score, excerpt: contexts[0] ?? null, contexts };
                    })
                    : undefined;
                // Declared for fuseRanks' eligibility normalisation: having keys to score is the chance to
                // earn the keyword rank, and an entry with none must not be divided by a weight it could
                // never have collected. Resolved here because this is where the scan has already
                // decided what `scoreKeys` is.
                item.keysEligible = scoreKeys.length > 0;
            }
        }

        // The scan text WA actually searched, so a "WA scored 0" mystery is answered by
        // looking: if the key isn't in here but core matched it, core scanned something
        // WA doesn't mirror (recursed entry content, an extension's inject buffer) or
        // another extension force-activated the entry. Regex scripts and attached files
        // are no longer on that list — the stash carries them.
        // The global-depth window, for /wa-grade's sample (per-entry scanDepth overrides also live here).
        // Joined with a BLANK line, not a single one, so the capture round-trips: re-segmenting this
        // string recovers the same units the scan actually used, at any setting.
        // THE MESSAGES, NOT THE WINDOW. A joined haystack is fixed at one depth, one matchWindow and one
        // includeNames — narrowing it is impossible and re-deriving it needs the chat file. These are the
        // scan-eligible messages as core transformed them (regex applied, attachments folded in), which
        // no other source has, so a reader rebuilds any window from them: `scanWindow(scanChat, {depth})`.
        runState.lastScanChat = chat.slice(-Math.max(1, settings().messageDepth))
            .map(x => ({ name: String(x?.name ?? ''), mes: String(x?.mes ?? '') }));

        if (runState.verboseRun) {
            console.log('%cWorlds Apart · keyword scan windows — the exact text WA searched, by depth', 'font-weight: bold');
            console.log(Object.fromEntries([...windowFor.windows]));
        }
    }

    // STAGE 4'S QUANTITY, COMPUTED EVERY SCAN. Not a setting: `E[credit]` is what stage 4 selects and
    // orders on, so a switch would mean carrying two orderings for the dynamic block forever. The fusion
    // it replaced is gone rather than defaulted off — `rrfK`, `lexicalWeight`, `keywordWeight` and
    // `weightByOrder` no longer exist as settings.
    await scoreRelevanceColumn(items, windowFor);

    // THE LAYOUT SCORE IS E[credit], the quantity stage 4 selects on. Ordering the dynamic block by
    // anything else would break the prefix property applyBudget assumes: a set chosen by E[credit] but
    // ordered by a different combination of the same signals lets the budget drop a high-E[credit] entry
    // because that other combination ranked it low.
    //
    // An unscored row sorts BELOW every scored one rather than beside them at 0 — a missing score means
    // the model file did not load or the row is not in a fitted tier, which is not the same claim as
    // "predicted irrelevant", and authored order is what remains to order them by.
    const layoutScore = it => (Number.isFinite(it.eCredit) ? it.eCredit : -1);

    // Budget walk order — NOT prompt order. Stickies and constants are always-on by
    // authorial intent, so they go first and the budget can only ever cut into the
    // retrieved block, weakest match first. Classification is by what an entry IS: a
    // constant that also matched keywords is a durable row, not a retrieval result.
    const sticky = [];
    const constant = [];
    let results = [];

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
        orderKey === 'best-first' ? (a, b) => (layoutScore(b) - layoutScore(a)) || authored(a, b) :
        orderKey === 'best-last'  ? (a, b) => (layoutScore(a) - layoutScore(b)) || authored(a, b) :
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
        results.sort((a, b) => (rankOf(a.entry.world) - rankOf(b.entry.world)) || (layoutScore(b) - layoutScore(a)) || authored(a, b));
    } else {
        // Interleaved: per-book weight scales fused (weight 1 = plain relevance ranking).
        results.sort((a, b) => (layoutScore(b) * cfgOf(b.entry.world).weight - layoutScore(a) * cfgOf(a.entry.world).weight) || authored(a, b));
    }
    sticky.sort(authored);
    constant.sort(authored);

    // Stashed BEFORE the cuts, so a debug or grading capture holds a row for every entry this pass
    // judged rather than only the survivors — `cut`/`cutBy` below record which side each fell on, and
    // an offline harness can replay any budget setting against the whole population.
    // Survivors and losers can't be re-interleaved afterwards: concatenating them loses the rank order
    // the cuts were prefixes of.
    runState.lastRanked = [...sticky, ...constant, ...results];

    // THE RELEVANCE CUT, before the walk and before the caps. It is the only decision here that asks
    // WHETHER an entry belongs; everything after it asks how many and how much. `lastRanked` above kept
    // the whole pre-cut population, so a row dropped here is still captured and gradeable — a harness
    // that only saw survivors could never score the decision that produced them.
    //
    // Per tier, at the cutoff its own fit was chosen at. A row in no fitted tier, or one the model
    // could not score, is kept: that is an absent verdict, not a negative one.
    // MEMORY ONLY, because a key on a REFERENCE entry is the authorial decision. Reference rows are
    // scored — the column orders them for the budget walk — and never cut: an author writing keys on a
    // world-rules entry is declaring when it should be present, so every reference entry that fires is
    // included and answers only to the budget cap. Measured, the fit agrees rather than deciding it: at
    // its own 0.17 the cut drops 35.3% of Foxbridge's relevant rows and 3 of its 10 grade-4s against
    // 1.0% on Sommers, Foxbridge being the only reference-ONLY book in the corpus.
    const cutoffs = relevanceModel.value ?? {};
    const { cut: relevanceCutRows } = selection.relevanceCut(results, {
        scoreOf: it => it.eCredit,
        cutoffOf: it => (isMemory(it.entry) ? cutoffs.memory?.cutoff ?? NaN : NaN),
    });
    const cutByRelevance = new Set(relevanceCutRows);
    results = results.filter(it => !cutByRelevance.has(it));
    if (relevanceCutRows.length) {
        console.log(`Worlds Apart: relevance cut dropped ${relevanceCutRows.length} of ${relevanceCutRows.length + results.length} dynamic entries`);
    }

    // Constants and stickies lead, which is what makes every cap below a prefix cut.
    let ranked = selection.walkOrder({ sticky, constant, results });

    const maxTokens = effectiveTokenBudget();
    const maxTotal = settings().maxTotalEntries;
    const maxDynamic = settings().maxDynamicEntries;
    const maxVectorEntries = settings().maxVectorEntries;
    const bookCaps = new Map(priorityList.filter(w => w.cap > 0).map(w => [resolvedName(w), w.cap]).filter(([n]) => n));

    if (maxTokens > 0 || maxTotal > 0 || maxDynamic > 0 || maxVectorEntries > 0 || bookCaps.size) {
        const dynamicSet = new Set(results);
        const { survivors, counted, skipped, dropped, budgeted, inPrompt } = await selection.applyBudget({
            ranked,
            isDynamic: item => dynamicSet.has(item),
            // THE TAG, not retrieval provenance. maxVectorEntries exists so that at most N vector
            // entries are added to the layout during the walk, which is a question about what an entry
            // IS — and that is what the flag records. It read runState.lastScores before: a stage-1
            // framing ("how much did retrieval contribute") carried onto a stage-4 cap, from when
            // maxVectorEntries WAS the count retrieval cut to. Since stage 1 stopped cutting, the two
            // differ only for a vectorized entry that keyword-activated without being admitted — the
            // wrong-book gate's residue — which is not worth an answer living in per-generation mutable
            // state instead of on the entry.
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

        for (const item of ranked) {
            if (!survivors.has(item)) {
                activated.delete(item.key);
            }
        }

        if (dropped) {
            const caps = [
                // Nested innermost first — vector ⊆ dynamic ⊆ total — so the line reads in the order the
                // caps bind. Recounted from the survivors on the same terms applyBudget counted them:
                // by provenance, and exempt entries are outside the population the caps bound.
                maxVectorEntries > 0 ? `vector ${results.filter(x => survivors.has(x) && runState.lastScores.has(x.key) && !selection.authorIgnoreBudget(x.entry)).length}/${maxVectorEntries}` : null,
                maxDynamic > 0 ? `dynamic ${results.filter(x => survivors.has(x) && !selection.authorIgnoreBudget(x.entry)).length}/${maxDynamic}` : null,
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
    // Built whenever a debug-class run is in flight, and stashed: /wa-grade grades THESE rows rather than
    // recomputing a ranking, so the grades attach to the selection that actually happened.
    if (runState.verboseRun) {
        // The PRE-CLIFF, PRE-BUDGET population (see lastRanked): every entry that shipped, plus — down to
        // the grading depth below — the ones this pass rejected, with `cut`/`cutBy` recording which side
        // each fell on. `ranked` is survivors only by this point.
        //
        // /wa-grade's candidates=N caps the DYNAMIC rows and nothing else. It is a grading-budget
        // decision rather than a selection one: the grading popup LISTS sticky and constant rows but
        // does not grade them, so capping the whole walk order would spend slots on rows nobody judges
        // and N would mean a different depth on every book.
        //
        // WHAT IT BOUNDS IS THE EXTRA, and it never drops a row that shipped. applyBudget SKIPS rather
        // than stops (selection.mjs), so a short entry below rank N still reaches the prompt when the
        // larger ones ahead of it did not fit — and a shipped row with no capture row is invisible to
        // grading and to every offline replay of the scene, with nothing downstream able to notice.
        const kept = new Set(ranked);
        let dynamicSeen = 0;
        const gradeDepth = runState.gradeCutoff?.maxVectorEntries ?? 0;
        const population = (runState.lastRanked ?? ranked)
            .filter(x => !gradeDepth || (blockOf.get(x) ?? 'dynamic') !== 'dynamic' || ++dynamicSeen <= gradeDepth || kept.has(x));
        // WHY a row was cut, not just that it was. applyBudget already computes this per skipped entry
        // (`blockedBy`) and it is the difference between "ranked too low" and "would not fit" — a large
        // entry is SKIPPED so smaller ones behind it still get in (selection.mjs), so a cut row is not
        // evidence that everything below it was cut too.
        const blockedOf = new Map(
            (runState.lastSkipped ?? []).map(s => [s.item ?? s, (s.blockedBy ?? []).map(b => b.cap).join('+')]),
        );
        // TOKENS PER ENTRY, counted here rather than reused from applyBudget's tokensOf — that one
        // short-circuits to 0 when maxTokens is 0, so reusing it would silently record zeros for anyone
        // running with the budget off. Content only, matching applyBudget's own accounting; the assembled
        // prompt is larger. With these on the row, an offline harness replays the cut at ANY budget instead
        // of inheriting the one that happened to be set at capture. getTokenizerModel() rides in the
        // paramSnapshot, since the counts mean nothing without knowing which tokenizer produced them.
        const tokens = await Promise.all(population.map(x => getTokenCountAsync(x.entry.content ?? '')));
        const rows = population.map((x, i) => ({
            // Columns lead like the selected table — title, then block, sticky, score, uid,
            // wiOrder — then the per-signal scores under the same names (cosine, text, keys), each
            // with its rank. `block` is the RUNTIME budget class (constant / sticky-active /
            // dynamic); `sticky` is the entry's CONFIGURED sticky value (0 = off). The two differ:
            // an entry with sticky configured still shows block `dynamic` on the turn it keyword-
            // activates, and dry runs (/wa-debug) never arm the effect at all — so the eval side reads
            // DURABLE off constant-or-`sticky`, not off the runtime block, which it can't observe.
            // Numeric fields stay numeric so the copied JSON is computable: `null` for "no
            // signal", rounded (not toFixed strings) for a readable grid, and `sticky` is the count
            // itself (0 = off). Only `block` is categorical.
            //
            // `?? null` RATHER THAN A TRUTHINESS TEST, because a scored 0 is not an absent signal: the
            // old `x.fused ? … : null` wrote both as null, so every sample on disk reports a constant
            // that fused to 0 identically to one that was never eligible to be fused at all.
            title: x.entry.comment,
            block: blockOf.get(x) ?? 'dynamic',
            sticky: x.entry.sticky || 0,
            score: Number.isFinite(x.eCredit) ? Number(x.eCredit.toFixed(5)) : null,
            uid: x.entry.uid,
            wiOrder: x.entry.waOriginalOrder,
            cosine: x.score !== undefined ? Number(x.score.toFixed(5)) : null,
            // The two signals the model reads that nothing else computes, and the number it produces.
            // `score` above IS eCredit — this repeats it only where a reader is comparing signals.
            pn: Number.isFinite(x.properNouns) ? Number(x.properNouns.toFixed(3)) : null,
            dens: Number.isFinite(x.density) ? Number(x.density.toFixed(2)) : null,
            // BM25 over chunk text. Gated on the same condition as cosine, because both come from the
            // retrieval path: an entry with no chunks in the collection has no text score to report, and
            // the scorer returning 0 for it is a default, not a measurement.
            text: x.score !== undefined && Number.isFinite(x.textScore) ? Number(x.textScore.toFixed(2)) : null,
            // BM25 over entry keys, gated on ELIGIBILITY (set at the scan, ~line 1608) rather than on the
            // value. keywordScore is 0 both when an eligible key missed and when the entry had no
            // scorable keys at all — and only the first is a measurement. Reading the
            // value alone reported 32 confident zeros on a capture where those entries had no keys to
            // score, which also silently defeats unionArms' absent-signal fill.
            keys: x.keysEligible === false ? null : (Number.isFinite(x.keywordScore) ? Number(x.keywordScore.toFixed(2)) : null),
            tokens: tokens[i],
            cut: !kept.has(x),
            // Which cap rejected it — 'tokens' means it did not FIT, which is a different fact from
            // ranking too low and is the one a grader can act on (raise the budget, or trim the entry).
            cutBy: blockedOf.get(x) || null,
            // Layout position. `index`, not `#`: the row and the bundle candidate it becomes are the same
            // thing seen twice, and one name for it is what keeps either greppable.
            index: i,
        }));

        // uid alone is ambiguous across books, so carry the book for the grader and the eval. THE ONE
        // PLACE `entry.world` IS READ — that is ST's field on an ST entry (core sets it as `entry.world =
        // file`), and past this line WA calls it `book`, in a row, in a key and in the schema.
        // `why` rides here rather than in `rows` so console.table stays scannable.
        runState.lastCandidates = rows.map((row, i) => ({ ...row, book: population[i].entry.world, why: population[i].keywordWhy }));
        runState.lastCandidateEntries = population.map(x => x.entry);

        console.log('%cWorlds Apart · selection candidates — every activated entry, its signals and what cut it. `score` is E[credit]; a cut row with no cap named lost the relevance cut', 'font-weight: bold');
        console.table(rows);
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
    // is_system FIRST, because production never sees those messages and a dry run that does is not a dry
    // run of production. ST filters them out of `coreChat` before any interceptor is called
    // (script.js: `chat.filter(x => !x.is_system || ...)`), so `intercept` is handed a chat that already
    // lacks them; reading context.chat raw here put hidden turns into the query and the scan window.
    //
    // It matters most exactly where it is least visible. STMemoryBooks can hide a turn once it has been
    // swept into a memory entry, so a well-developed chat is the one most likely to be mostly hidden —
    // 68% on the chat that surfaced this — and every /wa-grade capture from it described a scene no
    // generation could produce.
    const rawChat = context.chat ?? [];
    const chat = rawChat.filter(x => x && !x.is_system);

    // `intercept` gates on this and dryRun calls selectAndActivate directly, so this is the only gate
    // on that path. Without it a dry run with WA off half-runs: retrieval force-activates its winners
    // into core's map, and onEntriesLoaded and rankActivated then decline to touch a scan WA does not own.
    if (!settings().enabled) {
        toastr.warning('Worlds Apart is disabled — turn it on to run a dry run.', 'Worlds Apart');
        return '';
    }

    if (!chat.length) {
        toastr.warning(rawChat.length ? 'Every message in this chat is hidden.' : 'No chat to scan.', 'Worlds Apart');
        return '';
    }

    console.log(`%cWorlds Apart: ${verbose ? 'debug run' : 'dry run'}`, 'font-weight: bold', paramSnapshot());

    runState.verboseRun = Boolean(verbose);
    runState.dryRunInProgress = true;
    // THIS SCAN IS NOT ST'S. The flag means "the scan now running belongs to an ST dry generation",
    // and /wa-dry drives its own, so a value left over from one is wrong here. Nothing clears it
    // otherwise: GENERATION_ENDED comes from hideStopButton, which a dry Generate never reaches.
    runState.generationIsDryRun = false;

    // Cleared so a scan that activates nothing reports nothing, rather than last run's. The /wa-grade
    // capture is in here too: a stale candidate list would be graded as if it belonged to this scene,
    // and its `if (!rows.length)` guard cannot see the difference.
    runState.lastLayout = [];
    runState.lastDropped = [];
    runState.lastSkipped = [];
    runState.lastCandidates = [];
    runState.lastCandidateEntries = [];
    runState.lastQuery = '';
    runState.lastScanChat = [];
    runState.lastQueryChat = [];

    const chatForWI = chat
        .map(x => (world_info_include_names ? `${x.name}: ${x.mes}` : x.mes))
        .reverse();

    // Print in pipeline order: retrieval → activation ranking → final selection.
    // Stage 1 — vector candidates — is printed by retrieve() below, from the ranking it actually selected
    // on. This used to re-run scoring through the /wa-query probe, which scored WITHOUT the entity filter
    // and so could report a different cutoff than the one that ran; a debug view has to reuse production's
    // result, not re-derive one. /wa-query keeps the probe for scoring arbitrary text.
    // retrieve() is inside the try: it hits the network (plugin, Ollama), and a throw outside the finally
    // would leave verboseRun/dryRunInProgress stuck true for every later live generation.
    try {
        await selectAndActivate(chat);

        // Stage 2 — the scan; rankActivated prints the selection candidates (verbose) as it runs.
        await getWorldInfoPrompt(chatForWI, getMaxPromptTokens(), true, { ...scanSources(), trigger: 'normal' });

        // Stage 3 — selection: what survived caps and layout.
        await reportLayout(verbose);
    } finally {
        runState.verboseRun = false;
        runState.dryRunInProgress = false;
        // An exception between selectAndActivate and the scan's last loop would otherwise leave
        // the takeover flag armed for the next unrelated getSortedEntries.
        runState.waOwnsScan = false;
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
    // EVERY SETTING, NEVER A CURATED VIEW. This was a hand-maintained grouping plus a `nonDefaults`
    // diff, and a hand-maintained allowlist silently omits whatever was added last — a newly added
    // setting shipped missing from it, and `nonDefaults` could not cover for that, since it names a
    // setting only when it DIFFERS from default, so an off run was indistinguishable from a capture
    // taken before the setting existed. A complete dump cannot drift, and it makes the diff unnecessary
    // rather than merely easier: the defaults are in the source next to the values.
    //
    // DECLARATION ORDER, not sorted — defaultSettings is already written in rough pipeline order, so
    // that grouping comes free and alphabetising would throw it away.
    //
    // It includes `raterId` and `summaryPrompt`, so a snapshot pasted somewhere public carries them.
    const snap = {
        // A STRUCTURED SETTING IS STORAGE, NOT A KNOB, and is left out. `worldPriorityByChar` holds one
        // priority list per CHARACTER OR GROUP (`priorityKey`), every book any of them has ever seen, so
        // dumping it printed the priority order of every book of every character on a debug run for one
        // chat. Nothing computes it — it is persisted and was being echoed. A rule rather than a named
        // exception: anything whose DEFAULT is structured is storage by that fact.
        //
        // Nothing is lost, which is why it is dropped rather than summarised: `derived.attached`
        // below is this character's list filtered to the books actually attached, and that is the only
        // part of it that describes this run.
        settings: Object.fromEntries(Object.keys(defaultSettings)
            .filter(k => defaultSettings[k] === null || typeof defaultSettings[k] !== 'object')
            .map(k => [k, s[k]])),
        // The values with NO single backing setting, which is the only reason anything but the dump
        // above survives here. `maxTokens` is a percentage resolved against a live context size,
        // `tokenizer` is what the per-row `tokens` counts were produced by — without it those counts are
        // unreadable, since a sample re-simulated after a model switch reports a budget that never
        // existed — `insertionOrder` is a label over `presentationOrder`, and `attached` is scoped to
        // the books this chat actually has.
        derived: {
            maxTokens: tokenBudgetLabel(),
            // THE CEILING AS A NUMBER, because `maxTokens` above is a label for a human ("40%* = 29036")
            // and an offline harness replaying the budget walk needs the value. It belongs here by this
            // block's own rule: a percentage resolved against a live context size has no single backing
            // setting, so the dump above cannot carry it.
            //
            // The entry maxes are NOT repeated here — maxTotalEntries, maxDynamicEntries and
            // maxVectorEntries are scalars and are already in that dump — and the per-book caps ride in
            // `priority`, whose `cap` field is what applyBudget's capOf reads. Recording either twice
            // would let the two disagree.
            maxTokensEffective: effectiveTokenBudget(),
            tokenizer: getTokenizerModel(),
            insertionOrder: presentationBaseLabel(s.presentationOrder),
            attached,
            // WHICH FIT the eCredit column came out of, present only when the column exists. Same
            // argument as `tokenizer` right above it: a refit moves every value, so a capture that
            // names no fit cannot be compared across one. `null` distinguishes a third state — the
            // setting is on and the model file did not load — from the column being off entirely.
            relevanceModel: Object.fromEntries(Object.entries(relevanceModel.value ?? {})
                .map(([tier, m]) => [tier, m
                    ? { features: m.features, cutoff: m.cutoff, heldOutAuc: m.heldOutAuc, fittedOn: m.fittedOn }
                    : null])),
            // The profile NAME and endpoint behind `llmProfile`, which stores an id.
            ...(s.queryMode === 'summary' ? { summaryProfile: (() => {
                const profile = (extension_settings.connectionManager?.profiles ?? []).find(x => x.id === s.llmProfile);
                return { name: profile ? profile.name : 'current API', endpoint: profile ? (profile['api-url'] || profile.api || '—') : '—' };
            })() } : {}),
        },
    };

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

    // THE SIGNALS, NOT THEIR RANKS. There are no per-signal ranks any more: fusing them into a layout
    // position was RRF's job, and E[credit] reads the signals directly. So this names what the entry had
    // to say and what the model made of it, which is the same question the ranks were standing in for.
    const parts = [
        Number.isFinite(item.eCredit) ? `E[credit] ${item.eCredit.toFixed(3)}` : null,
        Number.isFinite(item.score) ? `vec ${item.score.toFixed(3)}` : null,
        item.textScore ? `text ${item.textScore.toFixed(2)}` : null,
        item.keywordScore ? `keys ${item.keywordScore.toFixed(2)}` : null,
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
    // Before the layout, so a scan whose only story is "WA deleted what core matched" still
    // tells it — the runtime must visibly agree with what the audit reports.

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
            score: Number.isFinite(item.eCredit) ? Number(item.eCredit.toFixed(5)) : null,
            uid: entry.uid,
            // wiOrder is the entry's own WI `order` field (what "WI Order" layout sorts
            // by); waOrder is the value WA writes to control the final prompt sequence.
            wiOrder: entry.waOriginalOrder,
            waOrder: entry.order,
            ...(verbose ? {
                cosine: item.score !== undefined ? Number(item.score.toFixed(5)) : null,
                text: item.textScore ? Number(item.textScore.toFixed(2)) : null,
                keys: item.keywordScore ? Number(item.keywordScore.toFixed(2)) : null,
                // The stage-4 relevance column. NULL means the row was not scored rather than scored
                // zero — a reference entry never is, because the shipped fit is memory's, and neither is
                // any row when the model file failed to load. Recorded at full precision — this is the value a
                // harness run is compared against to show the runtime and the fit agree, and rounding it
                // to the display's 2 places would put the comparison inside the rounding.
                properNouns: Number.isFinite(item.properNouns) ? item.properNouns : null,
                density: Number.isFinite(item.density) ? item.density : null,
                eCredit: Number.isFinite(item.eCredit) ? item.eCredit : null,
                // Which keys actually matched, strongest first: "Kyle×3 · pool". Textual by nature.
                hits: item.keywordHits?.length
                    ? item.keywordHits.map(h => (h.count > 1 ? `${h.key}×${h.count}` : h.key)).join(' · ')
                    : null,
            } : {}),
            block,
            why: whySelected(item, block),
            position: POSITION_NAMES[entry.position] ?? `position ${entry.position}`,
            depth: entry.position === 4 ? (entry.depth ?? 4) : null,
            exempt: selection.authorIgnoreBudget(entry),
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
                eCredit: Number.isFinite(item.eCredit) ? Number(item.eCredit.toFixed(5)) : null,
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
                eCredit: Number.isFinite(item.eCredit) ? Number(item.eCredit.toFixed(5)) : null,
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

    // Scores exactly what retrieval scores: stage 1 is cosine over the raw query, with no entity filter to
    // apply or withhold. The `unfiltered` flag this used to take existed so a SUMMARY probe could skip a
    // filter that summarized queries never got; there is no filter here to skip now.
    const { targets, scores } = await scoreEntries(searchText);

    if (!scores.size) {
        console.log(`Worlds Apart: the query scored no chunk for "${searchText.slice(0, 60)}…"`);
        return '';
    }

    reportVectorCandidates(scores, targets, searchText);

    return '';
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
async function gradeScene(named) {


    // Cap the dynamic rows at the depth asked for. Nothing cuts the population for relevance any more, at
    // either stage, so this is purely a grading budget: without it a capture pools the whole admitted set.
    const live = { maxVectorEntries: settings().maxVectorEntries };
    const wanted = Math.max(1, Number(named?.candidates ?? 20));
    runState.gradeCutoff = { maxVectorEntries: wanted };

    let rows = [];
    let entries = [];
    try {
        // The debug run IS the measurement: same retrieval, same ranking — only the cut is widened.
        await dryRun(true);
        rows = runState.lastCandidates ?? [];
        entries = runState.lastCandidateEntries ?? [];
    } finally {
        runState.gradeCutoff = null;
    }

    if (!rows.length) {
        toastr.warning('Nothing was activated — nothing to grade.', 'Worlds Apart');
        return '';
    }

    // retrieve() records the query as soon as it builds one, whatever retrieval then scores — so an
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
    const primaryBook = searchedBook(rows) ?? chatBook() ?? Object.keys(books)[0] ?? '';
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
        waVersion: await waVersion(),
        stVersion: await stVersion(),
        chat: chatFilePath(),
        book: primaryBook ? `data/default-user/worlds/${primaryBook}.json` : '',
        index: primaryBook ? vectorIndexPath(primaryBook) : '',
        primaryBook,
        embedModel: vectorRequestBody().model || '',
        params: captureParams(settings(), {
            caseSensitive: world_info_case_sensitive,
            wholeWords: world_info_match_whole_words,
            includeNames: world_info_include_names,
            allowWIScan: Boolean(extension_settings.note?.allowWIScan),
        }),
        snapshot: paramSnapshot(),
        candidates: rows,
        books,
        priority: (scopedPriority() ?? []).map(x => x.cfg),
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
 * `summary` is not eligible however tempting: state.mjs RESETS queryMode rather than un-surfacing it, so
 * an arm setting it would resurrect a withdrawn feature and pay an LLM call per scene for a mode no user
 * can be in. Bundles captured under it still open by name.
 *
 * ARM COUNT IS NOT A DESIGN CONSTANT. Add an entry here whenever graded-scene-grid.mjs reports a
 * configuration whose top rows are not fully judged; that number is the stopping rule, not this list's
 * length. `arms=` runs a subset when a round only needs to close one gap.
 */
const POOL_ARMS = {
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
 * object threaded through retrieve(), which is a much larger change than this feature justifies.
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
        await dryRun(true);
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
            snapshot: paramSnapshot(),
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
 * TODAY and 20x smaller, which made it the obvious default — until the samples started being things other
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
    // collide the moment the same entry appears against two scenes, and 10 of 19 entries in the set this
    // was built for do exactly that. Section membership rides on the row instead, for the collector.
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
                    // being graded, and they are written straight through to the new sample. That is not
                    // hypothetical: it is how 50 rows of a Time Whore scene ended up on an Ascensus scene
                    // captured 15 minutes later, at their original values. A book test would have missed
                    // the commoner case, two scenes of one book, since those rows name the same books.
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

async function superGradeScene(named) {
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
    const wav = await waVersion();
    const stv = await stVersion();
    const built = [];
    for (const cap of captures) {
        // Per arm, because a lexical-only arm can retrieve from a different book than the hybrid one — and the
        // harness loads exactly one collection, so getting this wrong keys a sample to a collection that
        // contributed nothing.
        const primaryBook = searchedBook(cap.rows) ?? chatBook() ?? Object.keys(books)[0] ?? '';
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
            embedModel: vectorRequestBody().model || '',
            params: cap.params,
            snapshot: cap.snapshot,
            candidates: cap.rows,
            books,
            priority: (scopedPriority() ?? []).map(x => x.cfg),
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
 * ONE SECTION PER BUNDLE, ONE SAVE FILE PER RUN. Grading 15 scenes was 15 imports and would have been 15
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
async function superEvalScene() {
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

            <label for="wa_message_depth">Message depth (recent messages for retrieval + keyword scan)</label>
            <input id="wa_message_depth" type="number" class="text_pole" min="1" max="20" step="1">

            <label for="wa_match_window">Match window (the unit a key has to match within)</label>
            <select id="wa_match_window" class="text_pole">
                <option value="paragraph">Paragraph — terms must land in the same paragraph</option>
                <option value="message">Message — anywhere within one message</option>
                <option value="scan">Whole scan window — what SillyTavern core does</option>
            </select>
            <small class="opacity50p">Only affects keys that combine conditions: secondary keys (AND ANY / NOT ANY / …) and <code>?</code> SmartKeys. A single keyword matches the same text either way. Narrower settings stop an entry firing on terms that were pages apart — and stop a negation five messages back from silently vetoing a match. Core has no equivalent, so anything but "Whole scan window" is a deliberate divergence from what core would have activated.</small>

            <label for="wa_word_boundary">Word boundary (what counts as inside a word)</label>
            <select id="wa_word_boundary" class="text_pole">
                <option value="strict">Strict — hyphens and apostrophes are part of the word</option>
                <option value="permissive">Permissive — only letters and digits are</option>
            </select>
            <small class="opacity50p">Only applies to entries with <b>Match Whole Words</b> ticked. Under Strict, the key <code>Joe</code> does not match <i>Joe's</i> and <code>hot tub</code> does not match <i>hot tub-side</i>; under Permissive both match. Plurals break under either — <code>hot tub</code> never matches <i>hot tubs</i> with the box ticked. A <code>/regex/</code> key using <code>\\b</code> gets Permissive behaviour back for one key without changing the setting. Unlike SillyTavern core, the box also applies to keys with a space in them.</small>

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
                    <b>LLM</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">Which model WA uses for its own generation calls — currently just the ✨ keyword suggester in Lorebook Studio. Nothing here affects your chat. Leave empty to use your current chat model. Either way it is one call per entry, more for long ones — negligible for a single ✨, worth thinking about before a book-wide suggest-all.</small>

                    <label for="wa_llm_profile">Generate with</label>
                    <div class="flex-container alignItemsCenter flexnowrap">
                        <select id="wa_llm_profile" class="text_pole flex1"></select>
                        <div id="wa_refresh_profiles" class="menu_button fa-solid fa-rotate" title="Reload the Connection Manager profile list"></div>
                    </div>

                    <label for="wa_llm_temp">Temperature (blank = backend default; needs a profile)</label>
                    <input id="wa_llm_temp" type="number" class="text_pole" min="0" max="2" step="0.05" placeholder="backend default">
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

                    <label>Mean-centered search (automatic when the server plugin is installed)</label>
                    <div id="wa_plugin_setup" style="margin:0.4em 0;font-size:0.85em;opacity:0.75;"></div>

                    <div id="wa_find_orphans" class="menu_button" style="width:auto;padding:0.3em 0.8em;">Find unused vector collections…</div>
                    <div id="wa_orphans_out" class="opacity50p" style="margin:0.4em 0;font-size:0.85em;"></div>
                    <small class="opacity50p">Nothing removes a vector collection: chunk pruning only runs for a book being synced, so a renamed, deleted or detached book leaves its whole collection on disk, as does switching embedding source or model. This reports what nothing claims — it deletes nothing, because these cost embedding time and a book you have not opened is not garbage.</small>

                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Ranking</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="opacity50p">How the lexical (BM25) and vector signals fuse.</small>




                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Selection &amp; budget</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_max_entries">Vector entry cap — retrieved entries in the prompt</label>
                    <input id="wa_max_entries" type="number" class="text_pole" min="1" max="100" step="1">

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

                    <label class="checkbox_label" for="wa_drop_unavailable">
                        <input id="wa_drop_unavailable" type="checkbox"><span>Hide entries from later in the chat</span>
                    </label>
                    <small class="opacity50p">On a branch back to an earlier point, the book still holds every scene summary written after it. This hides them, so WA cannot surface descriptions of events that have not happened yet. Does nothing at the latest turn — turn it off if you are using an old branch to write a story you have already told.</small>

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
                    <small class="opacity50p">Set once and forget.</small>


                    <label class="checkbox_label" for="wa_debug_log">
                        <input id="wa_debug_log" type="checkbox"><span>Log selection table on every generation</span>
                    </label>

                    <label for="wa_rater_id">Rater id (who your grades are signed as)</label>
                    <input id="wa_rater_id" type="text" class="text_pole" placeholder="generated on your first grade">
                    <small class="opacity50p">A random id, minted once and kept, written onto every grade you
                    type — so that when graded scenes are pooled from several people, two verdicts on the same
                    entry stay two verdicts. Random rather than your name or machine, because a composed
                    identity collides (almost nobody changes <code>default-user</code>) and a hostname is
                    usually a person's name, which would then travel in everything you share.</small>


                    <small class="opacity50p">Reviewing graded bundles needs no chat, but running a slash
                    command does — ST opens a placeholder assistant chat to dispatch one. This launches the
                    same reviewer without touching the chat input.</small>
                    <div id="wa_review_bundles" class="menu_button" style="width:auto;padding:0.3em 0.8em;">Review graded bundles…</div>
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
    const selected = settings().llmProfile;

    $('#wa_llm_profile')
        .empty()
        // Not a neutral fallback: on this path generateText uses generateRaw, which takes no
        // generation parameters, so BOTH the temperature and bypass-preset settings below are
        // ignored and the suggester runs on the chat model as configured. Say so in the option
        // itself — it is the default, and nothing else in the panel would reveal it.
        .append([`<option value="">Current chat API — ignores the settings below</option>`]
            .concat(profiles.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`))
            .join(''));

    // A deleted profile leaves a dangling id: show the fallback rather than a blank
    // select, but don't silently rewrite the setting.
    const stillExists = !selected || profiles.some(x => x.id === selected);
    $('#wa_llm_profile').val(stillExists ? selected : '');

    if (!stillExists) {
        console.warn(`Worlds Apart: saved LLM profile "${selected}" no longer exists, falling back to the current API`);
        toastr.warning('Saved LLM profile no longer exists.', 'Worlds Apart');
    }

    if (notify) {
        toastr.info(`${profiles.length} profile(s) loaded.`, 'Worlds Apart');
    }
}

/**
 * A blank field for a 'number?' setting, and anything that does not parse. Both mean null — "unset, follow
 * whatever this setting defers to" — and NaN in particular must never be stored: it is neither null nor
 * undefined, so it survives every `??` downstream and turns a fused score into NaN silently.
 */
const nullableNumber = (val) => {
    const n = Number(String(val).trim() || NaN);
    return Number.isFinite(n) ? n : null;
};

/**
 * Wires a settings control to its backing value.
 * @param {string} selector Element selector
 * @param {string} key Settings key
 * @param {'checked'|'number'|'number?'|'string'} kind Value type. 'number?' persists a blank or
 *   unparseable field as null ("unset"), for settings whose null means "follow another setting".
 */
function bind(selector, key, kind) {
    const $el = $(selector);

    if (kind === 'checked') {
        $el.prop('checked', settings()[key]);
    } else {
        // 'number?' holds null when unset, which must render as an empty field (showing the placeholder)
        // rather than as the string "null".
        $el.val(kind === 'number?' ? settings()[key] ?? '' : settings()[key]);
    }

    $el.on('input change', () => {
        settings()[key] = kind === 'checked' ? $el.prop('checked')
            : kind === 'number' ? Number($el.val())
                : kind === 'number?' ? nullableNumber($el.val())
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
    // The one place the word-boundary setting crosses into the matcher, which holds it module-level
    // (see setBoundaryMode). Re-pushed by the select's own handler below.
    matcher.setBoundaryMode(settings().wordBoundary);

    $('#extensions_settings').append(SETTINGS_HTML);

    updateEmbedInfo();   // refresh on drawer open so it tracks Vector Storage changes made mid-session
    $('#wa_embed_info').closest('.inline-drawer').children('.inline-drawer-toggle').on('click', updateEmbedInfo);

    $('#extensionsMenu').append('<div id="wa_studio" class="list-group-item flex-container flexGap5" title="Worlds Apart — Lorebook Studio: manage all lorebooks and entries"><div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>WA Lorebook Studio</span></div>');
    $('#wa_studio').on('click', () => { lorebookStudio(chatBook()); });

    bind('#wa_enabled', 'enabled', 'checked');
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
    renderPluginSetup();                     // paints "checking…" then the detected/install state
    // Detect the plugin and fingerprint the source in parallel; re-render once both settle so the box
    // can show up-to-date / out-of-date. Both are cached, so this runs its fetches at most once.
    Promise.all([hasPlugin(), computeSourceFingerprint()]).then(renderPluginSetup);
    bind('#wa_debug_log', 'debugLog', 'checked');
    document.querySelector('#wa_find_orphans')?.addEventListener('click', async () => {
        const out = document.querySelector('#wa_orphans_out');
        if (out) out.textContent = 'Looking…';
        try { const line = await reportOrphanCollections(); if (out) out.textContent = line; }
        catch (error) { if (out) out.textContent = `Failed: ${error.message}`; }
    });
    bind('#wa_rater_id', 'raterId', 'string');
    bind('#wa_message_depth', 'messageDepth', 'number');
    bind('#wa_match_window', 'matchWindow', 'string');
    bind('#wa_word_boundary', 'wordBoundary', 'string');
    $('#wa_word_boundary').on('change', () => matcher.setBoundaryMode(settings().wordBoundary));
    // number binding would collapse it to 0 and silently switch the keys signal off.
    bind('#wa_llm_profile', 'llmProfile', 'string');
    bind('#wa_llm_temp', 'llmTemperature', 'string');
    bind('#wa_max_entries', 'maxVectorEntries', 'number');
    bind('#wa_max_tokens', 'maxTokens', 'number');
    bind('#wa_max_tokens_pct', 'maxTokensPercent', 'number');
    bind('#wa_budget_slack', 'budgetSlackPercent', 'number');
    bind('#wa_slack_mode', 'budgetSlackMode', 'string');
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
    $('#wa_review_bundles').on('click', () => superEvalScene());

    // ST fires a dry-run generation on chat load and for token estimates; note it so the
    // scan-done handler can stay quiet, since its interceptor (and our retrieval) is skipped.
    eventSource.on(event_types.GENERATION_STARTED, (_type, _options, dryRun) => { runState.generationIsDryRun = Boolean(dryRun); });
    eventSource.on(event_types.GENERATION_ENDED, () => { runState.generationIsDryRun = false; runState.waOwnsScan = false; });

    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);

    // WORLDINFO_ENTRIES_LOADED only fires during a scan, so switching chat/character wouldn't
    // refresh the attached-book set until the next generation. CHAT_CHANGED fires on every
    // switch; re-read the active books then. Also populates once now so it isn't blank on load.
    const refreshAttached = () => getSortedEntries().then(showExemptCount).catch(() => {});
    eventSource.on(event_types.CHAT_CHANGED, refreshAttached);
    // New chat = possibly different books; drop the smartkeys key registry so the automaton
    // tracks the active vocabulary instead of the union of every book ever scanned.
    // WRAPPED, not passed by reference: CHAT_CHANGED emits getCurrentChatId(), which would land in
    // resetSmartKeys's `scope` parameter and defeat its default. It threw only when a chat was actually
    // open, since the id is undefined otherwise.
    eventSource.on(event_types.CHAT_CHANGED, () => resetSmartKeys());
    // The panel survives dry-run scans untouched (rankActivated ignores them), so without
    // this it would carry the previous chat's selection across a switch.
    eventSource.on(event_types.CHAT_CHANGED, () => { runState.lastLayout = []; renderWiPanel([]); });
    refreshAttached();
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, rankActivated);
    // Registered AFTER rankActivated so the feed sees the flag while the scan is live. Clearing on
    // the final loop (not just GENERATION_ENDED) is what keeps a between-scans getSortedEntries —
    // ST's dry runs, other extensions, the exempt-count refresh — off the takeover blanking.
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, (args) => {
        if (!args?.state?.next) runState.waOwnsScan = false;
    });

    // Show the active-entries icon right away; it fills in on the next scan.
    if (settings().enabled) renderWiPanel(runState.lastLayout);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-versus',
        callback: async (named) => { await versusCore(named); return ''; },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'how many of WA\u2019s ranked entries to carry beyond the two delivered sets, for grading depth', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '30' }),
        ],
        helpString: 'Worlds Apart: what WA delivered on this turn against what ST core + Vector Storage would have, at their own budgets. Runs /wa-debug first, prints the difference, and downloads an ordinary two-arm capture bundle \u2014 grade it with Review bundles, apply with eval/synthetic-data/apply-review.mjs, then score with eval/versus-score.mjs.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-core',
        callback: () => {
            const c = runState.lastCoreSet;
            if (!c) { toastr.info('No core selection recorded yet — it is captured on ST\u2019s own dry runs, so send or receive a message first.', 'Worlds Apart'); return ''; }
            console.log(`%cWorlds Apart \u00b7 ST core's own selection at message ${c.at} \u2014 ${c.entries.length} entries, core budget ${c.budget ?? 'unknown'}`, 'font-weight: bold');
            console.table(c.entries.map(e => ({ uid: e.uid, order: e.order, constant: e.constant, book: e.world, entry: e.title })));
            console.log(`uids for eval/core-compare.mjs --core-uids:\n${c.entries.map(e => e.uid).join(',')}`);
            toastr.success(`${c.entries.length} entries \u2014 see console`, 'ST core selection');
            return '';
        },
        helpString: 'Worlds Apart: what ST core selected on its own, with WA standing down. Captured from ST\u2019s dry runs, where interceptors are skipped and core runs its own budget \u2014 so it is core\u2019s shipped set, keyword route only. Console.',
        returns: 'nothing',
    }));

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
        name: 'wa-grade',
        callback: gradeScene,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'name', description: 'sample name, used as the filename', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'scene-<date>' }),
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'how many retrieved entries to surface for grading (the cliff is switched off for the run, so the sample can assess every cutoff mode offline)', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '20' }),
            SlashCommandNamedArgument.fromProps({ name: 'notes', description: 'free-text note stored in the sample', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        helpString: 'Worlds Apart: grade this scene for the offline evals. Runs /wa-debug, then opens a window listing every activated entry with the query text and per-signal scores, for grading 0-5 (constants and stickies are listed but not graded — relevance never chose them). Saving downloads a self-contained sample: query text, settings snapshot, candidate ranking, grades, and copies of every attached lorebook, so later chat/lorebook/settings edits cannot move the numbers. Drop it in eval/eval-data/ and run eval/graded-scene-grid.mjs --sample.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-super-grade',
        callback: superGradeScene,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'name', description: 'base sample name; each arm gets "<name>--<arm>.json"', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'chat-msgN' }),
            SlashCommandNamedArgument.fromProps({ name: 'arms', description: 'which arms to capture, comma-separated (default: all)', typeList: [ARGUMENT_TYPE.STRING], enumList: Object.keys(POOL_ARMS) }),
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'candidate depth per arm (the cliff is switched off for each run)', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '30' }),
            SlashCommandNamedArgument.fromProps({ name: 'notes', description: 'free-text note stored in every sample written', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        helpString: 'Worlds Apart: grade this scene against SEVERAL configurations at once, for a pool that isn\'t biased toward the current defaults. Runs /wa-debug once per arm (arms change which entries get surfaced — entity filter, retrieval mode, threshold, key suppression, summary queries), unions the entries they surfaced, dedupes, and opens one grading window over the union with a "surfaced by" column. Load earlier rounds\' samples into the file picker and their grades are subtracted, so each round only judges what is new. Saves one sample per arm — each with its own params and candidate rows, all sharing the pooled grades. Drop them in eval/eval-data/, run eval/graded-scene-grid.mjs --sample on each, and add arms until the judged@10 column stops showing gaps.',
        returns: 'nothing',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wa-super-eval',
        callback: superEvalScene,
        helpString: 'Worlds Apart: review graded samples/bundles from their FILES, chat-independent — nothing live is read, so scenes captured offline or graded by an LLM judge open without loading their chat. Pick several and each becomes a section with its own query text; stored grades arrive pre-filled and editable, entry text comes from the embedded books. Save downloads ONE review file for the whole run; apply it with node eval/synthetic-data/apply-review.mjs <file> --write.',
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
        helpString: 'Worlds Apart: summarize the current chat with the built-in summary prompt and score the result. Activates nothing. Dev probe for the /wa-super-grade `summary` pool arm — the summarized-query mode is withdrawn from production, so this is the only way to exercise it by hand.',
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
