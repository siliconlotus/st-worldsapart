// global-basis.mjs — the shared half of all-but-the-top: the mean and leading components of memory-tier
// prose across every other lineage, so a book's own leading directions can be measured after the generic
// ones are gone.
//
// A first stage exists because removing a book's top components straight off its own centred corpus does
// not remove what is unremarkable in that book — its mean is mostly shared mass, and its leading component
// sits largely inside a subspace built from other books' memory chunks (R15). Strip the shared part first
// and whatever leads the residual is the book's own.
//
// Memory tier only, archived included: whole-book PC1 is largely the memory-versus-reference axis (R17), so
// a mixed basis would make "generic" mean "register" and remove the tier distinction as its first act.
//
// Leave one lineage out, not one file — leaving out only the file puts near-copies of a book into its own
// "everyone else" (R17). scene.mjs lineagesOf does the grouping.
//
// Components are ranked by variance, which is not sharedness, so each one's eta^2 is recorded beside it:
// the between-lineage share of its projection's variance over the books the basis was built from. Low is
// shared across books, high separates them, and the two orderings disagree at the top on this corpus (R16),
// so a variance-ranked prefix removes the most book-specific direction first — the opposite of stage A's
// job. scene.mjs `sharedSelect` reads eta to select by sharedness instead. Weak at this n, and recorded
// rather than acted on for that reason (R17).
//
// Pooled, not equal-weighted per book: the shared component is a property of the model and of narrative
// prose, not of any book, so a bigger book is a better estimate of the same thing rather than a louder
// opinion. Equal-weighting hands the most influence to the least reliable means, while pooled and
// pooled-over-large-books-only agree almost exactly (R17).
//
// Usage (from eval/):
//   node global-basis.mjs <sample.json ...> [--m 8] [--force]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { corpusMean, norm } from '../plugin/vector.mjs';
import { topComponents } from './metrics.mjs';
import { openSample, lineagesOf, indexPath, sceneParams, getStringHash } from './scene.mjs';
import { cachePath, chunkConfig, resolveModel } from './reindex.mjs';
import { isMemory } from '../extension/relevance.mjs';

/** Where a book's basis lives. Keyed by the BOOK being scored, since that is all scene.mjs knows — the
 *  lineage exclusion is baked in at build time, when the other books are in hand.
 *
 *  The hash is of the full name, not of the truncated slug: two books can differ only past character 40, so
 *  a slug-only path would give one book the other's basis. */
export const basisPath = (book, model, within = false) => {
    if (!model) throw new Error('basisPath needs the model label — a basis is per model');
    return new URL(`./eval-data/basis/${String(book).replace(/[^\w.-]+/g, '-').slice(0, 40)}__${model}${within ? '__within' : ''}__${getStringHash(String(book))}.json`, import.meta.url).pathname;
};

/** Reads one book's basis. Returns null when absent — the caller decides whether that is fatal. */
export const loadBasis = (book, model, within = false) => {
    const p = basisPath(book, model, within);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    // `eta` rides along because it is what `sharedSelect: 'shared'` orders on; absent on a basis built
    // before it was recorded, which scene.mjs reports as a rebuild rather than silently falling back to
    // the variance order — the two orders disagree, so a quiet fallback would run the wrong arm.
    return { mean: Float64Array.from(j.mean), comps: j.comps.map(c => Float64Array.from(c)), eta: j.eta ?? null, meta: j.meta };
};

/** Memory-tier chunks of one sample's primary book, from the collection already on disk. */
const memoryChunks = (S, model) => {
    // Archived memory counts: this models what narrative prose looks like, not what can be retrieved, and a
    // summary the author retired is the same prose it was the day before. Excluding it shrinks the sample
    // unevenly, hardest on the books that are already thin (R17). So the collection wanted is the
    // `--archived` build, whose centroidOnly chunks are the disabled entries (reindex.mjs buildItems); a
    // book with no archived build falls back to the live collection rather than failing.
    //
    // The fallback is reported, not silent: missing the archived build costs half the sample on some books
    // and none on others, and produces a perfectly ordinary-looking basis either way. The caller logs
    // `archived`, and it goes in the meta so a stored basis says which pool estimated it.
    const cfg = chunkConfig(S);
    const archived = cachePath(S, cfg, model, S.primaryBook, true, true);
    const usingArchived = existsSync(archived);
    const file = usingArchived ? archived : indexPath(S, { model, all: sceneParams(S).denseAllEntries });
    if (!existsSync(file)) return null;
    const items = JSON.parse(readFileSync(file, 'utf8')).items;
    const mem = new Set(Object.values(S.books[S.primaryBook] ?? {})
        .filter(e => isMemory(e) && e.content).map(e => Number(e.uid)));
    const out = items.filter(i => mem.has(Number(i.metadata?.index)));
    out.archived = usingArchived;
    out.retired = Object.values(S.books[S.primaryBook] ?? {}).filter(e => isMemory(e) && e.content && e.disable).length;
    return out;
};

/** Each group centred on its own mean, pooled — the within-class scatter, as one flat list. */
export const groupResiduals = (groups) => groups.flatMap((g) => {
    const m = corpusMean(g);
    return g.map(it => ({ vector: Float64Array.from({ length: m.length }, (_, i) => it.vector[i] - m[i]) }));
});

/**
 * Per component, the between-lineage share of its projection's variance (eta^2) over the groups the basis
 * was built from — the sharedness statistic the variance ranking is not: a component every book varies
 * along scores near 0, one that offsets whole books scores near 1.
 *
 * @param {Array<Array<{vector: number[]}>>} groups Chunks, one array per lineage
 * @param {number[]} mean The basis mean
 * @param {number[][]} comps The components, in variance order
 * @returns {number[]} eta^2 per component, same order
 */
