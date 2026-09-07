// Is temperature's only benefit just "more candidates", obtainable more cheaply by asking for more?
//
// The temperature ladder found no per-response quality effect and exactly one positive result: the union
// across repeats reaches more of a book's own keys at T=1 than at T=0 (S1). Part of that is arithmetic — at
// T=0 the repeats are identical, so the union is the single response — so "temperature buys coverage" and
// "any source of extra candidates buys coverage" are not distinguished by it.
//
// The prompt already governs yield: it says "Output 5 to 10 keywords", and measured responses sit at the
// instruction, nowhere near the token budget (S1). So raising the instruction is a second route to more
// candidates, one call instead of three and deterministic at T=0.
//
//   base   T=0, "5 to 10"   x3   — deterministic; union == single response
//   temp   T=1, "5 to 10"   x3   — the temperature route to more candidates
//   count  T=0, "15 to 25"  x3   — the prompt route, one call, reproducible
//
// The comparison that matters is `temp` union against `count` single: if one deterministic call matches
// three sampled ones, temperature is strictly dominated for this purpose.
//
// base and temp are read from temp-ladder-cache.json, so they are already paid for; only `count` makes new
// calls. The count variant rewrites buildKeyPrompt's instruction line rather than parameterising the
// shipped function — the shipped prompt should not grow a knob before a finding earns it one.
//
// Usage:  node count-vs-temp.mjs --model gemma3:4b [--count "15 to 25"] [--repeats 3]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildKeySuggest, parseKeyList, STUDIO_SUGGEST_OPTS } from '../extension/keyword-suggest.mjs';
import { countKey } from '../extension/matcher.mjs';
import { mean } from './metrics.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const WORLDS = `${HERE}../../../../../../data/default-user/worlds`;
const LADDER_CACHE = `${HERE}eval-data/temp-ladder-cache.json`;
const CACHE_PATH = `${HERE}eval-data/count-vs-temp-cache.json`;

const arg = (n, d = null) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const MODEL = arg('model', 'gemma3:4b');
const COUNT = arg('count', '15 to 25');   // substituted into COUNT_LINE's slot
const REPEATS = Number(arg('repeats', '3'));
// A fixed seed makes sampling reproducible at ANY temperature, so "deterministic" and "T=0" are not
// the same requirement — with a seed, a prompt change is the only thing that can move the output,
// which is what prompt tweaking actually needs. Unset by default so existing caches stay valid.
const SEED = arg('seed') !== null ? Number(arg('seed')) : null;

const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const ladder = existsSync(LADDER_CACHE) ? JSON.parse(readFileSync(LADDER_CACHE, 'utf8')) : {};
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};

const files = { foxbridge: 'Foxbridge.json', sommers: 'Sommers_Pack__v22.json', timewhore: 'LTM_Isekai_-_Time_Whore_updated.json' };
const canon = {}, refKeys = {};
for (const [slug, f] of Object.entries(files)) {
    const d = JSON.parse(readFileSync(`${WORLDS}/${f}`, 'utf8'));
    canon[slug] = buildKeySuggest(d, { ...STUDIO_SUGGEST_OPTS, bgDocs: [] }).canon;
    for (const e of Object.values(d.entries ?? {})) refKeys[`${slug}.${e.uid}`] = (e.key ?? []).filter(k => String(k).trim());
}

const prompts = JSON.parse(readFileSync(`${HERE}eval-data/ladder-prompts-small.json`, 'utf8'));
const TEXT = Object.fromEntries(prompts.map(p => [p.id, p.prompt]));
// The shipped instruction line, verbatim from buildKeyPrompt. Asserting it is present keeps this
// from silently measuring an unmodified prompt if that wording ever changes.
// `shipped` is the anchor the variants are substituted over, so it must track buildKeyPrompt — currently
// the self-selecting wording, which makes `range-5-10` a counterfactual arm rather than the default.
const COUNT_LINE = '- Output as many keywords as you are confident about,';
const recount = p => {
    if (!p.includes(COUNT_LINE)) throw new Error('buildKeyPrompt instruction line not found — update COUNT_LINE');
    return p.replace(COUNT_LINE, `- Output ${COUNT} keywords,`);
};

