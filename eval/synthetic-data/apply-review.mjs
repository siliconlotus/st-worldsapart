// apply-review.mjs — writes a /wa-super-eval multi-scene review ({captureId, file, grades} sections) back into eval-data, each section resolved by captureId alone; the bundle is otherwise untouched.
// Usage (any cwd):
//   node eval/synthetic-data/apply-review.mjs [review.json] [--data <dir>] [--user <rater id>] [--write]   (no file: the newest review-*.json in eval-data, ~/Downloads or cwd; dry by default)
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';

const HEAD_BYTES = 4096;   // enough to hold everything ahead of the bulk; captureId is the second key
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBundle, passKey, setGrades } from '../../extension/grading.mjs';
import { arg } from '../metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where each section's bundle is, by captureId alone — no fallback to `file`: two captures of one turn under different books share basename and scene id, and a mis-landed review is not recoverable. Reads the head only; `captureId` is the second key a writer emits (G14).
 * @returns {Map<object, {path: string, renamedFrom?: string}|{error: string}>} section -> where it resolved
 */
export function resolveSections(sections, dir) {
    const byId = new Map();
    const wanted = new Set(sections.map(s => s.captureId).filter(Boolean));
    if (wanted.size) {
        for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
            const fd = openSync(`${dir}/${f}`, 'r');
            const buf = Buffer.alloc(HEAD_BYTES);
            const len = readSync(fd, buf, 0, HEAD_BYTES, 0);
            closeSync(fd);
            const head = buf.subarray(0, len).toString('utf8');
            // A document only: review files in eval-data carry their sections' captureIds too, and schemaVersion is the first key a writer emits.
            if (!/^\s*\{\s*"schemaVersion"\s*:/.test(head)) continue;
            const hit = /"captureId":\s*"([^"]+)"/.exec(head);
            if (!hit || !wanted.has(hit[1])) continue;
            byId.set(hit[1], [...(byId.get(hit[1]) ?? []), f]);
        }
    }
    const out = new Map();
    for (const s of sections) {
        const hits = byId.get(s.captureId) ?? [];
        if (!s.captureId) out.set(s, { error: `section "${s.file ?? '(unnamed)'}" carries no captureId — re-export the review` });
        else if (hits.length > 1) out.set(s, { error: `captureId ${s.captureId} is in ${hits.length} files (${hits.join(', ')}) — a bundle was copied, and nothing says which was reviewed` });
        else if (!hits.length) out.set(s, { error: `no bundle in ${dir} carries captureId ${s.captureId}` });
        else out.set(s, { path: `${dir}/${hits[0]}`, ...(hits[0] === s.file ? {} : { renamedFrom: s.file }) });
    }
    return out;
}

const US = String.fromCharCode(31);
export const rowKey = r => `${r.book ?? ''}${US}${r.uid}`;

/**
 * One section's human verdicts appended onto one scene's rows, keyed by book+uid; a row the review does not mention, or mentions with no `grade`, is left alone. Same rater, same day is one pass and appends nothing — the repeat rule grade-pending applies to a judge.
 * @param {{user?: string, now?: string, tool?: string}} [who] The reviewer, when, and what produced the file
 * @returns {{grades: object[], added: number, changed: number, untouched: number}}
 */
export function mergeReview(bundleGrades, sectionGrades, who = {}) {
    const by = new Map((bundleGrades ?? []).map(g => [rowKey(g), g]));
    let added = 0, changed = 0;
    for (const raw of sectionGrades ?? []) {
        // entryText is dropped: a copy on the row goes stale the moment the entry is edited.
        const { entryText, grade, why, llmGrade, llmGrades, humanGrades, grades: _g, by: _by, at: _at, world, ...rest } = raw;
        const r = { ...rest, book: rest.book ?? world };
        if (!Number.isFinite(Number(grade))) continue;
        const verdict = {
            kind: 'human',
            ...(who.user ? { id: who.user } : {}),
            // params.tool: without it a batch of review verdicts reads as an llm pass's (G9).
            ...(who.tool ? { params: { tool: who.tool } } : {}),
            grade: Number(grade),
            ...(who.now ? { gradedAt: who.now } : {}),
            ...(why ? { why } : {}),
        };
        const k = rowKey(r);
        const prior = by.get(k);
        if (!prior) { added++; by.set(k, { ...r, grades: [verdict] }); continue; }
        if ((prior.grades ?? []).some(v => v.kind === 'human' && passKey(v) === passKey(verdict))) continue;
        // A new row, never a mutated one: a second merge over the same openBundle rows would otherwise see this run's verdict as prior state.
        by.set(k, { ...prior, grades: [...(prior.grades ?? []), verdict] });
        changed++;
    }
    const grades = [...by.values()];
    return { grades, added, changed, untouched: grades.length - added - changed };
}

