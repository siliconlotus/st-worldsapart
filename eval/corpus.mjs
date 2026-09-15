// corpus.mjs — the lorebooks an eval run reads. They are the developer's own, so there is no default:
// `--books A.json,B.json`, or eval-data/books.json, or the run refuses.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** ST's lorebook directory, which every sweep reads its books out of. */
export const WORLDS = `${HERE}../../../../../../data/default-user/worlds`;

/** The roster a developer writes once; gitignored with the rest of eval-data. */
export const ROSTER = `${HERE}eval-data/books.json`;

export const BOOKS_USAGE = `no books. Pass --books A.json,B.json, or write eval/eval-data/books.json:
  ["A.json", { "file": "B.json", "provenance": "manually curated", "slug": "b" }]
Books are read from data/default-user/worlds and are yours, not the repo's.
Only hand-written or curated books can stand as a reference for keyword agreement.`;

/** The label a book goes by in output rows and cache keys: its filename, which is already unique in a directory. */
export const slugOf = file => String(file).replace(/\.json$/i, '').toLowerCase();

/** A roster entry: a bare filename, or a record carrying the curation status eval-data/README.md records.
 *  `slug` overrides the derived label; pin it when results already on disk are keyed by an older one. */
function record(v) {
    const r = typeof v === 'string'
        ? { file: v, provenance: '', slug: '' }
        : { file: v?.file, provenance: v?.provenance ?? '', slug: v?.slug ?? '' };
    if (!r.file || typeof r.file !== 'string' || !r.file.trim()) throw new Error(`a book has no file: ${JSON.stringify(v)}`);
    r.file = r.file.trim();
    return r;
}

/** `[entry…]` -> { slug: { file, provenance } }. Throws on a duplicate slug, which would silently merge two books. */
export function toBooks(list) {
    const out = {};
    for (const v of list) {
        const r = record(v);
        const slug = r.slug || slugOf(r.file);
        delete r.slug;
        if (out[slug]) throw new Error(`two books share the slug "${slug}"`);
        out[slug] = r;
    }
    if (!Object.keys(out).length) throw new Error(BOOKS_USAGE);
    return out;
}

/** slug -> { file, provenance }. Refuses rather than guessing: a book has no knowable default (CLAUDE.md). */
export function evalBooks(argv = process.argv, roster = ROSTER) {
    const i = argv.indexOf('--books');
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        return toBooks(argv[i + 1].split(',').map(s => s.trim()).filter(Boolean));
    }
    if (existsSync(roster)) {
        const list = JSON.parse(readFileSync(roster, 'utf8'));
        if (!Array.isArray(list)) throw new Error(`${roster} must be a list of books`);
        if (list.length) return toBooks(list);
    }
    throw new Error(BOOKS_USAGE);
}

/** For a CLI: the roster, or the usage line and exit 1 — never a stack trace. `evalBooks` throws, so the check can assert on it. */
export function booksOrExit(argv = process.argv) {
    try { return evalBooks(argv); } catch (e) { console.error(e.message); process.exit(1); }
}
