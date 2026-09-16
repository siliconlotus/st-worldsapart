// corpus-check.mjs — the book roster: the slug a filename derives, and that a missing roster refuses rather than guesses.
import { evalBooks, toBooks, slugOf, ROSTER as DEFAULT_ROSTER, WORLDS } from '../eval/lib/corpus.mjs';
import { eqDeep as eq, throws } from '../eval/lib/metrics.mjs';
import { resolve } from 'node:path';
import { stInstall } from '../eval/lib/st-install.mjs';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


eq(slugOf('Foxbridge.json'), 'foxbridge', 'the extension goes and the case folds');
eq(slugOf('My_Book__v2.json'), 'my_book__v2', 'punctuation and digits are kept: the filename is already unique');
eq(slugOf('no-extension'), 'no-extension', 'a name with no .json is its own slug');

eq(toBooks(['A.json']), { a: { file: 'A.json', provenance: '' } }, 'a bare filename');
eq(toBooks([{ file: 'B.json', provenance: 'curated' }]), { b: { file: 'B.json', provenance: 'curated' } }, 'a record keeps its provenance');
eq(toBooks([' A.json ']), { a: { file: 'A.json', provenance: '' } }, 'a filename is trimmed');
eq(toBooks([{ file: 'Long_Name__v2.json', slug: 'short' }]), { short: { file: 'Long_Name__v2.json', provenance: '' } }, 'an explicit slug overrides the derived one');
throws(() => toBooks(['A.json', 'a.json']), 'two books sharing a slug is refused, never merged');
throws(() => toBooks([{ file: 'A.json', slug: 'x' }, { file: 'B.json', slug: 'x' }]), 'two explicit slugs colliding is refused too');
throws(() => toBooks([{ provenance: 'curated' }]), 'a record with no file is refused');
throws(() => toBooks([]), 'an empty list is not a roster');

const NO_ROSTER = '/nonexistent/books.json';
eq(evalBooks(['node', 'x', '--books', 'A.json,B.json'], NO_ROSTER),
    { a: { file: 'A.json', provenance: '' }, b: { file: 'B.json', provenance: '' } }, '--books supplies the roster');
throws(() => evalBooks(['node', 'x'], NO_ROSTER), 'no flag and no roster refuses rather than guessing');
throws(() => evalBooks(['node', 'x', '--books', '--model'], NO_ROSTER), 'a flag with no value is not a roster');

const ROSTER = join(tmpdir(), `wa-books-${process.pid}.json`);
writeFileSync(ROSTER, JSON.stringify(['A.json', { file: 'B.json', provenance: 'manually curated' }]));
eq(evalBooks(['node', 'x'], ROSTER),
    { a: { file: 'A.json', provenance: '' }, b: { file: 'B.json', provenance: 'manually curated' } }, 'a roster mixes bare filenames and records');
writeFileSync(ROSTER, JSON.stringify({ a: 'A.json' }));
throws(() => evalBooks(['node', 'x'], ROSTER), 'an object roster is refused: it is a list');
writeFileSync(ROSTER, '[]');
throws(() => evalBooks(['node', 'x'], ROSTER), 'an empty roster is not a roster');
rmSync(ROSTER, { force: true });

// ROSTER is module-relative, so moving corpus.mjs silently repoints it. Nothing else exercises it.
const REPO = resolve(new URL('..', import.meta.url).pathname);
eq(resolve(DEFAULT_ROSTER), resolve(REPO, 'eval/eval-data/books.json'), 'the roster is eval-data/books.json, wherever this module lives');

// WORLDS goes through stInstall, so it is pinned to the install's own answer rather than to a count of directories:
// re-deriving it here would restate the assumption instead of checking it.
const ST = stInstall();
eq(WORLDS, ST.resolve('data/default-user/worlds'), "WORLDS is ST's lorebook directory as the install reports it");
eq(WORLDS.startsWith(ST.dataRoot), true, 'and it sits under dataRoot, so a relocated data directory moves it');

if (process.exitCode !== 1) console.log('corpus-check: ok');
