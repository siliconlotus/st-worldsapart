// claims-check.mjs — the published claim register's citations: every path exists and every symbol it names is still
// there. A citation is `path symbol, symbol` for code and `path § Heading § Heading` for prose. Self-checking.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from '../eval/lib/metrics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(ROOT, 'docs/measured-claims.md'), 'utf8');

// The path, then the rest of the span: symbols for code, headings for prose. No backtick may appear inside.
const CITE = /`([\w./-]+\.(?:mjs|js|md|json))([^`\n]*)`/g;
const cites = [...doc.matchAll(CITE)].map(m => ({ path: m[1], rest: m[2].trim(), raw: m[0] }));

eq(cites.length > 150, true, 'the register is being read, not matched as an empty list');

// A line number is not a citation: it rots on every edit and nothing can check it.
const numbered = cites.filter(c => /^:?\d/.test(c.rest) || /:\d/.test(c.path));
eq(numbered.map(c => c.raw).join('\n'), '', 'no citation names a line number');

const missing = cites.filter(c => !existsSync(join(ROOT, c.path)));
eq(missing.map(c => c.path).join('\n'), '', 'every cited path exists');

// An exported top-level declaration, which is what `grep` finds; a local would not be citable.
const exportsOf = src => new Set([...src.matchAll(/^export\s+(?:async\s+)?(?:function\s+(\w+)|(?:const|let|class)\s+(\w+))/gm)]
    .map(m => m[1] ?? m[2]));
const headingsOf = src => new Set([...src.matchAll(/^#{1,6}\s+(.*)$/gm)].map(m => m[1].trim().replace(/`/g, '')));

const unknown = [];
for (const c of cites) {
    if (!c.rest) continue;   // file-only: the claim cites the file, not a place in it
    const src = readFileSync(join(ROOT, c.path), 'utf8');
    const isDoc = c.path.endsWith('.md');
    const known = isDoc ? headingsOf(src) : exportsOf(src);
    for (const name of c.rest.split(isDoc ? '§' : ',').map(x => x.trim()).filter(Boolean)) {
        if (!known.has(name)) unknown.push(`${c.path} -> ${name}`);
    }
}
eq(unknown.join('\n'), '', 'every cited symbol is an exported declaration, or a heading in the cited document');
