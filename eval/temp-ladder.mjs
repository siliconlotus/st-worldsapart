// Does sampling temperature change what the ✨ LLM keyword suggester proposes, and how?
//
// The temperature setting (state.mjs llmTemperature) carries an assertion, not a measurement: the claim
// that low values suit this job was inherited from the withdrawn query summarizer, where a stable query
// mattered. The suggester feeds a candidate set to the Zipf/df gates and a human review, so recall is the
// generator's half and precision the filter's, and breadth may be worth more there than stability.
//
// What is and is not measurable here: agreement with a book's existing keys is a relative measure across
// arms and nothing more. Curation is evidence about precision and never about recall (eval-data/README.md),
// so a candidate absent from the book may be a bad key or a good one nobody considered. What this can do is
// hold the reference fixed while temperature moves — the bias is constant across the ladder, so the
// direction of a change is interpretable even though the absolute level is not a quality score. The three
// books are the ones whose provenance supports even that much; uncurated books are output, not judgement,
// and are deliberately excluded.
//
// Shipped code, not a reimplementation: the prompt is buildKeyPrompt, the parse is parseKeyList, the
// avoid-list and canonicaliser come from buildKeySuggest, attestation goes through countKey, and the
// options are STUDIO_SUGGEST_OPTS, so a prompt or gate change moves this too. Only the transport is local
// (keyword-tools.mjs generateText imports ST and cannot load in node).
//
// Usage:
//   node temp-ladder.mjs --dump-prompts prompts.json          # exact prompts, for cross-model parity
//   node temp-ladder.mjs --model gemma3:4b --temps 0,0.3,0.7,1.0 --repeats 3 --entries 8
//   node temp-ladder.mjs --score-only --extra haiku.json,sonnet.json
//
// Responses are cached to temp-ladder-cache.json keyed by (model, temp, repeat, prompt), so adding a
// model or a rung never re-pays for the ones already run.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildKeySuggest, buildKeyPrompt, parseKeyList, STUDIO_SUGGEST_OPTS } from '../extension/keyword-suggest.mjs';
import { countKey } from '../extension/matcher.mjs';
import { mean, fmt3 as fmt } from './metrics.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const CACHE_PATH = `${HERE}eval-data/temp-ladder-cache.json`;
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const WORLDS = `${HERE}../../../../../../data/default-user/worlds`;

// Provenance is the entry criterion: only hand-written or manually-curated books can stand as a
// reference at all (eval-data/README.md). Order is fixed so the entry sample is reproducible.
const BOOKS = [
    ['foxbridge', 'Foxbridge.json', 'hand-written'],
    ['sommers', 'Sommers_Pack__v22.json', 'manually curated'],
    ['timewhore', 'LTM_Isekai_-_Time_Whore_updated.json', 'manually curated (mostly)'],
];

