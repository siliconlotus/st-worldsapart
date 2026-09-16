// WA's own decorator semantics: the desugar table, the conflict rules, and the refusals.
// An assertion citing ST core as the authority goes in core-matcher-check.mjs instead.
import { decoratorFields, activationAdds, keywordScore, latchKey, latchBook, partitionLatches, hasLatch, SCENE_UNMODELLED_GATES, unmodelledGates, DEFAULT_WI_DEPTH, WI_POSITION, WI_ROLE, WI_LOGIC } from '../extension/matcher.mjs';
import { eq, eqDeep } from '../eval/lib/metrics.mjs';

const patch = (content, entry = {}, chatLength = 0) => decoratorFields({ key: ['k'], content, ...entry }, { chatLength });

// --- the straightforward mappings
eqDeep(patch('@@depth 0\nx'), { position: WI_POSITION.atDepth, depth: 0 }, '@@depth sets at-depth and the depth');
eqDeep(patch('@@depth 7\nx'), { position: WI_POSITION.atDepth, depth: 7 }, '...at any depth');
eqDeep(patch('@@scan_depth 3\nx'), { scanDepth: 3 }, '@@scan_depth sets scanDepth');

// @@reverse_depth counts from the START, so the spec defines it as @@depth <total messages> - N.
eqDeep(patch('@@reverse_depth 2\nx', {}, 10), { position: WI_POSITION.atDepth, depth: 8 },
    '@@reverse_depth 2 in a 10-message chat is depth 8');
eqDeep(patch('@@reverse_depth 2\nx', {}, 20), { position: WI_POSITION.atDepth, depth: 18 },
    '...and the distance from the end grows with the chat, which is what reversed means');
eqDeep(patch('@@reverse_depth 30\nx', {}, 10), {}, 'a negative result is out of range and refused');
eqDeep(patch('@@position before_desc\nx'), { position: WI_POSITION.before }, 'before_desc is before char defs');
eqDeep(patch('@@position after_desc\nx'), { position: WI_POSITION.after }, 'after_desc is after char defs');
eqDeep(patch('@@position personality\nx'), { position: WI_POSITION.after }, 'personality has no ST slot: nearest anchor');
eqDeep(patch('@@position scenario\nx'), { position: WI_POSITION.after }, 'scenario likewise');
console.log('ok   the scalar mappings');

// --- the shape decoratorFields actually receives on a parsed entry: core has stripped content, so it
// must read the waDecorators stash, like activationAdds's gates below. Without it, this returns {} in silence.
eqDeep(decoratorFields({ key: ['k'], content: 'The villa', decorators: [], waDecorators: ['@@depth 3'] }, { chatLength: 0 }),
    { position: WI_POSITION.atDepth, depth: 3 }, 'a parsed entry patches off waDecorators, its content having been stripped');
console.log('ok   decoratorFields reads the stash on a parsed entry');

// --- the decorator beats a field the entry also sets
eqDeep(patch('@@depth 0\nx', { position: 1, depth: 4 }), { position: WI_POSITION.atDepth, depth: 0 },
    'the importer default loses to what the author wrote');
console.log('ok   the decorator overwrites the entry\'s own field');

// --- @@role implies at-depth, and an explicit @@position beats it
eqDeep(patch('@@role assistant\nx'), { role: WI_ROLE.ASSISTANT, position: WI_POSITION.atDepth, depth: DEFAULT_WI_DEPTH },
    '@@role alone implies at-depth: a role is a request for message injection');
eqDeep(patch('@@role user\nx', { depth: 2 }), { role: WI_ROLE.USER, position: WI_POSITION.atDepth, depth: 2 },
    '...at the entry\'s own depth when it has one');
eqDeep(patch('@@role system\nx', { position: WI_POSITION.atDepth, depth: 3 }), { role: WI_ROLE.SYSTEM },
    'an entry already at-depth needs no implied position');
eqDeep(patch('@@depth 5\n@@role user\nx'), { position: WI_POSITION.atDepth, depth: 5, role: WI_ROLE.USER },
    '@@depth and @@role are harmonious');
eqDeep(patch('@@role user\n@@position before_desc\nx'), { position: WI_POSITION.before },
    'an explicit @@position beats the implied at-depth AND drops the role');
eqDeep(patch('@@position before_desc\n@@role user\nx'), { position: WI_POSITION.before },
    '...whichever order they are written in');
console.log('ok   @@role implies at-depth; an explicit @@position beats it');

