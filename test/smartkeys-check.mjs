// Verifies the SmartKeys boolean-query engine against the spec's acceptance table,
// plus the lexer edge cases the spec calls out (internal hyphens, weights, flags).
import { countChatHits, countKey, keywordScore, repeatCurveOf, setBoundaryMode, isRegexKey } from '../extension/matcher.mjs';
import { tokenize, parse, evaluate, buildAutomaton, scanAutomaton, validateSmartKey, fold, resetSmartKeys } from '../extension/smartkeys.mjs';
import { buildKeyPruneScan, pathProbes } from '../extension/keyword-audit.mjs';
import { eq } from '../eval/lib/metrics.mjs';

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
// --- group weights ----------------------------------------------------------------------------------
{
    const at = (k, t) => countKey(k, t, false, false);
    eq(at('? (copper pipe)::3', 'a copper pipe burst'), 3 * at('? copper pipe', 'a copper pipe burst'),
        'a group weight multiplies the whole conjunction, each of its things alike');
    eq(at('? (everest OR kailash)::2', 'the everest route'), 2,
        'an alternation is one thing, so the weight doubles it rather than its mentions');
    eq(at('? (fire::2)::3', 'fire here'), 6, 'a term weight and its group\'s compose');
    eq(at('? ((fire::2)::3)::5', 'fire here'), 30, '...and nest');
    const codes = k => validateSmartKey(k).map(p => `${p.severity}:${p.code}`).join(' ');
    eq(codes('? fire ::3'), 'error:stray-weight', 'a weight attached to nothing is fatal, not a term to search for');
    eq(codes('? fire ^2'), 'error:stray-weight', '...and the Lucene spelling, which lexes as a case-sensitive number');
    eq(codes('? =2'), '', 'a whole-word number is an ordinary term');
    eq(codes('? "^2"'), '', '...and quoting says the punctuation was meant');
}
eq(countKey('? fire::0.5', 'fire everywhere', false, false), 0.5, 'sub-1 ::weight down-weights (not clamped to 1)');
eq(countKey('? "hot tub"::2 party', 'hot tub party', false, false), 3, 'weight after quoted phrase, summed by AND');
eq(matches('? meeting "10:30"', 'the meeting is at 10:30'), true, 'literal colon via quoting');
eq(matches('? "10:30"', 'at 10 30 sharp'), false, 'quoted colon term is literal, not split');
eq(matches('? =c++', 'some c++ code'), true, '= boundary handles punctuation-edged terms (no \\b)');
eq(matches('? =cat', 'the category'), false, '= boundary still rejects substrings');
setBoundaryMode('permissive');
eq(matches('? =Joe', "that is Joe's coat"), true, 'permissive: = treats an apostrophe as a boundary');
setBoundaryMode('strict');
eq(matches('? =Joe', "that is Joe's coat"), false, 'strict: = treats it as inside the word, like a plain key');
eq(countKey('Joe', "that is Joe's coat", false, true), 0, '...which is the same answer the plain key gives');
// --- regex TERMS ------------------------------------------------------------------------------------
{
    const codes = k => validateSmartKey(k).map(p => `${p.severity}:${p.code}`).join(' ');
    eq(matches('? /co(l|s)monaut/ walked', 'the cosmonaut walked in'), true, 'a regex term matches as a pattern');
    eq(matches('? /co(l|s)monaut/ walked', 'the astronaut walked in'), false, '...and fails when the pattern does not');
    eq(matches('? "/re/"', 'the /re/ literal'), true, 'quoting keeps the literal reading');
    eq(matches('? "/re/"', 'a regular expression'), false, '...and it really is a literal');
    eq(matches('? -/drill/ fire', 'a fire started'), true, '-/re/ negates a pattern');
    eq(matches('? -/drill/ fire', 'a fire drill started'), false, '...and the negation bites');
    eq(matches('? and/or', 'an and/or clause'), true, 'a slash mid-token is ordinary text');
    eq(matches('? 3/4', 'in 3/4 time'), true, '...including a fraction');
    eq(countKey('? /a/ /b/', 'a and b', false, false), 3, 'two patterns stay two, and both count');
    eq(matches('? /[/]/ x', 'the /x path'), true, 'the delimiter does not close inside a character class');
    eq(matches('? /a\\/b/', 'an a/b split'), true, '\\/ writes a literal slash');
    eq(matches('? /fire/i', 'FIRE everywhere'), true, '/i is how insensitivity is written');
    eq(matches('? /fire/', 'FIRE everywhere'), false, '...because a pattern is case-sensitive by default');
    eq(countKey('? /fire/::3', 'fire and fire', false, false), 6, 'weight x occurrences, same as a TERM');
    eq(countKey('? /fire/^3', 'fire and fire', false, false), 6, '...and the Lucene ^N alias works too');
    eq(matches("? /Cap'n/", 'Cap\u2019n Joe'), false, 'a regex term is fold-exempt, like a whole-key regex');
    eq(matches("? Cap'n", 'Cap\u2019n Joe'), true, '...where a plain term in the same key is not');
    eq(codes('? /re/'), '', 'a lone regex is not no-terms');
    eq(codes('? /re/ -drill'), '', 'a regex is a positive contributor, so this is not negation-only');
    eq(codes('? /(/'), 'error:regex-invalid', 'a well-formed pattern new RegExp refuses is an error');
    eq(codes('? /re'), '', 'an unterminated pattern is simply not a pattern');
    eq(codes('? //g'), '', '...and neither is an empty one');
    eq(countKey('? /re', 'anything /re', false, false), 1, '...it matches the characters, as the bare key does');
    eq(countKey('/re', 'anything /re', false, false), 1, '...which is the bare key it now agrees with');
    eq(codes('? /[^"]+/'), '', 'punctuation-term and stray-quote do not read a pattern');
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
    eq(tok('? /[/]/ x'), 're:/[/]/ term:x', 'a space recovers the abutting form');
    eq(matches('? /\\/x/', 'the /x path'), true, '...and adjacency belongs inside the pattern');
    eq(codes('? /(home/user|~/user)/file/'), 'warn:regex-core-refuses', 'a term reaches the core-refusal warning');
    eq(codes('? /(home\\/user|~\\/user)\\/file/'), '', '...and escaping the delimiters clears it');
    eq(countKey('? /home/user/file', '/home/user/file', false, false), 1, 'a path is one literal term');
    eq(matches('? /home/user/file', 'the home user file'), false, '...so the bare-word reading is gone');

    eq(codes('/and/or/'), 'warn:regex-core-refuses', 'a bare regex core will refuse is flagged');
    eq(codes('/24/7/'), 'warn:regex-core-refuses', '...whatever the pattern is; the slash is the fault');
    eq(codes('/and\\/or/'), '', '...and escaping the inner slash clears it, because core then reads it');
    eq(codes('/fire/'), '', 'a pattern with no inner slash was never in question');
    eq(codes('fire'), '', 'a plain key still gets no opinion at all');
    eq(codes('? /and/or/'), 'warn:regex-core-refuses', 'a term reaches it too, on the same string');
    eq(codes('? /and\\/or/'), '', '...and clears the same way');
    eq(countKey('? "/and/or/"', 'the config at /and/or/ is set', false, false), 1, '? "…" is the literal hatch');
    eq(countKey('"/and/or/"', 'the config at /and/or/ is set', false, false), 0, '...and a bare "…" is not one');
    const msg = k => validateSmartKey(k)[0].message;
    eq(msg('/a\\/b/c/').includes('use ? "/a\\/b/c/".'), true, 'the hatch quotes the term as typed, not JSON-escaped');
    eq(countKey('? "/a\\/b/c/"', 'path /a\\/b/c/ here', false, false), 1, '...and that hatch matches the literal');
    eq(msg('/say "hi"/there/').includes('use ?'), false, 'no hatch is offered when quoting cannot work');
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
eq(matches('? =hers she', 'the ushers she saw'), false, 'AC candidate "hers" rejected by = verify');
eq(matches('? hers she', 'the ushers she saw'), true, 'unflagged substring terms accept the AC hit');

// keywordScore primes the automaton; primed countKey answers must match the naive walk on the SAME text buffer.
{
    const text = 'cat cats scatter, the Jubilees arrived at the hot tub';
    const entry = { key: ['cat', 'Jubilee', 'hot tub', 'nope'] };
    const { score, hits: h } = keywordScore(entry, text, entry.key, { k1: 2, caseSensitiveDefault: false, wholeWordsDefault: false });
    eq(h.map(x => `${x.key}:${x.count}`).join(' '), 'cat:3 Jubilee:1 hot tub:1', 'primed counts equal naive substring counts');
    // Expectation built through the shared curve, not an inlined formula, or a curve change reports as an Aho-Corasick fault.
    eq(score.toFixed(3), (repeatCurveOf(3, 2) + repeatCurveOf(1, 2) + repeatCurveOf(1, 2)).toFixed(3),
        'saturation unchanged by the fast path');
    eq(countKey('cat', text, false, true), 1, 'primed candidate, whole-word verify: standalone "cat" only');
    eq(countKey('jubilee', text, true, false), 0, 'primed candidate, case-sensitive verify rejects');
    eq(countKey('nope', text, true, true), 0, 'primed miss is authoritative under any flags');
}

eq(countKey('? (fire::3 XOR flood::3) OR water::0.5', 'fire and flood near the water', false, false), 0.5, 'failed XOR branch leaks no boost through OR');
eq(countKey('? (fire::3 alpha) OR water::0.5', 'fire and water', false, false), 0.5, 'half-matched AND leaks no boost through OR');
eq(countKey('? fire::3 XOR flood', 'a fire burns', false, false), 3, 'XOR still yields the matched side\'s weight');

{
    const T = v => ({ type: 'TERM', value: v, isExact: false, isCaseSensitive: false, weight: 1, acIndex: [0] });
    const empty = new Map();
    eq(evaluate({ type: 'AND', left: T('alpha'), right: T('alpha') }, 'alpha', empty).matched, false, 'acHits forwarded through AND');
    eq(evaluate({ type: 'NOT', operand: T('alpha') }, 'alpha', empty).matched, true, 'acHits forwarded through NOT');
}

{
    const data = { entries: { 0: { uid: 0, key: ['? moon mission', '? -apollo'], content: 'nothing relevant' } } };
    const opts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, minLength: 4 };
    const { classifyEntry } = buildKeyPruneScan(data, opts, new Set());
    eq(classifyEntry(data.entries[0]).map(f => f.flag).join(','), 'unattested,unusable', 'a dead query is flagged; a negation-only one is flagged unusable, not dead');
}

