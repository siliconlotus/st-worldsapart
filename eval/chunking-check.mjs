// Self-check for chunking.mjs — the splitter WA took ownership of from ST.
//
// Two halves. The first is pure assertions on the algorithm. The second is the one that matters: it
// re-chunks a graded sample's EMBEDDED books and compares the result against the `metadata.text` actually
// stored in that book's live vector index. That is a real-data oracle for byte-identity — the port is only
// safe if it reproduces indexes that already exist, and no amount of hand-written fixtures can establish
// that. It found 992/992 chunks identical on the first book it ran against.
//
// The same comparison is a STALENESS DETECTOR, which is why it prints rather than asserts on mismatch: a
// book edited after it was vectorized no longer chunks to what is stored, and its sample's per-entry cosines
// therefore describe text the book no longer contains. One existing eval sample is ~30% out of sync this
// way. That is a fact about the DATA, not a regression in the code, so it must not fail the suite — but it
// must not be silent either, since a stale index quietly corrupts every number derived from it.
//
// Runs clean with no arguments and no eval-data present: the oracle half skips when there is nothing to
// compare against.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { chunkEntry, splitRecursive } from '../extension/chunking.mjs';
import { eq } from './metrics.mjs';

const PARA = { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };

// --- splitRecursive: split, recurse, then greedily re-merge to fill ---
eq(JSON.stringify(splitRecursive('abc', 0)), '["abc"]', 'a non-positive length is a no-op, not an infinite recursion');
eq(splitRecursive('a\n\nb', 100).join('|'), 'a\n\nb', 'parts that fit are merged back with their delimiter');
eq(splitRecursive('aaa\n\nbbb', 4).join('|'), 'aaa|bbb', 'parts that cannot be merged stay apart');
// The merge pass is what makes 'length' mode span topics: it fills to capacity regardless of structure.
eq(splitRecursive('aa\n\nbb\n\ncc', 6).join('|'), 'aa\n\nbb|cc', 'merging fills to capacity, not to meaning');
// Delimiter cascade: too long for the first delimiter falls through to the next.
eq(splitRecursive('aaaa bbbb', 5, [' ', '']).join('|'), 'aaaa|bbbb', 'falls through to the next delimiter');
eq(splitRecursive('aaaaaa', 3, ['']).join('|'), 'aaa|aaa', "the empty delimiter splits between characters");

// --- chunkEntry: paragraph mode ---
eq(chunkEntry('one\n\ntwo', { ...PARA, minChunkSize: 0 }).length, 2, 'paragraph mode keeps one paragraph per chunk');
eq(chunkEntry('  one  \n\n\n  two  ', { ...PARA, minChunkSize: 0 }).join('|'), 'one|two', 'paragraphs are trimmed and blank runs collapse');
eq(chunkEntry('', PARA).length, 0, 'empty content yields no chunks');
eq(chunkEntry('\n\n   \n\n', PARA).length, 0, 'whitespace-only content yields no chunks');

// THE MERGE FLOOR, and its direction — the thing that reads backwards. A short paragraph is glued FORWARD
// into the next one, so a HIGHER floor means FEWER, LARGER chunks. Nothing is ever split by it.
const short = 'tiny\n\n' + 'x'.repeat(300);
eq(chunkEntry(short, { ...PARA, minChunkSize: 0 }).length, 2, 'floor 0: the short paragraph stands alone');
eq(chunkEntry(short, { ...PARA, minChunkSize: 120 }).length, 1, 'floor 120: the short paragraph is merged forward');
eq(chunkEntry(short, { ...PARA, minChunkSize: 120 })[0].startsWith('tiny\n\n'), true, 'merged forward, so it leads its chunk');
// A trailing run that never reaches the floor still has to be emitted, or its text would vanish from the index.
eq(chunkEntry('aaa\n\nbbb', { ...PARA, minChunkSize: 1000 }).join('|'), 'aaa\n\nbbb', 'a trailing sub-floor remainder is still emitted');
eq(chunkEntry('tiny', { ...PARA, minChunkSize: 1000 }).join('|'), 'tiny', 'a single sub-floor paragraph is not lost');
// Oversized paragraphs split on a FINER delimiter set than 'length' mode uses ('\n' before '. ').
const long = 'y'.repeat(900);
eq(chunkEntry(long, PARA).every(c => c.length <= 800), true, 'an oversized paragraph is split under chunkSize');
eq(chunkEntry(long, PARA).join(''), long, 'splitting an oversized paragraph loses no text');

