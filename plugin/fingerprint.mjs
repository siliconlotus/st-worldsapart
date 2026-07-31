// fingerprint.mjs — deploy tooling, not retrieval: a content fingerprint of the deployed server plugin
// so a stale /plugins copy is detectable without a hand-maintained version number. The plugin hashes
// its own deployed files and the extension hashes its source files, in the SAME fixed order; a mismatch
// means the copy drifted from source and needs a redeploy. Pure and isomorphic.

/** Every deployed plugin file as [source name in plugin/, deployed name], in fingerprint order.
 * The single manifest: deploy-plugin.mjs copies these, and both fingerprint sides hash them in THIS
 * order — adding or reordering a plugin file is one edit here, nowhere else. */
export const PLUGIN_FILES = [
    ['scoring.mjs', 'scoring.mjs'],
    ['automaton.mjs', 'automaton.mjs'],
    ['vector.mjs', 'vector.mjs'],
    ['lexical.mjs', 'lexical.mjs'],
    ['commonwords.js', 'commonwords.js'],
    ['fingerprint.mjs', 'fingerprint.mjs'],
    ['server.js', 'index.js'],
];

/** Non-cryptographic string hash (djb2, 32-bit). Only used to fingerprint files — not a security primitive. */
export function hashText(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Fingerprint of the deployed plugin: hash of every behavioural file's text, joined in a fixed order. */
export function pluginFingerprint(...fileTexts) {
    return hashText(fileTexts.join(' '));
}
