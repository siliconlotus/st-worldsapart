// Verifies the SmartKeys boolean-query engine against the spec's acceptance table,
// plus the lexer edge cases the spec calls out (internal hyphens, weights, flags).
import { countKey, keywordScore, setBoundaryMode, isRegexKey } from '../extension/matcher.mjs';
import { tokenize, parse, evaluate, buildAutomaton, scanAutomaton, validateSmartKey, fold, resetSmartKeys } from '../extension/smartkeys.mjs';
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
// The `=` flag shares wordChar() with countKey rather than restating it, so it inherits the
// wordBoundary setting: two boundary definitions would be two matchers.
setBoundaryMode('permissive');
eq(matches('? =Joe', "that is Joe's coat"), true, 'permissive: = treats an apostrophe as a boundary');
setBoundaryMode('strict');
eq(matches('? =Joe', "that is Joe's coat"), false, 'strict: = treats it as inside the word, like a plain key');
eq(countKey('Joe', "that is Joe's coat", false, true), 0, '...which is the same answer the plain key gives');
// --- regex TERMS ------------------------------------------------------------------------------------
// A `/re/` key is a pattern everywhere else it appears; inside a SmartKey it used to be five literal
// characters, which fell out of a lexer that did not know regexes exist. `? "/re/"` keeps the literal.
{
    const codes = k => validateSmartKey(k).map(p => `${p.severity}:${p.code}`).join(' ');
    eq(matches('? /co(l|s)monaut/ walked', 'the cosmonaut walked in'), true, 'a regex term matches as a pattern');
    eq(matches('? /co(l|s)monaut/ walked', 'the astronaut walked in'), false, '...and fails when the pattern does not');
    eq(matches('? "/re/"', 'the /re/ literal'), true, 'quoting keeps the literal reading');
    eq(matches('? "/re/"', 'a regular expression'), false, '...and it really is a literal');
    // The branch sits after the operator match, so a pattern can be negated.
    eq(matches('? -/drill/ fire', 'a fire started'), true, '-/re/ negates a pattern');
    eq(matches('? -/drill/ fire', 'a fire drill started'), false, '...and the negation bites');
    // Only at token start — the rule " and -/!/+ already follow.
    eq(matches('? and/or', 'an and/or clause'), true, 'a slash mid-token is ordinary text');
    eq(matches('? 3/4', 'in 3/4 time'), true, '...including a fraction');
    // LEFTMOST QUALIFYING close, tracking escape and class. Greedy over the whole source would
    // collapse `? /a/ /b/` into one pattern; stopping at the first delimiter regardless would cut
    // a pattern that legitimately contains one.
    eq(countKey('? /a/ /b/', 'a and b', false, false), 3, 'two patterns stay two, and both count');
    eq(matches('? /[/]/ x', 'the /x path'), true, 'the delimiter does not close inside a character class');
    eq(matches('? /a\\/b/', 'an a/b split'), true, '\\/ writes a literal slash');
    // Flags then weight, as a quoted term takes its weight after the closing quote.
    eq(matches('? /fire/i', 'FIRE everywhere'), true, '/i is how insensitivity is written');
    eq(matches('? /fire/', 'FIRE everywhere'), false, '...because a pattern is case-sensitive by default');
    eq(countKey('? /fire/::3', 'fire and fire', false, false), 6, 'weight x occurrences, same as a TERM');
    eq(countKey('? /fire/^3', 'fire and fire', false, false), 6, '...and the Lucene ^N alias works too');
    // Fold-exempt: countKey branches before foldedHay, so a pattern runs on raw text.
    eq(matches("? /Cap'n/", 'Cap\u2019n Joe'), false, 'a regex term is fold-exempt, like a whole-key regex');
    eq(matches("? Cap'n", 'Cap\u2019n Joe'), true, '...where a plain term in the same key is not');
    // A regex is a term for counting and for positivity, or these two keys would be fatally flagged.
    eq(codes('? /re/'), '', 'a lone regex is not no-terms');
    eq(codes('? /re/ -drill'), '', 'a regex is a positive contributor, so this is not negation-only');
    eq(codes('? /(/'), 'error:regex-invalid', 'a well-formed pattern new RegExp refuses is an error');
    // NO SHAPE, NO FAULT. `/re` and `//` are not broken patterns, they are literal terms — which is
    // exactly what the BARE keys `/re` and `//` are, so reporting a fault here would have been the
    // divergence. regex-unterminated and regex-empty went with the shape they described.
    eq(codes('? /re'), '', 'an unterminated pattern is simply not a pattern');
    eq(codes('? //g'), '', '...and neither is an empty one');
    eq(countKey('? /re', 'anything /re', false, false), 1, '...it matches the characters, as the bare key does');
    eq(countKey('/re', 'anything /re', false, false), 1, '...which is the bare key it now agrees with');
    // Value-reading checks skip it: a pattern is punctuation by nature.
    eq(codes('? /[^"]+/'), '', 'punctuation-term and stray-quote do not read a pattern');
    // A TERM READS AS THE WHOLE KEY READS. The plain-key rule is "the entire string is /…/flags";
    // when a term IS the entire key this scanner's accept test is that same test, so the two can no
    // longer disagree. Asserted on the TOKENS, because a count cannot tell two lexings apart: the old
    // reading of `? /home/user/file` was the pattern `/home/` plus the term `user/file`, and it
    // counted 2 against the text below for reasons that had nothing to do with the key.
    const tok = k => tokenize(k)
        .map(t => t.type === 'REGEX' ? `re:${t.value}` : t.type === 'TERM' ? `term:${t.value}` : t.type).join(' ');
    const plainReads = k => (isRegexKey(k) ? `re:${k}` : `term:${k}`);
    for (const k of ['/home/user/file', '/home/user/lux/', '/(home/user|~/user)/file/', '/re/',
        '/(rain|snow)/', '/a\\/b/', '/[/]/x', '/re', '//']) {
        eq(tok('? ' + k), plainReads(k), `a term reads as the whole key does: ${k}`);
    }
    eq(tok('? /re/is night'), 're:/re/is term:night', 'flags followed by a space are still taken');
    eq(tok('? /re/::2'), 're:/re/', '...as is a weight straight after the close');
    eq(tok('? /re/gi)'), 're:/re/gi RPAREN', '...and a closing paren is a boundary too');
    eq(tok('? (/a/|/b/) x'), 'LPAREN re:/a/ OR re:/b/ RPAREN term:x', 'grouping around patterns still lexes');
    // The cost, accepted: an abutting term after a pattern needs a space. Extending the regex is the
    // other answer, and the clearer one when adjacency is what was meant.
    eq(tok('? /[/]/ x'), 're:/[/]/ term:x', 'a space recovers the abutting form');
    eq(matches('? /\\/x/', 'the /x path'), true, '...and adjacency belongs inside the pattern');
    // The core divergence is now visible from a term, not just from a bare key.
    eq(codes('? /(home/user|~/user)/file/'), 'warn:regex-core-refuses', 'a term reaches the core-refusal warning');
    eq(codes('? /(home\\/user|~\\/user)\\/file/'), '', '...and escaping the delimiters clears it');
    eq(countKey('? /home/user/file', '/home/user/file', false, false), 1, 'a path is one literal term');
    eq(matches('? /home/user/file', 'the home user file'), false, '...so the bare-word reading is gone');

    // A BARE regex key core reads differently. WA runs it as a pattern; core refuses any pattern whose
    // delimiter is unescaped inside it and matches the whole string as literal text instead, which no
    // prose contains — so the key never activates and nothing says so. The matcher is unchanged; this
    // is the only thing validateSmartKey has to say about a key with no `?`.
    eq(codes('/and/or/'), 'warn:regex-core-refuses', 'a bare regex core will refuse is flagged');
    eq(codes('/24/7/'), 'warn:regex-core-refuses', '...whatever the pattern is; the slash is the fault');
    eq(codes('/and\\/or/'), '', '...and escaping the inner slash clears it, because core then reads it');
    eq(codes('/fire/'), '', 'a pattern with no inner slash was never in question');
    eq(codes('fire'), '', 'a plain key still gets no opinion at all');
    // ...and a SmartKey term reaches the SAME check now, because the term rule became the whole-key
    // rule. Before, the scan cut `/and/` off the front and there was no pattern left to ask about.
    eq(codes('? /and/or/'), 'warn:regex-core-refuses', 'a term reaches it too, on the same string');
    eq(codes('? /and\\/or/'), '', '...and clears the same way');
    // The hatch the warning points at has to be the one that works: quoting is a TERM rule, so the
    // bare form keeps its quotes as characters and matches neither reading.
    eq(countKey('? "/and/or/"', 'the config at /and/or/ is set', false, false), 1, '? "…" is the literal hatch');
    eq(countKey('"/and/or/"', 'the config at /and/or/ is set', false, false), 0, '...and a bare "…" is not one');
    // The warning names the term as TYPED, and the hatch it names has to be typeable. JSON.stringify
    // rendered `/a\/b/c/` as `/a\\/b/c/`, so the sentence told the author to type a different key.
    const msg = k => validateSmartKey(k)[0].message;
    eq(msg('/a\\/b/c/').includes('use ? "/a\\/b/c/".'), true, 'the hatch quotes the term as typed, not JSON-escaped');
    eq(countKey('? "/a\\/b/c/"', 'path /a\\/b/c/ here', false, false), 1, '...and that hatch matches the literal');
    // A term already holding a `"` has no hatch — the quote would close the term early — so the
    // sentence is dropped rather than printed wrong.
    eq(msg('/say "hi"/there/').includes('use ?'), false, 'no hatch is offered when quoting cannot work');
    // The flag is advisory only — WA still counts it, which is what makes it a warn rather than an error.
    eq(countKey('/and/or/', 'take and/or leave', false, false), 1, 'the matcher still runs it as a pattern');
}
console.log('ok   regex terms: leftmost close, flags then weight, negatable, fold-exempt, validated');

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
    eq(countKey('? fire | water', T, false, false), 2, 'OR sums its matched branches (see the recurrence block)');
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
    // ...and ONLY an unclosed one. An inch mark, a seconds mark or a closing quote mid-term is
    // ordinary text — the lexer only ever puts a `"` FIRST when the quoted branch failed to close.
    eq(codes('? 6" copper pipe'), '', 'an inch mark is text, not a broken quote');
    eq(codes('? 5\'10" barefoot'), '', 'feet and inches together are text');
    eq(codes('? say"what'), '', 'a quote inside a bare word is text');
    eq(codes('? ="moon mission"'), '', 'a properly closed quoted phrase with a flag is clean');
    eq(codes('? fire ="water'), 'error:stray-quote', 'a flagged unclosed quote is still unclosed');

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

