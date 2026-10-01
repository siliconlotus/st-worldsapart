// loader.js — deployed as <ST>/plugins/worlds-apart/index.js: imports plugin/server.js from the WorldsApart install named in
// source.json beside it, so updating the extension and restarting ST updates the plugin. node:* only; the one file a deploy copies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Must equal plugin/fingerprint.mjs LOADER_VERSION; bump both when this file changes. */
const LOADER_VERSION = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Walked, as eval/lib/st-install.mjs walks; two up, the deployed depth, when no config.yaml is reachable.
const ST_ROOT = (() => {
    for (let d = HERE; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, 'config.yaml'))) return d;
        if (path.dirname(d) === d) return path.resolve(HERE, '..', '..');
    }
})();

/** The install deploy-plugin.mjs ran from, written by it: relative to the ST root when inside it. */
const readSource = () => {
    try { return JSON.parse(fs.readFileSync(path.join(HERE, 'source.json'), 'utf8')).install ?? null; } catch { return null; }
};

/** `recorded`, or the shared install of the same folder name when `recorded` is gone: where ST's "move to global" puts a
 *  per-user copy. Never the other way: only an admin can write the shared folder. */
const resolveInstall = recorded => {
    if (!recorded || fs.existsSync(path.join(path.resolve(ST_ROOT, recorded), 'plugin', 'server.js'))) return recorded;
    const shared = path.join('public', 'scripts', 'extensions', 'third-party', path.basename(path.resolve(ST_ROOT, recorded)));
    if (!fs.existsSync(path.join(ST_ROOT, shared, 'plugin', 'server.js'))) return recorded;
    console.warn(`[WorldsApart] ${recorded} is gone; loading the shared install ${shared}. Run its deploy-plugin.mjs to record it.`);
    return shared;
};

let plugin = null;
const install = resolveInstall(readSource());
try {
    if (!install) throw new Error('no source.json beside the loader; run deploy-plugin.mjs from the WorldsApart install');
    const url = pathToFileURL(path.join(path.resolve(ST_ROOT, install), 'plugin', 'server.js'));
    // server.js reads these off its own URL: it is not in plugins/, so it cannot find ST by walking from itself.
    url.searchParams.set('stRoot', ST_ROOT);
    url.searchParams.set('install', install);
    url.searchParams.set('loader', String(LOADER_VERSION));
    plugin = await import(url.href);
} catch (error) {
    console.error(`[WorldsApart] the server plugin could not load WorldsApart from ${install ?? '(no install recorded)'}: ${error?.stack ?? error}`);
}

// Registers nothing on a failed load: the extension then reads the plugin as absent and offers the deploy command.
export const info = plugin?.info ?? { id: 'worlds-apart', name: 'WorldsApart', description: 'Failed to load; see the server log.' };
export const init = plugin?.init ?? (async () => {});
export const exit = plugin?.exit ?? (async () => {});
export const EMBED_SOURCES = plugin?.EMBED_SOURCES ?? [];
export default { info, init, exit };
