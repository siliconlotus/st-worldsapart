// cost-curve.mjs — F2 over the DELIVERED SET against what that set COSTS, for two fitted artefacts.
//
// WHY A CURVE AND NOT A SCORE. Stage 4's delivered count is not chosen: the signals are standardised
// within the scene, so a fixed cutoff keeps roughly a fixed FRACTION of whatever activation produced
// (F24). Pooling the statistics per book fixes the sign of that but scores slightly worse on F2 (F25) —
// and F2 cannot settle it, reading one scene's set and averaging over scenes, so an arm delivering half
// the tokens registers only as whatever recall it lost. Sweeping the cutoff turns each artefact into a
// CURVE of quality against spend; an artefact is better only if its curve sits ABOVE the other at equal
// tokens. Two arms on one curve means the cheaper one is buying nothing the cutoff setting cannot.
//
// BOTH ARTEFACTS, NOT ONE AGAINST THE SHIPPED FILE. `--fits a=<dir>,b=<dir>` names directories of
// `relevance-model-<tier>.json`, and a comparison is only clean when both were fitted on THIS corpus:
// scoring a model fitted elsewhere against one fitted here reads two corpora as a standardisation effect.
//
// Usage (from SillyTavern root):
//   node .../cost-curve.mjs <sample.json> [...] --fits scene=<dir>,book=<dir> [--cutoffs 0.05,0.10,…]
import { indexPath, loadScene, openSample, sceneParams, scoreScene, embed, sceneLabel } from './scene.mjs';
import { resolveModel } from './reindex.mjs';

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
const FITS = (arg('--fits') ?? '').split(',').filter(Boolean).map(s => s.split('='));
const CUTOFFS = (arg('--cutoffs') ?? '0.04,0.08,0.12,0.16,0.20,0.25,0.30').split(',').map(Number);

if (!samples.length || FITS.length < 2 || FITS.some(p => p.length !== 2)) {
    console.error('usage: cost-curve.mjs <sample.json> [...] --fits <name>=<dir>,<name>=<dir> [--cutoffs 0.04,0.08,...]');
    process.exit(2);
}
// The embedding model is a USER SETTING with no knowable default, so it comes off the bundles and a
// disagreement is fatal rather than pooled — two models' cosines are not one column.
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0]).embedModel;
if (!MODEL) { console.error(`${samples[0]} records no embedModel — set WA_EMBED_MODEL`); process.exit(2); }
const EM = resolveModel(MODEL);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

const scenes = [];
for (const path of samples) {
    const S = openSample(path);
    // The wrong-book null fixture is not a real configuration and contributes a tie to every cell.
    if (S.invalidConfiguration) { console.log(`skip ${sceneLabel(S) || path}: ${S.invalidConfiguration}`); continue; }
    const P = sceneParams(S, {});
    const scene = loadScene(S, { indexFile: indexPath(S, { model: EM.label, all: P.denseAllEntries }), indexOpts: { model: EM.label }, params: P });
    const qv = await embed(EM.query + S.query, { ollama: OLLAMA, model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url });
    scenes.push({ path, name: sceneLabel(S) || path, S, scene, qv });
}
console.log(`${scenes.length} scenes, embedder ${EM.label}\n`);

// EVERY FIT AT EVERY CUTOFF, fit-outermost so a killed run still holds whole curves rather than
// half of each. Each cell is scored over the same loaded scenes: nothing but the artefact and the
// cutoff moves between rows.
for (const [name, dir] of FITS) {
    console.log(`${name}  (${dir})`);
    console.log('  cutoff |     F2   precision   recall   entries   tokens');
    for (const cut of CUTOFFS) {
        const rows = [];
        for (const sc of scenes) {
            rows.push(await scoreScene({ sample: sc.S, overrides: { fitDir: dir, memoryCutoff: cut }, k: 20, scene: sc.scene, qv: sc.qv }));
        }
        const at = rows.map(r => r.atCut);
        console.log(`  ${cut.toFixed(2)}   | ${mean(at.map(r => r.f)).toFixed(4)}   ${(100 * mean(at.map(r => r.precision))).toFixed(1)}%    ${(100 * mean(at.map(r => r.recall))).toFixed(1)}%   ${mean(at.map(r => r.n)).toFixed(1)}     ${Math.round(mean(at.map(r => r.tokens)))}`);
    }
    console.log('');
}
console.log('An artefact wins only where its F2 is higher at the SAME token spend. Equal F2 at equal\n'
    + 'tokens means the two lie on one curve and the cheaper arm is buying nothing the cutoff cannot.');
