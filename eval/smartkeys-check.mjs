// Verifies the SmartKeys boolean-query engine against the spec's acceptance table,
// plus the lexer edge cases the spec calls out (internal hyphens, weights, flags).
import { countKey, keywordScore } from '../extension/ranking.mjs';
import { tokenize, parse, evaluate, buildAutomaton, scanAutomaton, validateSmartKey, fold } from '../extension/smartkeys.mjs';
import { buildKeyPruneScan } from '../extension/keyword-core.mjs';
import { eq } from './metrics.mjs';

const matches = (key, text) => countKey(key, text, false, false) > 0;

// Spec acceptance table.
eq(matches('moon mission', 'Astronaut on a mission to the moon.'), false, 'legacy key: not contiguous, no match');
eq(matches('? moon mission', 'Astronaut on a mission to the moon.'), true, 'implicit AND');
eq(matches('? ^=NASA mission', 'nasa completed the mission.'), false, '^ requires exact case');
eq(matches('? ^=NASA mission', 'NASA completed the mission.'), true, '^= passes on exact-case whole word');
eq(matches('? =cat', 'The cat category was updated.'), true, '= matches whole word "cat"');
eq(matches('? =cat', 'The category was updated.'), false, '= rejects "cat" inside "category"');
eq(matches('? moon mission -apollo', 'Neil went on a moon mission on Apollo 11.'), false, '-apollo excludes');
eq(matches('? moon mission -apollo', 'Neil went on a moon mission on Saturn V.'), true, 'negated term absent, rest matches');
eq(matches('? (moon mission) AND (astronaut | cosmonaut)', 'The cosmonaut joined the moon mission.'), true, 'grouping with OR');

// Operators and precedence.
eq(matches('? cat OR dog', 'a dog barked'), true, 'OR');
eq(matches('? cat XOR dog', 'a dog barked'), true, 'XOR one side');
eq(matches('? cat XOR dog', 'cat and dog'), false, 'XOR both sides');
eq(matches('? cat dog OR bird', 'a bird sang'), true, 'AND binds tighter than OR');
eq(matches('? !cat', 'a dog barked'), true, '! negation');
eq(matches('? cat && dog', 'cat dog'), true, '&& alias');
eq(matches('? "moon mission"', 'the moon mission began'), true, 'quoted phrase, contiguous');
eq(matches('? "moon mission"', 'mission to the moon'), false, 'quoted phrase, not contiguous');

// Lexer edge cases the spec requires.
eq(matches('? sci-fi', 'a sci-fi novel'), true, 'internal hyphen stays in the term');
eq(matches('? sci-fi', 'a fantasy novel'), false, 'sci-fi does not degrade to sci AND NOT fi (would match here)');
eq(matches('? c-3po', 'c-3po beeped'), true, 'digits and hyphens in terms');
eq(countKey('? fire::2.5', 'fire everywhere', false, false), 2.5, '::weight scales the matched score');
eq(countKey('? fire::0.5', 'fire everywhere', false, false), 0.5, 'sub-1 ::weight down-weights (not clamped to 1)');
eq(countKey('? "hot tub"::2 party', 'hot tub party', false, false), 3, 'weight after quoted phrase, summed by AND');
eq(matches('? meeting "10:30"', 'the meeting is at 10:30'), true, 'literal colon via quoting');
eq(matches('? "10:30"', 'at 10 30 sharp'), false, 'quoted colon term is literal, not split');
eq(matches('? =c++', 'some c++ code'), true, '= boundary handles punctuation-edged terms (no \\b)');
eq(matches('? =cat', 'the category'), false, '= boundary still rejects substrings');
eq(matches('? and', 'sandy beach'), false, 'bare "and" is an operator, not a term');
eq(matches('? android', 'an android walked'), true, 'AND-prefixed word is still one term');

// Degradation and malformed input: never throw, just fail to match.
eq(matches('? c++', 'c++ code'), true, 'regex specials in terms are escaped');
eq(matches('? (moon', 'moon landing'), true, 'unclosed paren tolerated');
eq(matches('?', 'anything'), false, 'empty query matches nothing');
eq(matches('? -', 'anything'), false, 'lone operator matches nothing');

// Pass-1 automaton: failure links must surface patterns that end inside other patterns.
const aut = buildAutomaton(['he', 'she', 'his', 'hers']);
const hits = scanAutomaton(aut, 'ushers');
eq([...hits.keys()].sort().join(','), '0,1,3', 'aho-corasick finds he/she/hers overlapping in "ushers"');
eq(scanAutomaton(aut, 'hi shore').size, 0, 'no false hits');
eq(scanAutomaton(buildAutomaton(['aa']), 'aaaa').get(0), 2, 'non-overlapping count parity with indexOf ("aa" in "aaaa" = 2)');
// Full pipeline routes through the automaton: flagged terms verify, unflagged trust Pass 1.
eq(matches('? =hers she', 'the ushers she saw'), false, 'AC candidate "hers" rejected by = verify');
eq(matches('? hers she', 'the ushers she saw'), true, 'unflagged substring terms accept the AC hit');

