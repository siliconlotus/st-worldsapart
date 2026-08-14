// split-rater.mjs — one-shot migration: drop `grade` from rows where it merely duplicates `llmGrade`.
//
// `grade` is a human's verdict and `llmGrade` is a judge's. They used to be written together at the same
// value when a judge graded a row, which made a row no human had seen identical in shape to one a human
// reviewed and agreed with. Since the contract agrees with itself 87.7% of the time, most human reviews
// WOULD agree, so the collision arrives silently on first use of the review flow and cannot be undone
// afterwards — nothing else in a bundle records who graded a row.
//
// Safe to run because the corpus is provably unreviewed: every row carrying both fields has them EQUAL,
// n=8394, zero differing. A differing pair would mean a human had revised a judge's grade, and this
// refuses to touch those. Reversible in principle (grade = llmGrade restores the old shape), and there
// is nothing to reconstruct: the value is unchanged, only the attribution.
//
// Usage (any cwd):
//   node eval/synthetic-data/split-rater.mjs [--data <dir>] [--write]
//
// Dry by default, like migrate-bundle and grade-pending merge. Prints per-file counts and a refusal
// list; --write rewrites in place.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const WRITE = argv.includes('--write');
const DATA = resolvePath(arg('--data', resolvePath(HERE, '..', 'eval-data')));

let files = 0, touched = 0, dropped = 0, humanKept = 0, alreadyClean = 0;
const refused = [];

for (const f of readdirSync(DATA).filter(x => x.endsWith('.json')).sort()) {
    let m;
    try { m = JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8')); } catch { continue; }
    // Shape decides, as migrate-bundle has it: eval-data holds spend caches and prompt sets beside the
    // samples, and none of those has a grades array.
    if (!Array.isArray(m.grades)) continue;
    files++;

    let n = 0;
    const differing = [];
    for (const g of m.grades) {
        if (g.llmGrade === undefined) { if (g.grade !== undefined) humanKept++; continue; }
        if (g.grade === undefined) { alreadyClean++; continue; }
        // A human already revised this judge's grade. The row is genuinely dual-rater and both values
        // are real, so it keeps them — this migration removes duplication, never a verdict.
        if (Number(g.grade) !== Number(g.llmGrade)) { differing.push(g.uid); continue; }
        delete g.grade;
        n++;
    }

    if (differing.length) refused.push([f, differing.length]);
    if (!n) continue;
    dropped += n;
    touched++;
    if (WRITE) writeFileSync(`${DATA}/${f}`, JSON.stringify(m, null, 1));
    console.log(`${WRITE ? 'wrote' : 'would drop'} ${String(n).padStart(5)} duplicate grade(s)  ${f}`);
}

console.log(`\n${files} bundles scanned, ${touched} ${WRITE ? 'rewritten' : 'would change'}`);
console.log(`${dropped} rows: grade dropped, llmGrade kept (judge only, no human has looked)`);
console.log(`${humanKept} rows: grade only, untouched (human only)`);
console.log(`${alreadyClean} rows: llmGrade only, already correct`);
for (const [f, n] of refused) console.log(`  KEPT BOTH ${n} row(s) in ${f} — grade differs from llmGrade, a human revised these`);
if (!WRITE) console.log('\nDry run. Re-run with --write to apply.');
