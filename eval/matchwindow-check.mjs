// matchWindow — the unit a key has to match within. Three properties carry the whole feature:
// `scan` is byte-for-byte the pre-setting behaviour, narrower settings stop cross-segment
// conjunctions (both signs), and segmentation never merges texts that were separate.
import { scanWindow, scanSegments, segment, keywordScore } from '../extension/ranking.mjs';
import { eq } from './metrics.mjs';

const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
const score = (entry, text) => keywordScore(entry, text, entry.key, cfg).score;

// A chat where the two terms of a conjunction sit in different messages, and different paragraphs
// of the same message — so message and paragraph modes are told apart, not just scan from the rest.
const chat = [
    { name: 'Alice', mes: 'we should drill the holes before lunch' },
    { name: 'Bob', mes: 'the astronauts trained here\n\nApollo was the program' },
    { name: 'Alice', mes: 'the workbench is on fire' },
];
const win = m => scanSegments(chat, { depth: 10, matchWindow: m });

{
    const e = { key: ['? apollo astronauts'] };
    eq(score(e, win('scan')) > 0, true, 'scan: a conjunction spans the whole window');
    eq(score(e, win('message')) > 0, true, 'message: both terms are in the same message');
    eq(score(e, win('paragraph')) > 0, false, 'paragraph: different paragraphs, so it stops matching');
}

// Negation scopes too — the veto is segment-local, which is the whole reason for the setting.
{
    const e = { key: ['? fire -drill'] };
    eq(score(e, win('scan')) > 0, false, 'scan: a drill five messages back silently vetoes the fire');
    eq(score(e, win('message')) > 0, true, 'message: the veto cannot reach across messages');
    eq(score(e, win('paragraph')) > 0, true, '...nor across paragraphs');
}

// Selective logic gets no carve-out: it scopes exactly like a SmartKey conjunction.
{
    const e = { key: ['astronauts'], keysecondary: ['drill'], selectiveLogic: 0 }; // AND_ANY
    eq(score(e, win('scan')) > 0, true, 'scan: the secondary is satisfied from another message');
    eq(score(e, win('paragraph')) > 0, false, 'paragraph: the secondary must be in the same segment');
}

// `scan` is not a mode, it is the degenerate one-segment array — so it must equal the old string path.
{
    const e = { key: ['? apollo astronauts', 'fire', 'drill'] };
    const asString = keywordScore(e, scanWindow(chat, { depth: 10 }), e.key, cfg);
    const asSegments = keywordScore(e, win('scan'), e.key, cfg);
    eq(asSegments.score, asString.score, 'scan segments score identically to the joined string');
    eq(JSON.stringify(asSegments.hits), JSON.stringify(asString.hits), '...and report the same hits');
}

// Counts SUM across gate-passing segments and saturate once, rather than saturating per segment.
{
    const e = { key: ['fire'] };
    const three = ['fire', 'fire', 'fire'];
    eq(keywordScore(e, three, e.key, cfg).hits[0].count, 3, 'occurrences accumulate across segments');
    eq(keywordScore(e, three, e.key, cfg).score, 3 / (3 + 1.2), '...and saturate once, not three times');
}

// Segmentation never MERGES separate texts, and re-segmenting is idempotent — the property that lets
// worldsapart.js append match sources to an already-split window and still collapse correctly at scan.
{
    eq(JSON.stringify(segment(segment(['a\n\nb'], 'paragraph'), 'paragraph')), '["a","b"]', 'idempotent');
    eq(JSON.stringify(segment(segment(['a\n\nb'], 'paragraph'), 'scan')), '["a\\nb"]', 'scan re-collapses');
    eq(segment(['msg'], 'paragraph').length, 1, 'a source text is its own segment, never merged');
    eq(JSON.stringify(segment(['a', '', '  '], 'message')), '["a"]', 'empty segments are dropped');
}

// scanWindow keeps its string contract for every caller that has not been taught about segments.
eq(typeof scanWindow(chat, { depth: 10 }), 'string', 'scanWindow still returns the joined string');

console.log('ok   matchWindow: scan is the old behaviour, narrower settings scope both signs');
