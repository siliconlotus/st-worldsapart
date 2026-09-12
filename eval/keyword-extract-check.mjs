// Guards buildKeyPruneScan / buildKeySuggest (keyword-audit.mjs, keyword-suggest.mjs) on a tiny synthetic book.
import assert from 'node:assert';
import { buildKeyPruneScan, KEY_MIN_LENGTH, KEY_MIN_SHARED_ENTRIES } from '../extension/keyword-audit.mjs';
import { buildKeySuggest, classifyLlmCand } from '../extension/keyword-suggest.mjs';

// --- buildKeyPruneScan ---------------------------------------------------------------------------
// Four entries so df ratios are meaningful: classify priority is english-common -> dead -> df-too-common -> short, so
// the short key must stay under the too-common ratio to reach the short check.
const pruneBook = { entries: {
    0: { uid: 0, key: ['Quillfeather', 'zzzznope', 'home', 'aX'], content: 'The Quillfeather accord met at home. aX aX.', comment: 'One' },
    1: { uid: 1, key: ['Marrowford'], content: 'Marrowford lay past the home road today.', comment: 'Two' },
    2: { uid: 2, key: [], content: 'A quiet home evening, nothing of note.', comment: 'Three' },
    3: { uid: 3, key: [], content: 'Rain on the home, an ordinary night.', comment: 'Four' },
} };
const pruneOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: false,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false,     minLength: KEY_MIN_LENGTH };
const ps = buildKeyPruneScan(pruneBook, pruneOpts, new Set());
assert.strictEqual(ps.entries.length, 4, 'all keyword entries scanned');
const flagsOf = uid => Object.fromEntries(ps.classifyEntry(pruneBook.entries[uid]).map(r => [r.key, r.flag]));
const f0 = flagsOf(0);
assert.strictEqual(f0.zzzznope, 'unattested', 'a key in no entry text is unattested');
assert.strictEqual(f0.home, 'english common', 'a common English word is flagged as english-common');
assert.strictEqual(f0.aX, 'short', 'a sub-minLength key is flagged short');
assert.ok(!('Quillfeather' in f0), 'a real findable name is not flagged');
{
    const book = { entries: {
        0: { uid: 0, comment: 'Cosmonaut', content: 'the cosmonaut waited', key: ['cosmonaut', '? -zebra', '/[/'],
            keysecondary: ['? -gagarin', '? "moon', 'apollo'], selectiveLogic: 3 },
        1: { uid: 1, comment: 'Clean', content: 'apollo flew', key: ['apollo'], keysecondary: [] },
    } };
    const scan = buildKeyPruneScan(book, pruneOpts, new Set());
    const prim = scan.classifyEntry(book.entries[0]);
    assert.deepStrictEqual(prim.map(f => `${f.key}:${f.flag}:${f.code ?? ''}`),
        ['? -zebra:unusable:negation-only', '/[/:unusable:regex-invalid'],
        'an unusable primary is flagged as such, with the validator\'s own code, not as unattested');
    assert.ok(prim.every(f => scan.reasonOf(f).text.startsWith('unusable') && scan.reasonOf(f).severity),
        'it reads as unusable on the chip and carries a severity colour');
    assert.ok(prim.every(f => !scan.defChecked(f)),
        'and is NOT pre-ticked for deletion — the fix is a correction, not a removal');
    assert.deepStrictEqual(scan.unusableKeysOf(book.entries[0]).map(r => `${r.key}:${r.code}`), ['? "moon:stray-quote'],
        'only the secondary needs the separate list; the negation-only one is legitimate there');
    assert.ok(scan.unusableKeysOf(book.entries[0]).every(r => r.message), 'each carries the validator message the author reads');
    // selectiveLogic 3 (AND_ALL) above is load-bearing: under AND_ANY the negation-only secondary is reported too.
    assert.deepStrictEqual(
        scan.unusableKeysOf({ ...book.entries[0], selectiveLogic: 0 }).map(r => `${r.key}:${r.code}`),
        ['? -gagarin:negation-only', '? "moon:stray-quote'],
        'under AND_ANY the negation-only secondary is reported too, with its own code');
    assert.deepStrictEqual(scan.unusableKeysOf(book.entries[1]), [], 'a clean entry reports nothing');
}

assert.ok(!('zzzznope' in flagsOfIgnored()), 'a whitelisted key is skipped');
function flagsOfIgnored() {
    const p = buildKeyPruneScan(pruneBook, pruneOpts, new Set(['zzzznope']));
    return Object.fromEntries(p.classifyEntry(pruneBook.entries[0]).map(r => [r.key, r.flag]));
}

