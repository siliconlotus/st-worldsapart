// The English-commonness cut behind the too-common flag: the deliberated words land on the expected side of the one list.
import assert from 'node:assert';
import { PACK } from '../extension/wa-pack-en.js';
import { table, usePack } from '../extension/lang.mjs';
// table().common, not a second split: lang.mjs owns how a pack's word list is read.
usePack(PACK);
const COMMON_WORDS = table().common;

const isCommon = w => COMMON_WORDS.has(w);

for (const w of ['home', 'street', 'house', 'room', 'night', 'king', 'door', 'blood', 'fire'])
    assert(isCommon(w), `${w} should flag`);

for (const w of ['magic', 'spirit', 'soul', 'queen'])
    assert(isCommon(w), `${w} should flag`);

for (const w of ['aria', 'castle', 'dragon'])
    assert(!isCommon(w), `${w} should never flag`);

console.log('keyword-common-check: ok');
