// grade-pending.mjs — turns graft-grades' *-pending rows into judge jobs, and judged jobs back into grades.
//
// Two halves of one pass, deliberately separate processes: `build` writes the job files, a judge grades
// them one file at a time, `merge` puts the answers back. Nothing here calls a model; the dispatch is the
// caller's, so a run that is killed halfway has already written every job it built and merged every result
// that existed.
//
// The job is the contamination boundary. A judge sees the scene text and each entry whole — never the
// candidate's score, rank, matched keys, selected chunks or position in the pool, all of which sit in the
// same bundle a few fields away. Agreeing with the retriever is not a judgement, so the retriever's output
// does not travel.
//
// Its own directory rather than eval/ proper: this GENERATES graded data, it does not measure anything,
// so it is none of the three kinds of file eval/ holds. Inputs and outputs stay up a level (eval-data
// bundles in, grade-jobs out) because that is what consumes them.
//
// Usage (any cwd):
//   node eval/synthetic-data/grade-pending.mjs build [--batch 16] [--jobs <dir>] [--only <name-substring>]
//   node eval/synthetic-data/grade-pending.mjs build --rows <rows.json> [--batch 16] [--jobs <dir>]
//   node eval/synthetic-data/grade-pending.mjs merge --jobs <dir> --results <dir> [--write]
//
// --rows grades an ARBITRARY row list instead of the *-pending pools: a JSON array of
// {bundle, world, uid}, where `bundle` is the bundle's FILENAME in eval-data (the identity rule above).
// The pending flow assumes a job is a scene grading its own pool; a cross-scene audit — re-grading the
// activation misses, an inter-rater pass — is a row list that happens to span scenes, and this groups it
// by bundle and emits one job per scene exactly as the pending path would have. Same job shape, same
// contamination boundary, same merge; a re-grade of already-graded rows is simply never merged, because
// merge skips any row the bundle already carries a grade for.
//
// merge is dry by default and ALWAYS runs the uid diff first: a result whose uid set does not match its
// job is not merged, and its job path is printed for re-dispatch. A judge dropping one row of sixteen is
// silent otherwise — it has happened — and a partial merge would bake the gap into the bundle.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = resolvePath(HERE, '..');
const DATA = resolvePath(EVAL, 'eval-data');
const CONTRACT = resolvePath(EVAL, '..', '.claude', 'agents', 'scene-relevance.md');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const WRITE = argv.includes('--write');

if (cmd !== 'build' && cmd !== 'merge') {
    console.error('usage: node eval/synthetic-data/grade-pending.mjs build [--batch 16] [--jobs <dir>] [--only <substr>]');
    console.error('       node eval/synthetic-data/grade-pending.mjs merge --jobs <dir> --results <dir> [--write]');
    process.exit(2);
}

const JOBS = resolvePath(arg('--jobs', resolvePath(EVAL, 'grade-jobs')));
const US = String.fromCharCode(31);
const rowKey = (world, uid) => [world, uid].join(US);
const shipped = b => (Array.isArray(b.arms) ? (b.arms.find(a => a.arm === 'shipped') ?? b.arms[0]) : b);
/** Books are keyed by array position, which equals uid in some books and not in others. Always map. */
const byUid = book => new Map(Object.values(book ?? {}).map(e => [String(e.uid), e]));

// THE CONTRACT IS STAMPED ON THE JOB, and merge reads it from there rather than re-hashing the file.
// A result records no rubric of its own, so a hash taken at merge time is the rubric in force WHEN THE
// MERGE RAN, not the one the judge was given: re-merging a stale result directory after a rubric
// correction relabelled 395 old-contract job files as if they had been graded under the new one, and
// the appended history said so. The job is written and the judge dispatched in the same breath, so the
// hash at build time is the only one that describes the grading.
const contractHash = existsSync(CONTRACT)
    ? createHash('sha256').update(readFileSync(CONTRACT)).digest('hex').slice(0, 8) : 'unknown';