// A key saturating the book's own prose is `book common` only while no chat has been scanned for it — the fallback for
// `chat common`. With a chat, ubiquity in entry text is a fact about the story, not the key, and draws nothing.
const mkBook = (n, hits, key) => ({ entries: Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [i, { uid: i, key: i === 0 ? [key] : [], content: i < hits ? `A ${key} appears here.` : 'Nothing notable here.' }])) });
const gateFlag = (n, hits) => { const p = buildKeyPruneScan(mkBook(n, hits, 'widgetron'), pruneOpts, new Set()); return Object.fromEntries(p.classifyEntry(p.entries[0]).map(r => [r.key, r.flag])).widgetron; };
assert.strictEqual(gateFlag(10, 10), 'book common', 'a key in every entry\'s text is book common while no chat is scanned');
{
    const withChat = buildKeyPruneScan(mkBook(10, 10, 'widgetron'), pruneOpts, new Set(), { chatScan: { messagesWith: new Map([['widgetron', 0]]), messages: 50 } });
    assert.strictEqual(withChat.classifyEntry(mkBook(10, 10, 'widgetron').entries[0])[0], undefined, '...and with a chat that does not bear it out, nothing: ubiquity in entry text is a fact about the story');
}

// --- buildKeySuggest -----------------------------------------------------------------------------
// >= 5 entries, so a term in a single entry stays under the isFunc >30%-df cut.
const suggestBook = { entries: {
    0: { uid: 0, key: [], content: 'The brass orrery turned. The brass orrery hummed. The brass orrery gleamed by the home.', comment: 'A' },
    1: { uid: 1, key: [], content: 'A quiet street at home, nothing of note happened here at all today.', comment: 'B' },
    2: { uid: 2, key: [], content: 'Rain fell on the home and the street, a dull ordinary evening.', comment: 'C' },
    3: { uid: 3, key: [], content: 'The home stood by the street where children played after school.', comment: 'D' },
    4: { uid: 4, key: [], content: 'Down the street, past the home, a market sold bread and fish.', comment: 'E' },
} };
const ss = buildKeySuggest(suggestBook, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 });
const entry0 = ss.perEntry.find(pe => pe.entry.uid === 0);
assert.ok(entry0, 'the entry with a distinctive repeated phrase has suggestions');
const terms0 = entry0.newRows.map(r => r.term);
assert.ok(terms0.some(t => t.includes('brass orrery')), `"brass orrery" suggested (got: ${terms0.join(', ')})`);
assert.ok(!terms0.includes('home'), '"home" (common + book-wide) is not suggested');
assert.strictEqual(ss.canon("Brass Orrery's"), 'brass orrery', 'canon folds case + possessive');
assert.strictEqual(ss.dfSubstr('home'), 5, 'dfSubstr counts entries whose text contains the term');
assert.ok(Array.isArray(ss.avoid), 'avoid list returned for the LLM prompt');

// --- classifyLlmCand: few-shot echoes ------------------------------------------------------------
// Entry 1's text has none of the few-shot example words; entry 0's has "brass orrery", which must survive.
{
    const llm = (cand, uid) => classifyLlmCand(cand, {
        canon: ss.canon, exampleCanon: ss.exampleCanon, exampleWords: ss.exampleWords,
        entryText: suggestBook.entries[uid].content, dfSubstr: ss.dfSubstr, N: ss.N,
        dfCeil: 0.5, isDupe: () => false,
    }).reason;
    assert.strictEqual(llm('Quillfeather accord', 1), 'echo', 'verbatim few-shot');
    assert.strictEqual(llm('marlowford almshouse', 1), 'echo', 'mangled few-shot name');
    assert.strictEqual(llm('the almshouse', 1), 'echo', 'half a few-shot');
    assert.strictEqual(llm('thaddeus', 1), 'echo', 'one word of a few-shot name');
    assert.strictEqual(llm('brass gears', 1), 'echo', 'example word, unattested here');
    assert.strictEqual(llm('brass gears', 0), null, 'example word attested in the entry text -> kept');
    assert.strictEqual(llm('market bread', 4), null, 'an ordinary candidate is untouched');
    console.log('ok   classifyLlmCand: mangled and partial few-shot echoes dropped, attested terms kept');
}

