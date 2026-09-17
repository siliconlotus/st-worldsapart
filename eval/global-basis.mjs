// global-basis.mjs — the CLI over lib/global-basis.mjs: one leave-one-lineage-out basis per book.
import { resolveModel } from './lib/reindex.mjs';
import { buildBases } from './lib/global-basis.mjs';

const argv = process.argv.slice(2);
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
if (!samples.length) {
    console.error('usage: node global-basis.mjs <sample.json ...> [--m 8] [--model <spec>] [--force]');
    console.error('builds one leave-one-LINEAGE-out basis per book, from memory-tier chunks of the collections already on disk');
    console.error('  --model takes a modelSpec, so a server stem is honoured: omlx:Qwen3-Embedding-8B-4bit-DWQ');
    console.error('  --within takes the components off the pooled WITHIN-book scatter, so a book-separating direction cannot lead');
    process.exit(2);
}
const m = Number(argv[argv.indexOf('--m') + 1]) || 8;
// The label, not the spec: a basis is per collection (cachePath).
const spec = (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null) ?? process.env.WA_EMBED_MODEL;
if (!spec) { console.error('no model: pass --model or set WA_EMBED_MODEL — a basis is per model'); process.exit(2); }
const model = resolveModel(spec).label;
const within = argv.includes('--within');
console.log(`building bases at m=${m} under "${model}"${within ? ', WITHIN-book scatter' : ''} from ${samples.length} sample(s)`);
const w = buildBases(samples, { m, model, within, force: argv.includes('--force'), log: s => console.log(s) });
console.log(`\n${w.length} basis file(s):`);
for (const [b, note] of w) console.log(`  ${b.slice(0, 44).padEnd(46)} ${note}`);
