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
import { keywordScore, scanSegments, countKey, isRegexKey } from '../extension/ranking.mjs';
import { buildAutomaton, addMessageHits, fold } from '../extension/smartkeys.mjs';
import { eq } from './metrics.mjs';

const here = new URL('./fixtures/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('sentinel-book.json', here), 'utf8'));
const msgs = fs.readFileSync(new URL('sentinel-chat.jsonl', here), 'utf8').split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l)).filter(m => typeof m.mes === 'string' && !m.is_system).map(m => m.mes);

const OPTS = {
    scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true,
    ignoreProper: false, stickySkipCommon: true, tooCommon: 0.5, minLength: 4, sharedKeys: 0.75,
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
    // Literals only, exactly as scanChats does: a `?` query cannot be found by an automaton built from
    // folded literals, so it is left OUT of the map rather than recorded as 0 — absent means unchecked.
    return { hits: new Map(literals.map(k => [k, counts.get(idxOf.get(fold(k))) ?? 0])), messages: msgs.length };
};

const verdicts = (chat, matchWindow = 'scan') => {
    const s = buildKeyPruneScan(data, OPTS, new Set(), { chatRate: chat, matchWindow });
    const out = {};
    for (const e of entries) for (const p of s.classifyEntry(e)) out[p.key] = { flag: p.flag, why: s.reasonOf(p).text, sev: s.severityOf(p) };
    return out;
};

eq(msgs.length, 10, 'the hidden message is dropped, as core and WA both drop it');

// --- no chat evidence -------------------------------------------------------------------------
{
    const v = verdicts(undefined);
    eq(v.quarkspindle, undefined, 'a key in its own entry text is not flagged');
    eq(v.zzunattested?.why, 'not in entry text', 'dead, and says only that entry text was checked');
    eq(v.glimmerwort?.why, 'not in entry text', 'chat-only key reads dead when no chat was searched');
    eq(v.mother?.flag, 'too common', 'the English list flags a generic word with no chat needed');
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
