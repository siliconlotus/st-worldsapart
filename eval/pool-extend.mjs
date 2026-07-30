// pool-extend.mjs — find the entries an OFFLINE arm would surface that nobody has graded, and ask for them.
//
// WHY THIS EXISTS SEPARATELY FROM /wa-super-grade. That command widens the judged pool by capturing several
// live configurations, which works for anything the extension can vary at query time. It cannot reach the
// chunk settings: changing chunkSize or minChunkSize changes what gets EMBEDDED, so covering them live would
// mean re-vectorizing the lorebook mid-capture, twice per arm, against the user's real collection.
//
// So every chunk arm in paired-arms.mjs is scored against a pool collected under ONE chunking, and any entry
// a different chunking surfaces counts as irrelevant because nobody looked at it. That biases chunk arms
// downward, systematically, and the bias grows with distance from the live settings — which is precisely the
// region the sweep exists to explore. Measured on three scenes, every chunk cell was a lower bound.
//
// The fix is the same iterative pooling loop, driven by rebuilt indexes instead of live captures: score each
// dose offline, take the top-k it would actually deploy, union across doses, subtract what is already judged,
// and emit the remainder as a grading request. /wa-super-grade's file picker accepts the emitted file and
// folds those entries into its table, so they get graded alongside the live arms and land in the same
// accumulated grade set. Re-run this afterwards and the list should be empty.
//
// Usage (from SillyTavern root):
//   node .../pool-extend.mjs <sample.json> [more.json ...] [--arms chunkSize=200,chunkSize=400] [--k 10]
//                            [--out-dir <dir>] [--dry]
//
// Defaults to the whole chunk ladder, since that is the part live pooling cannot cover. Building the indexes
// is the slow step; they are cached by book + model + chunk settings, so a second run is nearly free.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { scoreScene, loadScene, indexPath, openSample, sceneParams, embed } from './scene.mjs';
import { ensureIndex } from './reindex.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));

// The doses live pooling can't reach. Same values as paired-arms.mjs's ladder — they have to match, or the
// pool would be extended for configurations nobody is going to score.
const CHUNK_ARMS = {
    ...Object.fromEntries([200, 300, 400, 600, 1200, 1600, 2400].map(v => [`chunkSize=${v}`, { chunkSize: v }])),
    ...Object.fromEntries([0, 60, 120, 200, 300, 500].map(v => [`minChunk=${v}`, { minChunkSize: v }])),
    'chunkMode=length': { chunkMode: 'length' },
};

if (!samples.length) {
    console.error('need at least one sample: node pool-extend.mjs <sample.json> [more.json ...] [--arms a,b] [--k 10] [--out-dir <dir>] [--dry]');
    console.error('writes <name>-pending.json next to each sample: the entries an offline arm would surface that nobody has graded.');
    process.exit(2);
}
const picked = arg('--arms') ? String(arg('--arms')).split(',').map(x => x.trim()).filter(Boolean) : Object.keys(CHUNK_ARMS);
const unknown = picked.filter(a => !CHUNK_ARMS[a]);
if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — known: ${Object.keys(CHUNK_ARMS).join(', ')}`); process.exit(2); }

const K = Number(arg('--k') ?? 10);
const MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DRY = argv.includes('--dry');

(async () => {
    let grandTotal = 0;
    for (const path of samples) {
        const S = openSample(path, arg('--arm'));
        if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`${path}: no embedded entries for "${S.primaryBook}" — needs a 'full' capture`); continue; }
        const scene = loadScene(S, { indexFile: indexPath(S, { model: MODEL }), params: sceneParams(S) });
        const qv = await embed(S.query, { ollama: OLLAMA, model: MODEL });

        // uid -> { title, doses[], bestRank }. Keyed by uid because that is what a grade is keyed by; the
        // title is carried for the human and is NOT the identity (titles get edited).
        const wanted = new Map();
        const note = (rows, arm) => {
            for (const r of rows) {
                const hit = wanted.get(r.uid) ?? { uid: r.uid, title: r.title, doses: [], bestRank: Infinity };
                hit.doses.push(arm);
                hit.bestRank = Math.min(hit.bestRank, r.rank);
                wanted.set(r.uid, hit);
            }
        };

        // The sample's own configuration counts as a dose: its top-k can contain unjudged rows too (a
        // re-derived ranking is not the captured one), and those are the cheapest coverage to buy.
        const base = await scoreScene({ sample: S, k: K, scene, qv });
        note(base.unjudgedRows, 'baseline');

        for (const arm of picked) {
            const built = await ensureIndex(S, { overrides: CHUNK_ARMS[arm], model: MODEL, ollama: OLLAMA, log: () => {} });
            const r = await scoreScene({ sample: S, overrides: {}, k: K, index: built.path, model: MODEL, ollama: OLLAMA, qv });
            note(r.unjudgedRows, arm);
            process.stdout.write(`\r  ${S.name ?? basename(path)}: scored ${arm}                    `);
        }
        process.stdout.write('\r');

        const rows = [...wanted.values()].sort((a, b) => a.bestRank - b.bestRank);
        grandTotal += rows.length;
        console.log(`${S.name ?? basename(path)}: ${rows.length} ungraded entr${rows.length === 1 ? 'y' : 'ies'} surfaced by ${picked.length} dose(s) + baseline, over top-${K}`);
        for (const r of rows.slice(0, 12)) console.log(`  uid ${String(r.uid).padStart(5)}  #${String(r.bestRank).padStart(2)}  ${r.title.slice(0, 44).padEnd(44)} ${r.doses.length > 3 ? `${r.doses.length} doses` : r.doses.join(', ')}`);
        if (rows.length > 12) console.log(`  … and ${rows.length - 12} more`);
        if (!rows.length) { console.log('  pool already covers every dose — chunk arms on this scene are measurements, not lower bounds.'); continue; }

        if (DRY) continue;
        const outDir = arg('--out-dir') ?? dirname(path);
        const out = `${outDir}/${basename(path, '.json')}-pending.json`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(out, `${JSON.stringify({
            // `pending` is what /wa-super-grade's file picker keys on to tell this from a prior sample.
            pending: rows.map(r => ({ world: S.primaryBook, uid: r.uid, title: r.title, bestRank: r.bestRank, doses: r.doses })),
            forSample: S.name ?? basename(path),
            primaryBook: S.primaryBook,
            k: K,
            arms: picked,
            createdAt: new Date().toISOString().slice(0, 10),
            note: 'Entries an offline chunk arm would rank in its top-k that nobody has graded. Load into /wa-super-grade alongside the prior samples; they will appear in the grading table.',
        }, null, 2)}\n`);
        console.log(`  -> ${out}`);
    }

    if (grandTotal) {
        console.log(`\n${grandTotal} ungraded entr${grandTotal === 1 ? 'y' : 'ies'} across ${samples.length} scene(s). Load the -pending.json files into /wa-super-grade`);
        console.log('(same picker as the prior samples), grade them, then re-run paired-arms.mjs — the chunk cells should lose their "?".');
    } else {
        console.log('\nnothing to grade: every dose\'s top-k is already judged on every scene.');
    }
})();
