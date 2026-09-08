// fingerprint.mjs — content fingerprint of the deployed server plugin, so a stale /plugins copy is detectable.

/** Every deployed plugin file as [source name, deployed name] — the single manifest: deploy-plugin.mjs copies these and both fingerprint sides hash them in this order. */
export const PLUGIN_FILES = [
    ['scoring.mjs', 'scoring.mjs'],
    ['automaton.mjs', 'automaton.mjs'],
    ['vector.mjs', 'vector.mjs'],
    ['commonwords.js', 'commonwords.js'],
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
