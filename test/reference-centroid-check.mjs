// Self-check for the referenceCentroid arms: the reference tier's stage-3 cosine under each centring, memory rows and stage 1 untouched. Hand-written vectors.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScene, makeCandidateSet, sceneParams } from '../eval/scene.mjs';
import { eq } from '../eval/metrics.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'wa-refcent-'));
// 1, 2 memory; 3, 4 reference. Reference items share a component (+z) memory items do not.
const vec = { 1: [1, 0, 0], 2: [0, 1, 0], 3: [1, 0, 1], 4: [0, 1, 1] };
const item = uid => ({ id: `i${uid}`, metadata: { hash: uid, text: `text of entry ${uid}`, index: uid }, vector: vec[uid], norm: 1 });
const INDEX = join(DIR, 'all.json');
writeFileSync(INDEX, JSON.stringify({ version: 1, metadata_config: {}, items: [1, 2, 3, 4].map(item) }));

const entry = (uid, extra) => ({ world: 'B', uid, comment: `E${uid}`, content: `text of entry ${uid}`, key: [], vectorized: true, ...extra });
const S = {
    primaryBook: 'B', embedModel: 'check-embed',
    books: { B: { 1: entry(1, { STMB_start: 1 }), 2: entry(2, { STMB_start: 2 }), 3: entry(3), 4: entry(4) } },
    params: { threshold: -1 }, grades: [], candidates: [],
};
const QV = [1, 0, 0];
const rowsOf = overrides => {
    const P = sceneParams(S, { denseAllEntries: true, ...overrides });
    const scene = loadScene(S, { indexFile: INDEX, params: P });
    const rows = makeCandidateSet({ ...scene, params: P })(2, 0.75, null, QV, 'text of entry', () => ['nothing here']);
    return new Map(rows.map(r => [r.uid, r.score]));
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cos = (a, b) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mMem = [0.5, 0.5, 0], mRef = [0.5, 0.5, 1];
const near = (a, b, msg) => eq(Math.abs(a - b) < 1e-12, true, `${msg} (${a} vs ${b})`);

const base = rowsOf({});
const asRef = rowsOf({ referenceCentroid: 'reference' });
const cross = rowsOf({ referenceCentroid: 'cross' });
const raw = rowsOf({ referenceCentroid: 'raw' });

near(base.get(3), cos(sub(QV, mMem), sub(vec[3], mMem)), 'production: a reference row is centred on the memory mean');
for (const uid of [1, 2]) for (const [name, m] of [['reference', asRef], ['cross', cross], ['raw', raw]]) eq(m.get(uid), base.get(uid), `${name}: memory row ${uid} keeps its cosine`);
near(asRef.get(3), cos(sub(QV, mRef), sub(vec[3], mRef)), 'reference: both sides on the reference mean');
near(cross.get(3), cos(sub(QV, mMem), sub(vec[3], mRef)), 'cross: query on the memory mean, item on the reference mean');
near(raw.get(4), cos(QV, vec[4]), 'raw: nothing subtracted');
eq([...base.keys()].sort().join(','), [...cross.keys()].sort().join(','), 'a centring admits nothing: the same rows under every arm');
let threw = false;
try { rowsOf({ referenceCentroid: 'sideways' }); } catch { threw = true; }
eq(threw, true, 'an unknown centring throws rather than scoring as production');

rmSync(DIR, { recursive: true, force: true });
console.log(process.exitCode ? 'FAIL' : 'ok');
