// Delivered-set F over the arms of a graded capture bundle.
//
// An arm's delivered set is `!cut`, which is how every v3 capture records what reached the prompt. Nothing
// here is specific to a WA-against-core capture — that is two arms whose `params` differ, and the selector
// one of them used is a field in there like any other.
//
// The bars are stage 4's: recall counts grade >= 3, precision credits a 3 or 4 in full and a 2 at half
// (metrics.mjs gradeCredit), F at RECALL_WEIGHT. No window is imposed — choosing the set is what is being
// scored, so a fixed k would hand every arm the count that is half of what they disagree about.
//
// Not param-screen or graded-scene-grid: both re-derive a ranking offline from the frozen query, which is
// what lets them sweep parameters. An arm whose selector is ST core cannot be re-derived — inclusion
// groups, probability rolls, timed effects and its own budget walk are only what checkWorldInfo did on the
// turn — so for that arm the capture is the measurement, and this reads it rather than redoing it.
//
// Tokens sit beside F and are never folded into it. A cheaper set that scores the same is better, and no
// F-beta says so.
//
// Usage (any cwd):
//   node eval/versus-score.mjs <graded-bundle.json> [more.json ...]
import { readFileSync } from 'node:fs';
import { gradeCredit, fbeta, RECALL_WEIGHT, signTest } from './metrics.mjs';

const files = process.argv.slice(2).filter(a => a.endsWith('.json'));
if (!files.length) {
    console.error('usage: node eval/versus-score.mjs <graded-versus.json> [more.json ...]');
    process.exit(2);
}

const US = "\u001f";

/** The verdict in force. A versus capture is graded in one pass, so the last one is it; a re-grade appends
 *  beside the one it disagrees with rather than replacing it (bundle-schema.md, Verdict elements). */
const gradeOf = row => {
    const gs = row?.grades ?? [];
    return gs.length ? Number(gs[gs.length - 1].grade) : null;
};

const scoreArm = rows => {
    const graded = rows.filter(r => Number.isFinite(r.grade));
    const p = graded.length ? graded.reduce((s, r) => s + gradeCredit(r.grade), 0) / graded.length : 0;
    return { n: rows.length, ungraded: rows.length - graded.length, precision: p, tokens: rows.reduce((s, r) => s + (r.tokens || 0), 0) };
};

const per = [];
for (const file of files) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc.reviewed) {
        console.error(`${file} is a review export, which carries verdicts and no arms. Apply it first: node eval/synthetic-data/apply-review.mjs --write`);
        continue;
    }
    if (!Array.isArray(doc.scenes) || !(doc.arms ?? []).length) { console.error(`${file}: not a v3 capture bundle`); continue; }
    for (const scene of doc.scenes) {
        // Verdicts live on the scene and delivered sets on the arms, which is what lets every arm be judged
        // against the same grades.
        const grades = new Map((scene.entries ?? []).map(e => [`${e.book}${US}${e.uid}`, gradeOf(e)]));
        if (!grades.size) { console.error(`${file}: scene "${scene.id ?? '?'}" is ungraded — skipped`); continue; }
        const rel = new Set([...grades].filter(([, g]) => g >= 3).map(([k]) => k));
        const row = [];
        for (const arm of doc.arms) {
            const cell = arm.scenes?.[scene.id];
            if (!cell) continue;   // arms need not be rectangular over scenes
            const delivered = (cell.candidates ?? []).filter(c => !c.cut).map(c => ({ ...c, grade: grades.get(`${c.book}${US}${c.uid}`) }));
            if (!delivered.length) continue;
            const s = scoreArm(delivered);
            const recall = rel.size ? delivered.filter(r => r.grade >= 3).length / rel.size : 0;
            row.push({ arm: arm.name, ...s, recall, f2: fbeta(s.precision, recall, RECALL_WEIGHT), selector: arm.params?.selector ?? 'wa' });
        }
        if (row.length) per.push({ name: scene.id ?? doc.name ?? file, rel: rel.size, arms: row });
    }
}

if (!per.length) { console.error('nothing scored'); process.exit(1); }

for (const scene of per) {
    console.log(`\n${scene.name}  (${scene.rel} relevant)`);
    for (const a of scene.arms) {
        console.log(`  ${a.arm.padEnd(14)} n ${String(a.n).padStart(3)}  ${String(a.tokens).padStart(6)} tok  P ${a.precision.toFixed(3)}  R ${a.recall.toFixed(3)}  F2 ${a.f2.toFixed(3)}`
            + (a.ungraded ? `   !! ${a.ungraded} ungraded, scored as 0` : ''));
    }
}

// Paired, for the reason param-screen is: between-scene variance swamps between-arm variance, so each
// scene has to be its own control or four scenes say nothing.
// Paired against the first arm in the file, which is the one the bundle writer put first — no name is
// privileged, because an arm is only ever "the baseline" by the writer's ordering.
const baseName = per[0].arms[0].arm;
const names = [...new Set(per.flatMap(s => s.arms.map(a => a.arm)))].filter(n => n !== baseName);
console.log(`\n${per.length} scene(s), paired against arm "${baseName}"`);
for (const other of names) {
    const d = per.map(s => {
        const w = s.arms.find(a => a.arm === baseName), o = s.arms.find(a => a.arm === other);
        return w && o ? w.f2 - o.f2 : null;
    }).filter(x => x != null);
    if (!d.length) continue;
    const t = signTest(d);
    console.log(`  ${baseName} - ${other}: mean dF2 ${(t.mean >= 0 ? '+' : '') + t.mean.toFixed(4)}   ${t.plus}/${t.minus}/${t.ties} up/down/tie   sign p ${t.p.toFixed(3)}`);
    console.log(`    per scene: ${d.map(x => (x >= 0 ? '+' : '') + x.toFixed(3)).join('  ')}`);
}
if (per.length < 6) console.log(`  n=${per.length}: the best two-sided p reachable is ${(1 / 2 ** (per.length - 1)).toFixed(3)}. Read the direction and the mean.`);
