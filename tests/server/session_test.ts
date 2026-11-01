import { assert, assertEquals, assertFalse } from '@std/assert';
import { SESSION_MS, SessionAuth, tokenDigest } from '../../src/server/session.ts';

Deno.test('session token is random 256-bit, only verifier is stored, shared across instances and expires fixed at eight hours', async () => {
    const kv = await Deno.openKv(':memory:');
    let now = 1000;
    try {
        const a = new SessionAuth({ kv: () => Promise.resolve(kv), password: 'correct horse battery', now: () => now });
        const b = new SessionAuth({ kv: () => Promise.resolve(kv), password: 'correct horse battery', now: () => now });
        const token = await a.login('correct horse battery', '127.0.0.1');
        assert(token);
        assertEquals(token.length, 64);
        assert(/^[0-9a-f]{64}$/.test(token));
        const record = await kv.get(['session', await tokenDigest(token)]);
        assert(record.value);
        assertFalse(JSON.stringify(record.value).includes(token));
        assert(await b.validate(token));
        now += SESSION_MS - 1;
        assert(await b.validate(token));
        now++;
        assertFalse(await b.validate(token));
    } finally {
        kv.close();
    }
});

Deno.test('atomic shared IP throttle limits concurrent attempts, logout and password rotation revoke across instances, KV fails closed', async () => {
    const kv = await Deno.openKv(':memory:');
    const opts = { kv: () => Promise.resolve(kv), password: 'correct horse battery' };
    const a = new SessionAuth(opts), b = new SessionAuth(opts);
    try {
        const attempts = await Promise.all(
            Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).login('wrong', 'same').catch(() => 'throttled')),
        );
        assertEquals(attempts.filter((v) => v === null).length, 5);
        assertEquals(attempts.filter((v) => v === 'throttled').length, 7);
        const token = await a.login(opts.password, 'other');
        assert(token);
        await b.revoke(token);
        assertFalse(await a.validate(token));
        const token2 = await a.login(opts.password, 'third');
        assert(token2);
        const sameHashRotation = new SessionAuth({ ...opts, passwordVersion: '2' });
        await sameHashRotation.publishVersion();
        assertFalse(await sameHashRotation.validate(token2));
        const rotated = new SessionAuth({ ...opts, password: 'new password version', passwordVersion: '3' });
        await rotated.publishVersion();
        assertFalse(await a.validate(token2));
    } finally {
        kv.close();
    }
    assertFalse(await a.validate('a'.repeat(64)));
});
