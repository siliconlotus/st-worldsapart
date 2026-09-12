// The sentinel fixture: a book and chat whose every audit verdict is written down, driven through the inputs the Studio uses.
// Also importable into ST (install-sentinel.mjs), for the half node cannot see: chips, tooltips, colours.
import fs from 'node:fs';
import { buildKeyPruneScan } from '../extension/keyword-audit.mjs';
import { ORTHO_FAMILIES } from '../extension/smartkeys.mjs';
import { keywordScore, scanSegments, countKey, countChatHits, activationAdds, makeWindowFor, withExtraTexts } from '../extension/matcher.mjs';
import { buildKeyPruneScan as _pruneScan } from '../extension/keyword-audit.mjs';
import { eq } from './metrics.mjs';

const here = new URL('./fixtures/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('sentinel-book.json', here), 'utf8'));
const msgs = fs.readFileSync(new URL('sentinel-chat.jsonl', here), 'utf8').split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l)).filter(m => typeof m.mes === 'string' && !m.is_system).map(m => m.mes);

const OPTS = {
    scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true,
    ignoreProper: false, minLength: 4, bookShared: 0.75,
};
const RED = 'severe';
const entries = Object.values(data.entries);
const keys = [...new Set(entries.flatMap(e => e.key.map(k => String(k).trim())))];

/** The chat scan through the function the Studio's client path calls. */
const chatRate = () => countChatHits(keys, msgs);

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
    eq(v.zzunattested?.why, 'unattested (book)', 'dead, and says only that the book was checked');
    eq(v.glimmerwort?.why, 'unattested (book)', 'chat-only key reads dead when no chat was searched');
    eq(v.mother?.flag, 'english common', 'the English list flags a generic word with no chat needed');
    eq(v.mother?.sev !== RED, true, '...but unevidenced it is not severe');
    eq(v['lamp-post']?.why, 'matches only as a hyphen/space variant', 'the key fires, but never on the form the author typed');
    eq(v['lamp-post']?.sev, 'minor', '...which is advisory: the flag says rewrite or drop, not that it is broken');
    eq(v["/Cap'n \\w+/"]?.why, `a regex does not fold ' \u2014 try ['${ORTHO_FAMILIES.find(f => f.ascii === "'").pair}]`,
        'a regex key is told its quote matches only itself, in the fold\'s own family');
}

// --- with the chat ----------------------------------------------------------------------------
{
    const v = verdicts(chatRate());
    eq(v.glimmerwort, undefined, 'a key the chat uses is not dead — the flag is dropped');
    eq(v.zzunattested?.why, 'unattested (book/chat)', 'still dead, and now says both were checked');
    eq(v.morning?.sev, RED, 'a common word the chat confirms fires broadly is severe');
    eq(v.mother?.sev !== RED, true, 'a common word the chat says is quiet stays a warning');
    eq(v['? thornwick brambleshaw'], undefined, 'at scan the query is attested by its own entry text');
    eq(verdicts(chatRate(), 'paragraph')['? thornwick brambleshaw'], undefined,
        'and at paragraph, where its own text cannot attest it, the chat does — the scan evaluates `?` keys too');
}

