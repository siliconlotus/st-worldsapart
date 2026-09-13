// i18n-check.mjs — every user-facing string in the ST half is a translation key, and every locale file covers
// exactly those keys. `--dump` prints the key list instead, for drafting a locale.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SORT_LABELS, SORT_MENU, TIER_DEFS } from '../extension/sort.mjs';
import { FLAG_PRIORITY, SEVERE, MODERATE, MINOR } from '../extension/keyword-audit.mjs';
import { GRADE_ANCHORS } from '../extension/grading.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');

// The ST-coupled half: DOM, toasts and popups live here, so every prose literal must be tagged (the lint below).
const ST_HALF = ['worldsapart.js', 'extension/studio.mjs', 'extension/ui-widgets.mjs', 'extension/capture-ui.mjs', 'extension/keyword-tools.mjs'];
// Pure modules that take the tag as a parameter: their t`` literals are keys too, but they may bind `t` themselves.
const TAGGED_PURE = ['extension/keyword-audit.mjs', 'extension/matcher.mjs'];
// English constants translated at the display site with translate(); the check enumerates them so the locale covers them.
// 'ignored' is the Cleanup tab's one verdict-less bucket, named beside the flags.
const TABLE_KEYS = [
    ...Object.values(SORT_LABELS),
    ...SORT_MENU.flatMap(m => [m.label, ...(m.kids ?? []).map(([l]) => l)]),
    ...Object.values(TIER_DEFS).map(d => d.label),
    ...FLAG_PRIORITY, SEVERE, MODERATE, MINOR, 'ignored',
    ...GRADE_ANCHORS,
];

const fail = [];
const keys = new Map();   // key -> first `file:line`
const add = (k, where) => { if (!keys.has(k)) keys.set(k, where); };
const lineOf = (src, at) => src.slice(0, at).split('\n').length;

