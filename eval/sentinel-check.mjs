// The sentinel book + chat: a fixture where every audit verdict has a known right answer, so a change
// that silently disconnects one is caught here instead of by squinting at a tooltip.
//
// WHY IT EXISTS. Three separate faults shipped behind a green suite because every check called the
// classifier directly, one layer below what the Studio uses: a wrapper that dropped its options, a
// hardcoded verdict string, and an audit path that gathered no evidence. This exercises the same
// inputs the Studio produces — a real world-info file, a real .jsonl with a hidden message in it —
// and asserts the verdicts rather than the internals.
//
// The files are also importable into SillyTavern, which is the point: the half that cannot be tested
// from node (chips, tooltips, colours) is eyeballed against a book whose every answer is written down.
import fs from 'node:fs';
import { buildKeyPruneScan } from '../extension/keyword-core.mjs';
import { keywordScore, scanSegments, countKey, isRegexKey, activationAdds, makeWindowFor } from '../extension/matcher.mjs';
import { buildKeyPruneScan as _pruneScan } from '../extension/keyword-core.mjs';
import { buildAutomaton, addMessageHits, fold } from '../extension/smartkeys.mjs';
import { eq } from './metrics.mjs';

const here = new URL('./fixtures/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('sentinel-book.json', here), 'utf8'));
const msgs = fs.readFileSync(new URL('sentinel-chat.jsonl', here), 'utf8').split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l)).filter(m => typeof m.mes === 'string' && !m.is_system).map(m => m.mes);

const OPTS = {
    scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true,
    ignoreProper: false, bookCommon: 0.5, minLength: 4, bookShared: 0.75,
};
const RED = '#e06c6c';
const entries = Object.values(data.entries);
const keys = [...new Set(entries.flatMap(e => e.key.map(k => String(k).trim())))];

/** The chat scan exactly as the Studio's client path builds it. */
const chatRate = () => {
    const literals = keys.filter(k => !k.startsWith('?') && !isRegexKey(k));
    const folded = [...new Set(literals.map(fold))];
    const idxOf = new Map(folded.map((f, i) => [f, i]));
    const aut = buildAutomaton(folded);
    const counts = new Map();
    for (const t of msgs) addMessageHits(aut, t, counts);
    // Literals only, exactly as scanChats does: a `?` SmartKey cannot be found by an automaton built from
    // folded literals, so it is left OUT of the map rather than recorded as 0 — absent means unchecked.
    return { messagesWith: new Map(literals.map(k => [k, counts.get(idxOf.get(fold(k))) ?? 0])), messages: msgs.length };
};

const verdicts = (chat, matchWindow = 'scan') => {
    const s = buildKeyPruneScan(data, OPTS, new Set(), { chatScan: chat, matchWindow });
    const out = {};
    for (const e of entries) for (const p of s.classifyEntry(e)) out[p.key] = { flag: p.flag, why: s.reasonOf(p).text, sev: s.severityOf(p) };
    return out;
};

eq(msgs.length, 11, 'the hidden message is dropped, as core and WA both drop it');

// --- no chat evidence -------------------------------------------------------------------------
{
    const v = verdicts(undefined);
    eq(v.quarkspindle, undefined, 'a key in its own entry text is not flagged');
    eq(v.zzunattested?.why, 'not in entry text', 'dead, and says only that entry text was checked');
    eq(v.glimmerwort?.why, 'not in entry text', 'chat-only key reads dead when no chat was searched');
    eq(v.mother?.flag, 'english common', 'the English list flags a generic word with no chat needed');
    eq(v.mother?.sev !== RED, true, '...but unevidenced it is not severe');
}