// bgDocs (chat messages) pool into the IDF denominator.
const bgBook = { entries: { ...suggestBook.entries,
    0: { uid: 0, key: [], content: 'The brass orrery turned. The brass orrery hummed. The copper alembic dripped. The copper alembic gleamed.', comment: 'A' },
} };
{
    const opts = { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 };
    const score = (build, term) => build.perEntry.find(pe => pe.entry.uid === 0).newRows.find(r => r.term === term).score;
    const noBg = buildKeySuggest(bgBook, opts);
    assert.ok(Math.abs(score(noBg, 'brass orrery') - score(noBg, 'copper alembic')) < 1e-9, 'book-only: the two phrases tie');
    const withBg = buildKeySuggest(bgBook, { ...opts, bgDocs: Array.from({ length: 40 }, () => 'That copper alembic is dripping again.') });
    assert.ok(score(withBg, 'brass orrery') > score(withBg, 'copper alembic'), 'a chat-common term is demoted below a chat-absent one');
}

// Zipf gate, one assertion per key class.
const zipfBook = { entries: { ...suggestBook.entries,
    // All-common prose deliberately: even the f=1 words must sit in the Zipf table, or "reeked" surfaces and the entry is not empty.
    0: { uid: 0, key: [], content: 'The trash sat by the tavern door. The trash grew. The tavern was never clean.', comment: 'A' },
    // Mid-sentence capitals, as real prose: sentence-initial capitalisation is not properness evidence.
    5: { uid: 5, key: [], content: 'Everyone saw Jeffrey arrive early. Nobody heard Jeffrey explain his reasons.', comment: 'F' },
    6: { uid: 6, key: [], content: 'A basilisk guarded the gate. The basilisk never slept at night.', comment: 'G' },
    7: { uid: 7, key: [], content: 'They spoke of the comparison. Micah frowned at the ledger. Everyone asked Micah about the comparison later.', comment: 'H' },
    // Contiguous prose whose possessive the fold strips: "steal teddy bronze basilisk" is not a substring of this text.
    8: { uid: 8, key: [], content: "Kyle plotted to steal Teddy's bronze basilisk. Nobody would help him steal Teddy's bronze basilisk.", comment: 'I' },
    9: { uid: 9, key: [], content: 'The visitor was Sarah Olusanmokun from Stearns Corporation, carrying incorporation paperwork. Nobody mentioned the earlier incident again.', comment: 'J' },
    // "solidifying" is below the table floor, so the gerund rule and the POS set are what gate it.
    10: { uid: 10, key: [], content: 'Rumors kept solidifying around the Jubilee device. Sales kept solidifying around the Jubilee device.', comment: 'K' },
    // "unfolds" is out-of-table (the table has "unfold", not the inflection).
    11: { uid: 11, key: [], content: 'The ritual unfolds at midnight. The ritual unfolds in silence.', comment: 'L' },
    12: { uid: 12, key: [], content: 'Everyone watched Jeffrey acquiesce. Later they watched Jeffrey acquiesce again.', comment: 'M' },
    13: { uid: 13, key: [], content: 'Everyone saw Jeffrey self-deprecatingly wave. Then Kyle sulkily agreed, and Kyle sulkily left.', comment: 'N' },
    // "exchanges" tags Noun 1.00 in SUBTLEX; only the book's own syntax (followed by a determiner) can catch it.
    14: { uid: 14, key: [], content: 'Kyle exchanges a look with Brad. Kyle exchanges a nod with Shane.', comment: 'O' },
    15: { uid: 15, key: [], content: 'A voracious reader lived upstairs. The voracious reader never returned the books.', comment: 'P' },
    16: { uid: 16, key: [], content: 'They gathered for Dia de los Muertos at the plaza. Nobody spoke of it afterward.', comment: 'Q' },
    17: { uid: 17, key: [], content: 'The Duke of Thornhaven raised a glass of wine. Everyone toasted the Duke of Thornhaven, and Kyle refilled his glass of wine.', comment: 'R' },
    18: { uid: 18, key: [], content: 'The Marquis de Vallon arrived at court. Everyone whispered as de Vallon passed. Later de Vallon and the Marquis de Harcot argued.', comment: 'T' },
    19: { uid: 19, key: [], content: 'The crowd cheered for Queen Winnifred at the gate. Any queen would have smiled, but Queen Winnifred wept instead.', comment: 'U' },
} };
{
    const zs = buildKeySuggest(zipfBook, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 });
    const rowsOf = uid => zs.perEntry.find(pe => pe.entry.uid === uid)?.newRows ?? [];
    const terms = uid => rowsOf(uid).map(r => r.term);
    assert.strictEqual(rowsOf(0).length, 0, 'an entry whose every candidate is gated yields nothing');
    assert.ok(terms(5).includes('jeffrey'), '"Jeffrey" (common word, never lowercase) is spared as a proper noun');
    assert.ok(terms(6).includes('basilisk'), '"basilisk" (below the table floor) is suggested at full weight');
    assert.ok(terms(7).some(t => t.startsWith('micah')) && !terms(7).includes('comparison micah'), 'no phrase bridges a sentence boundary');
    assert.ok(!terms(8).some(t => t.includes('teddy bronze')), 'a gram bridging a stripped possessive is never suggested');
    assert.ok(terms(8).includes('bronze basilisk') && terms(8).includes('teddy'), 'the fold-broken gram unfolds into its attested parts');
    assert.ok(terms(9).includes('sarah olusanmokun') && terms(9).includes('stearns corporation'), 'single-mention entities surface on a summary entry');
    assert.strictEqual(rowsOf(9).find(r => r.term === 'sarah olusanmokun')?.display, 'Sarah Olusanmokun', 'display un-folds proper-noun casing from the recorded surface form');
    assert.ok(!terms(9).includes('paperwork') && !terms(9).includes('incident'), 'common f=1 words do not ride in with them');
    assert.ok(!terms(9).some(t => t.includes('nobody')), 'sentence-initial capitals are not properness evidence');
    assert.ok(!terms(10).some(t => t.includes('solidifying')), 'a rare lowercase gerund is gated as a verb form');
    assert.ok(terms(10).some(t => t.includes('jubilee')), 'the capitalised entity beside it surfaces normally');
    // The phrase "ritual unfolds" may survive demoted; assert on the unigram only.
    assert.ok(!terms(11).includes('unfolds'), 'a rare inflection of a common stem ("unfolds") is gated via de-inflection');
    assert.ok(!terms(12).some(t => t.includes('acquiesce')), 'a noun+verb clause fragment dies on the POS head test');
    assert.ok(terms(12).includes('jeffrey'), 'the proper anchor itself survives the POS kill');
    assert.ok(!terms(13).some(t => t.includes('deprecatingly') || t.includes('sulkily')), 'out-of-table -ily/-ingly adverb heads are killed');
    assert.ok(terms(13).includes('kyle') || terms(13).includes('jeffrey'), 'the names beside the adverbs survive');
    assert.ok(!terms(14).some(t => t.includes('exchanges')), 'a Noun-1.00-by-SUBTLEX verb dies on the followed-by-determiner test');
    assert.ok(terms(14).includes('kyle'), 'the subject name survives the syntax kill');
    assert.ok(!terms(15).includes('voracious'), 'a bare adjective unigram is dropped');
    assert.ok(terms(15).includes('voracious reader'), 'the same adjective is free to lead its noun phrase');
    assert.ok(terms(16).includes('dia de los muertos'), 'linker particles are admitted inside a capitalised span');
    assert.ok(terms(16).includes('muertos'), 'the bare anchor is offered beside the full name');
    assert.ok(!terms(16).some(t => t !== 'dia de los muertos' && /(^| )(de|los) /.test(' ' + t)), 'no particle-led form is offered');
    assert.strictEqual(rowsOf(16).find(r => r.term === 'dia de los muertos')?.display, 'Dia de los Muertos', 'linker casing survives the un-fold');
    assert.ok(terms(17).includes('duke of thornhaven'), '"of" interior to a proper span does not break the gram');
    assert.strictEqual(rowsOf(17).find(r => r.term === 'duke of thornhaven')?.display, 'Duke of Thornhaven', 'the of-name un-folds with its casing');
    assert.ok(!terms(17).some(t => t.includes('glass of wine')), 'a common-anchored of-phrase is still gated');
    assert.ok(!terms(18).some(t => t.endsWith(' de')), '"marquis de" is a fragment in any language');
    assert.ok(!terms(17).some(t => t.startsWith('of ') || t.startsWith('the ')), 'an English locative cannot lead a key');
    assert.ok(terms(18).includes('marquis de vallon') && terms(18).includes('marquis de harcot'), 'the full names surface');
    assert.strictEqual(rowsOf(19).find(r => r.term === 'queen winnifred')?.display, 'Queen Winnifred', 'display takes the phrase\'s own span, not per-word properness ("queen" is lowercase elsewhere)');
}
// excludeShort is off here: a bare honorific must fall to the TITLES drop, not the short cut.
{
    const tb = { entries: { ...suggestBook.entries,
        0: { uid: 0, key: [], content: 'Everyone greeted Mr Lansing warmly. Later Mr Lansing thanked everyone in the hall.', comment: 'S' },
    } };
    const ts = buildKeySuggest(tb, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: false, onlyActive: true, cap: 8 });
    const t0 = ts.perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(!t0.includes('mr'), 'bare "Mr" is dropped');
    assert.ok(t0.includes('mr lansing'), '"Mr Lansing" survives the title drop');
}