// --- first write to a field wins
eqDeep(patch('@@depth 0\n@@depth 5\nx'), { position: WI_POSITION.atDepth, depth: 0 }, 'the first of a duplicate wins');
eqDeep(patch('@@depth 0\n@@position before_desc\nx'), { position: WI_POSITION.atDepth, depth: 0 },
    '@@depth came first, so @@position does not overwrite position');
eqDeep(patch('@@position before_desc\n@@depth 0\nx'), { position: WI_POSITION.before },
    '...and the other way round, @@depth\'s depth is dropped with its position');
console.log('ok   document order, first write to a field wins');

// --- refusals
eqDeep(patch('@@ignore_on_max_context\nx'), {}, '@@ignore_on_max_context is not implemented: ignoreBudget false is the default');
eqDeep(patch('@@depth\nx'), {}, '@@depth with no argument is unparseable and ignored');
eqDeep(patch('@@depth abc\nx'), {}, '...as is a non-numeric one');
eqDeep(patch('@@role captain\nx'), {}, 'an unknown role value is ignored');
eqDeep(patch('@@position nowhere\nx'), {}, 'an unknown position value is ignored');
eqDeep(patch('@@scan_depth -1\nx'), {}, 'a negative scan depth is out of range');
eqDeep(patch('x'), {}, 'no decorators is an empty patch, not a patch of defaults');
console.log('ok   refusals: unparseable, out of range, and not implemented');

// --- @@activate_only_after counts ASSISTANT messages. WA gates activation on it directly; it is not
// mapped onto core's `delay`, which counts chat length.
const winA = () => () => ['the villa burned'];
const after = (n, assistantCount) => activationAdds(
    [{ uid: 1, world: 'W', key: ['villa'], content: `@@activate_only_after ${n}\nx` }],
    winA(), { assistantCount, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false },
).length;

