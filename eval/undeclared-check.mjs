// undeclared-check.mjs — names USED in a file but declared nowhere in it and not imported.
//
// The refactor-residue class, invisible to every other check here: a helper moves to another module and its
// module-scope `let` stays behind. Neither is a syntax error, so `node --check` passes, and the ST-coupled
// half cannot be imported under node at all — so the suite runs green while the shipped path throws
// ReferenceError on its first call.
//
// No scope analysis, deliberately: declarations are collected from the whole file regardless of scope, so
// shadowing is invisible. The failure hunted here is "declared NOWHERE", and over-approximating the declared
// set is what keeps this free of false alarms.
//
// acorn resolves out of SillyTavern's own node_modules; nothing is installed for this.
import { parse } from 'acorn';
import fs from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const GLOBALS = new Set(['globalThis','window','document','navigator','location','history','console','fetch','Headers','Request','Response','URL','URLSearchParams','Blob','File','FileReader','FormData','AbortController','WebSocket','Worker','crypto','performance','structuredClone','setTimeout','clearTimeout','setInterval','clearInterval','queueMicrotask','requestAnimationFrame','cancelAnimationFrame','localStorage','sessionStorage','IndexedDB','indexedDB','alert','confirm','prompt','getComputedStyle','MutationObserver','ResizeObserver','IntersectionObserver','CustomEvent','Event','Element','HTMLElement','Node','NodeList','DOMParser','XMLHttpRequest','TextEncoder','TextDecoder','Intl','Object','Array','String','Number','Boolean','Symbol','BigInt','Math','JSON','Date','RegExp','Error','TypeError','RangeError','SyntaxError','ReferenceError','EvalError','URIError','AggregateError','Map','Set','WeakMap','WeakSet','WeakRef','Promise','Proxy','Reflect','Function','ArrayBuffer','SharedArrayBuffer','DataView','Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','parseInt','parseFloat','isNaN','isFinite','encodeURI','encodeURIComponent','decodeURI','decodeURIComponent','escape','unescape','NaN','Infinity','undefined','eval','process','Buffer','__dirname','__filename','require','module','exports','global','TransformStream','ReadableStream','WritableStream','CompressionStream','DecompressionStream','$','jQuery','toastr','moment','SillyTavern','Handlebars','DOMPurify','showdown','Popper','localforage','Fuse','droll','pdfjsLib','Readability','isProbablyReaderable','hljs','Bowser','seedrandom','diff_match_patch','marked','katex','mermaid','Papa','JSZip','saveAs','html2canvas','ePub','yaml','lodash','_','ai','SVGElement','Image','Audio','AudioContext','MediaRecorder','speechSynthesis','SpeechSynthesisUtterance','ClipboardItem','Notification','BroadcastChannel','EventSource','Option','FontFace','CSS','matchMedia','scrollTo','scrollBy','open','close','postMessage','addEventListener','removeEventListener','dispatchEvent','btoa','atob','reportError','Atomics','WebAssembly','Iterator','AsyncFunction','GeneratorFunction','FinalizationRegistry','AbortSignal','innerWidth','innerHeight','outerWidth','outerHeight','screen','frames','parent','self','top','name','status','origin','isSecureContext','caches','clientInformation','devicePixelRatio','visualViewport','customElements','Text','Range','Selection','XPathResult','Storage','Headers']);

const declared = (node, out) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) declared(n, out); return; }
    switch (node.type) {
        case 'Identifier': out.add(node.name); return;
        case 'ObjectPattern': for (const p of node.properties) declared(p.type === 'Property' ? p.value : p.argument, out); return;
        case 'ArrayPattern': for (const e of node.elements) declared(e, out); return;
        case 'AssignmentPattern': declared(node.left, out); return;
        case 'RestElement': declared(node.argument, out); return;
        default: return;
    }
};

/** Every source file WA ships, from the repo root. `plugin/` is included and its deployed copy is not —
 *  that lives outside the repo. `node_modules` and the eval corpus hold no WA source, and `.claude`
 *  holds worktree CHECKOUTS — another branch's copy of this repo, whose defects are that branch's. */
const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', '.claude', 'eval-data', 'grade-jobs', 'data']);
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP.has(d.name)) return [];
    const full = join(dir, d.name);
    if (d.isDirectory()) return sources(full);
    return /\.(js|mjs)$/.test(d.name) ? [relative(ROOT, full)] : [];
});

// Bare run scans the whole repo; explicit paths are for narrowing while fixing one.
const files = process.argv.slice(2).length ? process.argv.slice(2) : sources(ROOT).sort();

let bad = 0;
for (const file of files) {
    const src = fs.readFileSync(join(ROOT, file), 'utf8');
    let ast;
    try { ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }); }
    catch (e) { console.log(`PARSE ${file}: ${e.message}`); continue; }

    const names = new Set();
    const used = new Map();   // name -> first line
    const walk = (node, parent) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const n of node) walk(n, parent); return; }
        if (!node.type) return;
        switch (node.type) {
            case 'ImportDeclaration': for (const s of node.specifiers) names.add(s.local.name); return;
            // `import.meta` and `new.target` are MetaProperty, whose halves are not identifiers in scope.
            case 'MetaProperty': return;
            case 'VariableDeclarator': declared(node.id, names); break;
            case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassDeclaration': case 'ClassExpression':
                if (node.id) names.add(node.id.name);
                for (const p of node.params ?? []) declared(p, names);
                break;
            case 'CatchClause': if (node.param) declared(node.param, names); break;
            case 'Identifier': {
                // Not a use: a property key, a member's property, a labelled statement.
                const skip = parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
                    || (parent.type === 'Property' && parent.key === node && !parent.computed)
                    || (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed)
                    || (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed)
                    || parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement'
                    || parent.type === 'ExportSpecifier' || parent.type === 'ImportSpecifier');
                if (!skip && !used.has(node.name)) used.set(node.name, node.loc?.start?.line ?? 0);
                return;
            }
        }
        for (const k of Object.keys(node)) { if (k === 'loc' || k === 'range') continue; walk(node[k], node); }
    };
    // Two passes: collect every declaration first, since a use can precede its declaration in the file.
    const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const n of node) collect(n); return; }
        if (node.type === 'ImportDeclaration') { for (const s of node.specifiers) names.add(s.local.name); return; }
        if (node.type === 'VariableDeclarator') declared(node.id, names);
        if (/Function|Class/.test(node.type ?? '')) { if (node.id) names.add(node.id.name); for (const p of node.params ?? []) declared(p, names); }
        if (node.type === 'CatchClause' && node.param) declared(node.param, names);
        for (const k of Object.keys(node)) { if (k === 'loc' || k === 'range') continue; collect(node[k]); }
    };
    collect(ast);
    walk(ast, null);

    const missing = [...used].filter(([n]) => !names.has(n) && !GLOBALS.has(n));
    for (const [n, line] of missing) { console.log(`FAIL ${file}:${line} — \`${n}\` is used but declared nowhere in the file and not imported`); bad++; }
}
console.log(bad ? `\n${bad} undeclared name(s)` : `ok   ${files.length} source files: every name used is declared or imported`);
process.exit(bad ? 1 : 0);
