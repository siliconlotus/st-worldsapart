// entry-form-check.mjs — the card's pure helpers: chip packing, select ranges, the state summary line.
import { eq, eqDeep } from '../eval/lib/metrics.mjs';
import { packByLength, rangeOptions, entryStateParts } from '../extension/entry-form.mjs';

eqDeep(packByLength(['a', 'ccc', 'bb', 'dd']), ['ccc', 'bb', 'dd', 'a'], 'longest first, ties stable');
eqDeep(packByLength([]), [], 'empty');
const keys = ['x', 'yy']; packByLength(keys); eqDeep(keys, ['x', 'yy'], 'input untouched');

eqDeep(rangeOptions('', { off: 'Off', max: 3 }).map(o => o.value), ['', '1', '2', '3'], 'off then 1..max');
eqDeep(rangeOptions(60, { max: 3 }).map(o => o.value), ['0', '1', '2', '3', '60'], 'no off: 0..max, out-of-range appended');
eqDeep(rangeOptions(7, { off: 'Off', any: 'Any level', max: 5 }).map(o => o.label), ['Off', 'Any level', '1', '2', '3', '4', '5', '7'], 'any after off');
eq(rangeOptions(2, { off: 'Off', max: 5 }).map(o => o.value).includes('2'), true, 'in range not duplicated');
eq(rangeOptions(2, { off: 'Off', max: 5 }).length, 6, 'in range: exactly off + 5');

const g = { caseGlobal: false, wholeGlobal: true };
eqDeep(entryStateParts({}, g), [], 'nothing set');
eqDeep(entryStateParts({ sticky: 3, probability: 60, useProbability: true, matchWholeWords: true, caseSensitive: true }, g),
    ['sticky 3', '60%', 'case-sensitive', 'whole words'], 'the common set');
eqDeep(entryStateParts({ probability: 60, useProbability: false }, g), [], 'probability off does not gate');
eqDeep(entryStateParts({ content: '@@promote\nx', cooldown: 2, delay: 1, excludeRecursion: true, preventRecursion: true, delayUntilRecursion: 2, ignoreBudget: true, scanDepth: 5 }, g),
    ['promoted', 'cooldown 2', 'delay 1', 'non-recursable', 'prevent recursion', 'delay until recursion 2', 'ignore budget', 'scan depth 5'], 'the rest');
eqDeep(entryStateParts({ matchWholeWords: null }, g), [], 'inherited whole words is not a part even when the global is on');
eqDeep(entryStateParts({ sticky: 3 }, g, (s, ...v) => String.raw({ raw: s }, ...v).toUpperCase()), ['STICKY 3'], 'tag applied');
eqDeep(entryStateParts({ delayUntilRecursion: true }, g), ['delay until recursion'], 'bare delay-until label');
eqDeep(rangeOptions(0, { off: 'Off', max: 3 }).map(o => o.value), ['', '1', '2', '3', '0'], 'stored 0 beside Off');
