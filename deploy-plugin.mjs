// Deploys the server plugin from this repo (source of truth) into ST's /plugins/worlds-apart/.
// The plugin, scoring math, and common-word list all live in this repo so the extension and its
// server half travel as one unit; /plugins/worlds-apart/ is a generated copy, never hand-edited.
//
// Run from this extension's folder after editing anything in plugin/ (server.js, the scoring math, etc.),
// then restart SillyTavern (the folder name doesn't matter — the script locates itself):
//   node deploy-plugin.mjs
//
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { PLUGIN_FILES, pluginFingerprint } from './plugin/fingerprint.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.resolve(SRC, '../../../../../plugins/worlds-apart');

const PACKAGE_JSON = JSON.stringify({
    name: 'worlds-apart-plugin',
    version: '0.2.0',
    type: 'module',
    main: 'index.js',
    private: true,
}, null, 4) + '\n';

// Everything the deploy is allowed to leave behind: the manifest's deployed names, plus the
// package.json written below. Anything else in DEST is stale by definition.
const KEEP = new Set([...PLUGIN_FILES.map(([, to]) => to), 'package.json']);

fs.mkdirSync(DEST, { recursive: true });

for (const [from, to] of PLUGIN_FILES) {
    const src = path.join(SRC, 'plugin', from);
    const dst = path.join(DEST, to);
    fs.rmSync(dst, { force: true });
    fs.copyFileSync(src, dst);
    console.log(`copied  plugin/${from}  ->  plugins/worlds-apart/${to}`);
}

fs.writeFileSync(path.join(DEST, 'package.json'), PACKAGE_JSON);
console.log('wrote    package.json');

// The manifest is the whole contents. This directory is generated, so a file the manifest no longer
// names is a leftover from an older layout, and leaving it is how a module the plugin stopped running
// goes on looking like plugin code.
//
// Top-level files only, never directories: a node_modules, or anything a user deliberately put here, is
// theirs to remove and not worth the blast radius of a recursive delete.
for (const name of fs.readdirSync(DEST)) {
    if (KEEP.has(name)) continue;
    const stale = path.join(DEST, name);
    if (!fs.statSync(stale).isFile()) {
        console.log(`SKIP     ${name}/ is a directory — left alone, remove it yourself if it is stale`);
        continue;
    }
    fs.rmSync(stale);
    console.log(`removed  plugins/worlds-apart/${name}  (not in the manifest)`);
}

// Server plugins are off by default in stock ST; flip the flag so the deployed plugin loads.
// Done here (not via sed) so the whole setup is one cross-platform command on Win/macOS/Linux.
const configPath = path.resolve(DEST, '../../config.yaml');
try {
    const cfg = fs.readFileSync(configPath, 'utf8');
    if (/^enableServerPlugins:\s*false\b/m.test(cfg)) {
        fs.writeFileSync(configPath, cfg.replace(/^(enableServerPlugins:\s*)false\b/m, '$1true'));
        console.log('enabled  enableServerPlugins: true in config.yaml (was false)');
    } else if (/^enableServerPlugins:\s*true\b/m.test(cfg)) {
        console.log('ok       enableServerPlugins already true in config.yaml');
    } else {
        console.log('NOTE     enableServerPlugins not found in config.yaml — set it to true manually');
    }
} catch {
    console.log(`NOTE     no config.yaml at ${configPath} — launch ST once, then set enableServerPlugins: true`);
}

// The fingerprint is why this script exists: the panel compares the deployed plugin's against the
// extension's source and shows a drift banner while they differ. Printing it here turns "did the
// redeploy take" into a comparison the user can make without opening the panel.
const fp = pluginFingerprint(...PLUGIN_FILES.map(([from]) => fs.readFileSync(path.join(SRC, 'plugin', from), 'utf8')));
console.log(`\nDeployed to ${DEST}\nfingerprint ${fp} — the settings panel should show this once ST restarts.\nRestart SillyTavern for the plugin to reload.`);
