// lab-check.mjs — lab.mjs: entryGate, entryFlags, runBook, runSpans, labScan. Self-checking; run with no arguments.

import { entryFlags, entryGate, labMessages, labScan, runBook, runSpans, windowTip } from '../extension/lab.mjs';
import { WI_LOGIC } from '../extension/matcher.mjs';
import { setMacros } from '../extension/smartkeys.mjs';
import { eq } from '../eval/lib/metrics.mjs';


const text = 'His breath is fast.\n\nHe looks slowly.\n\nHis breath hitches before slowly leveling out.';
const para = { matchWindow: 'paragraph' };

// --- an entry's gate and flags are core's reading of it, and nothing else's
eq(entryGate({ key: ['a'] }), undefined, 'no secondaries, no gate');
eq(JSON.stringify(entryGate({ keysecondary: ['b'] })), '{"keys":["b"],"logic":0}',
    'secondaries with NO `selective` gate, as secondaryKeys reads it: only `selective === false` ignores the list');
eq(entryGate({ selective: false, keysecondary: ['b'] }), undefined, '...and `selective === false` is what drops it');
eq(JSON.stringify(entryGate({ selective: true, keysecondary: ['b', ' '], selectiveLogic: 2 })),
    '{"keys":["b"],"logic":2}', 'a blank secondary is dropped before the logic, as core drops it');
eq(JSON.stringify(entryGate({ selective: true, keysecondary: ['b'] })), '{"keys":["b"],"logic":0}',
    'no logic is AND_ANY, core\'s default');
eq(JSON.stringify(entryFlags({ caseSensitive: true }, { caseSensitive: false, wholeWords: true })),
    '{"caseSensitive":true,"wholeWords":true}', 'the entry overrides, the caller\'s defaults fill in');
eq(JSON.stringify(entryFlags({}, {})), '{"caseSensitive":false,"wholeWords":false}', 'and nothing either way is off');

// --- runBook: what a text activates on keys alone
const entries = [
    { uid: 1, world: 'B', key: ['breath'] },
    { uid: 2, world: 'B', key: ['slow'], selective: true, keysecondary: ['breath'], selectiveLogic: WI_LOGIC.AND_ANY },
    { uid: 3, world: 'C', key: ['breath'] },
    { uid: 4, world: 'B', key: ['nothing'] },
    { uid: 5, world: 'B', key: ['breath'], disable: true },
    { uid: 6, world: 'B', key: [] },
];
const run = runBook(entries, text, para);
eq(run.scanned, 4, 'a disabled entry and an unkeyed one are not scanned');
eq(run.entries.map(h => h.entry.uid).join(), '1,2,3', 'the entries that matched, in the order given');
eq(run.entries[1].rows[0].count, 1, 'a gated entry matches only where its secondary is in the same window');
eq(run.books.join(), 'B,C', 'the books scanned, deduped in encounter order');
eq(run.keyList.join(), 'breath,slow', 'the run\'s distinct keys — one key two entries found is one term to colour');
// Core keyword-matches a vectorized entry, so skipVectorized is a filter the caller asks for, not a default.
const withVec = [...entries, { uid: 7, world: 'B', key: ['breath'], vectorized: true }];
eq(runBook(withVec, text, para).scanned, 5, 'a vectorized entry is scanned like any other by default');
eq(runBook(withVec, text, { ...para, skipVectorized: true }).scanned, 4, 'and left out when the reader is tuning keys');
eq(runBook(withVec, text, { ...para, skipVectorized: true }).entries.some(h => h.entry.uid === 7), false,
    'so it cannot appear among the hits either');
eq(runBook(entries, 'a quiet room', para).entries.length, 0, 'a text no key matches yields no entries...');
eq(runBook(entries, 'a quiet room', para).scanned, 4, '...and still reports what was scanned');

