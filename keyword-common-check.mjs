// Guards the English-commonness cut used by the keyword-prune too-common flag: the deliberated words
// must land on the expected side of the sticky (top-1000 head) and keyword/vector (full-list) tiers.
// Run: node keyword-common-check.mjs
import assert from 'node:assert';
import { COMMON_WORDS } from './commonwords.js';

const STICKY_CUT = 1000;                                  // mirror ENGLISH_COMMON_STICKY_CUT
const head = new Set([...COMMON_WORDS].slice(0, STICKY_CUT));
const isCommon = (w, sticky) => (sticky ? head : COMMON_WORDS).has(w);

// Generic even in-setting -> flagged on sticky AND keyword.
for (const w of ['home', 'street', 'house', 'room', 'night', 'king', 'door', 'blood', 'fire'])
    assert(isCommon(w, true) && isCommon(w, false), `${w} should flag on sticky and keyword`);

// Meaningful-but-common -> spared on sticky (reference sheet), flagged on keyword (full list).
for (const w of ['magic', 'spirit', 'soul', 'queen'])
    assert(!isCommon(w, true) && isCommon(w, false), `${w} should spare on sticky, flag on keyword`);

// Names / setting-specific -> spared everywhere (absent from the list).
for (const w of ['aria', 'castle', 'dragon'])
    assert(!isCommon(w, false), `${w} should never flag`);

console.log('keyword-common-check: ok');
