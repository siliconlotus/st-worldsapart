// keyword-tools.mjs — the ST-coupled half of the lorebook keyword analysis feature: the flag-injecting
// prune-scan wrapper, the LLM generation plumbing, and the Studio's scan/suggest option presets. The
// pure classifier/ranker/filter logic lives in keyword-core.mjs (ST-free, node-importable); the UI
// that surfaces it is the Studio (studio.mjs), which replaced the old standalone popup reports.
import { generateRaw } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { world_info_case_sensitive, world_info_match_whole_words } from '../../../../world-info.js';
// Same splitter the indexer uses — one copy, so a scan window is cut the way a chunk is (see chunking.mjs).
import { splitRecursive } from './chunking.mjs';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { settings } from './state.mjs';
import { KEY_TOO_COMMON, KEY_MIN_LENGTH, KEY_SHARED, buildKeyPruneScan as buildKeyPruneScanCore, buildKeyPrompt, parseKeyList } from './keyword-core.mjs';

/** buildKeyPruneScan with core's world-info match flags injected. A wrapper (not a bound value) so
 * the flags are read at call time — they're live ST settings. */
export const buildKeyPruneScan = (data, opts, ignoreSet) =>
    buildKeyPruneScanCore(data, opts, ignoreSet, { caseSensitiveDefault: world_info_case_sensitive, wholeWordsDefault: world_info_match_whole_words });


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

// Studio scans every entry (all modes, active + inactive) so every entry's keywords get a verdict;
// suggestions use the pruner's own dfCeil so a suggested key can't be one the pruner would then flag.
export const STUDIO_PRUNE_OPTS = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true, ignoreProper: false, stickySkipCommon: true, tooCommon: KEY_TOO_COMMON, minLength: KEY_MIN_LENGTH, sharedKeys: KEY_SHARED };
export const STUDIO_SUGGEST_OPTS = { dfCeil: 0.15, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: false, cap: 8, llmChunk: 5000 };
