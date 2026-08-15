// tokens.mjs — token counts that match a live capture's, without a live SillyTavern.
//
// WHY A COUNT BELONGS ON EVERY ROW. A bundle exists so a budget of any size can be replayed offline,
// independent of whatever the capturing machine happened to have configured. `tokens` is the field that
// makes that possible: without it a harness can only re-run the budget that already ran, which is the one
// question nobody needs answered. The runtime records it; an offline derivation has to produce the same
// number or the two cannot be compared.
//
// THE OFFSET IS THE WHOLE TRICK. WA counts through ST's getTokenCountAsync, which adds a fixed
// per-message overhead on top of the raw encoding. Measured against 259 captured rows carrying both a
// recorded count and their entry text: `recorded - cl100k(content)` was 6 on every single row — min 6,
// median 6, max 6, no spread at all. So the offline count is exact rather than approximate, and
// `tokens-check.mjs` re-derives it from whatever captures are on disk rather than trusting this comment.
//
// A tokenizer with no entry here THROWS. The alternative is a silent 0 offset, which is a 6-token error
// per entry that nothing would ever surface — and at ~10 entries per prompt that is most of a slack
// allowance. migrate-bundle's HTTP path against a running ST is the fallback for anything not listed.
import { createRequire } from 'node:module';
import { stInstall } from './scene.mjs';

/** Offsets are MEASURED, not chosen; tokens-check.mjs is what keeps them honest. */
export const TOKENIZER_OFFSET = {
    'gpt-3.5-turbo': 6,
};

/** tiktoken lives in SillyTavern's node_modules, which is an ancestor of this file — but only when the
 *  caller runs from inside the install. Resolved through stInstall so a tool run from elsewhere fails with
 *  a sentence rather than a module-not-found stack. */
const requireST = () => {
    const st = stInstall();
    if (!st) throw new Error('no SillyTavern install found from here — tiktoken is resolved out of its node_modules');
    return createRequire(`${st.root}/`);
};

/**
 * A counter for one tokenizer, matching what the runtime would have recorded.
 *
 * @param {string} tokenizer The name from paramSnapshot.budget.tokenizer
 * @returns {{ count: (text: string) => number, tokenizer: string, offset: number, free: () => void }}
 */
export function offlineTokenCounter(tokenizer) {
    const offset = TOKENIZER_OFFSET[tokenizer];
    if (offset === undefined) {
        throw new Error(`no measured offset for tokenizer "${tokenizer}" — add one via tokens-check.mjs against a capture that used it, `
            + 'or use migrate-bundle.mjs --tokenizer against a running SillyTavern');
    }
    const enc = requireST()('tiktoken').encoding_for_model(tokenizer);
    return {
        tokenizer,
        offset,
        count: text => enc.encode(String(text ?? '')).length + offset,
        free: () => enc.free(),
    };
}

/**
 * Re-derives the offset from captures that carry BOTH a recorded count and their entry text.
 *
 * Returns the spread, not just the middle: an offset is only usable if it is the SAME on every row. A
 * tokenizer whose residual varies is not a constant-offset encoder, and averaging it would bury that.
 *
 * @param {object[]} manifests Parsed bundles
 * @returns {Map<string, {offset: number, min: number, max: number, n: number, constant: boolean}>}
 */
export function deriveOffsets(manifests) {
    const req = requireST();
    const tiktoken = req('tiktoken');
    const encs = new Map();
    const acc = new Map();

    for (const m of manifests) {
        for (const arm of (Array.isArray(m.arms) ? m.arms : [m])) {
            const tok = arm.paramSnapshot?.budget?.tokenizer;
            if (!tok) continue;
            const byUid = new Map();
            for (const [world, bk] of Object.entries(m.books ?? {})) for (const e of Object.values(bk)) byUid.set(`${world}${e.uid}`, e);
            if (!encs.has(tok)) encs.set(tok, tiktoken.encoding_for_model(tok));
            const enc = encs.get(tok);

            for (const c of arm.candidates ?? []) {
                const real = Number(c.tokens);
                const text = byUid.get(`${c.world}${c.uid}`)?.content;
                if (!(real > 0) || !text) continue;
                const d = real - enc.encode(text).length;
                const a = acc.get(tok) ?? { min: Infinity, max: -Infinity, n: 0, first: d };
                a.min = Math.min(a.min, d); a.max = Math.max(a.max, d); a.n++;
                acc.set(tok, a);
            }
        }
    }
    for (const enc of encs.values()) enc.free();
    return new Map([...acc].map(([tok, a]) => [tok, { offset: a.min, min: a.min, max: a.max, n: a.n, constant: a.min === a.max }]));
}
