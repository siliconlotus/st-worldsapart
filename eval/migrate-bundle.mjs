// migrate-bundle.mjs — lifts a bundleVersion 1 capture to a 2, so every sample on disk reads under one set
// of conventions.
//
// WHY THIS EXISTS. Three shapes are sitting in eval-data and all of them answer "which version are you?"
// the same way: a v1 bundle (`arms`, bundleVersion 1), a flat single-arm sample (no `arms`, no version at
// all), and a v2 bundle that still said 1 until BUNDLE_VERSION landed. The harness copes — sceneParams
// documents a fallback for every field a v1 lacks — but anything reading the JSON field-by-field does not,
// and the fields that changed changed their MEANING rather than their name:
//
//   keys   v1 wrote null for "scored 0" and for "had no keys to score"; v2 writes 0 and null. Read across
//          both, the keyword signal appears to halve, which is a convention change wearing a measurement's
//          clothes — exactly the drift the single-matcher rule exists to prevent.
//   text   v1 wrote a confident 0 for an entry with no chunks in the collection. 1112 of them, in the
//          synthetic set alone.
//
// Both are recoverable, which is the thing worth stating plainly: eligibility is not stored on a v1 row, but
// it is a function of the entry and the arm's own captureParams, and a bundle carries both at 'full'
// fidelity. `scoringKeys` is the same rule the scan applied live, so this reconstructs rather than guesses.
//
// WHAT IS NOT RECONSTRUCTED. `cut`/`cutBy` are the live budget's verdict, and replaying them offline would
// put a simulation under a field name that means "this is what happened". They stay absent; `tokens` is what
// lets a harness replay the cut at any budget anyway. A v1's rows are also only the SURVIVORS of its cut, so
// the migrated file records `population: 'survivors'` — a v1 arm's row count is not comparable to a v2's.
//
// Usage (from anywhere):
//   node eval/migrate-bundle.mjs <sample.json ...> [--tokenizer <name>] [--offline] [--write] [--out-dir <dir>]
//
// DRY BY DEFAULT: prints what each file would gain and writes nothing until --write. Token counts are
// skipped entirely without --tokenizer, rather than filled from a default nobody measured. With it they
// come from SillyTavern's own tokenizer endpoint, so they match what a live capture records byte for byte;
// --offline produces the same numbers with no server, through tokens.mjs. Endpoint counts are cached by
// (tokenizer, content hash) in eval-data/token-cache.json, so a re-run after a kill re-counts nothing;
// the offline path needs no cache, being local CPU.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { stInstall, sceneParams, scoringKeys } from './scene.mjs';
import * as matcher from '../extension/matcher.mjs';
import { BUNDLE_VERSION } from '../extension/grading.mjs';
import { offlineTokenCounter } from './tokens.mjs';

// ---------------------------------------------------------------------------
// Token counts, from SillyTavern's own tokenizer
// ---------------------------------------------------------------------------

/** Basic-auth header from config.yaml, when the install has basicAuthMode on. Read at run time rather than
 *  configured here — the credentials live in exactly one place and this is a local dev tool. */
