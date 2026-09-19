// The sentinel fixture: a book and chat whose every audit verdict is written down, driven through the inputs the Studio uses.
// Also importable into ST (install-sentinel.mjs), for the half node cannot see: chips, tooltips, colours.
import fs from 'node:fs';
import { buildKeyPruneScan, substringProbes, orthoAlternates } from '../extension/keyword-audit.mjs';
import { ORTHO_FAMILIES } from '../extension/smartkeys.mjs';
import { keywordScore, scanSegments, countKey, countChatHits, activationAdds, makeWindowFor, withExtraTexts } from '../extension/matcher.mjs';
import { buildKeyPruneScan as _pruneScan } from '../extension/keyword-audit.mjs';
import { eq } from '../eval/lib/metrics.mjs';

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
// Secondaries are scanned too, as the Studio's bookKeys sends them: a gate's attestation is read off the same counts.
const secondaries = [...new Set(entries.flatMap(e => e.keysecondary ?? []))];

/** The chat scan through the function the Studio's client path calls. */
// The substring probes ride along as the Studio's second pass would send them: a 23-key fixture needs no gate.
const chatRate = () => countChatHits([...keys, ...secondaries, ...keys.flatMap(substringProbes)], msgs);

const verdicts = (chat, matchWindow = 'scan') => {
    const s = buildKeyPruneScan(data, OPTS, new Set(), { chatScan: chat, matchWindow });
    const out = {};
    for (const e of entries) for (const p of s.classifyEntry(e)) out[p.key] = { flag: p.flag, why: s.reasonOf(p).label, message: s.reasonOf(p).message, sev: s.severityOf(p) };
    return out;
};

eq(msgs.length, 11, 'the hidden message is dropped, as core and WA both drop it');

// --- no chat evidence -------------------------------------------------------------------------
{
    const v = verdicts(undefined);
    eq(v.quarkspindle, undefined, 'a key in its own entry text is not flagged');
    eq(v.zzunattested?.why, 'unattested (book)', 'dead, and says only that the book was checked');
    eq(v.glimmerwort?.why, 'unattested (book)', 'chat-only key reads dead when no chat was searched');
    eq(v.mother?.why, 'common word', 'the common list flags a generic word while no chat has been scanned');
    eq(v.CIA?.why, 'short (1/4 exact) — consider ? =CIA', 'a short key mostly inside longer words is offered the whole-word flag, measured over the book');
    eq(v['? =/re/']?.flag, 'warning', 'a validator warn is an audit flag, ahead of the dead verdict it explains');
    eq(v['? =/re/']?.why, 'Literal regex', '...named by the validator\'s label, short enough for a chip');
    eq(v['? =/re/']?.message, 'Flag = makes this a literal; remove it if you want the expression, or use quotes to suppress this warning.', '...with the validator\'s sentence as the tooltip');
    eq(v['? =/re/']?.sev, 'moderate', '...at the amber severity');
    // A key the audit never scanned — edited in since — is judged on demand, not handed "never matches" by default.
    const later = buildKeyPruneScan(data, OPTS, new Set());
    const fresh = key => { const f = later.classifyEntry({ uid: 99, key: [key] })[0]; return f ? later.reasonOf(f).label : ''; };
    eq(fresh('? =quarkspindle'), '', 'an edited-in whole-word term the book holds is judged attested');
    eq(fresh('? =zzunattested'), 'never matches (book)', '...and one it does not hold is dead, by a scan and not by default');
    const flagOf = key => later.classifyEntry({ uid: 99, key: [key] })[0]?.flag;
    eq(flagOf('the Spire') !== 'fragment', true, 'a titular "the" before a capitalised word is a name, not a fragment');
    eq(flagOf('The Isle of Wight') !== 'fragment', true, '...in either case, and over a longer frame');
    eq(flagOf('the door'), 'fragment', '...where "the" before a lowercase word is the phrase fragment it looks like');
    eq(v['isle of wight'], undefined, 'a lowercase locative the book writes capitalised is a name, not a fragment');
    eq(v['piece of cake']?.flag, 'fragment', '...where the same shape nothing capitalises is the phrase fragment it looks like');
    eq(v.mother?.sev !== RED, true, '...but unevidenced it is not severe');
    eq(v['lamp-post']?.why, 'book uses it only un-hyphenated', 'the key matches, but never on the form the author typed');
    eq(v['lamp-post']?.sev, 'minor', '...which is advisory: the flag says rewrite or drop, not that it is broken');
    // Six messages, one hit: under the chat-common share, so the variant verdict is what remains.
    const lamp = countChatHits(['lamp-post'], ['the lamp post flickers at the corner', 'a', 'b', 'c', 'd', 'e']);
    eq(verdicts({ messagesWith: lamp.messagesWith, typedWith: lamp.typedWith, messages: lamp.messages })['lamp-post']?.why,
        'chat uses it only un-hyphenated', '...and the chat is cited over the book, being what the model writes');
    eq(v["/Cap'n \\w+/"]?.why, `will not match curly form, consider ['${ORTHO_FAMILIES.find(f => f.ascii === "'").pair}]`,
        'a regex key is told its quote matches only itself, and is offered the curly pair');
    eq(v['/Bose-Einstein \\w+/']?.why, 'book uses en-dash, consider [-\u2013]',
        'the hyphen flags on evidence, and the evidence outranks the dead verdict it explains');
    // Chat outranks the book as the citation: the alternates are scanned as ordinary keys so the count exists.
    const probes = orthoAlternates('/Bose-Einstein \\w+/').map(a => a.alt);
    const withChat = countChatHits(['/Bose-Einstein \\w+/', ...probes], ['the Bose\u2013Einstein condensate forms']);
    const vc = verdicts({ messagesWith: withChat.messagesWith, messages: withChat.messages });
    eq(vc['/Bose-Einstein \\w+/']?.why, 'chat uses en-dash, consider [-\u2013]', 'and the chat is cited over the book when it has the form');
}

