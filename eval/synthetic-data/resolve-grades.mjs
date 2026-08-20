// resolve-grades.mjs — recomputes each row's `llmGrade` from its `llmGrades` history.
//
// THE VALUE IN FORCE IS A FUNCTION OF THE HISTORY, NOT OF WRITE ORDER. merge appends a pass and sets
// `llmGrade` to what that pass said, which makes the newest judge win every disagreement by default.
// That is only defensible when a later pass is known to be better, and it is not: re-grading the same
// rows with the same model under a corrected rubric moved ~30% of the relevant set OUT and a smaller
// number in, in both books measured — the same magnitude as the contract's own non-reproduction rate
// (CLAUDE.md, graded scenes). Latest-wins silently resolves judge noise in favour of whichever pass
// ran last.
//
// MEDIAN once three or more verdicts exist. Two judges who disagree cannot be resolved by any rule
// over themselves, so those rows keep the latest value and are reported; the fix for them is a third
// pass (`grade-pending.mjs build --rows` over the disagreements, then re-run this). At three the
// median is the majority on the >= 3 line whenever a majority exists, stays on the 0-4 scale, and
// needs no tie policy for an odd count.
//
// A HUMAN's `grade` is never read or written here. It is a separate column and outranks all of this
// at read time (metrics.mjs `gradeValue`).
//
// Usage (any cwd):
//   node eval/synthetic-data/resolve-grades.mjs [--data <dir>] [--write]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolvePath(process.argv.includes('--data')
    ? process.argv[process.argv.indexOf('--data') + 1]
    : resolvePath(HERE, '..', 'eval-data'));
const WRITE = process.argv.includes('--write');

/** Median of an odd or even count; even falls back to the LOWER middle rather than averaging, so the
 *  result is always a grade that a judge actually gave rather than a 2.5 the scale has no anchor for. */
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)];

let bundles = 0, rows = 0, changed = 0, unresolved = 0, crossed = 0;
const moves = {};
for (const f of readdirSync(DATA).sort()) {
    if (!f.endsWith('.json')) continue;
    let b;
    try { b = JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8')); } catch { continue; }
    if (!Array.isArray(b.grades)) continue;
    let dirty = false;
    for (const r of b.grades) {
        const h = r.llmGrades;
        if (!Array.isArray(h) || h.length < 2) continue;
        rows++;
        const vals = h.map(x => Number(x.llmGrade)).filter(Number.isFinite);
        if (vals.length < 2) continue;
        // Two disagreeing verdicts have no majority; leave the row alone and count it.
        if (vals.length === 2 && vals[0] !== vals[1]) { unresolved++; continue; }
        const was = Number(r.llmGrade);
        const now = median(vals);
        // CROSSINGS ARE COUNTED AGAINST THE LAST NON-TIEBREAK PASS, not against `llmGrade`. merge sets
        // `llmGrade` to whatever it appended last, so after a tiebreak lands that scalar is the
        // tiebreak's own vote — comparing the median to it answers nothing. What a reader needs to know
        // is how the resolved label differs from the one the arm runs were scored on, which is the last
        // ordinary pass.
        const ordinary = h.filter(x => !String(x.by ?? '').includes('#'));
        const scoredOn = Number((ordinary[ordinary.length - 1] ?? h[h.length - 1]).llmGrade);
        if ((scoredOn >= 3) !== (now >= 3)) crossed++;
        if (now === was) continue;
        moves[`${was}->${now}`] = (moves[`${was}->${now}`] ?? 0) + 1;
        r.llmGrade = now;
        // `by` named the pass whose value was in force. A median is not any one pass's verdict, so it
        // names the rule instead — a reader that trusted `by` to identify a rubric must not be handed
        // a hash that did not produce this number.
        r.by = `median/${vals.length}`;
        changed++; dirty = true;
    }
    if (!dirty) continue;
    bundles++;
    if (WRITE) writeFileSync(`${DATA}/${f}`, JSON.stringify(b, null, 1));
}
console.log(`${rows} rows with 2+ judge verdicts across ${readdirSync(DATA).filter(f => f.endsWith('.json')).length} files`);
console.log(`  ${changed} rows re-resolved to the median (${crossed} rows land on a different side of the >= 3 line than the last ordinary pass) in ${bundles} bundles`);
console.log(`  ${unresolved} rows have exactly two DISAGREEING verdicts and cannot be resolved — they need a third pass`);
if (Object.keys(moves).length) console.log('  moves ' + Object.entries(moves).sort().map(([k, n]) => `${k}:${n}`).join('  '));
if (!WRITE && changed) console.log('dry run — re-run with --write');
