// synth-scenes.mjs — derives synthetic graded-scene bundles from a live chat and a live world.
// Usage (any cwd):
//   node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> --msgs 123,456 [--write]
//   node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> --n 14 --seed 7 [--write]
//   node eval/synth-scenes.mjs --from <bundle.json> --msgs same [--write]
//   ... [--also "other book"]   ADD a book the five bindings do not name; detection covers the rest
//   ... [--include-hidden]   derive turns marked is_system, for scenes graded before they were hidden
// Message ids are raw record indices (line N of the .jsonl, hidden messages counted); the query and scan window are built from is_system-filtered messages.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { haystackFor, loadScene, makeCandidateSet, makeLayoutOrder, sceneParams, indexPath, embed, stInstall, wiTitle, bookFingerprint, whyFor } from './scene.mjs';
import { ensureIndex } from './reindex.mjs';
import { arg } from './metrics.mjs';

import { offlineTokenCounter } from './tokens.mjs';
import * as query from '../extension/query.mjs';
import * as entity from '../extension/entity.mjs';
import * as matcher from '../extension/matcher.mjs';
import { bundleSamples, openBundle, stRelative } from '../extension/grading.mjs';
import { execFileSync } from 'node:child_process';

/** The pooling arms in harness vocabulary; mirrors worldsapart.js POOL_ARMS, which imports ST and cannot be loaded here. */
const POOL_ARMS = {
    shipped: {},
    'no-filter': { entityFilter: false },
};

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FROM = arg(argv, '--from');
const MIN_HISTORY = Number(arg(argv, '--min-history') ?? 50);
const INCLUDE_HIDDEN = argv.includes('--include-hidden');
const OUT_DIR = arg(argv, '--out-dir') ?? (FROM ? dirname(resolvePath(FROM)) : '.');
const MODEL = arg(argv, '--model') ?? process.env.WA_EMBED_MODEL;
if (!MODEL) { console.error('no model: pass --model or set WA_EMBED_MODEL — the derived bundles record it'); process.exit(2); }
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

const src = FROM ? openBundle(JSON.parse(readFileSync(FROM, 'utf8'))) : null;
// Depth 10 is the corpus (G13); a set derived at another depth cannot be compared with the rest, and only its query looks short.
const DEPTH = Number(arg(argv, '--depth') ?? src?.params?.depth ?? 10);
const CHAT = arg(argv, '--chat') ?? src?.sceneChat;
const BOOK = arg(argv, '--book') ?? src?.primaryBook;
// The donor's own name, not its filename, which a rename silently changes.
const PREFIX = arg(argv, '--prefix') ?? (FROM ? String(src?.name ?? basename(FROM)).replace(/-msg\d+(\.json)?$/, '') : 'syn');

if (!CHAT || !BOOK) {
    console.error('usage: node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> (--msgs a,b,c | --n N [--seed S]) [--write]');
    console.error('       node eval/synth-scenes.mjs --from <bundle.json> --msgs same [--write]');
    console.error('  --from takes the chat, book and parameter identity from an existing bundle; "--msgs same" reuses its own turn');
    process.exit(2);
}

const SEP = String.fromCharCode(31);
const st = stInstall();
if (!st) { console.error('no SillyTavern install reachable — synth-scenes reads the live chat and world (set WA_ST_ROOT)'); process.exit(2); }

// By filename, which is how ST addresses a book; the name inside the file goes stale silently.
const worldPath = st.resolve(`data/default-user/worlds/${BOOK}.json`);
if (!existsSync(worldPath)) { console.error(`no world file for "${BOOK}" at ${worldPath}`); process.exit(2); }
const entries = JSON.parse(readFileSync(worldPath, 'utf8')).entries;
const byUidWorld = Object.fromEntries(Object.values(entries).map(e => [e.uid, { ...e, world: BOOK }]));

