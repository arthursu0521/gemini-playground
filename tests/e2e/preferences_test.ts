import { launch, type Page } from '@astral/astral';
import { assert, assertEquals } from '@std/assert';
import { startAppServer } from '../helpers/app_server.ts';

async function select(page: Page, id: string, value: string) {
    // Exercise the actual one-click controls, not synthetic select changes.
    for (let attempt = 0; attempt < 3; attempt++) {
        if (await page.evaluate((id) => document.getElementById(id)!.dataset.state, { args: [id] }) === value) return;
        await page.evaluate((id) => document.getElementById(id)!.click(), { args: [id] });
    }
    assertEquals(await page.evaluate((id) => document.getElementById(id)!.dataset.state, { args: [id] }), value);
}
Deno.test({
    name: 'preferences: Chinese default, bilingual controls, persistence and live system theme at 320px',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const app = startAppServer({});
        const browser = await launch({ path: Deno.env.get('CHROME_PATH'), args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const cdp = page.unsafelyGetCelestialBindings();
        try {
            await cdp.Emulation.setDeviceMetricsOverride({
                width: 320,
                height: 900,
                deviceScaleFactor: 1,
                mobile: true,
            });
            await cdp.Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
            await page.goto(app.origin);
            await page.waitForFunction(() =>
                Boolean(
                    (globalThis as unknown as {
                        geminiPlayground: {
                            client: { emit(name: string, data: unknown): void };
                            log: { stream(type: string, text: string): void; add(type: string, text: string): void };
                        };
                    }).geminiPlayground,
                )
            );
            assertEquals(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
            assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
            assertEquals(await page.evaluate(() => document.getElementById('connect-button')!.textContent), '连接');
            assertEquals(
                await page.evaluate(() => document.getElementById('ui-theme')!.dataset.state),
                'system',
            );
            for (const id of ['ui-language', 'ui-theme', 'login-ui-language', 'login-ui-theme']) {
                assertEquals(
                    await page.evaluate((id) => document.getElementById(id)!.tagName, { args: [id] }),
                    'BUTTON',
                );
                assert(
                    await page.evaluate((id) => Boolean(document.getElementById(id)!.getAttribute('aria-label')), {
                        args: [id],
                    }),
                );
            }
            await page.evaluate(() => document.getElementById('ui-language')!.click());
            assertEquals(await page.evaluate(() => document.documentElement.lang), 'en');
            assertEquals(
                await page.evaluate(() => document.getElementById('ui-language')!.getAttribute('aria-label')),
                'Interface language: English',
            );
            assertEquals(await page.evaluate(() => document.getElementById('connect-button')!.textContent), 'Connect');
            await select(page, 'ui-theme', 'light');
            assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
            await page.goto(app.origin);
            await page.waitForFunction(() =>
                Boolean(
                    (globalThis as unknown as {
                        geminiPlayground: {
                            client: { emit(name: string, data: unknown): void };
                            log: { stream(type: string, text: string): void; add(type: string, text: string): void };
                        };
                    }).geminiPlayground,
                )
            );
            assertEquals(await page.evaluate(() => document.documentElement.lang), 'en');
            assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
            await select(page, 'ui-theme', 'system');
            await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
            await cdp.Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'light' }] });
            await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
            for (const lang of ['zh-CN', 'en']) {
                await select(page, 'ui-language', lang);
                for (const theme of ['light', 'dark']) {
                    await select(page, 'ui-theme', theme);
                    assertEquals(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                    await page.evaluate(() => document.getElementById('config-toggle')!.click());
                    assert(
                        await page.evaluate(() => {
                            const p = document.querySelector('.config-wrapper')!;
                            return p.scrollWidth <= p.clientWidth;
                        }),
                    );
                    await page.evaluate(() => document.getElementById('close-config')!.click());
                    await page.evaluate(() => {
                        document.getElementById('app')!.hidden = true;
                        document.getElementById('login-panel')!.hidden = false;
                    });
                    assertEquals(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                    await select(page, 'login-ui-language', lang === 'en' ? 'zh-CN' : 'en');
                    assertEquals(
                        await page.evaluate(() => document.documentElement.lang),
                        lang === 'en' ? 'zh-CN' : 'en',
                    );
                    await select(page, 'login-ui-language', lang);
                    await page.evaluate(() => {
                        document.getElementById('app')!.hidden = false;
                        document.getElementById('login-panel')!.hidden = true;
                    });
                }
            }
        } finally {
            await browser.close();
            await app.close();
        }
    },
});

