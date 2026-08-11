// Verifies the stage-2 activation verdicts (matcher.mjs activationAdds / activationPrunes) — the
// union and prune halves of matcher-design.md bucket 1.5. Guards the candidacy rules the runtime
// and the tools must share: which keys may carry an activation, which entries are never judged,
// and that the verdict is keywordScore's over the entry's resolved-depth window.
import { activationAdds, activationPrunes, makeWindowFor, scanSegments } from '../extension/matcher.mjs';
import { eq } from './metrics.mjs';

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
        'SmartKeys-only entry activates — the defect bucket 1.5 exists to fix');
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
    eq(addedUids([{ uid: 8, key: ['cosmonaut'], vectorized: true, content: 'x' }], 'cosmonaut',
        { suppressVectorKeys: true }), '',
    'suppressVectorKeys makes vectorized entries retrieval-only (flag is the guard — keys are still live at intercept)');
    eq(addedUids([{ uid: 9, key: ['cosmonaut'], vectorized: true, content: 'x' }], 'cosmonaut',
        { suppressVectorKeys: false }), '9',
    'suppress off: vectorized entries are ordinary keyword candidates');
    eq(addedUids([{ uid: 10, key: ['cosmonaut'], content: '@@dont_activate\nx' }], 'cosmonaut'), '',
        '@@dont_activate is core\'s exclusion; the union must not override it');
    eq(addedUids([{ uid: 11, key: ['cosmonaut'], delayUntilRecursion: 1, content: 'x' }], 'cosmonaut'), '',
        'delayUntilRecursion entries never activate on the initial pass — the only pass the union feeds');
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
    console.log('ok   activationAdds: depth resolves as stage 3 rules it, 0 included');
}

// scanDepth 0 end to end, through the real window assembly (makeWindowFor): no chat window,
// but injects and opted-in sources can still carry the match — mirroring core's buffer.
{
    const chat = [{ name: 'A', mes: 'the cosmonaut waited' }];
    eq(scanSegments(chat, { depth: 0 }).join('|'), '', 'scanSegments at depth 0 yields no chat text');
    eq(scanSegments(chat, { depth: 1 }).join('|'), 'A: the cosmonaut waited', 'depth 1 unchanged');

    const zero = { uid: 1, key: ['cosmonaut'], scanDepth: 0, content: 'x' };
    eq(activationAdds([zero], makeWindowFor(chat, { matchWindow: 'message' }), { ...OPTS }).length, 0,
        'scanDepth-0 entry cannot activate from chat');
    eq(activationAdds([zero], makeWindowFor(chat, { matchWindow: 'message', injectText: 'cosmonaut log' }),
        { ...OPTS }).length, 1,
    'scanDepth-0 entry still activates from the inject text');

    const flagged = { uid: 2, key: ['stardust'], scanDepth: 0, matchScenario: true, content: 'x' };
    const sources = { scenario: 'stardust over the pale city' };
    eq(activationAdds([flagged], makeWindowFor(chat, { matchWindow: 'message', sources }), { ...OPTS }).length, 1,
        'an opted-in match source carries the activation');
    eq(activationAdds([{ ...flagged, matchScenario: false }],
        makeWindowFor(chat, { matchWindow: 'message', sources }), { ...OPTS }).length, 0,
    'sources are per-entry opt-in — no flag, no source text');
    console.log('ok   scanDepth 0 + makeWindowFor: scan-nothing honoured, injects and sources still matchable');
}

// The window's segmentation is the matcher's: a key split across segments is not a match,
// and the entry's own secondary gate applies per segment.
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

// Prune: reject-verdicts over the shared window, minus ownership and structural exemptions.
{
    const item = (uid, entry) => ({ key: `book.${uid}`, entry: { uid, content: 'x', ...entry } });
    const prunes = (items, exempt, text, o = {}) =>
        activationPrunes(items, new Set(exempt), win(text), { ...OPTS, ...o }).join(',');

    eq(prunes([item(1, { key: ['cosmonaut'] })], [], 'the cosmonaut waited'), '',
        'a matching entry is kept');
    eq(prunes([item(1, { key: ['cosmonaut'] })], [], 'nothing relevant'), 'book.1',
        'a no-match keyword activation is pruned');
    eq(prunes([item(1, { key: ['cosmonaut'] })], ['book.1'], 'nothing relevant'), '',
        'exempt keys are never pruned (WA-forced, sticky, external — the caller\'s knowledge)');
    eq(prunes([item(1, { key: ['cosmonaut'], constant: true })], [], 'nothing relevant'), '',
        'constant entries are structurally exempt');
    eq(prunes([item(1, { key: ['cosmonaut'], content: '@@activate\nx' })], [], 'nothing relevant'), '',
        '@@activate entries were admitted without a key match — not WA\'s to revoke');
    eq(prunes([item(1, { key: [], waKeys: ['cosmonaut'] })], [], 'nothing relevant'), '',
        'blanked suppressed-vectorized entries are keys-ineligible — never judged by waKeys');
    eq(prunes([item(1, { key: ['? !apollo'] })], [], 'quiet evening'), '',
        'an entry keyed only on error keys was never key-activated in WA\'s terms — kept');
    eq(prunes([item(1, { key: ['red rain'] })], [], ['the red', 'rain fell']), 'book.1',
        'prune judges over the same segmentation the scorer uses');
    console.log('ok   activationPrunes: reject-verdicts pruned, exemptions and ineligibles kept');
}
