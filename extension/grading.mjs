// grading.mjs — assembles the graded-scene bundle /wa-grade writes and eval/graded-scene-grid.mjs reads back: query, grades,
// settings snapshot and the books themselves, frozen; the vector index is recorded by path only. ST-free.

import * as matcher from './matcher.mjs';

/** ST's top-level directories; a stored path is cut at the FIRST match, since a chat or a book may itself be named `data`. */
const ST_ROOTS = /[\\/](data|public|plugins|backups|default)[\\/]/;

export function stRelative(path) {
    if (typeof path !== 'string') return path;
    const m = ST_ROOTS.exec(path);
    return m ? path.slice(m.index + 1).replace(/\\/g, '/') : path;
}

/** A book's entries keyed by uid, verbatim and whole: a trimmed book moves stage 3's BM25 through the gazetteer. */
export function keyByUid(entries) {
    const out = {};
    for (const entry of (Array.isArray(entries) ? entries : Object.values(entries ?? {}))) out[entry.uid] = entry;
    return out;
}

/** WA's live settings under the harness's parameter names; the four ST globals (case, whole-word, includeNames, allowWIScan) are injected. */
export function captureParams(s, { caseSensitive, wholeWords, includeNames, allowWIScan, recursive, maxRecursionSteps }) {
    return {
        K1: s.bm25K1,
        chunkMode: s.chunkMode,
        chunkSize: s.chunkSize,
        minChunkSize: s.minChunkSize,
        B: s.bm25B,
        repeatCurve: s.repeatCurve,
        repeatR: s.repeatR,
        boost: s.properNounBoost,
        stopwordDf: s.stopwordDocFreq,
        meanCentered: s.meanCentered,
        maxVectorEntries: s.maxVectorEntries,
        entityFilter: s.entityFilter,
        caseSensitive,
        wholeWords,
        // Read back by the harness, not only snapshotted: without it a permissive capture re-scores at the default.
        wordBoundary: s.wordBoundary,
        // The same, for the unit a conjunction must match within: absent, the harness re-scores at `scan` whatever the run used.
        matchWindow: s.matchWindow,
        includeNames,
        // "Include in World Info Scanning" on the Author's Note panel: puts the note and the depth prompt into the scan for every entry.
        allowWIScan,
        // Core's two, by their own names. Absent means the capture predates the field, which eval/scene.mjs reads as off.
        recursive,
        maxRecursionSteps,
    };
}

/** Median; an even count takes the LOWER middle, so the result is always a grade a rater gave. */
const median = v => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)];

/** The grade in force on a row, NaN when ungraded: the latest human verdict, else the median of >= 3 llm verdicts (G7), else the latest llm. */
export const gradeValue = (g) => {
    const of = kind => (g?.grades ?? []).filter(v => v?.kind === kind).map(v => Number(v.grade)).filter(Number.isFinite);
    const human = of('human');
    if (human.length) return human[human.length - 1];
    const llm = of('llm');
    if (llm.length >= 3) return median(llm);
    if (llm.length) return llm[llm.length - 1];
    // A bare `grade` is a verdict a human has just typed and gradeEntries has not yet recorded — a live path (splitGraded, makeGradeOf).
    return Number(g?.grade);
};

/** A capture row in the prompt by intent: constant, or sticky with the effect ARMED (`block`, never the `sticky` setting); eval/scene.mjs `isDurableEntry` asks the same of a raw entry. */
export const isDurable = row => row.block === 'constant' || row.block === 'sticky';

/** Unit Separator — CLAUDE.md; never NUL. */
const US = '';