// keywordScore primes the automaton for its plain keys; primed countKey answers must match
// the naive walk exactly, including flag fallbacks, on the SAME text buffer.
{
    const text = 'cat cats scatter, the Jubilees arrived at the hot tub';
    const entry = { key: ['cat', 'Jubilee', 'hot tub', 'nope'] };
    const { score, hits: h } = keywordScore(entry, text, entry.key, { k1: 2, caseSensitiveDefault: false, wholeWordsDefault: false });
    eq(h.map(x => `${x.key}:${x.count}`).join(' '), 'cat:3 Jubilee:1 hot tub:1', 'primed counts equal naive substring counts');
    eq(score.toFixed(3), (3 / 5 + 1 / 3 + 1 / 3).toFixed(3), 'BM25 saturation unchanged by the fast path');
    // Same primed text, flagged variants must fall through to the exact walk.
    eq(countKey('cat', text, false, true), 1, 'primed candidate, whole-word verify: standalone "cat" only');
    eq(countKey('jubilee', text, true, false), 0, 'primed candidate, case-sensitive verify rejects');
    eq(countKey('nope', text, true, true), 0, 'primed miss is authoritative under any flags');
}

// Unmatched nodes carry zero boost — a failed XOR/AND branch must not leak its weight into a
// parent OR's max.
eq(countKey('? (fire::3 XOR flood::3) OR water::0.5', 'fire and flood near the water', false, false), 0.5, 'failed XOR branch leaks no boost through OR');
eq(countKey('? (fire::3 alpha) OR water::0.5', 'fire and water', false, false), 0.5, 'half-matched AND leaks no boost through OR');
eq(countKey('? fire::3 XOR flood', 'a fire burns', false, false), 3, 'XOR still yields the matched side\'s weight');

// acHits must flow through compound nodes: a term the automaton says is absent may not match
// via the regex fallback, even when the raw text would satisfy the regex.
{
    const T = v => ({ type: 'TERM', value: v, isExact: false, isCaseSensitive: false, weight: 1, acIndex: 0 });
    const empty = new Map();
    eq(evaluate({ type: 'AND', left: T('alpha'), right: T('alpha') }, 'alpha', empty).matched, false, 'acHits forwarded through AND');
    eq(evaluate({ type: 'NOT', operand: T('alpha') }, 'alpha', empty).matched, true, 'acHits forwarded through NOT');
}

// Smart keys are NOT exempt from the audit — they are audited on df, like any other key. Neither of
// these queries can match "nothing relevant", so both are dead and both should say so.
{
    const data = { entries: { 0: { uid: 0, key: ['? moon mission', '? -apollo'], content: 'nothing relevant' } } };
    const opts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, stickySkipCommon: true, tooCommon: 0.5, minLength: 4 };
    const { classifyEntry } = buildKeyPruneScan(data, opts, new Set());
    eq(classifyEntry(data.entries[0]).map(f => f.flag).join(','), 'unattested', 'a dead query is flagged; "? -apollo" matches on absence so it is not dead');
}

// AST shape sanity: implicit AND injection between primaries.
const ast = parse(tokenize('? a (b OR c)'));
eq(ast.type, 'AND', 'adjacent primaries get implicit AND');
eq(evaluate(ast, 'a c').matched, true, 'evaluates the injected AND');

// Malformed operator POSITIONS are typos, not instructions. Building the node anyway made the whole
// key dead — AND(x, null) can never match — so the most idiomatic Lucene form of all, `+fire +water`,
// matched nothing. A prefix binary operator is Lucene's per-term required-marker, which an implicit
// AND already says; a dangling one keeps whichever side exists. The Studio validator is what tells
// the author the key is malformed; the matcher's job is not to silently refuse to fire.
{
    const T = 'fire and water everywhere';
    eq(matches('? +fire +water', T), true, 'leading + on every term (Lucene required-marker)');
    eq(matches('? +fire', T), true, 'a single leading +');
    eq(matches('? (+fire water)', T), true, 'leading + just inside a group');
    eq(matches('? & fire', T), true, 'leading &-alias is absorbed');
    eq(matches('? fire &', T), true, 'trailing operator keeps the left side');
    eq(matches('? fire && && water', T), true, 'a doubled operator is not two operands');
    eq(matches('? fire -', T), true, 'trailing negation keeps the left side');
    // ...without making a malformed key match MORE than it should.
    eq(matches('? +fire +zebra', T), false, 'a required term that is absent still fails');
    eq(matches('? +fire -water', T), false, 'negation still applies alongside a required-marker');
    eq(countKey('? fire | water', T, false, false), 1, 'genuine OR is untouched');
    eq(countKey('? fire water', T, false, false), 2, 'genuine implicit AND is untouched');
}
console.log('ok   malformed operator positions degrade to no-ops, not dead keys');

