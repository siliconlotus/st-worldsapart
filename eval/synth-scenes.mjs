// synth-scenes.mjs — derives synthetic graded-scene bundles from a live chat and a live world.
//
// One operation, two ways to pick the turns: `--msgs` names them (re-derive an existing set against a
// changed book), `--n` samples them (grow one). Re-deriving is this tool with the old message ids followed
// by graft-grades.mjs, which puts the old judgements back on the (scene, entry) pairs they were made about.
//
// Nothing is carried from a previous bundle: everything comes from the chat and the world as they are now,
// and the only inputs that may come from elsewhere are the message ids (H8). Message ids are raw record
// indices — line N of the .jsonl, hidden messages counted — while the query and scan window are built from
// is_system-filtered messages, because query.queryMessages and matcher.scanWindow both expect the caller to
// have dropped them.
//
// Every book the chat had attached is embedded, not only the one being ranked: loadScene builds the
// gazetteer from all of them because production's spans all of them, and those terms decide which query
// terms survive the entity filter (R22). The set is detected and --also only adds to it — a binding ST adds
// later goes unread here, whose only symptom is a narrower gazetteer. Names, never data: a card's
// `character_book` blob is the import-time payload and is stale the moment the world file is edited, so
// entry data always comes from the live world file, primary and attached alike.
//
// Usage (any cwd):
//   node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> --msgs 123,456 [--write]
//   node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> --n 14 --seed 7 [--write]
//   node eval/synth-scenes.mjs --from <bundle.json> --msgs same [--write]
//   ... [--also "other book"]   ADD a book the five bindings do not name; detection covers the rest
//   ... [--include-hidden]   derive turns marked is_system, for scenes graded before they were hidden
// Dry by default: prints what it would generate. Each bundle is written as it is produced, never at the end.
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

/**
 * The pooling arms, in harness vocabulary. Mirrors worldsapart.js POOL_ARMS, which is written in settings
 * vocabulary and cannot be imported (that module pulls in ST).
 */
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

// The donor: an existing graded scene whose chat, book, depth, params and chunking a fresh derivation
// inherits. Read through openBundle, so this file never learns where in a document those live.
const src = FROM ? openBundle(JSON.parse(readFileSync(FROM, 'utf8'))) : null;
// Depth is part of the scene, so --from inherits it, and depth 10 is the corpus so it is the default rather
// than something every invocation has to remember (G13). A set derived at anything else cannot be compared
// with the rest, and the failure is silent — the bundle looks fine and only its query is short.
const DEPTH = Number(arg(argv, '--depth') ?? src?.params?.depth ?? 10);
const CHAT = arg(argv, '--chat') ?? src?.sceneChat;
const BOOK = arg(argv, '--book') ?? src?.primaryBook;
// From the donor's own `name`, not its filename — `sampleFile` derives one from the other, so they agree
// until someone renames the file. A prefix is how a fold is told apart by eye (CLAUDE.md, graded scenes).
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

// --- the live world -----------------------------------------------------------------------------------
// By filename, which is how ST addresses a book and what it hashes into the collection id. The `name`
// inside the file is whatever it was last copied from and goes stale silently.
const worldPath = st.resolve(`data/default-user/worlds/${BOOK}.json`);
if (!existsSync(worldPath)) { console.error(`no world file for "${BOOK}" at ${worldPath}`); process.exit(2); }
const entries = JSON.parse(readFileSync(worldPath, 'utf8')).entries;
const byUidWorld = Object.fromEntries(Object.values(entries).map(e => [e.uid, { ...e, world: BOOK }]));

/**
 * One character card's `data.extensions.world` — a book name, never book data.
 *
 * ST copies an embedded lorebook into worlds/ on import and reads it from there ever after, so the card's
 * own `character_book` blob goes stale the moment the world file is edited. Only the name is live.
 *
 * Walks the PNG chunk table for the tEXt/iTXt entry ST writes ('ccv3', else 'chara'), whose value is
 * base64 JSON. Returns null for anything unreadable — a card with no book is the common case, not an error.
 */
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
                    // ccv3 wins when both are present; it is the newer of the two ST writes.
                    if (w && (key === 'ccv3' || !best)) best = w;
                } catch { /* an unreadable chunk is not a card */ }
            }
        }
        off += 12 + len;
    }
    return best;
}

