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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleSamples, openBundle } from '../extension/grading.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'wa-synth-check-'));
let bad = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) bad++; };

/**
 * Runs a tool the way a person would. Returns exit code and BOTH streams — these tools report refusals and
 * warnings on stderr and results on stdout, so reading one of them makes half their output invisible to a
 * check while it still looks like it passed.
 */
function run(script, args, env = {}) {
    const r = spawnSync('node', [join(HERE, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
const candidate = (uid, i) => ({ title: ENTRIES[uid].comment, uid, book: WORLD, index: i, score: 1 - i / 10, cosine: 0.5, keys: null });

const bundle = async (name, { query = 'Q', scanText = 'S', depth = 10, cands = [1, 2, 3], grades = null, world = WORLD, edit = null } = {}) => {
    const books = { [world]: Object.fromEntries(Object.entries(ENTRIES).map(([k, e]) => [k, { ...e, world }])) };
    if (edit) books[world][edit.uid] = { ...books[world][edit.uid], ...edit.set };
    const sample = {
        name, books, chat: 'data/chat.jsonl', createdAt: '2026-01-01',
        query, scanChat: String(scanText).split('\n\n').map(t => ({ name: 'X', mes: t })), depth, primaryBook: world, params: {},
        candidates: cands.map((u, i) => ({ ...candidate(u, i), book: world })),
        // A uid with no entry is deliberate: it is the "deleted from the book" orphan reason.
        grades: (grades ?? []).map(([uid, grade]) => ({ uid, grade, title: ENTRIES[uid]?.comment ?? `gone-${uid}`, book: world })),
    };
    if (grades) { sample.gradeScale = 4; sample.createdBy = 'a-judge'; }
    // Built through the real assembler rather than by hand, so the fixture cannot drift from the schema the
    // tools read — the whole reason grading.mjs is ST-free.
    return await bundleSamples([{ arm: 'shipped', sample }], { start: 90, end: 99 }, { population: 'ranked' });
};
const put = (file, obj) => { const p = join(TMP, file); writeFileSync(p, JSON.stringify(obj)); return p; };

// --- graft: the entry guard -----------------------------------------------------------------------------
// A book gets edited outside ST between captures, so book+uid can name a row whose TEXT has moved since a
// rater read it. The book hash says whether to look; what decides is the title and content themselves.
{
    const src = put('entry-src.json', await bundle('scene', { grades: [[1, 4], [2, 0], [3, 0]] }));

    const rewrote = put('entry-rewrote.json', await bundle('scene', { edit: { uid: 2, set: { content: 'entirely different text' } } }));
    let e = run('graft-grades.mjs', [rewrote, '--from', src]);
    ok(e.code === 0 && /entry-rewrote\.json\s+2\s+1\s/.test(e.out), 'a rewritten entry orphans its grade and the others still graft');
    ok(e.out.includes('entry text changed since it was graded'), '...under a reason that says the GRADE is stale, not that the entry was unrankable');

    const retitled = put('entry-retitled.json', await bundle('scene', { edit: { uid: 2, set: { comment: '002 - Renamed' } } }));
    ok(/entry-retitled\.json\s+2\s+1\s/.test(run('graft-grades.mjs', [retitled, '--from', src]).out),
        'the title is part of what was graded, so changing it orphans too');

    // THE ONE THAT MATTERS: the book hash differs here, and nothing a rater read has moved. A guard keyed on
    // the book rather than the entry would throw away every grade in the book for one added keyword.
    // A bundle that embeds no entries is malformed, and its grades have no stored text — so nothing can
    // have moved, and comparing against the absence would orphan all of them and blame drift for it.
    const bare = await bundle('scene', { grades: [[1, 4], [2, 0], [3, 0]] });
    bare.books = { [WORLD]: {} }; bare.bookHashes = { [WORLD]: 'empty' };
    const noBook = put('entry-nobook.json', bare);
    const fromBare = run('graft-grades.mjs', [put('entry-plain.json', await bundle('scene')), '--from', noBook]);
    ok(/entry-plain\.json\s+3\s+0\s/.test(fromBare.out),
        'a source embedding no text has nothing to have moved, so its grades still graft');

    const rekeyed = put('entry-rekeyed.json', await bundle('scene', { edit: { uid: 2, set: { key: ['brand', 'new', 'keys'], order: 42 } } }));
    e = run('graft-grades.mjs', [rekeyed, '--from', src]);
    ok(e.code === 0 && /entry-rekeyed\.json\s+3\s+0\s/.test(e.out), 'keys and order are not what a relevance verdict is about, so grades still graft');
}

// --- graft: the scene guard -----------------------------------------------------------------------------
const graded = put('graded.json', await bundle('scene', { grades: [[1, 4], [2, 0], [3, 0]] }));

const same = put('same.json', await bundle('scene'));
let r = run('graft-grades.mjs', [same, '--from', graded]);
ok(r.code === 0 && /same\.json\s+3\s+0\s/.test(r.out), 'a matching scene grafts every grade, with no orphans');
ok(!r.out.includes('REFUSED'), 'a matching scene is not refused');

for (const [field, over] of [['query', { query: 'different' }], ['scanChat', { scanText: 'different' }], ['depth', { depth: 5 }]]) {
    const f = put(`diff-${field}.json`, await bundle('scene', over));
    const res = run('graft-grades.mjs', [f, '--from', graded]);
    ok(res.code !== 0 && res.out.includes('REFUSED') && res.out.includes(field),
        `a scene differing only in ${field} is refused, and ${field} is named`);
}

// --- graft: the whitespace escape, which must not widen into anything else -------------------------------
const ws = put('ws.json', await bundle('scene', { scanText: 'S \nT' }));
const wsSrc = put('ws-graded.json', await bundle('scene', { scanText: 'S\nT', grades: [[1, 4]] }));
ok(run('graft-grades.mjs', [ws, '--from', wsSrc]).code !== 0, 'trailing whitespace still refuses by default');
r = run('graft-grades.mjs', [ws, '--from', wsSrc, '--allow-whitespace-drift']);
ok(r.code === 0 && /whitespace only/.test(r.out), '--allow-whitespace-drift accepts it, and says it did');
// A space in the MIDDLE is a different scene, not drift, and the flag must not reach it.
const mid = put('mid.json', await bundle('scene', { scanText: 'S T' }));
ok(run('graft-grades.mjs', [mid, '--from', wsSrc, '--allow-whitespace-drift']).code !== 0,
    'the flag does not excuse a difference anywhere but at a line end');
r = run('graft-grades.mjs', [ws, '--from', wsSrc, '--allow-whitespace-drift', '--write']);
ok(JSON.parse(readFileSync(ws, 'utf8')).grading?.sceneMatchedIgnoringTrailingWhitespace === true,
    'and the bundle records that its scene matched only under normalisation');

// --- graft: the entry half ------------------------------------------------------------------------------
r = run('graft-grades.mjs', [same, '--from', graded, '--write']);
const written = JSON.parse(readFileSync(same, 'utf8'));
ok(openBundle(written).entries?.length === 3, 'verdicts are carried onto the fresh scene');
ok(written.gradeScale === 4 && written.grading?.by === 'a-judge', 'grading provenance travels with the grades, not with the generation');
ok(written.grading?.graftedAt && written.createdBy !== 'a-judge', 'generation provenance is not overwritten by grading provenance');
ok(existsSync(same.replace(/\.json$/, '-pending.json')), 'uncovered rows are written as -pending.json');

// --- graft: a renamed world ------------------------------------------------------------------------------
// rowKey is world+uid, so a book renamed between grading and generation orphans every grade while the uids
// still line up perfectly. That is why the mapping is explicit: "the uids overlap" is also true of a
// wrong-book control, and a uid-only fallback would graft one silently.
const renamed = put('renamed.json', await bundle('scene', { world: 'New Name' }));
r = run('graft-grades.mjs', [renamed, '--from', graded]);
ok(r.code === 0 && /\s+0\s+3\s/.test(r.out), 'without --rename-book a renamed book orphans every grade');
r = run('graft-grades.mjs', [renamed, '--from', graded, '--rename-book', `${WORLD}=New Name`]);
ok(r.out.includes(' 3 ') && !r.out.includes('REFUSED'), 'with --rename-book the same grades land');
r = run('graft-grades.mjs', [renamed, '--from', graded, '--rename-book', 'no-equals-sign']);
ok(r.code !== 0, 'a malformed --rename-book is refused rather than ignored');

// --- graft: orphans are classified, not counted -----------------------------------------------------------
// Only "rankable, but nothing surfaced it" says the population moved; the others are classification facts
// about the entry and carry no information about retrieval.
const wide = put('wide.json', await bundle('scene', { cands: [1, 2] }));
const wideGrades = put('wide-graded.json', await bundle('scene', { grades: [[1, 4], [3, 0], [4, 2], [5, 3], [6, 3], [99, 1]] }));
r = run('graft-grades.mjs', [wide, '--from', wideGrades]);
for (const reason of ['reference tier', 'disabled', 'durable', 'uid gone from the book', 'rankable, but nothing surfaced it']) {
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
}

process.exit(bad ? 1 : 0);