// "When in doubt, quote it" is only good advice if quoting a single term is free. It is — and the one
// place it is NOT free is quoting across a space, which changes a conjunction into a phrase.
{
    const T = 'a fire in the hot tub at 10:30';
    const same = (a, b, label) => eq(countKey(a, T, false, false), countKey(b, T, false, false), label);
    same('? fire', '? "fire"', 'quoting a single term changes nothing');
    same('? =fire', '? ="fire"', '...with the exact flag');
    same('? ^Fire', '? ^"Fire"', '...with the case flag');
    same('? fire::2', '? "fire"::2', '...with a weight');
    eq(countKey('? hot tub', T, false, false) !== countKey('? "hot tub"', T, false, false), true,
        'but quoting across a space is a different query: conjunction vs phrase');
}
console.log('ok   quoting a single term is free; quoting across a space is not');

// A term contributes weight x OCCURRENCES. Scoring on presence alone made a query blind to recurrence:
// a synonym group returned the same number whether its concept appeared once or nine times, so it
// scored WORSE than the bare key the moment the word repeated. And OR sums rather than taking the max,
// which was only ever right because it coincided with the sum whenever a single branch matched.
{
    const c = (q, t) => { resetSmartKeys(); return countKey(q, t, false, false); };
    const grp = '? (glasses | spectacles)';
    eq(c(grp, 'glasses'), 1, 'one mention of one spelling');
    eq(c(grp, 'glasses glasses glasses'), 3, 'recurrence counts — this used to stay at 1');
    eq(c(grp, 'glasses glasses glasses spectacles spectacles'), 5, 'and both spellings are the same concept');
    eq(c(grp, 'glasses glasses glasses'), c('glasses', 'glasses glasses glasses'),
        'a synonym group now matches the bare key it generalises, instead of scoring below it');

    eq(c('? fire::2.5', 'fire fire'), 5, 'weight multiplies the count');
    eq(c('? =cat', 'cat cat cats'), 2, 'the exact flag counts occurrences too, not just presence');
    eq(c('? "hot tub"::2 party', 'hot tub hot tub party'), 5, 'quoted phrase x2 at weight 2, plus party');

    // The unmatched-carries-zero invariant is what keeps summing safe.
    eq(c('? moon -apollo', 'moon moon'), 2, 'a negation contributes nothing to the sum');
    eq(c('? (fire::3 XOR flood::3) OR water::0.5', 'fire and flood near the water'), 0.5, 'a failed XOR leaks no boost');
    eq(c('? (fire::3 alpha) OR water::0.5', 'fire and water'), 0.5, 'a half-matched AND leaks no boost');
}
console.log('ok   terms score on weight x occurrences; OR sums');

