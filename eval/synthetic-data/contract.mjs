// contract.mjs — what a rubric hash NAMES, and where to look it up.
//
// A verdict records `scene-relevance@f684ac34`. Without an archive that hash is a label: git has the text
// only if the file was committed, only if you know which file, and only if you know which commit — and a
// `--rubric` variant may never have been committed at all. So every pass writes the instruction block it
// sent, named by its own hash, and a hash resolves by reading a file.
//
// HASHED OVER WHAT IS SENT. The frontmatter is how Claude Code discovers an agent and is stripped before
// the model sees it, so it is not part of the contract: hashing it made an edit to a `description` line
// move both rubric hashes on 2026-08-21 while neither instruction block changed by a byte.
//
// CONTENT-ADDRESSED, SO WRITING IS IDEMPOTENT and the store is append-only in effect — a hash's content
// cannot change, so a second pass under the same contract writes nothing. Committed, unlike eval-data:
// these are the project's own prompts, and a bundle's rubric hash should resolve for anyone with the repo.
//
// Entries under the SUPERSEDED whole-file hashes are kept beside the body-hashed ones, holding the same
// text. A bundle records the hash that was current when it was graded, and the archive answers for the
// hash as recorded rather than for the one the current rule would produce.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = resolve(HERE, '..', 'contracts');

/** The instruction block a rubric file holds — its frontmatter removed, exactly as the prompt sends it. */
export const contractBody = raw => String(raw).replace(/^---[\s\S]*?\n---\n/, '');

/** A contract's identity: sha256 over the body, first 8. */
export const contractHash = body => createHash('sha256').update(body).digest('hex').slice(0, 8);

/**
 * Records an instruction block under its hash, so the hash can be read back as text.
 *
 * @param {string} body The block as sent
 * @param {string} [hash] Override, for recording under a hash produced by a superseded rule
 * @returns {{hash: string, path: string, written: boolean}}
 */
export function archiveContract(body, hash = contractHash(body)) {
    const path = `${CONTRACT_DIR}/${hash}.md`;
    if (existsSync(path)) return { hash, path, written: false };
    mkdirSync(CONTRACT_DIR, { recursive: true });
    writeFileSync(path, body);
    return { hash, path, written: true };
}

/** The instruction block a hash names, or null if this install has never seen it. */
export const readContract = hash => {
    const path = `${CONTRACT_DIR}/${hash}.md`;
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
};
