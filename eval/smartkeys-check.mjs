// Verifies the SmartKeys boolean-query engine against the spec's acceptance table,
// plus the lexer edge cases the spec calls out (internal hyphens, weights, flags).
import { countKey, keywordScore } from '../extension/ranking.mjs';
import { tokenize, parse, evaluate, buildAutomaton, scanAutomaton } from '../extension/smartkeys.mjs';
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
eq(countKey('? fire:2.5', 'fire everywhere', false, false), 2.5, ':weight scales the matched score');
eq(countKey('? fire:0.5', 'fire everywhere', false, false), 0.5, 'sub-1 :weight down-weights (not clamped to 1)');
eq(countKey('? "hot tub":2 party', 'hot tub party', false, false), 3, 'weight after quoted phrase, summed by AND');
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
eq(countKey('? (fire:3 XOR flood:3) OR water:0.5', 'fire and flood near the water', false, false), 0.5, 'failed XOR branch leaks no boost through OR');
eq(countKey('? (fire:3 alpha) OR water:0.5', 'fire and water', false, false), 0.5, 'half-matched AND leaks no boost through OR');
eq(countKey('? fire:3 XOR flood', 'a fire burns', false, false), 3, 'XOR still yields the matched side\'s weight');

// acHits must flow through compound nodes: a term the automaton says is absent may not match
// via the regex fallback, even when the raw text would satisfy the regex.
{
    const T = v => ({ type: 'TERM', value: v, isExact: false, isCaseSensitive: false, weight: 1, acIndex: 0 });
    const empty = new Map();
    eq(evaluate({ type: 'AND', left: T('alpha'), right: T('alpha') }, 'alpha', empty).matched, false, 'acHits forwarded through AND');
    eq(evaluate({ type: 'NOT', operand: T('alpha') }, 'alpha', empty).matched, true, 'acHits forwarded through NOT');
}

// Prune audit exempts smart keys like it exempts regex keys.
{
    const data = { entries: { 0: { uid: 0, key: ['? moon mission', '? -apollo'], content: 'nothing relevant' } } };
    const opts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneDead: true, pruneCommon: true, pruneShort: true, ignoreProper: false, stickySkipCommon: true, tooCommon: 0.5, minLength: 4 };
    const { classifyEntry } = buildKeyPruneScan(data, opts, new Set());
    eq(classifyEntry(data.entries[0]).length, 0, 'smart keys exempt from prune audit');
}

// AST shape sanity: implicit AND injection between primaries.
const ast = parse(tokenize('? a (b OR c)'));
eq(ast.type, 'AND', 'adjacent primaries get implicit AND');
eq(evaluate(ast, 'a c').matched, true, 'evaluates the injected AND');
