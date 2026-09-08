// Orphaned bindings (bindings.mjs): chats and character cards naming a lorebook that no longer exists.
import { findOrphanBindings, nearestWorld, normalizeWorldName, editDistance } from '../extension/bindings.mjs';
import { eq } from './metrics.mjs';

const chat = (file, world) => ({ file_name: file, chat_metadata: world ? { world_info: world } : {} });

eq(normalizeWorldName('LTM_Isekai_-_Time_Whore'), 'ltm isekai time whore', 'underscores and dashes collapse');
eq(normalizeWorldName('  A  B  '), 'a b', 'runs of whitespace collapse, ends trim');

{
    const worlds = ['LTM_Isekai_-_Time_Whore_updated', 'Foxbridge', 'albion_lorebook_v2'];
    eq(nearestWorld('LTM Isekai - Time Whore', worlds), 'LTM_Isekai_-_Time_Whore_updated', 'a dropped qualifier is recognised');
    eq(nearestWorld('Foxbridge', worlds), null, 'a name that still exists is not its own suggestion');
    eq(nearestWorld('LTM_-__Daddy_Next_Door__ABO_-_keywords_revised', ['LTM_-__Daddy_Next_Door__ABO__keywords_revised']),
        'LTM_-__Daddy_Next_Door__ABO__keywords_revised', 'a rename that only moved a separator is recognised');
    eq(nearestWorld('Sommers_Pack', worlds), null, 'an unrelated name gets no guess, rather than a near one');
    eq(nearestWorld('Alastor', ['Alastor v2']), 'Alastor v2', 'a true prefix is suggested');
    eq(nearestWorld('Sommers_Pack__v22', ['Sommers_Pack__v23', 'Foxbridge']), 'Sommers_Pack__v23', 'a version bump is recognised');
    eq(nearestWorld('Alastor v1', ['Alastor v2']), 'Alastor v2', '...including one digit apart');
    eq(nearestWorld('Gladiator', ['Foxbridge', 'albion_lorebook_v2', 'Mystara']), null, 'nothing close gets no guess');
    eq(nearestWorld('Foxbridge', ['Sommers_Pack__v22']), null, 'and an unrelated long name is not within tolerance');
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

eq(findOrphanBindings([{ char: 'A', avatar: 'A.png', charWorld: null, chats: [chat('x.jsonl', null)] }], ['K']).chatCount, 0,
    'an unbound chat is not a broken binding');
eq(findOrphanBindings([], ['K']).missing.length, 0, 'no chats, nothing missing');
eq(findOrphanBindings(undefined, []).chatCount, 0, 'an index that never loaded is empty, not a throw');

eq(editDistance('kitten', 'sitting'), 3, 'edit distance is the standard one');
eq(editDistance('', 'abc'), 3, 'and handles an empty side');

console.log('ok   orphaned bindings are found, grouped, and only confidently suggested');
