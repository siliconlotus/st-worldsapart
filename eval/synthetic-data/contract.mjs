// contract.mjs — what a rubric hash names: the instruction block as sent (frontmatter stripped), archived under its sha256[:8] in contracts/, which is committed so a bundle's hash resolves for anyone with the repo.
// Hashed over the body only — hashing the frontmatter moves the hash when a `description` line is edited (G9). Entries under superseded whole-file hashes are kept, since a bundle records the hash current when it was graded.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = resolve(HERE, '..', 'contracts');

/** The instruction block a rubric file holds — its frontmatter removed, exactly as the prompt sends it. */
export const contractBody = raw => String(raw).replace(/^---[\s\S]*?\n---\n/, '');

export const contractHash = body => createHash('sha256').update(body).digest('hex').slice(0, 8);

/** Records an instruction block under its hash, idempotently; `hash` overrides, for a hash produced by a superseded rule. */
export function archiveContract(body, hash = contractHash(body)) {
    const path = `${CONTRACT_DIR}/${hash}.md`;
    if (existsSync(path)) return { hash, path, written: false };
    mkdirSync(CONTRACT_DIR, { recursive: true });
    writeFileSync(path, body);
    return { hash, path, written: true };
}

export const readContract = hash => {
    const path = `${CONTRACT_DIR}/${hash}.md`;
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
};