function stAuth(root) {
    const cfg = existsSync(`${root}/config.yaml`) ? readFileSync(`${root}/config.yaml`, 'utf8') : '';
    if (!/^basicAuthMode:\s*true/m.test(cfg)) return {};
    const block = cfg.match(/^basicAuthUser:\s*\n((?:[ \t]+.*\n)+)/m)?.[1] ?? '';
    const user = block.match(/^\s*username:\s*['"]?(.*?)['"]?\s*$/m)?.[1];
    const pass = block.match(/^\s*password:\s*['"]?(.*?)['"]?\s*$/m)?.[1];
    if (!user) return {};
    return { Authorization: `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}` };
}

const US = String.fromCharCode(31);
const sha = s => createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 16);

/**
 * A cached token counter backed by the live SillyTavern's own tokenizer, so a backfilled count and one a
 * future capture records are the same number rather than two estimates of it.
 *
 * The cache is written after every file, not at the end: a killed run keeps every count it paid for, the
 * same rule the spend harnesses follow. Counting is local CPU rather than money, but a full pass over 70
 * bundles is minutes, and resuming for free costs one writeFileSync.
 */
export function makeTokenCounter(st, tokenizer) {
    const cachePath = `${st.root}/public/scripts/extensions/third-party/WorldsApart/eval/eval-data/token-cache.json`;
    const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
    const cfg = readFileSync(`${st.root}/config.yaml`, 'utf8');
    const port = cfg.match(/^port:\s*(\d+)/m)?.[1] ?? '8000';
    const auth = stAuth(st.root);
    let headers = null;
    let dirty = false;

    /** ST guards every POST with csrf-sync, so a token and its cookie are the price of admission — fetched
     *  once and reused, since they outlive a whole migration pass. Without this the endpoint answers 403 with
     *  a bare "Forbidden" page, which reads exactly like an auth failure and is not one. */
    const connect = async () => {
        if (headers) return headers;
        const r = await fetch(`http://127.0.0.1:${port}/csrf-token`, { headers: auth });
        if (!r.ok) throw new Error(`/csrf-token returned ${r.status} — is SillyTavern running on ${port}?`);
        const cookie = (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
        const { token } = await r.json();
        headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Cookie: cookie, ...auth };
        return headers;
    };

    // Content only — matching applyBudget's own accounting, which is what a live capture's `tokens` counts
    // too (rankActivated: getTokenCountAsync(entry.content)). The assembled prompt is larger.
    //
    // Always through /openai/encode?model=, never a bare per-tokenizer endpoint: that route is the one that
    // DISPATCHES on a model name (llama3, mistral, claude, gemma, qwen2, command-r, nemo, deepseek, then
    // tiktoken via ST's own getTokenizerModel), which is the same name paramSnapshot.budget.tokenizer
    // records. Sending the recorded name anywhere else would need a lookup table that ST already owns.
    const count = async (content, model = tokenizer) => {
        const key = `${model}${US}${sha(content)}`;
        if (cache[key] !== undefined) return cache[key];
        const r = await fetch(`http://127.0.0.1:${port}/api/tokenizers/openai/encode?model=${encodeURIComponent(model)}`, {
            method: 'POST', headers: await connect(), body: JSON.stringify({ text: String(content ?? '') }),
        });
        if (!r.ok) throw new Error(`tokenizer "${model}" returned ${r.status} — is SillyTavern running on ${port}?`);
        const n = (await r.json()).count;
        if (!Number.isFinite(n)) throw new Error(`tokenizer "${model}" returned no count`);
        cache[key] = n;
        dirty = true;
        return n;
    };
    const flush = () => { if (dirty) { writeFileSync(cachePath, JSON.stringify(cache)); dirty = false; } };
    return { count, flush };
}

/** The offline counter in makeTokenCounter's shape, so the migration below cannot tell them apart. One
 *  encoder is held per tokenizer name for the whole run; there is no cache to flush because encoding is
 *  local CPU and a re-run costs seconds rather than an HTTP round trip per row. */
function offlineCounterAdapter(tokenizer) {
    const held = new Map();
    const of = name => {
        if (!held.has(name)) held.set(name, offlineTokenCounter(name));
        return held.get(name);
    };
    return {
        count: async (content, model = tokenizer) => of(model).count(content),
        flush: () => { for (const c of held.values()) c.free(); held.clear(); },
    };
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

/** Every arm-like container in a manifest, whichever shape it is: a bundle's arms, or the flat sample
 *  itself. Both carry their own captureParams, scanText and candidates, which is all this walks. */
const armsOf = m => (Array.isArray(m.arms) ? m.arms : [m]);

/** The entry a row points at, from the bundle's embedded books. */
const entryFinder = m => {
    const byId = new Map();
    for (const [world, entries] of Object.entries(m.books ?? {})) {
        for (const e of Object.values(entries ?? {})) byId.set(`${world}${String.fromCharCode(31)}${Number(e.uid)}`, e);
    }
    return (world, uid) => byId.get(`${world}${String.fromCharCode(31)}${Number(uid)}`);
};

/** Key hits for one entry against the arm's frozen scan text — the same call rankActivated makes, so the
 *  excerpt localises the match that was actually scored rather than a re-derivation of the match rules. */
export function whyFor(entry, scanText, P) {
    matcher.setBoundaryMode(P.wordBoundary);
    const keys = scoringKeys(entry, P);
    if (!keys.length || !scanText) return [];
    const { hits } = matcher.keywordScore(entry, scanText, keys, { k1: P.K1, caseSensitiveDefault: P.caseSensitive, wholeWordsDefault: P.wholeWords });
    return hits.slice(0, 4).map(h => {
        const contexts = matcher.keyExcerpts(h.key, scanText, entry.caseSensitive, entry.matchWholeWords);
        return { key: h.key, count: h.count, excerpt: contexts[0] ?? null, contexts };
    });
}

/**
 * Lifts one parsed manifest in place. Pure but for `tokensOf`, which is injected because it is the only
 * step needing a running SillyTavern — the same reason settings and ST globals are injected everywhere else
 * here, and what lets migrate-bundle-check.mjs exercise this rather than a copy of it.
 *
 * @param {object} m Parsed bundle or flat sample, MUTATED
 * @param {{tokensOf?: ((content: string) => Promise<number>)|null, tokenizer?: string|null}} [io]
 * @returns {Promise<{m: object, skip?: string, tally: object}>}
 */
export async function migrateManifest(m, { tokensOf = null, tokenizer = null } = {}) {
    const tally = { textNulled: 0, keysZeroed: 0, keysNulled: 0, tokens: 0, why: 0, rows: 0, armsDropped: [], noEntry: 0 };

    // eval-data holds spend caches and prompt sets beside the samples, and `eval-data/*.json` is how anyone
    // will invoke this. Without the guard those get a bundleVersion, a population and a migratedWhy stamped
    // onto them — a cache file wearing a graded sample's metadata.
    if (!Array.isArray(m.grades) || !armsOf(m).some(a => Array.isArray(a.candidates))) {
        return { m, skip: 'not a graded sample', tally };
    }

    // A v2 file whose rows carry no `tokens` still does not read under v2 conventions, and that is this
    // tool's job. It is the mirror of the restamp below — there the stamp was stale and the rows were
    // right; here the stamp is right and one field is absent, because the derivation that wrote them had
    // no tokenizer. Backfilled ALONE: nothing else about a v2 row is touched, so this can never become a
    // second, quieter migration path.
    if (m.bundleVersion === BUNDLE_VERSION) {
        const missing = armsOf(m).flatMap(a => a.candidates ?? []).filter(r => r.tokens === undefined);
        if (!missing.length) return { m, skip: 'already v2', tally };
        if (!tokensOf) return { m, skip: `already v2, but ${missing.length} rows have no tokens — pass --tokenizer to backfill`, tally };
        const findEntry = entryFinder(m);
        for (const arm of armsOf(m)) {
            for (const row of arm.candidates ?? []) {
                if (row.tokens !== undefined) continue;
                const entry = findEntry(row.world, row.uid);
                if (!entry) { tally.noEntry++; continue; }
                row.tokens = await tokensOf(entry.content ?? '');
                tally.tokens++;
            }
            // Which tokenizer produced them, on the arm that carries the counts. Offline it is a harness
            // choice rather than an observation, and a count whose encoder is unrecorded cannot be checked.
            if (tokenizer) arm.paramSnapshot = { ...(arm.paramSnapshot ?? {}), budget: { ...(arm.paramSnapshot?.budget ?? {}), tokenizer } };
        }
        tally.rows = missing.length;
        return { m, tokensOnly: true, tally };
    }

    // SHAPE DECIDES, NOT THE STAMP. bundleVersion is written by the extension running in the browser, so a
    // capture taken before that page reloaded says 1 while every row already carries the v2 fields — eight
    // of the nine bundles in eval-data were exactly this. Migrating one would be a near no-op on the values
    // and would still stamp it `population: 'survivors'`, which is false for a full capture and precisely
    // the sort of confident wrong label this tool exists to delete. So the version is corrected and nothing
    // else is touched.
    const allRows = armsOf(m).flatMap(a => a.candidates ?? []);
    if (allRows.length && allRows.every(r => 'cut' in r && 'tokens' in r)) {
        m.bundleVersion = BUNDLE_VERSION;
        return { m, restamped: true, tally };
    }

    // The summary arm resurrects a withdrawn query mode; state.mjs resets queryMode rather than un-surfacing
    // it, so the arm cannot be re-run and its rows describe a configuration no user can be in.
    if (Array.isArray(m.arms)) {
        const before = m.arms.length;
        m.arms = m.arms.filter(a => a.arm !== 'summary');
        if (m.arms.length !== before) tally.armsDropped.push('summary');
    }

    const entryOf = entryFinder(m);
    const { arms: _a, ...shared } = m;

    for (const armObj of armsOf(m)) {
        const P = sceneParams({ ...shared, ...armObj });
        if (armObj.paramSnapshot?.summary) delete armObj.paramSnapshot.summary;
        if (armObj.paramSnapshot?.budget && tokenizer) armObj.paramSnapshot.budget.tokenizer = tokenizer;

        for (const row of armObj.candidates ?? []) {
            tally.rows++;
            const entry = entryOf(row.world, row.uid);
            if (!entry) { tally.noEntry++; continue; }

            // text follows the retrieval path, exactly as the row builder now gates it: no cosine means the
            // entry had no chunks in the collection, so a 0 there was a default and not a measurement.
            if (row.cosine === null || row.cosine === undefined) {
                if (row.text !== null && row.text !== undefined) { row.text = null; tally.textNulled++; }
            }

            // keys follows ELIGIBILITY. v1 collapsed both cases to null; scoringKeys is the same suppress
            // gate the scan applied, so an eligible row's null was a scored zero and an ineligible one's
            // was the absence it now says explicitly.
            const eligible = scoringKeys(entry, P).length > 0;
            if (!eligible) {
                if (row.keys !== null && row.keys !== undefined) { row.keys = null; tally.keysNulled++; }
            } else if (row.keys === null || row.keys === undefined) {
                row.keys = 0;
                tally.keysZeroed++;
            }

            if (row.why === undefined) { row.why = whyFor(entry, armObj.scanText, P); tally.why++; }

            if (tokensOf && row.tokens === undefined) {
                row.tokens = await tokensOf(entry.content);
                tally.tokens++;
            }
        }
    }

    // A v1 arm recorded only what survived its own cut, so its row count is not a population the way a v2's
    // is. Said on the file rather than inferred from a date, since the two are indistinguishable otherwise.
    m.population = 'survivors';
    m.migratedFrom = m.bundleVersion ?? 'flat-sample';
    m.migratedAt = new Date().toISOString().slice(0, 10);
    m.migratedWhy = 'bundleVersion 1 -> 2: text/keys re-gated on condition, key hits recomputed'
        + (tokenizer ? `, tokens counted with ${tokenizer}` : '; tokens NOT backfilled')
        + '. cut/cutBy deliberately absent — never captured, and a replay is not a record.';
    m.bundleVersion = BUNDLE_VERSION;

    return { m, tally };
}

// ---------------------------------------------------------------------------
// CLI. Guarded, so migrate-bundle-check.mjs imports migrateManifest without running a pass.
// ---------------------------------------------------------------------------

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
    const files = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
    const WRITE = argv.includes('--write');
    const TOKENIZER = arg('--tokenizer');
    const OUT_DIR = arg('--out-dir');

    if (!files.length) {
        console.error('usage: node eval/migrate-bundle.mjs <sample.json ...> [--tokenizer <name>] [--write] [--out-dir <dir>]');
        console.error('  dry by default — prints per-file repairs and writes nothing until --write.');
        console.error('  --tokenizer names a SillyTavern tokenizer endpoint (gpt2, llama3, claude, …); without it');
        console.error('  the per-row `tokens` backfill is skipped rather than guessed.');
        console.error('  --offline counts locally (tokens.mjs) instead of against a running SillyTavern.');
        process.exit(2);
    }

    const st = stInstall();
    if (TOKENIZER && !st) { console.error('--tokenizer needs a reachable SillyTavern install (none found from here)'); process.exit(2); }
    // --offline counts locally instead of over HTTP. It is not an approximation of the endpoint: the
    // encoding is the same one ST dispatches to, plus the fixed per-message overhead its counter adds,
    // measured and asserted by tokens-check.mjs. It exists because the HTTP path needs a RUNNING
    // SillyTavern, which is a strange prerequisite for backfilling files that are already on disk.
    const counter = TOKENIZER
        ? (argv.includes('--offline') ? offlineCounterAdapter(TOKENIZER) : makeTokenCounter(st, TOKENIZER))
        : null;

    /** Which tokenizer a manifest's counts should be produced by. The capture's OWN record wins: a v2 arm
     *  carries paramSnapshot.budget.tokenizer, which is what ST's "best match" resolved to on the run being
     *  migrated. --tokenizer is the fallback for captures made before that field existed, and saying so on
     *  the file is why migratedWhy names it. */
    const tokenizerFor = m => {
        for (const a of (Array.isArray(m.arms) ? m.arms : [m])) {
            const rec = a.paramSnapshot?.budget?.tokenizer;
            if (rec) return rec;
        }
        return TOKENIZER;
    };

    let failed = 0;
    for (const path of files) {
        let out;
        try {
            const m = JSON.parse(readFileSync(path, 'utf8'));
            const tok = counter ? tokenizerFor(m) : null;
            out = await migrateManifest(m, { tokensOf: tok ? (c => counter.count(c, tok)) : null, tokenizer: tok });
        } catch (e) {
            console.log(`${basename(path).slice(0, 47).padEnd(48)} FAILED — ${e.message}`);
            counter?.flush();
            failed++;
            continue;
        }
        const t = out.tally;
        if (out.skip) { console.log(`${basename(path).slice(0, 47).padEnd(48)} skipped — ${out.skip}`); continue; }
        if (out.tokensOnly) {
            console.log(`${basename(path).slice(0, 47).padEnd(48)} tokens backfilled ${String(out.tally.tokens).padStart(5)}`
                + (out.tally.noEntry ? `  NO ENTRY ${out.tally.noEntry}` : ''));
            if (WRITE) writeFileSync(OUT_DIR ? `${resolvePath(OUT_DIR)}/${basename(path)}` : path, JSON.stringify(out.m));
            continue;
        }
        if (out.restamped) {
            console.log(`${basename(path).slice(0, 47).padEnd(48)} restamped — rows already at v2 conventions, only bundleVersion was stale`);
            if (WRITE) writeFileSync(OUT_DIR ? `${resolvePath(OUT_DIR)}/${basename(path)}` : path, JSON.stringify(out.m));
            continue;
        }
        console.log(`${basename(path).slice(0, 47).padEnd(48)} rows ${String(t.rows).padStart(5)}`
            + `  text->null ${String(t.textNulled).padStart(4)}`
            + `  keys->0 ${String(t.keysZeroed).padStart(4)}`
            + `  keys->null ${String(t.keysNulled).padStart(4)}`
            + `  why ${String(t.why).padStart(5)}`
            + `  tokens ${TOKENIZER ? String(t.tokens).padStart(5) : '    -'}`
            + (t.armsDropped.length ? `  dropped ${t.armsDropped.join(',')}` : '')
            + (t.noEntry ? `  NO ENTRY ${t.noEntry}` : ''));

        // Per file, not at the end: the counts already paid for survive a kill.
        counter?.flush();
        if (WRITE) {
            const dest = OUT_DIR ? `${resolvePath(OUT_DIR)}/${basename(path)}` : path;
            if (OUT_DIR) mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, JSON.stringify(out.m));
        }
    }

    if (!WRITE) console.log(`\nDRY — nothing written. Re-run with --write${TOKENIZER ? '' : ', and --tokenizer <name> to fill tokens'}.`);
    if (failed) process.exit(1);
}
