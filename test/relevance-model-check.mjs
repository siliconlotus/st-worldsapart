// relevance-model-check — the stage-4 relevance prediction's pure half (relevance.mjs, selection.mjs relevanceCut).
import { properNames, buildNameDf, properShared, properDensity, scoreRelevance, postDates, modelKey } from '../extension/relevance.mjs';
import { relevanceCut } from '../extension/selection.mjs';
import { eq } from '../eval/lib/metrics.mjs';
import fs from 'node:fs';

// ---- properNames -------------------------------------------------------------------------------

eq([...properNames('Then Maren left. Then she returned.')].sort().join(','), 'maren',
    'a name is a capital that is not sentence-initial');

eq(properNames('We met at Home today.').has('home'), false,
    'a common English word is not counted as a name even mid-sentence');
eq(properNames('We met in London today.').has('london'), true,
    'a proper noun is never stoplisted');

eq(properNames('At Maren’s Gap').has([...properNames("At Maren's Gap")][0]), true,
    'a curly and a straight apostrophe produce the same name');

// ---- buildNameDf -------------------------------------------------------------------------------

const book = [
    { world: 'B', uid: 1, content: 'The camp held Maren and Brackenmoor.' },
    { world: 'B', uid: 2, content: 'A report on Maren.', disable: true },
    { world: 'B', uid: 3, content: '   ' },
    { world: 'B', uid: 4, content: 'Nothing about the patrol at Kesh.' },
];
const idx = buildNameDf(book);

eq(idx.ndoc, 3, 'ndoc counts entries with content, not chunks and not blank entries');
eq(idx.names.has('B.3'), false, 'a contentless entry contributes no name set');

// Disabled entries stay in the corpus (matcher-design.md; F27).
eq(idx.df.get('maren'), 2, 'a disabled entry still contributes to df');
eq(idx.df.get('brackenmoor'), 1, 'a name in one entry has df 1');

// ---- properShared ------------------------------------------------------------------------------

// By hand: ndoc 3; brackenmoor df 1 -> log(4/2), maren df 2 -> log(4/3); kesh is not in the window.
const win = properNames('Smoke rose as Brackenmoor burned while Maren watched.');
const rare = Math.log(4 / 2), common = Math.log(4 / 3);
eq(properShared(idx.names.get('B.1'), win, idx).toFixed(10), (rare + common).toFixed(10),
    'shared names score log((ndoc+1)/(df+1)) each');
eq(rare > common, true, 'a name fewer entries use is worth more');
eq(properShared(idx.names.get('B.4'), win, idx), 0, 'an entry sharing no name with the window scores 0');
eq(properShared(idx.names.get('B.1'), properNames('Brackenmoor burned alone.'), idx), 0,
    'a name only ever sentence-initial in the window is not in the window');

// ---- properDensity -----------------------------------------------------------------------------

// Pinned to a literal, not recomputed from properNames: the same function on both sides passes whatever it does.
eq(properDensity('Word said Maren met Kesh here.').toFixed(4), (200 / 6).toFixed(4),
    'density is names per 100 tokens of the entry');
eq(properDensity(''), 0, 'an empty entry has no density rather than a division by zero');

// ---- scoreRelevance ----------------------------------------------------------------------------

// One feature, two rows: [0, 2] standardises to [-1, +1]; intercept 0, slope 1 at both boundaries.
const toy = { features: ['cosine'], beta: { ge2: [0, 1], ge3: [0, 1] } };
const sig = x => 1 / (1 + Math.exp(-x));
const got = scoreRelevance(toy, [{ cosine: 0 }, { cosine: 2 }]);
eq(got[0].toFixed(10), sig(-1).toFixed(10), 'a row is standardised within the scene, not against a stored scale');
eq(got[1].toFixed(10), sig(1).toFixed(10), 'the high row takes the same curve on the other side');

const alone = scoreRelevance(toy, [{ cosine: 0 }, { cosine: 100 }]);
eq(alone[0].toFixed(10), sig(-1).toFixed(10), 'the scale is the scene\'s own spread, so 0-vs-100 lands where 0-vs-2 did');

const flat = scoreRelevance(toy, [{ cosine: 7 }, { cosine: 7 }]);
eq(flat.every(v => Math.abs(v - sig(0)) < 1e-12), true, 'a within-scene constant column contributes nothing');

// ge3's intercept of 5 would put P(>=3) above P(>=2) on every row.
const inverted = { features: ['cosine'], beta: { ge2: [0, 0], ge3: [5, 0] } };
const clamped = scoreRelevance(inverted, [{ cosine: 1 }, { cosine: 3 }]);
eq(clamped.every(v => Math.abs(v - 0.5) < 1e-12), true, 'P(>=3) is clamped to P(>=2), so E[credit] stays at P(>=2)');

eq(Number.isFinite(scoreRelevance(toy, [{}, { cosine: 1 }])[0]), true, 'a row missing a signal still scores');

let threw = false;
try { scoreRelevance({ features: ['cosine', 'text'], beta: { ge2: [0, 1], ge3: [0, 1] } }, [{ cosine: 1 }, { cosine: 2 }]); }
catch { threw = true; }
eq(threw, true, 'a model whose beta does not match its feature count throws');

// ---- the shipped model file: one fit per embedding model, keyed by modelKey; the contract holds for EVERY entry (E14)

const file = JSON.parse(fs.readFileSync(new URL('../extension/relevance-model-memory.json', import.meta.url), 'utf8'));
eq(file.tier, 'memory', 'the shipped artifact is the memory tier');
eq(Object.keys(file.byModel ?? {}).length > 0, true, 'it carries at least one fit, keyed by embedding model');
eq(Object.keys(file.byModel).every(k => k === modelKey(k)), true,
    'every key is already normalised, so a runtime lookup by modelKey cannot miss on case or a :latest tag');
