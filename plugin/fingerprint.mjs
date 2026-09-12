// fingerprint.mjs — content fingerprint of the deployed server plugin, so a stale /plugins copy is detectable.

/** Every deployed plugin file as [source path relative to plugin/, deployed name] — the single manifest: deploy-plugin.mjs copies these and both fingerprint sides hash them in this order. The matcher's three modules deploy FLAT, which is why they import each other by bare './name'. */
export const PLUGIN_FILES = [
    ['scoring.mjs', 'scoring.mjs'],
    ['../extension/automaton.mjs', 'automaton.mjs'],
    ['../extension/smartkeys.mjs', 'smartkeys.mjs'],
    ['../extension/matcher.mjs', 'matcher.mjs'],
    ['vector.mjs', 'vector.mjs'],
    ['fingerprint.mjs', 'fingerprint.mjs'],
    ['server.js', 'index.js'],
];

function hashText(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function pluginFingerprint(...fileTexts) {
    return hashText(fileTexts.join(' '));
}
