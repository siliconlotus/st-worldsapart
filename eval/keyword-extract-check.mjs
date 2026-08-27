// Guards the keyword classifier + ranker: buildKeyPruneScan / buildKeySuggest live in the pure,
// node-importable keyword-core.mjs, so this imports the real shipped code and runs it on a tiny
// synthetic book — a botched refactor or an edit that changes a verdict fails here instead of
// silently drifting the prune popup, the suggest popup, and Lorebook Studio.
// Run: node eval/keyword-extract-check.mjs
import assert from 'node:assert';
import { buildKeyPruneScan, buildKeySuggest, classifyLlmCand, KEY_BOOK_COMMON, KEY_MIN_LENGTH, KEY_MIN_BOOK_COMMON_ENTRIES } from '../extension/keyword-core.mjs';

// --- buildKeyPruneScan ---------------------------------------------------------------------------
// Four entries so df ratios are meaningful (the classify priority is english-common -> dead ->
// df-too-common -> short, so a short key must stay under the too-common ratio to reach the short
// check). Entry 0 lists: "Quillfeather" (a real findable name, in only 1/4 -> not flagged),
// "zzzznope" (dead, in no text), "home" (common English), "aX" (short, in only 1/4 -> not too-common).
const pruneBook = { entries: {
    0: { uid: 0, key: ['Quillfeather', 'zzzznope', 'home', 'aX'], content: 'The Quillfeather accord met at home. aX aX.', comment: 'One' },
    1: { uid: 1, key: ['Marrowford'], content: 'Marrowford lay past the home road today.', comment: 'Two' },
    2: { uid: 2, key: [], content: 'A quiet home evening, nothing of note.', comment: 'Three' },
    3: { uid: 3, key: [], content: 'Rain on the home, an ordinary night.', comment: 'Four' },
} };
const pruneOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: false,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false,     bookCommon: KEY_BOOK_COMMON, minLength: KEY_MIN_LENGTH };
const ps = buildKeyPruneScan(pruneBook, pruneOpts, new Set());
assert.strictEqual(ps.entries.length, 4, 'all keyword entries scanned');
const flagsOf = uid => Object.fromEntries(ps.classifyEntry(pruneBook.entries[uid]).map(r => [r.key, r.flag]));
const f0 = flagsOf(0);
assert.strictEqual(f0.zzzznope, 'unattested', 'a key in no entry text is unattested');
assert.strictEqual(f0.home, 'english common', 'a common English word is flagged as english-common');
assert.strictEqual(f0.aX, 'short', 'a sub-minLength key is flagged short');
assert.ok(!('Quillfeather' in f0), 'a real findable name is not flagged');
// Keys the MATCHER refuses to act on, reported so an imported book's malformed key stops being
// invisible. A PRIMARY gets the `unusable` flag on its own chip, ahead of every evidence-based verdict
// — `/[/` used to come back `unattested`, i.e. "never matches", which reads as prose that happens not
// to use the key rather than a key WA drops. A SECONDARY has no chip, so unusableKeysOf is its only
// surface — and position matters: `negation-only` is fatal for a primary (it fires on absence alone)
// and legitimate for a secondary, which never fires by itself because the primary gates activation.
// The rule lives in matcher.mjs; this only checks the audit reports its outcome.
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
    assert.ok(prim.every(f => scan.reasonOf(f).text.startsWith('unusable') && scan.reasonOf(f).color),
        'it reads as unusable on the chip and carries a severity colour');
    assert.ok(prim.every(f => !scan.defChecked(f)),
        'and is NOT pre-ticked for deletion — the fix is a correction, not a removal');
    assert.deepStrictEqual(scan.unusableKeysOf(book.entries[0]).map(r => `${r.key}:${r.code}`), ['? "moon:stray-quote'],
        'only the secondary needs the separate list; the negation-only one is legitimate there');
    assert.ok(scan.unusableKeysOf(book.entries[0]).every(r => r.message), 'each carries the validator message the author reads');
    // AND_ALL above, because under AND_ANY the negation-only key is dropped too (matcher.mjs: a
    // negation is satisfied by absence, so an OR branch built from one never gates). The audit is the
    // only place an author is told, so it has to follow the operator rather than the position alone.
    assert.deepStrictEqual(
        scan.unusableKeysOf({ ...book.entries[0], selectiveLogic: 0 }).map(r => `${r.key}:${r.code}`),
        ['? -gagarin:negation-only', '? "moon:stray-quote'],
        'under AND_ANY the negation-only secondary is reported too, with its own code');
    assert.deepStrictEqual(scan.unusableKeysOf(book.entries[1]), [], 'a clean entry reports nothing');
}