// --- a run's override: the Lab's boxes, set over every entry's own flags, so on and off can be compared on one run
{
    const strict = [{ uid: 8, world: 'B', key: ['Breath'], caseSensitive: true }, { uid: 9, world: 'B', key: ['slow'], matchWholeWords: true }];
    eq(runBook(strict, text, para).entries.map(h => h.entry.uid).join(), '', 'as written, the case-sensitive key misses lowercase and the whole-word key misses "slowly"');
    eq(runBook(strict, text, { ...para, override: { caseSensitive: false, wholeWords: false } }).entries.map(h => h.entry.uid).join(), '8,9', 'an override replaces each entry\'s flag for the run');
    eq(runBook(strict, text, { ...para, override: { caseSensitive: false } }).entries.map(h => h.entry.uid).join(), '8', '...and only the flag it names');
    const run = runBook(strict, text, { ...para, override: { wholeWords: false } });
    eq(runSpans(run, text, { ...para, override: { wholeWords: false } }).length > 0, true, 'the spans follow the same override');
    eq(labScan({ hay: text, run, matchWindow: 'paragraph', override: { wholeWords: false } }).spans.length > 0, true, '...through labScan too');
}

// --- runSpans: one fold over the union, not one per entry
const spans = runSpans(run, text, para);
eq(spans.map(sp => text.slice(sp.start, sp.end)).join(' '), 'breath slow breath slow',
    'every entry\'s hits, in source order — including the window its gate refused, which is where the branch still matched');
eq(spans[0].keys.length, 3, 'a word several entries reached is one span naming them all: two keys here, and one gate\'s term');

// --- labScan: the same shape in both modes, so a caller cannot read a field that only one branch has
const typed = labScan({ hay: text, keys: 'breath', sec: 'slow', logic: WI_LOGIC.NOT_ANY, ...para });
const applied = labScan({ hay: text, run, ...para });
eq(Object.keys(typed).sort().join(), 'gate,keys,rows,spans', 'a typed list returns keys, rows, gate and spans');
eq(Object.keys(applied).sort().join(), 'gate,keys,rows,spans', 'and an applied run returns the same four');
eq(typed.keys.join(), 'breath', 'the typed keys are what a typed list colours by');
eq(applied.keys.join(), 'breath,slow', 'the run\'s keyList is what a run colours by');
eq(typed.rows[0].count, 1, 'the typed list carries its rows, under the pane\'s own gate...');
eq(applied.rows.length, 0, '...where a run\'s hang off the run, per entry');
eq(applied.gate, null, 'a run has no gate of its own: every entry brought one');
eq(applied.spans.length, 4, 'and its spans are the union of its entries\'');

console.log(process.exitCode ? 'FAILED  lab' : 'ok   lab: gate, flags, a book applied, and one result shape for both modes');

// --- windowTip: the title-attribute rendering of a window, guillemets around every hit in it
const win = (text, excerpts) => ({ text, excerpts });
const sg1 = win('He looks slowly at the gate.', [{ at: 3, to: 8, negated: false }]);
eq(windowTip(sg1, sg1.excerpts[0]), 'He «looks» slowly at the gate.', 'a positive hit is «guillemeted»');
const sg2 = win('He looks slowly.', [{ at: 3, to: 8, negated: true }]);
eq(windowTip(sg2, sg2.excerpts[0]), 'He »looks« slowly.', 'a negated hit reverses them');
const sg3 = win('a bb ccc', [{ at: 5, to: 8 }, { at: 2, to: 4 }]);
eq(windowTip(sg3, sg3.excerpts[0]), 'a «bb» «ccc»', 'excerpts are marked in text order, whatever order they arrive in');
eq(windowTip(win('  spaced \n\n out  ', []), { at: 0, to: 1 }), 'spaced out', 'whitespace collapses: a title attribute is one line');

// Over 320 characters the window is clipped to 110 either side of the cited excerpt, with ellipses for what was cut.
const pad = 'x'.repeat(200);
const long = `${pad} HIT ${pad}`;
const ex = { at: pad.length + 1, to: pad.length + 4 };
const clipped = windowTip(win(long, [ex]), ex);
eq(clipped.startsWith('…'), true, 'a clip at the head is marked with an ellipsis');
eq(clipped.endsWith('…'), true, 'and so is one at the tail');
eq(clipped.includes('«HIT»'), true, 'the cited excerpt survives the clip');
eq(clipped.length < 260, true, 'the clip is 110 either side, not the whole window');
// An excerpt outside the clip window is left unmarked rather than dropped from the text.
const other = { at: 5, to: 8 };
const two = windowTip(win(long, [other, ex]), ex);
eq(two.includes('«xxx»'), false, 'an excerpt outside the clipped window is not marked');
eq(windowTip(win('short', [{ at: 0, to: 5 }]), { at: 0, to: 5 }), '«short»', 'under 320 characters nothing is clipped');

