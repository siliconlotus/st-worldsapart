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
const bundle = (world, uid) => ({
    // BOTH bundles carry this same name on purpose — that is the whole case — and the name is bundle A's
    // OWN filename, which is what production looked like: the -null-book variant took its name from the
    // original. That detail decides the failure mode. A shared name matching no file makes merge SKIP and
    // the rows vanish; a shared name matching a real file makes merge write one bundle's rows INTO the
    // other, which is the case worth catching and the one that happened.
    name: `${TAG}-a`,
    books: { [world]: { [uid]: entry(uid, `content for ${world} uid ${uid}`) } },
    arms: [{ arm: 'shipped', query: 'the scene text', candidates: [{ world, uid, title: `entry ${uid}` }] }],
    grades: [],
});

try {
    put(`${TAG}-a.json`, bundle('book-A', 11));
    put(`${TAG}-b.json`, bundle('book-B', 22));
    put(`${TAG}-a-pending.json`, { name: `${TAG}-scene`, of: `${TAG}-a.json`, rows: [{ world: 'book-A', uid: 11, title: 'entry 11' }] });
    put(`${TAG}-b-pending.json`, { name: `${TAG}-scene`, of: `${TAG}-b.json`, rows: [{ world: 'book-B', uid: 22, title: 'entry 22' }] });

    execFileSync('node', [TOOL, 'build', '--batch', '8', '--jobs', JOBS, '--only', TAG], { encoding: 'utf8' });
    const jobFiles = readdirSync(JOBS).filter(f => f.endsWith('.json'));
    ok(jobFiles.length === 2, `two same-named bundles produce two job files, not one (got ${jobFiles.length})`);

    // Answer each job with the grade its own candidates ask for; the judge is not what is under test.
    for (const jf of jobFiles) {
        const job = JSON.parse(readFileSync(`${JOBS}/${jf}`, 'utf8'));
        writeFileSync(job.out, JSON.stringify({ grades: job.candidates.map(c => ({ world: c.world, uid: c.uid, grade: 3, why: 'test' })) }, null, 1));
    }
    execFileSync('node', [TOOL, 'merge', '--jobs', JOBS, '--write'], { encoding: 'utf8' });

    const a = JSON.parse(readFileSync(`${DATA}/${TAG}-a.json`, 'utf8'));
    const b = JSON.parse(readFileSync(`${DATA}/${TAG}-b.json`, 'utf8'));
    ok(a.grades.length === 1 && a.grades[0]?.world === 'book-A' && a.grades[0]?.uid === 11, 'bundle A gets its own row and only its own');
    ok(b.grades.length === 1 && b.grades[0]?.world === 'book-B' && b.grades[0]?.uid === 22, 'bundle B gets its own row and only its own');
    // The failure this check exists for: a row whose world the bundle does not hold. Asserted per bundle
    // against ITS OWN books — a flat scan over both bundles' rows passes while one of them is empty.
    const stray = [a, b].flatMap(bu => (bu.grades ?? []).filter(g => !bu.books[g.world]));
    ok(stray.length === 0, `no grade lands in a bundle whose books lack that world (${stray.length} stray)`);
    ok(a.grades[0]?.llmGrade === 3 && a.grades[0]?.grade === undefined, 'the judge writes llmGrade, never grade');
} finally {
    for (const p of written) if (existsSync(p)) rmSync(p);
    rmSync(JOBS, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nok');
process.exit(fails ? 1 : 0);
