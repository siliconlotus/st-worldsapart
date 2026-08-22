// grade-local.mjs — dispatches grade-pending's job files to a LOCAL model, via ollama or any
// OpenAI-compatible server (oMLX, llama.cpp, vLLM). `--api openai` picks the second.
//
// The other half of grade-pending: `build` writes jobs, something grades them, `merge` reads the answers
// back. Swapping the judge touches nothing else. The system prompt is `.claude/agents/scene-relevance.md`
// VERBATIM (frontmatter stripped) — the rubric is the thing under test, not something to paraphrase.
//
// Candidates go in INLINE rather than as a job path: ollama has no filesystem, and the contract already
// carries that branch ("Otherwise return only the JSON"). `out` and `note` are dropped for the same reason.
//
// Fixed seed and temperature 0 (CLAUDE.md, "Prompt work belongs on a local model with a fixed seed").
// `think` is off by default: the Sonnet passes these are compared against ran without extended thinking.
//
// APPEND, never collect: one job -> one result file, written only after the answer parses and its uid set
// matches the job's. A kill costs the call in flight; a re-run resumes, because an existing result file is
// skipped. A malformed answer writes nothing and is retried by the next run.
//
// Jobs are dispatched ROUND-ROBIN OVER SCENES, not in name order, so stopping at 20% leaves a sample that
// spans books instead of one book graded four times.
//
// Usage (any cwd):
//   node eval/synthetic-data/grade-local.mjs --out eval/eval-data/grade-gemma [--model gemma4:31b-mlx]
//        [--jobs eval/grade-jobs] [--contract 8460b922] [--limit N] [--seed 7] [--ctx 65536] [--think]
//        [--api ollama|openai] [--host http://localhost:8008]
//
// The two APIs differ in the path, the body, and which chunk field holds the text. Both stream
// line-delimited JSON, so one parse loop reads two field paths. `--ctx` and `--think` are ollama-only.
//
// --contract restricts to jobs stamped with that rubric hash, which is what makes the result comparable
// to an existing pass; without it every job in the directory is dispatched regardless of which rubric it
// was built under.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const OUT = arg('--out');
if (!OUT) {
    console.error('usage: node eval/synthetic-data/grade-local.mjs --out <dir> [--model gemma4:31b-mlx]');
    console.error('       [--jobs eval/grade-jobs] [--contract <hash>] [--limit N] [--seed 7] [--ctx 65536] [--think]\n       [--api ollama|openai] [--host http://localhost:8008]');
    process.exit(2);
}
const OUTDIR = resolvePath(OUT);
const JOBS = resolvePath(arg('--jobs', resolvePath(ROOT, 'eval', 'grade-jobs')));
const MODEL = arg('--model', 'gemma4:31b-mlx');
const CONTRACT = arg('--contract');
const LIMIT = Number(arg('--limit', Infinity));
const SEED = Number(arg('--seed', 7));
const CTX = Number(arg('--ctx', 65536));
const THINK = argv.includes('--think');
const API = arg('--api', 'ollama');
if (!['ollama', 'openai'].includes(API)) { console.error(`--api must be ollama|openai, got ${API}`); process.exit(2); }
const HOST = arg('--host', process.env.OLLAMA_HOST ?? (API === 'openai' ? 'http://localhost:8008' : 'http://localhost:11434'));

// --rubric swaps the system prompt for a VARIANT: editing the contract of record would change the hash
// stamped on every job, making an experiment indistinguishable from a ruling.
const RUBRIC = resolvePath(arg('--rubric', resolvePath(ROOT, '.claude', 'agents', 'scene-relevance.md')));
const rubricRaw = readFileSync(RUBRIC);
// THE FRONTMATTER IS NOT THE CONTRACT. Claude Code reads it to discover the agent; the grading prompt
// strips it, so the model never sees it — and hashing it made an edit to the `description` line move the
// contract from 8460b922 to 4ddd6466 while the graded instructions stayed byte-identical. Hash what is
// SENT. grade-pending hashes the same way, so an unmodified rubric still hashes to the job's own stamp.
const system = rubricRaw.toString('utf8').replace(/^---[\s\S]*?\n---\n/, '');
const rubricHash = createHash('sha256').update(system).digest('hex').slice(0, 8);