if (cmd === 'build') {
    const BATCH = Number(arg('--batch', 16));
    const ONLY = arg('--only');
    const ROWS = arg('--rows');
    mkdirSync(JOBS, { recursive: true });

    let files = 0, rows = 0, batches = 0, bytes = 0, dropped = 0;
    // One bundle's worth of rows -> job files. Both input flows end here, so the job shape and the
    // usable-filter cannot drift between them. `tag` keeps --rows jobs from colliding with a pending
    // job for the same bundle if the two ever share a directory.
    const emitJobs = (bundleFile, rowList, tag) => {
        const bundle = JSON.parse(readFileSync(`${DATA}/${bundleFile}`, 'utf8'));
        const arm = shipped(bundle);
        const name = bundle.name ?? bundleFile.replace(/\.json$/, '');
        // IDENTITY IS THE FILENAME, never `name` — two bundles can carry the same name and one pair does
        // (isekai-time-whore-frozen-2-msg3728 and its -null-book variant, the same scene under a different
        // book). Keyed on name, their jobs overwrite each other here and merge writes the survivor's rows
        // into whichever file the name resolves to: measured, one row landed in a bundle whose books do not
        // contain that world. `scene` stays the display label; `bundle` is what merge resolves.
        const base = bundleFile.replace(/\.json$/, '');
        const books = new Map(Object.entries(bundle.books ?? {}).map(([w, bk]) => [w, byUid(bk)]));

        // A row whose entry is gone or empty cannot be graded from the entry text, and a judge handed an
        // empty candidate will grade the title. Dropped and counted rather than passed through.
        const usable = rowList.filter(r => {
            const e = books.get(r.world)?.get(String(r.uid));
            if (e && (e.content ?? '').trim()) return true;
            dropped++; return false;
        });

        for (let i = 0; i < usable.length; i += BATCH) {
            const chunk = usable.slice(i, i + BATCH);
            const id = `${base}-${tag}${String(i / BATCH).padStart(2, '0')}`;
            const job = {
                scene: name,
                bundle: bundleFile,
                contract: contractHash,
                out: `${JOBS}/${id}-graded.json`,
                note: 'Grade every candidate against the scene. Write the JSON your instructions describe to `out`.',
                sceneText: arm.query,
                candidates: chunk.map(r => {
                    const e = books.get(r.world).get(String(r.uid));
                    return { world: r.world, uid: r.uid, title: e.comment || r.title, text: e.content };
                }),
            };
            const path = `${JOBS}/${id}.json`;
            writeFileSync(path, JSON.stringify(job, null, 1));
            batches++; rows += chunk.length; bytes += JSON.stringify(job).length;
        }
        files++;
        console.log(`${name.slice(0, 46).padEnd(46)} ${String(usable.length).padStart(4)}/${String(rowList.length).padStart(4)} rows  ${Math.ceil(usable.length / BATCH)} jobs`);
    };

    if (ROWS) {
        const list = JSON.parse(readFileSync(resolvePath(ROWS), 'utf8'));
        const byBundle = new Map();
        for (const r of list) {
            if (!r.bundle || r.world === undefined || r.uid === undefined) { console.error(`row missing bundle/world/uid: ${JSON.stringify(r)}`); process.exit(2); }
            if (!byBundle.has(r.bundle)) byBundle.set(r.bundle, []);
            byBundle.get(r.bundle).push(r);
        }
        for (const [bf, group] of [...byBundle.entries()].sort()) emitJobs(bf, group, 'r');
    } else {
        for (const f of readdirSync(DATA).filter(x => x.endsWith('-pending.json')).sort()) {
            if (ONLY && !f.includes(ONLY)) continue;
            const pend = JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8'));
            emitJobs(pend.of, pend.rows, 'b');
        }
    }
    console.log(`\n${files} scenes, ${batches} jobs, ${rows} rows, ${dropped} dropped (no entry text)`);
    console.log(`${(bytes / 1024 / 1024).toFixed(1)}MB payload (~${Math.round(bytes / 4000)}k input tokens) in ${JOBS}`);
    process.exit(0);
}

