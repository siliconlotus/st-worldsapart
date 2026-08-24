// global-basis.mjs — the SHARED half of all-but-the-top: the mean and leading components of memory-tier
// prose across every OTHER lineage, so a book's own leading directions can be measured after the generic
// ones are gone.
//
// WHY A FIRST STAGE EXISTS AT ALL. Removing a book's top components straight off its own centred corpus
// does not remove "what is unremarkable in this book" — **measured**, a book's mean carries only 8-16% of
// its mass orthogonal to the shared direction on the long narrative books, and its leading component sits
// 0.55-0.77 inside a subspace built from other books' memory chunks. So single-stage pcRemove takes mostly
// common structure, and it scored NEGATIVE on the delivered set for exactly that reason (F2 -0.0038 at
// k=1 over 103 scenes). Strip the shared part first and whatever leads the residual is the book's own.
//
// MEMORY TIER ONLY. Whole-book PC1 is largely the memory-versus-reference axis — **measured** at 0.89 on
// Time Whore, 0.94 on one Ascensus file — which every book has, so a mixed basis would make "generic" mean
// "register" and remove the tier distinction as its first act.
//
// LEAVE ONE LINEAGE OUT, not one file. Three names in this corpus are the same Ascensus at 92-100%
// identical bodies; leaving out only the file puts two near-copies of a book into its own "everyone else",
// which moved one alignment from 0.83 to 0.77 when fixed. scene.mjs lineagesOf does the grouping.
//
// POOLED, NOT EQUAL-WEIGHTED PER BOOK. The shared component is a property of the model and of narrative
// prose, not of any book, so a bigger book is a better estimate of the same thing rather than a louder
// opinion. Equal-weighting hands the most influence to the least reliable means: **measured** split-half
// error is 0.13-0.14 on the 58-101 chunk books against 0.023 on Time Whore. It costs little — pooled and
// pooled-over-books-with-500+-chunks agree at cosine 0.99955, so pooling already behaves like "use the
// well-estimated ones".
//
// Usage (from eval/):
//   node global-basis.mjs <sample.json ...> [--m 8] [--force]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { corpusMean, norm } from '../plugin/vector.mjs';
import { topComponents } from './metrics.mjs';
import { openSample, lineagesOf, indexPath, sceneParams, getStringHash } from './scene.mjs';
import { isMemory } from '../extension/relevance.mjs';

/** Where a book's basis lives. Keyed by the BOOK being scored, since that is all scene.mjs knows — the
 *  lineage exclusion is baked in at build time, when the other books are in hand.
 *
 *  THE HASH IS OF THE FULL NAME, not of the truncated slug: two of this corpus's books differ only past
 *  character 40 (`LTM - Isekai Adventure - Isekai Adventure - 2026-03-04@14h45` and the same with ` old`),
 *  so a slug-only path silently gave one book the other's basis. Harmless while they share a lineage and a
 *  latent wrong answer the moment they do not. */
export const basisPath = (book, model = 'bge-m3') =>
    new URL(`./eval-data/basis/${String(book).replace(/[^\w.-]+/g, '-').slice(0, 40)}__${model}__${getStringHash(String(book))}.json`, import.meta.url).pathname;

/** Reads one book's basis. Returns null when absent — the caller decides whether that is fatal. */
export const loadBasis = (book, model = 'bge-m3') => {
    const p = basisPath(book, model);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { mean: Float64Array.from(j.mean), comps: j.comps.map(c => Float64Array.from(c)), meta: j.meta };
};

/** Memory-tier chunks of one sample's primary book, from the collection already on disk. */
const memoryChunks = (S, model) => {
    const file = indexPath(S, { model, all: sceneParams(S).denseAllEntries });
    if (!existsSync(file)) return null;
    const items = JSON.parse(readFileSync(file, 'utf8')).items.filter(i => !i.metadata?.centroidOnly);
    const mem = new Set(Object.values(S.books[S.primaryBook] ?? {})
        .filter(e => isMemory(e) && !e.disable && e.content).map(e => Number(e.uid)));
    return items.filter(i => mem.has(Number(i.metadata?.index)));
};

export const buildBases = (samplePaths, { m = 8, model = 'bge-m3', force = false, log = () => {} } = {}) => {
    const byBook = new Map();
    for (const p of samplePaths) {
        const S = openSample(p);
        if (byBook.has(S.primaryBook)) continue;
        const chunks = memoryChunks(S, model);
        if (!chunks?.length) { log(`  no collection for "${S.primaryBook}" — skipped`); continue; }
        byBook.set(S.primaryBook, { S, chunks });
    }
    if (byBook.size < 2) throw new Error(`a leave-one-out basis needs at least 2 books with collections; got ${byBook.size}`);
    const lin = lineagesOf(Object.fromEntries([...byBook].map(([b, v]) => [b, v.S.books[b]])));
    const written = [];
    for (const [book, v] of byBook) {
        const out = basisPath(book, model);
        if (!force && existsSync(out)) { written.push([book, 'cached']); continue; }
        const rest = [...byBook].filter(([o]) => lin.get(o) !== lin.get(book)).flatMap(([, x]) => x.chunks);
        if (!rest.length) { log(`  "${book}" is the only book in its lineage group — no basis possible, skipped`); continue; }
        const mean = corpusMean(rest);
        const comps = topComponents(rest, m, mean);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({
            mean: [...mean],
            comps: comps.map(c => [...c]),
            meta: { model, m: comps.length, askedM: m, chunks: rest.length,
                excludedLineage: lin.get(book), fromLineages: [...new Set([...byBook.keys()].map(b => lin.get(b)))].filter(l => l !== lin.get(book)),
                meanNorm: norm(mean) },
        }));
        written.push([book, `${rest.length} chunks, ${comps.length} comps, mean norm ${norm(mean).toFixed(4)}`]);
        log(`  ${book.slice(0, 40).padEnd(42)} <- ${rest.length} chunks from ${[...new Set([...byBook.keys()].map(b => lin.get(b)))].length - 1} other lineage(s)`);
    }
    return written;
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const argv = process.argv.slice(2);
    const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
    if (!samples.length) {
        console.error('usage: node global-basis.mjs <sample.json ...> [--m 8] [--force]');
        console.error('builds one leave-one-LINEAGE-out basis per book, from memory-tier chunks of the collections already on disk');
        process.exit(2);
    }
    const m = Number(argv[argv.indexOf('--m') + 1]) || 8;
    console.log(`building bases at m=${m} from ${samples.length} sample(s)`);
    const w = buildBases(samples, { m, force: argv.includes('--force'), log: s => console.log(s) });
    console.log(`\n${w.length} basis file(s):`);
    for (const [b, note] of w) console.log(`  ${b.slice(0, 44).padEnd(46)} ${note}`);
}