{
    const entries = {};
    for (let i = 1; i <= 12; i++) entries[i] = { uid: i, key: [], content: `Marjorie walked on.\nShe paused, number ${i}.` };
    entries[1].content += ' By the door.';
    entries[1].key = ['/\\n/', '/zzznope/', '/by the door/i', 'x'];
    const opts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true,
        pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, ignoreProper: false, bookShared: 0.5, minLength: 4 };
    const { classifyEntry, reasonOf } = buildKeyPruneScan({ entries }, opts, new Set());
    const flags = new Map(classifyEntry(entries[1]).map(f => [String(f.key), f]));
    eq(flags.get('/\\n/')?.flag, 'book common', 'a pattern that matches on every entry is book common while no chat is scanned for it');
    {
        const quiet = { messagesWith: new Map(entries[1].key.map(k => [k, 0])), messages: 50 };
        const withChat = buildKeyPruneScan({ entries }, opts, new Set(), { chatScan: quiet });
        eq(withChat.classifyEntry(entries[1]).some(f => String(f.key) === '/\\n/'), false, '...and with a chat that does not bear it out, nothing: ubiquity in entry text is a fact about the story');
    }
    eq(flags.get('/zzznope/')?.flag, 'unattested', '...and one that matches nowhere is flagged dead');
    eq(reasonOf(flags.get('/zzznope/')).text, 'never matches (book)', '...worded as evaluating false, not as absent text');
    eq(flags.has('/by the door/i'), false, 'a pattern that matches in exactly one entry draws nothing');
    eq(flags.get('/zzznope/')?.flag !== 'short', true, 'short-key never reads a pattern');
    eq(flags.get('x')?.flag, 'unattested', '...while a genuine literal is judged on its characters as before');
}