// Over-shared keys: flagged on how many entries LIST the key; needs >= KEY_MIN_SHARED_ENTRIES for the ratio.
const sharedBook = { entries: Object.fromEntries([...Array(12)].map((_, i) => [i, {
    uid: i,
    key: i === 0 ? ['astronaut', 'moonwalk'] : ['astronaut'],
    content: i === 0 ? 'The astronaut walked. A moonwalk followed. Astronaut again.' : 'Unrelated prose about weather and bread.',
}])) };
const sharedOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: false, pruneCommon: true, pruneShort: false, pruneShared: true, ignoreProper: false, minLength: KEY_MIN_LENGTH, bookShared: 0.75 };
{
    const s = buildKeyPruneScan(sharedBook, sharedOpts, new Set());
    const row = s.classifyEntry(sharedBook.entries[5]).find(r => r.key === 'astronaut');
    assert.ok(row, '"astronaut" flagged though it appears in only one entry\'s text');
    assert.strictEqual(row.flag, 'book shared', 'flagged on how many entries LIST it, not on its content df');
    assert.strictEqual(row.bookListed, 12, 'bookListed counts entries that LIST the key');
    assert.strictEqual(s.reasonOf(row).text, 'book shared (100%)', 'reason names the corpus and reports the share');
    assert.ok(!s.classifyEntry(sharedBook.entries[0]).some(r => r.key === 'moonwalk' && r.flag === 'book shared'), 'a key on one entry is not over-shared');
}
{
    const off = buildKeyPruneScan(sharedBook, { ...sharedOpts, pruneShared: false }, new Set());
    assert.ok(!off.classifyEntry(sharedBook.entries[5]).length, 'the flag is disableable');
}
{
    const hi = buildKeyPruneScan(sharedBook, { ...sharedOpts, bookShared: 1 }, new Set());
    assert.strictEqual(hi.reasonOf(hi.classifyEntry(sharedBook.entries[5])[0]).severity, 'severe', '100% share at threshold 100% is severe');
    const tiny = { entries: Object.fromEntries([...Array(9)].map((_, i) => [i, { uid: i, key: ['astronaut'], content: 'x' }])) };
    const small = buildKeyPruneScan(tiny, sharedOpts, new Set());
    assert.ok(!small.classifyEntry(tiny.entries[0]).some(r => r.flag === 'book shared'), 'skipped below KEY_MIN_SHARED_ENTRIES');
}

