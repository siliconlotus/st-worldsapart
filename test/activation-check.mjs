// Stage-2 activation verdicts (matcher.mjs activationAdds): candidacy, depth resolution, scanDepth 0, segmentation, the recursion rematch window.
import { activationAdds, makeWindowFor, scanSegments, withExtraTexts } from '../extension/matcher.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const OPTS = { messageDepth: 4, fallbackDepth: 2, caseSensitiveDefault: false, wholeWordsDefault: false };
const win = text => () => (Array.isArray(text) ? text : [text]);
const addedUids = (entries, text, o = {}) =>
    activationAdds(entries, win(text), { ...OPTS, ...o }).map(e => e.uid).join(',');

// Union candidacy: who may be force-activated, and on which keys.
{
    const plain = { uid: 1, key: ['cosmonaut'], content: 'x' };
    eq(addedUids([plain], 'the cosmonaut waited'), '1', 'plain key match is added');
    eq(addedUids([plain], 'nothing relevant'), '', 'no match, no add');

    const smart = { uid: 2, key: ['? apollo & cosmonaut'], content: 'x' };
    eq(addedUids([smart], 'the cosmonaut boarded apollo'), '2',
        'SmartKeys-only entry activates — core reads `? …` as a literal needle and never matches it');
    eq(addedUids([smart], 'the cosmonaut waited'), '', 'conjunction unmet, no add');

    eq(addedUids([{ uid: 3, key: ['? !apollo'], content: 'x' }], 'quiet evening'), '',
        'negation-only key cannot carry an activation (validator error)');
    eq(addedUids([{ uid: 4, key: ['?'], content: 'x' }], 'quiet evening'), '',
        'no-terms key cannot carry an activation');
    eq(addedUids([{ uid: 5, key: ['? !apollo', 'cosmonaut'], content: 'x' }], 'the cosmonaut waited'), '5',
        'error keys are filtered, not disqualifying — the valid key still activates');

    eq(addedUids([{ uid: 6, key: ['cosmonaut'], disable: true, content: 'x' }], 'cosmonaut'), '',
        'disabled entries are never candidates');
    eq(addedUids([{ uid: 7, key: ['cosmonaut'], constant: true, content: 'x' }], 'cosmonaut'), '',
        'constant entries are core\'s to activate — forcing again is noise');
    eq(addedUids([{ uid: 8, key: ['cosmonaut'], vectorized: true, content: 'x' }], 'cosmonaut'), '8',
    'vectorized entries are ordinary keyword candidates — stage 1 admits them anyway, so the skip protected nothing');
    eq(addedUids([{ uid: 10, key: ['cosmonaut'], content: '@@dont_activate\nx' }], 'cosmonaut'), '',
        '@@dont_activate is core\'s exclusion; the union must not override it');
    eq(addedUids([{ uid: 11, key: ['cosmonaut'], delayUntilRecursion: 1, content: 'x' }], 'cosmonaut'), '11',
        'delayed entries ARE emitted — core\'s gate order and the persistent external map admit them at their level, and with core\'s matcher blanked there is no other route in');
    eq(addedUids([{ uid: 14, key: ['cosmonaut'], decorators: ['@@dont_activate'], content: 'x' }], 'cosmonaut'), '',
        'parsed entries (getSortedEntries) carry decorators in the array with content stripped — the array is authoritative');
    eq(addedUids([{ uid: 15, key: ['cosmonaut'], decorators: ['@@activate'], content: 'x' }], 'cosmonaut'), '',
        '@@activate entries are core\'s to activate, as constants are: WA leaves their keys unblanked and core\'s ladder takes them');
    eq(addedUids([{ uid: 16, key: ['cosmonaut'], decorators: ['@@dont_activate', '@@activate'], content: 'x' }], 'cosmonaut'), '',
        '...both decorators too: CCv3 gives @@activate precedence, and core reaches it first, so WA must not suppress it here');
    console.log('ok   activationAdds: candidacy — SmartKeys admitted, error keys and excluded entries not');
}