/** One character card's data.extensions.world, a name (the card's character_book blob is stale); null when unreadable. */
function cardWorld(pngPath) {
    let buf;
    try { buf = readFileSync(pngPath); } catch { return null; }
    if (buf.length < 8) return null;
    let off = 8, best = null;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (type === 'IEND') break;
        if (type === 'tEXt' || type === 'iTXt') {
            const data = buf.subarray(off + 8, off + 8 + len);
            const nul = data.indexOf(0);
            const key = nul > 0 ? data.toString('latin1', 0, nul) : '';
            if (key === 'chara' || key === 'ccv3') {
                try {
                    const card = JSON.parse(Buffer.from(data.subarray(nul + 1).toString('latin1'), 'base64').toString('utf8'));
                    const w = card?.data?.extensions?.world ?? card?.extensions?.world ?? null;
                    // ccv3 wins when both are present.
                    if (w && (key === 'ccv3' || !best)) best = w;
                } catch { /* an unreadable chunk is not a card */ }
            }
        }
        off += 12 + len;
    }
    return best;
}

/**
 * Every book ST would have loaded for this chat, by name — a duplicate of worldsapart.js worldSourceRank's five bindings.
 * A binding ST adds later goes unread here, and the only symptom is a narrower gazetteer.
 */
function attachedWorlds(chatRelPath) {
    const out = new Map();       // name -> which binding found it
    const add = (name, src) => { if (name && !out.has(name)) out.set(name, src); };
    let settings = {};
    try { settings = JSON.parse(readFileSync(`${st.dataRoot}/default-user/settings.json`, 'utf8')); } catch { /* no settings is not fatal */ }
    const wi = settings.world_info_settings?.world_info ?? {};
    for (const w of wi.globalSelect ?? []) add(w, 'global');
    add(settings.power_user?.persona_description_lorebook, 'persona');
    // The character is the chat file's own directory.
    const chara = basename(dirname(chatRelPath));
    add(cardWorld(st.resolve(`data/default-user/characters/${chara}.png`)), 'character');
    for (const w of (wi.charLore ?? []).find(e => e.name === chara)?.extraBooks ?? []) add(w, 'character-extra');
    try {
        const head = JSON.parse(readFileSync(st.resolve(chatRelPath), 'utf8').split('\n', 1)[0]);
        add(head?.chat_metadata?.world_info, 'chat');
    } catch { /* handled by the chat check below */ }
    return out;
}