eq(after(2, 1), 0, 'one assistant message of two required: not activated');
eq(after(2, 2), 1, 'the count is reached: activated');
eq(after(2, 9), 1, 'and stays activated after it');
eq(after(0, 0), 1, 'zero is no gate at all');
eq(activationAdds([{ uid: 2, world: 'W', key: ['villa'], content: '@@activate_only_after abc\nx' }],
    winA(), { assistantCount: 0, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).length, 1,
    'an unparseable count is ignored, so the entry is ungated');
eq(activationAdds([{ uid: 3, world: 'W', key: ['villa'], content: '@@activate_only_after 5\nx' }],
    winA(), { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).length, 1,
    'no assistantCount in opts at all leaves the gate off, as before');
console.log('ok   @@activate_only_after gates activation on the assistant message count');

// --- @@is_greeting gates on WHICH greeting is active: message 0's swipe_id, since getFirstMessage builds
// swipes as [first_mes, ...alternate_greetings] (script.js `getFirstMessage`).
const greet = (n, greetingIndex) => activationAdds(
    [{ uid: 1, world: 'W', key: ['villa'], content: `@@is_greeting ${n}\nx` }],
    winA(), { greetingIndex, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false },
).length;

eq(greet(0, 0), 1, 'greeting 0 is first_mes, and the entry asks for it');
eq(greet(1, 0), 0, 'the entry asks for the first alternate, but first_mes is active');
eq(greet(1, 1), 1, 'the first alternate is active');
eq(greet(2, 1), 0, 'a different alternate is active');
eq(activationAdds([{ uid: 2, world: 'W', key: ['villa'], content: '@@is_greeting 1\nx' }],
    winA(), { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).length, 1,
    'no greetingIndex in opts at all leaves the gate off, as before');
console.log('ok   @@is_greeting gates on the active greeting index');

// --- @@activate_only_every: no remainder, and it reuses the count @@activate_only_after needs.
const every = (n, assistantCount) => activationAdds(
    [{ uid: 1, world: 'W', key: ['villa'], content: `@@activate_only_every ${n}\nx` }],
    winA(), { assistantCount, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false },
).length;

eq(every(3, 3), 1, 'three of three: no remainder, activated');
eq(every(3, 6), 1, 'six of three: likewise');
eq(every(3, 4), 0, 'four of three leaves a remainder');
eq(every(0, 4), 1, 'a zero divisor is refused, so the entry is ungated');
console.log('ok   @@activate_only_every gates on the remainder');

// --- @@is_user_icon compares the active persona name, ST's name1.
const icon = (want, personaName) => activationAdds(
    [{ uid: 1, world: 'W', key: ['villa'], content: `@@is_user_icon ${want}\nx` }],
    winA(), { personaName, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false },
).length;

eq(icon('Mara', 'Mara'), 1, 'the active persona matches');
eq(icon('Mara', 'Juno'), 0, 'a different persona does not');
eq(activationAdds([{ uid: 2, world: 'W', key: ['villa'], content: '@@is_user_icon Mara\nx' }],
    winA(), { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).length, 1,
    'no personaName in opts at all leaves the gate off, as before');
console.log('ok   @@is_user_icon gates on the active persona name');

// --- the shape activationAdds actually receives: core has stripped content, so the gates read the stash
// the ST half writes at onEntriesLoaded. Without it @@is_greeting would silently never fire.
const parsed = { uid: 1, world: 'W', key: ['villa'], decorators: [], content: 'The villa',
    waDecorators: ['@@is_greeting 1'] };
eq(activationAdds([parsed], winA(), { greetingIndex: 1, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).length, 1,
    'a parsed entry gates off waDecorators, its content having been stripped');
eq(activationAdds([parsed], winA(), { greetingIndex: 0, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).length, 0,
    '...and is gated out when the greeting does not match');
console.log('ok   the gates read the stash on a parsed entry');

// --- @@additional_keys and @@exclude_keys: alone each maps to keysecondary + selectiveLogic, together
// ST cannot express both so WA compiles one SmartKey.
const keys = (content, entry = {}, smartKeys = true) =>
    decoratorFields({ key: ['villa'], content, ...entry }, { chatLength: 0, smartKeys });

// --- alone, each maps to the core-compatible fields
eqDeep(keys('@@additional_keys storm,rain\nx'),
    { keysecondary: ['storm', 'rain'], selectiveLogic: WI_LOGIC.AND_ANY, selective: true },
    '@@additional_keys: at least one of them must be present');
eqDeep(keys('@@exclude_keys dream\nx'),
    { keysecondary: ['dream'], selectiveLogic: WI_LOGIC.NOT_ANY, selective: true },
    '@@exclude_keys: none of them may be present');
eqDeep(keys('@@additional_keys  storm , rain \nx').keysecondary, ['storm', 'rain'], 'the comma list is trimmed');
eqDeep(keys('@@additional_keys\nx'), {}, 'an empty list is ignored');

// A decorator's argument is a key list, so it splits like every other key list: splitKeys, not `split(',')`.
// Shredding a regex here writes its fragments into keysecondary, which CORE then matches literally.
eqDeep(keys('@@exclude_keys /re,gex/, night\nx').keysecondary, ['/re,gex/', 'night'],
    'a /regex/ argument keeps its commas');
eqDeep(keys('@@additional_keys "storm, heavy", rain\nx').keysecondary, ['"storm, heavy"', 'rain'],
    'a "quoted" argument keeps its commas');
eqDeep(keys('@@additional_keys ? a && "x, y"\nx').keysecondary, ['? a && "x, y"'],
    'a ? SmartKey argument survives whole, for keyNode to parse');

// CCv3 allows both of these more than once on one entry, so their lists accumulate. This is not a
// competing write to one field, so first-write-wins does not reach it.
eqDeep(keys('@@additional_keys storm\n@@additional_keys rain\nx').keysecondary, ['storm', 'rain'],
    'a repeated @@additional_keys accumulates');
eqDeep(keys('@@exclude_keys dream\n@@exclude_keys fog\nx').keysecondary, ['dream', 'fog'],
    '...and so does a repeated @@exclude_keys');

// The realistic way a repeat arises: an author guards an app-specific decorator with a `@@@` fallback,
// so the chain contributes a second list alongside any direct one.
eqDeep(keys('@@elaborate_custom_match_logic\n@@@additional_keys apple, banana\nx').keysecondary,
    ['apple', 'banana'], 'a @@@ fallback supplies the list when the decorator above it is unrecognised');
eqDeep(keys('@@additional_keys cherry\n@@elaborate_custom_match_logic\n@@@additional_keys apple, banana\nx').keysecondary,
    ['cherry', 'apple', 'banana'], '...and accumulates with a direct line rather than losing one of them');
console.log('ok   each key decorator alone maps to keysecondary');

// --- together. ST's single selectiveLogic cannot hold both gates, so `@@additional_keys` keeps the
// core-native mapping and the exclusions ride on a WA-only field, composed into the gate as AST nodes at
// match time. The entry's own keys are never rewritten, so nothing in them can be read as syntax.
eqDeep(keys('@@additional_keys storm,rain\n@@exclude_keys dream,fog\nx'),
    { keysecondary: ['storm', 'rain'], selectiveLogic: WI_LOGIC.AND_ANY, selective: true, waExcludeKeys: ['dream', 'fog'] },
    'both present: additional stays core-native, exclusions go to waExcludeKeys');
eq('key' in keys('@@additional_keys storm\n@@exclude_keys dream\nx'), false,
    'the entry\'s own keys are never rewritten');
console.log('ok   both together keep the native mapping and add a WA-only exclusion list');

// The gate itself, through the shipped matcher. Every key below previously had to be quoted, escaped or
// refused because it was spliced into a SmartKey string; none of them needs anything now.
const PAIR = '@@additional_keys storm,rain\n@@exclude_keys dream,fog\nThe villa';
const gated = (key, text) => {
    const e = { key: [key], content: PAIR };
    Object.assign(e, decoratorFields(e, { chatLength: 0 }));
    return keywordScore(e, text, e.key, { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).hits.length > 0;
};

for (const k of ['villa', 'the house', 'HP::100', '=weird', 'the "windy" city', 'a||b', 'Xor']) {
    eq(gated(k, `${k} in the storm`), true, `${k}: an additional key present is a match`);
    eq(gated(k, `${k} in heavy rain`), true, `${k}: any one additional key suffices`);
    eq(gated(k, `${k} in the storm and a dream`), false, `${k}: an excluded key suppresses it`);
    eq(gated(k, `${k} on a quiet day`), false, `${k}: no additional key, no match`);
}
eq(gated('/vil+a/i', 'the villa in the storm'), true, 'a regex key matches under the pair');
eq(gated('/vil+a/i', 'the villa in the storm and a dream'), false, '...and is gated by the exclusions');
console.log('ok   the pair gates correctly for keys that no longer need quoting or refusal');

// A key that is itself a SmartKey is spliced in as a subtree by keyNode, never re-lexed from text.
eq(gated('? villa || manor', 'the manor in the storm'), true, 'a ? key still works under the pair');
eq(gated('? villa || manor', 'the manor in the storm and a dream'), false, '...and is still gated by the exclusions');

// An unusable exclusion is filtered where the gate is built, not silently dropped from the patch.
eqDeep(keys('@@additional_keys storm\n@@exclude_keys /bad(/, dream\nx').waExcludeKeys, ['/bad(/', 'dream'],
    'an unparseable regex is carried into waExcludeKeys and filtered at gate-build time');
eq(gated('villa', 'the villa in the storm'), true, 'sanity: the plain case still matches');
console.log('ok   ? keys splice in, and an unusable exclusion does not take the gate with it');

// --- @@dont_activate_after_match and @@keep_activate_after_match: WA's own per-chat latch record,
// read from opts.fired rather than core's timedWorldInfo (see task-8-brief.md for why).
const US = String.fromCharCode(0x1F);
const win = () => () => ['the villa burned'];
const opts = fired => ({ fired, chatLength: 99, k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false });
const adds = (entries, fired) => activationAdds(entries, win(), opts(fired)).map(e => e.uid).join(',');
// waDecorators, not decorators: decoratorFor reads the stash, never core's own `decorators` field.
const ent = (uid, waDecorators) => ({ uid, world: 'W', key: ['villa'], waDecorators, content: 'x' });

eq(latchKey({ world: 'W', uid: 3 }), `W${US}3`, 'the latch key is US-separated, per CLAUDE.md');
eq(adds([ent(1, [])], new Set()), '1', 'an ordinary entry activates on its keyword');
eq(adds([ent(2, ['@@dont_activate_after_match'])], new Set()), '2',
    'a one-shot entry activates the FIRST time: it has not fired yet');
eq(adds([ent(2, ['@@dont_activate_after_match'])], new Set([`W${US}2`])), '',
    '...and never again once recorded');
eq(adds([ent(3, ['@@keep_activate_after_match'])], new Set([`W${US}3`])), '3',
    'a latched-on entry activates');

// It must activate with no keyword hit at all — that is the whole point.
const noMatch = activationAdds([ent(4, ['@@keep_activate_after_match'])], () => ['nothing here'], opts(new Set([`W${US}4`])));
eq(noMatch.length, 1, 'a latched-on entry activates with no keyword hit');

eq(adds([ent(5, ['@@dont_activate_after_match', '@@keep_activate_after_match'])], new Set([`W${US}5`])), '5',
    'both decorators: latches ON, as @@activate beats @@dont_activate in CCv3');
eq(adds([ent(6, ['@@dont_activate_after_match'])], undefined), '6',
    'no latch state at all behaves exactly as before');

// The delay guard must run above the latch hoist: core drops a matched entry for an unarrived delay
// before WA's own emit ever reaches it, so the hoist must not exempt a latched-on entry from it.
const delayed = { ...ent(7, ['@@keep_activate_after_match']), delay: 50 };
eq(activationAdds([delayed], win(), { ...opts(new Set([`W${US}7`])), chatLength: 10 }).length, 0,
    'a latched-on entry whose delay has not arrived is not emitted');
console.log('ok   the latch decorators, read from WA\'s own record');

// --- latchBook: the deleted-book prune's pure half (st/studio.mjs deleteBooks reads the current
// chat's fired list and drops any key whose book segment names a deleted book).
eq(latchBook(`W${US}3`), 'W', 'the book is the segment before the US');
eq(latchBook(`My Book${US}12`), 'My Book', 'a book name may itself contain spaces');
eq(latchBook(''), '', 'an empty key has no book');

// Deleting a book prunes its latch keys from the open chat's record; the undo puts them back, so the
// prune has to hand back what it removed rather than only what it kept.
eqDeep(partitionLatches([`W${US}1`, `W${US}2`, `X${US}3`], ['W']),
    { kept: [`X${US}3`], dropped: [`W${US}1`, `W${US}2`] }, 'a deleted book\'s keys are separated from the rest');
eqDeep(partitionLatches([`W${US}1`, `X${US}2`], ['W', 'X']),
    { kept: [], dropped: [`W${US}1`, `X${US}2`] }, 'several books at once');
eqDeep(partitionLatches([`W${US}1`], ['X']), { kept: [`W${US}1`], dropped: [] }, 'a book with no latches drops nothing');
eqDeep(partitionLatches([`My Book${US}1`], ['My Book']), { kept: [], dropped: [`My Book${US}1`] },
    'a book name with spaces still matches');
eqDeep(partitionLatches([], ['W']), { kept: [], dropped: [] }, 'an empty record');
eqDeep(partitionLatches(null, ['W']), { kept: [], dropped: [] }, 'an absent record is not a crash');

// Offline scene re-derivation cannot model the gates that read the chat's shape — an assistant/user split,
// message 0's swipe_id, the persona, the latch record — because a capture stores the chat as one joined
// string. It reports what it cannot model rather than over-admitting in silence.
const gateEntry = (uid, content) => ({ uid, world: 'W', key: ['villa'], content });
eqDeep(unmodelledGates([gateEntry(1, '@@is_greeting 2\nx')]), ['@@is_greeting'], 'a gate it cannot model is named');
eqDeep(unmodelledGates([gateEntry(1, '@@depth 0\nx')]), [], 'a decorator that is a plain field patch is not a gate');
eqDeep(unmodelledGates([gateEntry(1, 'The villa')]), [], 'an entry with no decorators names nothing');
eqDeep(unmodelledGates([gateEntry(1, '@@is_greeting 2\nx'), gateEntry(2, '@@is_user_icon Mara\nx'), gateEntry(3, '@@is_greeting 0\nx')]),
    ['@@is_greeting', '@@is_user_icon'], 'names are reported once each, in SCENE_UNMODELLED_GATES order');
eq(SCENE_UNMODELLED_GATES.includes('@@keep_activate_after_match'), true, 'the latch pair is unmodellable too: a capture holds no latch record');
eqDeep(unmodelledGates([]), [], 'no entries, nothing to report');
console.log('ok   latchBook recovers the book name from a latch key');

// --- hasLatch: the one predicate for "carries a latch decorator", shared by the activationAdds gate and
// worldsapart.js's recordLatches.
eq(hasLatch(ent(8, ['@@dont_activate_after_match'])), true, 'dont_activate_after_match carries a latch');
eq(hasLatch(ent(9, ['@@keep_activate_after_match'])), true, 'keep_activate_after_match carries a latch');
eq(hasLatch(ent(10, ['@@dont_activate_after_match', '@@keep_activate_after_match'])), true, 'both still carries a latch');
eq(hasLatch(ent(11, [])), false, 'no decorators carries no latch');
eq(hasLatch(ent(12, ['@@activate'])), false, 'an unrelated decorator carries no latch');
console.log('ok   hasLatch');