for (const [key, shipped] of Object.entries(file.byModel)) {
    eq(shipped.tier, 'memory', `${key}: the fit is the memory tier`);
    eq(typeof shipped.embedModel === 'string' && shipped.embedModel.length > 0, true,
        `${key}: the fit names the model spec it was fitted under, so a stray file is self-describing`);
    eq(Array.isArray(shipped.beta?.ge2) && Array.isArray(shipped.beta?.ge3), true,
        `${key}: one coefficient vector per boundary E[credit] is built from`);
    eq(shipped.beta.ge2.length, shipped.features.length + 1, `${key}: ge2 has an intercept plus one slope per feature`);
    eq(shipped.beta.ge3.length, shipped.features.length + 1, `${key}: ge3 has an intercept plus one slope per feature`);
    eq(shipped.layout.join(','), ['intercept', ...shipped.features.map(f => `${f}.z`)].join(','),
        `${key}: layout names the design the coefficients are in, intercept first`);
    eq(shipped.cutoff > 0 && shipped.cutoff < 1, true, `${key}: the operating point ships with the coefficients`);
    eq(shipped.features.includes('properNouns') && shipped.features.includes('density'), true,
        `${key}: the design carries the two signals relevance.mjs computes`);
    const live = scoreRelevance(shipped, [
        Object.fromEntries(shipped.features.map(f => [f, 0])),
        Object.fromEntries(shipped.features.map(f => [f, 1])),
    ]);
    eq(live.every(v => v > 0 && v < 1), true, `${key}: returns a probability for every row`);
    eq(live[1] > live[0], true, `${key}: a row stronger on every signal scores higher, so no sign is inverted`);
}


// ---- the relevance cut -------------------------------------------------------------------------

const cutRows = [
    { t: 'clears',      e: 0.50, tier: 'memory' },
    { t: 'below',       e: 0.02, tier: 'memory' },
    { t: 'exactly-at',  e: 0.10, tier: 'memory' },
    { t: 'unscored',    e: NaN,  tier: 'memory' },
    { t: 'no-fit-tier', e: 0.01, tier: 'nosuch' },
];
const CUTOFFS = { memory: 0.10, reference: 0.17 };
const { kept: cutKept, cut: cutOut } = relevanceCut(cutRows, {
    scoreOf: r => r.e,
    cutoffOf: r => CUTOFFS[r.tier] ?? NaN,
});
eq(cutKept.map(r => r.t).join(','), 'clears,exactly-at,unscored,no-fit-tier',
    'the cut keeps what clears its tier cutoff, and everything it cannot judge');
eq(cutOut.map(r => r.t).join(','), 'below', 'only a row scored below its own tier cutoff is cut');

eq(cutKept.some(r => r.t === 'exactly-at'), true, 'a row exactly at the cutoff is delivered');

const tiered = relevanceCut([{ t: 'm', e: 0.12, tier: 'memory' }, { t: 'r', e: 0.12, tier: 'reference' }],
    { scoreOf: r => r.e, cutoffOf: r => CUTOFFS[r.tier] });
eq(tiered.kept.map(r => r.t).join(','), 'm', 'the same score is delivered on one tier and cut on the other');

eq(cutKept.length + cutOut.length, cutRows.length, 'every row is either kept or cut, never both or neither');


// ---- postDates: what the book had not written yet ------------------------------------------------
eq(postDates({ STMB_start: 90, STMB_end: 110 }, 100), true, 'an entry straddling the turn had not been written');
eq(postDates({ STMB_start: 80, STMB_end: 100 }, 100), true, '...including one ending exactly at it, which needs the turn to have happened');
eq(postDates({ STMB_start: 80, STMB_end: 99 }, 100), false, '...but not one that ends the message before');
eq(postDates({ STMB_start: 10, STMB_end: 40 }, 100), false, 'an entry entirely earlier is available');
eq(postDates({ STMB_start: 150 }, 100), true, 'with no end, a later start still post-dates');
eq(postDates({ STMB_start: 50 }, 100), false, '...and an earlier one does not');
eq(postDates({}, 100), false, 'an entry with no range is available, which is what a reference sheet is');
eq(postDates({ STMB_start: 150 }, NaN), false, 'with no current position nothing is post-dated, so the filter is off rather than total');

// ---- fitsNamed ---------------------------------------------------------------------------------
const { fitsNamed, modelsFor } = await import('../eval/lib/scene.mjs');
const { UNFITTED_FALLBACK } = await import('../extension/relevance.mjs');
eq(fitsNamed('noCosine').memory.features.includes('cosine'), false, 'the noCosine fit carries no cosine feature');
eq(fitsNamed('bge-m3').memory.features.includes('cosine'), true, '...where a model fit does');
eq(fitsNamed('bge-m3').memory === modelsFor('bge-m3').memory, true, 'a name resolves to the same fit the embedding model does');
// The harness refuses an unfitted model and production borrows; the asymmetry is deliberate in both directions.
let unfittedThrew = false;
try { modelsFor('no-such-embedder-anywhere'); } catch { unfittedThrew = true; }
eq(unfittedThrew, true, 'the harness refuses an embedding model it has no fit for');
eq(fitsNamed(UNFITTED_FALLBACK).memory === modelsFor(UNFITTED_FALLBACK).memory, true,
    'the production fallback names a real fit in the shipped artifact');
eq(fitsNamed(UNFITTED_FALLBACK).memory.features.includes('cosine'), true,
    '...and it is cosine-bearing, since an unfitted model still has cosines');

let unknownThrew = false;
try { fitsNamed('no-such-model'); } catch { unknownThrew = true; }
eq(unknownThrew, true, 'an unknown fit name throws rather than resolving to nothing');

console.log('ok');