/**
 * Every book ST would have loaded for this chat, by name.
 *
 * A deliberate duplicate of worldsapart.js worldSourceRank's five bindings — global, persona, character
 * (primary), character (additional), chat. WA itself reads getSortedEntries() and takes the distinct
 * `world` values back out (runState.attachedWorlds), and that function is unreachable offline.
 *
 * The duplication is the point of failure to watch: a binding ST adds later is one this does not read, and
 * the symptom is a narrower gazetteer, which looks like nothing at all. Hence --also, which adds to
 * whatever this finds rather than replacing it, and the per-source line printed below.
 */
function attachedWorlds(chatRelPath) {
    const out = new Map();       // name -> which binding found it
    const add = (name, src) => { if (name && !out.has(name)) out.set(name, src); };
    let settings = {};
    try { settings = JSON.parse(readFileSync(`${st.dataRoot}/default-user/settings.json`, 'utf8')); } catch { /* no settings is not fatal */ }
    const wi = settings.world_info_settings?.world_info ?? {};
    for (const w of wi.globalSelect ?? []) add(w, 'global');
    add(settings.power_user?.persona_description_lorebook, 'persona');
    // The character is the chat file's own directory — ST stores chats under chats/<character>/.
    const chara = basename(dirname(chatRelPath));
    add(cardWorld(st.resolve(`data/default-user/characters/${chara}.png`)), 'character');
    for (const w of (wi.charLore ?? []).find(e => e.name === chara)?.extraBooks ?? []) add(w, 'character-extra');
    try {
        const head = JSON.parse(readFileSync(st.resolve(chatRelPath), 'utf8').split('\n', 1)[0]);
        add(head?.chat_metadata?.world_info, 'chat');
    } catch { /* handled by the chat check below */ }
    return out;
}