/** JS template escapes, as the engine reads them, so the key is what ST's `t` builds at runtime. */
const unescape = s => s.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (m, c) => {
    if (c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
    return { n: '\n', t: '\t' }[c] ?? c;
});
const entity = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&rsquo;/g, '’').replace(/&#39;/g, "'");

/** Every t`…` in `src` as ST keys: text with `${i}` for the i-th placeholder. A nested backtick inside a placeholder
 *  is refused, since the key it would build is not readable off the source. */
function tagged(src, file) {
    const re = /(?<![\w$.`])t`/g;
    let m;
    while ((m = re.exec(src))) {
        let i = m.index + 2, key = '', n = 0, ok = true;
        for (; i < src.length && src[i] !== '`'; i++) {
            if (src[i] === '\\') { key += src[i] + src[i + 1]; i++; continue; }
            if (src[i] === '$' && src[i + 1] === '{') {
                let d = 1; i += 2;
                for (; i < src.length && d; i++) { if (src[i] === '{') d++; else if (src[i] === '}') d--; else if (src[i] === '`') ok = false; }
                i--; key += `\${${n++}}`;
                continue;
            }
            key += src[i];
        }
        const where = `${file}:${lineOf(src, m.index)}`;
        if (!ok) { fail.push(`${where}: a t\`\` placeholder holds a nested template; hoist it into a variable`); continue; }
        add(unescape(key), where);
        re.lastIndex = i + 1;
    }
}

function attributes(src, file) {
    for (const m of src.matchAll(/data-i18n="([^"]*)"/g)) {
        // Entities decode before the split, as the browser decodes the attribute before ST splits it on ';'.
        for (const part of entity(m[1]).split(';')) {
            const k = part.replace(/^\[(\w+)\]/, '');
            if (!k) fail.push(`${file}:${lineOf(src, m.index)}: empty data-i18n key`);
            add(k, `${file}:${lineOf(src, m.index)}`);
        }
    }
    for (const m of src.matchAll(/translate\('((?:[^'\\]|\\.)*)'\)/g)) add(unescape(m[1]), `${file}:${lineOf(src, m.index)}`);
}

/** Prose literals at the DOM, toast and popup sites that bypassed the tag. Heuristic by construction; a hit names its line. */
function lint(src, file) {
    const lines = src.split('\n');
    lines.forEach((l, i) => {
        const where = `${file}:${i + 1}`;
        const code = l.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\*)/.test(l)) return;
        if (/\b(const|let|var) t\b|\bt =>|\(t\)|\(t,/.test(code)) fail.push(`${where}: a binding named t shadows the i18n tag`);
        if (/\b(textContent|innerText|\.title|\.placeholder)\s*=\s*['"][A-Za-z]/.test(code)) fail.push(`${where}: untagged literal at a DOM text site`);
        if (/toastr\.\w+\(\s*['"`][A-Za-z]/.test(code)) fail.push(`${where}: untagged toast text`);
        if (/\b(okButton|cancelButton|label|tooltip|subtitle|resetTitle)\s*:\s*['"`][A-Za-z][a-z]/.test(code)) fail.push(`${where}: untagged caption`);
        if (/Popup\.show\.\w+\(\s*['"`][A-Za-z]/.test(code)) fail.push(`${where}: untagged popup text`);
        if (/\btitle="[A-Za-z]/.test(code) && !/data-i18n="[^"]*\[title\]/.test(code)) fail.push(`${where}: an HTML title attribute without a [title] data-i18n key`);
        if (/\bplaceholder="([A-Za-z][^"]*)"/.test(code) && !/data-i18n="[^"]*\[placeholder\]/.test(code)) {
            const v = code.match(/\bplaceholder="([^"]*)"/)[1];
            if (!/^[a-z_]+(, [a-z_]+)*$/.test(v)) fail.push(`${where}: an HTML placeholder without a [placeholder] data-i18n key`);
        }
        if (/<(label|option|b|span|small|div|h3|th|summary|button|td|p)\b[^>]*>[A-Za-z][^<]*[a-z][^<]*<\//.test(code) && !/data-i18n=/.test(code)) fail.push(`${where}: HTML text without data-i18n`);
    });
    // The multi-line toast: a template opening on the line after `toastr.x(`.
    for (const m of src.matchAll(/toastr\.\w+\(\s*\n\s*['"`][A-Za-z]/g)) fail.push(`${file}:${lineOf(src, m.index)}: untagged toast text`);
}

for (const f of ST_HALF) { const src = read(f); tagged(src, f); attributes(src, f); lint(src, f); }
for (const f of TAGGED_PURE) tagged(read(f), f);
for (const k of TABLE_KEYS) add(k, 'table');
// ST splits a data-i18n value on ';', so a key holding one is cut in two; here ';' only ever joins a text key to an
// `[attr]` key, so every ';' in the decoded value must be followed by '['. A t`` key may hold ';' freely.
for (const f of ST_HALF) for (const m of read(f).matchAll(/data-i18n="([^"]*)"/g)) if (/;(?!\[)/.test(entity(m[1]))) fail.push(`${f}: a data-i18n key holds ';': ${m[1].slice(0, 60)}`);

if (process.argv.includes('--dump')) {
    for (const k of [...keys.keys()].sort()) console.log(JSON.stringify(k));
    process.exit(0);
}

const placeholders = s => [...s.matchAll(/\$\{(\d+)\}/g)].map(m => m[1]).sort().join(',');
for (const f of readdirSync(join(ROOT, 'i18n')).filter(x => x.endsWith('.json'))) {
    const locale = JSON.parse(read(`i18n/${f}`));
    const manifest = JSON.parse(read('manifest.json'));
    if (!Object.values(manifest.i18n ?? {}).includes(`i18n/${f}`)) fail.push(`manifest.json does not declare i18n/${f}`);
    for (const k of keys.keys()) if (!Object.hasOwn(locale, k)) fail.push(`i18n/${f}: missing ${JSON.stringify(k)} (${keys.get(k)})`);
    for (const [k, v] of Object.entries(locale)) {
        if (!keys.has(k)) fail.push(`i18n/${f}: stale key ${JSON.stringify(k)}`);
        else if (typeof v !== 'string' || !v.trim()) fail.push(`i18n/${f}: empty translation for ${JSON.stringify(k)}`);
        else if (placeholders(v) !== placeholders(k)) fail.push(`i18n/${f}: placeholders differ for ${JSON.stringify(k)}`);
    }
}

if (fail.length) { for (const x of fail) console.log('FAIL', x); process.exit(1); }
console.log(`i18n-check: ok, ${keys.size} keys`);
