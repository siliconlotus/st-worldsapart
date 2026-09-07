// matchWindow — the unit a key has to match within. Three properties carry the whole feature:
// `scan` is byte-for-byte the pre-setting behaviour, narrower settings stop cross-segment
// conjunctions (both signs), and segmentation never merges texts that were separate.
import { keywordScore, repeatCurveOf, scanSegments, scanWindow, segment } from '../extension/matcher.mjs';
import { eq } from './metrics.mjs';
// Dynamic, because keyword-audit.mjs pulls the ST-coupled half in at module scope on some branches.
const { buildKeyPruneScan } = await import('../extension/keyword-audit.mjs');
// The audit options every block below classifies under — one set, so a block cannot silently differ.
const opts = {
    scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, bookCommon: 0.5, minLength: 4,
};

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
    // Against repeatCurveOf, not an inlined formula: the claim here is about the COUNT reaching the
    // curve as 3, which is a fact about segmentation and holds under any curve. The second assertion
    // is what makes it a test — one saturation of 3 is strictly less than three saturations of 1.
    eq(keywordScore(e, three, e.key, cfg).score, repeatCurveOf(3, 1.2), '...and the curve sees a count of 3');
    eq(keywordScore(e, three, e.key, cfg).score < 3 * repeatCurveOf(1, 1.2), true, '...saturating once, not three times');
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

// The audit asks the runtime's question. A key whose terms never land in one paragraph will never
// fire at that setting, so reporting it as attested would be the audit telling the author it works.
// A LITERAL key is slice-invariant either way — measured over the books on disk, no literal key's
// df or occurrence total moves, because no literal spans a paragraph break (K5).
{
    const book = {
        entries: {
            0: {
                uid: 0,
                key: ['? apollo astronauts', 'apollo astronauts', 'astronauts'],
                content: 'The astronauts trained here.\n\nApollo was the program that flew them.',
            },
        },
    };
    const flags = mw => {
        const s = buildKeyPruneScan(book, opts, new Set(), { matchWindow: mw });
        return Object.fromEntries(s.classifyEntry(book.entries[0]).map(f => [f.key, f.flag]));
    };
    eq(flags('scan')['? apollo astronauts'], undefined, 'scan: the query is attested across the entry');
    eq(flags('paragraph')['? apollo astronauts'], 'unattested',
        'paragraph: its terms never share a paragraph, so it is dead and says so');
    // The literal that would fire nowhere is dead at BOTH settings, and the one that fires is alive at
    // both — a plain key's answer must not move with the setting.
    eq(flags('scan')['apollo astronauts'], 'unattested', 'a literal phrase absent from the text is dead');
    eq(flags('paragraph')['apollo astronauts'], 'unattested', '...at every setting, being slice-invariant');
    eq(flags('scan')['astronauts'], flags('paragraph')['astronauts'], 'an attested literal is unmoved too');
}
console.log('ok   the audit segments like the runtime, and literals are slice-invariant');

// Chat evidence reaching the CLASSIFIER, not the cleanup display layer — so the Explorer's chips,
// which colour from reasonOf/severityOf, carry it too. Absent chatRate must behave exactly as before.
{
    const { KEY_CHAT_COMMON } = await import('../extension/keyword-audit.mjs');
    // `mother` is in COMMON_WORDS; `zzznope` is in neither the book's text nor any word list.
    const book = { entries: { 0: { uid: 0, key: ['mother', 'zzznope'], content: 'Nothing relevant here.' } } };
    const run = chatScan => {
        const s = buildKeyPruneScan(book, opts, new Set(), { chatScan });
        return Object.fromEntries(s.classifyEntry(book.entries[0]).map(p => [p.key, { flag: p.flag, why: s.reasonOf(p).text, sev: s.severityOf(p) }]));
    };
    const none = run(undefined);
    eq(none.zzznope.flag, 'unattested', 'no chat: a key absent from entry text is dead');
    eq(none.zzznope.why, 'not in entry text', '...and says only what it checked');
    eq(none.mother.flag, 'english common', 'no chat: the English list still flags a generic word');
    eq(none.mother.sev !== '#e06c6c', true, '...but unevidenced it is no longer red');

    const quiet = run({ messagesWith: new Map([['mother', 2], ['zzznope', 0]]), messages: 100 });
    eq(quiet.zzznope.why, 'not in entry text or chat', 'chat checked and silent: the claim gets stronger');
    eq(quiet.mother.sev !== '#e06c6c', true, 'a quiet common word stays flagged, not red');

    const live = run({ messagesWith: new Map([['mother', 40], ['zzznope', 12]]), messages: 100 });
    eq(live.zzznope, undefined, 'a key the CHAT uses is not dead — the flag is suppressed, not recoloured');
    eq(live.mother.sev, '#e06c6c', 'a common word the chat confirms over-fires goes red');
    eq(live.mother.why, `english common · 40% of chat`, '...and shows the evidence, not just the assertion');
    eq(KEY_CHAT_COMMON, 0.2, 'the chat-common threshold is a named bound, not a literal');
}
console.log('ok   chat evidence reaches the classifier and conditions severity');

