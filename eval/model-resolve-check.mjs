// Self-check for `resolveModel` and the label it mints — which had no check at all, while its own header
// records two breakages that a stable-but-wrong label caused.
//
// The label is the identity of a set of vectors. It names the collection on disk, keys the query cache,
// and is what a bundle records and a human retypes, so the load-bearing property is that it RESOLVES BACK
// to the same model, endpoint and prefixes. Every failure here is a plausible number rather than an
// error: the wrong endpoint still answers, a dropped instruction prefix still embeds, and either reports
// a model as worse than it is.
import { PREFIXES, cachePath, pathSafe, resolveModel } from './reindex.mjs';
import { PREFIXES as SHIPPED, queryPrefix } from '../extension/relevance.mjs';
import { eq } from './metrics.mjs';

const round = spec => resolveModel(resolveModel(spec).label);
const idem = (spec, msg) => {
    const a = resolveModel(spec), b = round(spec);
    eq(b.label, a.label, `${msg}: label survives a round trip`);
    eq(`${b.model}|${b.endpoint}|${b.url}|${b.query}`,
       `${a.model}|${a.endpoint}|${a.url}|${a.query}`, `${msg}: ...and so does everything it resolved to`);
};

// --- transports -------------------------------------------------------------------------------------
eq(resolveModel('bge-m3').endpoint, 'ollama', 'a bare name is ollama');
eq(resolveModel('bge-m3').url, 'http://localhost:11434', '...at ollama\'s port');
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').endpoint, 'openai', 'an HTTP service speaks the OpenAI-compatible route');
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').model, 'Qwen3-Embedding-8B-4bit-DWQ', '...and the stem is not part of the model id');
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').url, 'http://localhost:8008', '...and it picks that service\'s port');
// The stem's colon used to be rewritten to a hyphen, which made the label resolve back as a bare ollama
// model — a stable label pointing at the wrong endpoint.
eq(round('omlx:Qwen3-Embedding-8B-4bit-DWQ').endpoint, 'openai', 'a service label still names its service after a round trip');

// --- st:, which is in-process rather than over HTTP ---------------------------------------------------
const jina = resolveModel('st:Cohee/jina-embeddings-v2-base-en');
eq(jina.endpoint, 'st', 'st: is the in-process transport, not an HTTP one');
eq(jina.model, 'Cohee/jina-embeddings-v2-base-en', '...and the model stays a HuggingFace repo id, slash included');
eq(jina.query, '', 'jina is trained with no task prefix');
idem('st:Cohee/jina-embeddings-v2-base-en', 'st');

// --- one configuration per model: its own contract ----------------------------------------------------
// There is no unprefixed arm. Following the contract measured a real gain on Qwen3-8B and flat on
// gemma (E7), so it is always followed and the prefixes are not a parameter. A label therefore carries
// no marker, and every model resolves to exactly one set of prefixes.
for (const [stem, want] of Object.entries(PREFIXES)) {
    eq(resolveModel(stem).query, want, `${stem}: the family's query prefix is found`);
}
eq(Object.keys(PREFIXES).includes('embeddinggemma'), false, 'gemma has no entry: its prefixes measured flat, so they are not carried');
// Matched as a substring at neither end: the served id is whoever packaged the model's spelling.
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').query, PREFIXES['qwen3-embedding'], 'a differently-cased, differently-packaged id still finds its family');
eq(resolveModel('text-embedding-qwen3-embedding-8b').query, PREFIXES['qwen3-embedding'], '...including one with a prepended type tag');
eq(resolveModel('qwen3-embedding:0.6b').query, PREFIXES['qwen3-embedding'], '...and a sibling size, which must not fall through to no prefix');
eq(resolveModel('bge-m3').query, '', 'a family with no entry takes no prefix');
for (const m of ['bge-m3', 'embeddinggemma', 'qwen3-embedding:4b', 'omlx:Qwen3-Embedding-8B-4bit-DWQ']) {
    eq(resolveModel(m).label, m, `${m}: the label is the model, with no marker to re-append`);
    idem(m, m);
}

// --- the query prefix production applies ------------------------------------------------------------
// A prefix is carried only where it is measured to earn one, and every one that survives goes on the
// QUERY — so it costs no rebuild and production applies exactly what the harness measured.
eq(queryPrefix('qwen3-embedding:4b'), PREFIXES['qwen3-embedding'], 'production applies qwen\'s instruction');
eq(queryPrefix('Qwen3-Embedding-8B-4bit-DWQ'), PREFIXES['qwen3-embedding'], '...whatever the server spelled it');
eq(queryPrefix('text-embedding-qwen3-embedding-8b'), PREFIXES['qwen3-embedding'], '...including a prepended type tag');
eq(queryPrefix('qwen3-embedding:4b:latest'), PREFIXES['qwen3-embedding'], '...and an ollama :latest tag');
eq(queryPrefix('mxbai-embed-large'), PREFIXES['mxbai-embed-large'], 'mxbai gets its instruction too');
eq(queryPrefix('embeddinggemma'), '', 'gemma gets nothing: its prefixes measured flat');
eq(queryPrefix('bge-m3'), '', 'a model with no contract takes nothing');
eq(queryPrefix('Cohee/jina-embeddings-v2-base-en'), '', "...and so does ST's default");
eq(queryPrefix(undefined), '', 'no configured model is not an error');

// --- the label as a path component -------------------------------------------------------------------
// A HuggingFace id carries a slash, and the label lands in three path positions. Unfolded it would become
// a nested directory rather than one collection.
eq(pathSafe('qwen3-embedding:4b'), 'qwen3-embedding:4b', 'a label with no slash is untouched, so nothing already on disk moves');
eq(pathSafe('omlx:Qwen3-Embedding-8B-4bit-DWQ'), 'omlx:Qwen3-Embedding-8B-4bit-DWQ', '...stems and colons included');
eq(pathSafe('st:Cohee/jina-embeddings-v2-base-en'), 'st:Cohee-jina-embeddings-v2-base-en', 'a slash folds');
const S = { primaryBook: 'A' }, cfg = { chunkMode: 'sentence', chunkSize: 400, minChunkSize: 50 };
const p = cachePath(S, cfg, 'st:Cohee/jina-embeddings-v2-base-en');
eq(p.slice(p.indexOf('/indexes/') + 9).split('/').length, 2, 'the cache path is <one directory>/index.json, not a nested tree');
// The hash still keys on the RAW label, so folding cannot merge two models that differ only by a slash.
eq(cachePath(S, cfg, 'a/b') === cachePath(S, cfg, 'a-b'), false, 'two labels that fold together still get different directories');

eq(PREFIXES === SHIPPED, true, 'the harness reads production\'s contract table, not a second copy of it');

console.log('ok');
