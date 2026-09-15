// grade-local.mjs — dispatches grade-pending's job files to a local model: ollama, or any OpenAI-compatible server (oMLX, llama.cpp, vLLM) with --api openai. The system prompt is .claude/agents/scene-relevance.md verbatim, frontmatter stripped; fixed seed, temperature 0, candidates inline.
// Usage (any cwd):
//   node eval/synthetic-data/grade-local.mjs --out eval/eval-data/grade-gemma [--model gemma4:31b-mlx] [--jobs eval/grade-jobs] [--contract <hash>: only jobs stamped with it]
//        [--limit N] [--seed 7] [--ctx 65536] [--think] [--api ollama|openai] [--host http://localhost:8008] [--rubric <file>: a variant system prompt]
// One job -> one result file, written only after the answer parses and its uid set matches the job's; an existing result is skipped, so a re-run resumes and a kill costs only the call in flight.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { archiveContract, contractBody, contractHash } from './contract.mjs';
import { createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg } from '../metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..', '..');
const argv = process.argv.slice(2);

const OUT = arg(argv, '--out');
if (!OUT) {
    console.error('usage: node eval/synthetic-data/grade-local.mjs --out <dir> [--model gemma4:31b-mlx]');
    console.error('       [--jobs eval/grade-jobs] [--contract <hash>] [--limit N] [--seed 7] [--ctx 65536] [--think]\n       [--api ollama|openai] [--host http://localhost:8008]');
    process.exit(2);
}
const OUTDIR = resolvePath(OUT);
const JOBS = resolvePath(arg(argv, '--jobs', resolvePath(ROOT, 'eval', 'grade-jobs')));
const MODEL = arg(argv, '--model', 'gemma4:31b-mlx');
const CONTRACT = arg(argv, '--contract');
const LIMIT = Number(arg(argv, '--limit', Infinity));
const SEED = Number(arg(argv, '--seed', 7));
const CTX = Number(arg(argv, '--ctx', 65536));
const THINK = argv.includes('--think');
const API = arg(argv, '--api', 'ollama');
if (!['ollama', 'openai'].includes(API)) { console.error(`--api must be ollama|openai, got ${API}`); process.exit(2); }
const HOST = arg(argv, '--host', process.env.OLLAMA_HOST ?? (API === 'openai' ? 'http://localhost:8008' : 'http://localhost:11434'));

const RUBRIC = resolvePath(arg(argv, '--rubric', resolvePath(ROOT, '.claude', 'agents', 'scene-relevance.md')));
const rubricRaw = readFileSync(RUBRIC);
const system = contractBody(rubricRaw.toString('utf8'));
const rubricHash = contractHash(system);
if (archiveContract(system, rubricHash).written) console.log(`contract ${rubricHash} archived`);

/**
 * The rater, resolved from the backend rather than from what was typed; a field a backend cannot answer stays absent, never guessed (bundle-schema.md, *A rater is whoever passed a verdict*).
 */