export const etaSquared = (groups, mean, comps) => comps.map((c) => {
    const proj = groups.map(g => g.map(it => { let p = 0; for (let i = 0; i < mean.length; i++) p += (it.vector[i] - mean[i]) * c[i]; return p; }));
    const all = proj.flat();
    const avg = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
    const gm = avg(all);
    const ssTot = all.reduce((s, x) => s + (x - gm) ** 2, 0);
    const ssBet = proj.reduce((s, g) => s + g.length * (avg(g) - gm) ** 2, 0);
    return ssTot > 0 ? ssBet / ssTot : 0;
});

export const buildBases = (samplePaths, { m = 8, model, within = false, force = false, log = () => {} } = {}) => {
    const byBook = new Map();
    for (const p of samplePaths) {
        const S = openSample(p);
        if (byBook.has(S.primaryBook)) continue;
        const chunks = memoryChunks(S, model);
        if (!chunks?.length) { log(`  no collection for "${S.primaryBook}" — skipped`); continue; }
        if (!chunks.archived && chunks.retired) log(`  !! "${S.primaryBook}": no --archived collection at these chunk settings, so its ${chunks.retired} retired memory entr(ies) are NOT in the pool`);
        byBook.set(S.primaryBook, { S, chunks });
    }
    if (byBook.size < 2) throw new Error(`a leave-one-out basis needs at least 2 books with collections; got ${byBook.size}`);
    const lin = lineagesOf(Object.fromEntries([...byBook].map(([b, v]) => [b, v.S.books[b]])));
    const written = [];
    for (const [book, v] of byBook) {
        const out = basisPath(book, model, within);
        if (!force && existsSync(out)) { written.push([book, 'cached']); continue; }
        // Grouped as well as pooled: the mean and the components come off the pooled chunks, eta^2 needs
        // them back in their lineages.
        const restByLin = new Map();
        for (const [o, x] of byBook) {
            if (lin.get(o) === lin.get(book)) continue;
            const L = lin.get(o);
            if (!restByLin.has(L)) restByLin.set(L, []);
            restByLin.get(L).push(...x.chunks);
        }
        const rest = [...restByLin.values()].flat();
        if (!rest.length) { log(`  "${book}" is the only book in its lineage group — no basis possible, skipped`); continue; }
        const mean = corpusMean(rest);
        // Which scatter the directions come off, a different question from where the corpus sits: the mean
        // is the pooled centroid either way. `within` takes the directions off the pooled within-book
        // scatter instead of the raw pool — each lineage centred on its own mean first, so a direction that
        // merely separates books cannot lead. It collapses PC1's eta^2 and shrinks its variance share (R17),
        // the gap being the between-book separation PCA was ranking on.
        //
        // Not LDA, the other half of the same decomposition: LDA maximises between-class over within-class,
        // so its discriminants are the book axes, it is rank-capped at (classes - 1) — short of the doses
        // the arms sweep — and it folds the per-book directions stage B needs separable into one space.
        const comps = within
            ? topComponents(groupResiduals([...restByLin.values()]), m, new Float64Array(mean.length))
            : topComponents(rest, m, mean);
        const eta = etaSquared([...restByLin.values()], mean, comps);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({
            mean: [...mean],
            comps: comps.map(c => [...c]),
            eta,
            // What it was built from, because a basis is only comparable to collections chunked the same way
            // and the only tell of a stale one is its chunk count running high over what the indexes hold
            // (R17). `fromSamples` names the bundles because which snapshot of a book a bundle embeds
            // decides which memory uids are in the pool.
            meta: { model, chunkCfg: chunkConfig(v.S), fromSamples: samplePaths.map(x => x.split('/').pop()),
                scatter: within ? 'within' : 'pooled',
                archivedPool: [...byBook].filter(([o]) => lin.get(o) !== lin.get(book)).every(([, x]) => x.chunks.archived),
                m: comps.length, askedM: m, chunks: rest.length,
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
        console.error('usage: node global-basis.mjs <sample.json ...> [--m 8] [--model <spec>] [--force]');
        console.error('builds one leave-one-LINEAGE-out basis per book, from memory-tier chunks of the collections already on disk');
        console.error('  --model takes a modelSpec, so a server stem is honoured: omlx:Qwen3-Embedding-8B-4bit-DWQ');
        console.error('  --within takes the components off the pooled WITHIN-book scatter, so a book-separating direction cannot lead');
        process.exit(2);
    }
    const m = Number(argv[argv.indexOf('--m') + 1]) || 8;
    // The label, not the spec: it names a collection (cachePath) and so must name the basis built from one.
    // The same weights at another quantization are other vectors, and models differ in dimension outright,
    // so a basis is only meaningful against the collection it was estimated on.
    const spec = (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null) ?? process.env.WA_EMBED_MODEL;
    if (!spec) { console.error('no model: pass --model or set WA_EMBED_MODEL — a basis is per model'); process.exit(2); }
    const model = resolveModel(spec).label;
    const within = argv.includes('--within');
    console.log(`building bases at m=${m} under "${model}"${within ? ', WITHIN-book scatter' : ''} from ${samples.length} sample(s)`);
    const w = buildBases(samples, { m, model, within, force: argv.includes('--force'), log: s => console.log(s) });
    console.log(`\n${w.length} basis file(s):`);
    for (const [b, note] of w) console.log(`  ${b.slice(0, 44).padEnd(46)} ${note}`);
}
