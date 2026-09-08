// keyword-tools.mjs — the ST-coupled half of keyword analysis: the prune-scan wrapper that injects core's match flags, and the LLM plumbing.
import { generateRaw } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { world_info_case_sensitive, world_info_match_whole_words } from '../../../../world-info.js';
import { splitRecursive } from './chunking.mjs';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { settings } from './state.mjs';
import { buildKeyPruneScan as buildKeyPruneScanCore } from './keyword-audit.mjs';
import { buildKeyPrompt, parseKeyList } from './keyword-suggest.mjs';

/** buildKeyPruneScan with core's match flags injected; a wrapper rather than a bound value, so the flags are read live. */
export const buildKeyPruneScan = (data, opts, ignoreSet, extra = {}) =>
    // `...extra` spreads the caller's matchWindow/chatScan over ST's defaults; a fixed object here drops them silently (matchwindow-check).
    buildKeyPruneScanCore(data, opts, ignoreSet, {
        caseSensitiveDefault: world_info_case_sensitive,
        wholeWordsDefault: world_info_match_whole_words,
        ...extra,
    });


async function generateText(prompt, responseLength) {
    const s = settings();
    const profileId = s.llmProfile;
    const profile = profileId ? (extension_settings.connectionManager?.profiles ?? []).find(x => x.id === profileId) : null;
    if (profile) {
        const temp = String(s.llmTemperature ?? '').trim();
        const overridePayload = temp === '' ? {} : { temperature: Number(temp) };
        // includePreset stays false, not a setting: a roleplay preset's samplers are tuned for prose variety, the opposite of an extraction.
        const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, responseLength, { includePreset: false }, overridePayload);
        const content = String(result?.content ?? '').trim();
        if (!content && result?.reasoning) throw new Error(`profile "${profile.name}" is a reasoning model (returned reasoning, no content). Pick a profile without ":thinking".`);
        return content;
    }
    return String(await generateRaw({ prompt, responseLength })).trim();
}

/** Response cap per call. A thinking model's reasoning spends this same budget; too tight and it returns an empty string. */
const KEY_RESPONSE_TOKENS = 4000;

export async function llmKeyCandidates(content, avoid, chunkSize = 5000) {
    const text = String(content ?? '');
    const chunks = text.length > chunkSize ? splitRecursive(text, chunkSize, ['\n\n', '\n', '. ', ' ', '']) : [text];
    const out = [];
    for (const c of chunks) out.push(...parseKeyList(await generateText(buildKeyPrompt(c, avoid), KEY_RESPONSE_TOKENS)));
    return out;
}