// The ignore whitelist skips a key entirely.
assert.ok(!('zzzznope' in flagsOfIgnored()), 'a whitelisted key is skipped');
function flagsOfIgnored() {
    const p = buildKeyPruneScan(pruneBook, pruneOpts, new Set(['zzzznope']));
    return Object.fromEntries(p.classifyEntry(pruneBook.entries[0]).map(r => [r.key, r.flag]));
}

// Min-entries gate: the df-based lorebook-common flag only fires once the corpus is big enough
// (>= KEY_MIN_BOOK_COMMON_ENTRIES). "widgetron" is non-English-common and appears in >37.5% of entries.
const mkBook = (n, hits, key) => ({ entries: Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [i, { uid: i, key: i === 0 ? [key] : [], content: i < hits ? `A ${key} appears here.` : 'Nothing notable here.' }])) });
const gateFlag = (n, hits) => { const p = buildKeyPruneScan(mkBook(n, hits, 'widgetron'), pruneOpts, new Set()); return Object.fromEntries(p.classifyEntry(p.entries[0]).map(r => [r.key, r.flag])).widgetron; };
assert.strictEqual(gateFlag(4, 3), undefined, `lorebook-common suppressed below ${KEY_MIN_BOOK_COMMON_ENTRIES} entries`);
assert.strictEqual(gateFlag(10, 6), 'book common', `book-common fires at/above ${KEY_MIN_BOOK_COMMON_ENTRIES} entries`);

// --- buildKeySuggest -----------------------------------------------------------------------------
// A distinctive multi-word phrase repeated within one entry (tf>=2) but rare across the book should
// surface; a generic common word should not. Needs >=5 entries so a term in a single entry stays
// under the isFunc >30%-df cut (which otherwise strips it from the n-grams as a "function word").
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
// canon / dfSubstr / avoid are handed back for the ✨ path + inline edits.
assert.strictEqual(ss.canon("Brass Orrery's"), 'brass orrery', 'canon folds case + possessive');
assert.strictEqual(ss.dfSubstr('home'), 5, 'dfSubstr counts entries whose text contains the term');
assert.ok(Array.isArray(ss.avoid), 'avoid list returned for the LLM prompt');

// --- classifyLlmCand: few-shot echoes ------------------------------------------------------------
// The model regurgitates the prompt's invented examples, and rarely verbatim — a mangled name or half
// a phrase is the common case, and both used to sail past the exact-phrase test. Entry 1's text has
// none of the example words; entry 0's has "brass orrery", which must therefore survive.
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
    // The hatch: an example word the entry's own prose uses is the entry's, not the prompt's.
    assert.strictEqual(llm('brass gears', 0), null, 'example word attested in the entry text -> kept');
    assert.strictEqual(llm('market bread', 4), null, 'an ordinary candidate is untouched');
    console.log('ok   classifyLlmCand: mangled and partial few-shot echoes dropped, attested terms kept');
}

// Background docs (bgDocs = chat messages) pool into the IDF denominator. On a small book both
// phrases have df 1, equal tf and rare anchors (both invisible to the Zipf gate), so book-only
// TF-IDF cannot separate them; a term flooding the chat must be demoted below the one the chat
// never mentions.
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

