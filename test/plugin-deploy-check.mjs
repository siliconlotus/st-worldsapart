// The real deploy-plugin.mjs, run into a sandbox root: it writes the loader, names this install in source.json, and sweeps
// what an older copying deploy left. Loading through the loader is embed-sources-check's and plugin-routes-check's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq } from '../eval/lib/metrics.mjs';
import { deploySandbox } from './plugin-sandbox.mjs';
import { stInstall } from '../eval/lib/st-install.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };

// A copying deploy's leftovers: its flat modules, a failed run's temp file, a link to nothing, and a directory.
const box = deploySandbox({
    prepare: root => {
        const dest = path.join(root, 'plugins', 'worlds-apart');
        fs.mkdirSync(path.join(dest, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'node_modules', 'kept.js'), '');
        for (const flat of ['scoring.mjs', 'matcher.mjs', 'smartkeys.mjs', 'fingerprint.mjs']) fs.writeFileSync(path.join(dest, flat), 'export {};\n');
        fs.writeFileSync(path.join(dest, 'matcher.mjs.deploying'), 'half a file');
        fs.writeFileSync(path.join(dest, 'index.js'), '// an older, copied server.js\n');
        fs.symlinkSync(path.join(root, 'nowhere.mjs'), path.join(dest, 'dangling.mjs'));
    },
});
const at = name => path.join(box.dir, name);
try {
    eq(box.run.status, 0, `the deploy ran (${box.run.stderr.trim() || 'no stderr'})`);

    eq(fs.readFileSync(at('index.js'), 'utf8') === fs.readFileSync(path.join(REPO, 'plugin', 'loader.js'), 'utf8'), true, 'index.js is a byte copy of the loader');
    eq(JSON.parse(fs.readFileSync(at('package.json'), 'utf8')).type, 'module', 'package.json marks the loader as ESM');
    const { install } = JSON.parse(fs.readFileSync(at('source.json'), 'utf8'));
    eq(path.resolve(box.root, install), REPO, 'source.json names the install the deploy ran from');
    eq(path.isAbsolute(install), true, '...absolute, since this one sits outside the sandbox root');

    for (const flat of ['scoring.mjs', 'matcher.mjs', 'smartkeys.mjs', 'fingerprint.mjs']) eq(lstat(at(flat)), null, `the sweep removes the copied ${flat}`);
    eq(lstat(at('matcher.mjs.deploying')), null, "and a failed run's temp file");
    eq(lstat(at('dangling.mjs')), null, 'and a link to nothing, which has no stat to read');
    eq(fs.existsSync(at('node_modules/kept.js')), true, '...but leaves a directory, and what is in it, alone');
    const expected = new Set(['index.js', 'package.json', 'source.json', 'node_modules']);
    eq(fs.readdirSync(box.dir).filter(n => !expected.has(n)).join(', '), '', 'nothing else is left beside the loader');

    // Without source.json the loader must still import, exporting a plugin that registers nothing, or ST's loader would throw.
    fs.rmSync(at('source.json'));
    const quiet = console.error;
    console.error = () => {};
    let bare;
    try { bare = await import(`${pathToFileURL(at('index.js')).href}?nosource`); } finally { console.error = quiet; }
    eq(typeof bare.default.init === 'function' && bare.EMBED_SOURCES.length === 0, true, 'a loader with no source.json loads and registers nothing');
} finally {
    box.cleanup();
}

// ST's "move to global" leaves source.json naming a per-user folder that is gone; the loader takes the shared one of that name.
{
    const st = stInstall();
    if (!st) console.log('ok   (no SillyTavern install reachable — a moved install cannot be loaded)');
    else {
        const name = path.basename(REPO);
        const moved = deploySandbox({ st, prepare: root => {
            fs.mkdirSync(path.join(root, 'public', 'scripts', 'extensions', 'third-party'), { recursive: true });
            fs.symlinkSync(REPO, path.join(root, 'public', 'scripts', 'extensions', 'third-party', name), 'dir');
        } });
        try {
            fs.writeFileSync(path.join(moved.dir, 'source.json'), JSON.stringify({ install: `data/default-user/extensions/${name}` }));
            const quiet = console.warn;
            console.warn = () => {};
            let plugin;
            try { plugin = await moved.load(); } finally { console.warn = quiet; }
            eq(plugin.EMBED_SOURCES.length > 0, true, 'a recorded per-user install that is gone loads the shared one of the same name');
            const routes = new Map();
            const log = console.log; console.log = () => {};
            try { await plugin.default.init({ post: (r, h) => routes.set(r, h), get: (r, h) => routes.set(r, h) }); } finally { console.log = log; }
            let sent;
            routes.get('/ping')({ body: {} }, { send: x => { sent = x; } });
            eq(sent.install, path.join('public', 'scripts', 'extensions', 'third-party', name), '...and /ping names the install it loaded, not the stale record');
            eq(sent.shared, false, 'a ping with no folder name reports no shared install');
            eq('root' in sent || 'dataRoot' in sent, false, 'a caller who is not an admin is not told where the server keeps its files');
            routes.get('/ping')({ body: {}, user: { profile: { admin: true } } }, { send: x => { sent = x; } });
            eq(path.isAbsolute(sent.root) && path.isAbsolute(sent.dataRoot), true, '...and an admin is, for the deploy command');
            routes.get('/ping')({ body: { dir: name } }, { send: x => { sent = x; } });
            eq(sent.shared, true, 'and one naming a folder installed for all users reports it, so a per-user copy of it can say it hides it');
            routes.get('/ping')({ body: { dir: '../../../etc' } }, { send: x => { sent = x; } });
            eq(sent.shared, false, 'a folder name is sanitised before it reaches the filesystem');
        } finally { moved.cleanup(); }
    }
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
