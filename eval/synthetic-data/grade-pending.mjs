// grade-pending.mjs — turns a row list into judge jobs, and judged jobs back into grades; nothing here calls a model, so a killed run has already written every job it built and merged every result that existed.
// Usage (any cwd):
//   node eval/synthetic-data/grade-pending.mjs build --rows <rows.json> [--batch 16] [--jobs <dir>] [--run <label>]
//   node eval/synthetic-data/grade-pending.mjs merge --jobs <dir> --results <dir> [--model <name>] [--effort <x>] [--write]   (dry by default; a result whose uid set differs from its job is rejected, never partially merged)
// rows.json is a JSON array of {bundle, book, uid}, bundle being the bundle's FILENAME in eval-data. A re-grade appends beside the prior verdict; only an exact repeat (same rubric, model and day) is skipped.
// The job is the contamination boundary: a judge sees the scene text and each entry whole, never a score, rank, matched key, chunk or pool position.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { archiveContract, contractBody } from './contract.mjs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBundle, passKey, raterKey, raterParts, setGrades } from '../../extension/grading.mjs';
import { arg } from '../lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = resolvePath(HERE, '..');
const DATA = resolvePath(EVAL, 'eval-data');
const CONTRACT = resolvePath(EVAL, '..', '.claude', 'agents', 'scene-relevance.md');

const argv = process.argv.slice(2);
const cmd = argv[0];
const WRITE = argv.includes('--write');

if (cmd !== 'build' && cmd !== 'merge') {
    console.error('usage: node eval/synthetic-data/grade-pending.mjs build --rows <rows.json> [--batch 16] [--jobs <dir>]');
    console.error('       node eval/synthetic-data/grade-pending.mjs merge --jobs <dir> --results <dir> [--write]');
    process.exit(2);
}

const JOBS = resolvePath(arg(argv, '--jobs', resolvePath(EVAL, 'grade-jobs')));
const US = String.fromCharCode(31);
// Trimmed: the judge echoes the book string and can come back a trailing space short. Only the match key; a merged row stores the job's own book.
const rowKey = (book, uid) => [String(book ?? '').trim(), uid].join(US);
const shipped = b => openBundle(b);
/** Books are keyed by array position, which equals uid in some books and not in others. Always map. */
const byUid = book => new Map(Object.values(book ?? {}).map(e => [String(e.uid), e]));

// Stamped on the job at build and read from there at merge: a hash taken at merge time is the rubric in force then, not the one the judge was given (G9).
const contractHash = existsSync(CONTRACT)
    ? archiveContract(contractBody(readFileSync(CONTRACT, 'utf8'))).hash
    : 'unknown';

// --run <label>: a deliberate same-day repeat under the same rubric and model; build stamps it on the job, merge appends #<label> to the pass id.
const RUN = arg(argv, '--run');

