// Self-check for reindex.mjs — the offline collection builder that makes chunk settings sweepable and other
// people's graded scenes scorable.
//
// buildItems must mirror syncWorld EXACTLY. Everything downstream assumes the offline collection is the one
// production would build, so a divergence here doesn't produce an error, it produces plausible wrong numbers
// attributed to whatever parameter was being swept. The oracle at the bottom is the real guard: it rebuilds
// from a graded sample's embedded books at that sample's own settings and asserts the (hash, uid) multiset
// matches the collection SillyTavern actually wrote.
import { buildItems, chunkConfig, cachePath } from './reindex.mjs';
import { getStringHash, stInstall } from './scene.mjs';
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

// --- `all`: the one build that deliberately does NOT mirror syncWorld (the denseAllEntries arm) ---
// The vectorized half must come out item-for-item identical, because that half stays stage 1's collection
// and its corpus mean — an --all index that reordered or re-hashed anything would move every baseline
// cosine and report it as the arm's effect.
const mixed = { 1: V(1, 'alpha'), 2: { uid: 2, content: 'beta', vectorized: false }, 3: V(3, 'gamma', { disable: true }), 4: { uid: 4, vectorized: false } };
const vecOnly = buildItems(mixed, CFG);
const withAll = buildItems(mixed, CFG, true);
eq(vecOnly.length, 1, 'without --all only the vectorized entry is indexed');
eq(withAll.length, 2, 'with --all the non-vectorized entry with content joins it');
eq(withAll.some(i => i.index === 3), false, 'a disabled entry stays out under --all too');
eq(withAll.some(i => i.index === 4), false, 'a contentless entry stays out under --all too');
eq(JSON.stringify(withAll.filter(i => i.index === 1)), JSON.stringify(vecOnly), 'the vectorized half of an --all build is item-for-item the ordinary build');

// --- `archived`: disabled MEMORY entries, as centroid mass and nothing else (the centroidPopulation arm) ---
// The marker is load-bearing rather than descriptive: scene.mjs keeps these out of `items` and `extra` by
// reading it, so an unmarked archived chunk becomes a retrievable entry in a collection no ST install holds.
// Reference is excluded at build time because the tier split is the whole point of the arm — a memory-tier
// centroid that quietly carried reference chunks would measure the register blend it exists to avoid.
const M = (uid, content, extra = {}) => ({ uid, content, vectorized: true, stmemorybooks: {}, ...extra });
const archivable = { 1: V(1, 'alpha'), 2: M(2, 'beta', { disable: true }), 3: V(3, 'gamma', { disable: true }) };
const noArch = buildItems(archivable, CFG, true);
const withArch = buildItems(archivable, CFG, true, true);
eq(noArch.length, 1, 'without --archived a disabled memory entry stays out');
eq(withArch.length, 2, 'with --archived the disabled MEMORY entry is indexed');
eq(withArch.some(i => i.index === 3), false, 'a disabled REFERENCE entry stays out under --archived');
eq(withArch.find(i => i.index === 2).centroidOnly, true, 'an archived entry is marked centroidOnly');
eq(withArch.find(i => i.index === 1).centroidOnly, undefined, 'a live entry carries no marker');
eq(JSON.stringify(withArch.filter(i => i.index === 1)), JSON.stringify(noArch), 'the live half of an --archived build is item-for-item the --all build');

// --- post-chunking: trim, drop blanks ---
const trimmed = buildItems({ 1: V(1, 'alpha\n\n   \n\nbeta') }, CFG);
eq(trimmed.length, 2, 'blank paragraphs are dropped, not embedded');
eq(trimmed.every(i => i.text === i.text.trim()), true, 'every stored chunk is trimmed');

// --- item shape: the metadata production writes ---
const [item] = buildItems({ 7: V(7, 'alpha') }, CFG);
eq(item.index, 7, 'index carries the owning uid');
eq(item.text, 'alpha', 'text is the chunk itself');
eq(item.hash, getStringHash('alpha7'), 'hash is ST\'s string hash of trimmed text + owning uid, as syncWorld computes it');
eq(typeof buildItems({ '7': V('7', 'alpha') }, CFG)[0].index, 'number', 'a string uid is normalised to a number');

// NO GLOBAL DE-DUPLICATION, and this is the counter-intuitive one. Since ccc5512 the hash carries
// (text, uid) — ST core lists and deletes by hash only, so identity has to live IN the hash or one hash
// stands for two owners and syncs misattribute rows. Text shared by two entries therefore hashes
// differently per owner and is stored twice, once per uid, by fresh and incremental syncs alike.
// Collapsing them changes which entry owns a shared chunk; since entry pooling takes the max over an
// entry's chunks, that moves the ranking and the elbow cut. A deduped rebuild reproduced every nDCG
// figure of a live index and still cut different entries than production did (P4).
const shared = buildItems({ 1: V(1, 'same text'), 2: V(2, 'same text') }, CFG);
eq(shared.length, 2, 'text shared by two entries is stored once PER ENTRY');
eq(shared[0].hash !== shared[1].hash, true, 'the uid in the hash keeps the two copies distinct');
eq(shared.map(x => x.index).join(','), '1,2', 'each copy is attributed to its own entry');

