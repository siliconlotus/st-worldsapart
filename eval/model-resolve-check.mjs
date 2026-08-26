// Self-check for `resolveModel` and the label it mints — which had no check at all, while its own header
// records two separate breakages that a stable-but-wrong label caused.
//
// The label is the identity of a set of vectors. It names the collection on disk, keys the query cache,
// and is what a bundle records and a human retypes, so the load-bearing property is that it RESOLVES BACK
// to the same model, endpoint and prefixes. Every failure here is a plausible number rather than an
// error: the wrong endpoint still answers, a dropped instruction prefix still embeds, and either reports
// a model as worse than it is.
import { PREFIXES, cachePath, pathSafe, resolveModel } from './reindex.mjs';
import { eq } from './metrics.mjs';

const round = spec => resolveModel(resolveModel(spec).label);
const idem = (spec, msg) => {
    const a = resolveModel(spec), b = round(spec);
    eq(b.label, a.label, `${msg}: label survives a round trip`);
    eq(`${b.model}|${b.endpoint}|${b.url}|${b.doc}|${b.query}`,
       `${a.model}|${a.endpoint}|${a.url}|${a.doc}|${a.query}`, `${msg}: ...and so does everything it resolved to`);
};

// --- transports -------------------------------------------------------------------------------------
eq(resolveModel('bge-m3').endpoint, 'ollama', 'a bare name is ollama');
eq(resolveModel('bge-m3').url, 'http://localhost:11434', '...at ollama\'s port');
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').endpoint, 'openai', 'an HTTP service speaks the OpenAI-compatible route');
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').model, 'Qwen3-Embedding-8B-4bit-DWQ', '...and the stem is not part of the model id');
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').url, 'http://localhost:8008', '...and it picks that server\'s port');
// The stem's colon used to be rewritten to a hyphen, which made the label resolve back as a bare ollama
// model — a stable label pointing at the wrong endpoint.
eq(round('omlx:Qwen3-Embedding-8B-4bit-DWQ').endpoint, 'openai', 'a service label still names its service after a round trip');

// --- st:, which is not a server ---------------------------------------------------------------------
const jina = resolveModel('st:Cohee/jina-embeddings-v2-base-en');
eq(jina.endpoint, 'st', 'st: is the in-process transport, not an HTTP one');
eq(jina.model, 'Cohee/jina-embeddings-v2-base-en', '...and the model stays a HuggingFace repo id, slash included');
eq(jina.label, 'st:Cohee/jina-embeddings-v2-base-en', '...and the label carries the stem');
idem('st:Cohee/jina-embeddings-v2-base-en', 'st');

// --- prefixes ----------------------------------------------------------------------------------------
// Matched as a substring at neither end: the served id is whoever packaged the model's spelling.
for (const [stem, want] of Object.entries(PREFIXES)) {
    eq(resolveModel(stem).query, want.query, `${stem}: the family's query prefix is found`);
}
eq(resolveModel('omlx:Qwen3-Embedding-8B-4bit-DWQ').query, PREFIXES['qwen3-embedding'].query, 'a differently-cased, differently-packaged id still finds its family');
eq(resolveModel('text-embedding-qwen3-embedding-8b').query, PREFIXES['qwen3-embedding'].query, '...including one with a prepended type tag');
eq(resolveModel('qwen3-embedding:4b/raw').query, '', '/raw deliberately takes no prefix');
eq(resolveModel('qwen3-embedding:4b/raw').label, 'qwen3-embedding:4b__raw', '...and says so in the label');
idem('qwen3-embedding:4b/raw', 'raw');
idem('embeddinggemma', 'prefixed');
idem('bge-m3', 'unprefixed');
eq(resolveModel('st:Cohee/jina-embeddings-v2-base-en').doc, '', 'jina is trained with no task prefix');

// --- the label as a path component -------------------------------------------------------------------
// A HuggingFace id carries a slash, and the label lands in three path positions. Unfolded it would become
// a nested directory rather than one collection.
eq(pathSafe('qwen3-embedding:4b'), 'qwen3-embedding:4b', 'a label with no slash is untouched, so nothing already on disk moves');
eq(pathSafe('omlx:Qwen3-Embedding-8B-4bit-DWQ__p'), 'omlx:Qwen3-Embedding-8B-4bit-DWQ__p', '...markers and stems included');
eq(pathSafe('st:Cohee/jina-embeddings-v2-base-en'), 'st:Cohee-jina-embeddings-v2-base-en', 'a slash folds');
const S = { primaryBook: 'A' }, cfg = { chunkMode: 'sentence', chunkSize: 400, minChunkSize: 50 };
const p = cachePath(S, cfg, 'st:Cohee/jina-embeddings-v2-base-en');
eq(p.slice(p.indexOf('/indexes/') + 9).split('/').length, 2, 'the cache path is <one directory>/index.json, not a nested tree');
// The hash still keys on the RAW label, so folding cannot merge two models that differ only by a slash.
eq(cachePath(S, cfg, 'a/b') === cachePath(S, cfg, 'a-b'), false, 'two labels that fold together still get different directories');

console.log('ok');
