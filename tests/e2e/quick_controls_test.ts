import { launch, type Page } from '@astral/astral';
import { assert, assertEquals } from '@std/assert';
import { startAppServer } from '../helpers/app_server.ts';

async function checkLanguage(page: Page, prefix: string) {
    for (const language of ['zh-CN', 'en']) {
        const brand = language === 'en' ? 'CTS AI Pal' : 'CTS好伴';
        assertEquals(
            await page.evaluate(() => [
                document.title,
                document.querySelector('#login-panel .eyebrow')!.textContent,
                document.querySelector('.workspace-label')!.textContent,
                document.querySelector('#app h1')!.textContent,
            ]),
            [brand, brand, brand, brand],
            'login, workspace and browser title use the localized CTS brand',
        );
        if (prefix === 'login-') {
            assert(
                await page.evaluate(() => {
                    const brand = document.querySelector('#login-panel .eyebrow')!.getBoundingClientRect();
                    const buttons = document.querySelector('#login-panel .ui-preferences')!.getBoundingClientRect();
                    return brand.right + 8 <= buttons.left &&
                        Math.abs((brand.top + brand.bottom) - (buttons.top + buttons.bottom)) < 2 &&
                        document.documentElement.scrollWidth <= innerWidth;
                }),
                'both languages keep the login title and switches aligned without overlap',
            );
        }
        const label = language === 'en' ? 'Interface language: English' : '界面语言: 简体中文';
        assertEquals(
            await page.evaluate((prefix) => {
                const button = document.getElementById(`${prefix}ui-language`)!;
                return [button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')];
            }, { args: [prefix] }),
            [language === 'en' ? 'EN' : '中', label, label],
        );
        await page.evaluate((prefix) => document.getElementById(`${prefix}ui-language`)!.click(), {
            args: [prefix],
        });
    }
}

async function checkTheme(page: Page, prefix: string) {
    for (const language of ['zh-CN', 'en']) {
        for (const [index, state] of ['system', 'light', 'dark', 'system'].entries()) {
            if (index > 0) {
                await page.evaluate((prefix) => document.getElementById(`${prefix}ui-theme`)!.click(), {
                    args: [prefix],
                });
            }
            const stateName = language === 'en'
                ? ({ system: 'Follow system', light: 'Light', dark: 'Dark' })[state]
                : ({ system: '跟随系统', light: '浅色', dark: '深色' })[state];
            const label = `${language === 'en' ? 'Appearance' : '外观'}: ${stateName}`;
            const result = await page.evaluate((prefix) => {
                const button = document.getElementById(`${prefix}ui-theme`)!;
                const svg = button.querySelector('svg');
                return {
                    state: button.dataset.state,
                    text: button.textContent,
                    label: button.getAttribute('aria-label'),
                    title: button.getAttribute('title'),
                    hidden: svg?.getAttribute('aria-hidden'),
                    shape: svg?.firstElementChild?.tagName,
                    count: button.querySelectorAll('svg').length,
                };
            }, { args: [prefix] });
            assertEquals(result, {
                state,
                text: '',
                label,
                title: label,
                hidden: 'true',
                shape: ({ system: 'rect', light: 'circle', dark: 'path' })[state],
                count: 1,
            });
        }
        await page.evaluate((prefix) => document.getElementById(`${prefix}ui-language`)!.click(), {
            args: [prefix],
        });
    }
}

async function checkCorner(page: Page, prefix: string) {
    const result = await page.evaluate((prefix) => {
        const language = document.getElementById(`${prefix}ui-language`)!;
        const theme = document.getElementById(`${prefix}ui-theme`)!;
        const container = document.getElementById(prefix ? 'login-panel' : 'app')!;
        const l = language.getBoundingClientRect();
        const t = theme.getBoundingClientRect();
        const c = container.getBoundingClientRect();
        return {
            fits: document.documentElement.scrollWidth <= innerWidth,
            corner: l.top < c.top + 60 && t.right > c.right - 40,
            touch: [l, t].every((r) => r.width >= 44 && r.height >= 44),
        };
    }, { args: [prefix] });
    assert(result.fits, 'no horizontal overflow');
    assert(result.corner, 'quick controls belong in the upper-right corner');
    assert(result.touch, 'quick controls retain 44px touch targets');
}

Deno.test({
    name: 'quick controls: upper-right buttons and input → Send → microphone stay aligned at 320px and desktop',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const app = startAppServer({ ACCESS_PASSWORD: 'test-password' });
        const workspace = startAppServer({});
        const browser = await launch({ path: Deno.env.get('CHROME_PATH'), args: ['--no-sandbox'] });
        const page = await browser.newPage();
        try {
            for (const width of [320, 375, 390, 639, 640, 768, 1280]) {
                await page.unsafelyGetCelestialBindings().Emulation.setDeviceMetricsOverride({
                    width,
                    height: 1000,
                    deviceScaleFactor: 1,
                    mobile: width === 320,
                });
                await page.goto(app.origin);
                await page.waitForFunction(() => document.getElementById('login-panel')!.hidden === false);
                await checkCorner(page, 'login-');
                await checkLanguage(page, 'login-');
                await checkTheme(page, 'login-');
                await Deno.writeFile(`/tmp/gemini-quick-controls-login-${width}.png`, await page.screenshot());
                // Login/session security is covered by the existing HTTPS auth suite.
                await page.goto(workspace.origin);
                await page.waitForFunction(() => document.getElementById('app')!.hidden === false);
                await checkCorner(page, '');
                await checkLanguage(page, '');
                await checkTheme(page, '');
                assertEquals(
                    await page.evaluate(() => {
                        const boxes = ['message-input', 'send-button', 'mic-button'].map((id) =>
                            document.getElementById(id)!.getBoundingClientRect()
                        );
                        return boxes.every((r) => r.height >= 44) &&
                            boxes.every((r) => Math.abs(r.top - boxes[0].top) < 1) &&
                            boxes[0].right <= boxes[1].left && boxes[1].right <= boxes[2].left &&
                            boxes.slice(1).every((r) => r.width >= 44);
                    }),
                    true,
                    'input, Send and microphone share a row in that visual order',
                );
                if (width < 640) {
                    for (const language of ['zh-CN', 'en']) {
                        assertEquals(
                            await page.evaluate(() => {
                                const [send, mic, camera, screen] = [
                                    'send-button',
                                    'mic-button',
                                    'camera-button',
                                    'screen-button',
                                ].map((id) => document.getElementById(id)!.getBoundingClientRect());
                                const near = (a: number, b: number) => Math.abs(a - b) < 1;
                                return near(send.left, camera.left) && near(mic.left, screen.left) &&
                                    near(camera.top, screen.top) && near(send.top, mic.top) &&
                                    camera.top >= send.bottom && camera.right <= screen.left &&
                                    [send, mic, camera, screen].every((r) =>
                                        r.width >= 44 && r.height >= 44 && near(r.width, r.height)
                                    ) && near(screen.right - camera.left, screen.bottom - mic.top) &&
                                    document.documentElement.scrollWidth <= innerWidth;
                            }),
                            true,
                            `${width}px ${language}: Send/mic above camera/screen form a square`,
                        );
                        await page.evaluate(() => document.getElementById('ui-language')!.click());
                    }
                }
                for (const state of ['light', 'dark', 'system']) {
                    await page.evaluate(() => document.getElementById('ui-theme')!.click());
                    assertEquals(await page.evaluate(() => document.getElementById('ui-theme')!.dataset.state), state);
                    assertEquals(
                        await page.evaluate(() => document.getElementById('ui-theme')!.getAttribute('aria-label')),
                        `外观: ${{ light: '浅色', dark: '深色', system: '跟随系统' }[state]}`,
                    );
                    assertEquals(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                }
                await Deno.writeFile(`/tmp/gemini-quick-controls-workspace-${width}.png`, await page.screenshot());
            }
        } finally {
            await browser.close();
            await app.close();
            await workspace.close();
        }
    },
});