// The delimiter is `::`, so a single colon is ordinary text. With one colon, "Judges 3:16" parsed as
// the term "3" weighted 16 -- silent, absurd, and escapable only by quoting a construction nobody
// expects to need quoting. Times, verse refs, sequel titles and URLs now tokenise as written.
{
    const terms = q => tokenize(q).filter(t => t.type === 'TERM').map(t => `${t.value}@${t.weight}`).join(' ');
    eq(terms('? fire::2'), 'fire@2', ':: introduces a weight');
    eq(terms('? "hot tub"::2'), 'hot tub@2', ':: works after a quoted phrase too');
    eq(terms('? meet at 10:30'), 'meet@1 at@1 10:30@1', 'a time keeps its colon and its weight of 1');
    eq(terms('? Judges 3:16'), 'Judges@1 3:16@1', 'a verse reference is not a weighted digit');
    eq(terms('? Kingdom Hearts re:code'), 'Kingdom@1 Hearts@1 re:code@1', 'an internal colon survives');
    eq(terms('? fire::abc'), 'fire::abc@1', 'delimiter followed by non-digits stays part of the term');
    eq(terms('? =^HOK::3'), 'HOK@3', 'flags and weight compose');
}
console.log('ok   weight delimiter is ::, single colon is ordinary text');

// Structural validation, shared by the Studio's save check and the audit so the two cannot disagree
// about what is valid. Errors are queries that cannot do what their author meant under any text;
// warnings are legal and probably a typo. Neither is fatal at match time.
{
    const codes = k => validateSmartKey(k).map(p => `${p.severity}:${p.code}`).join(' ');
    eq(codes('? fire water'), '', 'a plain conjunction is clean');
    eq(codes('? (gucci | prada) sunglasses -(fake | knockoff)'), '', 'groups and a negated group are clean');
    eq(codes('? meet at 10:30'), '', 'a colon in a term is clean');
    eq(codes('? =^HOK::3'), '', 'flags and a weight are clean');

    eq(codes('? -zebra'), 'error:negation-only', 'a lone negation matches on absence, i.e. almost always');
    eq(codes('? -a -b'), 'error:negation-only', 'several negations are still no positive term');
    eq(codes('? -(a b)'), 'error:negation-only', 'a negated group is still no positive term');
    eq(codes('? a -b'), '', 'one positive term is enough');
    eq(codes('? '), 'error:no-terms', 'an empty query can never match');
    eq(codes('? ()'), 'error:no-terms', 'an empty group has no terms');
    eq(codes('? fire "water'), 'error:stray-quote', 'an unclosed quote leaves the quote in the term');

    eq(codes('? (fire | water'), 'warn:unbalanced-parens', 'unbalanced parens parse, but probably not as grouped');
    eq(codes('? fire::0'), 'warn:all-zero-weights', 'a zero-weight key gates without scoring');
    eq(codes('? fire::0 water'), '', 'only ALL weights being zero is worth saying');

    eq(codes('plain key'), '', 'a plain key is not a SmartKey and gets no opinion');
    eq(codes('/regex/i'), '', 'nor is a regex key');
}
console.log('ok   SmartKey structural validation');

