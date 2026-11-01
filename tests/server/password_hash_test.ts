import { assert, assertEquals, assertFalse } from '@std/assert';
import { hashPassword, SessionAuth } from '../../src/server/session.ts';
import { loadConfig } from '../../src/server/config.ts';

Deno.test('encoded Argon2id hash authenticates 11 character migrated password without plaintext config', async () => {
    const hash = await hashPassword('elevenchars');
    assert(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'));
    const config = loadConfig((n) =>
        ({ ACCESS_PASSWORD_HASH: hash, AUTH_PASSWORD_VERSION: '2', GEMINI_API_KEY: 'test_server_key_000000000' })[n]
    );
    assertEquals(config.accessPassword, '');
    assert(config.serverKeyEnabled);
    const kv = await Deno.openKv(':memory:');
    try {
        const auth = new SessionAuth({ kv: () => Promise.resolve(kv), passwordHash: hash, passwordVersion: '2' });
        const token = await auth.login('elevenchars', 'one');
        assert(token);
        assert(await auth.validate(token));
        assertFalse(await auth.login('wrong', 'two'));
    } finally {
        kv.close();
    }
});
