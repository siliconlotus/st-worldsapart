// grade-pending.mjs — turns a row list into judge jobs, and judged jobs back into grades.
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
//   node eval/synthetic-data/grade-pending.mjs build --rows <rows.json> [--batch 16] [--jobs <dir>]
//   node eval/synthetic-data/grade-pending.mjs merge --jobs <dir> --results <dir> [--write]
//
// THE INPUT IS A ROW LIST: a JSON array of {bundle, book, uid}, where `bundle` is the bundle's FILENAME in
// eval-data (the identity rule above). Rows are grouped by bundle and emitted as one job per scene, so a
// cross-scene audit — re-grading the activation misses, an inter-rater pass — is expressed the same way as
// one scene's ungraded remainder: it is a row list that happens to span scenes.
//
// A RE-GRADE OF ALREADY-GRADED ROWS IS THE POINT: the new verdict is
// appended to the row's `llmGrades`, beside the one it disagrees with rather than over it, because
// comparing the two IS the validation that a rubric correction worked. Only an exact repeat — same rubric,
// same model, same day — is skipped, and only so that re-merging the same results is idempotent.
//
// merge is dry by default and ALWAYS runs the uid diff first: a result whose uid set does not match its
// job is not merged, and its job path is printed for re-dispatch. A judge dropping one row of sixteen is
// silent otherwise — it has happened — and a partial merge would bake the gap into the bundle.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { archiveContract, contractBody } from './contract.mjs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBundle, passKey, raterParts, setGrades } from '../../extension/grading.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = resolvePath(HERE, '..');
const DATA = resolvePath(EVAL, 'eval-data');
const CONTRACT = resolvePath(EVAL, '..', '.claude', 'agents', 'scene-relevance.md');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const WRITE = argv.includes('--write');

if (cmd !== 'build' && cmd !== 'merge') {
    console.error('usage: node eval/synthetic-data/grade-pending.mjs build --rows <rows.json> [--batch 16] [--jobs <dir>]');
    console.error('       node eval/synthetic-data/grade-pending.mjs merge --jobs <dir> --results <dir> [--write]');
    process.exit(2);
}

const JOBS = resolvePath(arg('--jobs', resolvePath(EVAL, 'grade-jobs')));
const US = String.fromCharCode(31);
const rowKey = (book, uid) => [book, uid].join(US);
/** The shipped arm as a flat sample. Reading through openBundle is what keeps this tool out of the file
 *  layout: v3 moved the haystack, the params and every verdict, and none of that shows up here. */
const shipped = b => openBundle(b);
/** Books are keyed by array position, which equals uid in some books and not in others. Always map. */
const byUid = book => new Map(Object.values(book ?? {}).map(e => [String(e.uid), e]));

// THE CONTRACT IS STAMPED ON THE JOB, and merge reads it from there rather than re-hashing the file.
// A result records no rubric of its own, so a hash taken at merge time is the rubric in force WHEN THE
// MERGE RAN, not the one the judge was given: re-merging a stale result directory after a rubric
// correction relabelled 395 old-contract job files as if they had been graded under the new one, and
// the appended history said so. The job is written and the judge dispatched in the same breath, so the
// hash at build time is the only one that describes the grading.
// One definition of what a contract IS and what it hashes to, shared with grade-local — see contract.mjs.
// The block is archived under its hash, so a verdict's `scene-relevance@<hash>` resolves to text.
const contractHash = existsSync(CONTRACT)
    ? archiveContract(contractBody(readFileSync(CONTRACT, 'utf8'))).hash
    : 'unknown';

// A RUN LABEL MAKES A REPEAT PASS DISTINCT FROM THE ONE IT REPEATS. Pass identity is contract+model,
// which is what stops a re-merge from appending the same verdicts twice — but it also refuses a
// DELIBERATE second opinion under the same rubric from the same model, which is exactly what a
// tiebreak is. `build --run <label>` stamps the job, and merge appends `#<label>` to the pass id, so
// the third verdict lands beside the first two instead of colliding with them, and still cannot be
// merged twice itself.
const RUN = arg('--run');

