// deploy-plugin.mjs — writes ST's /plugins/worlds-apart/: the loader as index.js, which imports this install's plugin/server.js
// at every ST start, and source.json naming this install. Removes the files an older copying deploy left, and enables server
// plugins in config.yaml. Needed once per install, and again only when the loader changes; restart ST afterwards.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { stInstall, isPerUserInstall } from './eval/lib/st-install.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ST = stInstall();
if (!ST) { console.error('no SillyTavern install above this checkout (no config.yaml found) — set WA_ST_ROOT'); process.exit(2); }
const DEST = path.join(ST.root, 'plugins/worlds-apart');

const PACKAGE_JSON = JSON.stringify({
    name: 'worlds-apart-plugin',
    type: 'module',
    main: 'index.js',
    private: true,
}, null, 4) + '\n';

// Relative to the ST root when this install sits inside it, so moving the whole ST folder keeps the plugin pointed here.
const rel = path.relative(ST.root, SRC);
const install = rel.startsWith('..') || path.isAbsolute(rel) ? SRC : rel;
const SOURCE_JSON = JSON.stringify({ install }, null, 4) + '\n';

// Everything the deploy may leave behind; any other top-level file in DEST is stale by definition.
const KEEP = new Set(['index.js', 'package.json', 'source.json']);

fs.mkdirSync(DEST, { recursive: true });

/** `text` to DEST/name by tmp then rename, never onto the file: ST may be loading it, and a torn file throws. */
const write = (name, text) => {
    const dst = path.join(DEST, name);
    fs.writeFileSync(`${dst}.deploying`, text);
    fs.renameSync(`${dst}.deploying`, dst);
    console.log(`wrote    plugins/worlds-apart/${name}`);
};
write('index.js', fs.readFileSync(path.join(SRC, 'plugin', 'loader.js'), 'utf8'));
write('package.json', PACKAGE_JSON);
write('source.json', SOURCE_JSON);

// Top-level files only, never directories: a node_modules is the user's to remove.
for (const name of fs.readdirSync(DEST)) {
    if (KEEP.has(name)) continue;
    const stale = path.join(DEST, name);
    let staleStat;
    try {
        staleStat = fs.statSync(stale);
    } catch {
        // A dangling symlink has no stat; removing it is the cleanup this sweep exists for.
        fs.rmSync(stale, { force: true });
        console.log(`removed  plugins/worlds-apart/${name}  (broken link)`);
        continue;
    }
    if (!staleStat.isFile()) {
        console.log(`SKIP     ${name}/ is a directory — left alone, remove it yourself if it is stale`);
        continue;
    }
    fs.rmSync(stale);
    console.log(`removed  plugins/worlds-apart/${name}  (not part of the loader)`);
}

const configPath = path.join(ST.root, 'config.yaml');
let cfg = null;
// ENOENT only: a failed backup or write below must surface as itself, not as a missing file.
try { cfg = fs.readFileSync(configPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (cfg === null) {
    console.log(`NOTE     no config.yaml at ${configPath} — launch ST once, then set enableServerPlugins: true`);
} else if (/^enableServerPlugins:\s*false\b/m.test(cfg)) {
    // Taken once and never again, since a later run would back up the patched file; so taken whole, by rename.
    const backup = `${configPath}.wa-backup`;
    if (!fs.existsSync(backup)) {
        fs.copyFileSync(configPath, `${backup}.deploying`);
        fs.renameSync(`${backup}.deploying`, backup);
    }
    const tmp = `${configPath}.deploying`;
    fs.writeFileSync(tmp, cfg.replace(/^(enableServerPlugins:\s*)false\b/m, '$1true'));
    fs.renameSync(tmp, configPath);
    console.log('enabled  enableServerPlugins: true in config.yaml (was false; the original is at config.yaml.wa-backup)');
} else if (/^enableServerPlugins:\s*true\b/m.test(cfg)) {
    console.log('ok       enableServerPlugins already true in config.yaml');
} else {
    console.log('NOTE     enableServerPlugins not found in config.yaml — set it to true manually');
}

if (isPerUserInstall(ST, SRC) && /^enableUserAccounts:\s*true\b/m.test(cfg ?? '')) {
    console.log('WARNING  this install belongs to one user account, and user accounts are enabled. The server runs the plugin from this folder,\n'
        + '         so whoever can replace that account\'s extensions decides what code the server runs. Install WorldsApart for all users\n'
        + '         unless that account is the server administrator\'s own.');
}

console.log(`\nThe plugin now loads WorldsApart from ${SRC}.\nRestart SillyTavern. From now on, updating the extension and restarting SillyTavern updates the plugin too.`);