// --- labMessages: the cut, the is_system drop, dropChatTags, then the segmentation
{
    const m = (mes, o = {}) => ({ name: 'Ann', mes, ...o });
    const chat = [m('one'), m('two', { is_system: true }), m('three'), m('four')];

    const all = labMessages(chat, { depth: 10 });
    eq(all.messages.join('|'), 'one|three|four', 'is_system messages are dropped, as core and WA both drop them');
    eq(all.hidden, 1, 'and `hidden` counts what the drop held back');
    eq(labMessages(chat, { depth: 2 }).messages.join('|'), 'three|four', 'depth takes the last N of what survives');
    eq(labMessages(chat, { depth: 0 }).messages.length, 0,
        'depth 0 is authored: core reads it as "match nothing from chat", not "no limit"');
    eq(labMessages(chat, { depth: 10, includeNames: true }).messages[0], 'Ann: one', 'includeNames prefixes the speaker');

    // `end` is a MESSAGE ID, so it cuts the RAW list with the hidden messages still counted.
    eq(labMessages(chat, { depth: 10, end: 2 }).messages.join('|'), 'one|three',
        'the cut is on the raw list: message id 2 is the third entry, hidden ones counted');
    eq(labMessages(chat, { depth: 10, end: 2 }).hidden, 1, 'and the drop inside the cut is reported');
    eq(labMessages(chat, { depth: 10, end: 0 }).messages.join('|'), 'one', 'ending at id 0 keeps the first message');
    eq(labMessages(chat, { depth: 10, end: -1 }).messages.length, 3, 'end -1 is no cut');

    // dropChatTags removes the named element WITH its contents, as the runtime does at intake.
    const tagged = [m('keep <tracker>hidden state</tracker> tail')];
    eq(labMessages(tagged, { depth: 10, dropSpec: 'tracker' }).messages[0], 'keep  tail',
        'a dropped tag takes its contents with it');
    eq(labMessages(tagged, { depth: 10, dropSpec: '  ' }).messages[0], 'keep <tracker>hidden state</tracker> tail',
        'a blank spec drops nothing');
    eq(labMessages([], { depth: 10 }).messages.length, 0, 'an empty chat is empty');
    eq(labMessages(undefined, { depth: 10 }).hidden, 0, 'a missing chat is empty, not a throw');
}

// --- parts: several chats as one text, each matched under its own macro map, the results merged and offset into the whole
{
    setMacros({});
    const a = 'Alice waved.', b = 'Bob waved.';
    const hay = `${a}\n\n${b}`;
    const parts = [{ text: a, at: 0, macros: { '{{char}}': 'Alice' } }, { text: b, at: a.length + 2, macros: { '{{char}}': 'Bob' } }];
    const r = labScan({ hay, keys: '{{char}}', matchWindow: 'paragraph', parts });
    eq(r.rows.length, 1, 'one row per key over all the parts');
    eq(r.rows[0].count, 2, 'each part matches under its own map');
    eq(r.rows[0].segments.map(sg => sg.at).join(), `0,${a.length + 2}`, 'segments carry their offset into the joined text');
    eq(r.spans.map(sp => hay.slice(sp.start, sp.end)).join('|'), 'Alice|Bob', 'spans land on the joined text');
    const entries = [{ uid: 1, world: 'B', key: ['{{char}}'] }, { uid: 2, world: 'B', key: ['nothing'] }];
    const run = runBook(entries, hay, { matchWindow: 'paragraph', parts });
    eq(run.entries.map(h => h.entry.uid).join(), '1', 'a run merges per part too');
    eq(run.entries[0].rows[0].count, 2, '...summing a key\'s count across the parts');
    eq(run.scanned, 2, '...and counts each entry once');
    eq(runSpans(run, hay, { matchWindow: 'paragraph', parts }).length, 2, 'a run\'s spans follow the parts');
    eq(labScan({ hay, keys: '{{char}}', matchWindow: 'paragraph' }).rows[0]?.count ?? 0, 0, 'without parts the map in force is used, and a parts scan left it as it was: nothing');
}
