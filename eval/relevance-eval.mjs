// Score WA's actual /wa-debug ranking against human relevance grades (0-5) with nDCG.
//
// Unlike the retrieval harnesses, this reads WA's REAL output — no pipeline reimplementation
// — so it stays honest across any chat/lorebook. You grade the titles /wa-debug prints, and
// this scores how well WA ordered them.
//
// Usage (from anywhere):
//   node relevance-eval.mjs <debug.txt> <grades.txt>
//   node relevance-eval.mjs --selftest
//
//   debug.txt  — the /wa-debug "selection candidates" ranking (full pre-cap order, so nDCG grades
//                everything, not just the survivors the "selected" table lists). Best: right-click
//                that console table → Copy object, and paste the JSON array — order is preserved
//                and every title survives intact. A pasted text table also works: rows are read by
//                their leading index cell (title = first quoted cell), so the param-snapshot
//                preamble and header/separator lines are ignored.
//                Scaffolding rows are set aside — constants (JSON `block` column) and sticky-
//                configured references (JSON `sticky` > 0, e.g. character sheets). They're always-
//                on / persist-on-trigger, not chosen by relevance, so grading only the dynamic
//                block keeps nDCG honest. A text paste has neither column, so it grades all rows.
//   grades.txt — one per line: "title substring | grade".  e.g.  Villa Victory Party | 5
//                The title need only be a distinctive substring of the debug title.
//                Lines without '|' are ignored, so you can keep notes in the file.
import { readFileSync } from 'node:fs';

// A row is any line with a true/false (the kept flag) followed by a quoted title. Titles with
// apostrophes come double-quoted (console.table's rule), so match either quote style whole.
function parseDebug(text) {
    // Preferred input: the console's "Copy object" on the candidates array gives clean JSON,
    // already in ranking order — no table-text scraping, so apostrophes, brackets, ampersands
    // and unicode all survive intact.
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) {
        try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr)) {
                return arr
                    .filter(r => r && typeof r.title === 'string' && r.title.trim())
                    .map(r => ({ title: r.title.trim(), kept: true, block: r.block, sticky: r.sticky }));
            }
        } catch { /* not JSON after all — fall through to the text scraper */ }
    }
    // Fallback: a pasted table (box-drawing or tab/space separated). A data row starts with its
    // numeric index cell, then the title as the first quoted cell. Requiring the index prefix
    // skips the /wa-debug param-snapshot preamble, whose lines carry quoted setting values
    // ('hybrid', 'messages', …) that would otherwise be mistaken for titles.
    const rows = [];
    for (const line of text.split('\n')) {
        if (!/^\s*│?\s*\d+\s*(?:│\s*)?['"]/.test(line)) continue;
        const t = line.match(/'([^']*)'|"([^"]*)"/);
        if (!t) continue;
        const title = (t[1] ?? t[2]).trim();
        // No elbow flag in the candidates table and it lists everything ranked, so every row
        // counts as "kept"; nDCG grades the full order regardless.
        if (title) rows.push({ title, kept: true });
    }
    return rows;
}

