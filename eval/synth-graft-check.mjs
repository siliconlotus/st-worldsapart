// synth-graft-check.mjs — the guards on deriving a bundle and putting old judgements back on it.
//
// Both tools are run as PROCESSES against fixtures on disk, not by importing pieces of them. What is being
// checked is a refusal, and a refusal that has been lifted out of its script is no longer the thing that
// refuses — the predecessor's equivalent was verified by a person pointing it at the wrong file by hand,
// which is exactly as durable as it sounds.
//
// The scene guard is the one that matters. A grade is a verdict about a (scene, entry) pair, and the entry
// half fails loudly on its own — a wrong uid matches nothing. The scene half is the half that can be wrong
// while looking right, because two bundles can name the same message id and hold different turns.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'wa-synth-check-'));
let bad = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) bad++; };

/** Runs a tool the way a person would. Returns exit code and combined output rather than throwing. */
function run(script, args, env = {}) {
    try {
        const out = execFileSync('node', [join(HERE, script), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
}

const WORLD = 'Check Book';
const entry = (uid, comment, extra = {}) => ({ uid, comment, content: `content of ${comment}`, key: [], vectorized: true, ...extra });
/** Titles follow the corpus convention the repair rule reads: numbered or ARC + number is memory. */
const ENTRIES = {
    1: entry(1, '001 - First Memory'),
    2: entry(2, '002 - Second Memory'),
    3: entry(3, 'Aldric — Full Entry'),                       // reference tier: no number, no marker
    4: entry(4, '004 - Disabled Memory', { disable: true }),
    5: entry(5, '005 - Pinned Memory', { constant: true }),
    6: entry(6, '006 - Never Surfaced'),
};
const candidate = (uid, i) => ({ title: ENTRIES[uid].comment, uid, world: WORLD, '#': i, score: 1 - i / 10, cosine: 0.5, keys: null });

const bundle = (name, { query = 'Q', scanText = 'S', depth = 10, cands = [1, 2, 3], grades = null, world = WORLD } = {}) => {
    const books = { [world]: Object.fromEntries(Object.entries(ENTRIES).map(([k, e]) => [k, { ...e, world }])) };
    const b = {
        name, books, bookMode: 'full', chat: 'data/chat.jsonl', population: 'ranked',
        arms: [{
            arm: 'shipped', query, scanText, depth, primaryBook: world, captureParams: {},
            candidates: cands.map((u, i) => ({ ...candidate(u, i), world })),
        }],
    };
    // A uid with no entry is deliberate: it is the "deleted from the book" orphan reason.
    if (grades) { b.grades = grades.map(([uid, grade]) => ({ uid, grade, title: ENTRIES[uid]?.comment ?? `gone-${uid}`, world })); b.gradeScale = 4; b.createdBy = 'a-judge'; }
    return b;
};
const put = (file, obj) => { const p = join(TMP, file); writeFileSync(p, JSON.stringify(obj)); return p; };

// --- graft: the scene guard -----------------------------------------------------------------------------
const graded = put('graded.json', bundle('scene', { grades: [[1, 4], [2, 0], [3, 0]] }));

const same = put('same.json', bundle('scene'));
let r = run('graft-grades.mjs', [same, '--from', graded]);
ok(r.code === 0 && /same\.json\s+3\s+0\s/.test(r.out), 'a matching scene grafts every grade, with no orphans');
ok(!r.out.includes('REFUSED'), 'a matching scene is not refused');

for (const [field, over] of [['query', { query: 'different' }], ['scanText', { scanText: 'different' }], ['depth', { depth: 5 }]]) {
    const f = put(`diff-${field}.json`, bundle('scene', over));
    const res = run('graft-grades.mjs', [f, '--from', graded]);
    ok(res.code !== 0 && res.out.includes('REFUSED') && res.out.includes(field),
        `a scene differing only in ${field} is refused, and ${field} is named`);
}

// --- graft: the entry half ------------------------------------------------------------------------------
r = run('graft-grades.mjs', [same, '--from', graded, '--write']);
const written = JSON.parse(readFileSync(same, 'utf8'));
ok(written.grades?.length === 3, 'grades are carried onto the fresh bundle');
ok(written.gradeScale === 4 && written.grading?.by === 'a-judge', 'grading provenance travels with the grades, not with the generation');
ok(written.grading?.graftedAt && written.createdBy !== 'a-judge', 'generation provenance is not overwritten by grading provenance');
ok(existsSync(same.replace(/\.json$/, '-pending.json')), 'uncovered rows are written as -pending.json');

// --- graft: a renamed world ------------------------------------------------------------------------------
// rowKey is world+uid, so a book renamed between grading and generation orphans every grade while the uids
// still line up perfectly. That is why the mapping is explicit: "the uids overlap" is also true of a
// wrong-book control, and a uid-only fallback would graft one silently.
const renamed = put('renamed.json', bundle('scene', { world: 'New Name' }));
r = run('graft-grades.mjs', [renamed, '--from', graded]);
ok(r.code === 0 && /\s+0\s+3\s/.test(r.out), 'without --rename-world a renamed book orphans every grade');
r = run('graft-grades.mjs', [renamed, '--from', graded, '--rename-world', `${WORLD}=New Name`]);
ok(r.out.includes(' 3 ') && !r.out.includes('REFUSED'), 'with --rename-world the same grades land');
r = run('graft-grades.mjs', [renamed, '--from', graded, '--rename-world', 'no-equals-sign']);
ok(r.code !== 0, 'a malformed --rename-world is refused rather than ignored');

// --- graft: orphans are classified, not counted -----------------------------------------------------------
// Only "rankable, but nothing surfaced it" says the population moved; the others are classification facts
// about the entry and carry no information about retrieval.
const wide = put('wide.json', bundle('scene', { cands: [1, 2] }));
const wideGrades = put('wide-graded.json', bundle('scene', { grades: [[1, 4], [3, 0], [4, 2], [5, 3], [6, 3], [99, 1]] }));
r = run('graft-grades.mjs', [wide, '--from', wideGrades]);
for (const reason of ['reference tier', 'disabled', 'durable', 'uid gone from the world', 'rankable, but nothing surfaced it']) {
    ok(r.out.includes(reason), `orphan reason reported: ${reason}`);
}
ok(/rankable, but nothing surfaced it\s+<</.test(r.out), 'the one reason that means retrieval moved is flagged');
ok(r.out.includes('006 - Never Surfaced'), 'and that reason names its rows, while the others are counted');

// --- synth: the guards that run before anything is embedded ------------------------------------------------
const ROOT = join(TMP, 'st');
mkdirSync(join(ROOT, 'data/default-user/worlds'), { recursive: true });
mkdirSync(join(ROOT, 'data/default-user/chats/C'), { recursive: true });
writeFileSync(join(ROOT, 'data/default-user/worlds', `${WORLD}.json`), JSON.stringify({ entries: ENTRIES, name: 'stale name' }));
const msgs = [{ user_name: 'A', character_name: 'B' }, ...Array.from({ length: 80 }, (_, i) => ({ name: 'X', mes: `message ${i}`, is_system: i === 40 }))];
writeFileSync(join(ROOT, 'data/default-user/chats/C/c.jsonl'), msgs.map(m => JSON.stringify(m)).join('\n'));
const ENV = { WA_ST_ROOT: ROOT };
const synth = ['--chat', 'data/default-user/chats/C/c.jsonl', '--book', WORLD];

r = run('synth-scenes.mjs', [...synth, '--msgs', '41'], ENV);
ok(r.code !== 0 && /hidden/.test(r.out), 'a hidden message cannot be a scene, and the refusal says why');
r = run('synth-scenes.mjs', [...synth, '--msgs', '9999'], ENV);
ok(r.code !== 0, 'a message id past the end of the chat is refused');
r = run('synth-scenes.mjs', ['--chat', 'data/default-user/chats/C/c.jsonl', '--book', 'No Such Book', '--msgs', '60'], ENV);
ok(r.code !== 0 && /no world file/.test(r.out), 'a book with no world file is refused by name');

// Sampling is seeded, so a set can be reproduced. Read off the plan line, which prints before any embedding.
const picks = out => (out.match(/generating \d+ scene\(s\) at depth \d+: (.+)/) ?? [])[1];
const a1 = run('synth-scenes.mjs', [...synth, '--n', '3', '--seed', '7'], ENV);
const a2 = run('synth-scenes.mjs', [...synth, '--n', '3', '--seed', '7'], ENV);
const a3 = run('synth-scenes.mjs', [...synth, '--n', '3', '--seed', '8'], ENV);
ok(picks(a1.out) && picks(a1.out) === picks(a2.out), '--seed reproduces a sample exactly');
ok(picks(a3.out) !== picks(a1.out), 'a different seed samples differently');
ok(!/\b(0|1|[1-4][0-9])\b/.test(String(picks(a1.out)).split(', ')[0]) || Number(String(picks(a1.out)).split(', ')[0]) >= 50,
    'a sampled turn has the required history behind it');

// --- synth: the arm table mirrors the one production pools with ---------------------------------------
// worldsapart.js imports ST, so its POOL_ARMS cannot be loaded under node and is read as text. Names only:
// the VALUES are in two vocabularies on purpose — settings there, harness here — which is exactly why the
// mirror needs pinning. A drifted entry derives a differently-configured arm under the right label, and
// nothing downstream can tell.
{
    const SRC = readFileSync(join(HERE, 'synth-scenes.mjs'), 'utf8');
    const WA = readFileSync(join(HERE, '..', 'worldsapart.js'), 'utf8');
    const names = src => (src.match(/POOL_ARMS\s*=\s*\{([\s\S]*?)\n\};/) ?? [, ''])[1]
        .split('\n').map(l => (l.match(/^\s*'?([\w-]+)'?\s*:/) ?? [])[1]).filter(Boolean).sort();
    const live = names(WA), mine = names(SRC);
    ok(live.length > 0, 'POOL_ARMS was found in worldsapart.js');
    ok(mine.join(',') === live.join(','), 'the generator mirrors worldsapart.js POOL_ARMS exactly');
    // captureParams DERIVES commonWordWeight from retrievalMode, so an arm that names the mode alone is
    // silently scored at the wrong weight.
    ok(/'?lexical'?:\s*\{[^}]*commonWordWeight:\s*0\.7/.test(SRC), 'the lexical arm carries commonWordWeight 0.7, as captureParams derives it');
    ok(/'?vector'?:\s*\{[^}]*commonWordWeight:\s*1\b/.test(SRC), '...and the vector arm carries 1');
    ok(/'loose-thr':\s*\{\s*threshold:\s*0\s*\}/.test(SRC), "loose-thr sets `threshold`, the harness spelling of scoreThreshold");
}

process.exit(bad ? 1 : 0);
