// The deployed plugin is FLAT: every manifest module is copied beside index.js, so each must resolve by bare './name'
// and stand alone in node. A cross-tree import added to the matcher breaks the server at load, not here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_FILES } from '../plugin/fingerprint.mjs';
import { countChatHits, setBoundaryMode } from '../extension/matcher.mjs';
import { eq } from '../eval/metrics.mjs';

const root = new URL('../plugin/', import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-deploy-'));
for (const [from, to] of PLUGIN_FILES) fs.copyFileSync(fileURLToPath(new URL(from, root)), path.join(dir, to));

// index.js imports ST internals that exist only in the install; everything else must load with nothing around it.
for (const [, to] of PLUGIN_FILES) {
    if (to === 'index.js' || !/\.(mjs|js)$/.test(to)) continue;
    await import(pathToFileURL(path.join(dir, to)).href);
}
console.log(`ok   every deployed module resolves flat (${PLUGIN_FILES.length - 1} of ${PLUGIN_FILES.length}; index.js needs the install)`);

// /scan-chats calls countChatHits off the deployed copy, so the deployed one must answer as the source does.
{
    const deployed = await import(pathToFileURL(path.join(dir, 'matcher.mjs')).href);
    const msgs = ['The copper pipe burst', 'copper, but no plumbing', 'Colonel Vasquez called', 'nothing here'];
    const keys = ['copper', '? copper pipe', '? =cop', '/vasqu[ei]z/i'];
    setBoundaryMode('strict'); deployed.setBoundaryMode('strict');
    const here = countChatHits(keys, msgs), there = deployed.countChatHits(keys, msgs);
    eq(there.messages, here.messages, 'the deployed matcher counts the same messages');
    for (const k of keys) eq(there.messagesWith.get(k), here.messagesWith.get(k), `...and the same hits for ${k}`);
    eq(here.messagesWith.get('? =cop'), 0, 'and a `=` term is live server-side: it rejects "copper" where a plain term would hit');
}
console.log('ok   the server scans chats through the shipped matcher, not a copy of it');
fs.rmSync(dir, { recursive: true, force: true });