const ast = parse(tokenize('? a (b OR c)'));
eq(ast.type, 'AND', 'adjacent primaries get implicit AND');
eq(evaluate(ast, 'a c').matched, true, 'evaluates the injected AND');

{
    const T = 'fire and water everywhere';
    eq(matches('? +fire +water', T), true, 'leading + on every term (Lucene required-marker)');
    eq(matches('? +fire', T), true, 'a single leading +');
    eq(matches('? (+fire water)', T), true, 'leading + just inside a group');
    eq(matches('? & fire', T), true, 'leading &-alias is absorbed');
    eq(matches('? fire &', T), true, 'trailing operator keeps the left side');
    eq(matches('? fire && && water', T), true, 'a doubled operator is not two operands');
    eq(matches('? fire -', T), true, 'trailing negation keeps the left side');
    eq(matches('? +fire +zebra', T), false, 'a required term that is absent still fails');
    eq(matches('? +fire -water', T), false, 'negation still applies alongside a required-marker');
    eq(countKey('? fire | water', T, false, false), 2, 'OR sums its matched branches (see the recurrence block)');
    eq(countKey('? fire water', T, false, false), 2, 'genuine implicit AND is untouched');
}
console.log('ok   malformed operator positions degrade to no-ops, not dead keys');

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

// validateSmartKey: errors cannot match as meant under any text; warnings are legal and probably a typo.
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

