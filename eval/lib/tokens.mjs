// tokens.mjs — token counts that match a live capture's, without a live SillyTavern: cl100k plus a per-tokenizer
// offset measured off captures (G12). An unlisted tokenizer THROWS; count it against a running SillyTavern.
import { createRequire } from 'node:module';
import { stInstall } from './scene.mjs';
import { armNames, openBundle } from '../../extension/grading.mjs';

/** Offsets are MEASURED, not chosen; tokens-check.mjs re-derives them. */
export const TOKENIZER_OFFSET = {
    'gpt-3.5-turbo': 6,
};

/** tiktoken is resolved out of the ST install's node_modules through stInstall, from any cwd. */
const requireST = () => {
    const st = stInstall();
    if (!st) throw new Error('no SillyTavern install found from here — tiktoken is resolved out of its node_modules');
    return createRequire(`${st.root}/`);
};

/** A counter for one tokenizer (the document's `budget.tokenizer`), matching what the runtime recorded. */
export function offlineTokenCounter(tokenizer) {
    const offset = TOKENIZER_OFFSET[tokenizer];
    if (offset === undefined) {
        throw new Error(`no measured offset for tokenizer "${tokenizer}" — add one via tokens-check.mjs against a capture that used it, `
            + 'or count against a running SillyTavern');
    }
    const enc = requireST()('tiktoken').encoding_for_model(tokenizer);
    return {
        tokenizer,
        offset,
        count: text => enc.encode(String(text ?? '')).length + offset,
        free: () => enc.free(),
    };
}

/** Each tokenizer's offset re-derived from captures carrying BOTH a recorded count and entry text; `constant` false means the residual varies and the offset is unusable. */
export function deriveOffsets(manifests) {
    const req = requireST();
    const tiktoken = req('tiktoken');
    const encs = new Map();
    const acc = new Map();

    for (const m of manifests) {
        // One tokenizer per document: it is ST's getTokenizerModel(), not a WA knob.
        const tok = m.budget?.tokenizer;
        if (!tok) continue;
        // Candidates sit on the arm's scene cell, so go through openBundle rather than walking the nesting.
        for (const arm of armNames(m)) {
            const S = openBundle(m, arm);
            const byUid = new Map();
            for (const [book, bk] of Object.entries(m.books ?? {})) for (const e of Object.values(bk)) byUid.set(`${book}${e.uid}`, e);
            if (!encs.has(tok)) encs.set(tok, tiktoken.encoding_for_model(tok));
            const enc = encs.get(tok);

            for (const c of S.candidates ?? []) {
                const real = Number(c.tokens);
                const text = byUid.get(`${c.book}${c.uid}`)?.content;
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
