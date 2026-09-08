// Runs the genre vocabulary cases (genre-cases.mjs) against the real suggester; a failure prints the whole candidate list.
//   node eval/genre-check.mjs [filter]   filter is a substring match on genre or shape
import { buildKeySuggest } from '../extension/keyword-suggest.mjs';
import { GENRE_CASES, SUGGEST_OPTS, paddedBook } from './genre-cases.mjs';

const filter = process.argv[2]?.toLowerCase();
const cases = filter ? GENRE_CASES.filter(c => (c.genre + ' ' + c.shape).toLowerCase().includes(filter)) : GENRE_CASES;
if (!cases.length) { console.error(`no cases match "${filter}"`); process.exit(2); }

let failed = 0;
for (const c of cases) {
    const s = buildKeySuggest(paddedBook(c.text, c.pad), SUGGEST_OPTS);
    const rows = s.perEntry.find(pe => pe.entry.uid === 0)?.newRows ?? [];
    const terms = rows.map(r => r.term);
    const problems = [];
    for (const t of c.expect ?? []) if (!terms.includes(t)) problems.push(`missing "${t}"`);
    for (const t of c.reject ?? []) if (terms.includes(t)) problems.push(`offered "${t}"`);
    for (const [term, want] of Object.entries(c.display ?? {})) {
        const got = rows.find(r => r.term === term)?.display;
        if (got !== want) problems.push(`display of "${term}" was ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    }
    if (problems.length) {
        failed++;
        console.log(`FAIL  [${c.genre}] ${c.shape}`);
        for (const p of problems) console.log(`        ${p}`);
        console.log(`        offered: ${rows.map(r => r.display).join(' | ') || '(nothing)'}`);
    }
}
const label = `${cases.length} case${cases.length === 1 ? '' : 's'}`;
if (failed) { console.log(`genre-check: ${failed} of ${label} FAILED`); process.exit(1); }
console.log(`genre-check: ok (${label})`);
