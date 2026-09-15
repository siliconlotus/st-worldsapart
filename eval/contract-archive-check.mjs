// A rubric hash must resolve to the instructions it names (synthetic-data/contract.mjs), independent of git.
import { eq } from './metrics.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveContract, contractBody, contractHash, readContract, CONTRACT_DIR } from './synthetic-data/contract.mjs';

// Hash what is sent: the frontmatter is stripped before the prompt (G9).
const withFm = d => `---\nname: r\ndescription: ${d}\n---\n\nYou are the judge.\nGrade 0-4.\n`;
eq(contractBody(withFm('one')).trim(), 'You are the judge.\nGrade 0-4.', 'the frontmatter is stripped, leaving what is sent');
eq(contractHash(contractBody(withFm('one'))), contractHash(contractBody(withFm('a completely different description'))),
    'a discovery-metadata edit does not move the contract');
eq(contractHash(contractBody(withFm('one'))) === contractHash(contractBody(withFm('one').replace('Grade 0-4', 'Grade 0-5'))), false,
    '...and an instruction edit does');

eq(readContract('deadbeef'), null, 'a hash this install has never seen resolves to null, not a throw');

// The round trip, which holds anywhere: archive a body, read it back under its hash, and re-archiving is a no-op.
{
    const body = 'You are the judge.\nGrade 0-4 on the anchored scale.\n';
    const h = contractHash(body);
    const first = archiveContract(body);
    eq(first.hash, h, 'archiving files a body under its own body hash');
    eq(readContract(h), body, '...and the hash reads that block back verbatim');
    eq(archiveContract(body).written, false, 'a second pass under one contract writes nothing');
    eq(readContract(h), body, '...and cannot alter what the hash already names');
    if (first.written) rmSync(first.path, { force: true });   // this check's own body, not a rubric any bundle names
}

// The archive is a LOCAL store (gitignored, as .gitignore says): these rubrics resolve only where the runs were graded.
if (!existsSync(CONTRACT_DIR)) {
    console.log('skip  no local contract archive — the recorded-rubric assertions need the machine that graded those runs');
} else {
    for (const [h, what] of [['b49449ef', 'the contract 66 rater rows name'], ['8460b922', 'the contract 53 rater rows name'],
        ['97e0aad5', 'the centrality variant grade-ab-v1 ran under']]) {
        const body = readContract(h);
        if (body === null) { console.log(`skip  ${h} is not in this install's archive (${what})`); continue; }
        eq(typeof body === 'string' && body.length > 1000, true, `${h} resolves to ${what}`);
        eq(body.startsWith('---'), false, '...as an instruction block, not a file with frontmatter');
    }
    if (readContract('8460b922') !== null && readContract('f684ac34') !== null) {
        eq(readContract('8460b922') === readContract('f684ac34'), true, 'the old whole-file hash and the new body hash resolve to one block');
        eq(contractHash(readContract('8460b922')), 'f684ac34', '...and that block hashes to the body hash under the current rule');
    }
}
console.log('ok');