if (cmd === 'build') {
    const BATCH = Number(arg('--batch', 16));
    const ROWS = arg('--rows');
    mkdirSync(JOBS, { recursive: true });

    let files = 0, rows = 0, batches = 0, bytes = 0, dropped = 0;
    // One bundle's worth of rows -> job files.
    const emitJobs = (bundleFile, rowList) => {
        const bundle = JSON.parse(readFileSync(`${DATA}/${bundleFile}`, 'utf8'));
        const arm = shipped(bundle);
        const name = bundle.name ?? bundleFile.replace(/\.json$/, '');
        // IDENTITY IS THE FILENAME, never `name` — two bundles can carry the same name and one pair does
        // (isekai-time-whore-frozen-2-msg3728 and its -null-book variant, the same scene under a different
        // book). Keyed on name, their jobs overwrite each other here and merge writes the survivor's rows
        // into whichever file the name resolves to: measured, one row landed in a bundle whose books do not
        // contain that book. `scene` stays the display label; `bundle` is what merge resolves.
        const base = bundleFile.replace(/\.json$/, '');
        const books = new Map(Object.entries(bundle.books ?? {}).map(([b, bk]) => [b, byUid(bk)]));

        // A row whose entry is gone or empty cannot be graded from the entry text, and a judge handed an
        // empty candidate will grade the title. Dropped and counted rather than passed through.
        const usable = rowList.filter(r => {
            const e = books.get(r.book)?.get(String(r.uid));
            if (e && (e.content ?? '').trim()) return true;
            dropped++; return false;
        });

        for (let i = 0; i < usable.length; i += BATCH) {
            const chunk = usable.slice(i, i + BATCH);
            const id = `${base}-r${String(i / BATCH).padStart(2, '0')}`;
            const job = {
                scene: name,
                bundle: bundleFile,
                contract: contractHash,
                ...(RUN ? { run: RUN } : {}),
                out: `${JOBS}/${id}-graded.json`,
                note: 'Grade every candidate against the scene. Write the JSON your instructions describe to `out`.',
                sceneText: arm.query,
                candidates: chunk.map(r => {
                    const e = books.get(r.book).get(String(r.uid));
                    return { book: r.book, uid: r.uid, title: e.comment || r.title, text: e.content };
                }),
            };
            const path = `${JOBS}/${id}.json`;
            writeFileSync(path, JSON.stringify(job, null, 1));
            batches++; rows += chunk.length; bytes += JSON.stringify(job).length;
        }
        files++;
        console.log(`${name.slice(0, 46).padEnd(46)} ${String(usable.length).padStart(4)}/${String(rowList.length).padStart(4)} rows  ${Math.ceil(usable.length / BATCH)} jobs`);
    };

    if (!ROWS) {
        console.error('build needs --rows <rows.json>: a JSON array of {bundle, book, uid}');
        process.exit(2);
    }
    {
        const list = JSON.parse(readFileSync(resolvePath(ROWS), 'utf8'));
        const byBundle = new Map();
        for (const r of list) {
            if (!r.bundle || r.book === undefined || r.uid === undefined) { console.error(`row missing bundle/book/uid: ${JSON.stringify(r)}`); process.exit(2); }
            if (!byBundle.has(r.bundle)) byBundle.set(r.bundle, []);
            byBundle.get(r.bundle).push(r);
        }
        for (const [bf, group] of [...byBundle.entries()].sort()) emitJobs(bf, group);
    }
    console.log(`\n${files} scenes, ${batches} jobs, ${rows} rows, ${dropped} dropped (no entry text)`);
    console.log(`${(bytes / 1024 / 1024).toFixed(1)}MB payload (~${Math.round(bytes / 4000)}k input tokens) in ${JOBS}`);
    process.exit(0);
}

// ---- merge ----
const RESULTS = resolvePath(arg('--results', JOBS));
const MODEL = arg('--model', 'claude-sonnet-5');
// The reasoning effort the pass ran at. A component of the rater id, not a note beside it: two passes
// differing only in effort would otherwise collide on the idempotency key and the second be dropped.
const EFFORT = arg('--effort', '');
/** WHO GRADED, as v3 names them: the model, and the rubric that told it what to grade. The pass's REASON
 *  is not part of either — a tiebreak verdict is a third verdict, and the array's order already says so. */
// WHAT THE RESULT SAYS PRODUCED IT, before what this run was told. grade-local resolves the model against
// the backend — a manifest digest from Ollama, an org-qualified repo id from oMLX's store — and a --model
// flag can only repeat what someone typed. The flags remain for a result written by something that records
// nothing, a subagent among them.
const raterOf = (job, res) => (res?.rater
    ? { kind: 'llm', ...res.rater, rubric: res.rater.rubric ?? `scene-relevance@${job.contract ?? contractHash}` }
    : { kind: 'llm', modelName: MODEL, rubric: `scene-relevance@${job.contract ?? contractHash}` });
/** Two verdicts from the same rater, under the same knobs, on the same day are indistinguishable in the
 *  file, so that is the key a re-merge is idempotent under. A pass that CHANGED a knob — another seed,
 *  another effort — is a different pass and appends. `--run` is the operator asserting that an otherwise
 *  identical same-day repeat is a deliberate extra verdict rather than the same jobs merged twice. */