// --- with the chat ----------------------------------------------------------------------------
{
    const v = verdicts(chatRate());
    eq(v.glimmerwort?.flag !== 'unattested', true, 'a key the chat uses is not dead — the dead flag is dropped');
    eq(v.glimmerwort?.why, 'chat common (27%)', '...and at 3 of 11 messages it is over the chat-common share, an advisory');
    eq(v.zzunattested?.why, 'unattested (book/chat)', 'still dead, and now says both were checked');
    eq(v.morning?.why, 'chat common (55%)', 'a common word the chat confirms matches broadly reads as the chat flag, above the English list');
    eq(v.morning?.sev, RED, '...and severe by degree, being in more messages than not');
    eq(v.mother, undefined, 'mother, in 1 of 11 messages, is under the share: the chat has answered, and the common list says nothing');
    eq(v.ver?.why, 'matches in 36% of messages, 0% as a word \u2014 consider ? =ver',
        'a key broad because it lands inside other words is told so, and offered the flag it lacks');
    eq(v.ver?.sev, 'moderate', '...one token fixes it, so not severe');
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
    eq(sub > 0 && whole === 0, true, `"ver" matches ${sub}/${msgs.length} as substring and never as a word`);
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
    eq(adds.includes(12), true, 'recursion source activates from chat');
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

// --- unusableKeysOf: the Studio's only surface for a secondary — refused by the matcher, or live and attested nowhere
{
    const row = r => `${r.key}:${r.flag}${r.code ? `:${r.code}` : ''}`;
    const s = _pruneScan(data, OPTS, new Set());
    eq(s.unusableKeysOf(data.entries['15']).map(row).join(','), 'morning:unattested,? "moon:unusable:stray-quote',
        'without a chat the positive secondary is unattested by the book and the malformed one carries the validator\'s code; the negation-only one is neither');
    const [dead, bad] = s.unusableKeysOf(data.entries['15']);
    eq(s.reasonOf(dead).label, 'unattested (book)', 'the words a primary gets');
    eq(s.severityOf(dead), '', 'and the blank severity a primary gets: a dead key is neutral');
    eq(s.severityOf(bad), RED, 'a refused secondary is severe');
    eq(s.unusableKeysOf({ ...data.entries['15'], selective: false }).length, 0, 'a switched-off gate lists nothing');
    eq(s.unusableKeysOf(data.entries['0']).length, 0, 'an entry with no secondaries reports nothing');

    const c = _pruneScan(data, OPTS, new Set(), { chatScan: chatRate() });
    eq(c.unusableKeysOf(data.entries['15']).map(row).join(','), '? "moon:unusable:stray-quote', 'the chat attests the positive secondary');
    eq(c.unusableKeysOf(data.entries['25']).map(r => `${r.key}:${c.reasonOf(r).label}`).join(','), 'zzghostgate:unattested (book/chat)',
        'a secondary in no entry and no message stays unattested once the chat is scanned, and says the chat was checked');
}