// Zipf gate, one assertion per key class: an English-common unigram is gated however unique it
// looks inside a small book ("trash" 4.4, "tavern" 3.6 — in the table = gated for unigrams), and an
// entry whose every candidate is gated yields nothing at all; an uncommon unigram survives at full
// weight ("minotaur" 2.8, below the table floor); a common word only ever seen capitalised is a
// proper noun and survives ("Jeffrey" 3.9); and no phrase bridges a sentence boundary
// ("comparison. Micah" is not a bigram).
const zipfBook = { entries: { ...suggestBook.entries,
    // All-common prose deliberately: even the f=1 words must sit in the Zipf table, or one of them
    // ("reeked") surfaces as a legitimate rare-word candidate and the entry is no longer empty.
    0: { uid: 0, key: [], content: 'The trash sat by the tavern door. The trash grew. The tavern was never clean.', comment: 'A' },
    // Mid-sentence capitals, as real prose would have: sentence-initial capitalisation is not
    // properness evidence (or "Nobody" would count as a name).
    5: { uid: 5, key: [], content: 'Everyone saw Jeffrey arrive early. Nobody heard Jeffrey explain his reasons.', comment: 'F' },
    6: { uid: 6, key: [], content: 'A minotaur guarded the gate. The minotaur never slept at night.', comment: 'G' },
    7: { uid: 7, key: [], content: 'They spoke of the comparison. Micah frowned at the ledger. Everyone asked Micah about the comparison later.', comment: 'H' },
    // Real contiguous prose whose possessive the token fold strips: the joined gram "steal teddy
    // bronze minotaur" is NOT a substring of this text, so it could never fire as a key.
    8: { uid: 8, key: [], content: "Kyle plotted to steal Teddy's bronze minotaur. Nobody would help him steal Teddy's bronze minotaur.", comment: 'I' },
    // Summary-style entry: every entity is mentioned exactly once, so TF is no signal at all —
    // f=1 terms must still surface when the gate is fully confident (rare/proper anchor), and
    // common f=1 words must not ride in with them.
    9: { uid: 9, key: [], content: 'The visitor was Sarah Olusanmokun from Stearns Corporation, carrying incorporation paperwork. Nobody mentioned the earlier incident again.', comment: 'J' },
    // A rare-by-z gerund ("solidifying" 2.58, below the table floor) must still be gated: lowercase
    // non-proper -ing words are verb forms. The capitalised entity beside it surfaces normally.
    10: { uid: 10, key: [], content: 'Rumors kept solidifying around the Jubilee device. Sales kept solidifying around the Jubilee device.', comment: 'K' },
    // "unfolds" is out-of-table (SUBTLEX has "unfold" 3.1 but not the inflection) — de-inflection
    // must gate it like its stem.
    11: { uid: 11, key: [], content: 'The ritual unfolds at midnight. The ritual unfolds in silence.', comment: 'L' },
    // Noun+verb clause fragment: "jeffrey acquiesce" rides a proper anchor and a rare verb, so
    // the frequency gates pass it — only the SUBTLEX POS head test (acquiesce: Verb 1.0) kills it.
    12: { uid: 12, key: [], content: 'Everyone watched Jeffrey acquiesce. Later they watched Jeffrey acquiesce again.', comment: 'M' },
    // Adverbs SUBTLEX never saw: out-of-table -ily/-ingly heads are adverb morphology
    // ("kyle sulkily", "jeffrey self-deprecatingly"); the names beside them survive.
    13: { uid: 13, key: [], content: 'Everyone saw Jeffrey self-deprecatingly wave. Then Kyle sulkily agreed, and Kyle sulkily left.', comment: 'N' },
    // "exchanges" tags Noun 1.00 in SUBTLEX (dialogue never verbs it) — only the book's own
    // syntax can catch it: consistently followed by a determiner = takes objects = verb.
    14: { uid: 14, key: [], content: 'Kyle exchanges a look with Brad. Kyle exchanges a nod with Shane.', comment: 'O' },
    // Bare adjectives over-fire detached from their noun: "voracious" (Adjective 1.00, rare by z)
    // dies alone but is free to lead its noun phrase.
    15: { uid: 15, key: [], content: 'A voracious reader lived upstairs. The voracious reader never returned the books.', comment: 'P' },
    // Non-English name particles: "de"/"los" are lowercase and common by z, but legitimate as
    // interior linkers of a capitalised span — the full name must surface (and subsume "Muertos").
    16: { uid: 16, key: [], content: 'They gathered for Dia de los Muertos at the plaza. Nobody spoke of it afterward.', comment: 'Q' },
    // English linkers interior to a name: "of" (a FUNCTION_WORD) must not break "Duke of
    // Thornhaven" — while a common-anchored of-phrase ("glass of wine") is still gated.
    17: { uid: 17, key: [], content: 'The Duke of Thornhaven raised a glass of wine. Everyone toasted the Duke of Thornhaven, and Kyle refilled his glass of wine.', comment: 'R' },
    // Edge-linker grams are windowing accidents: the address form "de Vallon" recurs more often
    // than the full name, so without the structural kill it outscores and cap-crowds the real
    // "Marquis de Vallon".
    18: { uid: 18, key: [], content: 'The Marquis de Vallon arrived at court. Everyone whispered as de Vallon passed. Later de Vallon and the Marquis de Harcot argued.', comment: 'T' },
    // Display casing must come from the phrase's own span: "queen" appears lowercase elsewhere,
    // so per-word properness would render "queen Winnifred" — the text says "Queen Winnifred".
    19: { uid: 19, key: [], content: 'The crowd cheered for Queen Winnifred at the gate. Any queen would have smiled, but Queen Winnifred wept instead.', comment: 'U' },
} };
{
    const zs = buildKeySuggest(zipfBook, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 });
    const rowsOf = uid => zs.perEntry.find(pe => pe.entry.uid === uid)?.newRows ?? [];
    const terms = uid => rowsOf(uid).map(r => r.term);
    assert.strictEqual(rowsOf(0).length, 0, 'an entry whose every candidate is gated yields nothing');
    assert.ok(terms(5).includes('jeffrey'), '"Jeffrey" (common word, never lowercase) is spared as a proper noun');
    assert.ok(terms(6).includes('minotaur'), '"minotaur" (below the table floor) is suggested at full weight');
    // "micah frowned" (same f, longer) subsumes bare "micah" in the kept-filter; the point here is
    // only that nothing bridges the sentence boundary.
    assert.ok(terms(7).some(t => t.startsWith('micah')) && !terms(7).includes('comparison micah'), 'no phrase bridges a sentence boundary');
    // Fold-broken grams die on attestation (dfSubstr 0), and dying BEFORE subsumption unfolds them:
    // the parts on each side of the possessive surface instead of being swallowed by the long gram.
    assert.ok(!terms(8).some(t => t.includes('teddy bronze')), 'a gram bridging a stripped possessive is never suggested');
    assert.ok(terms(8).includes('bronze minotaur') && terms(8).includes('teddy'), 'the fold-broken gram unfolds into its attested parts');
    assert.ok(terms(9).includes('sarah olusanmokun') && terms(9).includes('stearns corporation'), 'single-mention entities surface on a summary entry');
    assert.strictEqual(rowsOf(9).find(r => r.term === 'sarah olusanmokun')?.display, 'Sarah Olusanmokun', 'display un-folds proper-noun casing from the recorded surface form');
    assert.ok(!terms(9).includes('paperwork') && !terms(9).includes('incident'), 'common f=1 words do not ride in with them');
    assert.ok(!terms(9).some(t => t.includes('nobody')), 'sentence-initial capitals are not properness evidence');
    assert.ok(!terms(10).some(t => t.includes('solidifying')), 'a rare lowercase gerund is gated as a verb form');
    assert.ok(terms(10).some(t => t.includes('jubilee')), 'the capitalised entity beside it surfaces normally');
    // The phrase "ritual unfolds" may survive demoted (the phrase ramp tolerates mid-band anchors);
    // de-inflection's job is the unigram: "unfolds" must inherit unfold's z and be gated.
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
    // The bare anchor is offered alongside the full name (the user picks), but the PARTICLE forms
    // are not: a leading particle means nothing and, as a substring key, "Muertos" already matches
    // every occurrence of "de los Muertos".
    assert.ok(terms(16).includes('muertos'), 'the bare anchor is offered beside the full name');
    assert.ok(!terms(16).some(t => t !== 'dia de los muertos' && /(^| )(de|los) /.test(' ' + t)), 'no particle-led form is offered');
    assert.strictEqual(rowsOf(16).find(r => r.term === 'dia de los muertos')?.display, 'Dia de los Muertos', 'linker casing survives the un-fold');
    assert.ok(terms(17).includes('duke of thornhaven'), '"of" interior to a proper span does not break the gram');
    assert.strictEqual(rowsOf(17).find(r => r.term === 'duke of thornhaven')?.display, 'Duke of Thornhaven', 'the of-name un-folds with its casing');
    assert.ok(!terms(17).some(t => t.includes('glass of wine')), 'a common-anchored of-phrase is still gated');
    // Edges are asymmetric because naming conventions are: a particle binds to the toponym after it
    // ("de Vallon" is how you refer to the man), an English locative needs its title back, and
    // nothing may trail a linker in either language.
    assert.ok(!terms(18).some(t => t.endsWith(' de')), '"marquis de" is a fragment in any language');
    assert.ok(!terms(17).some(t => t.startsWith('of ') || t.startsWith('the ')), 'an English locative cannot lead a key');
    assert.ok(terms(18).includes('marquis de vallon') && terms(18).includes('marquis de harcot'), 'the full names surface');
    assert.strictEqual(rowsOf(19).find(r => r.term === 'queen winnifred')?.display, 'Queen Winnifred', 'display takes the phrase\'s own span, not per-word properness ("queen" is lowercase elsewhere)');
}
// Bare honorifics are perfect fake proper nouns (always capitalised, never lowercase), so the
// casing logic can't reject them — the TITLES drop must, even with the short-term cut disabled.
{
    const tb = { entries: { ...suggestBook.entries,
        0: { uid: 0, key: [], content: 'Everyone greeted Mr Lansing warmly. Later Mr Lansing thanked everyone in the hall.', comment: 'S' },
    } };
    const ts = buildKeySuggest(tb, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: false, onlyActive: true, cap: 8 });
    const t0 = ts.perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(!t0.includes('mr'), 'bare "Mr" is dropped');
    assert.ok(t0.includes('mr lansing'), '"Mr Lansing" survives the title drop');
}