async function ask(prompt, temperature) {
    const key = `${MODEL}\x1f${temperature}\x1f${SEED ?? 'noseed'}\x1f${hash(prompt)}`;
    if (cache[key] !== undefined) return cache[key];
    const r = await fetch(`${OLLAMA}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false, options: { temperature, num_predict: 4000, ...(SEED !== null ? { seed: SEED } : {}) } }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const j = await r.json();
    const text = String(j.response ?? '').trim();
    if (!text && j.done_reason === 'length') throw new Error('no output in budget');
    cache[key] = text;
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
    return text;
}

// --- gather --------------------------------------------------------------
// arm -> id -> [Set per repeat]
const arms = { base: new Map(), temp: new Map(), count: new Map() };
const push = (arm, id, set) => { if (!arms[arm].has(id)) arms[arm].set(id, []); arms[arm].get(id).push(set); };

for (const p of prompts) {
    const bk = p.book;
    for (let rep = 0; rep < REPEATS; rep++) {
        for (const [arm, t] of [['base', 0], ['temp', 1]]) {
            const raw = ladder[`${MODEL}\x1f${t}\x1f${rep}\x1f${hash(p.prompt)}`];
            if (raw !== undefined) push(arm, p.id, new Set(parseKeyList(raw).map(canon[bk]).filter(Boolean)));
        }
        const raw = await ask(recount(p.prompt), 0);
        push('count', p.id, new Set(parseKeyList(raw).map(canon[bk]).filter(Boolean)));
    }
}

// --- score ---------------------------------------------------------------
const rows = [];
for (const [arm, M] of Object.entries(arms)) {
    const single = [], singleRef = [], uni = [], uniRef = [], prec = [], att = [];
    for (const [id, sets] of M) {
        if (!sets.length) continue;
        const refs = new Set((refKeys[id] ?? []).map(canon[id.split('.')[0]]).filter(Boolean));
        const share = c => { let h = 0; for (const x of c) if (refs.has(x)) h++; return refs.size ? h / refs.size : NaN; };
        for (const c of sets) {
            single.push(c.size);
            singleRef.push(share(c));
            if (!c.size) continue;
            // precision = share of proposals that are already book keys; attested = share occurring
            // in the entry text. Together they say whether extra candidates are junk or real.
            let hit = 0;
            for (const x of c) if (refs.has(x)) hit++;
            prec.push(hit / c.size);
            att.push([...c].filter(x => countKey(x, TEXT[id] ?? '', false, false) > 0).length / c.size);
        }
        const u = new Set(sets.flatMap(s => [...s]));
        uni.push(u.size); uniRef.push(share(u));
    }
    if (single.length) rows.push({ arm, n: M.size, single: mean(single), singleRef: mean(singleRef.filter(Number.isFinite)), union: mean(uni), unionRef: mean(uniRef.filter(Number.isFinite)), prec: mean(prec.filter(Number.isFinite)), att: mean(att.filter(Number.isFinite)) });
}

const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');
console.log(`\nmodel ${MODEL}, ${prompts.length} entries x ${REPEATS} repeats, count arm asks for "${COUNT}"\n`);
console.log('arm     calls  single-yield  single-agree/ref   union-yield  union-agree/ref   precision  attested');
for (const r of rows) {
    console.log(`${r.arm.padEnd(8)}${String(REPEATS).padStart(4)}${f(r.single, 1).padStart(14)}${f(r.singleRef).padStart(18)}${f(r.union, 1).padStart(14)}${f(r.unionRef).padStart(17)}${f(r.prec).padStart(12)}${f(r.att).padStart(10)}`);
}
const t = rows.find(r => r.arm === 'temp'), c = rows.find(r => r.arm === 'count'), b = rows.find(r => r.arm === 'base');
if (t && c && b) {
    console.log(`\nthe comparison: temp UNION (3 calls, non-reproducible) = ${f(t.unionRef)} agree/ref at ${f(t.union, 1)} candidates`);
    console.log(`                count SINGLE (1 call, deterministic)   = ${f(c.singleRef)} agree/ref at ${f(c.single, 1)} candidates`);
    console.log(`                base  SINGLE (1 call, deterministic)   = ${f(b.singleRef)} agree/ref at ${f(b.single, 1)} candidates`);
}
