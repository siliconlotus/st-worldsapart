// pair-f2.mjs — the paired sign test between two relevance-regress runs.
//
// A feature set cannot be swept in one process: the design matrix is built once, so `--sweep` contrasts
// parameter values and nothing else. Adding a column means two runs, and the contrast between them has to
// be made outside both — which is what `--emit` writes the per-scene F2 vector for.
//
// Paired, because a cutoff-curve peak is not a comparison (matcher-design.md, *A cutoff-curve peak is not a
// comparison*): two arms differ by less than the flatness of their own curves, so the readable number is
// per-scene F2 differences and the sign test over them, each arm at its own best cutoff.
//
// The scene sets are checked, never assumed. Pairing by index is only safe if both runs kept the same
// scenes in the same order, and a row floor or a tier filter can drop one, pairing scene i of one arm
// against scene i+1 of the other. `--emit` carries the names for this test, and a mismatch exits non-zero.
//
// Usage (any cwd):
//   node eval/pair-f2.mjs <baseline.json> <arm.json> [--at-recall 0.75]
import fs from 'node:fs';
import { signTest } from './metrics.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? null) : null; };
// A flag's value is not a positional, the same trap relevance-regress names: without this, --at-recall's
// number is read as a third file and the pair taken from the wrong two arguments.
const VALUED = new Set(['--at-recall']);
const [a, b] = argv.filter((x, i) => !x.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!a || !b) {
    console.error('usage: node eval/pair-f2.mjs <baseline-emit.json> <arm-emit.json> [--at-recall 0.75]');
    process.exit(2);
}
const [A, B] = [a, b].map(p => JSON.parse(fs.readFileSync(p, 'utf8')));

if (A.scenes.length !== B.scenes.length || A.scenes.some((s, i) => s !== B.scenes[i])) {
    console.error(`scene sets differ (${A.scenes.length} vs ${B.scenes.length}) — pairing by index would compare different scenes`);
    process.exit(2);
}
// Exactly one thing may differ: two runs contrast either a feature set at one parameter value or a
// parameter at one feature set, and if both moved the difference cannot be attributed to either. The tier
// and the swept parameter's name must match in both cases.
for (const k of ['tier', 'swept']) {
    if (String(A[k]) !== String(B[k])) {
        console.error(`${k} differs (${A[k]} vs ${B[k]}) — these runs are not the same experiment`);
        process.exit(2);
    }
}
// `without` is checked alongside `with` because it is the other half of the feature set. It was absent
// from the emit at first, which made this guard blind to the one dimension a keys-column contrast moves —
// a guard that cannot see a change cannot refuse it.
const sameWith = String(A.with ?? []) === String(B.with ?? []) && String(A.without ?? []) === String(B.without ?? []);
const sameValue = String(A.value) === String(B.value);
if (!sameWith && !sameValue) {
    console.error(`both the feature set (${A.with} vs ${B.with}) and ${A.swept} (${A.value} vs ${B.value}) differ — the difference cannot be attributed to either`);
    process.exit(2);
}
if (sameWith && sameValue) console.error(`note: identical feature set and ${A.swept} value — this is a self-comparison`);

const label = x => `${x.with?.length ? x.with.join('+') : 'three signals'}${x.without?.length ? ` -${x.without.join('-')}` : ''}`;
// Matched recall, when asked for. Each arm's own best cutoff is where its curve peaks, so a contrast
// between two peaks mixes "better model" with "different point on the trade" — and F2 moves the peak
// toward precision as a model improves, which is exactly when the two stop being comparable. The grid
// carries every cutoff, so the honest question "at the same recall, which delivers better precision" is
// answerable. Nearest row by recall, and the row's actual recall is printed rather than the target,
// because a 1% grid does not hit every target exactly.
const AT = arg('--at-recall');
if (AT !== null) {
    const want = Number(AT);
    if (!Number.isFinite(want) || want <= 0 || want > 1) { console.error('--at-recall takes a fraction, e.g. 0.75'); process.exit(2); }
    const near = x => (x.grid ?? []).reduce((best, g) => (best === null || Math.abs(g.recall - want) < Math.abs(best.recall - want) ? g : best), null);
    const [ga, gb] = [near(A), near(B)];
    if (!ga || !gb) {
        console.error('one or both runs predate the emitted cutoff grid — re-run to compare at matched recall');
        process.exit(2);
    }
    console.log(`at recall ~${(100 * want).toFixed(0)}%, ${A.tier} tier`);
    for (const [x, g] of [[A, ga], [B, gb]])
        console.log(`  ${label(x).padEnd(34)} cut ${g.cut.toFixed(2)}  recall ${(100 * g.recall).toFixed(1)}%  precision ${(100 * g.precision).toFixed(1)}%  F2 ${g.f2.toFixed(4)}  delivered ${g.delivered.toFixed(1)}`);
    console.log(`  precision delta ${((gb.precision - ga.precision) >= 0 ? '+' : '') + (100 * (gb.precision - ga.precision)).toFixed(1)} points at ${(100 * gb.recall).toFixed(1)}% vs ${(100 * ga.recall).toFixed(1)}% recall\n`);
}

const d = B.perScene.map((f, i) => f - A.perScene[i]);
const st = signTest(d);
console.log(`${label(B)} against ${label(A)}, ${A.scenes.length} scenes paired, ${A.tier} tier`);
console.log(`  F2 ${A.f2.toFixed(4)} -> ${B.f2.toFixed(4)}  (cutoff ${A.cut.toFixed(2)} -> ${B.cut.toFixed(2)})`);
console.log(`  mean per-scene ${(st.mean >= 0 ? '+' : '') + st.mean.toFixed(4)}   ${st.plus} up / ${st.minus} down / ${st.ties} tied   sign test p ${st.p.toFixed(4)}`);
