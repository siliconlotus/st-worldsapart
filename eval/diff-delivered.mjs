// diff-delivered.mjs — what two arms actually deliver differently, entry by entry.
//
// F2 says an arm is better; it never says WHICH entries changed hands, and a set-based score can improve
// while dropping something a reader would have wanted. This prints the two cuts against each other: the
// rows one arm delivers and the other does not, split by grade, with each arm's score on the row and the
// per-column values behind it.
//
// THE RELEVANT DROPS ARE THE POINT. An arm that trades recall for a smaller set pays in grade >= 3 rows,
// and the paired F2 test cannot show you what they were. Those are listed individually; everything else is
// counted. Reading them is how a trade the metric approves of gets vetoed on grounds the metric has no
// access to — a scene's only entry about its subject is not interchangeable with a 0.
//
// EACH ARM AT ITS OWN BEST CUTOFF, as --cutoff reports them, so this is a diff of what SHIPS and not of two
// rankings at one threshold.
//
// Usage (any cwd):
//   node eval/diff-delivered.mjs <baseline-rows.json> <arm-rows.json> [--limit 40] [--scene <substr>] [--scene-chars 700]
import fs from 'node:fs';
import { arg } from './metrics.mjs';

const argv = process.argv.slice(2);
const files = argv.filter((a, i) => a.endsWith('.json') && !['--limit', '--scene', '--scene-chars'].includes(argv[i - 1]));
if (files.length !== 2) {
    console.error('usage: node eval/diff-delivered.mjs <baseline-rows.json> <arm-rows.json> [--limit 40] [--scene <substr>] [--scene-chars 700]');
    process.exit(2);
}
const LIMIT = Number(arg(argv, '--limit', 40));
const ONLY = arg(argv, '--scene');
// How much of the scene text to print above its rows. The tail, because that is the current turn.
const QCHARS = Number(arg(argv, '--scene-chars', 700));
const [A, B] = files.map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
const label = x => (x.with?.length ? x.with.join('+') : 'three signals');

const byScene = x => new Map(x.scenes.map(sc => [sc.name, sc]));
const [ma, mb] = [byScene(A), byScene(B)];
const shared = [...ma.keys()].filter(n => mb.has(n) && (!ONLY || n.includes(ONLY)));

// ALWAYS THE ARM'S FEATURE VALUES, never the baseline's: the baseline has no column for what the arm
// added, so showing its row would print the diff without the two numbers that explain it. Scores are
// always printed baseline -> arm regardless of which direction the row moved.
const fmt = d => {
    const f = Object.entries(d.row.feats).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join('  ');
    return `      g${d.row.g}${d.row.ungraded ? '?' : ' '} ${String(d.row.title).slice(0, 50).padEnd(50)} ${d.eBase.toFixed(3)} -> ${d.eArm.toFixed(3)}   ${f}`;
};

let dropped = [], added = [], sameCount = 0, aCount = 0, bCount = 0;
for (const name of shared) {
    const sa = ma.get(name), sb = mb.get(name);
    const ra = new Map(sa.rows.map(r => [r.uid, r])), rb = new Map(sb.rows.map(r => [r.uid, r]));
    aCount += sa.rows.filter(r => r.delivered).length;
    bCount += sb.rows.filter(r => r.delivered).length;
    for (const [uid, r] of ra) {
        const o = rb.get(uid);
        if (!o) continue;
        const d = { name, row: o, eBase: r.e, eArm: o.e };
        if (r.delivered && !o.delivered) dropped.push(d);
        else if (!r.delivered && o.delivered) added.push(d);
        else if (r.delivered) sameCount++;
    }
}

console.log(`${label(B)} against ${label(A)}, ${shared.length} scenes, ${A.tier} tier`);
console.log(`  cutoffs ${A.cut.toFixed(2)} -> ${B.cut.toFixed(2)}   delivered ${(aCount / shared.length).toFixed(1)} -> ${(bCount / shared.length).toFixed(1)} per scene   ${sameCount} rows delivered by both\n`);

