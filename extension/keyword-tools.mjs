// keyword-tools.mjs — the ST-coupled half of the lorebook keyword analysis feature: the flag-injecting
// prune-scan wrapper and the LLM generation plumbing. The pure classifier lives in keyword-audit.mjs
// and the ranker/filter in keyword-suggest.mjs (both ST-free and node-importable, and both carrying the
// Studio's own option presets); the UI that surfaces it is the Studio (studio.mjs).
import { generateRaw } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { world_info_case_sensitive, world_info_match_whole_words } from '../../../../world-info.js';
// Same splitter the indexer uses — one copy, so a scan window is cut the way a chunk is (see chunking.mjs).
import { splitRecursive } from './chunking.mjs';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { settings } from './state.mjs';
import { buildKeyPruneScan as buildKeyPruneScanCore } from './keyword-audit.mjs';
import { buildKeyPrompt, parseKeyList } from './keyword-suggest.mjs';

/** buildKeyPruneScan with core's world-info match flags injected. A wrapper (not a bound value) so
 * the flags are read at call time — they're live ST settings. */
export const buildKeyPruneScan = (data, opts, ignoreSet, extra = {}) =>
    // Forward the caller's options (matchWindow, chatScan): building this object here instead drops them
    // silently. ST's globals stay as defaults, so a caller can still override them.
    buildKeyPruneScanCore(data, opts, ignoreSet, {
        caseSensitiveDefault: world_info_case_sensitive,
        wholeWordsDefault: world_info_match_whole_words,
        ...extra,
    });


/**
 * One-shot text generation over WA's configured LLM profile (or the current API). Callers handle
 * failure themselves; nothing here caches or retries.
 */
async function generateText(prompt, responseLength) {
    const s = settings();
    const profileId = s.llmProfile;
    const profile = profileId ? (extension_settings.connectionManager?.profiles ?? []).find(x => x.id === profileId) : null;
    if (profile) {
        const temp = String(s.llmTemperature ?? '').trim();
        const overridePayload = temp === '' ? {} : { temperature: Number(temp) };
        // includePreset is always false, and that is business logic rather than a setting. A preset
        // contributes sampling parameters only here — sendRequest maps it onto an oai_settings clone, the
        // messages stay ours, and the prompt manager is never called — and a roleplay preset's samplers are
        // tuned for prose variety where this is an extraction wanting the opposite. Forced rather than
        // offered because the failure is asymmetric: a bypassed utility profile loses samplers
        // llmTemperature can restore, an included roleplay one has no escape.
        const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, responseLength, { includePreset: false }, overridePayload);
        const content = String(result?.content ?? '').trim();
        if (!content && result?.reasoning) throw new Error(`profile "${profile.name}" is a reasoning model (returned reasoning, no content). Pick a profile without ":thinking".`);
        return content;
    }
    return String(await generateRaw({ prompt, responseLength })).trim();
}

/**
 * Response cap per call. A runaway guard, not a budget: you pay for tokens generated, not tokens allowed,
 * so a tight cap buys nothing — and it must clear a thinking model's reasoning, which spends this same
 * budget and otherwise returns an empty string the Studio can only report as unusable.
 */
const KEY_RESPONSE_TOKENS = 4000;

// One pass per chunk, concatenating the raw candidate lines (callers dedupe/filter). Whether chunking
// beats sending the entry whole, and what size is right, are open; eval/chunk-vs-whole.mjs is the harness.

export async function llmKeyCandidates(content, avoid, chunkSize = 5000) {
    const text = String(content ?? '');
    const chunks = text.length > chunkSize ? splitRecursive(text, chunkSize, ['\n\n', '\n', '. ', ' ', '']) : [text];
    const out = [];
    for (const c of chunks) out.push(...parseKeyList(await generateText(buildKeyPrompt(c, avoid), KEY_RESPONSE_TOKENS)));
    return out;
}