// classifyEntry honours the scan's entry-class scope, not just the returned entries list.
const scopeBook = { entries: {
    0: { uid: 0, key: ['zzzdead'], content: 'nothing', constant: true },
    1: { uid: 1, key: ['zzzdead'], content: 'nothing', vectorized: true },
    2: { uid: 2, key: ['zzzdead'], content: 'nothing' },
    3: { uid: 3, key: ['zzzdead'], content: 'nothing', disable: true },
} };
const scopeOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, minLength: 4 };
const scoped = (over) => {
    const s = buildKeyPruneScan(scopeBook, { ...scopeOpts, ...over }, new Set());
    return Object.values(scopeBook.entries).filter(e => s.classifyEntry(e).length).map(e => e.uid);
};
assert.deepStrictEqual(scoped({}), [0, 1, 2, 3], 'all classes flagged when all are in scope');
assert.deepStrictEqual(scoped({ scanConstant: false }), [1, 2, 3], 'constants drop out when unscanned');
assert.deepStrictEqual(scoped({ scanVectorized: false }), [0, 2, 3], 'vectorized drop out when unscanned');
// uid 3 is disabled AND keyword-class (disable is orthogonal to class), so scanKeyword off drops it too.
assert.deepStrictEqual(scoped({ scanKeyword: false }), [0, 1], 'keyword entries drop out when unscanned');
assert.deepStrictEqual(scoped({ includeInactive: false }), [0, 1, 2], 'disabled drop out when inactive excluded');

console.log('keyword-extract-check: ok');

