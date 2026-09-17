// st-half.mjs — which files may import SillyTavern. Test data, on the footing of genre-cases.mjs: st-boundary-check
// asserts the tree matches it, i18n-check lints the browser half's prose against it.

/** The ST half: worldsapart.js is the ST half proper; the rest inject ST's globals into the pure modules. */
export const ST_HALF = [
    'worldsapart.js',
    'st/studio.mjs',
    'st/ui-widgets.mjs',
    'st/capture-ui.mjs',
    'st/keyword-tools.mjs',
    'st/lang-store.mjs',
];

/** ST's SERVER half, a different coupling: server.js runs inside ST's node process and imports `../../src/`, which
 *  resolves from the DEPLOY location (/plugins/worlds-apart/), not from here — so it is not node-importable either.
 *  Apart from ST_HALF because i18n-check's tag lint is about what a user reads: server strings are not translated. */
export const ST_SERVER = ['plugin/server.js'];