const arg = (name, dflt = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = name => process.argv.includes(`--${name}`);

const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
const saveCache = () => writeFileSync(CACHE_PATH, JSON.stringify(cache));

/**
 * The sampled entries, identical for every model and every rung. Deterministic by construction: a
 * fixed content-length floor, then uid order, then an even stride across the book — no RNG, so a
 * later run adds models to the same population rather than a fresh draw of it.
 */
function sampleEntries(data, n) {
    const all = Object.values(data?.entries ?? {})
        .filter(e => e && !e.disable && String(e.content ?? '').trim().length >= 400)
        // Keys are the reference, so an entry with none cannot contribute to agreement.
        .filter(e => Array.isArray(e.key) && e.key.filter(k => String(k).trim()).length > 0)
        .sort((a, b) => Number(a.uid) - Number(b.uid));
    if (all.length <= n) return all;
    const stride = all.length / n;
    return Array.from({ length: n }, (_, i) => all[Math.floor(i * stride)]);
}

/** One book's sampled entries with their shipped prompt and reference keys attached. */
function prepBook([slug, file, provenance], nEntries) {
    const data = JSON.parse(readFileSync(`${WORLDS}/${file}`, 'utf8'));
    const suggest = buildKeySuggest(data, { ...STUDIO_SUGGEST_OPTS, bgDocs: [] });
    const entries = sampleEntries(data, nEntries).map(e => {
        const content = String(e.content ?? '');
        // Long entries are chunked in production (llmKeyCandidates). The ladder measures the
        // generator, not the chunker, so it takes the first chunk-sized slice and says so.
        const text = content.slice(0, STUDIO_SUGGEST_OPTS.llmChunk);
        return {
            book: slug, uid: e.uid, title: e.comment ?? '', text,
            truncated: content.length > STUDIO_SUGGEST_OPTS.llmChunk,
            keys: e.key.filter(k => String(k).trim()),
            prompt: buildKeyPrompt(text, suggest.avoid),
        };
    });
    return { slug, provenance, canon: suggest.canon, avoid: suggest.avoid, entries };
}

/**
 * num_predict 400 mirrors llmKeyCandidates' hardcoded responseLength, so the ladder is measuring the
 * budget production actually gives the model.
 *
 * `think: false` is required, not a tuning choice: a thinking model spends the whole budget reasoning and
 * returns `done_reason: length` with an empty response, a silent zero that scores as "the model proposed
 * nothing" rather than as a failure (H6). A no-op for non-thinking models, so setting it uniformly keeps
 * the arms comparable. The shipped path has no equivalent escape, and its 400-token cap makes every
 * thinking model return nothing.
 */
async function askOllama(model, prompt, temperature) {
    const r = await fetch(`${OLLAMA}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature, num_predict: 400 } }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
    const j = await r.json();
    const text = String(j.response ?? '').trim();
    // An empty body with done_reason 'length' is a budget failure, not an empty candidate set.
    // Throwing keeps it out of the cache so a re-run retries it, instead of freezing a false zero.
    if (!text && j.done_reason === 'length') throw new Error(`${model}: no output in ${j.eval_count} tokens (thinking overrun?)`);
    return text;
}

/** Jaccard over canonicalised sets; 1 for two empty sets (identical, if vacuously). */
const jaccard = (a, b) => {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
};

/**
 * Per-arm statistics over one book's entries.
 *
 * `agree*` compare against the book's own keys and are relative-only (see the header). `stability` is the
 * mean pairwise Jaccard between repeats of the same entry at the same rung — the one metric here with no
 * reference-bias caveat, since it asks only whether the generator repeats itself. `grounded` is the
 * set-level predicate: does any candidate occur in the entry text.
 */
function scoreArm(book, runs) {
    const canon = book.canon;
    const perEntry = [], stabilities = [], unions = [];
    for (const e of book.entries) {
        const reps = runs.filter(r => r.uid === e.uid).map(r => new Set(r.cands.map(canon).filter(Boolean)));
        if (!reps.length) continue;
        const refs = new Set(e.keys.map(canon).filter(Boolean));

        // Union across repeats — the breadth measure, and the production-relevant one: the Studio merges
        // each ✨ click into the entry's existing chips (mergeLlmCands), so what a user accumulates is the
        // union of their retries. It is the only metric that can pay off a temperature above 0, since at
        // T=0 the repeats are identical and the union is the single response.
        const union = new Set(reps.flatMap(s => [...s]));
        let uhit = 0;
        for (const x of union) if (refs.has(x)) uhit++;
        unions.push({ unionYield: union.size, unionRef: refs.size ? uhit / refs.size : NaN });
        for (const c of reps) {
            let hit = 0;
            for (const x of c) if (refs.has(x)) hit++;
            perEntry.push({
                yield: c.size,
                agreeOfRef: refs.size ? hit / refs.size : NaN,
                agreeOfCand: c.size ? hit / c.size : NaN,
                attested: c.size ? [...c].filter(t => countKey(t, e.text, false, false) > 0).length / c.size : NaN,
                grounded: c.size ? ([...c].some(t => countKey(t, e.text, false, false) > 0) ? 1 : 0) : 0,
            });
        }
        for (let i = 0; i < reps.length; i++) {
            for (let j = i + 1; j < reps.length; j++) stabilities.push(jaccard(reps[i], reps[j]));
        }
    }
    const col = k => mean(perEntry.map(x => x[k]).filter(Number.isFinite));
    const ucol = k => mean(unions.map(x => x[k]).filter(Number.isFinite));
    return {
        n: perEntry.length,
        unionYield: ucol('unionYield'),
        unionRef: ucol('unionRef'),
        yield: col('yield'),
        agreeOfRef: col('agreeOfRef'),
        agreeOfCand: col('agreeOfCand'),
        attested: col('attested'),
        grounded: col('grounded'),
        stability: mean(stabilities),
    };
}

// ---------------------------------------------------------------------------

const nEntries = Number(arg('entries', '8'));
const books = BOOKS.map(b => prepBook(b, nEntries));

if (arg('dump-prompts')) {
    const out = books.flatMap(b => b.entries.map(e => ({
        id: `${e.book}.${e.uid}`, book: e.book, uid: e.uid, title: e.title,
        truncated: e.truncated, keys: e.keys, prompt: e.prompt,
    })));
    writeFileSync(arg('dump-prompts'), JSON.stringify(out, null, 2));
    console.log(`wrote ${out.length} prompts to ${arg('dump-prompts')}`);
    console.log(books.map(b => `  ${b.slug}: ${b.entries.length} entries (${b.provenance})`).join('\n'));
    process.exit(0);
}

const temps = String(arg('temps', '0,0.3,0.7,1.0')).split(',').map(Number);
const repeats = Number(arg('repeats', '3'));
const model = arg('model');

// Extra arms from outside ollama (subagent runs, an ST-routed profile): a JSON array of
// {id, model, cands[]} or {id, model, raw} — one object per response, repeated ids meaning repeats.
// `raw` is preferred where the transport can give it, so the shipped parseKeyList does the splitting and an
// arm collected in the browser is scored by production's parser. `temp` labels a rung if the arm has one.
const extraArms = new Map();
for (const path of String(arg('extra', '')).split(',').filter(Boolean)) {
    for (const row of JSON.parse(readFileSync(path, 'utf8'))) {
        const label = `${row.model}@${row.temp ?? 'default'}`;
        if (!extraArms.has(label)) extraArms.set(label, []);
        const [book, uid] = String(row.id).split('.');
        const cands = Array.isArray(row.cands) ? row.cands : parseKeyList(row.raw ?? '');
        extraArms.get(label).push({ book, uid: isNaN(Number(uid)) ? uid : Number(uid), cands });
    }
}

if (model) {
    let made = 0, failed = 0;
    for (const t of temps) {
        for (let rep = 0; rep < repeats; rep++) {
            for (const b of books) {
                for (const e of b.entries) {
                    const key = `${model}${t}${rep}${hash(e.prompt)}`;
                    if (cache[key] !== undefined) continue;
                    try {
                        cache[key] = await askOllama(model, e.prompt, t);
                        made++;
                        if (made % 10 === 0) { saveCache(); process.stdout.write(`  ${model}: ${made} calls\n`); }
                    } catch (err) {
                        failed++;
                        console.error(`  FAIL ${model} T=${t} rep=${rep} ${e.book}.${e.uid}: ${err.message}`);
                    }
                }
            }
        }
    }
    saveCache();
    console.log(`${model}: ${made} new calls, ${failed} failed`);
}

// --- report -----------------------------------------------------------------

const models = [...new Set(Object.keys(cache).map(k => k.split('')[0]))];
const rows = [];

for (const m of models) {
    for (const t of temps) {
        for (const b of books) {
            const runs = [];
            for (let rep = 0; rep < repeats; rep++) {
                for (const e of b.entries) {
                    const raw = cache[`${m}${t}${rep}${hash(e.prompt)}`];
                    if (raw !== undefined) runs.push({ uid: e.uid, cands: parseKeyList(raw) });
                }
            }
            if (runs.length) rows.push({ arm: `${m}@T${t}`, book: b.slug, ...scoreArm(b, runs) });
        }
    }
}
for (const [label, runs] of extraArms) {
    for (const b of books) {
        const mine = runs.filter(r => r.book === b.slug);
        if (mine.length) rows.push({ arm: label, book: b.slug, ...scoreArm(b, mine) });
    }
}

if (!rows.length) {
    console.log('nothing cached yet — run with --model <name> first');
    process.exit(0);
}

console.log('\nresponses  = candidate lists scored (entries x repeats)');
console.log('yield      = mean candidates per response, after parseKeyList');
console.log('agree/ref  = share of the book\'s OWN keys the model proposed   [relative only]');
console.log('agree/cand = share of proposals that are already book keys      [relative only]');
console.log('attested   = share of proposals occurring in the entry text (countKey)');
console.log('grounded   = share of responses with at least one attested proposal (set-level predicate)');
console.log('stability  = mean pairwise Jaccard between repeats of one entry at one rung');
console.log('u-yield    = distinct candidates across ALL repeats (what re-clicking accumulates)');
console.log('u-ref      = book keys reached by the UNION of repeats   [the only breadth payoff]\n');

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`${pad('arm', 24)}${pad('book', 12)}${lpad('resp', 5)}${lpad('yield', 7)}${lpad('agree/ref', 11)}${lpad('agree/cand', 12)}${lpad('attested', 10)}${lpad('grounded', 10)}${lpad('stability', 11)}${lpad('u-yield', 9)}${lpad('u-ref', 8)}`);
for (const r of rows) {
    console.log(`${pad(r.arm, 24)}${pad(r.book, 12)}${lpad(r.n, 5)}${lpad(r.yield.toFixed(1), 7)}${lpad(fmt(r.agreeOfRef), 11)}${lpad(fmt(r.agreeOfCand), 12)}${lpad(fmt(r.attested), 10)}${lpad(fmt(r.grounded), 10)}${lpad(fmt(r.stability), 11)}${lpad(r.unionYield.toFixed(1), 9)}${lpad(fmt(r.unionRef), 8)}`);
}

// --- paired contrast against the T=0 rung ------------------------------------
//
// The pooled means above cannot support a claim on their own: entries vary far more than rungs do, and an
// unpaired mean hides that. So contrast each rung against the same entry's T=0 result and sign-test the
// per-entry deltas, the discipline param-screen.mjs applies to scenes. n is entries, not responses —
// repeats are averaged first, because several samples of one entry are not independent observations.
if (has('paired')) {
    // Every arm's per-entry candidate sets in one shape, so the ollama rungs and the outside arms
    // (an ST-routed profile ladder, a subagent) get the same treatment. Keyed arm -> "book.uid" ->
    // one Set per repeat.
    const armSets = new Map();
    const put = (arm, book, uid, set) => {
        if (!armSets.has(arm)) armSets.set(arm, new Map());
        const k = `${book}.${uid}`;
        const m = armSets.get(arm);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(set);
    };
    for (const m of models) {
        for (const t of temps) {
            for (const b of books) {
                for (const e of b.entries) {
                    for (let rep = 0; rep < repeats; rep++) {
                        const raw = cache[`${m}\x1f${t}\x1f${rep}\x1f${hash(e.prompt)}`];
                        if (raw !== undefined) put(`${m}@T${t}`, b.slug, e.uid, new Set(parseKeyList(raw).map(b.canon).filter(Boolean)));
                    }
                }
            }
        }
    }
    for (const [label, runs] of extraArms) {
        for (const b of books) {
            for (const r of runs.filter(x => x.book === b.slug)) {
                put(label, b.slug, r.uid, new Set(r.cands.map(b.canon).filter(Boolean)));
            }
        }
    }

    // An arm's baseline is its own model's lowest rung — across models this would be a model contrast,
    // not a temperature one.
    const familyOf = a => a.replace(/@.*$/, '');
    const rungOf = a => Number(String(a.split('@')[1] ?? '').replace(/^T/, ''));
    const refsFor = new Map();
    const textFor = new Map();
    for (const b of books) for (const e of b.entries) {
        refsFor.set(`${b.slug}.${e.uid}`, new Set(e.keys.map(b.canon).filter(Boolean)));
        textFor.set(`${b.slug}.${e.uid}`, e.text);
    }
    const metric = (sets, key, refs, text) => {
        const share = c => { let h = 0; for (const x of c) if (refs.has(x)) h++; return refs.size ? h / refs.size : NaN; };
        if (key === 'unionRef') return share(new Set(sets.flatMap(s => [...s])));
        if (key === 'unionYield') return new Set(sets.flatMap(s => [...s])).size;
        const per = sets.map(c => (key === 'agreeOfRef' ? share(c)
            : key === 'attested' ? (c.size ? [...c].filter(t => countKey(t, text, false, false) > 0).length / c.size : NaN)
                : c.size));
        return mean(per.filter(Number.isFinite));
    };
    const binomP = (k, n) => {
        if (!n) return NaN;
        const c = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1); return r; };
        let p = 0;
        for (let i = 0; i <= n; i++) { const pr = c(n, i) / 2 ** n; if (pr <= c(n, k) / 2 ** n + 1e-12) p += pr; }
        return Math.min(1, p);
    };

    console.log('\npaired vs each model\'s own lowest rung — per ENTRY, sign test (repeats collapsed first)');
    console.log(`${pad('arm', 20)}${pad('metric', 12)}${lpad('n', 4)}${lpad('better', 8)}${lpad('worse', 7)}${lpad('mean d', 9)}${lpad('p(2-sided)', 12)}`);
    const arms = [...armSets.keys()];
    for (const fam of [...new Set(arms.map(familyOf))]) {
        const rungs = arms.filter(a => familyOf(a) === fam).sort((a, b) => rungOf(a) - rungOf(b));
        if (rungs.length < 2 || !Number.isFinite(rungOf(rungs[0]))) continue;   // single-point arms have no ladder
        const base = rungs[0];
        for (const arm of rungs.slice(1)) {
            for (const key of ['agreeOfRef', 'attested', 'unionRef', 'unionYield']) {
                const deltas = [];
                for (const [id, sets] of armSets.get(arm)) {
                    const bs = armSets.get(base)?.get(id);
                    if (!bs?.length || !sets.length) continue;
                    const a = metric(bs, key, refsFor.get(id), textFor.get(id));
                    const z = metric(sets, key, refsFor.get(id), textFor.get(id));
                    if (Number.isFinite(a) && Number.isFinite(z)) deltas.push(z - a);
                }
                if (!deltas.length) continue;
                const better = deltas.filter(d => d > 0).length, worse = deltas.filter(d => d < 0).length;
                console.log(`${pad(arm, 20)}${pad(key, 12)}${lpad(deltas.length, 4)}${lpad(better, 8)}${lpad(worse, 7)}${lpad(mean(deltas).toFixed(4), 9)}${lpad(fmt(binomP(Math.min(better, worse), better + worse)), 12)}`);
            }
        }
    }
}

// Books pooled per arm — the per-book rows above are what says whether a trend is book-specific.
console.log('');
console.log(`${pad('arm (all books)', 24)}${pad('', 12)}${lpad('resp', 5)}${lpad('yield', 7)}${lpad('agree/ref', 11)}${lpad('agree/cand', 12)}${lpad('attested', 10)}${lpad('grounded', 10)}${lpad('stability', 11)}${lpad('u-yield', 9)}${lpad('u-ref', 8)}`);
for (const arm of [...new Set(rows.map(r => r.arm))]) {
    const rs = rows.filter(r => r.arm === arm);
    const w = k => mean(rs.map(r => r[k]).filter(Number.isFinite));
    console.log(`${pad(arm, 24)}${pad('', 12)}${lpad(rs.reduce((a, r) => a + r.n, 0), 5)}${lpad(w('yield').toFixed(1), 7)}${lpad(fmt(w('agreeOfRef')), 11)}${lpad(fmt(w('agreeOfCand')), 12)}${lpad(fmt(w('attested')), 10)}${lpad(fmt(w('grounded')), 10)}${lpad(fmt(w('stability')), 11)}${lpad(w('unionYield').toFixed(1), 9)}${lpad(fmt(w('unionRef')), 8)}`);
}
