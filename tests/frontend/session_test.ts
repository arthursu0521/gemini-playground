import { assertEquals, assertFalse } from '@std/assert';
import { SettingsStore } from '../../src/static/js/settings.js';
import { MultimodalLiveClient } from '../../src/static/js/core/websocket-client.js';
import { FakeWebSocket } from '../helpers/fake_websocket.ts';
Deno.test('legacy password is deleted and never persisted on settings save', () => {
    const data = new Map([['gemini_access_password', 'legacy-secret']]);
    const storage = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => data.set(k, v),
        removeItem: (k: string) => data.delete(k),
    } as unknown as Storage;
    const store = new SettingsStore({ local: () => storage, session: () => storage });
    const settings = store.load();
    assertEquals(data.get('gemini_access_password'), undefined);
    store.save({ ...settings, accessPassword: 'do-not-store' });
    assertFalse([...data.values()].includes('do-not-store'));
});
Deno.test('cookie-only reconnect never transmits or retains a legacy password argument', async () => {
    const sockets: FakeWebSocket[] = [];
    class Socket extends FakeWebSocket {
        constructor(url: string) {
            super(url);
            sockets.push(this);
        }
    }
    const client = new MultimodalLiveClient({
        WebSocketImpl: Socket as unknown as typeof WebSocket,
        reconnectDelayMs: 1,
    });
    const connected = client.connect({ model: 'test' }, { accessPassword: 'never-send' });
    sockets[0].open();
    sockets[0].receive('{"setupComplete":{}}');
    await connected;
    assertEquals(JSON.parse(String(sockets[0].sent[0])), { auth: {} });
    assertFalse(JSON.stringify(client.credentials).includes('never-send'));
    sockets[0].receive('{"goAway":{}}');
    await new Promise((r) => setTimeout(r, 5));
    sockets[1].open();
    sockets[1].receive('{"setupComplete":{}}');
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(JSON.parse(String(sockets[1].sent[0])), { auth: {} });
    client.disconnect();
});
