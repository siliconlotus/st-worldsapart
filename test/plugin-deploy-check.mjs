// The real deploy-plugin.mjs, run into a sandbox root: what it copies, what its sweep removes and leaves, and that the
// FLAT result stands alone in node. A cross-tree import added to the matcher breaks the server at load, not here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_FILES } from '../plugin/fingerprint.mjs';
import { countChatHits, setBoundaryMode } from '../extension/matcher.mjs';
import { eq } from '../eval/lib/metrics.mjs';
import { deploySandbox } from './plugin-sandbox.mjs';

const source = new URL('../plugin/', import.meta.url);
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };

// A previous deploy's leftovers: a retired module, a failed run's temp file, a link to nothing, and a directory.
const box = deploySandbox({
    prepare: root => {
        const dest = path.join(root, 'plugins', 'worlds-apart');
        fs.mkdirSync(path.join(dest, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'node_modules', 'kept.js'), '');
        fs.writeFileSync(path.join(dest, 'retired.mjs'), 'export {};\n');
        fs.writeFileSync(path.join(dest, 'matcher.mjs.deploying'), 'half a file');
        fs.writeFileSync(path.join(dest, 'index.js'), '// an older deploy\n');
        fs.symlinkSync(path.join(root, 'nowhere.mjs'), path.join(dest, 'dangling.mjs'));
    },
});
const at = name => path.join(box.dir, name);
try {
    eq(box.run.status, 0, `the deploy ran (${box.run.stderr.trim() || 'no stderr'})`);

    for (const [from, to] of PLUGIN_FILES) {
        eq(fs.readFileSync(at(to), 'utf8') === fs.readFileSync(fileURLToPath(new URL(from, source)), 'utf8'), true, `${to} is a byte copy of ${from}`);
    }
    eq(JSON.parse(fs.readFileSync(at('package.json'), 'utf8')).type, 'module', 'package.json marks the flat copy as ESM');

    eq(lstat(at('retired.mjs')), null, 'the sweep removes a file the manifest no longer names');
    eq(lstat(at('matcher.mjs.deploying')), null, "a failed run's temp file is taken over by the next run's copy and rename");
    eq(lstat(at('dangling.mjs')), null, 'the sweep removes a link to nothing, which has no stat to read');
    eq(fs.existsSync(at('node_modules/kept.js')), true, '...but leaves a directory, and what is in it, alone');
    const expected = new Set([...PLUGIN_FILES.map(([, to]) => to), 'package.json', 'node_modules']);
    eq(fs.readdirSync(box.dir).filter(n => !expected.has(n)).join(', '), '', 'nothing else is left beside the manifest');

    // index.js imports ST internals that exist only in an install; everything else must load with nothing around it.
    for (const [, to] of PLUGIN_FILES) {
        if (to === 'index.js' || !/\.(mjs|js)$/.test(to)) continue;
        await import(pathToFileURL(at(to)).href);
    }
    console.log(`ok   every deployed module resolves flat (${PLUGIN_FILES.length - 1} of ${PLUGIN_FILES.length}; index.js needs the install)`);

    // /scan-chats calls countChatHits off the deployed copy, so the deployed one must answer as the source does.
    const deployed = await import(pathToFileURL(at('matcher.mjs')).href);
    const msgs = ['The copper pipe burst', 'copper, but no plumbing', 'Colonel Vasquez called', 'nothing here'];
    const keys = ['copper', '? copper pipe', '? =cop', '/vasqu[ei]z/i'];
    setBoundaryMode('strict'); deployed.setBoundaryMode('strict');
    const here = countChatHits(keys, msgs), there = deployed.countChatHits(keys, msgs);
    eq(there.messages, here.messages, 'the deployed matcher counts the same messages');
    for (const k of keys) eq(there.messagesWith.get(k), here.messagesWith.get(k), `...and the same hits for ${k}`);
    eq(here.messagesWith.get('? =cop'), 0, 'and a `=` term is live server-side: it rejects "copper" where a plain term would hit');
    console.log('ok   the server scans chats through the shipped matcher, not a copy of it');
} finally {
    box.cleanup();
}

// config.yaml: patched only from false, by rename; the original backed up once and never retaken; a failure is its own error.
{
    const cfgOf = root => path.join(root, 'config.yaml');
    const withConfig = text => deploySandbox({ prepare: root => fs.writeFileSync(cfgOf(root), text) });

    const off = withConfig('port: 8000\nenableServerPlugins: false\n');
    try {
        eq(off.run.status, 0, 'a deploy over enableServerPlugins: false succeeds');
        eq(fs.readFileSync(cfgOf(off.root), 'utf8'), 'port: 8000\nenableServerPlugins: true\n', '...turns it on and touches nothing else');
        eq(fs.readFileSync(`${cfgOf(off.root)}.wa-backup`, 'utf8'), 'port: 8000\nenableServerPlugins: false\n', '...and backs up the original');
        fs.writeFileSync(cfgOf(off.root), 'enableServerPlugins: false\n');
        off.deploy();
        eq(fs.readFileSync(`${cfgOf(off.root)}.wa-backup`, 'utf8'), 'port: 8000\nenableServerPlugins: false\n', 'a second run never retakes the backup');
        eq(fs.readdirSync(off.root).filter(n => n.endsWith('.deploying')).join(', '), '', 'and neither leaves a temp file beside config.yaml');
    } finally { off.cleanup(); }

    const on = withConfig('enableServerPlugins: true\n');
    try {
        eq(fs.existsSync(`${cfgOf(on.root)}.wa-backup`), false, 'already true: no backup is taken');
    } finally { on.cleanup(); }

    const none = deploySandbox();
    try {
        eq(none.run.status === 0 && /no config\.yaml/.test(none.run.stdout), true, 'no config.yaml: a note, and the deploy still succeeds');
    } finally { none.cleanup(); }

    // A write that fails must fail the deploy under its own name. Root reads through any permission, so it cannot be staged there.
    if (process.getuid?.() !== 0) {
        // The plugin directory exists and stays writable; only the root, where the backup goes, is locked.
        const locked = deploySandbox({ prepare: root => {
            fs.mkdirSync(path.join(root, 'plugins', 'worlds-apart'), { recursive: true });
            fs.writeFileSync(cfgOf(root), 'enableServerPlugins: false\n');
            fs.chmodSync(root, 0o555);
        } });
        try {
            const r = locked.run;
            eq(r.status !== 0 && /EACCES/.test(r.stderr) && !/no config\.yaml/.test(r.stdout), true, 'a backup it cannot write fails the deploy as EACCES, not as a missing file');
            eq(fs.readFileSync(cfgOf(locked.root), 'utf8'), 'enableServerPlugins: false\n', '...and leaves config.yaml as it was');
        } finally { fs.chmodSync(locked.root, 0o755); locked.cleanup(); }
    }
}
