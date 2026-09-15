// Should a long entry be chunked or sent whole? Three arms over entries longer than llmChunk, same prompt builder and parser: whole (one call), chunked (production — splitRecursive at llmChunk, one call per chunk, unioned), first (first chunk only, the temp-ladder's approximation).
// Usage:  node chunk-vs-whole.mjs --model gemma3:4b [--temp 0] [--entries 6]
// Agreement with the books' own keys is relative across arms only: curation is evidence about precision, never recall (eval-data/README.md).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildKeySuggest, buildKeyPrompt, parseKeyList, STUDIO_SUGGEST_OPTS } from '../extension/keyword-suggest.mjs';
import { splitRecursive } from '../extension/chunking.mjs';
import { countKey } from '../extension/matcher.mjs';
import { mean, fmt3 as fmt } from './metrics.mjs';
import { booksOrExit, WORLDS } from './corpus.mjs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CACHE_PATH = `${HERE}eval-data/chunk-vs-whole-cache.json`;
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const BOOKS = Object.entries(booksOrExit()).map(([slug, b]) => [slug, b.file]);
// The separators llmKeyCandidates passes, so a chunk boundary here is a chunk boundary there.
const SEPS = ['\n\n', '\n', '. ', ' ', ''];

const arg = (n, d = null) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};

const model = arg('model', 'gemma3:4b');
const temp = Number(arg('temp', '0'));
const perBook = Number(arg('entries', '6'));

/** num_predict 400 per call, as llmKeyCandidates sends: chunked gets 400 per chunk and whole 400 total — production's asymmetry, so a yield win for chunked is partly a budget win. */
async function ask(prompt) {
    const key = `${model}\x1f${temp}\x1f${hash(prompt)}`;
    if (cache[key] !== undefined) return cache[key];
    const r = await fetch(`${OLLAMA}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: temp, num_predict: 400 } }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const j = await r.json();
    const text = String(j.response ?? '').trim();
    if (!text && j.done_reason === 'length') throw new Error('no output in budget (thinking overrun?)');
    cache[key] = text;
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
    return text;
}

const rows = [];
for (const [slug, file] of BOOKS) {
    const data = JSON.parse(readFileSync(`${WORLDS}/${file}`, 'utf8'));
    const suggest = buildKeySuggest(data, { ...STUDIO_SUGGEST_OPTS, bgDocs: [] });
    const long = Object.values(data.entries ?? {})
        .filter(e => e && !e.disable && Array.isArray(e.key) && e.key.some(k => String(k).trim()))
        .filter(e => String(e.content ?? '').length > STUDIO_SUGGEST_OPTS.llmChunk)
        .sort((a, b) => Number(a.uid) - Number(b.uid));
    if (!long.length) { console.log(`${slug}: no entries over ${STUDIO_SUGGEST_OPTS.llmChunk} chars, skipped`); continue; }
    const stride = long.length / Math.min(perBook, long.length);
    const picked = Array.from({ length: Math.min(perBook, long.length) }, (_, i) => long[Math.floor(i * stride)]);

    for (const e of picked) {
        const content = String(e.content);
        const chunks = splitRecursive(content, STUDIO_SUGGEST_OPTS.llmChunk, SEPS);
        const refs = new Set(e.key.filter(k => String(k).trim()).map(suggest.canon).filter(Boolean));
        const score = (cands, calls) => {
            const set = new Set(cands.map(suggest.canon).filter(Boolean));
            let hit = 0; for (const x of set) if (refs.has(x)) hit++;
            return {
                calls, yield: set.size,
                agreeOfRef: refs.size ? hit / refs.size : NaN,
                agreeOfCand: set.size ? hit / set.size : NaN,
                attested: set.size ? [...set].filter(t => countKey(t, content, false, false) > 0).length / set.size : NaN,
            };
        };
        try {
            const whole = parseKeyList(await ask(buildKeyPrompt(content, suggest.avoid)));
            const perChunk = [];
            for (const c of chunks) perChunk.push(...parseKeyList(await ask(buildKeyPrompt(c, suggest.avoid))));
            const first = parseKeyList(await ask(buildKeyPrompt(chunks[0], suggest.avoid)));
            rows.push({ book: slug, uid: e.uid, chars: content.length, nchunks: chunks.length,
                whole: score(whole, 1), chunked: score(perChunk, chunks.length), first: score(first, 1) });
            process.stdout.write(`  ${slug}.${e.uid} (${content.length}ch, ${chunks.length} chunks)\n`);
        } catch (err) {
            console.error(`  FAIL ${slug}.${e.uid}: ${err.message}`);
        }
    }
}

if (!rows.length) { console.log('nothing scored'); process.exit(1); }

console.log(`\nmodel ${model}, T=${temp} — entries longer than ${STUDIO_SUGGEST_OPTS.llmChunk} chars only`);
console.log(`n=${rows.length} entries, mean ${(mean(rows.map(r => r.chars)) / 1000).toFixed(1)}k chars, mean ${mean(rows.map(r => r.nchunks)).toFixed(1)} chunks\n`);
const pad = (s, n) => String(s).padEnd(n); const lp = (s, n) => String(s).padStart(n);
console.log(`${pad('arm', 10)}${lp('calls', 7)}${lp('yield', 8)}${lp('agree/ref', 11)}${lp('agree/cand', 12)}${lp('attested', 10)}`);
for (const arm of ['whole', 'chunked', 'first']) {
    const g = k => mean(rows.map(r => r[arm][k]).filter(Number.isFinite));
    console.log(`${pad(arm, 10)}${lp(g('calls').toFixed(1), 7)}${lp(g('yield').toFixed(1), 8)}${lp(fmt(g('agreeOfRef')), 11)}${lp(fmt(g('agreeOfCand')), 12)}${lp(fmt(g('attested')), 10)}`);
}

const binomP = (k, n) => {
    if (!n) return NaN;
    const c = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1); return r; };
    let p = 0;
    for (let i = 0; i <= n; i++) { const pr = c(n, i) / 2 ** n; if (pr <= c(n, k) / 2 ** n + 1e-12) p += pr; }
    return Math.min(1, p);
};
console.log('\npaired: chunked vs whole, per entry');
console.log(`${pad('metric', 12)}${lp('n', 4)}${lp('chunked+', 10)}${lp('whole+', 8)}${lp('mean d', 9)}${lp('p', 8)}`);
for (const k of ['yield', 'agreeOfRef', 'agreeOfCand', 'attested']) {
    const ds = rows.map(r => r.chunked[k] - r.whole[k]).filter(Number.isFinite);
    const a = ds.filter(d => d > 0).length, b = ds.filter(d => d < 0).length;
    console.log(`${pad(k, 12)}${lp(ds.length, 4)}${lp(a, 10)}${lp(b, 8)}${lp(mean(ds).toFixed(3), 9)}${lp(fmt(binomP(Math.min(a, b), a + b)), 8)}`);
}
