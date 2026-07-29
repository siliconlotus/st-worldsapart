// Verifies WA's keyword matcher tracks core's world-info.js matchKeys semantics.
// Pulls countKey out of worldsapart.js by source slice — worldsapart.js only loads in a browser.
import { readFileSync } from 'node:fs';
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const src = readFileSync(new URL('../worldsapart.js', import.meta.url), 'utf8');
const i = src.indexOf('function countKey');
const countKey = new Function('escapeRegex', src.slice(i, src.indexOf('\n}\n', i) + 2) + '; return countKey;')(escapeRegex);
const eq = (got, want, label) => console.log(`${got === want ? 'ok  ' : 'FAIL'} ${label}: ${got}${got === want ? '' : ` (want ${want})`}`);

// keywordScore: sliced with countKey and its globals injected. Guards the scoreVectorKeys path —
// that a caller can score against an explicit key list (waKeys) instead of entry.key.
const ks = src.indexOf('function keywordScore');
const keywordScore = new Function('countKey', 'settings', 'world_info_case_sensitive', 'world_info_match_whole_words',
    src.slice(ks, src.indexOf('\n}\n', ks) + 2) + '; return keywordScore;')(countKey, () => ({ bm25K1: 2 }), false, false);
const scored = (e, t, k) => keywordScore(e, t, k).score > 0;
eq(scored({ key: ['zzz'] }, 'alpha beta', ['alpha']), true, 'keywordScore honors explicit keys over entry.key');
eq(scored({ key: ['alpha'] }, 'alpha beta', ['zzz']), false, 'explicit keys with no hit score zero even when entry.key would match');
eq(scored({ key: ['alpha'] }, 'alpha beta'), true, 'defaults to entry.key when no list passed');
eq(scored({ key: ['alpha'] }, 'alpha beta', []), false, 'empty key list (blanked 🔗, option off) scores zero');

// The regression that started this: core substring-matches when whole-word is off.
eq(countKey('Jubilee', 'the Jubilees arrived', false, false), 1, 'substring: Jubilee inside Jubilees (whole-word off)');
eq(countKey('Jubilee', 'the Jubilees arrived', false, true), 0, 'whole-word on: not inside a larger word');
eq(countKey('Jubilee', 'Jubilee met Jubilee', false, true), 2, 'whole-word counts standalone occurrences');
eq(countKey('cat', 'cat cats scatter', false, false), 3, 'substring counts every occurrence');
eq(countKey('cat', 'cat cats scatter', false, true), 1, 'whole-word counts only the standalone');
eq(countKey('v2', 'the v2 model', false, true), 1, 'single token with a digit, whole-word');
eq(countKey('hot tub', 'in the hot tub', false, true), 1, 'multi-word key falls back to substring');
eq(countKey('Kyle', 'kyle KYLE Kyle', false, false), 3, 'case-insensitive by default');
eq(countKey('Kyle', 'kyle KYLE', true, false), 0, 'case-sensitive when asked');
eq(countKey('/jubi\\w+/i', 'the Jubilees came', false, true), 1, 'regex key with flags overrides options');
eq(countKey('nope', 'nothing here', false, false), 0, 'no match is zero');
