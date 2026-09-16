// deploy-plugin.mjs — copies plugin/ into ST's /plugins/worlds-apart/ (a generated copy, never hand-edited), removes
// top-level files the manifest no longer names, and enables server plugins in config.yaml. Restart ST afterwards.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { PLUGIN_FILES, pluginFingerprint } from './plugin/fingerprint.mjs';
import { stInstall } from './eval/lib/st-install.mjs';

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

// Everything the deploy may leave behind; any other top-level file in DEST is stale by definition.
const KEEP = new Set([...PLUGIN_FILES.map(([, to]) => to), 'package.json']);

fs.mkdirSync(DEST, { recursive: true });

for (const [from, to] of PLUGIN_FILES) {
    const src = path.join(SRC, 'plugin', from);
    const dst = path.join(DEST, to);
    // Copy-then-swap: a failure mid-copy leaves the previously deployed copy intact, not half a plugin.
    const tmp = `${dst}.deploying`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
    console.log(`copied  ${path.relative(SRC, src)}  ->  plugins/worlds-apart/${to}`);
}

fs.writeFileSync(path.join(DEST, 'package.json'), PACKAGE_JSON);
console.log('wrote    package.json');

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
    console.log(`removed  plugins/worlds-apart/${name}  (not in the manifest)`);
}

const configPath = path.join(ST.root, 'config.yaml');
try {
    const cfg = fs.readFileSync(configPath, 'utf8');
    if (/^enableServerPlugins:\s*false\b/m.test(cfg)) {
        // Re-taking it would back up the patched file.
        const backup = `${configPath}.wa-backup`;
        if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);
        const tmp = `${configPath}.deploying`;
        fs.writeFileSync(tmp, cfg.replace(/^(enableServerPlugins:\s*)false\b/m, '$1true'));
        fs.renameSync(tmp, configPath);
        console.log('enabled  enableServerPlugins: true in config.yaml (was false; the original is at config.yaml.wa-backup)');
    } else if (/^enableServerPlugins:\s*true\b/m.test(cfg)) {
        console.log('ok       enableServerPlugins already true in config.yaml');
    } else {
        console.log('NOTE     enableServerPlugins not found in config.yaml — set it to true manually');
    }
} catch {
    console.log(`NOTE     no config.yaml at ${configPath} — launch ST once, then set enableServerPlugins: true`);
}

const fp = pluginFingerprint(...PLUGIN_FILES.map(([from]) => fs.readFileSync(path.join(SRC, 'plugin', from), 'utf8')));
console.log(`\nDeployed to ${DEST}\nfingerprint ${fp} — the settings panel should show this once ST restarts.\nRestart SillyTavern for the plugin to reload.`);
