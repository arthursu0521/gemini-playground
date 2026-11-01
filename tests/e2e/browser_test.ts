/**
 * End-to-end: headless Chrome (fake microphone + camera) -> real Deno server/relay -> mock Gemini.
 * Chrome is taken from CHROME_PATH, a standard install location, or downloaded by Astral.
 */
// deno-lint-ignore-file no-explicit-any
import { launch, type Page } from '@astral/astral';
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { hashPassword } from '../../src/server/session.ts';
import { decodeBase64 } from '@std/encoding/base64';
import { startAppServer } from '../helpers/app_server.ts';
import { type LiveConnection, startMockGemini } from '../helpers/mock_gemini.ts';

const CLIENT_KEY = 'AIzaTestKeyValid_0000000000000000000';
const SERVER_KEY = 'AIzaServerKeyValid_00000000000000000';
const PASSWORD = 'correct horse battery staple';

function findChrome(): string | undefined {
    const candidates = [
        Deno.env.get('CHROME_PATH'),
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const path of candidates) {
        if (!path) continue;
        try {
            if (Deno.statSync(path).isFile) return path;
        } catch { /* not here */ }
    }
    return undefined;
}

/** 24 kHz PCM16 sine, base64 - what Gemini streams back. */
function pcmTone(seconds: number, freq = 440): string {
    const n = Math.round(24000 * seconds);
    const view = new DataView(new ArrayBuffer(n * 2));
    for (let i = 0; i < n; i++) {
        view.setInt16(i * 2, Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / 24000)), true);
    }
    let binary = '';
    const bytes = new Uint8Array(view.buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/** Scripted Gemini: reacts to the text the browser sends. */
function geminiScript(conn: LiveConnection, message: Record<string, unknown>) {
    const turn = (message.clientContent as { turns?: { parts: { text: string }[] }[] } | undefined)?.turns?.[0];
    const text = turn?.parts?.[0]?.text;
    if (text === 'hello') {
        conn.send({
            serverContent: {
                modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmTone(0.4) } }] },
                outputTranscription: { text: 'Hi from ' },
            },
        });
        conn.send({ serverContent: { outputTranscription: { text: 'the mock' } } });
        conn.send({ serverContent: { generationComplete: true } });
        conn.send({ serverContent: { turnComplete: true } });
    } else if (text === 'weather') {
        conn.send({
            toolCall: {
                functionCalls: [{
                    id: 't1',
                    name: 'get_weather_on_date',
                    args: { location: 'Paris', date: '2026-10-17' },
                }],
            },
        });
    } else if (text === 'interrupt') {
        conn.send({
            serverContent: {
                modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmTone(3) } }] },
            },
        });
        setTimeout(() => conn.send({ serverContent: { interrupted: true } }), 300);
    } else if (text === 'goaway') {
        conn.send({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } });
        conn.send({ goAway: { timeLeft: '5s' } });
    } else if (text) {
        conn.send({ serverContent: { outputTranscription: { text: `echo: ${text}` }, turnComplete: true } });
    }
    if (message.toolResponse) {
        conn.send({ serverContent: { outputTranscription: { text: 'Tool result received' }, turnComplete: true } });
    }
}

const INIT_SCRIPT = `
    window.__cspViolations = [];
    window.__errors = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
    // Deterministic stand-in for the screen picker: an animated canvas stream.
    navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext('2d');
        let frame = 0;
        setInterval(() => { ctx.fillStyle = 'hsl(' + (frame++ * 37 % 360) + ',70%,50%)'; ctx.fillRect(0, 0, 1280, 720); }, 50);
        return canvas.captureStream(10);
    };
`;