// Union, never override: each source can only add, since every failure this guards against is a book going missing.
const detected = attachedWorlds(CHAT);
const ALSO = [...new Set([
    ...[...detected.keys()],
    ...String(arg(argv, '--also') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    ...Object.keys(src?.books ?? {}),
])].filter(w => w !== BOOK);
const otherBooks = {};
const missingBooks = [];
for (const name of ALSO) {
    const p = st.resolve(`data/default-user/worlds/${name}.json`);
    if (!existsSync(p)) { missingBooks.push(name); continue; }
    const es = JSON.parse(readFileSync(p, 'utf8')).entries;
    otherBooks[name] = Object.fromEntries(Object.values(es).map(e => [e.uid, { ...e, world: name }]));
}
/** Every embedded book: the ranked one plus the attached ones the gazetteer needs. */
const allBooks = { [BOOK]: byUidWorld, ...otherBooks };

/** What the bindings said beside what got embedded; a binding naming a world with no file is the one legitimate divergence. */
const attached = [BOOK, ...ALSO].map(book => ({
    book,
    source: detected.get(book) ?? 'named',
    // null = no world file, distinct from the fingerprint of an empty book.
    fingerprint: allBooks[book] ? bookFingerprint(allBooks[book]) : null,
}));
{
    const fingerprinted = attached.filter(a => a.fingerprint).map(a => a.book).sort().join(SEP);
    const embedded = Object.keys(allBooks).sort().join(SEP);
    if (fingerprinted !== embedded) {
        console.error(`internal: fingerprinted books [${fingerprinted}] do not match the embedded ones [${embedded}]`);
        process.exit(1);
    }
}

// Whole file, not a tail read: a raw index is only meaningful against every record.
const chatPath = st.resolve(CHAT);
if (!existsSync(chatPath)) { console.error(`no chat at ${chatPath}`); process.exit(2); }
const records = readFileSync(chatPath, 'utf8').split('\n').filter(Boolean)
    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
// A chat file's first record is the character card header, not a message; it has no `mes`.
const isMessage = r => typeof r?.mes === 'string';

/** Raw indices eligible to be a scene: a visible message with enough visible history behind it. */
const eligible = [];
{
    let usable = 0;
    for (const [i, r] of records.entries()) {
        if (!isMessage(r) || r.is_system) continue;
        if (usable >= MIN_HISTORY) eligible.push(i);
        usable++;
    }
}

/** Deterministic PRNG so --seed reproduces a sample exactly. */
const mulberry32 = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

let picks;
if (arg(argv, '--msgs') === 'same') {
    if (!src) { console.error('--msgs same needs --from'); process.exit(2); }
    // The donor's own fields, never its filename; sceneEnd is where the scene ends, generatedFrom.msg what wrote it.
    const same = src.sceneEnd ?? src.generatedFrom?.msg;
    if (!Number.isFinite(Number(same))) { console.error(`${basename(FROM)} records no scene end to reuse`); process.exit(2); }
    picks = [Number(same)];
} else if (arg(argv, '--msgs')) {
    picks = String(arg(argv, '--msgs')).split(',').map(x => Number(x.trim())).filter(Number.isFinite);
} else if (arg(argv, '--n')) {
    const rng = mulberry32(Number(arg(argv, '--seed') ?? 1));
    const pool = [...eligible];
    picks = [];
    for (let k = 0; k < Number(arg(argv, '--n')) && pool.length; k++) picks.push(...pool.splice(Math.floor(rng() * pool.length), 1));
    picks.sort((a, b) => a - b);
} else { console.error('pass --msgs a,b,c or --n N'); process.exit(2); }

// is_system is a rule about what the runtime scans; --include-hidden is stamped on the bundle because nothing else on the row says so.
const bad = picks.filter(i => !records[i] || !isMessage(records[i]) || (records[i].is_system && !INCLUDE_HIDDEN));
if (bad.length) {
    const hidden = bad.filter(i => records[i] && isMessage(records[i]) && records[i].is_system);
    console.error(`message id(s) ${bad.join(', ')} are missing or hidden in ${basename(chatPath)} — a raw index must name a visible message`);
    if (hidden.length) console.error(`  ${hidden.length} of them are hidden rather than absent (${hidden.join(', ')}); --include-hidden derives them anyway`);
    process.exit(2);
}

console.log(`chat ${basename(chatPath)}: ${records.length} records, ${eligible.length} eligible turns`);
console.log(`world "${BOOK}": ${Object.keys(entries).length} entries, ${Object.values(entries).filter(e => e.vectorized && !e.disable && e.content).length} vectorized`);
for (const [n, bk] of Object.entries(otherBooks)) console.log(`attached \`${n}\` (${detected.get(n) ?? 'named'}): ${Object.keys(bk).length} entries — embedded for the GAZETTEER only, never ranked`);
if (!ALSO.length) console.log(`no other book detected for this chat — global/persona/character/chat bindings all resolve to \`${BOOK}\` or nothing`);
for (const n of missingBooks) console.log(`attached \`${n}\` (${detected.get(n) ?? 'named'}): NO WORLD FILE — a stale binding; skipped, as ST would`);
console.log(`generating ${picks.length} scene(s) at depth ${DEPTH}: ${picks.join(', ')}\n`);

// Before ensureIndex: it embeds the whole book and writes a cache keyed by book name, so a dry run reaching it leaves a real collection behind.
if (!WRITE) {
    console.log('\nDRY — nothing written and nothing embedded. Re-run with --write.');
    process.exit(0);
}

/** <branch>@<git describe --tags --always --dirty>; +dirty rather than -dirty because SemVer build metadata compares equal. Empty when not a repo. */
const gitVersion = (dir) => {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return `${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('describe', '--tags', '--always', '--dirty=+dirty')}`;
    } catch { return ''; }
};

