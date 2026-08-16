// Self-check for content-lexical.mjs — the stage-3 text signal over EVERY entry's content.
//
// What matters here is not BM25 itself (lexical.mjs owns that and is checked through the scorers) but the
// three things this module decides: which entries become documents, how chunks pool back to an entry, and
// when the cached index is stale. Each has a way of failing silently — a keyword entry quietly absent, a
// long entry winning for having more places to match, or a stale index answering after an edit.
import { buildContentIndex, scoreContent, indexFingerprint, entryKey } from '../extension/content-lexical.mjs';

let fails = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`); if (!cond) fails++; };
const CFG = { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };
const e = (uid, content, extra = {}) => ({ world: 'B', uid, content, ...extra });

// --- who becomes a document -------------------------------------------------------------------------
const book = [
    e(1, 'The obsidian spire hums above the drowned quarter.'),
    e(2, 'Marek keeps a ledger of every debt the guild forgave.', { vectorized: true }),
    e(3, 'disabled entry about the obsidian spire', { disable: true }),
    e(4, '   '),
    e(5, 'A short reference sheet naming the drowned quarter.'),
];
const idx = buildContentIndex(book, CFG);
ok(idx.entryCount === 3, `only enabled entries with content are indexed (${idx.entryCount} of 5)`);

// THE WHOLE POINT: a non-vectorized entry is in the index. Before this module only `vectorized` entries
// were indexed anywhere, so a keyword entry's body was invisible to every scorer.
const hits = scoreContent(idx, 'obsidian spire');
ok(hits.has(entryKey(book[0])), 'a NON-vectorized entry earns a text score');
ok(!hits.has(entryKey(book[2])), 'a disabled entry earns none');
ok(scoreContent(idx, 'ledger guild').has(entryKey(book[1])), 'a vectorized entry earns one from the same index');

// One index, one IDF corpus: a term in every document discriminates far less than a rare one. NOT zero —
// buildLexical uses the smoothed log(1 + (N-df+0.5)/(df+0.5)), which stays positive at df == N, so the
// property to assert is the ratio and not an absence.
const idfCorpus = buildContentIndex([e(1, 'quarter spire'), e(2, 'quarter harbour'), e(3, 'quarter foundry')], CFG);
const common = scoreContent(idfCorpus, 'quarter').get('B.1') ?? 0;
const rare = scoreContent(idfCorpus, 'spire').get('B.1') ?? 0;
ok(rare > common * 3, `a term in every document is worth far less than a rare one (${rare.toFixed(3)} vs ${common.toFixed(3)})`);

// --- pooling ----------------------------------------------------------------------------------------
// MAX, not sum. A long entry repeating a term across many chunks must not outrank a short entry that says
// it once and means it — that length bias is what BM25's `b` already controls, and summing reintroduces it.
// The paragraph must clear minChunkSize or chunkEntry joins it with the next one, which changes tf and
// document length and tests something else entirely — that is what the first draft of this check did.
const PARA = 'The obsidian spire looms over the drowned quarter tonight and every night after, and the harbour bells answer it from the far bank until the tide turns again.';
const pooled = buildContentIndex([e(1, [PARA, PARA, PARA].join('\n\n')), e(2, PARA)], CFG);
const ps = scoreContent(pooled, 'spire quarter');
ok(pooled.docCount === 4, `the repeated entry chunked into separate documents (${pooled.docCount} chunks total)`);
ok(Math.abs((ps.get('B.1') ?? 0) - (ps.get('B.2') ?? 0)) < 1e-9,
    `identical chunks pool by MAX: saying it three times ties saying it once (${(ps.get('B.1') ?? 0).toFixed(4)} vs ${(ps.get('B.2') ?? 0).toFixed(4)})`);

// --- the fold: BM25 tokenizes under the MATCHER's fold (plugin/automaton.mjs), not a private one ----
// The old [^a-z0-9'] split treated an accented letter as a separator, so "Möbius" indexed as "bius"
// and could match nothing — 87 word types / 319 occurrences across four books, character names
// included. The fold normalizes encoding and typography; it deliberately does NOT strip diacritics,
// because é vs e is a distinction an author can write and countKey preserves it. Assert both halves,
// so neither a re-shattering nor a well-meant "fix" into diacritic stripping lands silently.
const foldIdx = buildContentIndex([e(1, 'The Möbius spire hums over André’s quarter.')], CFG);
ok(scoreContent(foldIdx, 'möbius spire').has('B.1'), 'an accented word matches its accented query instead of shattering');
ok(scoreContent(foldIdx, `mo\u0308bius`).has(`B.1`), `NFD in the query matches NFC in the document (one encoding, one token)`);
ok(scoreContent(foldIdx, "André's").has('B.1'), 'a curly apostrophe in the document matches the straight-quote query');
ok(!scoreContent(foldIdx, 'mobius').has('B.1'), 'ASCII "mobius" still does NOT match "möbius" — the fold is not diacritic stripping');

// --- staleness --------------------------------------------------------------------------------------
const base = indexFingerprint(book, CFG);
ok(indexFingerprint(book, CFG) === base, 'fingerprint is stable for unchanged input');
ok(indexFingerprint([...book, e(9, 'a new entry')], CFG) !== base, 'adding an entry moves it');
ok(indexFingerprint(book, { ...CFG, chunkSize: 400 }) !== base, 'changing chunk settings moves it');
ok(indexFingerprint(book.map((x, i) => (i === 0 ? { ...x, content: `${x.content} extra` } : x)), CFG) !== base, 'editing content moves it');

// --- degenerate inputs ------------------------------------------------------------------------------
ok(scoreContent(buildContentIndex([], CFG), 'anything').size === 0, 'an empty book scores nothing rather than throwing');
ok(scoreContent(idx, '').size === 0, 'an empty query scores nothing');

console.log(fails ? `\n${fails} FAILED` : '\nok');
process.exit(fails ? 1 : 0);