// Depth resolution: per-entry scanDepth, then messageDepth, then the injected fallback.
{
    const seen = [];
    const recorder = depth => { seen.push(depth); return ['cosmonaut']; };
    activationAdds([
        { uid: 1, key: ['cosmonaut'], scanDepth: 7, content: 'x' },
        { uid: 2, key: ['cosmonaut'], content: 'x' },
    ], recorder, { ...OPTS });
    eq(seen.join(','), '7,4', 'scanDepth beats messageDepth; messageDepth is the shared default');
    seen.length = 0;
    activationAdds([{ uid: 3, key: ['cosmonaut'], content: 'x' }], recorder,
        { ...OPTS, messageDepth: 0 });
    eq(seen.join(','), '2', 'unset messageDepth falls back to the injected core depth');
    seen.length = 0;
    activationAdds([{ uid: 4, key: ['cosmonaut'], scanDepth: 0, content: 'x' }], recorder, { ...OPTS });
    eq(seen.join(','), '0', 'scanDepth 0 is authored (core: match nothing from chat), not unset');
    seen.length = 0;
    activationAdds([
        { uid: 5, key: ['cosmonaut'], content: 'x' },
        { uid: 6, key: ['cosmonaut'], scanDepth: 7, content: 'x' },
    ], recorder, { ...OPTS, depthSkew: 2 });
    eq(seen.join(','), '6,7', 'depthSkew (min-activations) widens the default window only — authored scanDepth never skews');
    console.log('ok   activationAdds: depth resolves as stage 3 rules it, 0 included');
}

// scanDepth 0 through makeWindowFor: no chat window, but injects and opted-in sources still carry the match.
{
    const chat = [{ name: 'A', mes: 'the cosmonaut waited' }];
    eq(scanSegments(chat, { depth: 0 }).join('|'), '', 'scanSegments at depth 0 yields no chat text');
    eq(scanSegments(chat, { depth: 1 }).join('|'), 'A: the cosmonaut waited', 'depth 1 unchanged');

    const zero = { uid: 1, key: ['cosmonaut'], scanDepth: 0, content: 'x' };
    eq(activationAdds([zero], makeWindowFor(chat, { matchWindow: 'message' }), { ...OPTS }).length, 0,
        'scanDepth-0 entry cannot activate from chat');
    eq(activationAdds([zero], makeWindowFor(chat, { matchWindow: 'message', injects: [{ text: 'cosmonaut log', ambient: true }] }),
        { ...OPTS }).length, 1,
    'scanDepth-0 entry still activates from an ambient inject');
    eq(activationAdds([zero], makeWindowFor(chat, { matchWindow: 'message', injects: [{ text: 'cosmonaut log', ambient: false, depth: 4 }] }),
        { ...OPTS }).length, 0,
    'scanDepth-0 entry does NOT activate from an inject placed in the chat');

    const flagged = { uid: 2, key: ['stardust'], scanDepth: 0, matchScenario: true, content: 'x' };
    const sources = { scenario: 'stardust over the pale city' };
    eq(activationAdds([flagged], makeWindowFor(chat, { matchWindow: 'message', sources }), { ...OPTS }).length, 1,
        'an opted-in match source carries the activation');
    eq(activationAdds([{ ...flagged, matchScenario: false }],
        makeWindowFor(chat, { matchWindow: 'message', sources }), { ...OPTS }).length, 0,
    'sources are per-entry opt-in — no flag, no source text');
    console.log('ok   scanDepth 0 + makeWindowFor: scan-nothing honoured, injects and sources still matchable');
}

// The window's segmentation is the matcher's, and the secondary gate applies per segment.
{
    const e = { uid: 1, key: ['red rain'], content: 'x' };
    eq(addedUids([e], ['the red', 'rain fell']), '', 'key split across segments does not match');
    eq(addedUids([e], ['the red rain fell']), '1', 'same text, one segment: matches');

    const gated = { uid: 2, key: ['cosmonaut'], keysecondary: ['apollo'], selectiveLogic: 2, content: 'x' };
    eq(addedUids([gated], ['the cosmonaut boarded apollo']), '',
        'NOT_ANY secondary present in the matching segment gates the activation');
    eq(addedUids([gated], ['the cosmonaut waited']), '2', 'secondary absent: NOT_ANY passes');
    console.log('ok   activationAdds: verdict is keywordScore\'s — segmentation and secondary gating included');
}

// withExtraTexts: chat segments plus each recursion pass's new content, re-segmented under the match window.
{
    const chat = [{ name: 'A', mes: 'the cosmonaut waited' }];
    const compose = (texts, matchWindow) =>
        withExtraTexts(makeWindowFor(chat, { matchWindow }), texts, matchWindow);

    eq(activationAdds([{ uid: 1, key: ['moonbase'], content: 'x' }],
        compose(['the moonbase hummed'], 'message'), OPTS).map(e => e.uid).join(','), '1',
    'recursion text carries an activation');

    const conj = { uid: 2, key: ['? cosmonaut moonbase'], content: 'x' };
    eq(activationAdds([conj], compose(['the moonbase hummed'], 'message'), OPTS).length, 0,
        'a conjunction may not span the chat/recursion seam under a segmented window');
    eq(activationAdds([conj], compose(['the moonbase hummed'], 'scan'), OPTS).map(e => e.uid).join(','), '2',
        'at scan the buffer is one segment — core\'s own cross-pass semantics');
    console.log('ok   withExtraTexts: recursion content matchable, seam scoped by the match window');
}