// WA has no wildcards and no fuzzy matching, so * and ~ are ordinary characters and get no warning.
// Flagging them said "the term is matched literally" as though that were a defect, when literal is
// exactly what M*A*S*H, *B*witched and the emphasis markup in a real book all need. A key that DID
// expect wildcards is dead, and the audit reports it as such — from the evidence rather than a guess
// about intent.
{
    const codes = k => validateSmartKey(k).map(p => p.code).join(',');
    eq(codes('? fire~2'), '', 'a tilde is a literal, because there is no fuzzy matching to mistake it for');
    eq(codes('? M*A*S*H'), '', 'and an asterisk is a literal — there are real names shaped like this');
    eq(codes('? *B*witched'), '', '...including ones that lead with it');
    eq(codes('? x**3'), '', 'so Python power notation is not a wildcard either');
    eq(codes('? *asses*'), '', 'nor is emphasis markup, which is how a real book keys the Roman currency');
    eq(codes('? =^HOK::3'), '', 'the ^ FLAG is a prefix and is not a boost');
    eq(codes('? c++'), '', 'ordinary punctuation in a term is not Lucene syntax');
}
console.log('ok   unsupported Lucene syntax is named rather than silently dead');

// ^N is accepted as an ALIAS for ::N — Lucene's boost, carried by Elasticsearch's query_string and
// Solr, so it is muscle memory worth not breaking. It cannot collide with the ^ case-sensitivity flag,
// which is a PREFIX consumed before the value; this is a postfix followed by digits. Measured across
// the books on disk: 0 keys contain ^ followed by a digit.
{
    const T = q => tokenize(q).filter(t => t.type === 'TERM')
        .map(t => `${t.value}@${t.weight}${t.isExact ? '=' : ''}${t.isCaseSensitive ? '^' : ''}`).join(' ');
    eq(T('? fire^2'), T('? fire::2'), '^N and ::N are the same weight');
    eq(T('? "hot tub"^2 party'), 'hot tub@2 party@1', '^N works after a quoted phrase');
    eq(T('? =^HOK^3'), 'HOK@3=^', 'prefix flags and a postfix boost compose without ambiguity');
    eq(T('? ^HOK'), 'HOK@1^', 'a bare prefix ^ is still only the case flag');
    eq(T('? fire^abc'), 'fire^abc@1', 'delimiter followed by non-digits stays part of the term');
    eq(countKey('? fire^2', 'fire fire', false, false), 4, '...and it reaches the score, x occurrences');
}
console.log('ok   ^N is accepted as a boost alias');

