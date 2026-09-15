// Stage-2 recursion in eval/scene.mjs: the fixpoint's admissions, the depth each entry is reached at, and the
// gates that decide who feeds it and who it may not reach. Hand-written vectors; recursion off is the default.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScene, makeCandidateSet, sceneParams } from '../eval/scene.mjs';
import { eq } from '../eval/metrics.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'wa-recurse-'));
const INDEX = join(DIR, 'index.json');
writeFileSync(INDEX, JSON.stringify({ version: 1, metadata_config: {}, items: [{ id: 'i1', metadata: { hash: 1, text: 'anchor', index: 1 }, vector: [1, 0, 0], norm: 1 }] }));

const entry = (uid, key, content, extra = {}) => ({ world: 'B', uid, comment: `E${uid}`, key, content, ...extra });
const S = {
    primaryBook: 'B',
    embedModel: 'check-embed',
    books: {
        B: {
            // The chain: chat names only "workshop", and each content carries the next link's only key.
            1: entry(1, ['workshop'], 'The workshop rafters shelter a duskmoth colony.'),
            2: entry(2, ['duskmoth'], 'The duskmoth is drawn to vellumwing blossom.'),
            3: entry(3, ['vellumwing'], 'A vellumwing opens at full dark. Sedgewhistle marks the hour.', { preventRecursion: true }),
            4: entry(4, ['sedgewhistle'], 'Heard once, and not again.'),
            5: entry(5, ['duskmoth'], 'Non-recursable.', { excludeRecursion: true }),
            6: entry(6, ['midnight'], 'The lamps stay warm past midnight.', { delayUntilRecursion: true }),
        },
    },
    params: { threshold: -1 },
    grades: [], candidates: [],
};

const HAY = ['Morning light suits the workshop, and the lamps stay warm past midnight.'];
const run = (overrides = {}) => {
    const P = sceneParams(S, { denseAllEntries: false, centroidPopulation: 'vectorized', ...overrides });
    const rows = makeCandidateSet({ ...loadScene(structuredClone(S), { indexFile: INDEX, params: P }), params: P })(
        2, 0.75, null, [0, 1, 0], 'nothing', () => HAY);
    return new Map(rows.map(r => [r.uid, r]));
};

// --- recursion off: the default, and what every capture predating the fixpoint was made under.
{
    const r = run();
    eq([...r.keys()].sort().join(','), '1', 'only the chat match is admitted; nothing recurses');
    eq(r.has(6), false, 'a delayUntilRecursion entry is unreachable with recursion off, even with its key in the chat');
    eq(r.get(1).triggerDepth, 0, 'a chat match is depth 0');
}

// --- recursion on.
{
    const r = run({ recursive: true });
    eq([...r.keys()].sort((a, b) => a - b).join(','), '1,2,3,6', 'the chain runs to its end, and the delayed entry joins it');
    eq(r.get(2).triggerDepth, 1, 'uid 2 is reached through uid 1\'s content');
    eq(r.get(3).triggerDepth, 2, 'uid 3 through uid 2\'s, so one pass deeper');
    eq(r.get(6).triggerDepth, 1, 'the delayed entry matches the CHAT, but not until a recursion pass exists');
    eq(r.has(5), false, 'excludeRecursion: the buffer carries "duskmoth" and it is still not admitted');
    eq(r.has(4), false, 'preventRecursion: uid 3 is admitted but its content never enters the buffer');
}

// --- the depth weight, against the same match scored at depth 0.
{
    const on = run({ recursive: true });
    eq(on.get(2).keywordScore > 0 && on.get(2).keywordScore < on.get(1).keywordScore, true,
        'a depth-1 hit is worth less than the depth-0 hit that reached it');
    eq(on.get(3).keywordScore < on.get(2).keywordScore, true, 'and a depth-2 hit less again');
}

// --- an entry does not name itself through the buffer.
{
    // uid 1 matches on "workshop" from chat and its own content is the first thing in the buffer; "workshop"
    // appears there too, so scoring it against its own feed would count the same key twice.
    const off = run();
    const on = run({ recursive: true });
    eq(on.get(1).keywordScore, off.get(1).keywordScore,
        'the entry that seeded the buffer scores exactly what it scored from chat alone');
    eq(/workshop/.test(S.books.B[1].content), true, 'and its own content really does repeat its key — the premise of that claim');
}

// --- the step cap.
{
    const r = run({ recursive: true, maxRecursionSteps: 1 });
    eq([...r.keys()].sort((a, b) => a - b).join(','), '1,2,6', 'one pass only: uid 3 needs a second');
}

rmSync(DIR, { recursive: true, force: true });
console.log('ok   recursion fixpoint: admissions, depths, and the feed/reach gates');
