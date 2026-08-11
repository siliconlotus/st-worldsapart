// prune-audit.mjs — the bucket 1.5 task-5 measurement: over a real chat, how often would the prune
// delete an entry core keyword-activated, and why. Runs the REAL prune verdict (matcher.mjs
// activationPrunes over makeWindowFor) against an emulation of core's matchKeys at every message of
// the chat, and classifies each would-prune event:
//
//   boundary      — matches WA's window under WA's fold with whole-word OFF: core's ASCII \W
//                   boundary matched where WORD_CHAR refuses (upstream-st.md #1). Rule divergence.
//   segmentation  — matches WA's window at matchWindow 'scan': the paragraph/message window is what
//                   rejects it (secondary keys or a SmartKey split across segments). Named WA semantic.
//   depth         — matches under WA's rules over CORE's window but not WA's: only possible when
//                   core scans deeper than messageDepth. The ruled direction.
//   other         — none of the retests match; the fold or emulation drift. Look at these by hand.
//
// CORE EMULATION, DELIBERATELY. "countKey is the only matcher" governs runtime and reporting
// surfaces — anything that tells a user how a key behaves. This tool MEASURES the divergence
// between the two matchers, which definitionally needs both sides; core's side is the emulation
// below (lowercase-only fold, \W boundaries, whole-buffer secondary logic), kept small and marked.
//
// NOT MODELED, and how that biases the count: timed-effect exemptions (sticky would rescue some of
// these at runtime — the count here is an upper bound), recursion passes (the prune never judges
// them), injects and regex-script/file transforms (offline chats carry none). Suppressed-vectorized
// entries are excluded when --suppress is on (default), as at runtime.
//
// Usage: node eval/prune-audit.mjs [--core-depth 2] [--wa-depth 10] [--match-window paragraph]
//                                  [--stride 1] [--no-suppress] <book.json> <chat.jsonl> [pairs...]
import fs from 'node:fs';
import { activationPrunes, makeWindowFor, countKey, escapeRegex, WI_LOGIC } from '../extension/matcher.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    if (i === -1) return dflt;
    const v = args.splice(i, 2)[1];
    return v;
};
const CORE_DEPTH = Number(opt('--core-depth', 2));
const WA_DEPTH = Number(opt('--wa-depth', 10));
const MATCH_WINDOW = String(opt('--match-window', 'paragraph'));
const STRIDE = Number(opt('--stride', 1));
const noSuppressIdx = args.indexOf('--no-suppress');
const SUPPRESS = noSuppressIdx === -1 || (args.splice(noSuppressIdx, 1), false);

if (args.length < 2 || args.length % 2 !== 0) {
    console.error('usage: node eval/prune-audit.mjs [--core-depth N] [--wa-depth M] [--match-window mode] [--stride S] [--no-suppress] <book.json> <chat.jsonl> [pairs...]');
    process.exit(1);
}

