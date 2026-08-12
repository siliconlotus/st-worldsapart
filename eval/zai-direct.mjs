// Direct OpenAI-compatible client for Z.AI, so the suggester's LLM arm can be measured without ST
// in the path.
//
// WHY NOT ROUTE THROUGH ST. Going through ConnectionManagerRequestService means three things are
// fixed that we need to vary or observe: `thinking` cannot be toggled, `max_tokens` is whatever the
// caller passes and its effect on reasoning is invisible, and the usage block never reaches us. The
// browser-console snippet inherited all of that. Talking to the endpoint directly gives the knobs
// and, more importantly, gives `usage` — which is the only way to set a response cap from evidence
// instead of by picking a round number.
//
// CREDENTIALS ARE NEVER READ BY THIS SCRIPT OR BY ANYONE EDITING IT. The key comes from the
// environment, is passed straight to fetch, and is not logged, echoed, or written to the output
// file. Set it in your own shell:
//
//   export ZAI_API_KEY=...
//   node zai-direct.mjs --model glm-4.6 --prompts eval-data/ladder-prompts.json --out arm.json
//
// The default base URL is the one Z.AI's docs list for the coding plan; override with --base or
// ZAI_BASE_URL if your plan uses a different one.
//
// Flags:
//   --model <id>            required
//   --prompts <file>        the ladder's --dump-prompts output (default eval-data/ladder-prompts.json)
//   --out <file>            where to write results (temp-ladder --extra format, plus usage)
//   --max-tokens <n,n,...>  sweep the response cap (default 4000). Each value is its own arm.
//   --temps <n,n,...>       sweep temperature (default: send none, let the backend decide)
//   --thinking <on|off>     send thinking.type explicitly; omit to leave it to the provider
//   --repeats <n>           default 1
//   --limit <n>             only the first n prompts, for a cheap smoke test
//   --dry                   print one request body and exit, without calling anything
//
// Output is JSONL, appended one line per response as it arrives, and re-running RESUMES: any
// (id, cap, temp, rep) already in the file is skipped. Calls cost money, so nothing here may
// depend on the process finishing — an interrupted run keeps everything it paid for.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;

const arg = (n, d = null) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = n => process.argv.includes(`--${n}`);
const nums = (s, d) => (s ? String(s).split(',').map(Number) : d);

const BASE = arg('base', process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/coding/paas/v4');
const MODEL = arg('model');
const OUT = arg('out', `${HERE}eval-data/zai-direct-out.jsonl`);
const PROMPTS = arg('prompts', `${HERE}eval-data/ladder-prompts.json`);
const CAPS = nums(arg('max-tokens'), [4000]);
const TEMPS = nums(arg('temps'), [null]);
const THINKING = arg('thinking');
const REPEATS = Number(arg('repeats', '1'));
const LIMIT = Number(arg('limit', '0'));

if (!MODEL) { console.error('--model is required'); process.exit(2); }
if (!existsSync(PROMPTS)) { console.error(`prompts file not found: ${PROMPTS}`); process.exit(2); }

const prompts = JSON.parse(readFileSync(PROMPTS, 'utf8')).slice(0, LIMIT || undefined);

/** The request body. Kept in one place so --dry shows exactly what would be sent. */
function body(prompt, cap, temp) {
    const b = {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: cap,
        stream: false,
    };
    if (temp !== null && temp !== undefined) b.temperature = temp;
    // Z.AI takes thinking as an object; omitted entirely when the flag is not passed, so the
    // provider's own default applies and we are not asserting one.
    if (THINKING) b.thinking = { type: THINKING === 'on' ? 'enabled' : 'disabled' };
    return b;
}

if (has('dry')) {
    const b = body(prompts[0].prompt, CAPS[0], TEMPS[0]);
    console.log('POST', `${BASE}/chat/completions`);
    console.log('key from env ZAI_API_KEY:', process.env.ZAI_API_KEY ? 'present' : 'MISSING');
    console.log(JSON.stringify({ ...b, messages: [{ role: 'user', content: `<${b.messages[0].content.length} chars>` }] }, null, 2));
    process.exit(0);
}

const KEY = process.env.ZAI_API_KEY;
if (!KEY) { console.error('ZAI_API_KEY is not set in the environment. export it in your shell, then re-run.'); process.exit(2); }

/**
 * Returns the assistant text plus whatever the provider reports about token usage. `reasoning` is
 * captured separately where the API exposes it: a reply whose content is empty while reasoning is
 * not is a budget failure, and scoring it as an empty candidate set would record a false zero.
 */
async function call(prompt, cap, temp) {
    const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body(prompt, cap, temp)),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const msg = j.choices?.[0]?.message ?? {};
    return {
        raw: String(msg.content ?? '').trim(),
        reasoning: String(msg.reasoning_content ?? msg.reasoning ?? ''),
        finish: j.choices?.[0]?.finish_reason ?? null,
        usage: j.usage ?? null,
    };
}

