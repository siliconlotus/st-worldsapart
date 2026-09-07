// pool-extend.mjs — find the entries an offline arm would surface that nobody has graded, and ask for them.
//
// Separate from /wa-super-grade, which widens the judged pool by capturing several live configurations and
// so cannot reach the chunk settings: changing chunkSize or minChunkSize changes what gets embedded, which
// would mean re-vectorizing the lorebook mid-capture against the user's real collection. So every chunk arm
// in param-screen.mjs is scored against a pool collected under one chunking, and any entry a different
// chunking surfaces counts as irrelevant because nobody looked at it — a downward bias that grows with
// distance from the live settings, which is the region the sweep exists to explore (H9).
//
// The fix is the same iterative pooling loop driven by rebuilt indexes: score each dose offline, take the
// top-k it would deploy, union across doses, subtract what is already judged, and emit the remainder as a
// grading request. /wa-super-grade's file picker accepts the emitted file and folds those entries into its
// table. Re-run this afterwards and the list should be empty.
//
// Usage (from SillyTavern root):
//   node .../pool-extend.mjs <sample.json> [more.json ...] [--arms chunkSize=200,chunkSize=400] [--k 10]
//                            [--out-dir <dir>] [--dry]
//
// Defaults to the whole chunk ladder, since that is the part live pooling cannot cover. Building the indexes
// is the slow step; they are cached by book + model + chunk settings, so a second run is nearly free.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { entryKey } from '../extension/content-lexical.mjs';
import { scoreScene, loadScene, indexPath, openSample, sceneParams, embed, sceneLabel } from './scene.mjs';
import { ensureIndex, resolveModel } from './reindex.mjs';
import { arg } from './metrics.mjs';

const argv = process.argv.slice(2);
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));

// The doses live pooling can't reach. Same values as param-screen.mjs's ladder — they have to match, or the
// pool would be extended for configurations nobody is going to score.
const CHUNK_ARMS = {
    ...Object.fromEntries([200, 300, 400, 600, 1200, 1600, 2400].map(v => [`chunkSize=${v}`, { chunkSize: v }])),
    ...Object.fromEntries([0, 60, 120, 200, 300, 500].map(v => [`minChunk=${v}`, { minChunkSize: v }])),
    'chunkMode=length': { chunkMode: 'length' },
};

// No query-time arms: the KEYW/LEXW set described the RRF fusion, which no longer exists, so those arms
// could only ever surface the baseline's own rows. Chunk arms are what live pooling cannot reach, and they
// are the whole of this tool's default set.

