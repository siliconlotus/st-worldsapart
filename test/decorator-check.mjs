// WA's own decorator semantics: the desugar table, the conflict rules, and the refusals.
// An assertion citing ST core as the authority goes in core-matcher-check.mjs instead.
import { decoratorFields, activationAdds, DEFAULT_WI_DEPTH, WI_POSITION, WI_ROLE } from '../extension/matcher.mjs';
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
// swipes as [first_mes, ...alternate_greetings] (script.js:7723).
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
