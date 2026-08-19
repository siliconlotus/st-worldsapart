// pair-f2.mjs — the paired sign test between two relevance-regress runs.
//
// A FEATURE SET CANNOT BE SWEPT IN ONE PROCESS: the design matrix is built once, so `--sweep` contrasts
// parameter values and nothing else. Adding a column therefore means two RUNS, and the contrast between
// them has to be made outside both — which is what `--emit` writes the per-scene F2 vector for.
//
// PAIRED, because a cutoff-curve peak is not a comparison (matcher-design.md, *A cutoff-curve peak is not
// a comparison*). Two arms differ by less than the flatness of their own curves, so the readable number is
// per-scene F2 differences and the sign test over them, each arm at its OWN best cutoff.
//
// THE SCENE SETS ARE CHECKED, NEVER ASSUMED. Pairing by index is only safe if both runs kept the same
// scenes in the same order, and a row floor or a tier filter can silently drop one — which would pair
// scene i of one arm against scene i+1 of the other and report the offset as an effect. `--emit` carries
// the names for exactly this test, and a mismatch exits non-zero rather than printing a number.
//
// Usage (any cwd):
//   node eval/pair-f2.mjs <baseline.json> <arm.json>
import fs from 'node:fs';
import { signTest } from './metrics.mjs';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
    console.error('usage: node eval/pair-f2.mjs <baseline-emit.json> <arm-emit.json>');
    process.exit(2);
}
const [A, B] = [a, b].map(p => JSON.parse(fs.readFileSync(p, 'utf8')));

if (A.scenes.length !== B.scenes.length || A.scenes.some((s, i) => s !== B.scenes[i])) {
    console.error(`scene sets differ (${A.scenes.length} vs ${B.scenes.length}) — pairing by index would compare different scenes`);
    process.exit(2);
}
// A contrast between two tiers, two cuts or two swept values is not a feature contrast, and pairing them
// silently would attribute the difference to whichever column changed name.
for (const k of ['tier', 'swept', 'value']) {
    if (String(A[k]) !== String(B[k])) {
        console.error(`${k} differs (${A[k]} vs ${B[k]}) — these runs are not the same experiment`);
        process.exit(2);
    }
}

const d = B.perScene.map((f, i) => f - A.perScene[i]);
const st = signTest(d);
const label = x => (x.with?.length ? x.with.join('+') : 'three signals');
console.log(`${label(B)} against ${label(A)}, ${A.scenes.length} scenes paired, ${A.tier} tier`);
console.log(`  F2 ${A.f2.toFixed(4)} -> ${B.f2.toFixed(4)}  (cutoff ${A.cut.toFixed(2)} -> ${B.cut.toFixed(2)})`);
console.log(`  mean per-scene ${(st.mean >= 0 ? '+' : '') + st.mean.toFixed(4)}   ${st.plus} up / ${st.minus} down / ${st.ties} tied   sign test p ${st.p.toFixed(4)}`);