{
    const entries = {};
    for (let i = 1; i <= 12; i++) entries[i] = { uid: i, key: [], content: `Marjorie walked. Entry number ${i}.` };   // no `the`: book common must not eat the list
    entries[1].key = ['? Marjorie'];          // matches everywhere
    entries[2].key = ['? zebra unicorn'];     // matches nowhere
    entries[3].key = ['Marjorie'];            // plain control with the same df
    entries[4].key = ['? the'];               // reduces to an English-common term
    entries[5].key = ["? (the|zebra)"];       // OR: as loose as its loosest branch; zebra is nowhere, so book common cannot eat it
    entries[6].key = ['? the Marjorie'];      // AND: one selective term gates it
    const opts = { scanKeyword: true, scanVectorized: true, scanConstant: true, pruneUnattested: true,
        pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true,
        minLength: 4, bookShared: 0.5, ignoreProper: true };
    // A chat scanned that bears none of these out: with chat evidence, ubiquity in entry text draws nothing on its own,
    // which is what lets the English-list verdicts below be observed. Without one, `book common` stands in (further down).
    const quiet = { messagesWith: new Map(Object.values(entries).flatMap(e => e.key).map(k => [k, 0])), messages: 50 };
    const sc = buildKeyPruneScan({ entries }, opts, new Set(), { caseSensitiveDefault: false, wholeWordsDefault: false, chatScan: quiet });
    const verdict = uid => { const f = sc.classifyEntry(entries[uid])[0]; return f ? `${f.flag}|${sc.reasonOf(f).text}` : ''; };

    eq(verdict(2), 'unattested|never matches (book/chat)', 'a query that evaluates false everywhere is flagged dead');
    eq(verdict(1), verdict(3), 'a SmartKey and the equivalent plain key get the same verdict');
    eq(verdict(1), '', '...and a key in every entry draws none with a chat scanned, so the SmartKey is not judged as a string either');
    eq(verdict(4), 'unattested|never matches (book/chat)', 'a common word the chat does not bear out is not common word: the chat has answered, and what remains is that it is dead');

    // The common list is the no-chat fallback, so its verdicts are observed without one.
    const noChat = buildKeyPruneScan({ entries }, opts, new Set(), { caseSensitiveDefault: false, wholeWordsDefault: false });
    const flagOf = uid => noChat.classifyEntry(entries[uid])[0]?.flag;
    const textOf = uid => { const f = noChat.classifyEntry(entries[uid])[0]; return f ? noChat.reasonOf(f).text : ''; };
    eq(textOf(1), 'book common (100%)', 'without a chat the book\'s own prose stands in: a key in every entry is book common');
    eq(textOf(1), textOf(3), '...for the SmartKey and the plain key alike');
    eq(textOf(4), 'common word (the)', 'a query reducing to a common word earns the English-common flag while no chat is scanned');
    eq(flagOf(5), 'common word', 'an alternation is as loose as its loosest branch');
    eq(textOf(5), 'common word (the)', '...and the loose branch is named');
    eq(flagOf(6) !== 'common word', true, 'a conjunction is as tight as its tightest conjunct, so it earns no common flag');
    entries[7].key = ['? ^Mark'];
    entries[8].key = ['? Mark'];
    eq(flagOf(7) !== 'common word', true, 'a case-sensitive capital cannot be the lower-case common word');
    eq(flagOf(8), 'common word', '...where the same term written plainly can');

    // Two common paths through one conjunction: unmeasured the first is named; measured, the one the chat matches.
    entries[9].key = ['? (=mom || =mother || parent) (=Nick || =my || Parsons)'];
    const probes = pathProbes(entries[9].key[0]);
    eq(probes.length, 9, 'every path is a probe, the whole product and not the common paths alone');
    eq(probes.includes('? =mother =my') && probes.includes('? parent Parsons'), true, '...each carrying its terms\' own flags');
    eq(textOf(9), 'common word (mom & my)', 'no chat: the first common path, joined with &');
    const msgs = ['my mother said', 'my mother again', 'oh my mother', 'my mom once', 'nothing here'];
    const chat = countChatHits([entries[9].key[0], ...probes], msgs);
    const scChat = buildKeyPruneScan({ entries }, opts, new Set(), { chatScan: { messagesWith: chat.messagesWith, messages: chat.messages } });
    eq(scChat.reasonOf(scChat.classifyEntry(entries[9])[0]).text, 'chat common (80%, mostly mother & my)',
        'over the share it is chat common, naming the path that matches most — the chat\'s question, not the list\'s');
    eq(scChat.severityOf(scChat.classifyEntry(entries[9])[0]), 'severe', '...and severe by degree at 80%, whatever the path');
    // The breadth earned by a legitimate path: named as such, which is what clears the English-list concern.
    const legit = ['my mom once', 'the parent Parsons', 'parent Parsons again', 'Parsons the parent', 'Nick and his parent'];
    const chat2 = countChatHits([entries[9].key[0], ...probes], legit);
    const sc2 = buildKeyPruneScan({ entries }, opts, new Set(), { chatScan: { messagesWith: chat2.messagesWith, messages: chat2.messages } });
    eq(sc2.reasonOf(sc2.classifyEntry(entries[9])[0]).text, 'chat common (100%, mostly parent & Parsons)',
        'a legitimate path matching most is what the chip names');
}
console.log('ok   SmartKeys are audited on df, exempt only from the literal-string heuristics');

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

    eq(c('? moon -apollo', 'moon moon'), 2, 'a negation contributes nothing to the sum');
    eq(c('? (fire::3 XOR flood::3) OR water::0.5', 'fire and flood near the water'), 0.5, 'a failed XOR leaks no boost');
    eq(c('? (fire::3 alpha) OR water::0.5', 'fire and water'), 0.5, 'a half-matched AND leaks no boost');
}
{
    const pairs = [
        ['? (Arthur | Kyle) Porsche', '? Porsche (Arthur | Kyle)', 'Kyle drove the Porsche. Arthur watched.'],
        ['? (Arthur | Kyle) Porsche', '? Porsche (Arthur | Kyle)', 'Arthur walked home.'],
        ['? /P[o]rsche/ Arthur', '? Arthur /P[o]rsche/', 'Arthur and the Porsche'],
        ['? /P[o]rsche/ Arthur', '? Arthur /P[o]rsche/', 'Arthur alone'],
        ['? =Kyle^2 Porsche', '? Porsche =Kyle^2', 'Kyle and the Porsche'],
        ['? fire -water', '? -water fire', 'fire alone'],
        ['? fire -water', '? -water fire', 'fire and water'],
    ];
    for (const [a, b, text] of pairs) {
        eq(countKey(a, text), countKey(b, text), `order does not change the count: ${a}  /  ${b}`);
    }
    eq(countKey('? zebra /P[o]rsche/', 'Arthur and the Porsche'), 0, 'a failed left operand yields no match');
}
console.log('ok   AND short-circuits without changing what it counts');

