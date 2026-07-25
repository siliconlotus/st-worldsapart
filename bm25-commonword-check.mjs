// Verifies the background-frequency prior on the plugin's BM25 (commonWordWeight).
// Slices bm25Scores + tokenize out of the plugin (index.js loads as a server module with
// ST-internal imports; slicing keeps this check dependency-free) and injects a stub COMMON_WORDS.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../../../../plugins/worlds-apart/index.js', import.meta.url), 'utf8');
const slice = name => { const i = src.indexOf(`function ${name}`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const COMMON_WORDS = new Set(['said', 'walk']);   // "said" common, "kidnap" not
const bm25Scores = new Function('COMMON_WORDS', 'DEFAULT_K1', 'DEFAULT_B',
    `${slice('tokenize')}\n${slice('bm25Scores')}\n; return bm25Scores;`)(COMMON_WORDS, 1.2, 0.75);

const eq = (got, want, label) => console.log(`${Math.abs(got - want) < 1e-9 ? 'ok  ' : 'FAIL'} ${label}: ${got}${Math.abs(got - want) < 1e-9 ? '' : ` (want ${want})`}`);

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
