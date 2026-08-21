// grade-pending build/merge round-trip: does a row reach the bundle it came from?
//
// The case that matters is two bundles sharing a `name`, which is not hypothetical — a scene captured
// under a second book carries the same name as the original. Keyed on name, build overwrites one
// bundle's jobs with the other's and merge resolves the target back through the same collision, so a
// grade lands in a bundle whose `books` do not contain that world. It merged clean and the pool gap
// simply failed to close; nothing in the uid diff can see it, because each job matched its own result.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleSamples, openBundle, raterParts } from '../extension/grading.mjs';
import { gradeValue } from './metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, 'synthetic-data', 'grade-pending.mjs');
let fails = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`); if (!cond) fails++; };

// The tool reads eval-data/ beside itself, so the fixture is installed there and removed after. Named
// with a prefix nothing else uses, and every file it writes is tracked for cleanup.
const DATA = resolve(HERE, 'eval-data');
const TAG = 'zz-gpcheck';
const JOBS = mkdtempSync(`${tmpdir()}/gpcheck-`);
const written = [];
const put = (name, obj) => { const p = `${DATA}/${name}`; writeFileSync(p, JSON.stringify(obj, null, 1)); written.push(p); return p; };

const entry = (uid, text) => ({ uid, comment: `entry ${uid}`, content: text });
const bundle = (book, uid) => ({
    // BOTH bundles carry this same name on purpose — that is the whole case — and the name is bundle A's
    // OWN filename, which is what production looked like: the -null-book variant took its name from the
    // original. That detail decides the failure mode. A shared name matching no file makes merge SKIP and
    // the rows vanish; a shared name matching a real file makes merge write one bundle's rows INTO the
    // other, which is the case worth catching and the one that happened.
    name: `${TAG}-a`,
    books: { [book]: { [uid]: entry(uid, `content for ${book} uid ${uid}`) } },
    chat: 'data/chat.jsonl', scanText: 'the scene text', depth: 10,
    query: 'the scene text', candidates: [{ book, uid, title: `entry ${uid}` }],
    grades: [],
});
/** Built through the real assembler, so the fixture cannot drift from the schema the tool writes. */
const doc = async (book, uid) => await bundleSamples([{ arm: 'shipped', sample: bundle(book, uid) }], { start: 90, end: 99 });

try {
    put(`${TAG}-a.json`, await doc('book-A', 11));
    put(`${TAG}-b.json`, await doc('book-B', 22));
    put(`${TAG}-a-pending.json`, { name: `${TAG}-scene`, of: `${TAG}-a.json`, rows: [{ book: 'book-A', uid: 11, title: 'entry 11' }] });
    put(`${TAG}-b-pending.json`, { name: `${TAG}-scene`, of: `${TAG}-b.json`, rows: [{ book: 'book-B', uid: 22, title: 'entry 22' }] });

    execFileSync('node', [TOOL, 'build', '--batch', '8', '--jobs', JOBS, '--only', TAG], { encoding: 'utf8' });
    const jobFiles = readdirSync(JOBS).filter(f => f.endsWith('.json'));
    ok(jobFiles.length === 2, `two same-named bundles produce two job files, not one (got ${jobFiles.length})`);

    // Answer each job with the grade its own candidates ask for; the judge is not what is under test.
    for (const jf of jobFiles) {
        const job = JSON.parse(readFileSync(`${JOBS}/${jf}`, 'utf8'));
        writeFileSync(job.out, JSON.stringify({ grades: job.candidates.map(c => ({ book: c.book, uid: c.uid, grade: 3, why: 'test' })) }, null, 1));
    }
    execFileSync('node', [TOOL, 'merge', '--jobs', JOBS, '--write'], { encoding: 'utf8' });

    const a = openBundle(JSON.parse(readFileSync(`${DATA}/${TAG}-a.json`, 'utf8')));
    const b = openBundle(JSON.parse(readFileSync(`${DATA}/${TAG}-b.json`, 'utf8')));
    ok(a.entries.length === 1 && a.entries[0]?.book === 'book-A' && a.entries[0]?.uid === 11, 'bundle A gets its own row and only its own');
    ok(b.entries.length === 1 && b.entries[0]?.book === 'book-B' && b.entries[0]?.uid === 22, 'bundle B gets its own row and only its own');
    // The failure this check exists for: a row whose world the bundle does not hold. Asserted per bundle
    // against ITS OWN books — a flat scan over both bundles' rows passes while one of them is empty.
    const stray = [a, b].flatMap(bu => (bu.entries ?? []).filter(g => !bu.books[g.book]));
    ok(stray.length === 0, `no grade lands in a document whose books lack that book (${stray.length} stray)`);
    // THE RATER A VERDICT NAMES IS ITS PROVENANCE. An llm pass writes verdicts of kind `llm` and no
    // other, so a row no human has seen stays distinguishable from one a human reviewed and agreed with.
    const v = a.entries[0]?.grades ?? [];
    ok(v.length === 1 && v[0].kind === 'llm', 'the pass writes one verdict, of kind llm and no other kind');
    const rater = openBundle(JSON.parse(readFileSync(`${DATA}/${TAG}-a.json`, 'utf8'))).raters?.[v[0].rater]
        ?? JSON.parse(readFileSync(`${DATA}/${TAG}-a.json`, 'utf8')).raters[0];
    const who = raterParts(rater);
    ok(v[0].grade === 3 && who.modelId && who.rubric,
        'and its rater id decomposes to the model that ran and the rubric it ran under');
    // A HOSTED model has no digest to resolve, so its NAME stands in — flagged, because that id is not
    // stable the way a content digest is.
    ok(who.isDigest === false, '...with isDigest false, since a served model is opaque and cannot be pinned');
    ok(gradeValue(a.entries[0]) === 3, 'which the reader resolves to the value in force');
} finally {
    for (const p of written) if (existsSync(p)) rmSync(p);
    rmSync(JOBS, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nok');
process.exit(fails ? 1 : 0);