// --- looksLikeFragment: the clause-fragment flag -------------------------------------------------
import { looksLikeFragment, FUNCTION_WORDS } from '../extension/keyword-audit.mjs';

for (const k of ['naked for morale', 'try stuff and see', 'web not spoke wheel', 'the soft stuff',
    'claiming the first wave', 'the morning is mine', 'apology to his son', 'stop parenting me',
    'listening at night', 'queer at forty-seven']) {
    assert.equal(looksLikeFragment(k), true, `fragment: "${k}"`);
}

for (const k of ['dick flag towels', 'epsom salts', 'empty buildings', 'naked house flag', 'Pride flag',
    'occupying space', 'waterproof mattress pad', 'No Contact Order', 'Randy Miller']) {
    assert.equal(looksLikeFragment(k), false, `not a fragment: "${k}"`);
}

for (const k of ['Dia de los Muertos', 'Cirque du Soleil', 'Coup de Grace']) {
    assert.equal(looksLikeFragment(k), false, `named entity spared: "${k}"`);
}

for (const k of ['Church of the Sun', 'War and Peace', 'House of the Rising Sun', 'The Bali Trip']) {
    assert.equal(looksLikeFragment(k), false, `constructed proper noun spared: "${k}"`);
}
for (const k of ['Kyle went to Teddy', 'Order of the', 'church of the sun']) {
    assert.equal(looksLikeFragment(k), true, `still a fragment: "${k}"`);
}

for (const k of ['the', 'and', 'Marjorie', 'Grindr']) {
    assert.equal(looksLikeFragment(k), false, `single word: "${k}"`);
}
assert.equal(looksLikeFragment(''), false, 'empty key');
assert.equal(looksLikeFragment(null), false, 'null key');
assert.equal(looksLikeFragment('   '), false, 'whitespace key');
assert.equal(looksLikeFragment("Kyle's heat"), false, 'possessive is not a function word');
assert.equal(looksLikeFragment('Sommers, Teddy'), false, 'comma-separated name');
assert.equal(FUNCTION_WORDS.has('and') && FUNCTION_WORDS.has('the') && FUNCTION_WORDS.has('not'), true, 'FUNCTION_WORDS is populated');
assert.equal(FUNCTION_WORDS.has('de') || FUNCTION_WORDS.has('los'), false, 'no non-English determiners in the list');
console.log('ok   looksLikeFragment: fires on clause fragments, spares concrete names and non-English entities');

