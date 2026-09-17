// Orphaned bindings (bindings.mjs): chats and character cards naming a lorebook that no longer exists.
import { attachedBooks, classifyBookChats, findOrphanBindings, nearestWorld, normalizeWorldName, editDistance } from '../extension/bindings.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const chat = (file, world) => ({ file_name: file, chat_metadata: world ? { world_info: world } : {} });

eq(normalizeWorldName('LTM_Orbit_-_Night_Launch'), 'ltm orbit night launch', 'underscores and dashes collapse');
eq(normalizeWorldName('  A  B  '), 'a b', 'runs of whitespace collapse, ends trim');

{
    const worlds = ['LTM_Orbit_-_Night_Launch_updated', 'Baikonur', 'mercury_lorebook_v2'];
    eq(nearestWorld('LTM Orbit - Night Launch', worlds), 'LTM_Orbit_-_Night_Launch_updated', 'a dropped qualifier is recognised');
    eq(nearestWorld('Baikonur', worlds), null, 'a name that still exists is not its own suggestion');
    eq(nearestWorld('LTM_-__House_Next_Door__Notes_-_keywords_revised', ['LTM_-__House_Next_Door__Notes__keywords_revised']),
        'LTM_-__House_Next_Door__Notes__keywords_revised', 'a rename that only moved a separator is recognised');
    eq(nearestWorld('Apollo_Crew', worlds), null, 'an unrelated name gets no guess, rather than a near one');
    eq(nearestWorld('Soyuz', ['Soyuz v2']), 'Soyuz v2', 'a true prefix is suggested');
    eq(nearestWorld('Apollo_Crew__v22', ['Apollo_Crew__v23', 'Baikonur']), 'Apollo_Crew__v23', 'a version bump is recognised');
    eq(nearestWorld('Soyuz v1', ['Soyuz v2']), 'Soyuz v2', '...including one digit apart');
    eq(nearestWorld('Vostok', ['Baikonur', 'mercury_lorebook_v2', 'Korolev']), null, 'nothing close gets no guess');
    eq(nearestWorld('Baikonur', ['Apollo_Crew__v22']), null, 'and an unrelated long name is not within tolerance');
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

{
    const r = findOrphanBindings([{ char: 'Cy', avatar: 'Cy.png', charWorld: null, extraBooks: ['Gone', 'Kept'], chats: [] }], ['Kept']);
    eq(r.cardCount, 1, 'an additional lorebook naming a missing book is a card orphan');
    eq(r.missing[0]?.name + ':' + r.missing[0]?.cards.join(), 'Gone:Cy', '...attributed to the character carrying it, the existing one untouched');
}

// --- attachedBooks: the four ways a book is active for one chat, and the group union
{
    const worlds = ['Global', 'CardBook', 'Aux', 'ChatBook', 'Persona', 'OtherCard'];
    const cast = [
        { avatar: 'a.png', data: { extensions: { world: 'CardBook' } } },
        { avatar: 'b.png', data: { extensions: { world: 'OtherCard' } } },
        { avatar: 'c.png' },
    ];
    const extras = { 'a.png': ['Aux'] };
    const extraBooksOf = av => extras[av] ?? [];
    const base = { characters: cast, extraBooksOf, worldNames: worlds };

    eq(attachedBooks({ ...base, globalBooks: ['Global'] }).join(','), 'Global',
        'no character and no chat: the global selection alone');
    eq(attachedBooks({ ...base, characterId: 0 }).join(','), 'CardBook,Aux',
        'a solo character contributes its own book and its charLore extras');
    eq(attachedBooks({ ...base, characterId: 2 }).length, 0, 'a character with no book contributes nothing');
    eq(attachedBooks({ ...base, globalBooks: ['Global'], characterId: 0, chatBook: 'ChatBook', personaBook: 'Persona' }).join(','),
        'Global,CardBook,Aux,ChatBook,Persona', 'all four sources, global first');
    eq(attachedBooks({ ...base, globalBooks: ['CardBook'], characterId: 0 }).join(','), 'CardBook,Aux',
        'a book active two ways appears once — the duplicate core also skips');
    eq(attachedBooks({ ...base, characterId: 0, chatBook: 'Nonexistent' }).join(','), 'CardBook,Aux',
        'a stale binding naming a book that no longer exists is dropped');
    // A group unions the members that can speak, where core resolves one member per generation.
    const group = { members: ['a.png', 'b.png'], disabled_members: [] };
    eq(attachedBooks({ ...base, group }).join(','), 'CardBook,Aux,OtherCard', 'a group unions its members');
    eq(attachedBooks({ ...base, group: { ...group, disabled_members: ['b.png'] } }).join(','), 'CardBook,Aux',
        'a disabled member contributes nothing');
    eq(attachedBooks({ ...base, group, characterId: 0 }).join(','), 'CardBook,Aux,OtherCard',
        'a group ignores characterId, which the group sets per speaker');
}

// --- classifyBookChats: the binding precedence, and the guard against an unselected book
{
    const idx = [
        { char: 'Ann', avatar: 'a.png', charWorld: 'CardBook', extraBooks: ['Aux'], chats: [
            { file_name: 'a1.jsonl', file_size: '2 KB', chat_metadata: { world_info: 'ChatBook' } },
            { file_name: 'a2.jsonl', file_size: '1 KB', chat_metadata: {} },
        ] },
        { char: 'Bo', avatar: 'b.png', charWorld: null, extraBooks: [], chats: [
            { file_name: 'b1.jsonl', file_size: '3 KB', chat_metadata: { world_info: 'ChatBook' } },
            { file_name: 'b2.jsonl', file_size: '4 KB', chat_metadata: {} },
        ] },
    ];
    const why = r => `${r.file}:${r.why}`;

    const chat = classifyBookChats(idx, { book: 'ChatBook' });
    eq(chat.rows.map(why).join(' '), 'a1.jsonl:chat-bound b1.jsonl:chat-bound', 'a chat binding names only its own chats');
    eq(chat.isGlobal, false, 'and the book is not global');
    eq(chat.rows.every(r => r.bound), true, 'a chat-bound row is bound');

    eq(classifyBookChats(idx, { book: 'CardBook' }).rows.map(why).join(' '),
        'a1.jsonl:character-bound a2.jsonl:character-bound', 'a card binding names every chat of that card');
    eq(classifyBookChats(idx, { book: 'Aux' }).rows.map(why).join(' '),
        'a1.jsonl:character-bound (additional lorebook) a2.jsonl:character-bound (additional lorebook)',
        'an extraBooks binding is named apart from the card’s own');

    // Precedence: the chat's own binding wins over the card's, which wins over global.
    const both = classifyBookChats([{ ...idx[0], charWorld: 'ChatBook' }], { book: 'ChatBook', globalBooks: ['ChatBook'] });
    eq(both.rows.map(why).join(' '), 'a1.jsonl:chat-bound a2.jsonl:character-bound',
        'chat beats card, and card beats global, per chat');
    eq(both.isGlobal, true, 'a book in the global selection reports isGlobal whatever else binds it');

    const glob = classifyBookChats(idx, { book: 'Global', globalBooks: ['Global'] });
    eq(glob.rows.length, 4, 'a global book lists every chat');
    eq(glob.rows.every(r => r.why === 'global (book is always active)'), true, '...as globally active');
    eq(glob.rows.some(r => r.bound), false, 'global is not a binding: no row is bound');

    eq(classifyBookChats(idx, { book: 'Unbound' }).rows.length, 0, 'a book nothing names lists nothing');
    eq(classifyBookChats(idx, { book: 'Unbound', all: true }).rows.map(why).join(' '),
        'a1.jsonl:not bound a2.jsonl:not bound b1.jsonl:not bound b2.jsonl:not bound',
        '`all` drops the filter and marks every chat unbound');
    // Without the !!book guard, `undefined === undefined` reads every chat with no world_info as chat-bound.
    eq(classifyBookChats(idx, { book: null, all: true }).rows.some(r => r.bound), false,
        'no book selected: nothing binds, including the chats carrying no world_info');
    eq(classifyBookChats(idx, { book: '', all: true }).rows.every(r => r.why === 'not bound'), true,
        '...and the empty name is read the same way');
    eq(classifyBookChats(null, { book: 'ChatBook' }).rows.length, 0, 'a missing index is empty, not a throw');
}
