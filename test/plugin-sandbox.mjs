// plugin-sandbox.mjs — runs the real deploy-plugin.mjs into a throwaway root, so a check reads what a deploy writes.
// With an install, the root links its src/ and node_modules/ so the deployed index.js imports as ST would load it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../deploy-plugin.mjs', import.meta.url));

/** A root holding what `prepare(root)` puts there, then a deploy into it. `st` is stInstall(), needed only by `load`. */
export function deploySandbox({ st = null, prepare = () => {} } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-deploy-')));
    if (st) for (const d of ['src', 'node_modules']) fs.symlinkSync(path.join(st.root, d), path.join(root, d), 'dir');
    prepare(root);
    const run = spawnSync(process.execPath, [DEPLOY], { env: { ...process.env, WA_ST_ROOT: root }, encoding: 'utf8' });
    const dir = path.join(root, 'plugins', 'worlds-apart');
    const load = async () => {
        // util.js exits the process on the first config read with no path set, and something the server imports reads it at load.
        const util = await import(pathToFileURL(path.join(st.root, 'src/util.js')).href);
        util.setConfigFilePath(path.join(st.root, 'config.yaml'));
        return import(pathToFileURL(path.join(dir, 'index.js')).href);
    };
    return { root, dir, run, load, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
