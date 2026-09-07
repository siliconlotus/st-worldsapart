// Guards the English-commonness cut used by the keyword-prune too-common flag: the deliberated words must
// land on the expected side of the one list. One list, not two — an entry's stickiness does not enter,
// since sticky is about an armed entry persisting and says nothing about whether a key is a good trigger.
// Run: node keyword-common-check.mjs
import assert from 'node:assert';
import { COMMON_WORDS } from '../plugin/commonwords.js';

const isCommon = w => COMMON_WORDS.has(w);

// Generic even in-setting -> flagged.
for (const w of ['home', 'street', 'house', 'room', 'night', 'king', 'door', 'blood', 'fire'])
    assert(isCommon(w), `${w} should flag`);

// Meaningful but still common English -> flagged. These used to be spared on sticky entries.
for (const w of ['magic', 'spirit', 'soul', 'queen'])
    assert(isCommon(w), `${w} should flag`);

// Names / setting-specific -> spared (absent from the list).
for (const w of ['aria', 'castle', 'dragon'])
    assert(!isCommon(w), `${w} should never flag`);

console.log('keyword-common-check: ok');