// --- cohesion subsumption + properness --------------------------------------------------------
// filler pads entries so a term's df stays under the distributional function-word cut; OPTS is shared by the blocks below.
const filler = n => Object.fromEntries([...Array(n)].map((_, i) => [20 + i,
    { uid: 20 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone.' }]));
const OPTS = { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 };

// Cohesion subsumption: the longer gram at equal frequency must be a unit (count(whole)/(halfA+halfB) >= 0.4) or the contained gram wins.
{
    const assembly = { entries: { ...filler(6),
        0: { uid: 0, key: [], content: 'The bronze basilisk Arthur Baxter guarded it. Again the bronze basilisk Arthur Baxter stood watch.' },
        1: { uid: 1, key: [], content: 'A letter reached Arthur Baxter at the office today.' },
        2: { uid: 2, key: [], content: 'Nobody argued with Arthur Baxter about the schedule.' },
        3: { uid: 3, key: [], content: 'The bronze basilisk sat alone in the hall.' },
        4: { uid: 4, key: [], content: 'They polished the bronze basilisk every spring without fail.' },
    } };
    const t0 = buildKeySuggest(assembly, OPTS).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(!t0.includes('bronze basilisk arthur baxter'), 'an incohesive tetragram does not swallow its halves');
    assert.ok(t0.includes('arthur baxter') && t0.includes('bronze basilisk'), 'the halves that live independently are offered instead');
    // filler(9): with only 6 the shared word sits in 33% of entries and the function-word cut strips it before subsumption.
    const tri = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'They toured Mobius Industries HQ. The badge said Mobius Industries HQ.' },
        1: { uid: 1, key: [], content: 'A courier reached Mobius Industries before noon.' },
        2: { uid: 2, key: [], content: 'Nobody at Mobius Industries answered the phone.' },
    } };
    const y0 = buildKeySuggest(tri, OPTS).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(!y0.includes('mobius industries hq'), 'an incohesive trigram does not swallow its leading bigram');
    assert.ok(y0.includes('mobius industries'), 'the bigram that lives independently is offered instead');
    const unit = { entries: { ...filler(6),
        0: { uid: 0, key: [], content: 'They met at Pura Dalem Agung Padangtegal. Later, Pura Dalem Agung Padangtegal again.' },
    } };
    const u0 = buildKeySuggest(unit, OPTS).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(u0.includes('pura dalem agung padangtegal'), 'a cohesive tetragram survives');
    assert.ok(!u0.includes('pura dalem'), 'and still subsumes its halves');
    const titled = { entries: { ...filler(6),
        0: { uid: 0, key: [], content: 'Data Under Duress topped the report. Kyle under the awning waited for news.' },
        1: { uid: 1, key: [], content: 'The crate sat under the table for a week.' },
        2: { uid: 2, key: [], content: 'Kyle spoke plainly to the room about the schedule.' },
        3: { uid: 3, key: [], content: 'Arthur because of the rain stayed. Arthur because of the wind left.' },
    } };
    const ts = buildKeySuggest(titled, OPTS).perEntry;
    const at = uid => ts.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(!at(0).includes('kyle under'), 'a title-cased common word is not properness evidence');
    assert.ok(!at(3).some(t => t.includes('because')), 'a top-500 word cannot ride a name anchor into a phrase');
}
console.log('ok   cohesion subsumption prefers live halves; properness needs more than a capital');
// Non-English particles may LEAD a key and repeat; the filler floods them so only the positional linker rule keeps these whole.
{
    const fill = n => Object.fromEntries([...Array(n)].map((_, i) => [30 + i,
        { uid: 30 + i, key: [], content: 'De la mesa, el nombre de la casa, la vida de los otros, un dia de sol.' }]));
    const book = { entries: { ...fill(8),
        0: { uid: 0, key: [], content: 'The envoy Rosa de la Cruz arrived. Everyone bowed to Rosa de la Cruz.' },
        1: { uid: 1, key: [], content: 'The scholar ibn Suleiman spoke first. They listened to ibn Suleiman.' },
        2: { uid: 2, key: [], content: 'A letter from Baron von Furstenheim came. Baron von Furstenheim waited.' },
        3: { uid: 3, key: [], content: 'The delegate Marine le Pen spoke last. Reporters crowded Marine le Pen.' },
        4: { uid: 4, key: [], content: 'The striker Giovani dos Santos scored twice. Fans chanted for Giovani dos Santos.' },
    } };
    const s = buildKeySuggest(book, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 });
    const at = uid => s.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.display) ?? [];
    assert.ok(at(0).includes('Rosa de la Cruz'), 'a doubled particle stays inside the name');
    assert.ok(at(2).includes('Baron von Furstenheim'), 'an interior particle stays inside the name');
    assert.ok(at(1).includes('Suleiman') && !at(1).includes('ibn Suleiman'), 'a leading particle gives way to the bare name');
    const bare = { entries: { ...fill(8),
        0: { uid: 0, key: [], content: 'Everyone feared de Sacres. Nobody spoke to de Sacres.' },
        1: { uid: 1, key: [], content: 'Everyone feared de la Cruz. Nobody spoke to de la Cruz.' },
    } };
    const b = buildKeySuggest(bare, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 12 });
    const bt = uid => b.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(bt(0).includes('sacres') && !bt(0).includes('de sacres'), 'a rare name sheds its particle');
    assert.ok(bt(1).includes('de la cruz'), 'a common one keeps it — "Cruz" alone is a worse key than "de la Cruz"');
    assert.ok(at(3).includes('Marine le Pen'), 'French "le" mid-name');
    assert.ok(at(4).includes('Giovani dos Santos'), 'Portuguese "dos" mid-name');
}
console.log('ok   non-English particles lead and repeat; English linkers stay interior');
// Display case is the form the text uses MOST, counted book-wide.
{
    const filler = n => Object.fromEntries([...Array(n)].map((_, i) => [10 + i,
        { uid: 10 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone.' }]));
    // filler(9): the term sits in 3 entries; fewer than ~11 total puts it over the >30% share the function-word cut treats as a stopword.
    const book = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: '# THE OFFERING-FISH\n\nRitual notes follow in the archive below.' },
        1: { uid: 1, key: [], content: 'The offering-fish keep their own counsel, and the offering-fish rarely speak.' },
        2: { uid: 2, key: [], content: 'Guild rules bind every offering-fish who takes the vow.' },
    } };
    const s = buildKeySuggest(book, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 });
    const row = s.perEntry.find(pe => pe.entry.uid === 0)?.newRows.find(r => r.term === 'offering-fish');
    assert.ok(row, 'a term appearing only in its entry\'s header is still a candidate');
    assert.strictEqual(row.display, 'offering-fish', 'the shouted header loses to prose spelling found in other entries');
}
console.log('ok   display takes the most-used capitalisation, counted book-wide');
// maxN counts CONTENT words; a gram with exactly one possible next word is a prefix, not a unit.
{
    const book = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'They sailed to the Island of the Dome of the Slate. Nobody returns from the Island of the Dome of the Slate.' },
    } };
    const t0 = buildKeySuggest(book, OPTS).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.display) ?? [];
    assert.ok(t0.includes('Island of the Dome of the Slate'), 'linkers do not consume the phrase budget');
    assert.ok(!t0.some(t => t !== 'Island of the Dome of the Slate' && /^Island of the Dome/.test(t)), 'and its truncations do not compete with it');
    // Two occurrences of "chairman of the grain commission" are what make the successor claim sayable.
    const titles = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'He chairs the Grain Commission board. The Grain Commission met at noon.' },
        1: { uid: 1, key: [], content: 'Every Chairman of the Grain Commission speaks last, and each Chairman of the Grain Commission signs. The Grain Commission adjourned.' },
    } };
    const t1 = buildKeySuggest(titles, OPTS).perEntry.find(pe => pe.entry.uid === 1)?.newRows.map(r => r.term) ?? [];
    assert.ok(!t1.includes('chairman of the grain'), 'a gram with one possible successor is a truncation');
    assert.ok(t1.includes('chairman of the grain commission'), 'an equal-frequency non-shoulder does not displace the whole title');
}
console.log('ok   phrase budget counts content words; truncations do not outrank whole names');
// A unit phrase swallows contained PHRASES but not a bare word; a particle-led name is the exception.
{
    const opts = { ...OPTS, cap: 12 };
    const book = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'The envoy Evelyn Ashworth spoke first. Nobody interrupted Evelyn Ashworth.' },
        1: { uid: 1, key: [], content: 'They bowed to Vicomtesse de Sacres. The room watched Vicomtesse de Sacres depart.' },
    } };
    const s = buildKeySuggest(book, opts);
    const at = uid => s.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(at(0).includes('evelyn ashworth') && at(0).includes('ashworth'), 'a phrase and its bare surname are both offered');
    assert.ok(at(1).includes('sacres') && !at(1).includes('de sacres'), 'the bare surname replaces the particle form');
    assert.ok(at(1).includes('vicomtesse de sacres') && at(1).includes('vicomtesse'), 'the full title and its head both stand');
}
console.log('ok   phrases keep their bare words, except where a particle says otherwise');
// Elision writes the particle onto the name ("d'Orléans"), so the tokeniser sees one word.
{
    const fill = n => Object.fromEntries([...Array(n)].map((_, i) => [30 + i,
        { uid: 30 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone here.' }]));
    const book = { entries: { ...fill(9),
        // "Ironhold", not "Orleans": unaccented "orleans" is IN the frequency table, so it would keep its particle.
        0: { uid: 0, key: [], content: "The duchy of Ironhold passed to his heir. The Duc d'Ironhold held the duchy of Ironhold until his death." },
        1: { uid: 1, key: [], content: "A hall of Objets d'Art stood there. More Objets d'Art filled the annex." },
    } };
    const s = buildKeySuggest(book, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 12 });
    const at = uid => s.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(at(0).includes('ironhold') && !at(0).includes("d'ironhold"), 'an elided particle yields to a distinctive name');
    assert.ok(at(0).some(t => t.includes("duc d'ironhold")), 'while the full title keeps it');
    assert.ok(at(1).includes("d'art"), '"d\'Art" keeps its particle — "art" alone is a common word');
    const dart = { entries: { ...fill(9),
        0: { uid: 0, key: [], content: "The musketeer d'Artagnan rode north. Nobody outmatched d'Artagnan that season." },
        1: { uid: 1, key: [], content: 'Later Artagnan drew his sword, and Artagnan spoke of the cardinal.' },
    } };
    const dd = buildKeySuggest(dart, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 12 });
    const dt = uid => dd.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(dt(0).includes("d'artagnan"), 'the elided form stands where its entry offers no bare name');
    assert.ok(dt(1).includes('artagnan'), 'and the entry that does write the bare name offers that');
}
console.log('ok   elided particles follow the same rule as written ones');