// What the arm's columns look like on what it cut versus what it kept — the listing shows individual
// rows, this shows whether the cut has the shape the coefficients predict.
const stat = (rows, k) => { const v = rows.map(d => Number(d.row.feats[k])).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
const keptRows = [];
for (const name of shared) for (const r of mb.get(name).rows) if (r.delivered) keptRows.push({ row: r });
const armOnly = (B.with ?? []).filter(k => !(A.with ?? []).includes(k));
if (armOnly.length) {
    console.log(`the arm's own columns, mean over rows:`);
    console.log(`  ${'column'.padEnd(10)} ${'dropped'.padStart(9)} ${'kept by arm'.padStart(12)} ${'dropped @g>=3'.padStart(14)}`);
    for (const k of armOnly)
        console.log(`  ${k.padEnd(10)} ${stat(dropped, k).toFixed(2).padStart(9)} ${stat(keptRows, k).toFixed(2).padStart(12)} ${stat(dropped.filter(d => d.row.g >= 3), k).toFixed(2).padStart(14)}`);
    console.log();
}

// THE HAYSTACK, which is what makes a drop legible. A relevant row cut from a scene that still delivers
// four others is redundancy; the same row cut from a scene that then has none is the failure the F2 mean
// cannot show you, because one scene's collapse averages away against every scene that improved.
//
// UNGRADED IS ITS OWN COLUMN, never folded into g0. Those rows are scored 0 by the delivery convention
// (scene.mjs) rather than judged 0, so counting them as irrelevant would report the pool's depth as the
// arm's precision.
const compose = (x) => {
    const h = { ungraded: 0 }, per = [];
    for (const sc of x.scenes) {
        if (ONLY && !sc.name.includes(ONLY)) continue;
        const got = sc.rows.filter(r => r.delivered);
        for (const r of got) { if (r.ungraded) h.ungraded++; else h[r.g] = (h[r.g] ?? 0) + 1; }
        per.push({ name: sc.name, relevant: sc.relevant, delivered: got.length, relDelivered: got.filter(r => !r.ungraded && r.g >= 3).length });
    }
    return { h, per };
};
const [ca, cb] = [compose(A), compose(B)];
const histLine = h => Object.keys(h).filter(k => k !== 'ungraded').sort().map(k => `g${k} ${String(h[k]).padStart(5)}`).join('  ') + `   ungraded ${String(h.ungraded).padStart(5)}`;
console.log('the delivered haystack, pooled over scenes:');
console.log(`  baseline  ${histLine(ca.h)}`);
console.log(`  arm       ${histLine(cb.h)}`);

const lost = ca.per.map((p, i) => ({ ...p, armRel: cb.per[i].relDelivered, armDel: cb.per[i].delivered }))
    .filter(p => p.armRel < p.relDelivered);
const starved = lost.filter(p => p.armRel === 0 && p.relDelivered > 0);
console.log(`\n  ${lost.length} of ${ca.per.length} scenes deliver fewer relevant rows under the arm`);
console.log(`  ${starved.length} deliver NONE where the baseline delivered at least one  <-- the harm case`);
if (lost.length) {
    console.log(`\n  worst by relevant rows lost:`);
    console.log(`    ${'scene'.padEnd(32)} ${'relevant'.padStart(8)} ${'rel delivered'.padStart(14)} ${'set size'.padStart(12)}`);
    for (const p of [...lost].sort((x, y) => (y.relDelivered - y.armRel) - (x.relDelivered - x.armRel)).slice(0, 10))
        console.log(`    ${p.name.replace(/--shipped$/, '').slice(0, 32).padEnd(32)} ${String(p.relevant).padStart(8)} ${`${p.relDelivered} -> ${p.armRel}`.padStart(14)} ${`${p.delivered} -> ${p.armDel}`.padStart(12)}`);
}
console.log();

for (const [title, rows] of [['DROPPED (delivered by the baseline, cut by the arm)', dropped], ['ADDED (cut by the baseline, delivered by the arm)', added]]) {
    const byGrade = {};
    for (const d of rows) byGrade[d.row.g] = (byGrade[d.row.g] ?? 0) + 1;
    console.log(`${title}: ${rows.length} rows  ${JSON.stringify(byGrade)}`);
    const relevant = rows.filter(d => d.row.g >= 3).sort((x, y) => y.row.g - x.row.g || y.eBase - x.eBase);
    if (!relevant.length) { console.log('    none at grade >= 3\n'); continue; }
    console.log(`    grade >= 3 (${relevant.length}), score under baseline -> under arm:`);
    // GROUPED BY SCENE, with the scene's own text above its rows. Relevance is a property of the PAIR,
    // so a list of titles is unreadable: the same entry is right in one scene and wrong in the next, and
    // whether a drop was a mistake is a question about what the scene was ABOUT.
    const groups = new Map();
    for (const d of relevant) groups.set(d.name, [...(groups.get(d.name) ?? []), d]);
    let shown = 0;
    for (const [name, ds] of groups) {
        if (shown >= LIMIT) break;
        const q = mb.get(name)?.query ?? '';
        console.log(`\n    ${name.replace(/--shipped$/, '')}   (${mb.get(name)?.relevant ?? '?'} relevant in scene)`);
        if (q) for (const line of String(q).slice(-QCHARS).split(/\n+/).filter(Boolean)) console.log(`      | ${line.slice(0, 150)}`);
        for (const d of ds) { if (shown++ >= LIMIT) break; console.log(fmt(d)); }
    }
    if (relevant.length > shown) console.log(`\n    … ${relevant.length - shown} more (raise --limit)`);
    console.log();
}