// --- the match window reaches the audit -------------------------------------------------------
{
    const scan = verdicts(undefined, 'scan'), msg = verdicts(undefined, 'message'), para = verdicts(undefined, 'paragraph');
    eq(scan['? thornwick brambleshaw'], undefined, 'at scan the query is attested across the entry');
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

// --- the terrace group (uids 7-9): the group filter picking uid 9 is the eyeball check in ST; node certifies its inputs
{
    const chat = fs.readFileSync(new URL('sentinel-chat.jsonl', here), 'utf8').split('\n').filter(l => l.trim())
        .map(l => JSON.parse(l)).filter(m => typeof m.mes === 'string' && !m.is_system);
    const windowFor = makeWindowFor(chat, { matchWindow: 'paragraph', includeNames: true });
    const opts = { messageDepth: 20, fallbackDepth: 2, caseSensitiveDefault: false, wholeWordsDefault: false };

    // core's \W reads é as a boundary (upstream-st.md #1); WA does not.
    eq(countKey('caf', 'the café by the bistro', false, true), 0, 'whole-word caf does not match café under WA');
    eq(countKey('caf', 'the café by the bistro', false, false), 1, 'substring caf would — the flag is the divergence');

    const adds = activationAdds(Object.values(data.entries), windowFor, opts).map(e => e.uid);
    eq(adds.includes(7), true, 'the SmartKeys-only entry is union-activated — only WA can do this');
    eq(adds.includes(9), true, 'the clean loser matches and is union-activated');
    eq(adds.includes(8), false, 'the false winner does not match under WA — never added');

}

// --- timed effects, recursion, delay (uids 10-15): the runtime halves are the eyeball check in ST
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
    eq(adds.includes(14), true, 'delayUntilRecursion IS emitted; core decides when, or whether, to admit it');

    // At messageDepth 2 "cold frame" (message 2 of 11) has scrolled out of the window.
    const narrow = { ...opts, messageDepth: 2 };
    eq(activationAdds([data.entries['10']], windowFor, narrow).length, 0,
        'sticky entry with its key out of the window is not re-emitted — core\'s timed effect is what carries it');

    // Stage 3 over the recursion buffer: the target's key is in no message, only in uid 12's content.
    const keys13 = (win) => keywordScore(data.entries['13'], win(20, data.entries['13']), undefined,
        { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).score;
    eq(keys13(windowFor), 0, 'recursion target scores keys 0 against chat alone — the budget drops it first');
    const buffered = withExtraTexts(windowFor, [data.entries['12'].content], 'paragraph');
    eq(keys13(buffered) > 0, true, 'the recursion buffer carries the key, so stage 3 can score it');

    // Depth resolution: each pass adds only what the previous pass admitted, so uid 16 is out of reach at pass 1.
    const keysOf = (uid, win) => keywordScore(data.entries[uid], win(20, data.entries[uid]), undefined,
        { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).score;
    const pass1 = withExtraTexts(windowFor, [data.entries['12'].content], 'paragraph');
    const pass2 = withExtraTexts(windowFor, [data.entries['12'].content, data.entries['13'].content], 'paragraph');
    eq(keysOf('16', windowFor), 0, 'depth-2 target scores 0 against chat alone');
    eq(keysOf('16', pass1), 0, 'and 0 at pass 1 — uid 13 has not been admitted yet, so its content is not in the buffer');
    eq(keysOf('16', pass2) > 0, true, 'it becomes scorable only at pass 2, which is what makes its depth 2');

    // excludeRecursion: the premise the hand-applied stage-3 exclusion rests on. The exclusion itself is in
    // worldsapart.js and unreachable from node — it is the install-sentinel eyeball.
    eq(keysOf('17', windowFor), 0, 'non-recursable entry has no chat evidence');
    eq(keysOf('17', pass1) > 0, true, 'the buffer DOES carry its key — so stage 3 must exclude it by hand, or credit it');

    // preventRecursion: uid 16's content is the only place uid 18's key appears, and it never enters the buffer.
    eq(/sedgewhistle/i.test(data.entries['16'].content), true, 'uid 18\'s key lives in uid 16\'s content');
    eq(msgs.some(m => /sedgewhistle/i.test(m)), false, 'and in no chat message, so uid 16 is its only possible route');
    eq(keysOf('18', pass2), 0, 'uid 18 stays unscorable: preventRecursion keeps uid 16 out of every later buffer');

    // uid 15's three secondaries are one of each kind: usable, negation-only, malformed.
    eq(adds.includes(15), true, 'AND_ALL gate passes: the usable secondaries hold and the malformed one is dropped');

    const gated = (text) => keywordScore(data.entries['15'], [text], undefined,
        { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false }).score > 0;
    eq(gated('Morning rounds, then.'), true, 'both surviving secondaries satisfied');
    eq(gated('Morning rounds, then. zzunattested.'), false,
        'the NEGATION-ONLY secondary is live, not dropped — the term present closes the gate');
    eq(gated('Evening rounds, then.'), false, 'the positive secondary is still required');
}

// --- unusableKeysOf: the Studio's only surface for a secondary
{
    const s = _pruneScan(data, OPTS, new Set());
    eq(s.unusableKeysOf(data.entries['15']).map(r => `${r.key}:${r.code}`).join(','), '? "moon:stray-quote',
        'the malformed secondary is reported with the validator\'s code; the negation-only one is not');
    eq(s.unusableKeysOf(data.entries['0']).length, 0, 'an entry with no secondaries reports nothing');
}
