// grade-pending build/merge round-trip: does a row reach the bundle it came from, when two bundles share a `name`?
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleSamples, openBundle, raterParts } from '../extension/grading.mjs';
import { gradeValue } from '../eval/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = resolve(HERE, '..', 'eval');
const US = String.fromCharCode(31);
const TOOL = resolve(EVAL, 'synthetic-data', 'grade-pending.mjs');
let fails = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`); if (!cond) fails++; };

// The tool reads eval-data/ beside itself, so the fixture is installed there and removed after.
const DATA = resolve(EVAL, 'eval-data');
const TAG = 'zz-gpcheck';
const JOBS = mkdtempSync(`${tmpdir()}/gpcheck-`);
const written = [];
const put = (name, obj) => { const p = `${DATA}/${name}`; writeFileSync(p, JSON.stringify(obj, null, 1)); written.push(p); return p; };

const entry = (uid, text) => ({ uid, comment: `entry ${uid}`, content: text });
const bundle = (book, uid) => ({
    // Both bundles carry this name on purpose, and it is bundle A's own filename: a shared name matching a real file is the case that happened.
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
    const rows = put(`${TAG}-rows.json`, [
        { bundle: `${TAG}-a.json`, book: 'book-A', uid: 11 },
        { bundle: `${TAG}-b.json`, book: 'book-B', uid: 22 },
    ]);

    execFileSync('node', [TOOL, 'build', '--batch', '8', '--jobs', JOBS, '--rows', rows], { encoding: 'utf8' });
    const jobFiles = readdirSync(JOBS).filter(f => f.endsWith('.json'));
    ok(jobFiles.length === 2, `two same-named bundles produce two job files, not one (got ${jobFiles.length})`);

    // Answer each job with the grade its own candidates ask for; the judge is not under test.
    for (const jf of jobFiles) {
        const job = JSON.parse(readFileSync(`${JOBS}/${jf}`, 'utf8'));
        // The result carries what produced it, as grade-local writes it; merge must prefer this over its own --model flag.
        writeFileSync(job.out, JSON.stringify({
            rater: { modelDigest: 'a'.repeat(64), modelName: 'gemma4:e4b-mxfp8', family: 'gemma4', quant: 'mxfp8', modelParams: '8.1B', rubric: 'scene-relevance@deadbeef' },
            params: { seed: 7, temperature: 0, num_ctx: 65536, think: false },
            grades: job.candidates.map(c => ({ book: c.book, uid: c.uid, grade: 3, why: 'test' })),
        }, null, 1));
    }
    execFileSync('node', [TOOL, 'merge', '--jobs', JOBS, '--write'], { encoding: 'utf8' });

    const a = openBundle(JSON.parse(readFileSync(`${DATA}/${TAG}-a.json`, 'utf8')));
    const b = openBundle(JSON.parse(readFileSync(`${DATA}/${TAG}-b.json`, 'utf8')));
    ok(a.entries.length === 1 && a.entries[0]?.book === 'book-A' && a.entries[0]?.uid === 11, 'bundle A gets its own row and only its own');
    ok(b.entries.length === 1 && b.entries[0]?.book === 'book-B' && b.entries[0]?.uid === 22, 'bundle B gets its own row and only its own');
    // Asserted per bundle against ITS OWN books: a flat scan over both bundles' rows passes while one of them is empty.
    const stray = [a, b].flatMap(bu => (bu.entries ?? []).filter(g => !bu.books[g.book]));
    ok(stray.length === 0, `no grade lands in a document whose books lack that book (${stray.length} stray)`);
    const v = a.entries[0]?.grades ?? [];
    ok(v.length === 1 && v[0].kind === 'llm', 'the pass writes one verdict, of kind llm and no other kind');
    const rater = openBundle(JSON.parse(readFileSync(`${DATA}/${TAG}-a.json`, 'utf8'))).raters?.[v[0].rater]
        ?? JSON.parse(readFileSync(`${DATA}/${TAG}-a.json`, 'utf8')).raters[0];
    const who = raterParts(rater);
    ok(who.isDigest, 'the rater id carries the digest the result resolved, not the name the flag defaulted to');
    ok(who.rubric === 'scene-relevance@deadbeef', '...and the rubric the result graded under');
    ok(rater.family === 'gemma4' && rater.quant === 'mxfp8' && rater.modelParams === '8.1B',
        'the descriptive fields survive the merge');
    ok(rater.capabilities === undefined, 'capabilities decided whether `think` is a knob and is not a rater field');
    ok(v[0].params?.seed === 7 && v[0].params?.num_ctx === 65536 && v[0].params?.think === false,
        'the verdict carries the knobs the pass ran under, under the names the invocation used');
    ok(v[0].grade === 3 && who.modelId && who.rubric,
        'and its rater id decomposes to the model that ran and the rubric it ran under');
    ok(gradeValue(a.entries[0]) === 3, 'which the reader resolves to the value in force');

    const hosted = raterParts({ kind: 'llm', id: `claude-sonnet-5${US}scene-relevance@deadbeef` });
    ok(hosted.isDigest === false, 'a served model is opaque, so its id is a name and isDigest says so');
    ok(hosted.modelId === 'claude-sonnet-5' && hosted.rubric === 'scene-relevance@deadbeef',
        '...and it still decomposes to the model that ran and the rubric it ran under');
} finally {
    for (const p of written) if (existsSync(p)) rmSync(p);
    rmSync(JOBS, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nok');
process.exit(fails ? 1 : 0);