function parseGrades(text) {
    const g = [];
    for (const line of text.split('\n')) {
        const i = line.lastIndexOf('|');
        if (i < 0) continue;
        const title = line.slice(0, i).trim().replace(/^['"]|['"]$/g, '');
        const grade = Number(line.slice(i + 1).replace(/[^0-9.]/g, ''));
        if (title && Number.isFinite(grade)) g.push({ title, grade });
    }
    return g;
}

// nDCG with graded relevance; ungraded ranked rows count as 0 (standard partial-label rule).
const dcg = (grades, k) => grades.slice(0, k).reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
const ndcg = (grades, k) => dcg(grades, k) / (dcg([...grades].sort((a, b) => b - a), k) || 1);

// Token-subset match: a grade matches a row when every word of the grade title (length >1,
// so "in"/"of" count but stray "s" from an apostrophe doesn't derail it) appears in the row's
// words. Survives apostrophes, punctuation, and extra words that plain substring trips on.
const norm = s => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1);

function score(rows, grades, { quiet = false } = {}) {
    const rowTokens = rows.map(r => new Set(norm(r.title)));
    const used = new Array(rows.length).fill(false);
    for (const g of grades) {
        const gt = norm(g.title);
        const ri = rows.findIndex((r, i) => !used[i] && gt.length && gt.every(t => rowTokens[i].has(t)));
        if (ri >= 0) { used[ri] = true; rows[ri].grade = g.grade; rows[ri].graded = true; g.matched = true; }
    }
    for (const r of rows) if (r.grade === undefined) { r.grade = 0; r.graded = false; }
    const unmatched = grades.filter(g => !g.matched);
    const gradeVec = rows.map(r => r.grade);
    const keptN = rows.filter(r => r.kept).length || rows.length;

    if (!quiet) {
        if (unmatched.length) console.log(`!! ${unmatched.length} grade(s) matched no ranked row: ${unmatched.map(x => `"${x.title}"`).join(', ')}\n`);
        console.log('rank kept grade  title');
        rows.forEach((r, i) => console.log(`${String(i + 1).padStart(4)}  ${r.kept ? ' ✓ ' : '   '}   ${r.graded ? r.grade : '·'}    ${r.title}`));
        console.log(`\nelbow kept top ${keptN}. kept grades: [${rows.filter(r => r.kept).map(r => r.grade).join(', ')}]`);
        const rel = rows.map((r, i) => [r, i]).filter(([r]) => r.grade >= 3);
        const missed = rel.filter(([r]) => !r.kept);
        console.log(`nDCG@5 ${ndcg(gradeVec, 5).toFixed(3)}  @${keptN} ${ndcg(gradeVec, keptN).toFixed(3)}  @all ${ndcg(gradeVec, rows.length).toFixed(3)}`);
        console.log(`precision@${keptN} (grade≥3): ${rows.slice(0, keptN).filter(r => r.grade >= 3).length}/${keptN}`);
        console.log(`relevant (grade≥3) kept: ${rel.length - missed.length}/${rel.length}${missed.length ? ` — missed: ${missed.map(([r, i]) => `${r.title} (#${i + 1})`).join(', ')}` : ''}`);
        const junk = rows.filter(r => r.kept && r.grade === 0);
        console.log(`irrelevant (grade 0) surfaced: ${junk.length}${junk.length ? ` — ${junk.map(r => r.title).join(', ')}` : ' (clean)'}`);
    }
    return { ndcg5: ndcg(gradeVec, 5), ndcgKept: ndcg(gradeVec, keptN), keptN };
}

if (process.argv.includes('--selftest')) {
    // Locks the nDCG math against the hand-verified Vegas-pool case. nDCG@5 is used because it's
    // cutoff-stable — independent of how many rows get pasted or whether a kept flag survives.
    // Rows are in the "selection candidates" shape: title is the first quoted cell.
    const debug = `
0 '179 - Villa Celebration Conclusion' '0.009' 179 1
1 '205 - Dylan: First Steps' '0.008' 205 2
2 '[ARC 020] - The Tattoo Weekend' '0.007' 20 3
3 '176 - Villa Victory Party' '0.006' 176 4
4 '213 - Dylan Move-In Zenith' '0.005' 213 5
5 '212 - Il Cuore Date Night' '0.004' 212 6
6 '181 - Autopilot and Intentionality' '0.003' 181 7
7 "177 - Mitchell's Pile" '0.003' 177 8
8 '149 - Memorial Day Barbecue' '0.002' 149 9
9 '[ARC 009] - The Launch' '0.002' 9 10
10 "178 - Danny's First Time" '0.001' 178 11
11 "243 - Arthur's Patterns" '0.001' 243 12
12 '097 - Gala Costume Fitting' '0.001' 97 13
13 "253 - Court of the Cherubim" '0.001' 253 14
14 '157 - Sinclair Foundation' '0.001' 157 15
15 "055 - Warlord's Reckoning" '0.000' 55 16
16 '168 - DILF-off in Bali' '0.000' 168 17
17 '198 - Camping Trip Arrival' '0.000' 198 18
18 '208 - Sommers Pack Dinner' '0.000' 208 19
19 '115 - Final Inspection' '0.000' 115 20`;
    const grades = `Villa Celebration Conclusion | 5
Dylan: First Steps | 3
Tattoo Weekend | 2
Villa Victory Party | 5
Dylan Move-In | 3
Il Cuore | 1
Autopilot | 2
Mitchell's Pile | 4
Memorial Day | 0
The Launch | 0
Danny's First Time | 4
Arthur's Patterns | 1
Gala Costume | 2
Cherubim | 2
Sinclair | 0
Warlord | 0
DILF-off | 2
Camping Trip | 1
Sommers Pack Dinner | 0
Final Inspection | 0`;
    const { ndcg5 } = score(parseDebug(debug), parseGrades(grades), { quiet: true });
    const ok = Math.abs(ndcg5 - 0.860) < 0.002;
    console.log(`selftest nDCG@5 = ${ndcg5.toFixed(3)} (expect 0.860) — ${ok ? 'ok' : 'FAIL'}`);

    // JSON path: order preserved, tricky titles intact, non-title rows dropped.
    const j = parseDebug(JSON.stringify([{ title: "Mitchell's Pile", block: 'dynamic', sticky: 0 }, { title: 'Jeffrey Sommers', block: 'dynamic', sticky: 1 }, { title: '[ARC 031]', block: 'constant' }, { title: '  ' }, { bogus: 1 }]));
    const jok = j.length === 3 && j[0].sticky === 0 && j[1].sticky === 1 && j[2].block === 'constant';
    const graded = j.filter(r => (r.block === undefined || r.block === 'dynamic') && !(Number(r.sticky) > 0));   // eval's tier filter
    const fok = graded.length === 1 && graded[0].title === "Mitchell's Pile";   // sticky sheet + constant set aside
    console.log(`selftest JSON parse — ${jok ? 'ok' : 'FAIL'} (${j.length} rows) · tier filter — ${fok ? 'ok' : 'FAIL'} (grades ${graded.map(r => r.title).join(', ') || 'none'})`);

    process.exit(ok && jok && fok ? 0 : 1);
}

const [debugPath, gradesPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!debugPath || !gradesPath) {
    console.error('usage: node relevance-eval.mjs <debug.txt> <grades.txt>   (or --selftest)');
    process.exit(2);
}
const parsed = parseDebug(readFileSync(debugPath, 'utf8'));
const grades = parseGrades(readFileSync(gradesPath, 'utf8'));
if (!parsed.length) { console.error('no ranked rows parsed from debug file'); process.exit(1); }
// Grade retrieval only. Scaffolding — constants and sticky-configured references (character
// sheets etc.) — is always-on or persist-on-trigger, not chosen by relevance, so as ungraded 0s
// it'd sink nDCG. Tier on constant (runtime `block`) OR a configured `sticky` value, NOT the
// runtime sticky-active state: a sticky entry reads `block: dynamic` on its keyword-activation
// turn and /wa-debug (a dry run) never arms the effect, so `sticky > 0` is the stable signal.
// A text paste has neither column, so everything is kept.
const rows = parsed.filter(r => (r.block === undefined || r.block === 'dynamic') && !(Number(r.sticky) > 0));
const setAside = parsed.length - rows.length;
if (!rows.length) { console.error('no dynamic (retrieved) rows to grade — is this a constant-only table?'); process.exit(1); }
console.log(`parsed ${parsed.length} rows${setAside ? `, set aside ${setAside} constant/sticky` : ''}; grading ${rows.length} retrieved against ${grades.length} grades\n`);
score(rows, grades);
