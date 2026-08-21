// apply-review.mjs — writes a /wa-super-eval multi-scene review back into eval-data.
//
// The review file is a list of {file, grades}: the bundle it came from and that section's rows.
//
// A HUMAN VERDICT IS ONE OF KIND `human`, and it APPENDS beside whatever an llm said and whatever an
// earlier reviewer said — so a row no human has touched carries only llm verdicts, which is what makes
// "no human has looked at this" readable off the record alone.
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
import { openBundle, passKey, setGrades } from '../../extension/grading.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const US = String.fromCharCode(31);
export const rowKey = r => `${r.book ?? ''}${US}${r.uid}`;

/**
 * One section's human verdicts merged onto one scene's rows, keyed by book+uid.
 *
 * A HUMAN RE-GRADING APPENDS; NOTHING OVERWRITES. The reviewer's verdict joins `grades` beside
 * whatever a judge said and whatever an earlier reviewer said, because the file holds the record and the
 * reader decides which verdict counts. The old rule replaced the whole row, which is what a stored scalar
 * forces you to do — with a verdict array there is nothing to go stale, so nothing to overwrite.
 *
 * Rows the review does not mention are left alone: absence is not a grade. A row it mentions with no
 * `grade` is the same absence and is skipped too.
 *
 * NOTHING IS EVER OVERWRITTEN, so the only question is what counts as a REPEAT. Same rater, same day is
 * one review pass — re-applying the file must not append a second copy of every verdict in it — and that
 * is the whole of the exemption. A different day is a person looking again, which is an event even when
 * they land on the same grade; a different rater is a second opinion. Both append. It is the same rule
 * grade-pending.mjs applies to a judge (rubric + model + day), so the two writers agree about what a
 * repeated pass is.
 *
 * @param {object[]} bundleGrades Rows as openBundle hands them out
 * @param {object[]} sectionGrades The review section's rows
 * @param {{user?: string, now?: string}} [who] The reviewer, as v3 names them
 * @returns {{grades: object[], added: number, changed: number, untouched: number}}
 */
export function mergeReview(bundleGrades, sectionGrades, who = {}) {
    const by = new Map((bundleGrades ?? []).map(g => [rowKey(g), g]));
    let added = 0, changed = 0;
    for (const raw of sectionGrades ?? []) {
        // `entryText` travels in the review so a section reads standalone; the books already hold the
        // entry, and a duplicate on the row goes stale silently.
        const { entryText, grade, why, llmGrade, llmGrades, humanGrades, grades: _g, by: _by, at: _at, ...r } = raw;
        if (!Number.isFinite(Number(grade))) continue;
        const verdict = {
            kind: 'human',
            ...(who.user ? { id: who.user } : {}),
            grade: Number(grade),
            ...(who.now ? { gradedAt: who.now } : {}),
            ...(why ? { why } : {}),
        };
        const k = rowKey(r);
        const prior = by.get(k);
        if (!prior) { added++; by.set(k, { ...r, grades: [verdict] }); continue; }
        if ((prior.grades ?? []).some(v => v.kind === 'human' && passKey(v) === passKey(verdict))) continue;
        // A NEW ROW, never a mutated one: the caller's rows come straight out of openBundle and a second
        // merge over the same input would otherwise see this run's verdict as prior state.
        by.set(k, { ...prior, grades: [...(prior.grades ?? []), verdict] });
        changed++;
    }
    const grades = [...by.values()];
    return { grades, added, changed, untouched: grades.length - added - changed };
}

// argv is read here, not at module scope: the check imports mergeReview, and a usage guard would exit it.
if (import.meta.url === `file://${process.argv[1]}`) {
    const argv = process.argv.slice(2);
    const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
    const WRITE = argv.includes('--write');
    // WHO REVIEWED, as v3 names a rater: the ST handle AND the host, because almost nobody changes
    // `default-user` and two people's verdicts would otherwise read as one person's.
    const USER = arg('--user', 'default-user@hephaestus');
    // WHEN THE HUMAN REVIEWED, taken from the review file. This tool's own run time is a FALLBACK and a
    // poor one: a review applied a week later would record the verdict as passed then, and two reviews
    // applied in one invocation would share a stamp and collapse into one pass.
    const RAN_AT = new Date().toISOString();
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
        const { grades, added, changed, untouched } = mergeReview(openBundle(bundle).entries, s.grades, { user: USER, now: review.reviewedAt ?? RAN_AT });
        const human = (s.grades ?? []).filter(g => g.grade !== undefined).length;
        totalHuman += human;
        console.log(`${WRITE ? 'wrote' : 'would write'} ${String(changed).padStart(3)} changed, ${String(added).padStart(3)} added, ${String(untouched).padStart(4)} untouched  (${human} human-graded)  ${s.file}`);
        if (WRITE) writeFileSync(path, JSON.stringify(setGrades(bundle, grades), null, 1));
        touched++;
    }
    console.log(`\n${touched} bundles, ${totalHuman} human grades${missing ? `, ${missing} bundles missing` : ''}`);
    if (!WRITE) console.log('dry run — re-run with --write');
    process.exit(missing ? 1 : 0);
}
