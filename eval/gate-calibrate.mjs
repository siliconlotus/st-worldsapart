// gate-calibrate.mjs — re-measures `uncenteredGate` (extension/state.mjs) for one embedding model.
//
// THE GATE IS THE ONLY THING AT STAGE 1 THAT DROPS A CHUNK, and stage 1 is the only place an entry can
// enter, so a chunk it drops is unrecoverable downstream. Its value is a RAW cosine — centring subtracts
// the book's own mean, which is exactly what makes a centred score unable to answer "is this the wrong
// book?", since every book has above-average chunks. Raw cosine scale is a property of the model's
// anisotropy, so this number does not survive a model change and has to be re-measured rather than
// carried over. bge-m3 is 1024-dimensional and Qwen3-Embedding-8B is 4096.
//
// THE EXPERIMENT, as the shipped 0.5 was calibrated: a scene's relevant entries (grade >= 3) in its OWN
// book, scored raw against the query, versus the best any DELIBERATELY UNRELATED book manages on the same
// query. The foreign pool is eval-data/public-lorebooks — third-party books never played here. Reported
// per foreign book, because genre is the variable: a same-genre wrong book (same author, same idiom)
// clears any raw-cosine gate, and this knob has never claimed to catch those.
//
// READ THE COST TABLE, NOT THE SEPARATION. The bge-m3 calibration did not separate cleanly either —
// relevant >= 0.538 against wrong-genre topping out at 0.47-0.54 — and 0.5 was chosen because it cut
// contamination from 10-19 entries to 0-2 at no cost to a real scene. So the question a re-calibration
// answers is what each candidate value COSTS in true positives, not whether some value is perfect.
//
// Usage (from eval/):
//   node gate-calibrate.mjs [modelSpec]          default omlx:Qwen3-Embedding-8B-4bit-DWQ
//
// Foreign embeddings are cached beside the tool, since re-running must not re-pay for them.
const R = '/Users/delumine/SillyTavern-launcher/SillyTavern/public/scripts/extensions/third-party/WorldsApart';
const { openSample } = await import(`${R}/eval/scene.mjs`);
const { resolveModel, cachePath, chunkConfig, embedTexts } = await import(`${R}/eval/reindex.mjs`);
const { chunkEntry } = await import(`${R}/extension/chunking.mjs`);
const { gradeValue } = await import(`${R}/eval/metrics.mjs`);
const fs = await import('node:fs');
const em = resolveModel(process.argv[2] ?? 'omlx:Qwen3-Embedding-8B-4bit-DWQ');
const CACHE = new URL(`./eval-data/foreign-pool-${em.label}.json`, import.meta.url).pathname;
const CFG = { chunkMode: 'paragraph', chunkSize: 1750, minChunkSize: 120 };
const dot = (a, b) => { let s = 0; for (let i = 0; i < b.length; i++) s += a[i] * b[i]; return s; };
const unit = a => { const n = Math.sqrt(dot(a, a)) || 1; return a.map(x => x / n); };

// --- the foreign pool, embedded once and cached (an embed call costs, so a re-run must be free) ---
let foreign;
if (fs.existsSync(CACHE)) { foreign = JSON.parse(fs.readFileSync(CACHE, 'utf8')); }
else {
    foreign = {};
    for (const f of fs.readdirSync(`${R}/eval/eval-data/public-lorebooks`).filter(x => x.endsWith(".json"))) {
        const name = f.replace(/^main_|_world_info\.json$/g, '').replace(/-[0-9a-f]{8,}$/, '');
        const es = Object.values(JSON.parse(fs.readFileSync(`${R}/eval/eval-data/public-lorebooks/${f}`, 'utf8')).entries ?? {});
        const texts = es.flatMap(e => chunkEntry(String(e.content ?? ''), CFG)).map(t => t.trim()).filter(Boolean);
        process.stderr.write(`embedding ${texts.length} chunks of ${name}\n`);
        const vecs = [];
        for (let i = 0; i < texts.length; i += 32) vecs.push(...await embedTexts(texts.slice(i, i + 32).map(t => em.doc + t), { model: em.model, endpoint: em.endpoint, url: em.url }));
        foreign[name] = vecs.map(unit);
    }
    fs.writeFileSync(CACHE, JSON.stringify(foreign));
}
const names = Object.keys(foreign);
console.log(`model ${em.label};  foreign pool: ${names.map(n => `${n} (${foreign[n].length} chunks)`).join(', ')}\n`);

const SCENES = ['sommers-abo-frozen-test-msg5472.json', 'isekai-adventure-time-whore-frozen-sampl-msg16300.json',
    'ascensus-syn-msg1645.json', 'richard-syn-msg1037.json',
    'you-re-a-doll-at-the-panopticon-2026-02-msg42.json', 'isekai-time-whore-frozen-2-msg3728.json'];
console.log('scene'.padEnd(32) + 'worst relevant   ' + names.map(n => n.slice(0, 11).padStart(13)).join(''));
const ALLREL = [];
const relMins = [], perBook = Object.fromEntries(names.map(n => [n, []]));
for (const file of SCENES) {
    let S; try { S = openSample(`${R}/eval/eval-data/${file}`); } catch { continue; }
    const p = cachePath(S, chunkConfig(S), em.label, S.primaryBook, true, false);
    if (!fs.existsSync(p) || !S.query) continue;
    const qv = unit((await embedTexts([em.query + S.query], { model: em.model, endpoint: em.endpoint, url: em.url }))[0]);
    const rel = new Set((S.entries ?? []).filter(g => gradeValue(g) >= 3 && (!g.book || g.book === S.primaryBook)).map(g => Number(g.uid)));
    const best = new Map();
    for (const it of JSON.parse(fs.readFileSync(p, 'utf8')).items) { const u = Number(it.metadata?.index); if (!rel.has(u)) continue; best.set(u, Math.max(best.get(u) ?? -1, dot(unit(it.vector), qv))); }
    if (!best.size) continue;
    const relMin = Math.min(...best.values()); relMins.push(relMin);
    for (const v of best.values()) ALLREL.push(v);
    const maxes = names.map(n => { let m = -1; for (const v of foreign[n]) { const c = dot(v, qv); if (c > m) m = c; } perBook[n].push(m); return m; });
    console.log(file.slice(0, 30).padEnd(32) + relMin.toFixed(3).padStart(14) + '   ' + maxes.map(m => m.toFixed(3).padStart(13)).join(''));
}
const lo = Math.min(...relMins);
console.log(`\nworst relevant across scenes: ${lo.toFixed(4)}`);
for (const n of names) console.log(`  ${n.slice(0, 30).padEnd(32)} tops out at ${Math.max(...perBook[n]).toFixed(4)}`);
const hi = Math.max(...names.map(n => Math.max(...perBook[n])));
for (const g of [0.5, 0.45, 0.4, 0.0]) {
    const cut = ALLREL.filter(v => v < g).length;
    const foreignCut = names.flatMap(n => perBook[n]).filter(v => v < g).length;
    console.log(`  gate ${g.toFixed(2)}: drops ${cut}/${ALLREL.length} relevant entries, and ${foreignCut}/${names.length * relMins.length} foreign scene-maxima`);
}
console.log(lo > hi ? `\nSEPARATED: any gate in (${hi.toFixed(3)}, ${lo.toFixed(3)}) works; midpoint ${((lo + hi) / 2).toFixed(3)}`
    : `\nNOT separated: best foreign ${hi.toFixed(4)} >= worst relevant ${lo.toFixed(4)}`);
