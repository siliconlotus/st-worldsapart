// WA's own decorator semantics: the desugar table, the conflict rules, and the refusals.
// An assertion citing ST core as the authority goes in core-matcher-check.mjs instead.
import { decoratorFields, DEFAULT_WI_DEPTH, WI_POSITION, WI_ROLE } from '../extension/matcher.mjs';
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