/**
 * Who the rater is, resolved from the backend rather than from what was typed.
 *
 * A NAME IS NOT AN IDENTITY. `bge-m3:latest` is whatever was pulled most recently, and an oMLX id is a
 * repo id's tail, so two accounts publishing one tail would record as one rater. What each backend can
 * actually answer differs, and a field it cannot answer stays ABSENT — a guess here is worse than a gap,
 * because the gap is legible and the guess is not (bundle-schema.md, *A rater is whoever passed a verdict*).
 *
 * Ollama: `/api/tags` carries the manifest digest, `/api/show` the descriptive fields and `capabilities`.
 * oMLX: its API carries neither, but its STORE is `<org>/<name>` for anything it downloaded — so the org
 * is read rather than guessed, and a model copied in from elsewhere sits flat and has no org to record.
 * A local model's `config.json` names its `architectures`, which is `family` resolved rather than parsed
 * out of a filename.
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
        // `modelDigest`, the field raterKey reads. `modelId` is the name of the COMPONENT it becomes
        // inside the joined id, not a field — raterParts hands that back.
        if (hit?.digest) out.modelDigest = hit.digest;
        const show = await j(`${HOST}/api/show`, { model: MODEL });
        const d = show?.details ?? {};
        if (d.family) out.family = d.family;
        if (d.quantization_level) out.quant = d.quantization_level;
        if (d.parameter_size) out.modelParams = d.parameter_size;
        if (Array.isArray(show?.capabilities)) out.capabilities = show.capabilities;
        return out;
    }

    // The oMLX store. Not the HuggingFace cache: a model oMLX downloaded is under its org here, and one
    // copied in is flat — the cache answers for neither reliably.
    const store = `${homedir()}/.omlx/models`;
    let dir = null;
    if (existsSync(store)) {
        for (const e of readdirSync(store, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (e.name === MODEL) { dir = `${store}/${MODEL}`; break; }
            if (existsSync(`${store}/${e.name}/${MODEL}/config.json`)) {
                // The ORG-QUALIFIED name, into `modelName` — not `modelDigest`, which is a digest and
                // this is not. The schema calls modelName the model LINE, and the repo id is that line
                // more precisely than its tail.
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
// WHAT THE INVOCATION SET, under the names it set them. Mirrors the request body exactly rather than a
// common scale: `num_ctx` and `think` are Ollama's and are not sent on the OpenAI path, and `think` is
// recorded only where the model declares the capability — so an absent one means unsupported, not unset.
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
// Round-robin over BOOKS first, then that book's scenes: scene names sort by book, so interleaving
// scenes alone still grades one book to exhaustion before touching the next.
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
    // A legitimate A/B, but the result no longer matches the job's stamp, so merging it would file these
    // grades under a rubric that did not produce them.
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
                // STREAM: node's fetch aborts at 300s waiting for HEADERS, and an unstreamed reply sends
                // none until the whole answer is ready, so a slow job dies rather than being slow.
                model: MODEL, messages, stream: true, think: THINK, format: 'json',
                options: { seed: SEED, temperature: 0, num_ctx: CTX },
            }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        // Reassembled into the shape the non-streaming reply had, so nothing downstream knows the
        // difference. The final chunk is the one carrying the token counts.
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
                // The stats chunk: ollama flags it `done`, OpenAI just attaches `usage` (and sends it
                // with an EMPTY choices array, so it must not be mistaken for the end of the content).
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
            // The right ANSWER in the wrong wrapper: the object inside a one-element array, or bare rows
            // with no envelope. Anything else still fails the uid check below.
            if (Array.isArray(parsed)) parsed = parsed.length === 1 && parsed[0]?.grades ? parsed[0] : { grades: parsed };
        } catch (e) { why = `parse: ${e.message}`; }
    }
    if (!why) {
        // Same guard merge applies, applied here so a short answer never reaches disk: a judge dropping one
        // row of sixteen is silent otherwise, and a written-then-rejected result would have to be hunted.
        const want = new Set(job.candidates.map(c => `${c.book}/${c.uid}`));
        const got = (parsed.grades ?? []).map(g => `${g.book}/${g.uid}`);
        const bads = (parsed.grades ?? []).filter(g => !Number.isInteger(Number(g.grade)) || g.grade < 0 || g.grade > 4);
        const lost = [...want].filter(k => !got.includes(k));
        if (lost.length || got.length !== want.size || bads.length) why = `shape: ${lost.length} missing, ${got.length}/${want.size} rows, ${bads.length} out-of-range`;
    }

    if (why) { bad++; console.log(`  FAIL ${id}  ${dt.toFixed(0)}s  ${why}`); }
    // `gradedAt` is WHEN THIS PASS RAN, not when someone later merged it. Merge time cannot separate two
    // passes filed in one invocation, and a day cannot separate two passes run in one day — which is the
    // adjudication case, where a second pass over the same rows is the entire point.
    else { ok++; writeFileSync(`${OUTDIR}/${id}-graded.json`, JSON.stringify({
        scene: job.scene, gradedAt: new Date().toISOString(),
        // WHAT PRODUCED THIS, carried rather than re-stated at merge time. The merge used to rebuild the
        // rater from a --model flag, so the tool that resolved the model dropped it and the tool that
        // wrote it guessed.
        // `capabilities` decided whether `think` is a knob at all; it is not a rater field and does not travel.
        rater: { ...RATER, rubric: `${RUBRIC.split('/').pop().replace(/\.md$/, '')}@${rubricHash}` },
        params: PARAMS,
        grades: parsed.grades,
    }, null, 1)); }
    appendFileSync(LOG, JSON.stringify({
        id, model: MODEL, api: API, host: HOST, seed: SEED, rubric: rubricHash, rubricFile: RUBRIC.split('/').pop(), contract: job.contract, ok: !why, why,
        secs: Number(dt.toFixed(1)), rows: job.candidates.length,
        promptTokens: res?.prompt_eval_count ?? null, outTokens: res?.eval_count ?? null,
        // The head of the raw answer, ON FAILURE ONLY: a rejected result writes no file, so otherwise the
        // only record of why is a shape count.
        ...(why ? { raw: (res?.message?.content ?? '').slice(0, 400) } : {}),
    }) + '\n');
    if ((ok + bad) % 10 === 0) console.log(`  ${ok} ok, ${bad} failed, ${(secs / 60).toFixed(1)}min elapsed`);
}
console.log(`\n${ok} graded, ${bad} failed, ${(secs / 60).toFixed(1)}min (${(secs / Math.max(1, ok + bad)).toFixed(0)}s/job)`);
process.exit(bad ? 1 : 0);