console.log('ok   terms score on weight x occurrences; OR sums');

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

{
    const t = 'Cap’n Joe drank at the CAFÉ — the café was warm.';
    eq(countKey("Cap'n", t, false, true), 1, 'baseline: a plain whole-word key folds the apostrophe');
    eq(countKey("? =Cap'n", t, false, false), 1, '=flagged SmartKey term folds it too');
    eq(countKey("? ^Cap'n", t, false, false), 1, '...and so does ^flagged');
    eq(countKey('? ^CAFÉ', t, false, false), 1, '^ still discriminates case after folding');
    eq(countKey('? =café', t, false, false), 2, '= counts every occurrence, either case');
}
console.log('ok   flagged terms verify against the folded haystack, like countKey');

{
    // Two texts, because agreeing on 0 is not agreement.
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

{
    const msg = 'The astronauts of the Apollo mission';
    eq(countKey('apollo astronauts', msg, false, false), 0, 'the plain key wants the words adjacent, in order');
    eq(countKey('? "apollo astronauts"', msg, false, false), 0, '...and the quoted term is the same key');
    eq(countKey('? apollo astronauts', msg, false, false) > 0, true, 'unquoted, order and distance stop mattering');
}
console.log('ok   the SMARTKEYS.md worked example holds');

// --- proximity: `(…)~N` holds a group to a window — its things within N words of each other, in any order
{
    const c = (q, t) => { resetSmartKeys(); return countKey(q, t, false, false); };
    const codes = k => validateSmartKey(k).map(p => `${p.severity}:${p.code}`).join(' ');
    eq(c('? (copper pipe)~1', 'a copper hot pipe burst'), 1, 'one word between is within ~1');
    eq(c('? (copper pipe)~0', 'a copper hot pipe burst'), 0, '...and not within ~0, which is adjacency');
    eq(c('? (copper pipe)~0', 'the pipe, copper, burst'), 1, 'adjacency in either order; punctuation is not a word');
    eq(c('? (copper pipe)~2', 'copper, then the pipe'), 1, 'two words between is within ~2');
    eq(c('? (copper pipe)~1', 'copper, then the pipe'), 0, '...and outside ~1');
    eq(c('? (copper pipe)~1', 'the pipe was copper'), 1, 'order-free, as a group is');
    eq(c('? (copper pipe)', 'copper is far from the old pipe'), 2, 'a group without ~ keeps segment scope, and its two units');
    eq(c('? ((Arthur | Kyle) Porsche)~2', 'Arthur watched from afar as Kyle drove the Porsche'), 1, 'an alternation takes the nearer branch');
    eq(c('? ((Arthur | Kyle) Porsche)~1', 'Arthur watched from afar as Kyle drove the Porsche'), 0, '...and fails when neither is near');
    eq(c('? ((Arthur | Kyle) Porsche)~2', 'Arthur watched the Porsche while Kyle slept far away'), 1, '...whichever branch it is');
    eq(c('? (copper pipe)~1', 'copper pipe, copper pipe, and copper'), 2, 'occurrences are clusters');
    eq(c('? (copper pipe)~1', 'copper pipe pipe'), 1, 'a cluster is consumed: the second pipe has no copper of its own');
    eq(c('? copper pipe', 'copper pipe pipe'), 3, '...where the plain conjunction counts every mention');
    eq(c('? (fire -drill)~2', 'a fire started'), 1, 'a negation inside: absent, the positive stands');
    eq(c('? (fire -drill)~2', 'a fire drill started'), 0, '...present within N words, it vetoes');
    eq(c('? (fire -drill)~2', 'the fire blazed far from the drill site'), 1, '...present beyond N words, it does not');
    eq(c('? (fire -drill)~2', 'fire drill. Later on, the fire spread.'), 1, 'the veto is over the padded window, not the segment');
    eq(c('? fire -drill', 'fire drill. Later on, the fire spread.'), 0, '...which is what a plain negation is');
    eq(c('? (fire -drill)~2', 'fire drill. Later the fire spread.'), 0, 'a negative with N words between is within reach, as a positive would be');
    eq(c('? (fire -drill)~0', 'fire drill'), 0, '...so at ~0 an adjacent negative vetoes');
    eq(c('? (fire -drill)~0', 'fire and drill'), 1, '...and one word away does not');
    eq(c('? (fire -(drill practice))~2', 'a fire drill, no practice'), 0, 'a compound negation holds by its operator over what is within reach: both words are');
    eq(c('? (fire -(drill practice))~2', 'a fire drill today and tomorrow and practice'), 1, '...and here practice is not, so nothing vetoes');
    eq(c('? (fire -(drill practice))~0', 'drill fire practice'), 0, 'either side of the cluster is within reach');
    eq(c('? (fire -(drill practice)~0)~0', 'drill fire practice'), 1, 'a nested group vetoes by its own clusters, and these two are not adjacent to each other');
    eq(c('? (fire -(drill practice)~0)~0', 'fire drill practice'), 0, '...but here they are, and the cluster is adjacent to fire though it runs past the reach');
    eq(c('? (fire -"drill practice")~0', 'fire drill practice'), 0, 'a phrase vetoes the same way: adjacent, however long');
    eq(c('? (copper pipe)~1::3', 'copper pipe'), 3, 'a weight after ~N multiplies the cluster');
    eq(c('? (/P[o]rsche/ Kyle)~2', 'Kyle drove the Porsche'), 1, 'a regex leaf has a position too');
    eq(c('? (/P[o]rsche/ Kyle)~1', 'Kyle drove the Porsche'), 0, '...counted in the same words');
    eq(c('? ((copper pipe)~0 burst)~1', 'copper pipe suddenly burst'), 1, 'a proximity group nests as one thing with its clusters as its spans');
    eq(c('? ((copper pipe)~0 burst)~1', 'copper old pipe burst'), 0, '...and an inner failure is an outer absence');
    eq(c('? ((fire XOR flame) truck)~1', 'fire truck'), 1, 'XOR inside is (fire -flame) | (flame -fire), the negations the group\'s own veto');
    eq(c('? ((fire XOR flame) truck)~1', 'flame truck'), 1, '...whichever side it is');
    eq(c('? ((fire XOR flame) truck)~1', 'fire flame truck'), 0, '...and no cluster when the other side is within its reach');
    eq(c('? ((fire XOR flame) truck)~1', 'fire truck. Later, a flame truck.'), 2, '...where two clusters out of each other\'s reach both stand');
    eq(c('? ((fire XOR flame) truck)~1', 'fire truck and then flame'), 1, '...and a flame with no truck of its own is no objection');
    eq(c('? ((john XOR quincy) adams)~1', 'John James Adams'), 1, 'the worked example: one side with a word between');
    eq(c('? ((john XOR quincy) adams)~1', 'Quincy Jefferson Adams'), 1, '...the other side likewise');
    eq(c('? ((john XOR quincy) adams)~1', 'John Quincy Adams'), 0, '...and both sides within reach is neither');
    eq(c('? ((john XOR quincy) adams)~1', 'Quincy Adams and John Adams'), 1, 'a vetoed window consumes nothing: John Adams forms after Adams-and-John is refused');
    eq(c('? (fire XOR flame)~1', 'fire and flame'), 0, 'a group that is itself the XOR: each side within the other\'s reach');
    eq(c('? (fire XOR flame)~1', 'fire and fire'), 2, '...and one side alone counts its occurrences');
    eq(c('? (((john james) | quincy) adams)~1', 'John Adams'), 0, 'an alternation of longer things is a choice: the left side needs both names');
    eq(c('? (((john james) | quincy) adams)~1', 'John James Adams and Quincy Adams'), 2, '...swept together, so each Adams goes to the name beside it');
    eq(c('? (=cat (dog | wolf))~1', 'the cat and wolf'), 1, 'flags on leaves hold inside a group');
    eq(c('? (=cat (dog | wolf))~1', 'the category and wolf'), 0, '...so = still refuses the substring');
    eq(c('? (fire pipe)~0', 'firetruck pipe'), 1, 'a span is widened to its word before slack is counted: a substring hit is as near as its word');
    eq(c('? (fire -drill)~0', 'firetruck drill'), 0, '...and the pad is measured from the word too');
    setBoundaryMode('strict');
    eq(c('? (copper pipe)~1', 'copper well-known pipe'), 1, 'slack counts words off the boundary class: strict reads well-known as one');
    setBoundaryMode('permissive');
    eq(c('? (copper pipe)~1', 'copper well-known pipe'), 0, '...and permissive as two');
    setBoundaryMode('strict');
    const cfg = { k1: 2, caseSensitiveDefault: false, wholeWordsDefault: false };
    eq(keywordScore({ key: ['? (copper pipe)~1'] }, 'copper pipe', undefined, cfg).score, 1, 'a proximity group scores as one thing');
    eq(keywordScore({ key: ['? copper pipe'] }, 'copper pipe', undefined, cfg).score, 2, '...where the conjunction is two');
    eq(codes('? (copper pipe)~3'), '', 'a proximity group validates clean');
    eq(codes('? "copper pipe"~3'), 'error:proximity-on-phrase', '~N after a phrase is refused: a phrase already carries order');
    eq(codes('? (copper pipe)~'), 'warn:punctuation-term', 'the digits are required; a bare ~ is text');
    eq(codes('? (-drill)~3'), 'error:negation-only', 'a group with no positive is the existing error');
    eq(codes('? fire~2'), '', '~ inside a term is still a literal');
    eq(c('? fire~2', 'fire~2 here'), 1, '...and still matches its characters');
    eq(codes('? (fire)~3'), '', 'a one-term group takes ~N: parse stamps `near` on the term, which is not the phrase case');
    const rp = tokenize('? (a b)~3::2').find(t => t.type === 'RPAREN');
    eq(`${rp.near}/${rp.weight}`, '3/2', '~N then the weight ride on the closing paren');
    const rp2 = tokenize('? (a b)::2~3').find(t => t.type === 'RPAREN');
    eq(`${rp2.near}/${rp2.weight}`, '3/2', '...in either order, so the two spellings are one key');
    eq(codes('? (a b)~3::2~5'), 'error:stray-proximity', 'a second ~N is fatal: the group took the first, and this one searches for text');
    eq(codes('? (a b) ~5'), 'error:stray-proximity', '...whitespace does not attach it either');
    eq(codes('? fire ~5'), '', 'a ~N not after a group is ordinary text ("~5 minutes"), never the misplaced operator');
    eq(codes('? (a b)~3 "~5"'), '', '...and quoting it after a group says the text was meant');
}
console.log('ok   proximity: (…)~N clusters a group within N words, vetoes over the padded window');