// chatRateOf's middle state: a scan ran, but not over this key. runChatScan collects from
// visibleEntries(), so a filter change leaves classified keys the scan never sent — and calling those
// "not in entry text or chat" is the strong claim on evidence nobody gathered.
{
    const book = { entries: { 0: { uid: 0, key: ['zzznope'], content: 'Nothing relevant.' } } };
    const why = chatScan => {
        const s = buildKeyPruneScan(book, opts, new Set(), { chatScan });
        return s.reasonOf(s.classifyEntry(book.entries[0])[0]).text;
    };
    eq(why({ messagesWith: new Map([['zzznope', 0]]), messages: 100 }), 'not in entry text or chat',
        'in the scan and silent: both were checked');
    eq(why({ messagesWith: new Map([['somethingelse', 3]]), messages: 100 }), 'not in entry text',
        'scan ran but skipped this key: claim no more than was checked');
}
console.log('ok   a key the chat scan never covered is not reported as chat-checked');

// A chat "hit" is a MESSAGE, not an occurrence — the browser and the server plugin both accumulate
// through addMessageHits so they cannot drift. They had drifted: the client added 1 per message, the
// server added the occurrence count, and keyword-audit divides by the message total to get a share.
{
    const { buildAutomaton, addMessageHits } = await import('../extension/smartkeys.mjs');
    const aut = buildAutomaton(['fire']);
    const totals = new Map();
    for (const m of ['fire fire fire', 'no match here', 'FIRE once']) addMessageHits(aut, m, totals);
    eq(totals.get(0), 2, 'two of three messages contain it, however often it repeats in them');
    eq(totals.get(0) / 3 <= 1, true, 'so messagesWith/messages is a rate and can never exceed 1');
}
console.log('ok   a chat hit is one message, shared by the browser and the server');

// The Studio does not call buildKeyPruneScan directly — keyword-tools.mjs wraps it to inject ST's
// match-flag globals. That wrapper took a FIXED 4th argument and built it itself, so every option the
// Studio passed (matchWindow, chatRate) was discarded: the audit ran at the default match window with
// no chat evidence however much was gathered, and the only symptom was a verdict that never changed.
// String-sliced rather than imported because the wrapper pulls in ST (see bulk-reorder-check for the
// same trick) — a shape check, but this shape is what silently disconnected two features.
{
    const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../extension/keyword-tools.mjs', import.meta.url), 'utf8'));
    const m = src.match(/export const buildKeyPruneScan = \(([^)]*)\)([\s\S]*?)\n\n/);
    eq(!!m, true, 'the wrapper is still an arrow with a parameter list');
    const [, params, body] = m;
    const extra = (params.split(',')[3] ?? '').trim().split('=')[0].trim();
    eq(extra.length > 0, true, 'it takes a 4th parameter for the caller options');
    eq(body.includes(`...${extra}`), true, `it spreads ${extra || '(nothing)'} into the options it forwards`);
}
console.log('ok   the Studio wrapper forwards caller options instead of replacing them');