async function resolveModel() {
    const out = { modelName: MODEL };
    const j = async (url, body) => {
        try {
            const r = await fetch(url, body
                ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
                : { signal: AbortSignal.timeout(5000) });
            return r.ok ? await r.json() : null;
        } catch { return null; }
    };

    if (API === 'ollama') {
        const hit = ((await j(`${HOST}/api/tags`))?.models ?? []).find(m => m.name === MODEL);
        // modelDigest is the field raterKey reads.
        if (hit?.digest) out.modelDigest = hit.digest;
        const show = await j(`${HOST}/api/show`, { model: MODEL });
        const d = show?.details ?? {};
        if (d.family) out.family = d.family;
        if (d.quantization_level) out.quant = d.quantization_level;
        if (d.parameter_size) out.modelParams = d.parameter_size;
        if (Array.isArray(show?.capabilities)) out.capabilities = show.capabilities;
        return out;
    }

    // The oMLX store, not the HuggingFace cache: a downloaded model sits under its org, a copied-in one flat.
    const store = `${homedir()}/.omlx/models`;
    let dir = null;
    if (existsSync(store)) {
        for (const e of readdirSync(store, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (e.name === MODEL) { dir = `${store}/${MODEL}`; break; }
            if (existsSync(`${store}/${e.name}/${MODEL}/config.json`)) {
                // Into modelName, not modelDigest: a repo id is the model line, and not a digest.
                out.modelName = `${e.name}/${MODEL}`;
                dir = `${store}/${e.name}/${MODEL}`;
                break;
            }
        }
    }
    if (dir) {
        try {
            const arch = JSON.parse(readFileSync(`${dir}/config.json`, 'utf8')).architectures;
            if (Array.isArray(arch) && arch.length) out.family = arch[0];
        } catch { /* a model without a readable config records no family */ }
    }
    return out;
}

const MODEL_INFO = await resolveModel();
const { capabilities: _caps, ...RATER } = MODEL_INFO;
// Mirrors the request body under its own names: num_ctx and think are ollama-only, and think is recorded only where the model declares the capability, so absent means unsupported rather than unset.
const PARAMS = API === 'ollama'
    ? { seed: SEED, temperature: 0, num_ctx: CTX, ...((MODEL_INFO.capabilities ?? []).includes('thinking') ? { think: THINK } : {}) }
    : { seed: SEED, temperature: 0 };
console.log(`rater: ${MODEL_INFO.modelDigest ?? MODEL_INFO.modelName}${MODEL_INFO.modelDigest ? ` (${MODEL_INFO.modelName})` : ''}`
    + `${MODEL_INFO.family ? `  family=${MODEL_INFO.family}` : ''}${MODEL_INFO.quant ? ` quant=${MODEL_INFO.quant}` : ''}`
    + `${MODEL_INFO.modelParams ? ` params=${MODEL_INFO.modelParams}` : ''}`);

mkdirSync(OUTDIR, { recursive: true });
const LOG = `${OUTDIR}/dispatch.jsonl`;

// Scene is the job id minus its batch suffix, book is the scene minus its message number.
const sceneOf = id => id.replace(/-[br]\d+(-p\d+)?$/, '');
const bookOf = scene => scene.replace(/-msg\d+.*$/, '');
const pending = [];
for (const f of readdirSync(JOBS).filter(x => x.endsWith('.json') && !x.endsWith('-graded.json')).sort()) {
    const id = f.replace(/\.json$/, '');
    if (existsSync(`${OUTDIR}/${id}-graded.json`)) continue;
    const job = JSON.parse(readFileSync(`${JOBS}/${f}`, 'utf8'));
    if (CONTRACT && job.contract !== CONTRACT) continue;
    pending.push({ id, job });
}
const byScene = new Map();
for (const p of pending) {
    const s = sceneOf(p.id);
    if (!byScene.has(s)) byScene.set(s, []);
    byScene.get(s).push(p);
}
// Round-robin over books, then scenes within a book: scene names sort by book, so interleaving scenes alone grades one book to exhaustion first.
const byBook = new Map();
for (const s of byScene.keys()) {
    const bk = bookOf(s);
    if (!byBook.has(bk)) byBook.set(bk, []);
    byBook.get(bk).push(s);
}
const sceneOrder = [];
for (let i = 0; sceneOrder.length < byScene.size; i++) for (const list of byBook.values()) if (list[i]) sceneOrder.push(list[i]);

const queue = [];
for (let i = 0; queue.length < pending.length; i++) for (const s of sceneOrder) if (byScene.get(s)[i]) queue.push(byScene.get(s)[i]);
const work = queue.slice(0, LIMIT);

const jobContract = work[0]?.job?.contract;
if (jobContract && jobContract !== rubricHash) {
    console.log(`  NOTE: jobs stamped contract ${jobContract}, grading with rubric ${rubricHash} (${RUBRIC.split('/').pop()}) — read these results, do not merge them`);
}
console.log(`${work.length} jobs (${byScene.size} scenes) -> ${OUTDIR}  model=${MODEL} api=${API} host=${HOST} seed=${SEED}${API === "ollama" ? ` ctx=${CTX} think=${THINK}` : ""}`);

/** Ollama's json mode still fences sometimes; the fence is the only thing stripped. */
const unfence = s => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

let ok = 0, bad = 0, secs = 0;
for (const { id, job } of work) {
    const t = Date.now();
    let res, why = null;
    try {
        const messages = [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify({ scene: job.scene, sceneText: job.sceneText, candidates: job.candidates }) },
        ];
        const r = await fetch(`${HOST}${API === 'openai' ? '/v1/chat/completions' : '/api/chat'}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(API === 'openai' ? {
                model: MODEL, messages, stream: true, seed: SEED, temperature: 0,
                response_format: { type: 'json_object' },
                // Usage only arrives on the final chunk if asked for.
                stream_options: { include_usage: true },
            } : {
                // stream: true, or node's fetch aborts at 300s waiting for headers on a slow job.
                model: MODEL, messages, stream: true, think: THINK, format: 'json',
                options: { seed: SEED, temperature: 0, num_ctx: CTX },
            }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        // Reassembled into the non-streaming reply's shape; the final chunk carries the token counts.
        let buf = '', content = '';
        res = {};
        for await (const part of r.body) {
            buf += Buffer.from(part).toString('utf8');
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const raw of lines) {
                const line = raw.replace(/^data:\s*/, '').trim();
                if (!line || line === '[DONE]') continue;
                const j = JSON.parse(line);
                if (j.error) throw new Error(j.error.message ?? j.error);
                content += j.message?.content ?? j.choices?.[0]?.delta?.content ?? '';
                // The stats chunk: ollama flags it done, OpenAI attaches usage with an empty choices array — not the end of the content.
                if (j.done || j.usage) res = j;
            }
        }
        res.message = { content };
        if (res.usage) { res.prompt_eval_count = res.usage.prompt_tokens; res.eval_count = res.usage.completion_tokens; }
    } catch (e) { why = `request: ${e.message}`; }

    const dt = (Date.now() - t) / 1000; secs += dt;
    let parsed = null;
    if (!why) {
        try {
            parsed = JSON.parse(unfence(res.message?.content ?? ''));
            // The right answer in the wrong wrapper: a one-element array, or bare rows with no envelope.
            if (Array.isArray(parsed)) parsed = parsed.length === 1 && parsed[0]?.grades ? parsed[0] : { grades: parsed };
        } catch (e) { why = `parse: ${e.message}`; }
    }
    if (!why) {
        // grade-pending merge's shape guard, applied before anything reaches disk: a judge dropping one row of sixteen is silent otherwise.
        const want = new Set(job.candidates.map(c => `${c.book}/${c.uid}`));
        const got = (parsed.grades ?? []).map(g => `${g.book}/${g.uid}`);
        const bads = (parsed.grades ?? []).filter(g => !Number.isInteger(Number(g.grade)) || g.grade < 0 || g.grade > 4);
        const lost = [...want].filter(k => !got.includes(k));
        if (lost.length || got.length !== want.size || bads.length) why = `shape: ${lost.length} missing, ${got.length}/${want.size} rows, ${bads.length} out-of-range`;
    }

    if (why) { bad++; console.log(`  FAIL ${id}  ${dt.toFixed(0)}s  ${why}`); }
    // gradedAt is when this pass ran: merge time cannot separate two passes filed in one invocation.
    else { ok++; writeFileSync(`${OUTDIR}/${id}-graded.json`, JSON.stringify({
        scene: job.scene, gradedAt: new Date().toISOString(),
        // The rater travels with the result; at merge time only a --model flag is available.
        rater: { ...RATER, rubric: `${RUBRIC.split('/').pop().replace(/\.md$/, '')}@${rubricHash}` },
        params: PARAMS,
        grades: parsed.grades,
    }, null, 1)); }
    appendFileSync(LOG, JSON.stringify({
        id, model: MODEL, api: API, host: HOST, seed: SEED, rubric: rubricHash, rubricFile: RUBRIC.split('/').pop(), contract: job.contract, ok: !why, why,
        secs: Number(dt.toFixed(1)), rows: job.candidates.length,
        promptTokens: res?.prompt_eval_count ?? null, outTokens: res?.eval_count ?? null,
        // Raw head on failure only: a rejected result writes no file, so this is the only record of why.
        ...(why ? { raw: (res?.message?.content ?? '').slice(0, 400) } : {}),
    }) + '\n');
    if ((ok + bad) % 10 === 0) console.log(`  ${ok} ok, ${bad} failed, ${(secs / 60).toFixed(1)}min elapsed`);
}
console.log(`\n${ok} graded, ${bad} failed, ${(secs / 60).toFixed(1)}min (${(secs / Math.max(1, ok + bad)).toFixed(0)}s/job)`);
process.exit(bad ? 1 : 0);