// --- with the chat ----------------------------------------------------------------------------
{
    const v = verdicts(chatRate());
    eq(v.glimmerwort, undefined, 'a key the chat uses is not dead — the flag is dropped');
    eq(v.zzunattested?.why, 'not in entry text or chat', 'still dead, and now says both were checked');
    eq(v.morning?.sev, RED, 'a common word the chat confirms fires broadly is severe');
    eq(v.mother?.sev !== RED, true, 'a common word the chat says is quiet stays a warning');
    eq(v['? thornwick brambleshaw'], undefined, 'at scan the query is attested by its own entry text');
    // A `?` key is not in the automaton's alphabet, so the chat scan cannot speak to it. Where it IS
    // dead — paragraph mode splits its two terms apart — it must keep the weaker claim rather than be
    // credited with a search that never covered it.
    // A dead QUERY reads "never matches" rather than "not in entry text" — it evaluated false, which is
    // a different sentence — and that wording carries no claim about the chat, which is correct here:
    // the automaton could not see it either.
    const p = verdicts(chatRate(), 'paragraph')['? thornwick brambleshaw'];
    eq(p?.why, 'never matches', 'a dead query says it evaluated false, claiming nothing about the chat');
}

// --- the match window reaches the audit -------------------------------------------------------
{
    const scan = verdicts(undefined, 'scan'), msg = verdicts(undefined, 'message'), para = verdicts(undefined, 'paragraph');
    eq(scan['? thornwick brambleshaw'], undefined, 'at scan the query is attested across the entry');
    // An entry's content is one text, so `message` has nothing to split — for the AUDIT it is scan by
    // another name, and only paragraph subdivides. The distinction is real on the chat side only.
    eq(msg['? thornwick brambleshaw'], undefined, 'message cannot subdivide entry text, so it matches scan');
    eq(para['? thornwick brambleshaw']?.flag, 'unattested', 'at paragraph its terms never share a segment');
}

// --- and the runtime scores the same way ------------------------------------------------------
{
    const chat = msgs.map(m => ({ name: 'Sentinel', mes: m }));
    const e = data.entries['3'];
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const at = mw => keywordScore(e, scanSegments(chat, { depth: 20, matchWindow: mw }), e.key, cfg).score;
    eq(at('scan') > 0, true, 'scan: the query matches across the window');
    eq(at('message') > 0, true, 'message: both terms are in one message');
    eq(at('paragraph'), 0, 'paragraph: they are in different paragraphs of it');
}

// --- the substring accident, for the parked collapse diagnostic --------------------------------
{
    const sub = msgs.filter(m => countKey('ver', m, false, false) > 0).length;
    const whole = msgs.filter(m => countKey('ver', m, false, true) > 0).length;
    eq(sub > 0 && whole === 0, true, `"ver" fires ${sub}/${msgs.length} as substring and never as a word`);
}

console.log('ok   sentinel: every audit verdict matches its written-down answer');

// --- the terrace group: WA's verdicts reach the group filter, so the right entry wins ----------
// The written-down answers for uids 7-9. Core's runtime half (the group filter sees WA's matches and
// picks uid 9) is the eyeball check in ST; what node can certify is every verdict that runtime is
// built from.
{
    const chat = fs.readFileSync(new URL('sentinel-chat.jsonl', here), 'utf8').split('\n').filter(l => l.trim())
        .map(l => JSON.parse(l)).filter(m => typeof m.mes === 'string' && !m.is_system);
    const windowFor = makeWindowFor(chat, { matchWindow: 'paragraph', includeNames: true });
    const opts = { messageDepth: 20, fallbackDepth: 2, caseSensitiveDefault: false, wholeWordsDefault: false };

    // The divergence itself, pinned: core's \W reads é as a boundary (upstream-st.md #1), WA does not.
    eq(countKey('caf', 'the café by the bistro', false, true), 0, 'whole-word caf does not match café under WA');
    eq(countKey('caf', 'the café by the bistro', false, false), 1, 'substring caf would — the flag is the divergence');

    const adds = activationAdds(Object.values(data.entries), windowFor, opts).map(e => e.uid);
    eq(adds.includes(7), true, 'the SmartKeys-only entry is union-activated — only WA can do this');
    eq(adds.includes(9), true, 'the clean loser matches and is union-activated');
    eq(adds.includes(8), false, 'the false winner does not match under WA — never added');

    // uid 8 is the group's false winner under CORE's rules (its key matches only on the \W boundary
    // divergence above). WA's matcher runs BEFORE the group filter, so core never sees uid 8 as a
    // candidate and uid 9 takes the group — the ordering the takeover buys, where the 1.5 union could
    // only delete uid 8 afterwards and leave the group empty.
}

