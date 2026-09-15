// The count-instruction sweep (count-sweep.mjs's arms) against a hosted OpenAI-compatible endpoint through a bounded concurrency pool; the credentials come from the environment and are never logged or written.
// Usage:  NANO_API_KEY=... node nano-sweep.mjs --model google/gemma-4-26b-a4b-it [--concurrency 8] [--out <file>] [--variants all|shipped] [--score-only]
// Appends one JSONL line per response as it lands and resumes from what is on disk; the queue is entry-outermost, so a partial run covers every arm.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { buildKeySuggest, parseKeyList, STUDIO_SUGGEST_OPTS } from '../extension/keyword-suggest.mjs';
import { mean, fmt3 as fmt } from './lib/metrics.mjs';
import { booksOrExit, WORLDS } from './lib/corpus.mjs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BASE = process.env.NANO_BASE_URL ?? 'https://nano-gpt.com/api/v1';

const arg = (n, d = null) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = n => process.argv.includes(`--${n}`);
const MODEL = arg('model');
const CONC = Number(arg('concurrency', '8'));
const OUT = arg('out', `${HERE}eval-data/nano-sweep.jsonl`);

const VARIANTS = {
    'range-5-10': 'Output 5 to 10 keywords',
    'atleast-5': 'Output at least 5 keywords',
    'range-15-20': 'Output 15 to 20 keywords',
    'atleast-15': 'Output at least 15 keywords',
    'confident': 'Output as many keywords as you are confident about',
};
// SHIPPED must track buildKeyPrompt's wording: it is the anchor the variants are substituted over.
const SHIPPED = 'Output as many keywords as you are confident about';
const useVariants = arg('variants', 'all') === 'shipped' ? { 'range-5-10': SHIPPED } : VARIANTS;

const files = Object.fromEntries(Object.entries(booksOrExit()).map(([slug, b]) => [slug, b.file]));
const canon = {}, refKeys = {};
for (const [slug, f] of Object.entries(files)) {
    const d = JSON.parse(readFileSync(`${WORLDS}/${f}`, 'utf8'));
    canon[slug] = buildKeySuggest(d, { ...STUDIO_SUGGEST_OPTS, bgDocs: [] }).canon;
    for (const e of Object.values(d.entries ?? {})) refKeys[`${slug}.${e.uid}`] = (e.key ?? []).filter(k => String(k).trim());
}
const prompts = JSON.parse(readFileSync(`${HERE}eval-data/ladder-prompts.json`, 'utf8'));

// --- existing rows, for resume -------------------------------------------
const rows = [];
const seen = new Set();
if (existsSync(OUT)) {
    for (const line of readFileSync(OUT, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); rows.push(r); seen.add(`${r.model}|${r.variant}|${r.id}`); } catch { /* partial tail */ }
    }
}

if (!has('score-only')) {
    if (!MODEL) { console.error('--model is required'); process.exit(2); }
    const KEY = process.env.NANO_API_KEY;
    if (!KEY) { console.error('NANO_API_KEY not set in the environment.'); process.exit(2); }

    const queue = [];
    for (const p of prompts) {
        for (const [variant, phrase] of Object.entries(useVariants)) {
            if (seen.has(`${MODEL}|${variant}|${p.id}`)) continue;
            if (!p.prompt.includes(SHIPPED)) throw new Error('shipped count phrase not found');
            queue.push({ p, variant, prompt: p.prompt.replace(SHIPPED, phrase) });
        }
    }
    console.log(`${MODEL}: ${queue.length} calls to make (${rows.filter(r => r.model === MODEL).length} already on disk), concurrency ${CONC}`);

    let done = 0, failed = 0, throttled = 0;
    const t0 = Date.now();
    const sleep = ms => new Promise(res => setTimeout(res, ms));

    /** A 429 is back-pressure, not a failure: exponential backoff with jitter, up to 5 retries; anything else fails at once. */
    const fetchWithBackoff = async (task) => {
        for (let attempt = 0; ; attempt++) {
            const r = await fetch(`${BASE}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
                body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: task.prompt }], max_tokens: 4000, stream: false }),
            });
            if (r.status !== 429) return r;
            if (attempt >= 5) return r;
            throttled++;
            await sleep(Math.round((2 ** attempt) * 500 * (1 + Math.random())));
        }
    };

    const worker = async () => {
        for (;;) {
            const task = queue.shift();
            if (!task) return;
            const t = Date.now();
            try {
                const r = await fetchWithBackoff(task);
                const ms = Date.now() - t;
                if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
                const j = await r.json();
                const row = {
                    model: MODEL, variant: task.variant, id: task.p.id, ms,
                    raw: String(j.choices?.[0]?.message?.content ?? '').trim(),
                    usage: j.usage ?? null,
                };
                appendFileSync(OUT, JSON.stringify(row) + '\n');
                rows.push(row);
            } catch (e) {
                failed++;
                console.error(`  FAIL ${task.p.id}/${task.variant}: ${e.message}`);
            }
            if (++done % 25 === 0) process.stdout.write(`  ${done} done, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed\n`);
        }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    const wall = (Date.now() - t0) / 1000;
    console.log(`${MODEL}: ${done} calls in ${wall.toFixed(0)}s wall (${failed} failed, ${throttled} throttle-retries) — ${(done / wall).toFixed(2)} calls/s at concurrency ${CONC}`);
}

// --- score ----------------------------------------------------------------
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const F = (p, r, b) => { const b2 = b * b; return (p + r) ? (1 + b2) * p * r / (b2 * p + r) : 0; };

const models = [...new Set(rows.map(r => r.model))];
for (const m of models) {
    const mine = rows.filter(r => r.model === m);
    console.log(`\n== ${m}   (${mine.length} responses)`);
    console.log(`${'variant'.padEnd(15)}${'n'.padStart(4)}${'ms/call'.padStart(9)}${'out tok'.padStart(9)}${'yield'.padStart(7)}${'recall'.padStart(8)}${'prec'.padStart(7)}${'F1.5'.padStart(8)}${'F2'.padStart(8)}`);
    for (const variant of Object.keys(VARIANTS)) {
        const rs = mine.filter(r => r.variant === variant);
        if (!rs.length) continue;
        const P = [], R = [], f15 = [], f2 = [], ys = [];
        for (const r of rs) {
            const book = r.id.split('.')[0];
            const c = new Set(parseKeyList(r.raw).map(canon[book]).filter(Boolean));
            const refs = new Set((refKeys[r.id] ?? []).map(canon[book]).filter(Boolean));
            ys.push(c.size);
            if (!refs.size || !c.size) continue;
            let h = 0;
            for (const x of c) if (refs.has(x)) h++;
            const pr = h / c.size, rc = h / refs.size;
            P.push(pr); R.push(rc); f15.push(F(pr, rc, 1.5)); f2.push(F(pr, rc, 2));
        }
        console.log(`${variant.padEnd(15)}${String(rs.length).padStart(4)}${String(Math.round(med(rs.map(r => r.ms)))).padStart(9)}`
            + `${String(Math.round(mean(rs.map(r => r.usage?.completion_tokens).filter(Number.isFinite)))).padStart(9)}`
            + `${mean(ys).toFixed(1).padStart(7)}${fmt(mean(R)).padStart(8)}${fmt(mean(P)).padStart(7)}${fmt(mean(f15)).padStart(8)}${fmt(mean(f2)).padStart(8)}`);
    }
}