const samePass = (a, b) => a.kind === 'llm' && b.kind === 'llm' && passKey(a) === passKey(b);
// FALLBACK ONLY. A verdict is stamped with when the PASS ran, taken from the result itself or, failing
// that, from when the result file was written — a subagent writes its own answer, so its mtime is the
// grading moment. Merge time is the last resort and is the one that cannot separate two passes filed
// together, which is precisely the adjudication case.
const STAMP = new Date().toISOString();
const gradedAtOf = (res, path) => {
    if (res?.gradedAt) return res.gradedAt;
    try { return statSync(path).mtime.toISOString(); } catch { return STAMP; }
};

const jobFiles = readdirSync(JOBS).filter(f => f.endsWith('.json') && !f.endsWith('-graded.json')).sort();
const missing = [], mismatched = [];
const bySceneRows = new Map();

for (const jf of jobFiles) {
    const job = JSON.parse(readFileSync(`${JOBS}/${jf}`, 'utf8'));
    const rf = `${RESULTS}/${jf.replace(/\.json$/, '-graded.json')}`;
    if (!existsSync(rf)) { missing.push(`${JOBS}/${jf}`); continue; }

    let res;
    try { res = JSON.parse(readFileSync(rf, 'utf8')); } catch (e) { mismatched.push([`${JOBS}/${jf}`, `unparseable result: ${e.message}`]); continue; }
    const gradedAt = gradedAtOf(res, rf);

    const want = new Set(job.candidates.map(c => rowKey(c.book, c.uid)));
    const got = new Map((res.grades ?? []).map(g => [rowKey(g.book, g.uid), g]));
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
    const rater = raterOf(job, res);
    bySceneRows.get(target).push(...job.candidates.map(c => {
        const g = got.get(rowKey(c.book, c.uid));
        // KIND `llm`, never `human`. The rater a verdict names IS its provenance — that is the whole of
        // what tells an unreviewed row from one a human reviewed and agreed with, and it is structural
        // rather than policed: this writer names no other kind.
        // The knobs the pass RAN under, from the result, with --effort filling what a result cannot know
        // about itself (a subagent is not told its own reasoning level).
        const params = { ...(res.params ?? {}), ...(EFFORT ? { effort: EFFORT } : {}) };
        const one = { ...rater, ...(Object.keys(params).length ? { params } : {}), grade: Number(g.grade), gradedAt, ...(g.why ? { why: g.why } : {}) };
        return { title: c.title, grades: [one], book: c.book, uid: c.uid };
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
    const priorRows = openBundle(bundle).entries ?? [];
    const byRow = new Map(priorRows.map(g => [rowKey(g.book, g.uid), g]));
    let appended = 0;
    const perPass = new Map();
    const label = v => raterParts(v).rubric + '/' + raterParts(v).model;
    const bump = v => perPass.set(label(v), (perPass.get(label(v)) ?? 0) + 1);
    const fresh = rows.filter(r => {
        const prior = byRow.get(rowKey(r.book, r.uid));
        const one = r.grades[0];
        if (!prior) { bump(one); return true; }
        const seen = prior.grades ?? [];
        if (!RUN && seen.some(x => samePass(x, one))) { collided++; return false; }
        // A HUMAN's verdict is never touched — it outranks an llm's at read time, and the new verdict
        // joins the record beside it so the disagreement stays inspectable.
        prior.grades = [...seen, one];
        appended++; bump(one);
        return false;
    });
    if (!fresh.length && !appended) continue;

    setGrades(bundle, [...priorRows, ...fresh]);
    // Provenance is per PASS, not per bundle: these files already carry fable-5 grades from 2026-07-31,
    // and a single `by` string cannot describe a mixed set. `by` stays the latest so existing readers see
    // something current; `passes` is what says which prompt and which model produced how many rows.
    bundle.grading = bundle.grading ?? {};
    bundle.grading.passes = [...(bundle.grading.passes ?? []),
        ...[...perPass].map(([by, n]) => ({ by, at: STAMP, rows: n, contract: 'scene-relevance.md' }))];
    bundle.grading.by = [...perPass.keys()].pop();
    // A SUMMARY, and derivable from the verdicts now that each one names its own rater — kept because the
    // row COUNT per pass is what says a merge landed, which no per-row field records.
    if (WRITE) writeFileSync(file, JSON.stringify(bundle, null, 1));
    for (const [by, n] of perPass) passTally.set(by, (passTally.get(by) ?? 0) + n);
    merged += fresh.length + appended; touched++;
    console.log(`${WRITE ? 'wrote' : 'would write'} ${String(fresh.length).padStart(4)} grades${appended ? ` + ${appended} re-graded` : ''} -> ${scene}`);
}

console.log(`\n${merged} grades into ${touched} bundles${collided ? `; ${collided} rows already graded, left alone` : ''}`);
for (const [by, n] of passTally) console.log(`  ${String(n).padStart(5)} as ${by}`);
if (!WRITE && merged) console.log('dry run — re-run with --write');
process.exit(missing.length || mismatched.length ? 1 : 0);