const WA_VERSION = gitVersion(resolvePath(dirname(fileURLToPath(import.meta.url)), '..'));
const ST_VERSION = st?.root ? gitVersion(st.root) : '';

const r5 = x => (Number.isFinite(x) ? Number(x.toFixed(5)) : null);
const r2 = x => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

// Counted offline at the runtime's value (tokens.mjs); the tokenizer is written onto the bundle because offline it is a harness choice.
const TOKENIZER = src?.budget?.tokenizer ?? 'gpt-3.5-turbo';
const tokens = offlineTokenCounter(TOKENIZER);

/** The source's budget block with maxTokens dropped: on the source it is a display string (G13), and no budget was applied here. */
const budgetFor = () => ({ ...(src?.budget ?? {}), maxTokens: null, tokenizer: TOKENIZER });

// Built once from the live world; chunked as the app would chunk it today (reindex.mjs chunkConfig).
const chunkOverrides = src?.paramSnapshot?.settings ?? {};
const shell = { primaryBook: BOOK, books: allBooks, paramSnapshot: src?.paramSnapshot };
const built = await ensureIndex(shell, { overrides: chunkOverrides, model: MODEL, ollama: OLLAMA, log: m => console.log(`  ${m}`) });
console.log(`collection: ${built.items} chunks${built.built ? ' (built)' : ' (cached)'}\n`);