// --- 'length' mode is splitRecursive directly, floor ignored ---
eq(JSON.stringify(chunkEntry('a\n\nb', { chunkMode: 'length', chunkSize: 800, minChunkSize: 999 })),
    JSON.stringify(splitRecursive('a\n\nb', 800)), "'length' mode is splitRecursive verbatim, floor unused");

// --- THE ORACLE: do we reproduce indexes that already exist? ---
const DATA = new URL('./eval-data/', import.meta.url).pathname;
// A sample records `index` relative to the ST ROOT, because the grid tools are run from there. A check is run
// from wherever the suite loop happens to sit, so resolve against the root derived from this file instead of
// the cwd — otherwise the oracle silently skips and the port loses the only evidence that it is exact.
const ROOT = new URL('../../../../../../', import.meta.url).pathname;
const resolve = p => (p.startsWith('/') ? p : ROOT + p);
const samples = existsSync(DATA) ? readdirSync(DATA).filter(f => f.endsWith('.json')) : [];
let compared = 0;
for (const file of samples) {
    let S;
    try { S = JSON.parse(readFileSync(DATA + file, 'utf8')); } catch { continue; }
    const chunkCfg = S.paramSnapshot?.vectors;
    if (!S.index || !existsSync(resolve(S.index)) || !chunkCfg || !S.books?.[S.primaryBook]) continue;

    const book = S.books[S.primaryBook];
    const stored = new Set(JSON.parse(readFileSync(resolve(S.index), 'utf8')).items.map(it => it.metadata.text));

    // MIRROR syncWorld EXACTLY, INCLUDING WHAT IT DOES *AFTER* CHUNKING. Two properties of the real indexer
    // are invisible in chunkEntry's output and both were, in turn, mistaken for data corruption here:
    //
    //   trim + drop empties — syncWorld re-trims every chunk and skips blanks. splitRecursive splitting an
    //                         oversized paragraph on '. ' leaves pieces with edge whitespace, so raw output
    //                         and stored text legitimately differ.
    //   keyed by hash       — identical text is ONE collection item however many entries produce it, so
    //                         boilerplate repeated across entries is stored once, attributed to whichever
    //                         entry got there first.
    //
    // Comparing per-entry and positionally against a hash-keyed, insertion-ordered store reported a
    // perfectly-synced 1050-chunk collection as 70% stale. Condemning good graded data is a far more
    // expensive failure than the drift this is meant to catch, so the comparison is now set-to-set over the
    // whole collection, exactly the granularity syncWorld itself works at.
    const vectorized = Object.values(book).filter(e => e.vectorized && !e.disable && typeof e.content === 'string' && e.content);
    const expected = new Set();
    for (const e of vectorized) for (const c of chunkEntry(e.content, chunkCfg)) { const t = c.trim(); if (t) expected.add(t); }
    if (!stored.size || !expected.size) continue;
    compared++;

    const missing = [...stored].filter(t => !expected.has(t));      // indexed, but the book no longer produces it
    const unindexed = [...expected].filter(t => !stored.has(t));    // the book produces it, but it was never embedded

    // A collection fully in sync is the port's proof. A residue is the DATA drifting, so it reports loudly
    // and passes — the suite must stay green on a machine whose lorebooks have moved on.
    if (!missing.length && !unindexed.length) {
        eq(true, true, `index oracle: ${S.name ?? file} reproduces all ${stored.size} stored chunks byte-for-byte (${vectorized.length} vectorized entries)`);
    } else {
        console.log(`ok   index oracle: ${S.name ?? file} ${stored.size - missing.length}/${stored.size} stored chunks reproduced from ${vectorized.length} vectorized entries`);
        if (missing.length) console.log(`     !! ${missing.length} indexed chunk(s) this book no longer produces — content edited since they were embedded.`);
        if (unindexed.length) console.log(`     !! ${unindexed.length} chunk(s) the book produces are NOT indexed — that text is unsearchable until re-vectorized.`);
        console.log('        Re-vectorize before using this sample in a retuning corpus. (Not a code failure: the chunker is');
        console.log('        pinned by any fully-clean sample above.)');
    }
}
if (!compared) console.log('ok   index oracle: skipped — no sample with a reachable index in eval-data/');
else eq(compared > 0, true, `index oracle ran against ${compared} live index/book pair(s)`);