if (!samples.length) {
    console.error('need at least one sample: node pool-extend.mjs <sample.json> [more.json ...] [--arms a,b] [--k 10] [--out-dir <dir>] [--dry]');
    console.error('writes <name>-pending.json next to each sample: the entries an offline arm would surface that nobody has graded.');
    process.exit(2);
}
const picked = arg(argv, '--arms') ? String(arg(argv, '--arms')).split(',').map(x => x.trim()).filter(Boolean) : Object.keys(CHUNK_ARMS);
const unknown = picked.filter(a => !CHUNK_ARMS[a]);
if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — known: ${Object.keys(CHUNK_ARMS).join(', ')}`); process.exit(2); }

const K = Number(arg(argv, '--k') ?? 10);
// The model is a spec, resolved once (reindex.mjs resolveModel): the label names collections and bases, the
// rest says how to call the model, including the task prefix a prefix-trained family needs. A bare name is
// an ollama model. Falls back to the bundle's own model, never a hardcoded name — a hardcoded one resolves
// collections that exist for a corpus that has moved on, so nothing errors and the previous model is
// quietly measured (H3).
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0], arg(argv, '--arm')).embedModel;
if (!MODEL) { console.error(`${samples[0]} records no embedModel — set WA_EMBED_MODEL`); process.exit(2); }
const EM = resolveModel(MODEL);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DRY = argv.includes('--dry');

(async () => {
    let grandTotal = 0;
    for (const path of samples) {
        const S = openSample(path, arg(argv, '--arm'));
        if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`${path}: no embedded entries for "${S.primaryBook}" — a bundle that does not embed its books is malformed`); continue; }
        // `all` from the scene's own params, which default it on: a denseAllEntries scene cannot be scored
        // against a vectorized-only build.
        const P = sceneParams(S);
        const scene = loadScene(S, { indexFile: indexPath(S, { model: EM.label, all: P.denseAllEntries }), indexOpts: { model: EM.label }, params: P });
        const qv = await embed(EM.query + S.query, { ollama: OLLAMA, model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url });

        // (book, uid) -> { title, doses[], bestRank }. Keyed the way a grade is keyed — every attached book
        // is ranked and two books number their uids from 0, so a bare-uid map merges two entries into one
        // pending row. The title is carried for the human and is not the identity.
        const wanted = new Map();
        const note = (rows, arm) => {
            for (const r of rows) {
                const key = entryKey({ world: r.book ?? S.primaryBook, uid: r.uid });
                const hit = wanted.get(key) ?? { uid: r.uid, book: r.book ?? S.primaryBook, title: r.title, doses: [], bestRank: Infinity };
                hit.doses.push(arm);
                hit.bestRank = Math.min(hit.bestRank, r.rank);
                wanted.set(key, hit);
            }
        };

        // The sample's own configuration counts as a dose: its top-k can contain unjudged rows too (a
        // re-derived ranking is not the captured one), and those are the cheapest coverage to buy.
        const base = await scoreScene({ sample: S, k: K, scene, qv });
        note(base.unjudgedRows, 'baseline');

        for (const arm of picked) {
            // Every arm here changes what gets embedded, so each needs its own collection.
            const r = await scoreScene({ sample: S, overrides: {}, k: K, model: MODEL, ollama: OLLAMA, qv,
                index: (await ensureIndex(S, { overrides: CHUNK_ARMS[arm], model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url, ollama: OLLAMA, log: () => {} })).path });
            note(r.unjudgedRows, arm);
            process.stdout.write(`\r  ${sceneLabel(S) || basename(path)}: scored ${arm}                    `);
        }
        process.stdout.write('\r');

        const rows = [...wanted.values()].sort((a, b) => a.bestRank - b.bestRank);
        grandTotal += rows.length;
        console.log(`${sceneLabel(S) || basename(path)}: ${rows.length} ungraded entr${rows.length === 1 ? 'y' : 'ies'} surfaced by ${picked.length} dose(s) + baseline, over top-${K}`);
        for (const r of rows.slice(0, 12)) console.log(`  ${r.book === S.primaryBook ? '' : `${r.book} `}uid ${String(r.uid).padStart(5)}  #${String(r.bestRank).padStart(2)}  ${r.title.slice(0, 44).padEnd(44)} ${r.doses.length > 3 ? `${r.doses.length} doses` : r.doses.join(', ')}`);
        if (rows.length > 12) console.log(`  … and ${rows.length - 12} more`);
        if (!rows.length) { console.log('  pool already covers every dose — chunk arms on this scene are measurements, not lower bounds.'); continue; }

        if (DRY) continue;
        const outDir = arg(argv, '--out-dir') ?? dirname(path);
        const out = `${outDir}/${basename(path, '.json')}-pending.json`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(out, `${JSON.stringify({
            // `pending` is what /wa-super-grade's file picker keys on to tell this from a prior sample.
            pending: rows.map(r => ({ book: r.book, uid: r.uid, title: r.title, bestRank: r.bestRank, doses: r.doses })),
            forScene: sceneLabel(S) || basename(path),
            primaryBook: S.primaryBook,
            k: K,
            arms: picked,
            createdAt: new Date().toISOString(),
            note: 'Entries an offline arm would rank in its top-k that nobody has graded. Load into /wa-super-grade alongside the prior samples; they will appear in the grading table.',
        }, null, 2)}\n`);
        console.log(`  -> ${out}`);
    }

    if (grandTotal) {
        console.log(`\n${grandTotal} ungraded entr${grandTotal === 1 ? 'y' : 'ies'} across ${samples.length} scene(s). Load the -pending.json files into /wa-super-grade`);
        console.log('(same picker as the prior samples), grade them, then re-run param-screen.mjs — the chunk cells should lose their "?".');
    } else {
        console.log('\nnothing to grade: every dose\'s top-k is already judged on every scene.');
    }
})();