// Over-shared keys: flagged on how many entries LIST the key, independent of how often it appears in
// their TEXT. "astronaut" sits in one entry's prose but is keyed on all 12, so the content-frequency
// flags can't see it. Needs >= KEY_MIN_BOOK_COMMON_ENTRIES entries for the ratio to mean anything.
const sharedBook = { entries: Object.fromEntries([...Array(12)].map((_, i) => [i, {
    uid: i,
    key: i === 0 ? ['astronaut', 'moonwalk'] : ['astronaut'],
    content: i === 0 ? 'The astronaut walked. A moonwalk followed. Astronaut again.' : 'Unrelated prose about weather and bread.',
}])) };
const sharedOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: false, pruneCommon: true, pruneShort: false, pruneShared: true, ignoreProper: false, bookCommon: KEY_BOOK_COMMON, minLength: KEY_MIN_LENGTH, bookShared: 0.75 };
{
    const s = buildKeyPruneScan(sharedBook, sharedOpts, new Set());
    const row = s.classifyEntry(sharedBook.entries[5]).find(r => r.key === 'astronaut');
    assert.ok(row, '"astronaut" flagged though it appears in only one entry\'s text');
    assert.strictEqual(row.flag, 'book shared', 'flagged as book-shared, not as book-common');
    assert.strictEqual(row.bookListed, 12, 'bookListed counts entries that LIST the key');
    assert.strictEqual(s.reasonOf(row).text, 'book shared (100%)', 'reason names the corpus and reports the share');
    // 100% >= threshold -> red, same banding as the frequency flag.
    assert.strictEqual(s.reasonOf(row).color, s.reasonOf({ flag: 'book common', bookContent: 12 }).color, 'severity banding matches book common');
    // The one-entry key is untouched by the shared flag.
    assert.ok(!s.classifyEntry(sharedBook.entries[0]).some(r => r.key === 'moonwalk' && r.flag === 'book shared'), 'a key on one entry is not over-shared');
}
{
    const off = buildKeyPruneScan(sharedBook, { ...sharedOpts, pruneShared: false }, new Set());
    assert.ok(!off.classifyEntry(sharedBook.entries[5]).length, 'the flag is disableable');
}
{
    // Between 0.75x and 1x the threshold is the yellow danger zone; below 0.75x nothing fires.
    const hi = buildKeyPruneScan(sharedBook, { ...sharedOpts, bookShared: 1 }, new Set());
    assert.strictEqual(hi.reasonOf(hi.classifyEntry(sharedBook.entries[5])[0]).color, '#e06c6c', '100% share at threshold 100% is red');
    const tiny = { entries: Object.fromEntries([...Array(9)].map((_, i) => [i, { uid: i, key: ['astronaut'], content: 'x' }])) };
    const small = buildKeyPruneScan(tiny, sharedOpts, new Set());
    assert.ok(!small.classifyEntry(tiny.entries[0]).some(r => r.flag === 'book shared'), 'skipped below KEY_MIN_BOOK_COMMON_ENTRIES');
}