// SmartKeys are audited like any other key, not exempted. countKey already evaluates a query against
// the same primed trie every literal goes through, so df was being computed for them all along and
// then discarded. What genuinely does not apply is the heuristics that read the key as a LITERAL
// STRING — English-common, fragment, short — because the matching surface of `? fire water` is its
// terms, not the twelve characters of the query.
{
    const entries = {};
    for (let i = 1; i <= 12; i++) entries[i] = { uid: i, key: [], content: `Marjorie walked. Entry number ${i} of the set.` };
    entries[1].key = ['? Marjorie'];          // fires everywhere
    entries[2].key = ['? zebra unicorn'];     // fires nowhere
    entries[3].key = ['Marjorie'];            // plain control with the same df
    entries[4].key = ['? the'];               // an English-common TERM, but not an English-common KEY
    const opts = { scanKeyword: true, scanVectorized: true, scanConstant: true, pruneUnattested: true,
        pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true,
        minLength: 4, tooCommon: 0.5, sharedKeys: 0.5, ignoreProper: true };
    const sc = buildKeyPruneScan({ entries }, opts, new Set(), { caseSensitiveDefault: false, wholeWordsDefault: false });
    const verdict = uid => { const f = sc.classifyEntry(entries[uid])[0]; return f ? `${f.flag}|${sc.reasonOf(f).text}` : ''; };

    eq(verdict(2), 'unattested|never matches', 'a query that evaluates false everywhere is flagged dead');
    eq(verdict(1), verdict(3), 'a SmartKey and the equivalent plain key get the same df verdict');
    eq(verdict(1), 'too common|frequent (100%)', '...and that verdict is the df one, not a string one');
    // The literal-string heuristics stay off: `? the` is a bad key because of its TERM, which is a
    // per-term check that does not exist yet — not because the string "? the" is a common English word.
    // The English-common check says "common"; the df check says "frequent (N%)". "? the" fires
    // everywhere, so it earns the df verdict — what it must NOT earn is the English-common one, which
    // would be reading the query as though the string "? the" were an English word.
    eq(verdict(4), 'too common|frequent (100%)', 'a query earns the df verdict, not the English-common one');
}
console.log('ok   SmartKeys are audited on df, exempt only from the literal-string heuristics');

// Only the FIRST `?` is the sentinel, so a doubled prefix leaves one behind as a literal term — and a
// query searching for a bare question mark fires on nearly every message. The no-terms check cannot
// see this, because there genuinely is a term.
{
    const codes = k => validateSmartKey(k).map(p => `${p.severity}:${p.code}`).join(' ');
    eq(tokenize('? or ? ()').filter(t => t.type === 'TERM').map(t => t.value).join(','), '?', 'the second ? survives as a term');
    eq(codes('? or ? ()'), 'warn:punctuation-term', 'a doubled sentinel is caught as a punctuation term');
    eq(codes('? ?'), 'warn:punctuation-term', 'so is a bare question mark on its own');
    eq(codes('? fire .'), 'warn:punctuation-term', 'and a stray full stop beside a real term');
    eq(codes('? c++'), '', 'a term with letters is fine however much punctuation it carries');
    eq(codes('? 10:30'), '', 'digits count too');
}
console.log('ok   punctuation-only terms are flagged');

// Quoting marks a punctuation term as deliberate, because sometimes it is: Sigur Rós named an album
// "()" and a more recent one is 142 characters of combining marks. Quoted, such a title is one term
// and validates clean; unquoted it shreds into dozens, which is worth saying once rather than once per
// term (the Studio collapses repeats to one toast per kind).
{
    const codes = k => validateSmartKey(k).map(p => `${p.severity}:${p.code}`).join(' ');
    eq(codes('? "()"'), '', 'a quoted punctuation term is deliberate');
    eq(codes('? "()" | =^Von'), '', '...and composes with the rest of the syntax');
    eq(codes('? ()'), 'error:no-terms', 'unquoted, those are just an empty group');
    eq(codes('? or ? ()'), 'warn:punctuation-term', 'an unquoted stray ? is still caught');
    eq(codes('? "?"'), '', 'quoting rescues the deliberate question mark too');
    eq(tokenize('? "()"').filter(t => t.type === 'TERM')[0].quoted, true, 'the token remembers it was quoted');
    eq(tokenize('? fire').filter(t => t.type === 'TERM')[0].quoted, false, '...and that a bare term was not');
}
console.log('ok   quoting marks a punctuation term as deliberate');

// Real-world pathological literals round-trip when quoted. Both of these are actual release titles.
// The point is not the characters: it is that a quoted literal is ONE term whatever it contains, and
// that the fold leaves alone anything with no case and no orthographic variants.
{
    const artist = '⣎⡇ꉺლ༽இ•̛)ྀ◞ ༎ຶ ༽ৣৢ؞ৢ؞ؖ ꉺლ';   // contains a ) and several scripts
    const q = `? "${artist}"`;
    eq(tokenize(q).length, 1, 'a quoted literal is one token however many syntax characters it holds');
    eq(tokenize(q)[0].value, artist, '...and survives the lexer byte for byte');
    eq(fold(artist), artist, 'the fold is a no-op with no case and no orthographic variants to change');
    eq(validateSmartKey(q).length, 0, 'quoted, it validates clean');
    eq(countKey(q, `now playing ${artist} — new one`, false, false) > 0, true, 'and matches its own text');
    eq(countKey(q, 'nothing relevant here at all', false, false) > 0, false, 'and nothing else');
    // Unquoted the ) becomes a paren token and the symbol runs become punctuation terms.
    eq(tokenize(`? ${artist}`).filter(t => /PAREN/.test(t.type)).length, 1, 'unquoted, the ) is syntax');
}
console.log('ok   pathological literals round-trip when quoted');
