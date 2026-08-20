// grade-local.mjs — dispatches grade-pending's job files to a LOCAL model, via ollama or any
// OpenAI-compatible server (oMLX, llama.cpp, vLLM). `--api openai` picks the second.
//
// The other half of grade-pending: `build` writes jobs, something grades them, `merge` reads the answers
// back. That something has so far been a Claude subagent; this is the same contract handed to a local
// model instead, so a judge can be swapped without touching the job shape, the contamination boundary or
// the merge. The system prompt is `.claude/agents/scene-relevance.md` VERBATIM (frontmatter stripped) —
// the rubric is the thing under test, so it is not paraphrased for a local model.
//
// Candidates go in INLINE rather than as a job path: ollama has no filesystem, and the contract already
// carries that branch ("Otherwise return only the JSON"). `out` and `note` are dropped for the same reason.
//
// Fixed seed and temperature 0, because a model comparison is only readable when nothing else moves
// (CLAUDE.md, "Prompt work belongs on a local model with a fixed seed"). `think` is off by default: the
// Sonnet passes these results are compared against ran without extended thinking.
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
// The two APIs differ in three places and nowhere else: the path, the body, and which field of a
// streamed chunk holds the text. Both stream LINE-DELIMITED JSON, so there is one parse loop reading
// two field paths rather than two transports — `data:` prefixes and the `[DONE]` sentinel are the only
// OpenAI-isms, and stripping them costs two lines. `--ctx` and `--think` are ollama-only; an
// OpenAI-compatible server takes its context from how it was launched.
//
// --contract restricts to jobs stamped with that rubric hash, which is what makes the result comparable
// to an existing pass; without it every job in the directory is dispatched regardless of which rubric it
// was built under.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
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

const system = readFileSync(resolvePath(ROOT, '.claude', 'agents', 'scene-relevance.md'), 'utf8')
    .replace(/^---[\s\S]*?\n---\n/, '');

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
// Round-robin over BOOKS first, then over that book's scenes. Interleaving scenes alone is not enough:
// scene names sort by book, so a scene-only round-robin still grades one book to exhaustion before it
// touches the next — measured, the first 12 jobs of a 36-scene run were all one book.
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
                // Usage only arrives on the final chunk if it is asked for, and a run whose cost cannot be
                // read afterwards is the one you end up re-running to find out.
                stream_options: { include_usage: true },
            } : {
                // STREAM, because node's fetch aborts at 300s waiting for HEADERS (undici's default
                // headersTimeout) and an unstreamed ollama reply sends none until the whole answer is
                // ready. MEASURED: 8 jobs died at exactly 301s with `fetch failed` while the GPU was
                // shared, and the server logged those same requests at took=5m0.88s — it was recording
                // the client hanging up, not a limit of its own. Streaming makes headers arrive at once,
                // so a slow job is slow rather than dead, and no request timeout has to be guessed at.
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
            // Two shapes that are the right ANSWER in the wrong wrapper, and both are cheap to accept:
            // the object inside a one-element array (measured: gemma-4-31B-it-MLX-8bit does this every
            // time), and the bare rows with no envelope. Anything else is a real refusal to answer the
            // question and still fails the uid check below.
            if (Array.isArray(parsed)) parsed = parsed.length === 1 && parsed[0]?.grades ? parsed[0] : { grades: parsed };
        } catch (e) { why = `parse: ${e.message}`; }
    }
    if (!why) {
        // Same guard merge applies, applied here so a short answer never reaches disk: a judge dropping one
        // row of sixteen is silent otherwise, and a written-then-rejected result would have to be hunted.
        const want = new Set(job.candidates.map(c => `${c.world}/${c.uid}`));
        const got = (parsed.grades ?? []).map(g => `${g.world}/${g.uid}`);
        const bads = (parsed.grades ?? []).filter(g => !Number.isInteger(Number(g.grade)) || g.grade < 0 || g.grade > 4);
        const lost = [...want].filter(k => !got.includes(k));
        if (lost.length || got.length !== want.size || bads.length) why = `shape: ${lost.length} missing, ${got.length}/${want.size} rows, ${bads.length} out-of-range`;
    }

    if (why) { bad++; console.log(`  FAIL ${id}  ${dt.toFixed(0)}s  ${why}`); }
    else { ok++; writeFileSync(`${OUTDIR}/${id}-graded.json`, JSON.stringify({ scene: job.scene, grades: parsed.grades }, null, 1)); }
    appendFileSync(LOG, JSON.stringify({
        id, model: MODEL, api: API, host: HOST, seed: SEED, contract: job.contract, ok: !why, why,
        secs: Number(dt.toFixed(1)), rows: job.candidates.length,
        promptTokens: res?.prompt_eval_count ?? null, outTokens: res?.eval_count ?? null,
        // The head of the raw answer, ON FAILURE ONLY. A rejected result writes no file, so without this
        // the only record of WHY is a shape count — and the first failure here ("0/7 rows") turned out to
        // be the right answer inside a one-element array, which cost a round trip to discover.
        ...(why ? { raw: (res?.message?.content ?? '').slice(0, 400) } : {}),
    }) + '\n');
    if ((ok + bad) % 10 === 0) console.log(`  ${ok} ok, ${bad} failed, ${(secs / 60).toFixed(1)}min elapsed`);
}
console.log(`\n${ok} graded, ${bad} failed, ${(secs / 60).toFixed(1)}min (${(secs / Math.max(1, ok + bad)).toFixed(0)}s/job)`);
process.exit(bad ? 1 : 0);
