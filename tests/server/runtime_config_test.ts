import { assertEquals } from '@std/assert';

// Deploy runs the entrypoint directly, not `deno task start`; task-only flags do not apply.
Deno.test('deployment config enables KV without relying on local task flags', async () => {
    const config = JSON.parse(await Deno.readTextFile(new URL('../../deno.json', import.meta.url)));
    assertEquals(config.unstable?.includes('kv'), true);
});
