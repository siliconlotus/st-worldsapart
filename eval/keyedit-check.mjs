// keyedit-check.mjs — keyedit.mjs: kwNorm, hasKey, keyHolders, renameKeyOn, deleteKey, replaceKey, addVariant.
// Self-checking; run with no arguments.

import { addVariant, deleteKey, hasKey, keyHolders, kwNorm, renameKeyOn, replaceKey } from '../extension/keyedit.mjs';
import { eq } from './metrics.mjs';

const book = () => [{ key: ['Cat', 'dog'] }, { key: ['cat'] }, { key: ['bird'] }, { key: [] }, {}];

// --- what counts as the same key is what core's default scan counts: case and surrounding space
eq(kwNorm('  Cat '), 'cat', 'a key is normalised for comparison, never for storage');
eq(hasKey({ key: ['Cat'] }, 'cat'), true, 'so a case-different key is the same key');
eq(hasKey({ keysecondary: ['b'] }, 'b'), false, 'and the list is the caller\'s to name...');
eq(hasKey({ keysecondary: ['b'] }, 'b', 'keysecondary'), true, '...on both sides');
eq(keyHolders(book(), 'CAT').length, 2, 'holders finds every entry with the key, an unkeyed one included safely');

// --- rename: a collision merges rather than duplicating, and a case fix does not delete itself
{
    const e = { key: ['Cat', 'feline'] };
    eq(renameKeyOn(e, 'Cat', 'feline') && e.key.join(), 'feline', 'a rename onto a key the entry has is a merge');
    const c = { key: ['cat', 'dog'] };
    eq(renameKeyOn(c, 'cat', 'Cat') && c.key.join(), 'Cat,dog', 'a case fix is a real edit and keeps the key');
    eq(renameKeyOn({ key: ['a'] }, 'missing', 'x'), false, 'a key the entry does not have is not renamed');
    const sec = { keysecondary: ['a'] };
    eq(renameKeyOn(sec, 'a', 'b', 'keysecondary') && sec.keysecondary.join(), 'b', 'and the secondary list is renamed the same way');
}

// --- the book-wide three, each reporting what it touched
{
    const es = book();
    eq(addVariant(es, 'cat', 'kitten'), 2, 'a variant lands on every entry keyed the same...');
    eq(addVariant(es, 'cat', 'KITTEN'), 0, '...and not twice, whatever its case');
    eq(es[0].key.join(), 'Cat,dog,kitten', 'appended, leaving the rest of the list alone');
    eq(replaceKey(es, 'cat', 'feline'), 2, 'a replacement rewrites every holder');
    eq(es[1].key.join(), 'feline,kitten', 'in place, so the order is kept');
    eq(replaceKey([{ key: ['Cat', 'feline'] }], 'cat', 'feline'), 1, 'and merges where the entry already had the target');
    eq(deleteKey(es, 'kitten'), 2, 'a delete removes it from every holder');
    eq(es.every(e => !hasKey(e, 'kitten')), true, 'and from none other');
    eq(deleteKey(es, 'nothing'), 0, 'a key nothing has touches nothing');
}

console.log(process.exitCode ? 'FAILED  keyedit' : 'ok   keyedit: rename merges, and the book-wide three report what they touched');
