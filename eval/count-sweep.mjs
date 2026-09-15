// How should buildKeyPrompt ask for a count? Five wordings substituted over the shipped phrase, every entry at one fixed seed, so a difference between variants is the wording alone; local only, since hosted models honour neither seed nor temperature (H1).
// Usage:  node count-sweep.mjs --model gemma3:4b [--seed 42] [--temp 1]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildKeySuggest, parseKeyList, STUDIO_SUGGEST_OPTS } from '../extension/keyword-suggest.mjs';
import { countKey } from '../extension/matcher.mjs';
import { mean } from './lib/metrics.mjs';
import { booksOrExit, WORLDS } from './lib/corpus.mjs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const CACHE_PATH = `${HERE}eval-data/count-sweep-cache.json`;

const arg = (n, d = null) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const MODEL = arg('model', 'gemma3:4b');
const SEED = Number(arg('seed', '42'));
const TEMP = Number(arg('temp', '1'));

const VARIANTS = {
    'range-5-10': 'Output 5 to 10 keywords',
    'atleast-5': 'Output at least 5 keywords',
    'range-15-20': 'Output 15 to 20 keywords',
    'atleast-15': 'Output at least 15 keywords',
    'confident': 'Output as many keywords as you are confident about',
};
// SHIPPED must track buildKeyPrompt's wording: it is the anchor the variants are substituted over.
const SHIPPED = 'Output as many keywords as you are confident about';

const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};

const files = Object.fromEntries(Object.entries(booksOrExit()).map(([slug, b]) => [slug, b.file]));
const canon = {}, refKeys = {};
for (const [slug, f] of Object.entries(files)) {
    const d = JSON.parse(readFileSync(`${WORLDS}/${f}`, 'utf8'));
    canon[slug] = buildKeySuggest(d, { ...STUDIO_SUGGEST_OPTS, bgDocs: [] }).canon;
    for (const e of Object.values(d.entries ?? {})) refKeys[`${slug}.${e.uid}`] = (e.key ?? []).filter(k => String(k).trim());
}
const prompts = JSON.parse(readFileSync(`${HERE}eval-data/ladder-prompts.json`, 'utf8'));

async function ask(prompt) {
    const key = `${MODEL}\x1f${TEMP}\x1f${SEED}\x1f${hash(prompt)}`;
    if (cache[key] !== undefined) return cache[key];
    const r = await fetch(`${OLLAMA}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false, options: { temperature: TEMP, num_predict: 4000, seed: SEED } }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const j = await r.json();
    const text = String(j.response ?? '').trim();
    if (!text && j.done_reason === 'length') throw new Error('no output in budget');
    cache[key] = text;
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
    return text;
}

const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const results = {};   // variant -> id -> {yield, ref, prec, att}
let done = 0;
const total = Object.keys(VARIANTS).length * prompts.length;

// Entry-outermost, variant-innermost: a partial run is a balanced sample of every arm.
for (const name of Object.keys(VARIANTS)) results[name] = {};
for (const p of prompts) {
    for (const [name, phrase] of Object.entries(VARIANTS)) {
        if (!p.prompt.includes(SHIPPED)) throw new Error('shipped count phrase not found — update SHIPPED');
        const raw = await ask(p.prompt.replace(SHIPPED, phrase));
        const c = new Set(parseKeyList(raw).map(canon[p.book]).filter(Boolean));
        const refs = new Set((refKeys[p.id] ?? []).map(canon[p.book]).filter(Boolean));
        let hit = 0;
        for (const x of c) if (refs.has(x)) hit++;
        results[name][p.id] = {
            yield: c.size,
            ref: refs.size ? hit / refs.size : NaN,
            prec: c.size ? hit / c.size : NaN,
            att: c.size ? [...c].filter(x => countKey(x, p.prompt, false, false) > 0).length / c.size : NaN,
            refCount: refs.size,
        };
        if (++done % 20 === 0) process.stdout.write(`  ${done}/${total}\n`);
    }
}

console.log(`\nmodel ${MODEL}, seed ${SEED}, temp ${TEMP}, ${prompts.length} entries — one call per cell, output pinned\n`);
console.log(`${'variant'.padEnd(14)}${'yield'.padStart(7)}${'min'.padStart(5)}${'max'.padStart(5)}${'agree/ref'.padStart(11)}${'precision'.padStart(11)}${'attested'.padStart(10)}`);
for (const name of Object.keys(VARIANTS)) {
    const rs = Object.values(results[name]);
    if (!rs.length) continue;
    const ys = rs.map(r => r.yield);
    console.log(`${name.padEnd(14)}${f(mean(ys), 1).padStart(7)}${String(Math.min(...ys)).padStart(5)}${String(Math.max(...ys)).padStart(5)}`
        + `${f(mean(rs.map(r => r.ref).filter(Number.isFinite))).padStart(11)}`
        + `${f(mean(rs.map(r => r.prec).filter(Number.isFinite))).padStart(11)}`
        + `${f(mean(rs.map(r => r.att).filter(Number.isFinite))).padStart(10)}`);
}

console.log('\nH1  range vs open floor (does a closed range pull toward its bottom?)');
for (const [lo, hi] of [['atleast-5', 'range-5-10'], ['atleast-15', 'range-15-20']]) {
    const a = mean(Object.values(results[lo]).map(r => r.yield));
    const b = mean(Object.values(results[hi]).map(r => r.yield));
    console.log(`  ${lo.padEnd(12)} ${f(a, 1)}   vs   ${hi.padEnd(12)} ${f(b, 1)}   diff ${f(a - b, 1)}`);
}

console.log('\nH2  padding on sparse entries (precision by how many keys the author wrote)');
const ids = prompts.map(p => p.id);
const med = [...ids.map(i => results['range-5-10'][i].refCount)].sort((a, b) => a - b)[Math.floor(ids.length / 2)];
const sparse = ids.filter(i => results['range-5-10'][i].refCount <= med);
const rich = ids.filter(i => results['range-5-10'][i].refCount > med);
console.log(`  split at ${med} reference keys: ${sparse.length} sparse, ${rich.length} rich`);
console.log(`  ${'variant'.padEnd(14)}${'prec sparse'.padStart(12)}${'prec rich'.padStart(11)}${'gap'.padStart(8)}${'yield sparse'.padStart(13)}${'yield rich'.padStart(11)}`);
for (const name of Object.keys(VARIANTS)) {
    const ps = mean(sparse.map(i => results[name][i].prec).filter(Number.isFinite));
    const pr = mean(rich.map(i => results[name][i].prec).filter(Number.isFinite));
    console.log(`  ${name.padEnd(14)}${f(ps).padStart(12)}${f(pr).padStart(11)}${f(ps - pr).padStart(8)}`
        + `${f(mean(sparse.map(i => results[name][i].yield)), 1).padStart(13)}`
        + `${f(mean(rich.map(i => results[name][i].yield)), 1).padStart(11)}`);
}

const cy = Object.values(results['confident']).map(r => r.yield);
const sd = Math.sqrt(mean(cy.map(y => (y - mean(cy)) ** 2)));
console.log(`\n"confident" yield spread: mean ${f(mean(cy), 1)}, sd ${f(sd, 2)}, range ${Math.min(...cy)}-${Math.max(...cy)}`);
console.log('  (a flat sd means the model picked a habitual number rather than judging the entry)');
