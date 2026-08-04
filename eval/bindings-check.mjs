// Orphaned bindings: chats and character cards naming a lorebook that no longer exists.
//
// The detection is pure and lives in bindings.mjs precisely so it can be tested — the Studio view that
// renders it cannot be. Today's lesson, applied before rather than after.
import { findOrphanBindings, nearestWorld, normalizeWorldName } from '../extension/bindings.mjs';
import { eq } from './metrics.mjs';

const chat = (file, world) => ({ file_name: file, chat_metadata: world ? { world_info: world } : {} });

// Separators are the difference nobody means — a rename that only changed punctuation is the same book.
eq(normalizeWorldName('LTM_Isekai_-_Time_Whore'), 'ltm isekai time whore', 'underscores and dashes collapse');
eq(normalizeWorldName('  A  B  '), 'a b', 'runs of whitespace collapse, ends trim');

// Containment, not edit distance: the real case is a qualifier added or removed.
{
    const worlds = ['LTM_Isekai_-_Time_Whore_updated', 'Foxbridge', 'albion_lorebook_v2'];
    eq(nearestWorld('LTM Isekai - Time Whore', worlds), 'LTM_Isekai_-_Time_Whore_updated', 'a dropped qualifier is recognised');
    eq(nearestWorld('Foxbridge', worlds), null, 'a name that still exists is not its own suggestion');
    eq(nearestWorld('Sommers_Pack', worlds), null, 'an unrelated name gets no guess, rather than a near one');
    // The failure that matters: suggesting a book leads to rewriting chat history, so a wrong guess is
    // worse than none. Two books alike but neither containing the other must not match.
    eq(nearestWorld('Alastor v1', ['Alastor v2']), null, 'similar-but-divergent names are not suggested');
    eq(nearestWorld('Alastor', ['Alastor v2']), 'Alastor v2', '...but a true prefix is');
}

{
    const worlds = ['Kept', 'Kept_v2'];
    const index = [
        { char: 'Ann', avatar: 'Ann.png', charWorld: 'Gone', chats: [chat('a.jsonl', 'Gone'), chat('b.jsonl', 'Kept')] },
        { char: 'Bob', avatar: 'Bob.png', charWorld: 'Kept', chats: [chat('c.jsonl', 'Gone'), chat('d.jsonl', null)] },
    ];
    const r = findOrphanBindings(index, worlds);
    eq(r.missing.length, 1, 'one missing book, however many bindings point at it');
    eq(r.chatCount, 2, 'both orphaned chats counted');
    eq(r.cardCount, 1, 'the character card binding is counted separately — it is diagnosable, not fixable');
    eq(r.missing[0].name, 'Gone', 'grouped under the name that does not resolve');
    eq(r.missing[0].chats.map(c => c.file).join(','), 'a.jsonl,c.jsonl', 'chats carry enough to fetch them');
    eq(r.missing[0].cards.join(','), 'Ann', 'and the cards carry who to tell you to fix by hand');
    eq(r.missing[0].nearest, null, '"Gone" resembles neither existing book');
}

// A chat with no binding at all is not an orphan — it simply has no book, which is normal.
eq(findOrphanBindings([{ char: 'A', avatar: 'A.png', charWorld: null, chats: [chat('x.jsonl', null)] }], ['K']).chatCount, 0,
    'an unbound chat is not a broken binding');
eq(findOrphanBindings([], ['K']).missing.length, 0, 'no chats, nothing missing');
eq(findOrphanBindings(undefined, []).chatCount, 0, 'an index that never loaded is empty, not a throw');

console.log('ok   orphaned bindings are found, grouped, and only confidently suggested');