// --- timed effects, recursion, delay: what WA emits, and what core's gates do with it -----------
// The runtime halves (sticky persistence across turns, cooldown suppression, the recursion pass
// dragging uid 13 in) are the eyeball check in ST; node certifies the verdicts they are built from.
{
    const chat = fs.readFileSync(new URL('sentinel-chat.jsonl', here), 'utf8').split('\n').filter(l => l.trim())
        .map(l => JSON.parse(l)).filter(m => typeof m.mes === 'string' && !m.is_system);
    const windowFor = makeWindowFor(chat, { matchWindow: 'paragraph', includeNames: true });
    const opts = { messageDepth: 20, fallbackDepth: 2, caseSensitiveDefault: false, wholeWordsDefault: false };

    const adds = activationAdds(Object.values(data.entries), windowFor, opts).map(e => e.uid);
    eq(adds.includes(10), true, 'sticky entry: key in window, union adds it (persistence is core\'s)');
    eq(adds.includes(11), true, 'cooldown entry: union adds; core gates cooldown BEFORE external activations, so a force cannot break it');
    eq(adds.includes(12), true, 'recursion source fires from chat');
    eq(adds.includes(13), false, 'recursion target has no chat evidence — only the recursion pass admits it');
    // BLIND: WA emits a delayUntilRecursion entry whose keys match and leaves the timing to core, which
    // checks both delay gates before the external-activation branch. With core's matcher blanked,
    // declining to emit would leave no route in at all. Whether core ever admits it is core's own
    // question and this book is the case where it does not — one delay level, recursion off, so no
    // RECURSION pass is scheduled (see the entry's own comment).
    eq(adds.includes(14), true, 'delayUntilRecursion IS emitted; core decides when, or whether, to admit it');

    // Sticky persistence is core's and WA cannot see it offline: at messageDepth 2 "cold frame"
    // (message 2 of 11) has scrolled out of the window, so WA does not re-emit uid 10 on such a turn
    // and the timed effect is the only reason it is still in the prompt.
    const narrow = { ...opts, messageDepth: 2 };
    eq(activationAdds([data.entries['10']], windowFor, narrow).length, 0,
        'sticky entry with its key out of the window is not re-emitted — core\'s timed effect is what carries it');

    // uid 15's GATE. Its three secondaries are one of each kind, and the entry activating is what
    // certifies that the unusable one was DROPPED rather than evaluated: under AND_ALL a
    // never-matching secondary can never be satisfied, so a regression there kills the entry silently
    // — which is the exact failure this whole rule exists to stop.
    eq(adds.includes(15), true, 'AND_ALL gate passes: the usable secondaries hold and the malformed one is dropped');

    const gated = (text) => keywordScore(data.entries['15'], [text], undefined,
        { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).score > 0;
    eq(gated('Morning rounds, then.'), true, 'both surviving secondaries satisfied');
    eq(gated('Morning rounds, then. zzunattested.'), false,
        'the NEGATION-ONLY secondary is live, not dropped — the term present closes the gate');
    eq(gated('Evening rounds, then.'), false, 'the positive secondary is still required');
}

// The audit reports the dropped secondary, and reports ONLY it: `negation-only` is fatal for a primary
// and legitimate here, so a report that named it would be reading the primary's rule. This is the
// Studio's sole surface for a secondary — its chips are painted per key from exactly this list.
{
    const s = _pruneScan(data, OPTS, new Set());
    eq(s.unusableKeysOf(data.entries['15']).map(r => `${r.key}:${r.code}`).join(','), '? "moon:stray-quote',
        'the malformed secondary is reported with the validator\'s code; the negation-only one is not');
    eq(s.unusableKeysOf(data.entries['0']).length, 0, 'an entry with no secondaries reports nothing');
}