// argv is read here, not at module scope: the check imports mergeReview, and a usage guard would exit it.
if (import.meta.url === `file://${process.argv[1]}`) {
    const argv = process.argv.slice(2);
    const WRITE = argv.includes('--write');
    const RAN_AT = new Date().toISOString();   // fallback only: two reviews applied in one invocation would share it and collapse into one pass
    const DATA = resolvePath(arg(argv, '--data', resolvePath(HERE, '..', 'eval-data')));
    const VALUE_FLAGS = new Set(['--data', '--user']);   // every flag that takes a value, or its value is read as the positional
    const named = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
    const newestReview = () => {
        const dirs = [DATA, process.env.HOME ? `${process.env.HOME}/Downloads` : null, process.cwd()].filter(Boolean);
        let best = null;
        for (const d of dirs) {
            let names; try { names = readdirSync(d); } catch { continue; }
            for (const f of names.filter(x => /^review-.*\.json$/.test(x))) {
                const full = `${d}/${f}`;
                const at = statSync(full).mtimeMs;
                if (!best || at > best.at) best = { full, at };
            }
        }
        return best?.full ?? null;
    };
    const REVIEW = named ?? newestReview();
    if (!REVIEW) {
        console.error(`no review-*.json found in ${DATA}, ~/Downloads or the working directory`);
        console.error('usage: node eval/synthetic-data/apply-review.mjs [review.json] [--data <dir>] [--write]');
        process.exit(2);
    }
    if (!named) console.log(`using ${REVIEW}`);
    const review = JSON.parse(readFileSync(resolvePath(REVIEW), 'utf8'));
    // No empty default: a verdict signed as nobody is neither attributable nor idempotent.
    const USER = arg(argv, '--user', review.user ?? '');
    if (!USER) {
        console.error(`${REVIEW} records no rater, and one cannot be inferred — pass --user <your rater id>`);
        console.error('  it is the `user` field of a bundle your own /wa-grade produced');
        process.exit(2);
    }
    const sections = review.reviewed ?? [];
    if (!Array.isArray(sections) || !sections.length) {
        console.error(`${REVIEW} carries no "reviewed" sections`);
        process.exit(2);
    }
    let touched = 0, missing = 0, totalHuman = 0;
    const where = resolveSections(sections, DATA);
    for (const s of sections) {
        const at = where.get(s);
        if (at.error) { console.log(`  UNRESOLVED ${at.error}`); missing++; continue; }
        const path = at.path;
        if (at.renamedFrom) console.log(`  "${at.renamedFrom}" is now ${basename(path)} — resolved by captureId`);
        const bundle = JSON.parse(readFileSync(path, 'utf8'));
        const { grades, added, changed, untouched } = mergeReview(openBundle(bundle).entries, s.grades, { user: USER, now: review.reviewedAt ?? RAN_AT, tool: review.createdBy ?? 'wa-super-eval' });
        const human = (s.grades ?? []).filter(g => g.grade !== undefined).length;
        totalHuman += human;
        console.log(`${WRITE ? 'wrote' : 'would write'} ${String(changed).padStart(3)} changed, ${String(added).padStart(3)} added, ${String(untouched).padStart(4)} untouched  (${human} human-graded)  ${basename(path)}`);
        if (WRITE) writeFileSync(path, JSON.stringify(setGrades(bundle, grades), null, 1));
        touched++;
    }
    console.log(`\n${touched} bundles, ${totalHuman} human grades${missing ? `, ${missing} unresolved` : ''}`);
    if (!WRITE) console.log('dry run — re-run with --write');
    process.exit(missing ? 1 : 0);
}
