// matchWindow — the unit a key has to match within: scan, message, paragraph.
import { keywordScore, repeatCurveOf, scanSegments, scanWindow, segment } from '../extension/matcher.mjs';
import { eq } from './metrics.mjs';
// Dynamic, because keyword-audit.mjs pulls the ST-coupled half in at module scope on some branches.
const { buildKeyPruneScan } = await import('../extension/keyword-audit.mjs');
// One option set for every block below, so a block cannot silently differ.
const opts = {
    scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, minLength: 4,
};

const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
const score = (entry, text) => keywordScore(entry, text, entry.key, cfg).score;

// The two terms of a conjunction sit in different messages, and in different paragraphs of one message.
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

{
    const e = { key: ['? fire -drill'] };
    eq(score(e, win('scan')) > 0, false, 'scan: a drill five messages back silently vetoes the fire');
    eq(score(e, win('message')) > 0, true, 'message: the veto cannot reach across messages');
    eq(score(e, win('paragraph')) > 0, true, '...nor across paragraphs');
}

{
    const e = { key: ['astronauts'], keysecondary: ['drill'], selectiveLogic: 0 }; // AND_ANY
    eq(score(e, win('scan')) > 0, true, 'scan: the secondary is satisfied from another message');
    eq(score(e, win('paragraph')) > 0, false, 'paragraph: the secondary must be in the same segment');
}

{
    const e = { key: ['? apollo astronauts', 'fire', 'drill'] };
    const asString = keywordScore(e, scanWindow(chat, { depth: 10 }), e.key, cfg);
    const asSegments = keywordScore(e, win('scan'), e.key, cfg);
    eq(asSegments.score, asString.score, 'scan segments score identically to the joined string');
    eq(JSON.stringify(asSegments.hits), JSON.stringify(asString.hits), '...and report the same hits');
}

{
    const e = { key: ['fire'] };
    const three = ['fire', 'fire', 'fire'];
    eq(keywordScore(e, three, e.key, cfg).hits[0].count, 3, 'occurrences accumulate across segments');
    // Against repeatCurveOf, not an inlined formula: the claim is about the COUNT reaching the curve, under any curve.
    eq(keywordScore(e, three, e.key, cfg).score, repeatCurveOf(3, 1.2), '...and the curve sees a count of 3');
    eq(keywordScore(e, three, e.key, cfg).score < 3 * repeatCurveOf(1, 1.2), true, '...saturating once, not three times');
}

{
    eq(JSON.stringify(segment(segment(['a\n\nb'], 'paragraph'), 'paragraph')), '["a","b"]', 'idempotent');
    eq(JSON.stringify(segment(segment(['a\n\nb'], 'paragraph'), 'scan')), '["a\\nb"]', 'scan re-collapses');
    eq(segment(['msg'], 'paragraph').length, 1, 'a source text is its own segment, never merged');
    eq(JSON.stringify(segment(['a', '', '  '], 'message')), '["a"]', 'empty segments are dropped');
}

eq(typeof scanWindow(chat, { depth: 10 }), 'string', 'scanWindow still returns the joined string');

console.log('ok   matchWindow: scan is the old behaviour, narrower settings scope both signs');

// --- the audit segments like the runtime; a literal is slice-invariant (K5)
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
    eq(flags('scan')['apollo astronauts'], 'unattested', 'a literal phrase absent from the text is dead');
    eq(flags('paragraph')['apollo astronauts'], 'unattested', '...at every setting, being slice-invariant');
    eq(flags('scan')['astronauts'], flags('paragraph')['astronauts'], 'an attested literal is unmoved too');
}
console.log('ok   the audit segments like the runtime, and literals are slice-invariant');

// --- df counts ENTRIES, so two case variants of one key cannot both count the same entry
{
    // `Pack` and `pack` fold together when caseSensitive is off; before the guard both wrote to one cache slot.
    const content = 'The pack gathers. Pack law is absolute.';
    const entries = {};
    for (let i = 0; i < 12; i++) entries[i] = { uid: i, key: ['Pack', 'pack'], content };
    const s = buildKeyPruneScan({ entries }, { ...opts, pruneShared: true, bookShared: 0.75 }, new Set(), {});
    const p = s.classifyEntry(entries[0]).find(x => x.key === 'Pack');
    eq(p?.bookContent, 12, 'df is the entry count, not once per variant');
    eq(p.bookContent <= 12, true, '...so it can never exceed the book');
    // total is occurrences, and it feeds the short-key ratio: double-counting there mis-bands the severity.
    eq(s.classifyEntry(entries[0]).find(x => x.key === 'pack')?.bookContent, 12, 'and the variant reads the same slot, not a second one');
}
console.log('ok   a key and its case variant count one entry once');

// --- chat evidence reaches the CLASSIFIER, so reasonOf/severityOf carry it
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
    eq(none.zzznope.why, 'unattested (book)', '...and says only what it checked');
    eq(none.mother.flag, 'english common', 'no chat: the English list still flags a generic word');
    eq(none.mother.sev !== 'severe', true, '...but unevidenced it is no longer severe');

    const quiet = run({ messagesWith: new Map([['mother', 2], ['zzznope', 0]]), messages: 100 });
    eq(quiet.zzznope.why, 'unattested (book/chat)', 'chat checked and silent: the claim gets stronger');
    eq(quiet.mother, undefined, 'a common word the chat says is quiet is not flagged: the chat has answered, and the list is its fallback only');

    const live = run({ messagesWith: new Map([['mother', 40], ['zzznope', 12]]), messages: 100 });
    eq(live.zzznope, undefined, 'a key the CHAT uses is not dead — the flag is suppressed, not recoloured');
    eq(live.mother.why, `chat common · 40% of messages`, 'a common word the chat confirms over-fires reads as the chat flag, above the English list');
    eq(live.mother.sev, 'moderate', '...moderate at 40%: over the gate, not in more messages than not');
    eq(KEY_CHAT_COMMON, 0.2, 'the chat-common threshold is a named bound, not a literal');
}
console.log('ok   chat evidence reaches the classifier and conditions severity');