// --- the floor still reads backwards: higher minChunkSize means FEWER chunks ---
const many = { 1: V(1, ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n\n')) };
eq(buildItems(many, { ...CFG, minChunkSize: 0 }).length, 3, 'floor 0: one chunk per paragraph');
eq(buildItems(many, { ...CFG, minChunkSize: 200 }).length, 1, 'floor 200: all three merge forward into one');

// --- chunkConfig layering: harness default < sample snapshot < explicit override ---
const S = { paramSnapshot: { settings: { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 20 } } };
eq(chunkConfig(S).minChunkSize, 20, "the sample's own chunk settings win over the defaults");
eq(chunkConfig(S, { minChunkSize: 120 }).minChunkSize, 120, 'an arm override wins over the sample');
eq(chunkConfig(S, { minChunkSize: 120 }).chunkSize, 800, 'an override leaves the other settings alone');
eq(chunkConfig({}).chunkSize, 1750, 'a sample with no snapshot still gets a full config');
// ONE SNAPSHOT SHAPE. The current writer's scalar dump is read; the older grouped blocks are not, because
// they name knobs the pipeline no longer has and reading them would resurrect a parameter with no code.
eq(chunkConfig({ paramSnapshot: { settings: { chunkSize: 900, minChunkSize: 30 } } }).chunkSize, 900, 'the settings dump is read');
eq(chunkConfig({ paramSnapshot: { settings: { chunkSize: 900 } } }).minChunkSize, 120, '...and a field it omits falls to the default rather than to undefined');
eq(chunkConfig({ paramSnapshot: { vectors: { chunkSize: 800, minChunkSize: 20 } } }).chunkSize, 1750, 'a pre-v3 grouped snapshot is IGNORED, not read');
eq(chunkConfig({ paramSnapshot: { vectors: { chunkSize: 800 }, settings: { chunkSize: 900 } } }).chunkSize, 900, '...and does not win when both are present');

// --- cache identity: same inputs -> same path, any difference -> a different one ---
const cp = (o, m = 'bge-m3') => cachePath({ primaryBook: 'Book' }, chunkConfig(S, o), m);
eq(cp({}) === cp({}), true, 'the cache path is deterministic');
eq(cp({}) === cp({ chunkSize: 400 }), false, 'a different chunkSize is a different collection');
eq(cp({}) === cp({ minChunkSize: 0 }), false, 'a different floor is a different collection');
eq(cp({}) === cp({ chunkMode: 'length' }), false, 'a different mode is a different collection');
eq(cp({}) === cp({}, 'other-model'), false, 'a different embedding model is a different collection');
// An --all collection holds a different entry population at the same settings, so it cannot share a path
// with the ordinary one — and the ordinary one must keep the path it already has on disk.
eq(cachePath({ primaryBook: 'Book' }, chunkConfig(S), 'bge-m3', 'Book', true) === cp({}), false, 'an --all collection is a different collection');
eq(cachePath({ primaryBook: 'Book' }, chunkConfig(S), 'bge-m3', 'Book', false), cp({}), 'not asking for --all leaves the existing path untouched');
eq(cachePath({ primaryBook: 'Book' }, chunkConfig(S), 'bge-m3', 'Book', true, true)
    === cachePath({ primaryBook: 'Book' }, chunkConfig(S), 'bge-m3', 'Book', true), false, 'an --archived collection is a different collection');
eq(cachePath({ primaryBook: 'Book' }, chunkConfig(S), 'bge-m3', 'Book', true, false)
    === cachePath({ primaryBook: 'Book' }, chunkConfig(S), 'bge-m3', 'Book', true), true, 'not asking for --archived leaves the --all path untouched');

// --- ORACLE: rebuild a real sample at its own settings and match what ST actually wrote ---
// stInstall() walks to the live ST install, so this works from git worktrees too. eval-data/ is
// gitignored (private captures), so when this checkout has none the canonical checkout's samples are used.
const ST = stInstall();
const LOCAL = new URL('./eval-data/', import.meta.url).pathname;
const DATA = existsSync(LOCAL) || !ST ? LOCAL : `${ST.root}/public/scripts/extensions/third-party/WorldsApart/eval/eval-data/`;
const resolve = p => ST ? ST.resolve(p) : p;
let ran = 0;
for (const file of existsSync(DATA) ? readdirSync(DATA).filter(f => f.endsWith('.json')) : []) {
    let sample;
    try { sample = JSON.parse(readFileSync(DATA + file, 'utf8')); } catch { continue; }
    if (!sample.index || !existsSync(resolve(sample.index)) || !sample.paramSnapshot?.settings || !sample.books?.[sample.primaryBook]) continue;
    const stored = JSON.parse(readFileSync(resolve(sample.index), 'utf8')).items.map(i => `${i.metadata.hash}|${i.metadata.index}`).sort();
    const mine = buildItems(sample.books[sample.primaryBook], chunkConfig(sample)).map(i => `${i.hash}|${i.index}`).sort();
    ran++;
    if (stored.length === mine.length && stored.every((k, i) => k === mine[i])) {
        eq(true, true, `rebuild oracle: ${sample.name ?? file} matches its live collection exactly (${stored.length} items)`);
    } else {
        // Extras can be legitimate: syncWorld filters against what is already saved, so a row whose
        // (text, uid) was retired from the entries but not yet vacuumed, or a collection touched by an
        // older build, can hold items a fresh rebuild would not produce the same way. Missing rows cannot
        // be: everything the collection stores came from these entries at these settings, so a rebuild
        // that fails to reproduce a stored item means buildItems has drifted from syncWorld.
        const s = new Set(stored);
        const extra = mine.filter(k => !s.has(k)).length;
        const m = new Set(mine);
        const missing = stored.filter(k => !m.has(k)).length;
        console.log(`ok   rebuild oracle: ${sample.name ?? file} stored ${stored.length}, fresh rebuild ${mine.length} (${extra} extra, ${missing} missing)`);
        eq(missing, 0, `  every stored item is reproduced for ${sample.name ?? file} (extras are duplicates an incremental sync filtered)`);
    }
}
if (!ran) console.log('ok   rebuild oracle: skipped — no sample with a reachable index in eval-data/');
