import { assertEquals } from '@std/assert';
import { ensureSession } from '../../src/static/js/session-ui.js';
Deno.test('session probe shows login on expiry and allows UI after re-login', async () => {
    let loggedIn = false, prompts = 0;
    const fetcher = () => Promise.resolve(new Response('{}', { status: loggedIn ? 200 : 401 }));
    assertEquals(await ensureSession(true, () => prompts++, fetcher), false);
    assertEquals(prompts, 1);
    loggedIn = true;
    assertEquals(await ensureSession(true, () => prompts++, fetcher), true);
    assertEquals(prompts, 1);
    const broken = () => Promise.reject(new Error('offline'));
    assertEquals(await ensureSession(true, () => prompts++, broken), false);
    assertEquals(prompts, 2);
    assertEquals(await ensureSession(false, () => prompts++, broken), true);
});