// classifyEntry must honour the scan's entry-class scope, not just the returned `entries` list —
// the Studio explorer iterates its OWN list and asks per entry, so a scope-blind classifier keeps
// flagging classes the user just told it to skip.
const scopeBook = { entries: {
    0: { uid: 0, key: ['zzzdead'], content: 'nothing', constant: true },
    1: { uid: 1, key: ['zzzdead'], content: 'nothing', vectorized: true },
    2: { uid: 2, key: ['zzzdead'], content: 'nothing' },
    3: { uid: 3, key: ['zzzdead'], content: 'nothing', disable: true },
} };
const scopeOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, bookCommon: 0.5, minLength: 4 };
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
// Machine-written keys are lifted verbatim from an entry's own prose, so they sit in that entry's text
// (df 1, not "dead"), appear nowhere else (not too-common, not shared) and are long (not short) — every
// other category misses them. What is decidable from the key alone is COHERENCE, not specificity.
import { looksLikeFragment, FUNCTION_WORDS } from '../extension/keyword-core.mjs';

// Fires: real auto-generated keys that name nothing.
for (const k of ['naked for morale', 'try stuff and see', 'web not spoke wheel', 'the soft stuff',
    'claiming the first wave', 'the morning is mine', 'apology to his son', 'stop parenting me',
    'listening at night', 'queer at forty-seven']) {
    assert.equal(looksLikeFragment(k), true, `fragment: "${k}"`);
}

// SPARED, and these are the ones that matter — a key can be hyper-specific and still legitimate,
// because it NAMES something concrete and might recur. Specificity is not the defect; incoherence is.
for (const k of ['dick flag towels', 'epsom salts', 'empty buildings', 'naked house flag', 'Pride flag',
    'occupying space', 'waterproof mattress pad', 'No Contact Order', 'Randy Miller']) {
    assert.equal(looksLikeFragment(k), false, `not a fragment: "${k}"`);
}