console.log(`scene                          arms  pooled  vectorized  keyword-only`);
for (const idx of picks) {
    // srcIndex maps a visible message back to its raw record, so the scene records the range it covers rather than idx - DEPTH.
    const visible = [], srcIndex = [];
    records.forEach((r, i) => {
        if (i > idx || !isMessage(r) || (!INCLUDE_HIDDEN && r.is_system)) return;
        visible.push(r); srcIndex.push(i);
    });
    const query = query.buildQuery(visible, { depth: DEPTH });
    const queryChat = query.queryMessages(visible, { depth: DEPTH });
    const sceneStart = srcIndex[queryChat[0].i];
    const sceneEnd = srcIndex[queryChat[queryChat.length - 1].i];
    // The donor's knobs, minus `depth` — that is the scene's span, and this derivation sets its own.
    const { depth: _d, ...base } = { ...(src?.params ?? {}) };
    // The messages, not a window: what /wa-grade freezes (runState.lastScanChat).
    const scanChat = visible.slice(-DEPTH).map(r => ({ name: r.name, mes: r.mes }));
    const qv = await embed(query, { ollama: OLLAMA, model: MODEL });

    const armsOut = [];
    const pool = new Map();
    for (const [armName, override] of Object.entries(POOL_ARMS)) {
        const capture = { ...base, ...override };
        const S = {
            primaryBook: BOOK, books: allBooks, chat: CHAT,
            query, queryChat, scanChat, depth: DEPTH, params: capture,
            paramSnapshot: src?.paramSnapshot, index: built.path,
        };
        const P = sceneParams(S);
        // Per arm, not once: the gazetteer is baked at load time and an arm moves it.
        const scene = loadScene(S, { indexFile: indexPath(S, { model: MODEL }), indexOpts: { model: MODEL }, params: P });
        const haystack = haystackFor(S, P);
        // Term weights as scoreScene derives them; null runs every arm with the entity filter off (R22).
        const tw = P.entityFilter ? entity.buildTermWeights(query, scene.gaz, P.boost) : null;
        const rows = makeCandidateSet({ ...scene, params: P })(
            P.K1, P.B, tw, qv, query, haystack,
        );
        // Ordered but not truncated: a pool that is the whole population is one no later re-ranking can orphan a grade out of.
        const ranked = makeLayoutOrder({ scene, haystack: haystackFor(S, P) })(rows);
        const out = ranked.map((r, i) => {
            const e = r.entry;
            const row = {
                title: wiTitle(e),
                // Derived, not observed: sticky is 'sticky' only once an earlier turn armed it, and nothing offline does.
                block: e.constant ? 'constant' : 'dynamic',
                sticky: e.sticky || 0,
                tokens: tokens.count(e.content ?? ''),
                score: r5(r.fused), uid: Number(e.uid),
                wiOrder: e.waOriginalOrder ?? e.order ?? null,
                cosine: r.score !== undefined ? r5(r.score) : null, vRank: r.vectorRank ?? null,
                text: r.score !== undefined ? r2(r.textScore) : null, tRank: r.textRank ?? null,
                keys: r.keysEligible === false ? null : r2(r.keywordScore), kRank: r.keywordRank ?? null,
                // ST's entry.world, read once into WA's name for it.
                index: i, book: e.world ?? BOOK,
                why: whyFor(e, haystack(e), P),
            };
            // Keyed on row.book, never row.world, which is undefined here.
            if (!pool.has(`${row.book}${row.uid}`)) pool.set(`${row.book}${row.uid}`, row);
            return row;
        });
        armsOut.push({
            arm: armName, query, queryChat, scanChat, depth: DEPTH,
            primaryBook: BOOK, index: built.path,
            // Inside params, the open map the schema keeps arm knobs in.
            params: { ...capture, ...(INCLUDE_HIDDEN ? { includedHidden: true } : {}) },
            paramSnapshot: src?.paramSnapshot, budget: budgetFor(),
            // No grading depth was applied, recorded explicitly rather than omitted.
            cutoff: { gradingOverride: null, note: 'offline derivation records the full activated population' },
            candidates: out,
        });
    }

    const name = `${PREFIX}-msg${idx}`;
    const vec = [...pool.values()].filter(r => r.cosine !== null).length;
    console.log(`${name.slice(0, 30).padEnd(30)} ${String(armsOut.length).padStart(4)} ${String(pool.size).padStart(7)} ${String(vec).padStart(11)} ${String(pool.size - vec).padStart(13)}`);

    if (WRITE) {
        // Shared fields ride on every arm's sample: bundleSamples reads them off the first and hoists them once.
        const shared = {
            name,
            createdAt: new Date().toISOString(),
            createdBy: 'synth-scenes',
            books: allBooks,
            embedModel: MODEL, chat: CHAT,
            waVersion: WA_VERSION, stVersion: ST_VERSION,
            grades: [],
        };
        const bundle = await bundleSamples(
            armsOut.map(a => ({ arm: a.arm, sample: { ...shared, ...a } })),
            { start: sceneStart, end: sceneEnd, captureId: randomUUID() },
            // Generation provenance only; grading provenance travels with the grades (graft-grades.mjs).
            {
                // Relative like every other stored path — this one rides in `extra`, so it misses buildSample's choke point.
                generatedFrom: { chat: stRelative(CHAT), book: BOOK, attached, msg: idx, depth: DEPTH, model: MODEL, records: records.length },
                population: 'ranked',
            },
        );
        mkdirSync(resolvePath(OUT_DIR), { recursive: true });
        // Written per scene as it is produced: a run killed halfway keeps every scene it finished.
        writeFileSync(`${resolvePath(OUT_DIR)}/${name}.json`, JSON.stringify(bundle));
    }
}

console.log(`\nwrote ${picks.length} bundle(s) to ${resolvePath(OUT_DIR)}`);
console.log('ungraded by construction — run graft-grades.mjs to bring prior judgements onto matching (scene, entry) pairs');
