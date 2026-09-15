// reindex.mjs — the CLI over lib/reindex.mjs: rebuild a vector collection from a sample's embedded books,
// offline, into eval-data/indexes — never into ST's live vectors.
import { readFileSync } from 'node:fs';
import { openBundle } from '../extension/grading.mjs';
import { arg } from './lib/metrics.mjs';
import { ensureIndex, resolveModel } from './lib/reindex.mjs';

const argv = process.argv.slice(2);
const sample = argv.find(a => a.endsWith('.json') && !a.startsWith('--'));
if (!sample) {
    console.error('usage: node reindex.mjs <sample.json> [--chunkSize N] [--chunkMode paragraph|length] [--minChunkSize N] [--book <name>] [--out <index.json>] [--batch 64] [--force] [--all] [--archived]');
    console.error('--all embeds EVERY entry with content, not just the vectorized ones — the collection the denseAllEntries arm reads (scene.mjs)');
    console.error('--archived ALSO embeds disabled memory entries as centroid-only mass — the collection the centroidPopulation arm reads (scene.mjs)');
    console.error('rebuilds a vector collection from the sample\'s embedded books into eval-data/indexes/ (never into SillyTavern\'s live vectors unless --out says so)');
    console.error('  --model <spec>  a modelSpec, so a server stem and a task prefix are honoured: omlx:Qwen3-Embedding-8B-4bit-DWQ');
    process.exit(2);
}
const S = openBundle(JSON.parse(readFileSync(sample, 'utf8')), arg(argv, '--arm'));
const overrides = {};
for (const k of ['chunkSize', 'minChunkSize']) if (arg(argv, `--${k}`) !== null) overrides[k] = Number(arg(argv, `--${k}`));
if (arg(argv, '--chunkMode')) overrides.chunkMode = arg(argv, '--chunkMode');
const spec = arg(argv, '--model') ?? process.env.WA_EMBED_MODEL ?? S.embedModel;
if (!spec) { console.error('no model: pass --model, set WA_EMBED_MODEL, or use a sample that records embedModel'); process.exit(2); }
const em = resolveModel(spec);
if (S.embedModel && em.label !== resolveModel(S.embedModel).label) console.error(`!! rebuilding under "${em.label}" but the sample was captured under "${S.embedModel}" — its recorded cosines will not be comparable`);

ensureIndex(S, {
    overrides, model: em.model, label: em.label, endpoint: em.endpoint,
    book: arg(argv, '--book') ?? S.primaryBook, out: arg(argv, '--out'),
    ollama: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    url: em.endpoint === 'ollama' ? (process.env.OLLAMA_URL ?? 'http://localhost:11434') : em.url,
    batch: Number(arg(argv, '--batch')) || 64, force: argv.includes('--force'), all: argv.includes('--all'), archived: argv.includes('--archived'), log: m => console.log(m),
}).then(r => {
    console.log(r.built ? `wrote ${r.items} items -> ${r.path}` : `already built (${r.items} items) -> ${r.path}  [--force to rebuild]`);
    console.log(argv.includes('--all')
        ? `score it with:  node param-screen.mjs ${sample} --arms denseAll=on   (an --all index is only meaningful under denseAllEntries)`
        : `score it with:  node graded-scene-grid.mjs --sample ${sample} --index ${r.path}`);
}).catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