// A FLAGGED term verifies against the same folded text Pass 1 filtered on. It used to verify against
// raw text, so `? =Cap'n` cleared the automaton (which scans folded) and then failed its own regex —
// while the plain whole-word key `Cap'n` matched the same prose. One fold, or two matchers.
{
    const t = 'Cap’n Joe drank at the CAFÉ — the café was warm.';
    eq(countKey("Cap'n", t, false, true), 1, 'baseline: a plain whole-word key folds the apostrophe');
    eq(countKey("? =Cap'n", t, false, false), 1, '=flagged SmartKey term folds it too');
    eq(countKey("? ^Cap'n", t, false, false), 1, '...and so does ^flagged');
    eq(countKey('? ^CAFÉ', t, false, false), 1, '^ still discriminates case after folding');
    eq(countKey('? =café', t, false, false), 2, '= counts every occurrence, either case');
}
console.log('ok   flagged terms verify against the folded haystack, like countKey');

// The shorthand table in SMARTKEYS.md. Each group is one query written several ways; they must parse
// AND score identically, or the doc is teaching a rewrite that changes the key.
{
    // Two texts, because agreeing on 0 is not agreement — a group where every spelling is broken
    // matches nothing in perfect unison. The second text satisfies the ones the first negates away.
    const texts = ['the moon mission left; fire and water fell as rain', 'fire, and apollo, and snow'];
    const same = (group, why) => {
        const got = texts.map(t => group.map(k => countKey(k, t, false, false)));
        const ok = got.every(row => row.every(v => v === row[0])) && got.some(row => row[0] > 0);
        eq(ok ? 1 : 0, 1, `${why}: ${group.join('  ==  ')} -> ${got.map(r => r.join('/')).join(' | ')}`);
    };
    same(['? moon mission', '? moon AND mission'], 'juxtaposition is AND');
    same(['? moon mission -apollo', '? moon AND mission AND NOT apollo'], 'prefix - is AND NOT');
    same(['? +fire +water', '? fire AND water', '? fire water'], 'Lucene + is absorbed');
    same(['? rain | snow', '? rain OR snow', '? rain || snow'], 'the OR spellings agree');
    same(['? fire && !water', '? fire AND NOT water', '? fire -water'], 'the AND/NOT spellings agree');
    same(['? fire^2', '? fire::2'], 'the boost spellings agree');
}
console.log('ok   the documented shorthands are exact rewrites');