// --- core matchKeys emulation (see header) -----------------------------------------------------
const coreCount = (key, text, caseSensitive, wholeWords) => {
    const raw = String(key ?? '').trim();
    if (!raw || !text) return 0;
    // Core has no `?` semantics — a SmartKey is a literal needle (the defect the union fixes).
    const rx = raw.match(/^\/(.+)\/([gimsuy]*)$/);
    if (rx) {
        try { return new RegExp(rx[1], rx[2]).test(text) ? 1 : 0; } catch { return 0; }
    }
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? raw : raw.toLowerCase();
    if (wholeWords) {
        // Core's exact shape: escapeRegex + (?:^|\W)(key)(?:$|\W), ASCII classes, no `u` flag.
        try { return new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`).test(hay) ? 1 : 0; } catch { return 0; }
    }
    return hay.includes(needle) ? 1 : 0;
};

const coreActivates = (entry, text, csDefault, wwDefault) => {
    const cs = entry.caseSensitive ?? csDefault;
    const ww = entry.matchWholeWords ?? wwDefault;
    const keys = (entry.key ?? []).filter(k => String(k ?? '').trim());
    if (!keys.length || !keys.some(k => coreCount(k, text, cs, ww) > 0)) return false;
    const sec = (entry.keysecondary ?? []).filter(k => String(k ?? '').trim());
    if (!sec.length) return true;
    let any = false, all = true;
    for (const k of sec) {
        if (coreCount(k, text, cs, ww) > 0) any = true;
        else all = false;
    }
    switch (entry.selectiveLogic ?? WI_LOGIC.AND_ANY) {
        case WI_LOGIC.NOT_ALL: return !all;
        case WI_LOGIC.NOT_ANY: return !any;
        case WI_LOGIC.AND_ALL: return all;
        default: return any;
    }
};

// --- the audit ---------------------------------------------------------------------------------
const OPTS = { messageDepth: WA_DEPTH, fallbackDepth: CORE_DEPTH, caseSensitiveDefault: false, wholeWordsDefault: false };
const totals = { anchors: 0, coreActs: 0, prunes: 0, byClass: new Map() };

for (let p = 0; p + 1 < args.length; p += 2) {
    const bookPath = args[p], chatPath = args[p + 1];
    const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
    const msgs = fs.readFileSync(chatPath, 'utf8').split('\n').filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(m => m && typeof m.mes === 'string' && !m.is_system)
        .map(m => ({ name: m.name, mes: m.mes }));

    // The prunable population, as at runtime: keyed, enabled, not suppressed-vectorized. The
    // structural exemptions (constant, @@activate, error-only keys) live inside activationPrunes.
    const entries = Object.values(book.entries ?? {})
        .filter(e => !e.disable && (e.key ?? []).some(k => String(k ?? '').trim()))
        .filter(e => !(SUPPRESS && e.vectorized));

    const name = bookPath.split('/').pop().replace(/\.json$/, '');
    const stat = { anchors: 0, coreActs: 0, prunes: 0, byClass: new Map(), byKey: new Map() };

    for (let i = 0; i < msgs.length; i += STRIDE) {
        stat.anchors++;
        const window = msgs.slice(0, i + 1);
        const coreText = window.slice(-CORE_DEPTH).map(m => `${m.name}: ${m.mes}`).join('\n');
        const active = entries.filter(e => coreActivates(e, coreText, false, false));
        if (!active.length) continue;
        stat.coreActs += active.length;

        const windowFor = makeWindowFor(window, { matchWindow: MATCH_WINDOW, includeNames: true });
        const judged = active.map(e => ({ key: `${name}.${e.uid}`, entry: e }));
        const pruned = new Set(activationPrunes(judged, new Set(), windowFor, OPTS));
        for (const { key, entry } of judged) {
            if (!pruned.has(key)) continue;
            stat.prunes++;
            // Classify by retesting under relaxations. Scan-mode first: it resolves any verdict
            // divergence that the segmented window causes (secondary keys or SmartKey terms split
            // across segments) — including entries where the key is present as a substring, which
            // a naive boundary-first test would swallow. Boundary requires the whole-word shape.
            const scanFor = makeWindowFor(window, { matchWindow: 'scan', includeNames: true });
            const cs = entry.caseSensitive ?? false;
            const ww = entry.matchWholeWords ?? false;
            const waWindowText = windowFor(WA_DEPTH, entry).join('\n');
            let cls = 'other';
            if (!activationPrunes([{ key, entry }], new Set(), scanFor, OPTS).length) cls = 'segmentation';
            else if (ww && (entry.key ?? []).some(k => countKey(k, waWindowText, cs, false))) cls = 'boundary';
            else if ((entry.key ?? []).some(k => countKey(k, coreText, cs, ww))) cls = 'depth';
            stat.byClass.set(cls, (stat.byClass.get(cls) ?? 0) + 1);
            const kk = `${cls}  uid=${entry.uid}  [${(entry.key ?? []).join(', ').slice(0, 60)}]`;
            stat.byKey.set(kk, (stat.byKey.get(kk) ?? 0) + 1);
        }
    }

    console.log(`\n== ${name} — ${entries.length} prunable of ${Object.keys(book.entries ?? {}).length} entries, ${msgs.length} usable messages (stride ${STRIDE})`);
    console.log(`   core keyword activations: ${stat.coreActs} entry-anchors; would-prune: ${stat.prunes}`
        + (stat.coreActs ? ` (${(100 * stat.prunes / stat.coreActs).toFixed(2)}%)` : ''));
    for (const [cls, n] of [...stat.byClass].sort((a, b) => b[1] - a[1])) console.log(`     ${cls}: ${n}`);
    for (const [kk, n] of [...stat.byKey].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`       ${n}×  ${kk}`);

    totals.anchors += stat.anchors; totals.coreActs += stat.coreActs; totals.prunes += stat.prunes;
    for (const [cls, n] of stat.byClass) totals.byClass.set(cls, (totals.byClass.get(cls) ?? 0) + n);
}

console.log(`\n== TOTAL — anchors ${totals.anchors}, core activations ${totals.coreActs}, would-prune ${totals.prunes}`
    + (totals.coreActs ? ` (${(100 * totals.prunes / totals.coreActs).toFixed(2)}%)` : ''));
for (const [cls, n] of [...totals.byClass].sort((a, b) => b[1] - a[1])) console.log(`   ${cls}: ${n}`);