// ---- merge ----
const RESULTS = resolvePath(arg('--results', JOBS));
const MODEL = arg('--model', 'claude-sonnet-5');
const passOf = job => `scene-relevance@${job.contract ?? contractHash}/${MODEL}`;
const STAMP = new Date().toISOString().slice(0, 10);

const jobFiles = readdirSync(JOBS).filter(f => f.endsWith('.json') && !f.endsWith('-graded.json')).sort();
const missing = [], mismatched = [];
const bySceneRows = new Map();

for (const jf of jobFiles) {
    const job = JSON.parse(readFileSync(`${JOBS}/${jf}`, 'utf8'));
    const rf = `${RESULTS}/${jf.replace(/\.json$/, '-graded.json')}`;
    if (!existsSync(rf)) { missing.push(`${JOBS}/${jf}`); continue; }

    let res;
    try { res = JSON.parse(readFileSync(rf, 'utf8')); } catch (e) { mismatched.push([`${JOBS}/${jf}`, `unparseable result: ${e.message}`]); continue; }

    const want = new Set(job.candidates.map(c => rowKey(c.world, c.uid)));
    const got = new Map((res.grades ?? []).map(g => [rowKey(g.world, g.uid), g]));
    const lost = [...want].filter(k => !got.has(k));
    const extra = [...got.keys()].filter(k => !want.has(k));
    const bad = [...got.values()].filter(g => !Number.isInteger(Number(g.grade)) || g.grade < 0 || g.grade > 4);
    if (lost.length || extra.length || bad.length) {
        mismatched.push([`${JOBS}/${jf}`, `${lost.length} missing, ${extra.length} extra, ${bad.length} out-of-range`]);
        continue;
    }
    // Grouped by the bundle FILE, not the scene name — see the note in build. A job written before
    // `bundle` existed falls back to the old name-derived path, which is what it was in fact merged as.
    const target = job.bundle ?? `${job.scene}.json`;
    if (!bySceneRows.has(target)) bySceneRows.set(target, []);
    // `llmGrade` ONLY — never `grade`, which a human writes and nothing else does. Both used to be
    // written at the same value, which made a row no human had seen identical to one a human reviewed
    // and agreed with. Readers take metrics.mjs `gradeValue`, so the grade in force is unchanged; what
    // changes is that provenance survives, and it is the one thing no shape guard could recover
    // afterwards. `g.grade` on the right is the JUDGE's own output field, a different namespace.
    // A ROW HOLDS EVERY JUDGEMENT MADE ABOUT IT, not the latest one. `grading.passes` says a pass
    // produced N rows and cannot say which, and a single `by` string cannot describe a row two judges
    // have seen — which is not hypothetical: a rubric correction means re-grading rows that already
    // carry a verdict, and comparing the two IS the validation that the correction worked.
    //
    // `llmGrade` stays as the value IN FORCE so every existing reader (metrics.mjs `gradeValue`) is
    // untouched and 9340 rows need no migration; `llmGrades` is the history, newest last, and the two
    // are kept in step here. A row graded once has a one-element history, which is the same shape.
    const pass = passOf(job);
    bySceneRows.get(target).push(...job.candidates.map(c => {
        const g = got.get(rowKey(c.world, c.uid));
        // `llmGrade` INSIDE the element too, never `grade`. The array is judge-only, and `grade` is the
        // human's field — a project rule, not a convention. An element keyed `grade` would make
        // metrics.mjs `gradeValue` return a judge's number through its HUMAN branch, which is the
        // provenance collapse split-rater.mjs already had to migrate 8394 rows out of once.
        // A human's verdict never enters this array; it stays the row's top-level `grade` scalar.
        const one = { llmGrade: Number(g.grade), by: pass, at: STAMP, why: g.why };
        return { title: c.title, llmGrade: one.llmGrade, llmGrades: [one], by: pass, world: c.world, uid: c.uid, why: g.why };
    }));
}

