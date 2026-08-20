// judge-agree.mjs — compares two judges' answers to the SAME grade jobs, row by row.
//
// Both sides are `-graded.json` result directories, so the comparison never touches an eval-data bundle.
// That is deliberate: `grade-pending.mjs merge` makes the last pass merged the value IN FORCE, so merging
// a trial judge to compare it would quietly hand every downstream eval that judge's grades. A judge is
// audited from its raw answers and merged only once it is the judge you want.
//
// Rows join on job id plus world/uid, so only jobs both sides answered are counted; a job one side failed
// is reported as unmatched rather than dropped silently.
//
// What to read, in order of what it decides:
//   - the >= 3 BAND. Every selection criterion in this project is defined on that line (CLAUDE.md,
//     "Four stages"), so agreement there is the number that matters and overall accuracy is not.
//   - MEAN GRADE and the per-scene harsher/lenient split, which is where a judge drifts first: the
//     measured failure of the last pass was leniency, not rank order.
//   - exact / within-1 agreement and QWK, read against the reference line printed at the end. The
//     contract does not reproduce EVENLY — 87.7% exact against itself overall, but 79% at the head of a
//     pool — so a candidate at 80% is not obviously worse than the incumbent, it is inside its noise.
//
// Usage (any cwd):
//   node eval/judge-agree.mjs <refDir> <candDir> [--labels sonnet,gemma]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { qwk } from './metrics.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dirs = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--labels');

if (dirs.length !== 2) {
    console.error('usage: node eval/judge-agree.mjs <refDir> <candDir> [--labels ref,cand]');
    process.exit(2);
}
const [REF, CAND] = dirs.map(d => resolvePath(d));
const [LA, LB] = arg('--labels', 'ref,cand').split(',');

const load = dir => {
    const out = new Map();
    for (const f of readdirSync(dir).filter(x => x.endsWith('-graded.json'))) {
        const id = f.replace(/-graded\.json$/, '');
        let j; try { j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
        for (const g of j.grades ?? []) out.set(`${id}|${g.world}|${g.uid}`, Number(g.grade));
    }
    return out;
};
if (!existsSync(REF) || !existsSync(CAND)) { console.error('missing directory'); process.exit(2); }
const a = load(REF), b = load(CAND);

const keys = [...b.keys()].filter(k => a.has(k));
if (!keys.length) { console.error('no rows in common'); process.exit(1); }
const onlyB = b.size - keys.length;
const scenes = new Set(keys.map(k => k.split('|')[0].replace(/-[br]\d+(-p\d+)?$/, '')));
const jobs = new Set(keys.map(k => k.split('|')[0]));

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const av = keys.map(k => a.get(k)), bv = keys.map(k => b.get(k));

const N = 5;
const O = Array.from({ length: N }, () => new Array(N).fill(0));
for (let i = 0; i < keys.length; i++) O[av[i]][bv[i]]++;
const ra = new Array(N).fill(0), rb = new Array(N).fill(0);
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { ra[i] += O[i][j]; rb[j] += O[i][j]; }
const kappa = qwk(av.map((v, i) => [v, bv[i]]), N);

const exact = keys.filter((k, i) => av[i] === bv[i]).length;
const within1 = keys.filter((k, i) => Math.abs(av[i] - bv[i]) <= 1).length;
const pct = n => `${(100 * n / keys.length).toFixed(1)}%`;

// The >= 3 band, with the reference judge as the standard — not because it is right, but because it is
// the judge whose grades the shipped scores are computed from.
const relA = keys.filter((k, i) => av[i] >= 3), relB = keys.filter((k, i) => bv[i] >= 3);
const both = relB.filter(k => a.get(k) >= 3).length;
const f1 = (2 * both) / (relA.length + relB.length || 1);

console.log(`${keys.length} rows  ${jobs.size} jobs  ${scenes.size} scenes${onlyB ? `  (${onlyB} ${LB} rows unmatched)` : ''}`);
console.log(`\nmean grade   ${LA} ${mean(av).toFixed(2)}   ${LB} ${mean(bv).toFixed(2)}   (${LB} ${mean(bv) > mean(av) ? 'more lenient' : 'harsher'} by ${Math.abs(mean(bv) - mean(av)).toFixed(2)})`);
console.log(`distribution ${LA} [${ra.join(' ')}]   ${LB} [${rb.join(' ')}]`);
console.log(`\nexact ${pct(exact)}   within-1 ${pct(within1)}   QWK ${kappa.toFixed(3)}`);

console.log(`\n>= 3 band (what every selection criterion is defined on)`);
console.log(`  ${LA} calls ${relA.length} relevant, ${LB} calls ${relB.length}, ${both} agreed`);
console.log(`  ${LB} vs ${LA}:  recall ${(both / (relA.length || 1)).toFixed(2)}  precision ${(both / (relB.length || 1)).toFixed(2)}  F1 ${f1.toFixed(2)}`);

console.log(`\nconfusion (rows ${LA}, cols ${LB})`);
console.log('     ' + [0, 1, 2, 3, 4].map(j => String(j).padStart(6)).join(''));
for (let i = 0; i < N; i++) console.log(`  ${i}  ` + O[i].map(v => String(v).padStart(6)).join(''));

// Per-scene direction. n is small and the scenes are not independent draws, so this is a description of
// where the disagreement sits, not a test.
const perScene = new Map();
for (let i = 0; i < keys.length; i++) {
    const s = keys[i].split('|')[0].replace(/-[br]\d+(-p\d+)?$/, '');
    if (!perScene.has(s)) perScene.set(s, []);
    perScene.get(s).push(bv[i] - av[i]);
}
const deltas = [...perScene].map(([s, d]) => [s, mean(d)]).sort((x, y) => y[1] - x[1]);
const up = deltas.filter(d => d[1] > 0).length, down = deltas.filter(d => d[1] < 0).length;
console.log(`\nper scene: ${LB} more lenient on ${up}, harsher on ${down}, level on ${deltas.length - up - down}`);
for (const [s, d] of [...deltas.slice(0, 3), ...deltas.slice(-3)].filter((v, i, arr) => arr.indexOf(v) === i)) {
    console.log(`  ${d >= 0 ? '+' : ''}${d.toFixed(2)}  ${s}`);
}

// The only scale on which the agreement numbers mean anything: the contract re-graded against ITSELF.
console.log(`\nreference: the contract vs itself is 87.7% exact / 98.3% within-1 overall, but 79% at the`);
console.log(`head of a pool, and 4 of 13 rows originally >= 3 came back below it (CLAUDE.md, "Graded scenes").`);
