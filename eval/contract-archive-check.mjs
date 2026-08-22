// A rubric hash must resolve to the instructions it names. Without the archive it is a label: git holds
// the text only if the file was committed, only if you know which file and which commit — and a --rubric
// variant may never have been committed at all.
import { eq } from './metrics.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveContract, contractBody, contractHash, readContract, CONTRACT_DIR } from './synthetic-data/contract.mjs';

// THE FRONTMATTER IS NOT THE CONTRACT. Claude Code reads it to discover the agent and the prompt strips it,
// so the model never sees it — and hashing it moved BOTH rubric hashes on 2026-08-21 for an edit to a
// `description` line, while neither instruction block changed by a byte.
const withFm = d => `---\nname: r\ndescription: ${d}\n---\n\nYou are the judge.\nGrade 0-4.\n`;
eq(contractBody(withFm('one')).trim(), 'You are the judge.\nGrade 0-4.', 'the frontmatter is stripped, leaving what is sent');
eq(contractHash(contractBody(withFm('one'))), contractHash(contractBody(withFm('a completely different description'))),
    'a discovery-metadata edit does not move the contract');
eq(contractHash(contractBody(withFm('one'))) === contractHash(contractBody(withFm('one').replace('Grade 0-4', 'Grade 0-5'))), false,
    '...and an instruction edit does');

// The three hashes bundles on disk actually reference, and the variant the A/B ran under.
for (const [h, what] of [['b49449ef', 'the contract 66 rater rows name'], ['8460b922', 'the contract 53 rater rows name'],
    ['97e0aad5', 'the centrality variant grade-ab-v1 ran under']]) {
    const body = readContract(h);
    eq(typeof body === 'string' && body.length > 1000, true, `${h} resolves to ${what}`);
    eq(body.startsWith('---'), false, `...as an instruction block, not a file with frontmatter`);
}
// A superseded whole-file hash and the body hash of the same text are BOTH present, holding one block: a
// bundle records the hash current when it was graded, so the archive answers for the hash as recorded.
eq(readContract('8460b922') === readContract('f684ac34'), true, 'the old whole-file hash and the new body hash resolve to one block');
eq(contractHash(readContract('8460b922')), 'f684ac34', '...and that block hashes to the body hash under the current rule');

// Content-addressed, so writing is idempotent and a hash's content can never change.
{
    const before = readContract('f684ac34');
    const again = archiveContract(before, 'f684ac34');
    eq(again.written, false, 'a second pass under one contract writes nothing');
    eq(readContract('f684ac34') === before, true, '...and cannot alter what the hash already names');
}
eq(readContract('deadbeef'), null, 'a hash this install has never seen resolves to null, not a throw');
eq(existsSync(CONTRACT_DIR), true, 'the archive is a real directory, committed beside the code');
console.log('ok');