if (cmd === 'build') {
    const BATCH = Number(arg(argv, '--batch', 16));
    const ROWS = arg(argv, '--rows');
    mkdirSync(JOBS, { recursive: true });

    let files = 0, rows = 0, batches = 0, bytes = 0, dropped = 0, future = 0;
    const emitJobs = (bundleFile, rowList) => {
        const bundle = JSON.parse(readFileSync(`${DATA}/${bundleFile}`, 'utf8'));
        const arm = shipped(bundle);
        const name = bundle.name ?? bundleFile.replace(/\.json$/, '');
        // Identity is the filename, never bundle.name — two bundles can share a name (G9); scene is display only, bundle is what merge resolves.
        const base = bundleFile.replace(/\.json$/, '');
        const books = new Map(Object.entries(bundle.books ?? {}).map(([b, bk]) => [b, byUid(bk)]));

        // scene.mjs dropUnavailable's rule: an entry whose STMB range ends at or after the frozen turn was not in the book when the turn was live.
        const at = Number(bundle.generatedFrom?.msg);
        const unavailable = (r) => {
            if (!Number.isFinite(at)) return false;
            const e = books.get(r.book)?.get(String(r.uid));
            const end = Number(e?.STMB_end), start = Number(e?.STMB_start);
            return Number.isFinite(end) ? end >= at : (Number.isFinite(start) && start > at);
        };
        // A judge handed an empty candidate grades the title; dropped and counted instead.
        const usable = rowList.filter(r => {
            const e = books.get(r.book)?.get(String(r.uid));
            if (!e || !(e.content ?? '').trim()) { dropped++; return false; }
            if (unavailable(r)) { future++; return false; }
            return true;
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
    console.log(`\n${files} scenes, ${batches} jobs, ${rows} rows, ${dropped} dropped (no entry text)`
        + `${future ? `, ${future} dropped (post-dates its scene)` : ''}`);
    console.log(`${(bytes / 1024 / 1024).toFixed(1)}MB payload (~${Math.round(bytes / 4000)}k input tokens) in ${JOBS}`);
    process.exit(0);
}

// ---- merge ----
const RESULTS = resolvePath(arg(argv, '--results', JOBS));
const MODEL = arg(argv, '--model', 'claude-sonnet-5');
// A component of the rater id, not a note beside it: two passes differing only in effort would otherwise collide on the idempotency key.
const EFFORT = arg(argv, '--effort', '');
// The result's own rater over the flags: grade-local resolves the model against the backend, and the flags cover a result that records nothing (a subagent).
const raterOf = (job, res) => (res?.rater
    ? { kind: 'llm', ...res.rater, rubric: res.rater.rubric ?? `scene-relevance@${job.contract ?? contractHash}` }
    : { kind: 'llm', modelName: MODEL, rubric: `scene-relevance@${job.contract ?? contractHash}` });
/** Same rater, same knobs, same day is one pass: a re-merge is idempotent under it and anything else appends. */
const samePass = (a, b) => a.kind === 'llm' && b.kind === 'llm' && passKey(a) === passKey(b);
// Merge time is the last resort: it cannot separate two passes filed together.
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
    // A job written before `bundle` existed falls back to the name-derived path, which is what it was in fact merged as.
    const target = job.bundle ?? `${job.scene}.json`;
    if (!bySceneRows.has(target)) bySceneRows.set(target, []);
    const rater = raterOf(job, res);
    bySceneRows.get(target).push(...job.candidates.map(c => {
        const g = got.get(rowKey(c.book, c.uid));
        // kind 'llm', never 'human': the kind is what tells an unreviewed row from a reviewed one, and this writer names no other. --effort fills what a result cannot know about itself.
        const params = { ...(res.params ?? {}), ...(EFFORT ? { effort: EFFORT } : {}) };
        // `id` is what passKey and raterParts read, and a bundle's own verdicts carry it: without it every re-merge reads as a new pass.
        const one = { ...rater, id: raterKey(rater), ...(Object.keys(params).length ? { params } : {}), grade: Number(g.grade), gradedAt, ...(g.why ? { why: g.why } : {}) };
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
    const priorRows = openBundle(bundle).entries ?? [];
    const byRow = new Map(priorRows.map(g => [rowKey(g.book, g.uid), g]));
    let appended = 0;
    const perPass = new Map();
    const label = v => { const { rubric, modelId } = raterParts(v); return `${rubric ?? ''}/${modelId ?? ''}`; };
    const bump = v => perPass.set(label(v), (perPass.get(label(v)) ?? 0) + 1);
    const fresh = rows.filter(r => {
        const prior = byRow.get(rowKey(r.book, r.uid));
        const one = r.grades[0];
        if (!prior) { bump(one); return true; }
        const seen = prior.grades ?? [];
        if (!RUN && seen.some(x => samePass(x, one))) { collided++; return false; }
        // Appended beside every prior verdict, a human's included; nothing is overwritten.
        prior.grades = [...seen, one];
        appended++; bump(one);
        return false;
    });
    if (!fresh.length && !appended) continue;

    setGrades(bundle, [...priorRows, ...fresh]);
    // grading.passes: the per-pass row count is what says a merge landed; no per-row field records it.
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