// Existing rows, so a re-run resumes rather than re-paying. Keyed on everything that changes a
// response; a partial final line (killed mid-write) is dropped rather than parsed.
const doneKeys = new Set();
const out = [];
if (existsSync(OUT)) {
    for (const line of readFileSync(OUT, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            out.push(r);
            doneKeys.add(`${r.id}|${r.maxTokens}|${r.temp}|${r.rep}`);
        } catch { /* truncated tail from an interrupted write */ }
    }
    console.log(`resuming: ${out.length} responses already in ${OUT}`);
}
const append = row => { appendFileSync(OUT, JSON.stringify(row) + '\n'); out.push(row); };

let failed = 0;
const total = prompts.length * CAPS.length * TEMPS.length * REPEATS;
let done = 0;

// ORDER MATTERS FOR EARLY QUITTING, not just for tidiness. Sweeping one temperature to exhaustion
// before starting the next means no cross-rung comparison exists until the run is half spent, which
// is the opposite of what an append-as-you-go log is for. Repeat is outermost and temperature is
// innermost, so every replicate covers every arm: after one pass you have the full design once over,
// and after two you have within-rung pairs and can decide whether the rest is worth buying.
for (const cap of CAPS) {
    for (let rep = 0; rep < REPEATS; rep++) {
        for (const p of prompts) {
            for (const temp of TEMPS) {
                done++;
                if (doneKeys.has(`${p.id}|${cap}|${temp ?? 'default'}|${rep}`)) continue;
                try {
                    const r = await call(p.prompt, cap, temp);
                    append({
                        id: p.id, model: MODEL, temp: temp ?? 'default', maxTokens: cap, rep,
                        raw: r.raw, finish: r.finish,
                        // Recorded, never scored: length only, so a reasoning trace is measurable
                        // without its text being stored alongside someone's lorebook content.
                        reasoningChars: r.reasoning.length,
                        usage: r.usage,
                    });
                    const u = r.usage ?? {};
                    const reas = u.completion_tokens_details?.reasoning_tokens;
                    process.stdout.write(`  ${String(done).padStart(3)}/${total} ${p.id} cap=${cap}`
                        + ` compl=${u.completion_tokens ?? '?'}${reas !== undefined ? ` reason=${reas}` : ''}`
                        + ` finish=${r.finish}${r.raw ? '' : ' EMPTY'}\n`);
                } catch (e) {
                    failed++;
                    console.error(`  ${String(done).padStart(3)}/${total} FAIL ${p.id} cap=${cap}: ${e.message}`);
                }
            }
        }
    }
}

console.log(`\n${OUT}: ${out.length} responses total (${failed} failed this run)`);

// --- what the usage block says about the cap -----------------------------------
// The point of running direct: reasoning consumption is observable, so a response cap can be set
// from the distribution rather than picked.
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pick = (o, ...path) => path.reduce((x, k) => (x == null ? x : x[k]), o);
console.log(`\n${'cap'.padEnd(8)}${'n'.padStart(5)}${'empty'.padStart(7)}${'len-stop'.padStart(10)}${'completion tok'.padStart(16)}${'reasoning tok'.padStart(15)}${'max compl.'.padStart(12)}`);
for (const cap of CAPS) {
    const rs = out.filter(r => r.maxTokens === cap);
    if (!rs.length) continue;
    const compl = rs.map(r => pick(r, 'usage', 'completion_tokens')).filter(Number.isFinite);
    const reas = rs.map(r => pick(r, 'usage', 'completion_tokens_details', 'reasoning_tokens')).filter(Number.isFinite);
    console.log(
        String(cap).padEnd(8) +
        String(rs.length).padStart(5) +
        String(rs.filter(r => !r.raw).length).padStart(7) +
        String(rs.filter(r => r.finish === 'length').length).padStart(10) +
        (compl.length ? mean(compl).toFixed(0) : '—').padStart(16) +
        (reas.length ? mean(reas).toFixed(0) : 'not reported').padStart(15) +
        (compl.length ? String(Math.max(...compl)) : '—').padStart(12));
}
console.log('\nempty + len-stop together are the starvation signal: a reply cut at the cap with no content.');