/** The fields (`query`, `scanChat` compared through the shipped window builder, `depth`) on which two captures are different scenes; empty means the same scene. */
export function sceneDiff(a, b, { ignoreTrailingWhitespace = false } = {}) {
    const scanOf = v => matcher.scanWindow(v?.scanChat ?? [], { depth: v?.depth, includeNames: true });
    const read = (v, f) => (f === 'scanChat' ? scanOf(v) : f === 'depth' ? Number(v?.depth) : v?.[f]);
    const flat = x => (typeof x === 'string' ? x.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n') : x);
    const norm = ignoreTrailingWhitespace ? flat : (x => x);
    return ['query', 'scanChat', 'depth'].filter(f => norm(read(a, f)) !== norm(read(b, f)));
}

/** A row's identity: book + uid. `book`, never `world` — past the ST boundary the name is `book` everywhere. */
export const rowKey = row => `${row.book ?? ''}${US}${row.uid}`;

const FILLABLE = ['cosine', 'text', 'keys'];

/** Unions several arms' candidate rows: the first arm wins a duplicate and accumulates `arms`, ordered by `bestRank`; only the raw signals under `scores` are filled from a later arm (`filled` names it). */
export function unionArms(arms) {
    const seen = new Map();   // rowKey -> { row, entry }
    for (const { arm, rows, entries } of arms ?? []) {
        (rows ?? []).forEach((row, i) => {
            const key = rowKey(row);
            const hit = seen.get(key);
            const rank = Number(row.index ?? Infinity);
            if (hit) {
                hit.row.arms.push(arm);
                hit.row.bestRank = Math.min(hit.row.bestRank, rank);
                for (const sig of FILLABLE) {
                    if (hit.row.scores?.[sig] == null && row.scores?.[sig] != null) {
                        (hit.row.scores ??= {})[sig] = row.scores[sig];
                        (hit.row.filled ??= {})[sig] = arm;
                        if (sig === 'keys' && !(hit.row.why ?? []).length && (row.why ?? []).length) hit.row.why = row.why;
                    }
                }
                return;
            }
            // `scores` is cloned: the fill writes into it, and a shallow copy would mutate the arm it came from.
            seen.set(key, { row: { ...row, scores: { ...(row.scores ?? {}) }, arms: [arm], bestRank: rank, from: arm }, entry: entries?.[i] });
        });
    }
    const merged = [...seen.values()].sort((a, b) => a.row.bestRank - b.row.bestRank);
    return { rows: merged.map(x => x.row), entries: merged.map(x => x.entry) };
}

/** Splits union rows into those still needing a human and those an earlier round judged, matched on book+uid, never title; `priorOf` is rowKey -> grade in force. */
export function splitGraded(rows, prior) {
    const priorOf = new Map();
    for (const g of prior ?? []) {
        const v = gradeValue(g);
        if (g && g.uid !== undefined && Number.isFinite(v)) {
            priorOf.set(rowKey(g), v);
        }
    }
    return {
        fresh: (rows ?? []).filter(r => !priorOf.has(rowKey(r))),
        known: (rows ?? []).filter(r => priorOf.has(rowKey(r))),
        priorOf,
    };
}

/** Appends this round's bare-`grade` rows onto the earlier rounds' verdicts; nothing is overwritten, and a repeat of the same pass (`passKey`) is skipped. */
export function mergeGrades(prior, fresh, who = {}) {
    const by = new Map();
    for (const g of prior ?? []) if (g && g.uid !== undefined) by.set(rowKey(g), g);
    for (const g of fresh ?? []) {
        if (!g || g.uid === undefined) continue;
        const seen = by.get(rowKey(g));
        const lifted = gradeEntries([g], who)[0];
        if (!seen) { by.set(rowKey(g), lifted); continue; }
        const verdict = lifted?.grades?.slice(-1)[0];
        if (!verdict) continue;
        if ((seen.grades ?? []).some(v => v.kind === 'human' && passKey(v) === passKey(verdict))) continue;
        by.set(rowKey(g), { ...seen, grades: [...(seen.grades ?? []), verdict] });
    }
    return [...by.values()];
}

/** The sample's `primaryBook`: the book contributing the most retrieved rows (`cosine !== null`, never truthiness — a 0 cosine is retrieved), or null. */
export function searchedBook(rows) {
    const counts = new Map();
    for (const row of rows ?? []) {
        if (row?.cosine !== null && row?.cosine !== undefined && row.book) {
            counts.set(row.book, (counts.get(row.book) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Assembles the sample. `queryChat`/`scanChat` are ST's {name, mes} messages; `injects` are {key, text, ambient, depth}; `sources` is
 *  matcher.usedMatchSources output; `books` is world -> uid-keyed entries; `chat`/`book`/`index` are paths, recorded not embedded; `now` is injected. */
export function buildSample({ name, notes, query, queryChat, scanChat, injects, sources, depth, chat, book, index, primaryBook, embedModel, params, snapshot, candidates, books, priority, grades, cutoff, gradedCandidates, pluginFP, sourceFP, waVersion, stVersion, now }) {
    const { budget, ...rest } = snapshot ?? {};
    return {
        name,
        notes: notes || `Graded ${now} from a live /wa-grade run.`,
        createdAt: now,
        createdBy: 'wa-grade',

        query,
        // What makes messageDepth sweepable offline: buildQuery over the last d of these reproduces the query at any depth <= capture.
        queryChat,
        // The haystack's inputs, never the haystack: a reader builds any window from these (matcher.mjs makeWindowFor).
        scanChat,
        injects,
        sources,
        depth,
        chat: stRelative(chat),
        // `pluginFP` served the capture, `sourceFP` is what the extension's own copy hashed to; equal means the deploy was current.
        pluginFP,
        sourceFP,
        // `<branch>@<git describe>`, undefined where the writer cannot resolve it.
        waVersion,
        stVersion,
        embedModel,
        budget,
        primaryBook,
        // Provenance only, never a fallback: no reader may open the live book.
        book: stRelative(book),
        index: stRelative(index),

        params,
        paramSnapshot: rest,

        bookPriority: priority,
        books,

        grades,
        gradeScale: GRADE_SCALE,

        // The grading depth, under its historical name.
        cutoff,
        // How many rows the grader was shown; rows past it are ungraded, not irrelevant.
        gradedCandidates,
        candidates,
    };
}

/** Fields identical across every arm, stored once at document level. Not query, candidates, params, cutoff or primaryBook: those are per-arm. */
const SHARED_FIELDS = ['name', 'notes', 'createdAt', 'createdBy', 'bookPriority', 'gradeScale', 'embedModel', 'budget', 'pluginFP', 'sourceFP'];

const GATE_INPUT_FIELDS = ['assistantCount', 'greetingIndex', 'personaName', 'firedLatches'];

const SCENE_FIELDS = ['chat', 'scanChat', 'injects', 'sources'];   // a sample's names for sceneChat / sceneChats / sceneInjects / sceneSources

/** Numeric signal values, which live under `scores` and a fitted model indexes by name; ranks and the fused score stay flat, being arm-relative. */
const SIGNAL_FIELDS = ['cosine', 'text', 'keys', 'properNouns', 'length'];

const SCHEMA_VERSION = 3;

/** A scene's id, `<chat basename>-msg-<end>`, every run outside `[A-Za-z0-9_]` collapsed to `-`. */
const sceneId = (chat, end) => {
    const base = String(chat ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
    return `${base.replace(/[^A-Za-z0-9_]+/g, '-')}-msg-${end}`;
};

/** A rater's canonical id: a human's UUID, or for an llm `modelDigest || modelName` and `rubric` US-joined — never a printable separator, model ids carry `:` and `/` (G8, P6). */
export const raterKey = r => (r?.kind === 'human'
    ? String(r.id ?? '')
    : [r?.modelDigest || r?.modelName || '', r?.rubric ?? ''].join(US));

/** The inverse; `isDigest` says whether the model half is a content digest or a name standing in for one. */
export const raterParts = r => (r?.kind === 'human'
    ? { id: r.id }
    : (([modelId, rubric]) => ({ modelId, rubric, isDigest: /^[0-9a-f]{64}$/.test(modelId) }))(String(r?.id ?? '').split(US)));

/** A pass's identity, what a writer deduplicates on: the rater and the day. Settings are not identity; `params` must not join it. */
export const passKey = v => [v?.id ?? '', v?.gradedAt ?? ''].join(US);

const RATER_DESC = ['modelName', 'family', 'quant', 'modelParams'];

/** The distinct raters across a scene's verdicts as one table, each verdict carrying its index. One `grades` array, not one per kind: the file promises order across kinds. */
function indexVerdicts(entries) {
    const raters = [];
    const at = new Map();
    const index = (v) => {
        const kind = v.kind === 'human' ? 'human' : 'llm';
        const id = raterKey({ kind, ...v });
        const key = `${kind}${US}${id}`;
        if (!at.has(key)) {
            const desc = {};
            for (const k of RATER_DESC) if (v[k]) desc[k] = v[k];
            at.set(key, raters.length);
            raters.push({ rater: raters.length, kind, id, ...desc });
        }
        return at.get(key);
    };
    const who = ({ kind, id, modelDigest, rubric, modelName, family, quant, modelParams, ...rest }) =>
        [{ kind, id, modelDigest, rubric, modelName, family, quant, modelParams }, rest];
    const out = (entries ?? []).map(e => ({
        ...e,
        ...((e.grades ?? []).length
            ? { grades: e.grades.map(g => { const [r, v] = who(g); return { rater: index(r), ...v }; }) }
            : {}),
    }));
    return { entries: out, raters };
}

/** A stored rater record expanded back into the fields raterKey composed it from; without it openBundle -> setGrades recomposes a different id (G9). */
const expandRater = (who) => {
    if (who?.kind !== 'llm') return who;
    const { modelId, rubric, isDigest } = raterParts(who);
    return {
        ...who,
        // raterKey reads `modelDigest || modelName`, so a NAME must not be restored as a digest.
        ...(isDigest ? { modelDigest: modelId } : { modelName: who.modelName ?? modelId }),
        ...(rubric ? { rubric } : {}),
    };
};

/** The inverse: an index back to the rater it names, so a reader never handles indices. */
const deref = (entries, raters = []) => (entries ?? []).map(e => ({
    ...e,
    ...(e.grades ? { grades: e.grades.map(({ rater, ...v }) => { const { rater: _i, ...who } = raters[rater] ?? {}; return { ...expandRater(who), ...v }; }) } : {}),
}));

/** Live grade rows -> scene entries carrying the record: a bare `grade` is a human's by definition and is appended as a verdict. */
function gradeEntries(grades, { user, now } = {}) {
    const out = [];
    for (const g of grades ?? []) {
        if (!g || g.uid === undefined) continue;
        const verdicts = [...(g.grades ?? [])];
        if (Number.isFinite(Number(g.grade))) {
            verdicts.push({ kind: 'human', ...(user ? { id: user } : {}), grade: Number(g.grade), ...(now ? { gradedAt: now } : {}) });
        }
        out.push({
            book: g.book ?? '',
            uid: g.uid,
            title: g.title,
            ...(verdicts.length ? { grades: verdicts } : {}),
        });
    }
    return out;
}


/** A debug row -> a v3 candidate: signals gathered under `scores`, everything else as-is. One direction only; there is no inverse. */
export const toCandidate = (row, i) => {
    const scores = { ...(row.scores ?? {}) };
    const flat = {};
    for (const [k, v] of Object.entries(row)) {
        if (SIGNAL_FIELDS.includes(k)) scores[k] = v; else flat[k] = v;
    }
    // Idempotent: a row that is already a candidate keeps its `scores`, since the UI and bundleSamples both convert the same row.
    delete flat.scores;
    return { book: row.book ?? '', uid: row.uid, index: Number(row.index ?? i), ...flat, scores };
};

/** Canonical JSON for hashing: keys sorted, since insertion order carries no meaning and two installs need not agree on it. */
const canonical = v => {
    if (v === undefined || typeof v === 'function') return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.keys(v).sort()
        .filter(k => v[k] !== undefined && typeof v[k] !== 'function')
        .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)
        .join(',')}}`;
};

/** Web Crypto, not node:crypto: the browser half imports this module. */
const sha256Hex = async text => [...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');

/** Drops `entry.world`, ST's back-pointer to the book name, which is present or absent by ST path and would hash one book two ways (G8). */
const withoutLocation = e => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
    const { world, ...rest } = e;
    return rest;
};

/** book name -> SHA-256 hex of its entries. Beside `books`, never inside: every reader walks a book with Object.values. */
export async function hashBooks(books) {
    return Object.fromEntries(await Promise.all(Object.entries(books ?? {}).map(
        async ([name, bk]) => [name, await sha256Hex(canonical(Object.fromEntries(
            Object.entries(bk ?? {}).map(([uid, e]) => [uid, withoutLocation(e)]))))])));
}

/** Packs one sample per arm into one schemaVersion 3 document; one scene is a one-element `scenes` list. `scene.user` is the rater
 *  id for freshly typed grades (state.mjs `raterId`); `extra` is document-level fields to carry. */
export async function bundleSamples(arms, scene = {}, extra = {}) {
    const first = arms[0]?.sample ?? {};
    const doc = { schemaVersion: SCHEMA_VERSION };
    if (scene.captureId) doc.captureId = scene.captureId;
    for (const f of SHARED_FIELDS) if (first[f] !== undefined) doc[f] = first[f];
    Object.assign(doc, extra);

    const id = sceneId(first.chat, scene.end);
    const indexed = indexVerdicts(gradeEntries(first.grades, { user: scene.user, now: first.createdAt }));

    // A scene is the graded moment, not a span: `sceneStart` and `depth` belong to the arm's cell.
    // The gate inputs a scene cannot re-derive from its own window (eval/bundle-schema.md); omitted, not
    // nulled, when the capture predates them, so a reader can tell "not recorded" from "none".
    const gateInputs = Object.fromEntries(GATE_INPUT_FIELDS.filter(f => first[f] !== undefined).map(f => [f, first[f]]));
    doc.scenes = [{ id, sceneChat: first.chat ?? '', sceneEnd: scene.end, ...gateInputs, entries: indexed.entries }];

    const whyBlock = {};
    doc.arms = arms.map(({ arm, sample }) => {
        const per = { name: arm };
        if (sample.waVersion !== undefined) per.waVersion = sample.waVersion;
        if (sample.stVersion !== undefined) per.stVersion = sample.stVersion;
        per.params = { ...(sample.params ?? {}), ...(sample.scoredBy ? { scoredBy: sample.scoredBy } : {}) };
        if (sample.paramSnapshot !== undefined) per.paramSnapshot = sample.paramSnapshot;
        const cell = { sceneStart: scene.start, depth: sample.depth };
        for (const [k, v] of Object.entries(sample)) {
            if (SHARED_FIELDS.includes(k) || SCENE_FIELDS.includes(k) || k in extra) continue;
            if (['arm', 'grades', 'candidates', 'params', 'paramSnapshot', 'depth', 'waVersion', 'stVersion', 'scoredBy', 'books'].includes(k)) continue;
            if (v === undefined) continue;
            cell[k] = v;
        }
        // Layout order, load-bearing: every stage-5 cap is a prefix cut replayed over the array as it stands. `why` moves to the trailing block, by position.
        const cands = (sample.candidates ?? []).map(toCandidate);
        cell.candidates = cands.map(({ why: _why, ...c }) => c);
        const whys = cands.map(c => c.why ?? []);
        if (whys.some(w => w.length)) whyBlock[arm] = { [id]: whys };
        per.scenes = { [id]: cell };
        return per;
    });

    // `query`/`queryChat` hoist onto the scene only when the arms agree; openBundle spreads the cell last, so a per-arm value wins.
    const cells = doc.arms.map(a => a.scenes[id]);
    const key = c => JSON.stringify([c.query ?? null, c.queryChat ?? null]);
    if (cells.length && cells.every(c => key(c) === key(cells[0]))) {
        const { query, queryChat } = cells[0];
        for (const c of cells) { delete c.query; delete c.queryChat; }
        if (query !== undefined) doc.scenes[0].query = query;
        if (queryChat !== undefined) doc.scenes[0].queryChat = queryChat;
    }

    if (indexed.raters.length) doc.raters = indexed.raters;

    // Field order is the schema (eval/bundle-schema.md): the bulk goes last, and the hashes stay ahead of the books.
    const books = first.books ?? {};
    doc.bookHashes = await hashBooks(books);

    if (Object.keys(whyBlock).length) doc.candidateWhy = whyBlock;

    doc.sceneChats = { [id]: first.scanChat ?? [] };
    if ((first.injects ?? []).length) doc.sceneInjects = { [id]: first.injects };
    // Only the fields some entry's `matchXxx` names (matcher.usedMatchSources): a persona description is the most personal text a shared file could carry.
    if (Object.keys(first.sources ?? {}).length) doc.sceneSources = { [id]: first.sources };
    doc.books = books;
    return doc;
}

/** One arm of one scene as a flat view, every field keeping its schema name; `arm` is the arm's `name`. Defaults to the 'shipped' arm and the only scene. */
export function openBundle(doc, arm = null, scene = null) {
    if (!Array.isArray(doc?.scenes)) {
        throw new Error('not a graded-scene document — no `scenes`');
    }
    const ids = doc.scenes.map(s => s.id);
    const sc = scene ? doc.scenes.find(s => s.id === scene) : doc.scenes[0];
    if (!sc) throw new Error(`document has no scene "${scene}" — available: ${ids.join(', ')}`);

    const over = (doc.arms ?? []).filter(a => a.scenes?.[sc.id]);
    const names = over.map(a => a.name);
    const wanted = arm ?? (names.includes('shipped') ? 'shipped' : names[0]);
    const hit = over.find(a => a.name === wanted);
    if (!hit) throw new Error(`scene "${sc.id}" has no arm "${wanted}" — available: ${names.join(', ')}`);

    const { scenes: _s, arms: _a, sceneChats, sceneInjects, sceneSources, raters, schemaVersion: _v, ...docFields } = doc;
    const { entries, ...sceneFields } = sc;
    const { name: armName, scenes: _cells, params, ...armFields } = hit;
    const { depth, ...cell } = hit.scenes[sc.id];
    const whys = doc.candidateWhy?.[armName]?.[sc.id];
    return {
        ...docFields,
        ...sceneFields,
        scanChat: sceneChats?.[sc.id] ?? [],
        injects: sceneInjects?.[sc.id] ?? [],
        sources: sceneSources?.[sc.id] ?? {},
        entries: deref(entries, raters),
        ...armFields,
        params,
        depth,
        ...cell,
        ...(whys ? { candidates: (cell.candidates ?? []).map((c, i) => (whys[i]?.length ? { ...c, why: whys[i] } : c)) } : {}),
        arm: armName,
    };
}

export const armNames = (doc, scene = null) => {
    const sc = scene ? doc?.scenes?.find(s => s.id === scene) : doc?.scenes?.[0];
    return sc ? (doc.arms ?? []).filter(a => a.scenes?.[sc.id]).map(a => a.name) : [];
};

/** Writes verdict rows (the entry shape openBundle hands out) back onto a single-scene document — the only writer of the layout besides bundleSamples. */
export function setGrades(doc, rows, who = {}) {
    if (!Array.isArray(doc?.scenes)) throw new Error('setGrades expects a schemaVersion 3 document');
    if (doc.scenes.length !== 1) throw new Error(`setGrades is for single-scene documents; this one has ${doc.scenes.length}`);
    const indexed = indexVerdicts(gradeEntries(rows, who));
    doc.scenes[0].entries = indexed.entries;
    if (indexed.raters.length) doc.raters = indexed.raters; else delete doc.raters;
    return doc;
}

/** The 0-4 scale's anchors, shown verbatim by the grading UIs; the wording is what agreement hangs on (G5). */
export const GRADE_ANCHORS = [
    'Definitely not relevant',
    'Most likely not relevant; include only as filler',
    'Weakly relevant; 50/50 on inclusion',
    'Fairly relevant; should likely be included',
    'Directly relevant; should absolutely be included',
];
export const GRADE_SCALE = GRADE_ANCHORS.length - 1;

export function sampleFile(sample) {
    const slug = String(sample.name || 'scene').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
    return { filename: `${slug}.json`, content: `${JSON.stringify(sample, null, 2)}\n` };
}