console.log(`\n${jobFiles.length} jobs: ${jobFiles.length - missing.length - mismatched.length} clean, ${missing.length} ungraded, ${mismatched.length} rejected`);
for (const [p, why] of mismatched) console.log(`  REJECT ${p}  ${why}`);
if (missing.length) console.log(`  ${missing.length} jobs have no result yet (first: ${missing[0]})`);

let merged = 0, collided = 0, touched = 0;
const passTally = new Map();
for (const [target, rows] of bySceneRows) {
    const file = `${DATA}/${target}`;
    const scene = target.replace(/\.json$/, '');
    if (!existsSync(file)) { console.log(`  SKIP ${scene}: no bundle at ${file}`); continue; }
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    // A ROW IS SKIPPED ONLY IF THIS EXACT PASS ALREADY GRADED IT, so a re-run is idempotent and a
    // re-grade under a CHANGED contract or a different model appends instead of being refused. The
    // old rule — skip anything already graded — made a rubric correction unmergeable: the rows that
    // most need re-grading are precisely the ones that already carry a verdict.
    const byRow = new Map((bundle.grades ?? []).map(g => [rowKey(g.world, g.uid), g]));
    let appended = 0;
    const perPass = new Map();
    const bump = p => perPass.set(p, (perPass.get(p) ?? 0) + 1);
    const fresh = rows.filter(r => {
        const prior = byRow.get(rowKey(r.world, r.uid));
        if (!prior) { bump(r.by); return true; }
        const seen = prior.llmGrades ?? (prior.llmGrade === undefined ? [] : [{ llmGrade: prior.llmGrade, by: prior.by, at: prior.at, why: prior.why }]);
        if (seen.some(x => x.by === r.by)) { collided++; return false; }
        // A HUMAN's `grade` is never overwritten — it stays the value in force, and the judge's new
        // verdict joins the history beside it so the disagreement is inspectable.
        prior.llmGrades = [...seen, ...r.llmGrades];
        prior.llmGrade = r.llmGrade;
        prior.by = r.by;
        if (r.why) prior.why = r.why;
        appended++; bump(r.by);
        return false;
    });
    if (!fresh.length && !appended) continue;

    bundle.grades = [...(bundle.grades ?? []), ...fresh];
    // Provenance is per PASS, not per bundle: these files already carry fable-5 grades from 2026-07-31,
    // and a single `by` string cannot describe a mixed set. `by` stays the latest so existing readers see
    // something current; `passes` is what says which prompt and which model produced how many rows.
    bundle.grading = bundle.grading ?? {};
    bundle.grading.passes = [...(bundle.grading.passes ?? []),
        ...[...perPass].map(([by, n]) => ({ by, at: STAMP, rows: n, contract: 'scene-relevance.md' }))];
    bundle.grading.by = [...perPass.keys()].pop();
    if (WRITE) writeFileSync(file, JSON.stringify(bundle, null, 1));
    for (const [by, n] of perPass) passTally.set(by, (passTally.get(by) ?? 0) + n);
    merged += fresh.length + appended; touched++;
    console.log(`${WRITE ? 'wrote' : 'would write'} ${String(fresh.length).padStart(4)} grades${appended ? ` + ${appended} re-graded` : ''} -> ${scene}`);
}

console.log(`\n${merged} grades into ${touched} bundles${collided ? `; ${collided} rows already graded, left alone` : ''}`);
for (const [by, n] of passTally) console.log(`  ${String(n).padStart(5)} as ${by}`);
if (!WRITE && merged) console.log('dry run — re-run with --write');
process.exit(missing.length || mismatched.length ? 1 : 0);
