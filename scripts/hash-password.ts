/** Offline hash generator. Never prints a password or hash. Output file is exclusively created, mode 0600. */
import { hashPassword } from '../src/server/session.ts';
const [input, output] = Deno.args;
if (!input || !output) {
    throw new Error(
        'Usage: deno run --allow-read=<input> --allow-write=<output> scripts/hash-password.ts <password-file> <hash-output>',
    );
}
let password = await Deno.readTextFile(input);
// Permit a file created with a conventional single trailing newline, preserve all other characters.
password = password.replace(/\r?\n$/, '');
if (!password || password.length > 1024) throw new Error('Password must contain 1–1024 characters');
const hash = await hashPassword(password);
password = '';
const file = await Deno.open(output, { write: true, createNew: true, mode: 0o600 });
try {
    await file.write(new TextEncoder().encode(hash + '\n'));
} finally {
    file.close();
}
console.log('Argon2id hash written to protected output file.');