// --- chatRateOf's middle state: a scan ran, but not over this key
{
    const book = { entries: { 0: { uid: 0, key: ['zzznope'], content: 'Nothing relevant.' } } };
    const why = chatScan => {
        const s = buildKeyPruneScan(book, opts, new Set(), { chatScan });
        return s.reasonOf(s.classifyEntry(book.entries[0])[0]).text;
    };
    eq(why({ messagesWith: new Map([['zzznope', 0]]), messages: 100 }), 'unattested (book/chat)',
        'in the scan and silent: both were checked');
    eq(why({ messagesWith: new Map([['somethingelse', 3]]), messages: 100 }), 'unattested (book)',
        'scan ran but skipped this key: claim no more than was checked');
}
console.log('ok   a key the chat scan never covered is not reported as chat-checked');

// --- countChatHits covers `?` and /re/ keys, which the automaton pass cannot see
{
    const { countChatHits } = await import('../extension/matcher.mjs');
    const msgs = ['The copper pipe burst', 'copper, but no plumbing', 'Colonel Vasquez called', 'nothing here'];
    const got = countChatHits(['copper', '? copper pipe', '/vasqu[ei]z/i', '? zzznope'], msgs);
    // Expansion reaches here too, or a hyphenated key reports fewer messages than countKey matches.
    // Test like we fight: a conjunction across two adjacent messages fires under `scan` and not under `message`.
    const split = ['the copper arrived', 'the pipe burst', 'nothing', 'nothing'];
    eq(countChatHits(['? copper pipe'], split).messagesWith.get('? copper pipe'), 0, 'message unit: terms in different messages never co-occur');
    const sc = countChatHits(['? copper pipe'], split, { matchWindow: 'scan', depth: 2 });
    eq(`${sc.messagesWith.get('? copper pipe')}/${sc.messages} ${sc.unit}`, '1/2 window', 'scan unit: blocks of `depth` messages, and the conjunction co-occurs in one');
    const pg = countChatHits(['? copper pipe'], ['copper here.\n\npipe there.'], { matchWindow: 'paragraph' });
    eq(`${pg.messagesWith.get('? copper pipe')}/${pg.messages} ${pg.unit}`, '0/2 paragraph', 'paragraph unit: one message, two paragraphs, no co-occurrence');
    // includeNames: the speaker's name is in the unit exactly when the live scan would put it there.
    const named = [{ name: 'Sentinel', mes: 'hello' }, { name: 'You', mes: 'hi' }];
    eq(countChatHits(['Sentinel'], named, { includeNames: true }).messagesWith.get('Sentinel'), 1, 'with includeNames a key reaches the speaker');
    eq(countChatHits(['Sentinel'], named).messagesWith.get('Sentinel'), 0, '...and not without, the default');
    const hy = countChatHits(['copper-pipe'], ['a copper pipe', 'a copper-pipe', 'both copper pipe and copper-pipe', 'neither']);
    eq(hy.messagesWith.get('copper-pipe'), 3, 'both forms count, and a message holding both counts once');
    eq(got.messages, 4, 'the denominator is every message it was given');
    eq(got.messagesWith.get('copper'), 2, 'a literal is still the automaton pass');
    eq(got.messagesWith.get('? copper pipe'), 1, 'a SmartKey is evaluated per message, so both terms must share one');
    eq(got.messagesWith.get('/vasqu[ei]z/i'), 1, 'a regex key is matched as a pattern');
    eq(got.messagesWith.get('? zzznope'), 0, 'a query nothing satisfies is 0 — checked and silent, not absent from the map');

    const book = { entries: { 0: { uid: 0, key: ['? zzznope'], content: 'Nothing relevant.' } } };
    const why = chatScan => {
        const sc = buildKeyPruneScan(book, opts, new Set(), { chatScan });
        return sc.reasonOf(sc.classifyEntry(book.entries[0])[0]).text;
    };
    eq(why(undefined), 'never matches (book)', 'a dead query claims only what was checked');
    eq(why(got), 'never matches (book/chat)', '...and says so when the chat was checked too');
}
console.log('ok   the chat scan evaluates `?` and /re/ keys, not just literals');

// --- a chat hit is one MESSAGE, not an occurrence (addMessageHits, shared by browser and plugin)
{
    const { buildAutomaton, addMessageHits } = await import('../extension/smartkeys.mjs');
    const aut = buildAutomaton(['fire']);
    const totals = new Map();
    for (const m of ['fire fire fire', 'no match here', 'FIRE once']) addMessageHits(aut, m, totals);
    eq(totals.get(0), 2, 'two of three messages contain it, however often it repeats in them');
    eq(totals.get(0) / 3 <= 1, true, 'so messagesWith/messages is a rate and can never exceed 1');
}
console.log('ok   a chat hit is one message, shared by the browser and the server');

// --- keyword-tools.mjs wraps buildKeyPruneScan and must forward the caller options; string-sliced because it imports ST
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
