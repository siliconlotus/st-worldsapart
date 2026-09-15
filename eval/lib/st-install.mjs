// st-install.mjs — locates the SillyTavern install this checkout sits in, and resolves paths inside it. node:* only,
// so the deploy script and the fixtures can import it without pulling the harness in.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `{ root, dataRoot, resolve }` for the install, or null when none is reachable. Walks up for `config.yaml` rather
 * than counting directories, so a checkout at any depth — or a git worktree — finds it; `WA_ST_ROOT` overrides.
 * `resolve` reads `dataRoot:` out of config.yaml, so a `data/…` path follows a relocated data directory.
 */
export function stInstall() {
    let root = process.env.WA_ST_ROOT;
    if (!root) {
        for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) {
            if (existsSync(`${d}/config.yaml`)) { root = d; break; }
            if (dirname(d) === d) return null;
        }
    }
    const m = existsSync(`${root}/config.yaml`) && readFileSync(`${root}/config.yaml`, 'utf8').match(/^dataRoot:\s*['"]?(.+?)['"]?\s*$/m);
    const dataRoot = resolvePath(root, m ? m[1] : './data');
    const resolve = p => p.startsWith('/') ? p : p.startsWith('data/') ? dataRoot + p.slice('data'.length) : `${root}/${p}`;
    return { root, dataRoot, resolve };
}