// NON-ENGLISH NAMED ENTITIES MUST SURVIVE. The test is English function words specifically, so a Spanish
// or French determiner inside a proper name does not trip it. This is the case that would break first if
// anyone "improved" the predicate by adding a generic stopword list.
for (const k of ['Dia de los Muertos', 'Cirque du Soleil', 'Coup de Grace']) {
    assert.equal(looksLikeFragment(k), false, `named entity spared: "${k}"`);
}

// CONSTRUCTED PROPER NOUNS: a capitalised frame with name-particle interior is a name, not a fragment.
for (const k of ['Church of the Sun', 'War and Peace', 'House of the Rising Sun', 'The Bali Trip']) {
    assert.equal(looksLikeFragment(k), false, `constructed proper noun spared: "${k}"`);
}
// ...but a non-particle lowercase word, a lowercase end, or no capitals is still prose.
for (const k of ['Kyle went to Teddy', 'Order of the', 'church of the sun']) {
    assert.equal(looksLikeFragment(k), true, `still a fragment: "${k}"`);
}

// A single word is never a fragment — it is a name, or the English-common flag catches it.
for (const k of ['the', 'and', 'Marjorie', 'Grindr']) {
    assert.equal(looksLikeFragment(k), false, `single word: "${k}"`);
}
assert.equal(looksLikeFragment(''), false, 'empty key');
assert.equal(looksLikeFragment(null), false, 'null key');
assert.equal(looksLikeFragment('   '), false, 'whitespace key');
// Punctuation and possessives must not fabricate a second word.
assert.equal(looksLikeFragment("Kyle's heat"), false, 'possessive is not a function word');
assert.equal(looksLikeFragment('Sommers, Teddy'), false, 'comma-separated name');
// The suggester and the audit share one list, so they cannot disagree about what junk looks like.
assert.equal(FUNCTION_WORDS.has('and') && FUNCTION_WORDS.has('the') && FUNCTION_WORDS.has('not'), true, 'FUNCTION_WORDS is populated');
assert.equal(FUNCTION_WORDS.has('de') || FUNCTION_WORDS.has('los'), false, 'no non-English determiners in the list');
console.log('ok   looksLikeFragment: fires on clause fragments, spares concrete names and non-English entities');

