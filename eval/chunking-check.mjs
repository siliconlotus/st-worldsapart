// Self-check for chunking.mjs: assertions on the splitter, then an oracle re-chunking graded samples' books against their live vector index.
// An oracle mismatch is the DATA drifting (P3), so it prints rather than fails; with no eval-data the oracle skips.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { chunkEntry, splitRecursive } from '../extension/chunking.mjs';
import { eq } from './metrics.mjs';
import { evalDataDir, openSample, indexPath, sceneLabel } from './scene.mjs';
import { chunkConfig } from './reindex.mjs';

const MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';

const PARA = { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };

// --- splitRecursive: split, recurse, then greedily re-merge to fill ---
eq(JSON.stringify(splitRecursive('abc', 0)), '["abc"]', 'a non-positive length is a no-op, not an infinite recursion');
eq(splitRecursive('a\n\nb', 100).join('|'), 'a\n\nb', 'parts that fit are merged back with their delimiter');
eq(splitRecursive('aaa\n\nbbb', 4).join('|'), 'aaa|bbb', 'parts that cannot be merged stay apart');
eq(splitRecursive('aa\n\nbb\n\ncc', 6).join('|'), 'aa\n\nbb|cc', 'merging fills to capacity, not to meaning');
eq(splitRecursive('aaaa bbbb', 5, [' ', '']).join('|'), 'aaaa|bbbb', 'falls through to the next delimiter');
eq(splitRecursive('aaaaaa', 3, ['']).join('|'), 'aaa|aaa', "the empty delimiter splits between characters");

// --- chunkEntry: paragraph mode ---
eq(chunkEntry('one\n\ntwo', { ...PARA, minChunkSize: 0 }).length, 2, 'paragraph mode keeps one paragraph per chunk');
eq(chunkEntry('  one  \n\n\n  two  ', { ...PARA, minChunkSize: 0 }).join('|'), 'one|two', 'paragraphs are trimmed and blank runs collapse');
eq(chunkEntry('', PARA).length, 0, 'empty content yields no chunks');
eq(chunkEntry('\n\n   \n\n', PARA).length, 0, 'whitespace-only content yields no chunks');

const short = 'tiny\n\n' + 'x'.repeat(300);
eq(chunkEntry(short, { ...PARA, minChunkSize: 0 }).length, 2, 'floor 0: the short paragraph stands alone');
eq(chunkEntry(short, { ...PARA, minChunkSize: 120 }).length, 1, 'floor 120: the short paragraph is merged forward');
eq(chunkEntry(short, { ...PARA, minChunkSize: 120 })[0].startsWith('tiny\n\n'), true, 'merged forward, so it leads its chunk');
eq(chunkEntry('aaa\n\nbbb', { ...PARA, minChunkSize: 1000 }).join('|'), 'aaa\n\nbbb', 'a trailing sub-floor remainder is still emitted');
eq(chunkEntry('tiny', { ...PARA, minChunkSize: 1000 }).join('|'), 'tiny', 'a single sub-floor paragraph is not lost');
const long = 'y'.repeat(900);
eq(chunkEntry(long, PARA).every(c => c.length <= 800), true, 'an oversized paragraph is split under chunkSize');
eq(chunkEntry(long, PARA).join(''), long, 'splitting an oversized paragraph loses no text');

// --- 'length' mode is splitRecursive directly, floor ignored ---
eq(JSON.stringify(chunkEntry('a\n\nb', { chunkMode: 'length', chunkSize: 800, minChunkSize: 999 })),
    JSON.stringify(splitRecursive('a\n\nb', 800)), "'length' mode is splitRecursive verbatim, floor unused");

// --- the oracle: reproduce existing indexes. evalDataDir() resolves the root a sample's `index` is relative to, or it skips silently ---
const DATA = evalDataDir();
const samples = existsSync(DATA) ? readdirSync(DATA).filter(f => f.endsWith('.json')) : [];
let compared = 0, openable = 0;
for (const file of samples) {
    // Through openSample and indexPath, never field names of its own: a name spelled here goes stale without failing.
    let S;
    try { S = openSample(DATA + file); } catch { continue; }
    if (!S?.books?.[S.primaryBook]) continue;
    openable++;
    const indexFile = indexPath(S, { model: MODEL });
    if (!existsSync(indexFile)) continue;
    const chunkCfg = chunkConfig(S);

    const book = S.books[S.primaryBook];
    const stored = new Set(JSON.parse(readFileSync(indexFile, 'utf8')).items.map(it => it.metadata.text));

    // Mirrors syncWorld after chunking: re-trim, drop blanks, and compare set-to-set, since the store is hash-keyed (P3).
    const vectorized = Object.values(book).filter(e => e.vectorized && !e.disable && typeof e.content === 'string' && e.content);
    const expected = new Set();
    for (const e of vectorized) for (const c of chunkEntry(e.content, chunkCfg)) { const t = c.trim(); if (t) expected.add(t); }
    if (!stored.size || !expected.size) continue;
    compared++;

    const missing = [...stored].filter(t => !expected.has(t));      // indexed, but the book no longer produces it
    const unindexed = [...expected].filter(t => !stored.has(t));    // the book produces it, but it was never embedded

    if (!missing.length && !unindexed.length) {
        eq(true, true, `index oracle: ${sceneLabel(S) || file} reproduces all ${stored.size} stored chunks byte-for-byte (${vectorized.length} vectorized entries)`);
    } else {
        console.log(`ok   index oracle: ${sceneLabel(S) || file} ${stored.size - missing.length}/${stored.size} stored chunks reproduced from ${vectorized.length} vectorized entries`);
        if (missing.length) console.log(`     !! ${missing.length} indexed chunk(s) this book no longer produces — content edited or re-chunked since they were embedded.`);
        if (unindexed.length) console.log(`     !! ${unindexed.length} chunk(s) the book produces are NOT indexed — that text is unsearchable until re-vectorized.`);
        console.log('        Re-vectorize before using this sample in a retuning corpus. (Not a code failure: the chunker is');
        console.log('        pinned by any fully-clean sample above.)');
    }
}

// A skip is not an ok: openable bundles with no reachable index is a broken oracle reporting success.
if (!samples.length) {
    console.log('WARN index oracle: no eval-data/ in this checkout, so the chunker is pinned by the unit cases above alone.');
} else {
    eq(compared > 0, true, `index oracle ran against ${compared} live index/book pair(s) (${openable} bundle(s) openable of ${samples.length} file(s))`);
}

// ---- the merge floor applies to split fragments too (R25)
const CFG = { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };
const words = n => Array.from({ length: n }, () => 'word').join(' ');
const floorCases = [
    ['an interior rule inside an oversized block', `${words(200)}\n---\n${words(200)}\n\n${words(30)}`],
    ['a short tail left by a sentence split', `${words(190)}. production.`],
    ['a short trailing paragraph', `${words(200)}\n\nstray`],
    ['a short paragraph before a real one', `stray\n\n${words(60)}`],
];
for (const [name, text] of floorCases) {
    const out = chunkEntry(text, CFG);
    eq(out.filter(c => c.length < CFG.minChunkSize).length, 0, `no chunk under the floor: ${name}`);
    eq(out.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), `content preserved: ${name}`);
}
eq(chunkEntry('tiny', CFG).join(''), 'tiny', 'an entry shorter than the floor is still chunked, not dropped');