Deno.test({
    name: 'preferences: login distinguishes unavailable service from wrong password in both languages',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const app = startAppServer({ ACCESS_PASSWORD: 'test-password' });
        const browser = await launch({ path: Deno.env.get('CHROME_PATH'), args: ['--no-sandbox'] });
        const page = await browser.newPage();
        try {
            await page.goto(app.origin);
            await page.waitForFunction(() =>
                Boolean(
                    (globalThis as unknown as {
                        geminiPlayground: {
                            client: { emit(name: string, data: unknown): void };
                            log: { stream(type: string, text: string): void; add(type: string, text: string): void };
                        };
                    }).geminiPlayground,
                )
            );
            for (const lang of ['zh-CN', 'en']) {
                await select(page, 'login-ui-language', lang);
                for (const status of [401, 503, 429]) {
                    await page.evaluate((status) => {
                        const original = globalThis.fetch;
                        globalThis.fetch = ((url, init) =>
                            String(url).endsWith('/auth/login')
                                ? Promise.resolve(new Response('{}', { status }))
                                : original(url, init)) as typeof fetch;
                        (document.getElementById('login-password') as HTMLInputElement).value = 'incorrect';
                        (document.getElementById('login-form') as HTMLFormElement).requestSubmit();
                    }, { args: [status] });
                    const expected = lang === 'en'
                        ? ({
                            401: 'Wrong password. Please try again.',
                            503: 'Service unavailable. Please try again later.',
                            429: 'Too many attempts. Wait a minute.',
                        })[status]
                        : ({
                            401: '密码错误，请重试。',
                            503: '服务暂不可用，请稍后重试。',
                            429: '尝试次数过多，请稍后再试。',
                        })[status];
                    await page.waitForFunction(
                        (expected) => document.getElementById('login-error')!.textContent === expected,
                        { args: [expected] },
                    );
                }
            }
        } finally {
            await browser.close();
            await app.close();
        }
    },
});

Deno.test({
    name: 'preferences: dynamic UI relocalizes without translating transcripts or protocol payloads',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const app = startAppServer({});
        const browser = await launch({ path: Deno.env.get('CHROME_PATH'), args: ['--no-sandbox'] });
        const page = await browser.newPage();
        try {
            await page.goto(app.origin);
            await page.waitForFunction(() =>
                Boolean(
                    (globalThis as unknown as {
                        geminiPlayground: {
                            client: { emit(name: string, data: unknown): void };
                            log: { stream(type: string, text: string): void; add(type: string, text: string): void };
                        };
                    }).geminiPlayground,
                )
            );
            await page.evaluate(() => {
                const app = (globalThis as unknown as {
                    geminiPlayground: {
                        client: { emit(name: string, data: unknown): void };
                        log: { stream(type: string, text: string): void; add(type: string, text: string): void };
                    };
                }).geminiPlayground;
                app.client.emit('reconnecting', { attempt: 2, resumable: true });
                app.log.stream('user', 'System Connect Error');
                app.log.stream('ai', 'System Connect Error');
                app.client.emit('log', { type: 'client.text', message: 'System Connect Error' });
                app.log.add('error', 'Audio recording is not supported in this browser');
            });
            assertEquals(
                await page.evaluate(() => document.querySelector('.log-entry.debug .text')!.textContent),
                'client.text: System Connect Error',
            );
            assertEquals(
                await page.evaluate(() => document.querySelector('.log-entry.error .text')!.textContent),
                '此浏览器不支持录音',
            );
            assertEquals(await page.evaluate(() => document.getElementById('status')!.textContent), '正在重新连接…');
            for (const lang of ['en', 'zh-CN']) {
                await select(page, 'ui-language', lang);
                assertEquals(
                    await page.evaluate(() =>
                        [...document.querySelectorAll('.log-entry.user .text,.log-entry.ai .text')].map((e) =>
                            e.textContent
                        )
                    ),
                    ['System Connect Error', 'System Connect Error'],
                );
            }
        } finally {
            await browser.close();
            await app.close();
        }
    },
});

Deno.test({
    name: 'preferences: blocked storage never prevents boot or switching',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const app = startAppServer({});
        const browser = await launch({ path: Deno.env.get('CHROME_PATH'), args: ['--no-sandbox'] });
        const page = await browser.newPage();
        try {
            await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
                source:
                    "Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')}});",
            });
            await page.goto(app.origin);
            await page.waitForFunction(() =>
                Boolean(
                    (globalThis as unknown as {
                        geminiPlayground: {
                            client: { emit(name: string, data: unknown): void };
                            log: { stream(type: string, text: string): void; add(type: string, text: string): void };
                        };
                    }).geminiPlayground,
                )
            );
            assertEquals(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
            await select(page, 'ui-language', 'en');
            await select(page, 'ui-theme', 'dark');
            assertEquals(await page.evaluate(() => document.documentElement.lang), 'en');
            assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
        } finally {
            await browser.close();
            await app.close();
        }
    },
});

Deno.test({
    name: 'preferences: invalid saved values fall back to Chinese and system',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const app = startAppServer({});
        const browser = await launch({ path: Deno.env.get('CHROME_PATH'), args: ['--no-sandbox'] });
        const page = await browser.newPage();
        try {
            await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
                source:
                    "localStorage.setItem('gemini_ui_language','invalid');localStorage.setItem('gemini_ui_theme','invalid');",
            });
            await page.goto(app.origin);
            await page.waitForFunction(() =>
                Boolean(document.getElementById('connect-button')?.textContent === '连接')
            );
            assertEquals(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
            assertEquals(
                await page.evaluate(() => document.getElementById('ui-theme')!.dataset.state),
                'system',
            );
            assertEquals(
                await page.evaluate(() => document.getElementById('logs-container')?.dataset.emptyTitle),
                '对话从这里开始',
            );
            await select(page, 'ui-language', 'en');
            assertEquals(
                await page.evaluate(() => document.getElementById('logs-container')?.dataset.emptyTitle),
                'A conversation starts here',
            );
            assertEquals(
                await page.evaluate(() => document.getElementById('logs-container')?.dataset.emptyHint),
                'Connect, then speak, type, or share your view.',
            );
        } finally {
            await browser.close();
            await app.close();
        }
    },
});
