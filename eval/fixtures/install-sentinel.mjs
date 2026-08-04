// Makes the sentinel fixture visible to SillyTavern, so the half of the audit that cannot be reached
// from node — chips, tooltips, colours, the pre-tick — can be checked against a book whose every
// verdict is written down in sentinel-check.mjs.
//
// SYMLINKS, not copies: editing the fixture has to change what the UI shows, or the two drift and the
// eyeball check starts verifying a stale answer. Re-run after moving the repo; `--remove` unlinks.
//
//   node eval/fixtures/install-sentinel.mjs [--char <folder>] [--remove]
//
// The chat needs to live under a CHARACTER, because that is how ST files chats. Any character will do:
// the chat's own metadata binds it to the book, so the character it hangs off is irrelevant to the
// audit. Defaults to the first character folder that already has chats.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ST = path.resolve(HERE, '../../../../../../../');          // .../SillyTavern
const USER = path.join(ST, 'data', 'default-user');
const WORLDS = path.join(USER, 'worlds');
const CHATS = path.join(USER, 'chats');

// The world's FILENAME is its name in ST, and the fixture chat's chat_metadata.world_info must equal it.
const WORLD_NAME = 'WA Sentinel';
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const charArg = args[args.indexOf('--char') + 1];

if (!fs.existsSync(WORLDS)) {
    console.error(`No worlds folder at ${WORLDS} — is this extension installed under a SillyTavern tree?`);
    process.exit(1);
}

const chatDir = (() => {
    if (charArg) return path.join(CHATS, charArg);
    const dirs = fs.existsSync(CHATS) ? fs.readdirSync(CHATS).filter(d => fs.statSync(path.join(CHATS, d)).isDirectory()) : [];
    const withChats = dirs.find(d => fs.readdirSync(path.join(CHATS, d)).some(f => f.endsWith('.jsonl')));
    return withChats ? path.join(CHATS, withChats) : null;
})();

const links = [
    [path.join(HERE, 'sentinel-book.json'), path.join(WORLDS, `${WORLD_NAME}.json`)],
    ...(chatDir ? [[path.join(HERE, 'sentinel-chat.jsonl'), path.join(chatDir, `${WORLD_NAME}.jsonl`)]] : []),
];

for (const [src, dst] of links) {
    const existing = fs.existsSync(dst) || fs.lstatSync(dst, { throwIfNoEntry: false });
    if (existing) {
        const isOurs = fs.lstatSync(dst).isSymbolicLink() && fs.readlinkSync(dst) === src;
        if (!isOurs && !remove) { console.error(`refused: ${dst} exists and is not our symlink`); process.exit(1); }
        fs.unlinkSync(dst);
        console.log(`${remove ? 'removed' : 'replaced'}  ${dst}`);
    }
    if (remove) continue;
    fs.symlinkSync(src, dst);
    console.log(`linked    ${dst}`);
}

if (remove) process.exit(0);
if (!chatDir) {
    console.log('\nNo character with existing chats found — the book is linked, the chat is not.');
    console.log('Pass --char <folder under data/default-user/chats> to place it.');
    process.exit(0);
}
console.log(`\nOpen "${WORLD_NAME}" in the chat list under ${path.basename(chatDir)}, then open the Studio on the`);
console.log(`"${WORLD_NAME}" book and press Re-audit. The chat binds itself via chat_metadata.world_info,`);
console.log('so the audit should report 10 messages and these verdicts (see sentinel-check.mjs):');
console.log('   quarkspindle             unflagged, green');
console.log('   zzunattested             dead — "not in entry text or chat"');
console.log('   glimmerwort              unflagged (the chat uses it, so the dead flag is dropped)');
console.log('   ? thornwick brambleshaw  unflagged at scan; dead at paragraph');
console.log('   mother                   "common", warning severity — quiet in this chat');
console.log('   morning                  "common · 60% of chat", severe');
console.log('   ver                      dead in entry text; fires 4/10 only inside longer words');
