// rederive-check.mjs — pins the two parts of rederive-syn.mjs that fail SILENTLY.
//
// Its scoring is composed from scene.mjs, which other checks already exercise. What is unique here, and
// unguarded anywhere else, is bookkeeping that produces a plausible-looking bundle when it is wrong:
//
//   the ARM TABLE   written in harness vocabulary because worldsapart.js POOL_ARMS cannot be imported under
//                   node. A drifted entry re-derives a differently-configured arm under the right label.
//   --books-from    supplies the book while the scene stays the bundle's own. Pointed at the wrong-book
//                   control it would rebuild fourteen scenes against a book chosen to be wrong.
//
// Run bare: prints ok/FAIL, exits non-zero on failure.
import { readFileSync } from 'node:fs';
import { eq } from './metrics.mjs';

const SRC = readFileSync(new URL('./rederive-syn.mjs', import.meta.url), 'utf8');
const WA = readFileSync(new URL('../worldsapart.js', import.meta.url), 'utf8');

// --- the arm table, against the one worldsapart.js actually pools with ---------------------------------
// worldsapart.js imports ST, so its POOL_ARMS is read as text. Names only: the VALUES are in two different
// vocabularies on purpose (settings vs harness), which is exactly why the mirror needs pinning.
const namesIn = src => {
    const body = src.match(/POOL_ARMS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
    return [...body.matchAll(/^\s{4}'?([a-zA-Z-]+)'?:/gm)].map(m => m[1]).sort();
};
const live = namesIn(WA);
const mine = namesIn(SRC);
eq(live.length > 0, true, 'POOL_ARMS was found in worldsapart.js');
eq(mine.join(','), live.join(','), 'the re-derivation mirrors worldsapart.js POOL_ARMS exactly');

// The two derived values a name-only mirror would miss. captureParams sets commonWordWeight from
// retrievalMode rather than from a setting, so an arm declared by retrievalMode alone scores it at 1.
eq(/'?lexical'?:\s*\{[^}]*commonWordWeight:\s*0\.7/.test(SRC), true, "the lexical arm carries commonWordWeight 0.7, as captureParams derives it");
eq(/'?vector'?:\s*\{[^}]*commonWordWeight:\s*1\b/.test(SRC), true, '...and the vector arm carries 1');
// scoreThreshold is the settings name; the harness parameter is `threshold`.
eq(/'loose-thr':\s*\{\s*threshold:\s*0\s*\}/.test(SRC), true, "loose-thr sets `threshold`, the harness spelling of scoreThreshold");

// --- the guards --------------------------------------------------------------------------------------
// A flag's value is not an input file: --books-from takes a .json, and the naive filter fed the dump back
// in as a bundle to re-derive.
eq(/VALUE_FLAGS\s*=\s*new Set\(\[[^\]]*'--books-from'/.test(SRC), true, '--books-from is excluded from the input file list');
eq(/!VALUE_FLAGS\.has\(argv\[i - 1\]\)/.test(SRC), true, '...by skipping any argument that follows a value-taking flag');

// The wrong-book refusal, and that it is on primaryBook rather than chat — the Foxbridge dump is a
// DIFFERENT chat from the foxjack scenes and must still be usable, while the null-book control shares the
// Time Whore chat and must not be.
eq(/want !== have && !FORCE/.test(SRC), true, 'a --books-from with a different primaryBook is refused');
eq(/--force to override/.test(SRC), true, '...with an override documented in the message');
eq(/\.chat\b[^\n]*!==/.test(SRC), false, 'the refusal is NOT on chat: a fresh dump of another chat is a legitimate book source');

// The scene must never come from the dump. If any of these were taken from it, the grades would be
// describing a turn the bundle no longer represents.
const scenePatch = SRC.match(/scene0 = \{\s*\.\.\.scene0,([\s\S]*?)\};/)?.[1] ?? '';
eq(scenePatch.length > 0, true, 'the --books-from patch was found');
for (const field of ['query', 'scanText', 'depth', 'chat', 'grades']) {
    eq(new RegExp(`\\b${field}\\s*:`).test(scenePatch), false, `--books-from does not overwrite ${field} — the scene stays the bundle's`);
}
for (const field of ['books', 'primaryBook', 'index']) {
    eq(new RegExp(`\\b${field}\\s*:`).test(scenePatch), true, `--books-from does supply ${field}`);
}

// `eq` sets process.exitCode rather than throwing, so a bare "ok" here would print over its own failures.

// --- provenance ---------------------------------------------------------------------------------------
// The written bundle must say where each half came from. It carries the bundle's scene and the dump's book
// AND parameters, and a stamp claiming the books were "carried verbatim" was true only before --books-from.
eq(/booksFrom:\s*BOOKS_FROM/.test(SRC), true, 'the written bundle records which dump supplied the book');
eq(/paramsFrom:\s*BOOKS_FROM/.test(SRC), true, '...and that the baseline parameters came from it too');
eq(/carried verbatim/.test(SRC.split('rederivedWhy')[1] ?? ''), false, 'no "carried verbatim" claim survives in the stamp when a dump is used');
eq(/NOT re-randomised/.test(SRC), true, 'the stamp still says the scene was not re-randomised');

console.log(process.exitCode ? 'FAILED' : 'ok');
