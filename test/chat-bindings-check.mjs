// The plugin's /chat-bindings route, called on a real deploy against a throwaway chats folder. Skips without an ST install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stInstall } from '../eval/lib/st-install.mjs';
import { eq, eqDeep } from '../eval/lib/metrics.mjs';
import { deploySandbox } from './plugin-sandbox.mjs';

const st = stInstall();
if (!st) {
    console.log('ok  (no SillyTavern install reachable — the plugin cannot load)');
    process.exit(0);
}

const US = String.fromCharCode(0x1F);
const chats = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-chats-'));
const groupChats = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-group-chats-'));
const write = (dir, file, meta) => {
    fs.mkdirSync(path.join(chats, dir), { recursive: true });
    fs.writeFileSync(path.join(chats, dir, file), `${JSON.stringify({ chat_metadata: meta })}\n{"mes":"hi"}\n`);
};
write('Ada', 'latched.jsonl', { world_info: 'Book', worldsApart: { fired: { [`Book${US}3`]: 7 } } });
write('Ada', 'plain.jsonl', { world_info: 'Book' });
write('Bo', 'unbound.jsonl', {});
fs.writeFileSync(path.join(groupChats, '1700000000.jsonl'), `${JSON.stringify({ chat_metadata: { world_info: 'Book', worldsApart: { fired: { [`Book${US}5`]: 2 } } } })}\n`);

const box = deploySandbox({ st });
try {
    eq(box.run.status, 0, `the deploy ran (${box.run.stderr.trim() || 'no stderr'})`);
    const plugin = await box.load();
    const routes = new Map();
    await plugin.default.init({ post: (p, h) => routes.set(p, h), get: (p, h) => routes.set(p, h) });
    let sent;
    const response = { send: v => (sent = v), status: () => response };
    await routes.get('/chat-bindings')({ user: { directories: { chats, groupChats } }, body: {} }, response);
    const byFile = Object.fromEntries((sent?.bindings ?? []).map(b => [b.file, b]));
    eq(sent?.chats, 3, 'every chat file is counted');
    eqDeep(byFile['latched.jsonl']?.fired, { [`Book${US}3`]: 7 }, 'a chat holding latch records reports them, firing turn intact');
    eq(byFile['latched.jsonl']?.world_info, 'Book', '...beside its binding');
    eq('fired' in (byFile['plain.jsonl'] ?? {}), false, 'a chat with no record carries no `fired`');
    eq(byFile['unbound.jsonl']?.world_info, null, 'an unbound chat is still listed');
    eqDeep(sent?.groups, [{ id: '1700000000', world_info: 'Book', fired: { [`Book${US}5`]: 2 } }], 'a group chat is listed by id, with its binding and latch record');
} finally {
    box.cleanup();
    fs.rmSync(chats, { recursive: true, force: true });
    fs.rmSync(groupChats, { recursive: true, force: true });
}