// --- cohesion subsumption + properness --------------------------------------------------------
// At equal frequency the longer gram used to win outright, on the assumption that longer is more
// specific. Specificity is worthless if the string never occurs: measured against a real chat, a
// half of an INCOHESIVE tetragram out-fires the whole 96% of the time. So the longer gram now has
// to be a unit — count(whole)/(count(halfA)+count(halfB)) >= 0.4 — or the contained gram wins.
{
    const filler = n => Object.fromEntries([...Array(n)].map((_, i) => [20 + i,
        { uid: 20 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone.' }]));
    const opts = { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 };
    // Both halves live independently across the book, so the tetragram is an assembly.
    const assembly = { entries: { ...filler(6),
        0: { uid: 0, key: [], content: 'The bronze minotaur Arthur Baxter guarded it. Again the bronze minotaur Arthur Baxter stood watch.' },
        1: { uid: 1, key: [], content: 'A letter reached Arthur Baxter at the office today.' },
        2: { uid: 2, key: [], content: 'Nobody argued with Arthur Baxter about the schedule.' },
        3: { uid: 3, key: [], content: 'The bronze minotaur sat alone in the hall.' },
        4: { uid: 4, key: [], content: 'They polished the bronze minotaur every spring without fail.' },
    } };
    const t0 = buildKeySuggest(assembly, opts).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(!t0.includes('bronze minotaur arthur baxter'), 'an incohesive tetragram does not swallow its halves');
    assert.ok(t0.includes('arthur baxter') && t0.includes('bronze minotaur'), 'the halves that live independently are offered instead');
    // A trigram decomposes into OVERLAPPING bigrams (ABC -> AB + BC), which is what the leading/
    // trailing bigram pair gives: "Mobius Industries HQ" must lose to "Mobius Industries".
    // filler(9): with only 6, "industries" sits in 33% of entries and the distributional
    // function-word cut strips it from every n-gram before subsumption is ever consulted.
    const tri = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'They toured Mobius Industries HQ. The badge said Mobius Industries HQ.' },
        1: { uid: 1, key: [], content: 'A courier reached Mobius Industries before noon.' },
        2: { uid: 2, key: [], content: 'Nobody at Mobius Industries answered the phone.' },
    } };
    const y0 = buildKeySuggest(tri, opts).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(!y0.includes('mobius industries hq'), 'an incohesive trigram does not swallow its leading bigram');
    assert.ok(y0.includes('mobius industries'), 'the bigram that lives independently is offered instead');
    // Same shape, but nothing inside it ever occurs apart — a unit, which still wins the tie.
    const unit = { entries: { ...filler(6),
        0: { uid: 0, key: [], content: 'They met at Pura Dalem Agung Padangtegal. Later, Pura Dalem Agung Padangtegal again.' },
    } };
    const u0 = buildKeySuggest(unit, opts).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.term) ?? [];
    assert.ok(u0.includes('pura dalem agung padangtegal'), 'a cohesive tetragram survives');
    assert.ok(!u0.includes('pura dalem'), 'and still subsumes its halves');
    // Properness has ONE definition: capitalised mid-sentence AND never seen lowercase. Title case
    // capitalises anything ("Data Under Duress"), so a word that also appears lowercase is not a
    // name — otherwise it qualified every word of an f=1 phrase and "Kyle under" became a key.
    const titled = { entries: { ...filler(6),
        0: { uid: 0, key: [], content: 'Data Under Duress topped the report. Kyle under the awning waited for news.' },
        1: { uid: 1, key: [], content: 'The crate sat under the table for a week.' },
        2: { uid: 2, key: [], content: 'Kyle spoke plainly to the room about the schedule.' },
        // A name anchor makes a phrase maximally rare, so a top-500 word can ride along on it
        // ("Arthur because") unless the phrase also has a commonness ceiling.
        3: { uid: 3, key: [], content: 'Arthur because of the rain stayed. Arthur because of the wind left.' },
    } };
    const ts = buildKeySuggest(titled, opts).perEntry;
    const at = uid => ts.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(!at(0).includes('kyle under'), 'a title-cased common word is not properness evidence');
    assert.ok(!at(3).some(t => t.includes('because')), 'a top-500 word cannot ride a name anchor into a phrase');
}
console.log('ok   cohesion subsumption prefers live halves; properness needs more than a capital');
// Non-English particles bind to what follows, so they may LEAD a key and may repeat ("de la
// Cruz"). The filler floods the particles so the distributional function-word cut would otherwise
// strip every gram containing them — the positional linker rule is what keeps these whole.
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
    // A LEADING particle gives way to the name it carries: as a substring key "Suleiman" matches
    // every "ibn Suleiman", and the particle contributes nothing to what the key means.
    assert.ok(at(1).includes('Suleiman') && !at(1).includes('ibn Suleiman'), 'a leading particle gives way to the bare name');
    // ...but only when what remains is distinctive. Stripping is a trade, and the frequency table
    // prices it: "sacres" is absent from it, while "cruz" 3.5, "santos" 3.6 and "pen" 4.4 are
    // listed — so "de la Cruz" keeps its particle rather than degrading to a common surname.
    const bare = { entries: { ...fill(8),
        0: { uid: 0, key: [], content: 'Everyone feared de Sacres. Nobody spoke to de Sacres.' },
        1: { uid: 1, key: [], content: 'Everyone feared de la Cruz. Nobody spoke to de la Cruz.' },
    } };
    const b = buildKeySuggest(bare, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 12 });
    const bt = uid => b.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(bt(0).includes('sacres') && !bt(0).includes('de sacres'), 'a rare name sheds its particle');
    assert.ok(bt(1).includes('de la cruz'), 'a common one keeps it — "Cruz" alone is a worse key than "de la Cruz"');
    // Real names, and the reason the vocabulary is broad: each of these fragments into junk under a
    // list that happens to omit its particle.
    assert.ok(at(3).includes('Marine le Pen'), 'French "le" mid-name');
    assert.ok(at(4).includes('Giovani dos Santos'), 'Portuguese "dos" mid-name');
}
console.log('ok   non-English particles lead and repeat; English linkers stay interior');
// Display case is the form the text uses MOST, and the evidence is book-wide. A machine-written
// entry shouts its subject in a markdown header, so the entry that produces the candidate may hold
// only the shouted spelling while the prose that spells it normally sits in other entries.
{
    const filler = n => Object.fromEntries([...Array(n)].map((_, i) => [10 + i,
        { uid: 10 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone.' }]));
    // filler(9): the term sits in 3 entries, so fewer than ~11 total puts it over the >30% share
    // that the distributional function-word cut treats as a stopword, and no gram survives at all.
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
// maxN counts CONTENT words, so a name padded with grammar still fits the budget, and a gram that
// has exactly one possible next word is a prefix rather than a unit.
{
    const filler = n => Object.fromEntries([...Array(n)].map((_, i) => [20 + i,
        { uid: 20 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone.' }]));
    const opts = { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 };
    // Seven tokens, three of which mean anything — under a token-counted budget of 4 this name can
    // only ever be seen through a window across its middle.
    const book = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'They sailed to the Island of the Dome of the Slate. Nobody returns from the Island of the Dome of the Slate.' },
    } };
    const t0 = buildKeySuggest(book, opts).perEntry.find(pe => pe.entry.uid === 0)?.newRows.map(r => r.display) ?? [];
    assert.ok(t0.includes('Island of the Dome of the Slate'), 'linkers do not consume the phrase budget');
    assert.ok(!t0.some(t => t !== 'Island of the Dome of the Slate' && /^Island of the Dome/.test(t)), 'and its truncations do not compete with it');
    // "grain commission" always follows "chairman of the", so the window stopping at "grain" is a
    // prefix; two occurrences are what makes that sayable.
    const titles = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'He chairs the Grain Commission board. The Grain Commission met at noon.' },
        1: { uid: 1, key: [], content: 'Every Chairman of the Grain Commission speaks last, and each Chairman of the Grain Commission signs. The Grain Commission adjourned.' },
    } };
    const t1 = buildKeySuggest(titles, opts).perEntry.find(pe => pe.entry.uid === 1)?.newRows.map(r => r.term) ?? [];
    assert.ok(!t1.includes('chairman of the grain'), 'a gram with one possible successor is a truncation');
    // Only the shoulder a phrase decomposes INTO may replace it. Here the shoulder ("grain
    // commission", 3 mentions) does not share the title's frequency, so the only equal-frequency
    // gram inside it is bare "chairman" — which is not what cohesion weighed, so both stand and the
    // title is not reduced to a job word.
    assert.ok(t1.includes('chairman of the grain commission'), 'an equal-frequency non-shoulder does not displace the whole title');
}
console.log('ok   phrase budget counts content words; truncations do not outrank whole names');
// A unit phrase swallows contained PHRASES but not a bare word — the word is a broader instrument
// and often the form the chat actually uses ("Ashworth" 149 chat hits against 4 for "Evelyn
// Ashworth"), so both are offered. A particle-led name is the exception: "Sacres" occurs only ever
// inside "de Sacres", and the particle is the structural tell.
{
    const filler = n => Object.fromEntries([...Array(n)].map((_, i) => [20 + i,
        { uid: 20 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone.' }]));
    const opts = { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 12 };
    const book = { entries: { ...filler(9),
        0: { uid: 0, key: [], content: 'The envoy Evelyn Ashworth spoke first. Nobody interrupted Evelyn Ashworth.' },
        1: { uid: 1, key: [], content: 'They bowed to Vicomtesse de Sacres. The room watched Vicomtesse de Sacres depart.' },
    } };
    const s = buildKeySuggest(book, opts);
    const at = uid => s.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(at(0).includes('evelyn ashworth') && at(0).includes('ashworth'), 'a phrase and its bare surname are both offered');
    // A leading particle is nearly meaningless and the bare form matches everything the particle
    // form would, so "Sacres" is what gets offered — never "de Sacres".
    assert.ok(at(1).includes('sacres') && !at(1).includes('de sacres'), 'the bare surname replaces the particle form');
    assert.ok(at(1).includes('vicomtesse de sacres') && at(1).includes('vicomtesse'), 'the full title and its head both stand');
}
console.log('ok   phrases keep their bare words, except where a particle says otherwise');
// Elision writes the particle onto the name ("d'Orléans"), so the tokeniser sees one word and the
// particle rules never get a look. Same trade on the same terms, plus a check that the bare name
// stands somewhere on its own — dropping the elided form is only safe if something replaces it.
{
    const fill = n => Object.fromEntries([...Array(n)].map((_, i) => [30 + i,
        { uid: 30 + i, key: [], content: 'Rain fell on the street tonight, a dull ordinary evening for everyone here.' }]));
    const book = { entries: { ...fill(9),
        // "Ironhold", not "Orleans": unaccented "orleans" is IN the frequency table (New Orleans),
        // so it would correctly keep its particle and the test would prove nothing.
        0: { uid: 0, key: [], content: "The duchy of Ironhold passed to his heir. The Duc d'Ironhold held the duchy of Ironhold until his death." },
        1: { uid: 1, key: [], content: "A hall of Objets d'Art stood there. More Objets d'Art filled the annex." },
    } };
    const s = buildKeySuggest(book, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 12 });
    const at = uid => s.perEntry.find(pe => pe.entry.uid === uid)?.newRows.map(r => r.term) ?? [];
    assert.ok(at(0).includes('ironhold') && !at(0).includes("d'ironhold"), 'an elided particle yields to a distinctive name');
    assert.ok(at(0).some(t => t.includes("duc d'ironhold")), 'while the full title keeps it');
    assert.ok(at(1).includes("d'art"), '"d\'Art" keeps its particle — "art" alone is a common word');
    // ...and an entry that never writes the bare name keeps the elided form, because the bare one
    // is a different token and nothing would appear in its place. "d'Artagnan" is the case: the
    // particle is the name there, not a detachable prefix.
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





