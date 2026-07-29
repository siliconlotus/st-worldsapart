// Deploys the server plugin from this repo (source of truth) into ST's /plugins/worlds-apart/.
// The plugin, scoring math, and common-word list all live in this repo so the extension and its
// server half travel as one unit; /plugins/worlds-apart/ is a generated COPY, never hand-edited.
//
// Run from this extension's folder after editing anything in plugin/ (server.js, the scoring math, etc.),
// then restart SillyTavern (the folder name doesn't matter — the script locates itself):
//   node deploy-plugin.mjs
//
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { PLUGIN_FILES } from './plugin/fingerprint.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.resolve(SRC, '../../../../../plugins/worlds-apart');

const PACKAGE_JSON = JSON.stringify({
    name: 'worlds-apart-plugin',
    version: '0.1.0',
    type: 'module',
    main: 'index.js',
    private: true,
}, null, 4) + '\n';

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

console.log(`\nDeployed to ${DEST}\nRestart SillyTavern for the plugin to reload.`);
