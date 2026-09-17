// global-basis.mjs — the shared half of all-but-the-top: the mean and leading components of memory-tier prose across every OTHER lineage, per book.
// Leave one LINEAGE out, not one file; memory tier only, archived included (R17).
// Usage (from eval/):
//   node global-basis.mjs <sample.json ...> [--m 8] [--force]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { corpusMean, norm } from '../../plugin/vector.mjs';
import { topComponents } from './metrics.mjs';
import { openSample, lineagesOf, indexPath, sceneParams, getStringHash } from './scene.mjs';
import { cachePath, chunkConfig, resolveModel } from './reindex.mjs';
import { isMemory } from '../../extension/relevance.mjs';
import { fileURLToPath } from 'node:url';

/** Where a book's basis lives, keyed by the book being scored; the hash is of the full name because two books can differ only past character 40. */
const basisPath = (book, model, within = false) => {
    if (!model) throw new Error('basisPath needs the model label — a basis is per model');
    return fileURLToPath(new URL(`../eval-data/basis/${String(book).replace(/[^\w.-]+/g, '-').slice(0, 40)}__${model}${within ? '__within' : ''}__${getStringHash(String(book))}.json`, import.meta.url));
};

/** Reads one book's basis. Returns null when absent — the caller decides whether that is fatal. */
export const loadBasis = (book, model, within = false) => {
    const p = basisPath(book, model, within);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    // eta is what sharedSelect: 'shared' orders on; absent on an older basis, which scene.mjs reports as a rebuild rather than falling back to the variance order.
    return { mean: Float64Array.from(j.mean), comps: j.comps.map(c => Float64Array.from(c)), eta: j.eta ?? null, meta: j.meta };
};

/** Memory-tier chunks of one sample's primary book, from the collection already on disk. */
const memoryChunks = (S, model) => {
    // The --archived build when present, else the live collection; which one is reported, since a basis looks ordinary either way.
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
const groupResiduals = (groups) => groups.flatMap((g) => {
    const m = corpusMean(g);
    return g.map(it => ({ vector: Float64Array.from({ length: m.length }, (_, i) => it.vector[i] - m[i]) }));
});

/** Per component, the between-lineage share of its projection's variance (eta^2) over `groups` (one array per lineage): near 0 is shared, near 1 offsets whole books. */
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
        // within: directions off the pooled within-book scatter (each lineage centred first), so a book-separating direction cannot lead; the mean is the pooled centroid either way.
        const comps = within
            ? topComponents(groupResiduals([...restByLin.values()]), m, new Float64Array(mean.length))
            : topComponents(rest, m, mean);
        const eta = etaSquared([...restByLin.values()], mean, comps);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({
            mean: [...mean],
            comps: comps.map(c => [...c]),
            eta,
            // A basis is only comparable to collections chunked the same way; fromSamples names the bundles because which snapshot a bundle embeds decides the memory uids.
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
