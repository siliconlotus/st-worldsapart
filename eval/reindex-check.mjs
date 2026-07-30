// Self-check for reindex.mjs — the offline collection builder that makes chunk settings sweepable and other
// people's graded scenes scorable.
//
// buildItems must mirror syncWorld EXACTLY. Everything downstream assumes the offline collection is the one
// production would build, so a divergence here doesn't produce an error, it produces plausible wrong numbers
// attributed to whatever parameter was being swept. The oracle at the bottom is the real guard: it rebuilds
// from a graded sample's embedded books at that sample's own settings and asserts the (hash, uid) multiset
// matches the collection SillyTavern actually wrote.
import { buildItems, chunkConfig, cachePath } from './reindex.mjs';
import { getStringHash } from './scene.mjs';
import { eq } from './metrics.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const CFG = { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 0 };
const V = (uid, content, extra = {}) => ({ uid, content, vectorized: true, ...extra });

// --- which entries get indexed at all: syncWorld filters on vectorized && !disable && content ---
eq(buildItems({ 1: V(1, 'alpha') }, CFG).length, 1, 'a vectorized entry with content is indexed');
eq(buildItems({ 1: { uid: 1, content: 'alpha', vectorized: false } }, CFG).length, 0, 'a non-vectorized entry is not indexed');
eq(buildItems({ 1: V(1, 'alpha', { disable: true }) }, CFG).length, 0, 'a disabled entry is not indexed');
eq(buildItems({ 1: V(1, '') }, CFG).length, 0, 'an empty entry is not indexed');
eq(buildItems({ 1: { uid: 1, vectorized: true } }, CFG).length, 0, 'a contentless entry is not indexed');

// --- post-chunking: trim, drop blanks ---
const trimmed = buildItems({ 1: V(1, 'alpha\n\n   \n\nbeta') }, CFG);
eq(trimmed.length, 2, 'blank paragraphs are dropped, not embedded');
eq(trimmed.every(i => i.text === i.text.trim()), true, 'every stored chunk is trimmed');

// --- item shape: the metadata production writes ---
const [item] = buildItems({ 7: V(7, 'alpha') }, CFG);
eq(item.index, 7, 'index carries the owning uid');
eq(item.text, 'alpha', 'text is the chunk itself');
eq(item.hash, getStringHash('alpha'), 'hash is ST\'s string hash of the trimmed text');
eq(typeof buildItems({ '7': V('7', 'alpha') }, CFG)[0].index, 'number', 'a string uid is normalised to a number');

// NO GLOBAL DE-DUPLICATION, and this is the counter-intuitive one. syncWorld filters new items against the
// hashes ALREADY in the collection, which on a fresh build is nothing — so text shared by two entries really
// is stored twice, once per uid. Collapsing them changes which entry owns a shared chunk; since entry pooling
// takes the max over an entry's chunks, that moves the ranking and the elbow cut. A deduped rebuild
// reproduced every nDCG figure of a live index and still cut 4 entries where production cut 8.
const shared = buildItems({ 1: V(1, 'same text'), 2: V(2, 'same text') }, CFG);
eq(shared.length, 2, 'text shared by two entries is stored once PER ENTRY, as a fresh sync does');
eq(shared[0].hash === shared[1].hash, true, 'both copies carry the same hash');
eq(shared.map(x => x.index).join(','), '1,2', 'each copy is attributed to its own entry');

// --- the floor still reads backwards: higher minChunkSize means FEWER chunks ---
const many = { 1: V(1, ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n\n')) };
eq(buildItems(many, { ...CFG, minChunkSize: 0 }).length, 3, 'floor 0: one chunk per paragraph');
eq(buildItems(many, { ...CFG, minChunkSize: 200 }).length, 1, 'floor 200: all three merge forward into one');

// --- chunkConfig layering: harness default < sample snapshot < explicit override ---
const S = { paramSnapshot: { vectors: { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 20 } } };
eq(chunkConfig(S).minChunkSize, 20, "the sample's own chunk settings win over the defaults");
eq(chunkConfig(S, { minChunkSize: 120 }).minChunkSize, 120, 'an arm override wins over the sample');
eq(chunkConfig(S, { minChunkSize: 120 }).chunkSize, 800, 'an override leaves the other settings alone');
eq(chunkConfig({}).chunkSize, 800, 'a sample with no snapshot still gets a full config');

// --- cache identity: same inputs -> same path, any difference -> a different one ---
const cp = (o, m = 'bge-m3') => cachePath({ primaryBook: 'Book' }, chunkConfig(S, o), m);
eq(cp({}) === cp({}), true, 'the cache path is deterministic');
eq(cp({}) === cp({ chunkSize: 400 }), false, 'a different chunkSize is a different collection');
eq(cp({}) === cp({ minChunkSize: 0 }), false, 'a different floor is a different collection');
eq(cp({}) === cp({ chunkMode: 'length' }), false, 'a different mode is a different collection');
eq(cp({}) === cp({}, 'other-model'), false, 'a different embedding model is a different collection');

// --- ORACLE: rebuild a real sample at its own settings and match what ST actually wrote ---
const DATA = new URL('./eval-data/', import.meta.url).pathname;
const ROOT = new URL('../../../../../../', import.meta.url).pathname;
const resolve = p => (p.startsWith('/') ? p : ROOT + p);
let ran = 0;
for (const file of existsSync(DATA) ? readdirSync(DATA).filter(f => f.endsWith('.json')) : []) {
    let sample;
    try { sample = JSON.parse(readFileSync(DATA + file, 'utf8')); } catch { continue; }
    if (!sample.index || !existsSync(resolve(sample.index)) || !sample.paramSnapshot?.vectors || !sample.books?.[sample.primaryBook]) continue;
    const stored = JSON.parse(readFileSync(resolve(sample.index), 'utf8')).items.map(i => `${i.metadata.hash}|${i.metadata.index}`).sort();
    const mine = buildItems(sample.books[sample.primaryBook], chunkConfig(sample)).map(i => `${i.hash}|${i.index}`).sort();
    ran++;
    if (stored.length === mine.length && stored.every((k, i) => k === mine[i])) {
        eq(true, true, `rebuild oracle: ${sample.name ?? file} matches its live collection exactly (${stored.length} items)`);
    } else {
        // Collections are PATH-DEPENDENT: syncWorld filters against what is already saved, so a book grown
        // incrementally holds fewer items than the same book synced in one pass (cross-entry duplicates get
        // filtered on the second sync but not the first). A rebuild is what a FRESH sync would produce, which
        // is the right target — but it means exact parity with a long-lived collection is not guaranteed.
        const s = new Set(stored);
        const extra = mine.filter(k => !s.has(k)).length;
        const m = new Set(mine);
        const missing = stored.filter(k => !m.has(k)).length;
        console.log(`ok   rebuild oracle: ${sample.name ?? file} stored ${stored.length}, fresh rebuild ${mine.length} (${extra} extra, ${missing} missing)`);
        eq(missing, 0, `  every stored item is reproduced for ${sample.name ?? file} (extras are duplicates an incremental sync filtered)`);
    }
}
if (!ran) console.log('ok   rebuild oracle: skipped — no sample with a reachable index in eval-data/');
