// buildKeyPruneScan's near-duplicate flag. Synthetic, so it runs without the corpus — the shapes are
// taken from the real instances: one scene summarized twice (Sommers 197/198), an arc that overlaps a
// scene it contains (Time Whore, must NOT flag), and two arc entries with the same text (Isekai
// Adventure, must flag).
import { buildKeyPruneScan, KEY_DUPE_MIN } from '../extension/keyword-core.mjs';
import { eq } from './metrics.mjs';

const OPTS = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true,
    pruneUnattested: false, pruneCommon: false, pruneShort: false, pruneShared: false, pruneFragment: false,
    ignoreProper: false, bookCommon: 0.5, minLength: 4, bookShared: 0.75 };

// Rare tokens only — the flag ignores anything the English table calls common, so filler must be rare
// too or it counts as neither shared nor distinguishing.
const rare = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}zzq${i}`).join(' ');
const body = (shared, own) => `${rare('shared', shared)} ${rare('own' + own, 40)} ${'padding text here. '.repeat(12)}`;

const mk = es => ({ entries: Object.fromEntries(es.map((e, i) => [String(i), { uid: i, comment: '', content: '', key: [], ...e }])) });

// --- one scene written twice: heavy shared vocabulary, both flagged, symmetrically ---
let scan = buildKeyPruneScan(mk([
    { comment: '180 - Integration Breakfast', content: body(60, 'a') },
    { comment: '181 - Autopilot', content: body(60, 'a') },
    { comment: '999 - Unrelated', content: body(0, 'c') },
]), OPTS, new Set());
eq(scan.dupes.get(0)?.length, 1, 'a near-duplicate pair is flagged');
eq(scan.dupes.get(1)?.[0].uid, 0, 'and it is flagged on both sides, not just the first');
eq(scan.dupes.has(2), false, 'an unrelated entry is not flagged');
eq(scan.dupes.get(0)[0].sim >= KEY_DUPE_MIN, true, 'reported similarity clears the threshold');

// --- an arc and a scene it contains: overlapping by construction, both wanted, must not flag ---
scan = buildKeyPruneScan(mk([
    { comment: 'ARC 10 — Return from the Marches', content: body(60, 'a') },
    { comment: '089 - Warm Valley Revelry', content: body(60, 'a') },
]), OPTS, new Set());
eq(scan.dupes.size, 0, 'arc vs member scene is hierarchy, not duplication');

// --- stmbArc flag, for books where the title carries no ARC prefix ---
scan = buildKeyPruneScan(mk([
    { comment: 'The Bali Trip', stmbArc: true, content: body(60, 'a') },
    { comment: '176 - Villa Victory Party', content: body(60, 'a') },
]), OPTS, new Set());
eq(scan.dupes.size, 0, 'stmbArc is honoured when the title does not say ARC');

// --- two arc entries with the same text: same level, so still a duplicate ---
scan = buildKeyPruneScan(mk([
    { comment: 'Arc 05: Tarn\'s Return', content: body(60, 'a') },
    { comment: 'Arc 05 - Tarn\'s Return', content: body(60, 'a') },
]), OPTS, new Set());
eq(scan.dupes.size, 2, 'arc vs arc is a real duplicate');

// --- short entries are skipped: a stub pair must not read as identical ---
scan = buildKeyPruneScan(mk([
    { comment: 'stub a', content: 'tiny' },
    { comment: 'stub b', content: 'tiny' },
]), OPTS, new Set());
eq(scan.dupes.size, 0, 'entries under the length floor are not compared');

// --- disabled twins are still reported, and marked, since that is how a handled pair reads ---
scan = buildKeyPruneScan(mk([
    { comment: 'kept', content: body(60, 'a') },
    { comment: 'retired', disable: true, content: body(60, 'a') },
]), OPTS, new Set());
eq(scan.dupes.get(0)?.[0].disabled, true, 'a disabled twin is flagged as disabled, not hidden');

console.log('dupe-check: ok');
