// cost-curve.mjs — F2 over the delivered set against its token cost, the cutoff swept, for two fitted artefacts (directories of relevance-model-<tier>.json); one wins only where its curve sits above the other at equal tokens (F24, F25).
// Usage (from SillyTavern root):
//   node .../cost-curve.mjs <sample.json> [...] --fits scene=<dir>,book=<dir> [--cutoffs 0.05,0.10,…]
// Both fits must be fitted on this corpus: a model fitted elsewhere reads two corpora as a standardisation effect.
import { indexPath, loadScene, openSample, sceneParams, scoreScene, embed, sceneLabel } from './scene.mjs';
import { resolveModel } from './reindex.mjs';
import { mean } from './metrics.mjs';


const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
const FITS = (arg('--fits') ?? '').split(',').filter(Boolean).map(s => s.split('='));
const CUTOFFS = (arg('--cutoffs') ?? '0.04,0.08,0.12,0.16,0.20,0.25,0.30').split(',').map(Number);

if (!samples.length || FITS.length < 2 || FITS.some(p => p.length !== 2)) {
    console.error('usage: cost-curve.mjs <sample.json> [...] --fits <name>=<dir>,<name>=<dir> [--cutoffs 0.04,0.08,...]');
    process.exit(2);
}
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0]).embedModel;   // a user setting: off the bundle, never defaulted
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

// Fit-outermost: a killed run holds whole curves rather than half of each.
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
