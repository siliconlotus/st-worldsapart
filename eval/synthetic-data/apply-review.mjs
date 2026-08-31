// apply-review.mjs — writes a /wa-super-eval multi-scene review back into eval-data.
//
// The review file is a list of {captureId, file, grades}: which bundle it came from and that section's
// rows. Resolution is BY ID — a basename is a name a user may change, and a review that lands on the wrong
// bundle is not recoverable, since the grades look native once written.
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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';

/** Enough of a document to hold everything ahead of the bulk. `captureId` is the second key. */
const HEAD_BYTES = 4096;
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBundle, passKey, setGrades } from '../../extension/grading.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where a review section's bundle is, BY CAPTURE ID AND NOTHING ELSE.
 *
 * There is no fallback to `file`, and that is the point. A basename is a name a user may change, and worse,
 * a name that EXISTS is not evidence it is the right bundle: two captures of one turn under different books
 * share both basename and scene id, and the corpus has such a pair. Falling back to a name that resolves is
 * exactly the mis-landing the id was introduced to prevent, and a mis-landed review is not recoverable —
 * the grades look native once written. So an unresolvable section refuses and the run reports it.
 *
 * READ FROM THE HEAD. `captureId` is the second key a writer emits, ahead of the bulk, which is what the
 * schema's field-order rule is for. A head read is ~30x cheaper than parsing every document whole and
 * finds the same ids (G14).
 *
 * @param {Array<{captureId?: string, file?: string}>} sections The review's sections
 * @param {string} dir eval-data
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
            // A DOCUMENT, not any JSON that mentions an id. eval-data also holds review files, `*-pending`
            // lists and whatever else, and a review carries its sections' captureIds — which the scan
            // matched, so a review sitting beside its own bundles made every one of them ambiguous.
            // `schemaVersion` is the first key a writer emits, so the opening brace settles it.
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
 * @param {{user?: string, now?: string, tool?: string}} [who] The reviewer, when, and what produced the file
 * @returns {{grades: object[], added: number, changed: number, untouched: number}}
 */
export function mergeReview(bundleGrades, sectionGrades, who = {}) {
    const by = new Map((bundleGrades ?? []).map(g => [rowKey(g), g]));
    let added = 0, changed = 0;
    for (const raw of sectionGrades ?? []) {
        // `entryText` travels in the review so a section reads standalone; the books already hold the
        // entry, and a duplicate on the row goes stale silently.
        const { entryText, grade, why, llmGrade, llmGrades, humanGrades, grades: _g, by: _by, at: _at, world, ...rest } = raw;
        const r = { ...rest, book: rest.book ?? world };
        if (!Number.isFinite(Number(grade))) continue;
        const verdict = {
            kind: 'human',
            ...(who.user ? { id: who.user } : {}),
            // WHICH TOOL PRODUCED IT. A human grade can arrive three ways — `/wa-grade`, a merge from
            // `/wa-super-grade`, or `/wa-super-eval` writing a review back — and nothing on a verdict used
            // to say which. That absence is what let a batch of review verdicts be read as an llm
            // pass's (G9), because the only signal left was the document's creator, and a synth document
            // has no human path of its own. It is provenance of the pass, so it rides with the rest of it.
            ...(who.tool ? { params: { tool: who.tool } } : {}),
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
    // WHEN THE HUMAN REVIEWED, taken from the review file. This tool's own run time is a FALLBACK and a
    // poor one: a review applied a week later would record the verdict as passed then, and two reviews
    // applied in one invocation would share a stamp and collapse into one pass.
    const RAN_AT = new Date().toISOString();
    const DATA = resolvePath(arg('--data', resolvePath(HERE, '..', 'eval-data')));
    // No arguments is the normal case: the newest review-*.json across eval-data, Downloads and the cwd.
    // A FLAG'S VALUE IS NOT A POSITIONAL. `--user <uuid>` read the uuid as the review path until this
    // listed every flag that takes one; `--data` alone was special-cased, which is how the next flag added
    // reintroduces it.
    const VALUE_FLAGS = new Set(['--data', '--user']);
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
    // WHO PASSED THESE VERDICTS, off the review itself — /wa-super-eval knows and now records it. `--user`
    // overrides for a review exported before it did; there is no empty default, because a verdict signed as
    // nobody is neither attributable nor idempotent (its pass key is rater + instant, so it matches nothing
    // and the whole review appends again on the next run).
    const USER = arg('--user', review.user ?? '');
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
