// apply-review.mjs — writes a /wa-super-eval multi-scene review back into eval-data.
//
// The review file is a list of {file, grades}: the bundle it came from and that section's rows.
//
// A HUMAN VERDICT IS `grade` AND NOTHING ELSE WRITES IT. Fields are copied across as given, never merged
// or coalesced, so a row a human did not touch keeps its judge verdict and gains no `grade` — which is
// what keeps "no human has looked at this" readable (see split-rater.mjs).
//
// `entryText` is the one field dropped. The review carries it so it can be READ on its own; the bundle
// already has the entry in its books, and a second copy on the grade row is a duplicate that goes stale
// the moment the entry is edited.
//
// The bundle is otherwise untouched: arms, captures, params and books stay byte-identical.
//
// Usage (any cwd):
//   node eval/synthetic-data/apply-review.mjs            # newest review-*.json from ~/Downloads, dry
//   node eval/synthetic-data/apply-review.mjs --write    # ...and apply it
//
// Dry by default: a review that lands on the wrong bundle is not recoverable afterwards, since the
// grades look native once written.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const US = String.fromCharCode(31);
export const rowKey = r => `${r.world ?? ''}${US}${r.uid}`;

/**
 * One section's grades merged onto one bundle's, keyed by world+uid.
 *
 * Rows the review does not mention are left alone — absence is not a grade. Rows it does mention REPLACE
 * their counterpart wholesale: the reviewer had the whole row, and a field-wise merge would keep a stale
 * `why` beside a changed grade.
 *
 * @returns {{grades: object[], added: number, changed: number, untouched: number}}
 */
export function mergeReview(bundleGrades, sectionGrades) {
    const by = new Map((bundleGrades ?? []).map(g => [rowKey(g), g]));
    let added = 0, changed = 0;
    for (const raw of sectionGrades ?? []) {
        const { entryText, ...r } = raw;
        const k = rowKey(r);
        const prior = by.get(k);
        if (!prior) { added++; by.set(k, r); continue; }
        // `grade` is the only field a human writes, so a section row whose grade matches what is already
        // there is not a change even if other fields moved.
        if (prior.grade !== r.grade) changed++;
        by.set(k, r);
    }
    const grades = [...by.values()];
    return { grades, added, changed, untouched: grades.length - added - changed };
}

// argv is read here, not at module scope: the check imports mergeReview, and a usage guard would exit it.
if (import.meta.url === `file://${process.argv[1]}`) {
    const argv = process.argv.slice(2);
    const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
    const WRITE = argv.includes('--write');
    const DATA = resolvePath(arg('--data', resolvePath(HERE, '..', 'eval-data')));
    // No arguments is the normal case: the newest review-*.json across eval-data, Downloads and the cwd.
    const named = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--data');
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
    const sections = review.reviewed ?? [];
    if (!Array.isArray(sections) || !sections.length) {
        console.error(`${REVIEW} carries no "reviewed" sections`);
        process.exit(2);
    }
    let touched = 0, missing = 0, totalHuman = 0;
    for (const s of sections) {
        const path = `${DATA}/${s.file}`;
        if (!existsSync(path)) { console.log(`  MISSING ${s.file} — not in ${DATA}`); missing++; continue; }
        const bundle = JSON.parse(readFileSync(path, 'utf8'));
        const { grades, added, changed, untouched } = mergeReview(bundle.grades, s.grades);
        const human = (s.grades ?? []).filter(g => g.grade !== undefined).length;
        totalHuman += human;
        console.log(`${WRITE ? 'wrote' : 'would write'} ${String(changed).padStart(3)} changed, ${String(added).padStart(3)} added, ${String(untouched).padStart(4)} untouched  (${human} human-graded)  ${s.file}`);
        if (WRITE) writeFileSync(path, JSON.stringify({ ...bundle, grades }, null, 1));
        touched++;
    }
    console.log(`\n${touched} bundles, ${totalHuman} human grades${missing ? `, ${missing} bundles missing` : ''}`);
    if (!WRITE) console.log('dry run — re-run with --write');
    process.exit(missing ? 1 : 0);
}
