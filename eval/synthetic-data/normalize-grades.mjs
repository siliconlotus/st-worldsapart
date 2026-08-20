// normalize-grades.mjs — brings every bundle's judge verdicts to the current shape: one element in
// `llmGrades` per pass, each naming the pass that produced it.
//
// Two legacy shapes, both from before the history existed:
//
//   1. A row with `llmGrade` and no `llmGrades` at all — the verdict with no record of who gave it.
//   2. An element shaped `{llmGrade}` alone — in the array, but unattributed.
//
// ATTRIBUTION IS RECOVERED, NEVER INVENTED. A pass label that is wrong is worse than one that is absent:
// absent reads as unknown, wrong reads as evidence. Where the sources disagree or say nothing, `by` is
// left off and the row is reported.
//
// `grading.by` IS THE LAST PASS, NOT THE PASS THAT GRADED A GIVEN ROW. It is only usable when the bundle
// has no other attributed pass to contradict it — the bundles holding the unattributed elements carry
// `...#tiebreak` there, which is certainly not who graded them. `grading.notes` names the model in prose
// ("Graded by claude-fable-5") and is the only record for those, so it is read last and only when
// nothing structural is available.
//
// `llmGrade` is left exactly as it was. What the value in force should be is a separate question from
// what the record says, and this only fixes the record.
//
// Usage (any cwd):
//   node eval/synthetic-data/normalize-grades.mjs             # report what would change
//   node eval/synthetic-data/normalize-grades.mjs --write
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The model named in a bundle's prose notes, as the pass label that provenance used. */
export const passFromNotes = (grading) => {
    const m = /[Gg]raded by ([\w.-]+)/.exec(String(grading?.notes ?? ''));
    return m ? `wa-super-grade-synthetic/${m[1]}` : null;
};

/**
 * The pass label to attribute an unrecorded verdict to, or null when nothing can say.
 *
 * @param {object} bundle the bundle the row lives in
 * @param {object} row the grade row
 * @param {boolean} structural whether the row's and bundle's own `by` may be consulted — false for an
 *   element known to predate the field, since both labels then describe a later pass
 */
export function attributionOf(bundle, row, structural = true) {
    const grading = bundle?.grading ?? {};
    // `row.by` is the LAST pass to touch the row, exactly as `grading.by` is for the bundle. It is only
    // the row's own author when the row records a single verdict — which is what a scalar row is, and
    // what a bare element is not: the element predates `by`, so a row carrying one was written by a
    // later pass than the element.
    if (structural && row?.by) return row.by;
    if (structural && grading.by) {
        // Only when no attributed element in this bundle disagrees: a bundle several passes have touched
        // cannot say which of them produced a row that recorded nothing.
        const seen = new Set((bundle.grades ?? [])
            .flatMap(r => r?.llmGrades ?? [])
            .map(x => x?.by)
            .filter(Boolean));
        if (seen.size === 0 || (seen.size === 1 && seen.has(grading.by))) return grading.by;
        return null;
    }
    return passFromNotes(grading);
}

/**
 * One bundle normalised in place.
 *
 * @returns {{lifted: number, attributed: number, unattributed: number}} rows given a history, elements
 *   given a pass, and cases where nothing could be recovered.
 */
export function normalizeBundle(bundle) {
    let lifted = 0, attributed = 0, unattributed = 0;
    const at = bundle?.grading?.at;
    for (const row of (bundle?.grades ?? [])) {
        if (!row || typeof row !== 'object') continue;
        if (row.llmGrade !== undefined && !Array.isArray(row.llmGrades)) {
            const by = attributionOf(bundle, row, true);
            if (!by) unattributed++;
            row.llmGrades = [{
                llmGrade: row.llmGrade,
                ...(by ? { by } : {}),
                ...(row.at ?? at ? { at: row.at ?? at } : {}),
                ...(row.why ? { why: row.why } : {}),
            }];
            lifted++;
            continue;
        }
        // ONLY A HISTORY WITH SIBLINGS. Every legacy unattributed element sits beside an attributed one
        // (measured: 1277 of them, all in histories of two or three) because it is the original pass and
        // something later appended to it. A LONE element with no `by` is instead a scalar row this
        // migration just lifted and could not attribute — reading the notes for it would quietly grant
        // on a re-run exactly what the first run refused, and a re-run must not decide more than the
        // first did.
        for (const el of (row.llmGrades ?? [])) {
            if (!el || el.by || row.llmGrades.length < 2) continue;
            // An element with no `by` predates the field, so the bundle's own label is a later pass and
            // must not be borrowed — only the notes describe the pass that wrote it.
            const by = attributionOf(bundle, row, false);
            if (!by) { unattributed++; continue; }
            el.by = by;
            if (at && el.at === undefined) el.at = at;
            attributed++;
        }
    }
    return { lifted, attributed, unattributed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const argv = process.argv.slice(2);
    const WRITE = argv.includes('--write');
    const i = argv.indexOf('--data');
    const DATA = resolvePath(i >= 0 ? argv[i + 1] : resolvePath(HERE, '..', 'eval-data'));

    let files = 0, lifted = 0, attributed = 0, unattributed = 0;
    const byPass = new Map();
    for (const f of readdirSync(DATA).sort()) {
        if (!f.endsWith('.json')) continue;
        let b;
        try { b = JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8')); } catch { continue; }
        if (!b || typeof b !== 'object' || Array.isArray(b) || !Array.isArray(b.grades)) continue;
        const r = normalizeBundle(b);
        if (!r.lifted && !r.attributed) continue;
        for (const row of b.grades) for (const el of (row?.llmGrades ?? [])) {
            if (el?.by) byPass.set(el.by, (byPass.get(el.by) ?? 0) + 1);
        }
        files++; lifted += r.lifted; attributed += r.attributed; unattributed += r.unattributed;
        console.log(`${String(r.lifted).padStart(4)} lifted  ${String(r.attributed).padStart(4)} attributed${r.unattributed ? `  ${r.unattributed} UNATTRIBUTED` : ''}  ${f}`);
        if (WRITE) writeFileSync(`${DATA}/${f}`, JSON.stringify(b, null, 1));
    }
    console.log(`\n${files} bundles: ${lifted} rows given a history, ${attributed} elements given a pass${unattributed ? `, ${unattributed} left unattributed` : ''}`);
    console.log('passes now on record:');
    for (const [p, n] of [...byPass].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${p}`);
    if (!WRITE) console.log('\ndry run — re-run with --write');
}
