// The English-commonness cut behind the too-common flag: the deliberated words land on the expected side of the one list.
import assert from 'node:assert';
import { PACK } from '../extension/zipf-en.js';
const COMMON_WORDS = new Set(PACK.common.split(' '));

const isCommon = w => COMMON_WORDS.has(w);

for (const w of ['home', 'street', 'house', 'room', 'night', 'king', 'door', 'blood', 'fire'])
    assert(isCommon(w), `${w} should flag`);

for (const w of ['magic', 'spirit', 'soul', 'queen'])
    assert(isCommon(w), `${w} should flag`);

for (const w of ['aria', 'castle', 'dragon'])
    assert(!isCommon(w), `${w} should never flag`);

console.log('keyword-common-check: ok');
