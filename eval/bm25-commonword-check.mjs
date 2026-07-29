// Verifies the background-frequency prior on the plugin's BM25 (commonWordWeight).
// bm25Scores lives in the pure, shared lexical.mjs — imported directly, so this checks the exact
// code the server runs. Uses real COMMON_WORDS: "said" is common, "kidnap" is not.
import { bm25Scores } from '../plugin/lexical.mjs';
import { COMMON_WORDS } from '../plugin/commonwords.js';

const eq = (got, want, label) => console.log(`${Math.abs(got - want) < 1e-9 ? 'ok  ' : 'FAIL'} ${label}: ${got}${Math.abs(got - want) < 1e-9 ? '' : ` (want ${want})`}`);

console.log(`${COMMON_WORDS.has('said') && !COMMON_WORDS.has('kidnap') ? 'ok  ' : 'FAIL'} precondition: "said" common, "kidnap" not`);

// One doc containing both a common word and a rare word, each once.
const lexical = {
    postings: new Map([['said', [[0, 1]]], ['kidnap', [[0, 1]]]]),
    idf: new Map([['said', 2], ['kidnap', 2]]),   // equal IDF, so any gap is purely the prior
    docLen: [2], avgdl: 2,
};
const score = (q, w) => bm25Scores(lexical, q, 1, 1.2, 0.75, null, 0, w)[0];

const rareBase = score('kidnap', 1);
eq(score('kidnap', 0.3), rareBase, 'rare term unaffected by the prior');
eq(score('said', 1), rareBase, 'common term at weight 1 is a no-op (equals rare baseline)');
console.log(`${score('said', 0.3) < rareBase ? 'ok  ' : 'FAIL'} common term down-weighted at 0.3: ${score('said', 0.3)} < ${rareBase}`);
eq(score('said', 0), 0, 'common term dropped at weight 0');
eq(score('said', 0.5) / rareBase, 0.5, 'down-weight scales the IDF linearly (0.5 -> half score)');