// A plain multi-word key IS a quoted phrase — the equivalence SMARTKEYS.md leans on to explain that
// the UNQUOTED SmartKey is the novel form, not the quoted one. Whole-word does not break it (it applies
// to single-word keys only, so both stay on substring); case-sensitivity does, since a SmartKey ignores
// the entry checkbox and wants ^ instead.
{
    const t = 'Apollo mission ended. apollo mission again. apollo  mission spaced.';
    for (const ww of [false, true]) {
        eq(countKey('? "apollo mission"', t, false, ww), countKey('apollo mission', t, false, ww),
            `a plain phrase key equals a quoted term (wholeWords=${ww})`);
    }
    eq(countKey('? apollo mission', t, false, false), 6, 'unquoted, it is two terms and counts each');
    eq(countKey('? ^"apollo mission"', t, true, false), countKey('apollo mission', t, true, false),
        '^ is how a SmartKey asks for the case-sensitivity the checkbox gives a plain key');
}
console.log('ok   a plain multi-word key is a quoted phrase');

// The worked example in SMARTKEYS.md, verbatim. It carries the whole plain-vs-SmartKey distinction,
// so it must not be prose that drifted from the matcher.
{
    const msg = 'The astronauts of the Apollo mission';
    eq(countKey('apollo astronauts', msg, false, false), 0, 'the plain key wants the words adjacent, in order');
    eq(countKey('? "apollo astronauts"', msg, false, false), 0, '...and the quoted term is the same key');
    eq(countKey('? apollo astronauts', msg, false, false) > 0, true, 'unquoted, order and distance stop mattering');
}
console.log('ok   the SMARTKEYS.md worked example holds');