async function openPage(origin: string, chromePath: string | undefined) {
    const browser = await launch({
        path: chromePath,
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--no-first-run',
            '--ignore-certificate-errors',
            '--no-default-browser-check',
            // GitHub's Ubuntu runners block Chrome's user-namespace sandbox (AppArmor).
            ...(Deno.build.os === 'linux' && Deno.env.get('CI') ? ['--no-sandbox'] : []),
        ],
    });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.addEventListener('console', (e) => {
        if (e.detail.type === 'error') consoleErrors.push(e.detail.text);
    });
    page.addEventListener('pageerror', (e) => consoleErrors.push(String(e.detail)));
    await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({ source: INIT_SCRIPT });
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).geminiPlayground));
    return { browser, page, consoleErrors };
}

// --- page helpers (run in the browser) ---------------------------------------------------------

const setValue = (page: Page, id: string, value: string) =>
    page.evaluate((i: string, v: string) => {
        const el = document.getElementById(i) as HTMLInputElement;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { args: [id, value] });

const click = (page: Page, id: string) =>
    page.evaluate((i: string) => (document.getElementById(i) as HTMLElement).click(), { args: [id] });

const text = (page: Page, selector: string) =>
    page.evaluate((s: string) => document.querySelector(s)?.textContent ?? '', { args: [selector] });

const logText = (page: Page) => text(page, '#logs-container');

/** Polls a predicate inside the page. */
async function waitInPage(page: Page, fn: (...args: any[]) => unknown, args: unknown[] = [], timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await page.evaluate(fn as any, { args: args as any })) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

async function waitForLog(page: Page, needle: string, timeout = 8000) {
    const found = await waitInPage(
        page,
        (n: string) => (document.getElementById('logs-container')?.textContent ?? '').includes(n),
        [needle],
        timeout,
    );
    if (!found) throw new Error(`log never contained "${needle}". Log:\n${await logText(page)}`);
}

async function sendMessage(page: Page, message: string) {
    await setValue(page, 'message-input', message);
    await click(page, 'send-button');
}

async function waitUntil<T>(fn: () => T | undefined | false, timeout = 8000, what = 'condition'): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const realtime = (conn: LiveConnection, kind: 'audio' | 'video') =>
    conn.messages
        .map((m) => (m.realtimeInput as Record<string, { data: string; mimeType: string }> | undefined)?.[kind])
        .filter((x): x is { data: string; mimeType: string } => Boolean(x));

const chromePath = findChrome();

Deno.test({
    name: 'e2e: full session in headless Chrome',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn(t) {
        const mock = startMockGemini({ validKeys: [CLIENT_KEY], onMessage: geminiScript });
        const app = startAppServer({ UPSTREAM_BASE_URL: mock.baseUrl });
        const { browser, page, consoleErrors } = await openPage(app.origin, chromePath);
        let conn!: LiveConnection;
        try {
            await t.step('page loads under a strict CSP with no errors and no third-party requests', async () => {
                const state = await page.evaluate(() => {
                    const w = globalThis as unknown as Record<string, string[]>;
                    return {
                        csp: w.__cspViolations,
                        errors: w.__errors,
                        icons: document.querySelectorAll('svg.icon').length,
                        external: performance.getEntriesByType('resource')
                            .map((e) => e.name).filter((u) => !u.startsWith(location.origin)),
                        passwordHidden: (document.getElementById('access-password') as HTMLInputElement).hidden,
                        status: document.getElementById('status')?.textContent,
                        voices: (document.getElementById('voice-select') as HTMLSelectElement).options.length,
                    };
                });
                assertEquals(state.csp, []);
                assertEquals(state.errors, []);
                assertEquals(state.external, []);
                assert(state.icons >= 6, `icons rendered: ${state.icons}`);
                assertEquals(state.passwordHidden, true, 'no server key configured');
                assertEquals(state.status, 'Disconnected');
                assertEquals(state.voices, 30);
            });

            await t.step('connect: key goes in the auth message, setup is complete and correct', async () => {
                await setValue(page, 'api-key', CLIENT_KEY);
                const next = mock.nextConnection();
                await click(page, 'connect-button');
                conn = await next;
                assertEquals(conn.key, CLIENT_KEY, 'relay used the key from the auth message');
                assertEquals(conn.url.search, `?key=${CLIENT_KEY}`);
                await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Connected');
                const setup = conn.messages[0].setup as Record<string, any>;
                assertEquals(setup.model, 'models/gemini-3.8-live');
                assertEquals(setup.generationConfig.responseModalities, ['AUDIO']);
                assertEquals(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
                assertEquals(setup.contextWindowCompression, { slidingWindow: {} });
                assertEquals(setup.sessionResumption, {});
                assertEquals(setup.inputAudioTranscription, {});
                assertEquals(setup.tools[0], { googleSearch: {} });
                assertEquals(setup.tools[1].functionDeclarations[0].name, 'get_weather_on_date');
                assert(!JSON.stringify(conn.messages).includes('"auth"'), 'auth envelope must not reach Gemini');
                assertEquals(
                    await page.evaluate(
                        () => [localStorage.getItem('gemini_api_key'), sessionStorage.getItem('gemini_api_key')],
                    ),
                    [null, CLIENT_KEY],
                    'key is only kept for the tab session by default',
                );
            });

            await t.step(
                'text turn: streamed transcript is shown and audio really plays through the worklet',
                async () => {
                    await page.evaluate(() => {
                        const app = (globalThis as any).geminiPlayground;
                        (globalThis as any).__player = [];
                        const port = app.player.node.port;
                        const original = port.onmessage;
                        port.onmessage = (e: MessageEvent) => {
                            if (e.data.type !== 'volume' || e.data.value > 0.01) {
                                (globalThis as any).__player.push(e.data.type);
                            }
                            original.call(port, e);
                        };
                    });
                    await sendMessage(page, 'hello');
                    await waitForLog(page, 'Hi from the mock');
                    assert(
                        await waitInPage(page, () => (globalThis as any).__player.includes('drained'), [], 5000),
                        'audio drained',
                    );
                    const events: string[] = await page.evaluate(() => (globalThis as any).__player);
                    assert(events.indexOf('playing') < events.indexOf('drained'));
                    assert(events.includes('volume'), 'output level was reported');
                    const entries = await page.evaluate(() =>
                        [...document.querySelectorAll('.log-entry.ai .text')].map((e) => e.textContent)
                    );
                    assertEquals(
                        entries.filter((e) => e === 'Hi from the mock').length,
                        1,
                        'fragments joined in one entry',
                    );
                },
            );

            await t.step('microphone: 100 ms chunks of 16 kHz PCM16, then audioStreamEnd', async () => {
                await click(page, 'mic-button');
                await waitForLog(page, 'Microphone on');
                const chunks = await waitUntil(
                    () => realtime(conn, 'audio').length >= 5 && realtime(conn, 'audio'),
                    8000,
                    'mic audio',
                );
                for (const chunk of chunks) {
                    assertEquals(chunk.mimeType, 'audio/pcm;rate=16000');
                    assertEquals(decodeBase64(chunk.data).byteLength, 3200);
                }
                // Chrome's fake microphone beeps about once per second: wait for a beep.
                const isLoud = (c: { data: string }) =>
                    new Int16Array(decodeBase64(c.data).buffer).some((s) => Math.abs(s) > 500);
                await waitUntil(() => realtime(conn, 'audio').some(isLoud), 5000, "the fake microphone's tone");
                assertEquals(
                    await page.evaluate(() => document.getElementById('mic-button')?.getAttribute('aria-pressed')),
                    'true',
                );
                await click(page, 'mic-button');
                await waitUntil(
                    () => conn.messages.some((m) => (m.realtimeInput as any)?.audioStreamEnd === true),
                    4000,
                    'audioStreamEnd',
                );
                await waitForLog(page, 'Microphone off');
            });

            await t.step('camera: JPEG frames reach Gemini; stopping releases the camera', async () => {
                const before = realtime(conn, 'video').length;
                await click(page, 'camera-button');
                await waitForLog(page, 'Camera on');
                const frames = await waitUntil(
                    () => realtime(conn, 'video').length > before && realtime(conn, 'video'),
                    8000,
                    'video',
                );
                const jpeg = decodeBase64(frames.at(-1)!.data);
                assertEquals(frames.at(-1)!.mimeType, 'image/jpeg');
                assertEquals([jpeg[0], jpeg[1]], [0xff, 0xd8], 'JPEG magic bytes');
                await click(page, 'camera-button');
                await waitForLog(page, 'Camera off');
                assertEquals(
                    await page.evaluate(() => (document.getElementById('preview') as HTMLVideoElement).srcObject),
                    null,
                );
            });

            await t.step('screen share: frames are scaled to <= 1024 px and sent; stop works', async () => {
                const before = realtime(conn, 'video').length;
                await click(page, 'screen-button');
                await waitForLog(page, 'Screen sharing on');
                const frames = await waitUntil(
                    () => realtime(conn, 'video').length > before && realtime(conn, 'video'),
                    8000,
                    'screen',
                );
                const jpeg = decodeBase64(frames.at(-1)!.data);
                // Read the JPEG SOF0 header for its dimensions.
                let width = 0;
                for (let i = 2; i < jpeg.length - 9; i++) {
                    if (jpeg[i] === 0xff && (jpeg[i + 1] === 0xc0 || jpeg[i + 1] === 0xc2)) {
                        width = (jpeg[i + 7] << 8) | jpeg[i + 8];
                        break;
                    }
                }
                assertEquals(width, 1024);
                await click(page, 'stop-screen');
                await waitForLog(page, 'Screen sharing off');
            });

            await t.step('tool call: executed in the browser, answered with the matching id', async () => {
                await sendMessage(page, 'weather');
                const response = await conn.waitFor((m) => 'toolResponse' in m);
                const fr = (response.toolResponse as any).functionResponses[0];
                assertEquals(fr.id, 't1');
                assertEquals(fr.name, 'get_weather_on_date');
                assertStringIncludes(fr.response.output.note, 'Demo data');
                await waitForLog(page, 'Using tool get_weather_on_date');
                await waitForLog(page, 'Tool result received');
            });

            await t.step('interruption clears queued audio immediately', async () => {
                await page.evaluate(() => ((globalThis as any).__player = []));
                await sendMessage(page, 'interrupt');
                assert(
                    await waitInPage(page, () => (globalThis as any).__player.includes('cleared'), [], 5000),
                    'audio cleared',
                );
                const events: string[] = await page.evaluate(() => (globalThis as any).__player);
                assert(events.includes('playing'));
                assert(!events.includes('drained'), 'the 3 s answer was cut short, not played out');
            });

            await t.step('goAway: the browser reconnects and resumes with the latest handle', async () => {
                const next = mock.nextConnection();
                await sendMessage(page, 'goaway');
                const resumed = await next;
                const setup = (await resumed.waitFor((m) => 'setup' in m)).setup as Record<string, any>;
                assertEquals(setup.sessionResumption, { handle: 'handle-1' });
                await waitForLog(page, 'Session resumed');
                assertEquals((await conn.closed).code, 1000, 'old connection closed after the swap');
                conn = resumed;
                await sendMessage(page, 'still here?');
                await waitForLog(page, 'echo: still here?');
            });

            await t.step('log panel keeps at most 500 entries', async () => {
                const size = await page.evaluate(() => {
                    const app = (globalThis as any).geminiPlayground;
                    for (let i = 0; i < 700; i++) app.log.add('system', `filler ${i}`);
                    return document.getElementById('logs-container')!.childElementCount;
                });
                assertEquals(size, 500);
            });

            await t.step('disconnect closes the upstream session and resets the UI', async () => {
                await click(page, 'connect-button');
                assertEquals((await conn.closed).code, 1000);
                await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Disconnected');
                assertEquals(
                    await page.evaluate(() => (document.getElementById('send-button') as HTMLButtonElement).disabled),
                    true,
                );
            });

            await t.step('an invalid key shows the reason from Gemini', async () => {
                await setValue(page, 'api-key', 'AIzaWrongKey_00000000000000000000');
                await click(page, 'connect-button');
                await waitForLog(page, 'API key not valid');
                assertEquals(await text(page, '#status'), 'Disconnected');
            });

            await t.step('no console errors except the expected failed-login message', async () => {
                const unexpected = consoleErrors.filter((e) => !e.includes('Connection failed'));
                assertEquals(unexpected, []);
                const w = await page.evaluate(() => (globalThis as any).__cspViolations);
                assertEquals(w, []);
                const logs = app.logs.join('\n');
                assert(!logs.includes(CLIENT_KEY), 'server logs never contain the key');
            });
        } finally {
            await browser.close();
            await app.close();
            await mock.close();
        }
    },
});

Deno.test({
    name: 'e2e: access password login uses the server-side key',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const mock = startMockGemini({ validKeys: [SERVER_KEY], onMessage: geminiScript });
        const kv = await Deno.openKv(':memory:');
        const tlsDir = await Deno.makeTempDir();
        const certPath = `${tlsDir}/cert.pem`, keyPath = `${tlsDir}/key.pem`;
        const generated = await new Deno.Command('openssl', {
            args: [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-keyout',
                keyPath,
                '-out',
                certPath,
                '-days',
                '1',
                '-subj',
                '/CN=localhost',
                '-addext',
                'subjectAltName=IP:127.0.0.1,DNS:localhost',
                '-addext',
                'basicConstraints=critical,CA:FALSE',
            ],
            stdout: 'null',
            stderr: 'piped',
        }).output();
        if (!generated.success) throw new Error('openssl test certificate generation failed');
        const app = startAppServer({
            UPSTREAM_BASE_URL: mock.baseUrl,
            GEMINI_API_KEY: SERVER_KEY,
            ACCESS_PASSWORD_HASH: await hashPassword(PASSWORD),
        }, {
            kv: () => Promise.resolve(kv),
            tls: { cert: await Deno.readTextFile(certPath), key: await Deno.readTextFile(keyPath) },
        });
        const { browser, page } = await openPage(app.origin, chromePath);
        try {
            await page.waitForFunction(() => !document.getElementById('login-panel')!.hidden);
            await setValue(page, 'login-password', PASSWORD);
            await page.evaluate(() => (document.getElementById('login-form') as HTMLFormElement).requestSubmit());
            await page.waitForFunction(() => document.getElementById('login-panel')!.hidden);
            assertEquals(
                await page.evaluate(() => (document.getElementById('login-password') as HTMLInputElement).value),
                '',
            );
            const next = mock.nextConnection();
            await click(page, 'connect-button');
            const conn = await next;
            assertEquals(conn.key, SERVER_KEY);
            await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Connected');
            await sendMessage(page, 'ping');
            await waitForLog(page, 'echo: ping');
            const stored = await page.evaluate(() =>
                JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })
            );
            assert(!stored.includes(PASSWORD), 'password is never written to localStorage');
            const logs = app.logs.join('\n');
            assert(!logs.includes(PASSWORD) && !logs.includes(SERVER_KEY), 'no secrets in server logs');
            // Simulate another instance logging out: idle session monitor must return UI to login.
            for await (const entry of kv.list({ prefix: ['session'] })) await kv.delete(entry.key);
            await new Promise((r) => setTimeout(r, 16000));
            await page.waitForFunction(() => !document.getElementById('login-panel')!.hidden);
            await setValue(page, 'login-password', PASSWORD);
            await page.evaluate(() => (document.getElementById('login-form') as HTMLFormElement).requestSubmit());
            await page.waitForFunction(() => document.getElementById('login-panel')!.hidden);
            const resumed = mock.nextConnection();
            await click(page, 'connect-button');
            await resumed;
            await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Connected');
            await click(page, 'logout-button');
            await page.waitForFunction(() => !document.getElementById('login-panel')!.hidden);
            const sessionStatus = await page.evaluate(async () => (await fetch('/auth/session')).status);
            assertEquals(sessionStatus, 401);
        } finally {
            await browser.close();
            await app.close();
            await mock.close();
            kv.close();
            await Deno.remove(tlsDir, { recursive: true });
        }
    },
});
