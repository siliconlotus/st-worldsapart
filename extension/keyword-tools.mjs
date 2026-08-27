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
import { KEY_BOOK_COMMON, KEY_MIN_LENGTH, KEY_BOOK_SHARED, buildKeyPruneScan as buildKeyPruneScanCore, buildKeyPrompt, parseKeyList } from './keyword-core.mjs';

/** buildKeyPruneScan with core's world-info match flags injected. A wrapper (not a bound value) so
 * the flags are read at call time — they're live ST settings. */
export const buildKeyPruneScan = (data, opts, ignoreSet, extra = {}) =>
    // FORWARD the caller's options. This took a fixed 4th argument and built it here, so everything the
    // Studio passed — matchWindow, chatRate — was dropped on the floor: the audit ran at the default
    // match window and with no chat evidence no matter what was gathered, and the only symptom was a
    // verdict that never changed. ST's globals stay as DEFAULTS, so a caller can still override them.
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
        // includePreset is always false, and that is business logic rather than a setting.
        //
        // What the preset contributes here is SAMPLING PARAMETERS ONLY — never prompt content.
        // sendRequest forwards `presetName` to presetToGeneratePayload, which maps the preset onto
        // an oai_settings clone; the messages array stays the one we passed. The prompt manager,
        // which is where a roleplay preset's system prompt and jailbreak live, is never called on
        // this path — so there is no prompt conditioning here to guard against.
        //
        // Bypassing is still right, for the samplers: a roleplay preset is tuned for prose variety
        // — high temperature and top_p, repetition penalties — and this is an extraction that wants
        // the opposite. Forced rather than offered because the failure is asymmetric. Bypassed, a
        // purpose-built utility profile loses its samplers and llmTemperature can restore the one
        // that matters; included, a roleplay profile poisons every suggestion with no escape.
        const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, responseLength, { includePreset: false }, overridePayload);
        const content = String(result?.content ?? '').trim();
        if (!content && result?.reasoning) throw new Error(`profile "${profile.name}" is a reasoning model (returned reasoning, no content). Pick a profile without ":thinking".`);
        return content;
    }
    return String(await generateRaw({ prompt, responseLength })).trim();
}

/**
 * Response cap per call. A runaway guard, not a budget: you pay for tokens generated, not tokens
 * allowed, so a tight cap buys nothing.
 *
 * It must clear a THINKING model's reasoning, which spends this same budget. At the previous 400 a
 * reasoning model could consume the whole allowance and return an empty string, which the
 * no-profile path passes through silently and the Studio reports as "Model returned nothing usable"
 * indefinitely.
 */
const KEY_RESPONSE_TOKENS = 4000;

// One pass per chunk, concatenating the raw candidate lines (callers dedupe/filter). chunkSize is
// user-tunable (Recommender settings). Whether chunking beats sending the entry whole, and what
// size is right, are open; eval/chunk-vs-whole.mjs is the harness.

export async function llmKeyCandidates(content, avoid, chunkSize = 5000) {
    const text = String(content ?? '');
    const chunks = text.length > chunkSize ? splitRecursive(text, chunkSize, ['\n\n', '\n', '. ', ' ', '']) : [text];
    const out = [];
    for (const c of chunks) out.push(...parseKeyList(await generateText(buildKeyPrompt(c, avoid), KEY_RESPONSE_TOKENS)));
    return out;
}

// Studio option presets moved to keyword-core.mjs (pure data, and the evals must read the shipped
// values rather than a copy). Re-exported so studio.mjs's import site is unchanged.
export { STUDIO_PRUNE_OPTS, STUDIO_SUGGEST_OPTS } from './keyword-core.mjs';
