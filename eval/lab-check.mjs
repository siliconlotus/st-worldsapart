// lab-check.mjs — the Keyword Lab's model: an entry's gate and flags, a book applied to a text, and the one result shape
// both modes return. Self-checking; run with no arguments.

import { entryFlags, entryGate, labScan, runBook, runSpans } from '../extension/lab.mjs';
import { WI_LOGIC } from '../extension/matcher.mjs';

let failed = 0;
const eq = (got, want, what) => {
    if (got === want) { console.log(`ok   ${what}: ${got}`); return; }
    failed++; process.exitCode = 1;
    console.log(`FAIL ${what}: ${got} (want ${want})`);
};

const text = 'His breath is fast.\n\nHe looks slowly.\n\nHis breath hitches before slowly leveling out.';
const para = { matchWindow: 'paragraph' };

// --- an entry's gate and flags are core's reading of it, and nothing else's
eq(entryGate({ key: ['a'] }), undefined, 'no secondaries, no gate');
eq(entryGate({ keysecondary: ['b'] }), undefined, 'secondaries without `selective` do not gate — core reads the flag');
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
eq(run.entries.map(h => h.entry.uid).join(), '1,2,3', 'the entries that fired, in the order given');
eq(run.entries[1].rows[0].count, 1, 'a gated entry fires only where its secondary is in the same window');
eq(run.books.join(), 'B,C', 'the books scanned, deduped in encounter order');
eq(run.keyList.join(), 'breath,slow', 'the run\'s distinct keys — one key two entries found is one term to colour');
eq(runBook(entries, 'a quiet room', para).entries.length, 0, 'a text no key matches yields no entries...');
eq(runBook(entries, 'a quiet room', para).scanned, 4, '...and still reports what was scanned');

// --- runSpans: one fold over the union, not one per entry
const spans = runSpans(run, text, para);
eq(spans.map(sp => text.slice(sp.start, sp.end)).join(' '), 'breath slow breath slow',
    'every entry\'s hits, in source order — including the window its gate refused, which is where the branch still fired');
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

console.log(failed ? `FAILED ${failed}` : 'ok   lab: gate, flags, a book applied, and one result shape for both modes');
