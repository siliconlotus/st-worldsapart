// fingerprint.mjs — content fingerprint of the plugin's source as the server loaded it, so a stale server process is detectable.

/** Every file the server loads from the install, relative to plugin/: the browser and the server hash these, in this order. */
export const PLUGIN_FILES = [
    'scoring.mjs',
    '../extension/automaton.mjs',
    '../extension/smartkeys.mjs',
    '../extension/matcher.mjs',
    'vector.mjs',
    'fingerprint.mjs',
    'server.js',
];

/** plugin/loader.js's own LOADER_VERSION, which /ping reports: an older deployed loader asks for one redeploy. Keep the two equal. */
export const LOADER_VERSION = 2;

/** What a /ping answer says about the plugin, or null when the body is not the plugin's: a host that serves its page for any
 *  unknown path answers 200 with HTML. Each field is null where an older plugin does not send it. */
export function readPing(body) {
    if (body?.ok !== true) return null;
    return {
        root: body.root ?? null,
        fingerprint: body.fingerprint ?? null,
        loader: Number(body.loader) || null,
        install: body.install ?? null,
        dataRoot: body.dataRoot ?? null,
        shared: body.shared === true,
    };
}

function hashText(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function pluginFingerprint(...fileTexts) {
    return hashText(fileTexts.join(' '));
}