// The other attached books. Detected from the live bindings, plus anything --also names, plus whatever the
// source bundle embedded under --from — a capture records every book that was live, so a re-derivation
// must never narrow it. Union, not override: each source can only add, because every failure this guards
// against is a book going missing.
const detected = attachedWorlds(CHAT);
const ALSO = [...new Set([
    ...[...detected.keys()],
    ...String(arg(argv, '--also') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    ...Object.keys(src?.books ?? {}),
])].filter(w => w !== BOOK);
// A binding can name a book that no longer exists — a card outlives a renamed or deleted world. ST loads
// what it finds and ignores the rest, so a missing attached book is skipped with a warning rather than
// fatal; the primary book still exits above, since nothing can be ranked without it.
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

/**
 * What the bindings said, beside what got embedded — written onto the bundle so a reader can tell the two
 * apart later. They agree by construction: loadScene builds the gazetteer from every key of `books`, and
 * `books` is the primary plus the attached books that resolved. The one legitimate divergence is a binding
 * naming a world with no file, which is skipped because ST would not load it either. `loaded` is what makes
 * the invariant testable: the loaded names must be exactly the keys of `books`.
 */
const attached = [BOOK, ...ALSO].map(book => ({
    book,
    source: detected.get(book) ?? 'named',
    // null = no world file. Distinct from the fingerprint of a book that exists and is empty, which is a
    // real hash of nothing; a boolean cannot tell those apart, and a bare count calls both of them zero.
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

// --- the live chat ------------------------------------------------------------------------------------
// Whole file, not a tail read: graded-scene-grid tails because it only ever wants the newest turn, while
// sampling an arbitrary message needs the beginning, and a raw index is only meaningful against every record.
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
    // From the donor's own fields, never from its filename: parsing `-msg(\d+)` out of the name derives a
    // scene at whatever number the file happens to be called, so a rename silently changes the turn.
    // `sceneEnd` is the message the scene ends at; `generatedFrom.msg` is what wrote it.
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

// Hidden turns are still scenes. is_system is a rule about what the runtime scans, not about whether the
// turn happened or whether an entry is relevant to it, so --include-hidden treats hidden messages as present
// when building the query and scan window — the only way to reproduce a scene graded while they were
// visible. Off by default and stamped on the bundle when used, because such a scene is not one the runtime
// could produce today and nothing else on the row says so.
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

// A dry run stops here, before the collection is built. Everything a dry run is for is already on screen,
// and ensureIndex is the one step that spends: it embeds the whole book, and writes into a cache keyed by
// book name, so a dry run reaching it would leave a real collection behind under whatever name it was passed.
if (!WRITE) {
    console.log('\nDRY — nothing written and nothing embedded. Re-run with --write.');
    process.exit(0);
}

/**
 * A repo's resolved version, as the schema wants it: `<branch>@<git describe --tags --always --dirty>`.
 *
 * Resolved, never declared — manifest.json and package.json name the next release, not what ran. `+dirty`
 * rather than git's `-dirty` because it is SemVer build metadata: `0.2.0+dirty` compares equal to `0.2.0`,
 * where a pre-release suffix would sort below it. Empty when the directory is not a repo or git is absent.
 */
const gitVersion = (dir) => {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return `${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('describe', '--tags', '--always', '--dirty=+dirty')}`;
    } catch { return ''; }
};

// The two repos this capture came out of. WA is this file's own tree; ST is the install serving it.
const WA_VERSION = gitVersion(resolvePath(dirname(fileURLToPath(import.meta.url)), '..'));
const ST_VERSION = st?.root ? gitVersion(st.root) : '';

const r5 = x => (Number.isFinite(x) ? Number(x.toFixed(5)) : null);
const r2 = x => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

// Tokens are recorded so a budget of any size can be replayed: a bundle carrying only the budget its capture
// ran under answers exactly one question. Counted offline at the same value the runtime would have recorded
// (tokens.mjs), so a derived row and a captured one are comparable rather than two estimates. The tokenizer
// is the source capture's when there is one and the default otherwise, and either way it is written down
// below — offline it is a harness choice, not an observation.
const TOKENIZER = src?.budget?.tokenizer ?? 'gpt-3.5-turbo';
const tokens = offlineTokenCounter(TOKENIZER);

// The budget block a derived bundle should carry: the settings it was derived under, minus the one field
// that is a resolved runtime number. `maxTokens` on the source is a display string (G13) — a percentage of
// whatever context window was open on that machine — and no budget was applied here, so passing it through
// would describe a run that never happened.
/** The document's own budget block: the source's, with the live token cap dropped (a derived scene
 *  imposes none) and the tokenizer pinned so the recorded per-entry counts stay interpretable. */
const budgetFor = () => ({ ...(src?.budget ?? {}), maxTokens: null, tokenizer: TOKENIZER });

// The collection, built once from the live world and shared by every scene — same book, same chunking.
// The current writer's scalar dump; the pre-v3 grouped `vectors` block is not read (reindex.mjs
// chunkConfig), so a synthesised scene chunks the way the app would chunk it today.
const chunkOverrides = src?.paramSnapshot?.settings ?? {};
const shell = { primaryBook: BOOK, books: allBooks, paramSnapshot: src?.paramSnapshot };
const built = await ensureIndex(shell, { overrides: chunkOverrides, model: MODEL, ollama: OLLAMA, log: m => console.log(`  ${m}`) });
console.log(`collection: ${built.items} chunks${built.built ? ' (built)' : ' (cached)'}\n`);

console.log(`scene                          arms  pooled  vectorized  keyword-only`);
for (const idx of picks) {
    // The visible messages AND where each came from, so the scene can record the message range it covers
    // rather than approximating it as `idx - DEPTH`: the window skips hidden and empty messages, so the
    // two differ exactly when a scene has any. queryMessages' `i` indexes into what it was handed.
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
    // The messages, not a window — the same thing /wa-grade freezes (`runState.lastScanChat`), sliced to the
    // derivation's depth and trimmed to what a haystack is built from.
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
        // Loaded per arm, not once: the gazetteer is baked in at load time and an arm
        // moves it. scoreScene throws rather than reuse a scene across that change, for the same reason.
        const scene = loadScene(S, { indexFile: indexPath(S, { model: MODEL }), indexOpts: { model: MODEL }, params: P });
        const haystack = haystackFor(S, P);
        // Term weights exactly as scoreScene derives them. Passing null instead runs every arm with the
        // entity filter off, which inflates the query term set and BM25 with it (R22) under an arm label
        // that says nothing about it.
        const tw = P.entityFilter ? entity.buildTermWeights(query, scene.gaz, P.boost) : null;
        const rows = makeCandidateSet({ ...scene, params: P })(
            P.K1, P.B, tw, qv, query, haystack,
        );
        // Every activated row, ordered but not truncated — a pool that is the whole population is one no
        // later re-ranking can orphan a grade out of.
        const ranked = makeLayoutOrder({ scene, haystack: haystackFor(S, P) })(rows);
        const out = ranked.map((r, i) => {
            const e = r.entry;
            const row = {
                title: wiTitle(e),
                // Derived, not observed: offline there is no runtime budget class. `constant` is a property
                // of the entry and survives that; `sticky` is not — the block reads 'sticky' only once an
                // earlier turn armed the effect, and nothing offline does, so writing it from the configured
                // value would invent an armed state isDurable then believes.
                block: e.constant ? 'constant' : 'dynamic',
                sticky: e.sticky || 0,
                tokens: tokens.count(e.content ?? ''),
                score: r5(r.fused), uid: Number(e.uid),
                wiOrder: e.waOriginalOrder ?? e.order ?? null,
                cosine: r.score !== undefined ? r5(r.score) : null, vRank: r.vectorRank ?? null,
                text: r.score !== undefined ? r2(r.textScore) : null, tRank: r.textRank ?? null,
                keys: r.keysEligible === false ? null : r2(r.keywordScore), kRank: r.keywordRank ?? null,
                // ST's `entry.world` read once, into WA's name for it.
                index: i, book: e.world ?? BOOK,
                why: whyFor(e, haystack(e), P),
            };
            // Keyed on `row.book`, never `row.world`, which is undefined here: otherwise every book's rows
            // share one key and a uid present in two books keeps whichever came first.
            if (!pool.has(`${row.book}${row.uid}`)) pool.set(`${row.book}${row.uid}`, row);
            return row;
        });
        armsOut.push({
            arm: armName, query, queryChat, scanChat, depth: DEPTH,
            primaryBook: BOOK, index: built.path,
            // Inside `params`, not beside it: whether hidden messages were kept is a capture-time knob of
            // the configuration, and `params` is the open map the schema keeps arm knobs in.
            params: { ...capture, ...(INCLUDE_HIDDEN ? { includedHidden: true } : {}) },
            paramSnapshot: src?.paramSnapshot, budget: budgetFor(),
            // No grading depth was applied, recorded explicitly rather than omitted. (The field is named
            // for the stage-4 cliff it also used to carry; that cut no longer exists.)
            cutoff: { gradingOverride: null, note: 'offline derivation records the full activated population' },
            candidates: out,
        });
    }

    const name = `${PREFIX}-msg${idx}`;
    const vec = [...pool.values()].filter(r => r.cosine !== null).length;
    console.log(`${name.slice(0, 30).padEnd(30)} ${String(armsOut.length).padStart(4)} ${String(pool.size).padStart(7)} ${String(vec).padStart(11)} ${String(pool.size - vec).padStart(13)}`);

    if (WRITE) {
        // Shared on every arm's sample because bundleSamples reads them off the first and hoists them
        // once; an arm never carries a copy.
        const shared = {
            name,
            createdAt: new Date().toISOString(),
            createdBy: 'synth-scenes',
            books: allBooks,
            embedModel: MODEL, chat: CHAT,
            waVersion: WA_VERSION, stVersion: ST_VERSION,
            // Nothing is graded yet: a derived scene is a pool waiting for verdicts, and graft-grades.mjs
            // or grade-pending.mjs puts them on.
            grades: [],
        };
        const bundle = await bundleSamples(
            armsOut.map(a => ({ arm: a.arm, sample: { ...shared, ...a } })),
            { start: sceneStart, end: sceneEnd, captureId: randomUUID() },
            // Generation provenance only. How the grades were made is the grades' own and travels with them
            // in graft-grades.mjs; conflating the two makes a bundle's history unreadable.
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
