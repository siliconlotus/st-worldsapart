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
export const LOADER_VERSION = 1;

function hashText(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function pluginFingerprint(...fileTexts) {
    return hashText(fileTexts.join(' '));
}
