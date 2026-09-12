// Makes the sentinel fixture visible to SillyTavern, so the half of the audit that cannot be reached
// from node — chips, tooltips, colours, the pre-tick — can be checked against a book whose every
// verdict is written down in sentinel-check.mjs.
//
// LINKS, not copies: editing the fixture has to change what the UI shows, or the two drift and the
// eyeball check starts verifying a stale answer. Re-run after moving the repo; `--remove` unlinks.
//
// The two use different link types, and that is forced by ST rather than chosen. Worlds are listed with
// a plain readdirSync (src/endpoints/settings.js), which returns names, so a SYMLINK is seen. Chats are
// listed with `withFileTypes: true` and filtered on `file.isFile()` (src/endpoints/characters.js), and
// a symlink's dirent answers isSymbolicLink() rather than isFile() — so a symlinked chat is dropped
// before its metadata is ever read, and nothing binds. A HARD link is an ordinary directory entry for
// the same inode: it passes the filter and still shares every edit.
//
// The cost of the hard link is that it does not survive the file being REPLACED rather than written in
// place — a git checkout of the fixture makes a new inode and silently orphans the copy in ST. Re-run
// this script after one.
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
// indexOf returns -1 when absent, and args[0] is NOT the character folder — that silently made
// `--remove` look for the chat under a directory named "--remove" and clean up nothing.
const charArg = args.includes('--char') ? args[args.indexOf('--char') + 1] : null;

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
    ['symlink', path.join(HERE, 'sentinel-book.json'), path.join(WORLDS, `${WORLD_NAME}.json`)],
    ...(chatDir ? [['hardlink', path.join(HERE, 'sentinel-chat.jsonl'), path.join(chatDir, `${WORLD_NAME}.jsonl`)]] : []),
];

/** Ours if it is our symlink, or a hard link to the same inode. Anything else is someone's real file. */
const isOurs = (kind, src, dst) => {
    const st = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (!st) return false;
    if (kind === 'symlink') return st.isSymbolicLink() && fs.readlinkSync(dst) === src;
    return st.ino === fs.statSync(src).ino;
};

for (const [kind, src, dst] of links) {
    if (fs.lstatSync(dst, { throwIfNoEntry: false })) {
        if (!isOurs(kind, src, dst) && !remove) { console.error(`refused: ${dst} exists and is not ours`); process.exit(1); }
        fs.unlinkSync(dst);
        console.log(`${remove ? 'removed' : 'replaced'}  ${dst}`);
    }
    if (remove) continue;
    if (kind === 'symlink') fs.symlinkSync(src, dst); else fs.linkSync(src, dst);
    console.log(`${kind.padEnd(8)}  ${dst}`);
}

if (remove) process.exit(0);
if (!chatDir) {
    console.log('\nNo character with existing chats found — the book is linked, the chat is not.');
    console.log('Pass --char <folder under data/default-user/chats> to place it.');
    process.exit(0);
}
console.log(`\nOpen "${WORLD_NAME}" in the chat list under ${path.basename(chatDir)}, then open the Studio on the`);
console.log(`"${WORLD_NAME}" book and press Re-audit. The chat binds itself via chat_metadata.world_info,`);
console.log('so the audit should report 11 messages and these verdicts (see sentinel-check.mjs):');
console.log('   quarkspindle             unflagged, green');
console.log('   zzunattested             dead — "not in entry text or chat"');
console.log('   glimmerwort              unflagged (the chat uses it, so the dead flag is dropped)');
console.log('   ? thornwick brambleshaw  "never matches" at the DEFAULT paragraph window — its two terms');
console.log('                            sit in different paragraphs of its own entry. Unflagged at scan');
console.log('                            or message, which is the tell that the setting is arriving:');
console.log('                            entry text has no messages, so only paragraph subdivides it.');
console.log('   mother                   "common", warning severity — quiet in this chat');
console.log('   morning                  "chat common · 55% of messages", severe by degree (more messages than not) —');
console.log('                            red, but never pre-ticked: constant or a narrower key is the remedy');
console.log('   ver                      dead in entry text; fires 4/11 only inside longer words — with a chat');
console.log('                            scanned, "fires in 36% of messages, 0% as a word — consider ? =ver"');
console.log('   ? sodium & lamps         unflagged (attested in its own text). Its ACTIVATION is the');
console.log('                            union check: core reads "?" as a literal and never fires it;');
console.log('                            with WA enabled it must appear in the prompt on a café/bistro turn.');
console.log('   caf                      dead under WA — whole-word, and "café" does not count (core');
console.log('                            WOULD fire it; that divergence is the entry\'s whole point)');
console.log('   bistro                   unflagged; loses the terrace group to caf\'s override under core.');
console.log('   CIA                      "short (1/4 clean) — consider ? =CIA": inside special/official/social, once as');
console.log('                            the word; the book-side twin of the substring flag\'s suggestion');
console.log('   lamp-post                "book uses it only un-hyphenated", minor — the space form is');
console.log('                            in its own content, the hyphenated form nowhere.');
console.log('   /Cap\'n \\\\w+/             "will not match curly form, consider [...]", minor, the class being');
console.log('                            fold\'s own apostrophe family. Same chip in the Explorer and in');
console.log('                            Bulk Cleanup: both read the classifier.');
console.log('   /Bose-Einstein \\\\w+/      "book uses en-dash, consider [-–]", minor. Dead as');
console.log('                            written, and the evidence outranks that dead verdict.');
console.log('                            Explorer and in Bulk Cleanup: both read the classifier.');
console.log('');
console.log('Runtime eyeball (prune, bucket 1.5): on a generation whose recent chat mentions café');
console.log('and bistro, the prompt must contain NEITHER terrace entry — core picks caf as group');
console.log('winner, WA deletes it, and the group goes empty (ruled; bucket 2 promotes bistro).');
console.log('');
console.log('Runtime eyeball, scan-loop behaviours (uids 10-18; enable recursion for 12-18).');
console.log('None of these may EVER appear in runState.lastPruned:');
console.log('   cold frame (sticky 3)    say "cold frame" once: fires, then stays in the prompt the');
console.log('                            next 3 turns while the key is out of the window — the sticky');
console.log('                            exemption is what keeps the prune off it on those turns.');
console.log('   first light (cooldown 2) fires on mention, then refuses to re-fire for 2 messages');
console.log('                            even if mentioned again — core gates cooldown before external');
console.log('                            activations, so WA\'s union force cannot break it.');
console.log('   workshop → duskmoth      mention "workshop": uid 12 fires from chat and its content');
console.log('                            drags uid 13 in on the RECURSION pass. duskmoth is in no chat');
console.log('                            message — the INITIAL-only gate is why the prune spares it.');
console.log('   midnight (delay-until-   never fires on the initial pass even though "midnight" is in');
console.log('   recursion 1)             chat; appears only when a recursion pass runs.');
console.log('   → vellumwing             uid 13\'s content carries it, so it arrives one pass LATER than');
console.log('                            duskmoth: depth 2, and its keys score is divided by 1 + 2.');
console.log('   gloamvetch               uid 12\'s content carries it, so the buffer has its key — but the');
console.log('                            entry is non-recursable, so it must NOT appear in the prompt and');
console.log('                            must show no keys score in the Studio.');
console.log('   sedgewhistle             appears only in uid 16\'s content, and uid 16 prevents further');
console.log('                            recursion, so it must never appear at any depth.');
