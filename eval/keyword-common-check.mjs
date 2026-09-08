// The English-commonness cut behind the too-common flag: the deliberated words land on the expected side of the one list.
import assert from 'node:assert';
import { COMMON_WORDS } from '../plugin/commonwords.js';

const isCommon = w => COMMON_WORDS.has(w);

for (const w of ['home', 'street', 'house', 'room', 'night', 'king', 'door', 'blood', 'fire'])
    assert(isCommon(w), `${w} should flag`);

for (const w of ['magic', 'spirit', 'soul', 'queen'])
    assert(isCommon(w), `${w} should flag`);

for (const w of ['aria', 'castle', 'dragon'])
    assert(!isCommon(w), `${w} should never flag`);

console.log('keyword-common-check: ok');
