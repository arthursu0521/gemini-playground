import { launch, type Page } from '@astral/astral';
import { assert, assertEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { startAppServer } from '../helpers/app_server.ts';

const widths = [320, 375, 390, 768, 1440];
async function viewport(page: Page, width: number) {
    await page.unsafelyGetCelestialBindings().Emulation.setDeviceMetricsOverride({
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 640,
    });
}
async function screenshot(page: Page, name: string) {
    const dir = Deno.env.get('UI_SCREENSHOTS');
    if (!dir) return;
    await Deno.mkdir(dir, { recursive: true });
    const shot = await page.unsafelyGetCelestialBindings().Page.captureScreenshot({ format: 'png' });
    await Deno.writeFile(`${dir}/${name}.png`, decodeBase64(shot.data));
}

Deno.test({
    name: 'responsive UI: workspace, login, settings and media remain accessible at every breakpoint',
    sanitizeOps: false,
    sanitizeResources: false,
    async fn(t) {
        const app = startAppServer({});
        const browser = await launch({
            path: Deno.env.get('CHROME_PATH'),
            args: ['--no-sandbox'],
        });
        const page = await browser.newPage();
        try {
            await page.goto(app.origin);
            await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).geminiPlayground));
            await t.step('workspace and login provide clear headings and form descriptions', async () => {
                assertEquals(await page.evaluate(() => document.querySelector('#app h1')?.textContent), 'CTS好伴');
                assertEquals(
                    await page.evaluate(() =>
                        document.getElementById('login-password')?.getAttribute('aria-describedby')
                    ),
                    'login-description login-error',
                );
            });
            await t.step('settings manage focus, Escape, and background isolation', async () => {
                await viewport(page, 375);
                await page.evaluate(() => document.getElementById('config-toggle')!.click());
                assertEquals(
                    await page.evaluate(() => document.getElementById('config-container')?.getAttribute('aria-modal')),
                    'true',
                );
                assert(await page.evaluate(() => Boolean(document.activeElement?.closest('#config-container'))));
                assertEquals(
                    await page.evaluate(() => (document.getElementById('message-form') as HTMLElement).inert),
                    true,
                );
                await page.evaluate(() =>
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
                );
                assertEquals(await page.evaluate(() => document.activeElement?.id), 'config-toggle');
                assertEquals(
                    await page.evaluate(() => document.getElementById('config-toggle')?.getAttribute('aria-expanded')),
                    'false',
                );
            });
            await t.step('keyboard focus cycles inside settings and every form control is labeled', async () => {
                await page.evaluate(() => document.getElementById('config-toggle')!.click());
                await page.evaluate(() => {
                    document.getElementById('apply-config')!.focus();
                    document.dispatchEvent(
                        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
                    );
                });
                assertEquals(await page.evaluate(() => document.activeElement?.id), 'close-config');
                await page.evaluate(() =>
                    document.dispatchEvent(
                        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
                    )
                );
                assertEquals(await page.evaluate(() => document.activeElement?.id), 'apply-config');
                assertEquals(
                    await page.evaluate(() =>
                        [...document.querySelectorAll('input, select, textarea')].filter((node) => {
                            const el = node as HTMLInputElement;
                            return !el.hidden && !el.labels?.length && !el.getAttribute('aria-label');
                        }).map((el) => el.id)
                    ),
                    [],
                );
                await page.evaluate(() => document.getElementById('close-config')!.click());
            });
            for (const width of widths) {
                await t.step(`${width}px workspace has no overflow and comfortable controls`, async () => {
                    await viewport(page, width);
                    const result = await page.evaluate(() => ({
                        overflow: document.documentElement.scrollWidth > innerWidth,
                        small: [...document.querySelectorAll('button')].filter((el) => {
                            const r = el.getBoundingClientRect();
                            return r.width > 0 && (r.width < 44 || r.height < 44);
                        }).map((el) => el.id),
                    }));
                    assertEquals(result.overflow, false, 'page must not overflow horizontally');
                    assertEquals(result.small, [], 'all visible buttons must meet 44px touch targets');
                    await screenshot(page, `workspace-${width}`);
                    await page.evaluate(() => document.getElementById('config-toggle')!.click());
                    assert(
                        await page.evaluate(() => {
                            const panel = document.querySelector('.config-wrapper') as HTMLElement;
                            return panel.scrollWidth <= panel.clientWidth &&
                                document.documentElement.scrollWidth <= innerWidth;
                        }),
                        'Settings fit without horizontal scrolling',
                    );
                    await page.evaluate(() => document.getElementById('apply-config')!.scrollIntoView());
                    assert(
                        await page.evaluate(() => {
                            const r = document.getElementById('apply-config')!.getBoundingClientRect();
                            return r.top >= 0 && r.bottom <= innerHeight;
                        }),
                        'Done button is reachable',
                    );
                    await page.evaluate(() => document.querySelector('.config-wrapper')!.scrollTo(0, 0));
                    await screenshot(page, `settings-${width}`);
                    await page.evaluate(() => document.getElementById('close-config')!.click());
                    await page.evaluate(() => {
                        for (const id of ['video-container', 'screen-container']) {
                            document.getElementById(id)!.hidden = false;
                        }
                        const logs = document.getElementById('logs-container')!;
                        for (const type of ['system', 'user', 'ai', 'error', 'debug']) {
                            const entry = document.createElement('div');
                            entry.className = `log-entry ${type}`;
                            entry.textContent = `${type}: Using tool get_weather_on_date ` + 'long-url'.repeat(100);
                            logs.append(entry);
                        }
                        logs.classList.add('show-debug');
                    });
                    assertEquals(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                    assert(
                        await page.evaluate(() =>
                            ['stop-video', 'stop-screen', 'flip-camera'].every((id) => {
                                const el = document.getElementById(id)!;
                                const r = el.getBoundingClientRect();
                                return r.width >= 44 && r.height >= 44 && getComputedStyle(el).opacity === '1';
                            })
                        ),
                        'Media controls stay touch sized and visible',
                    );
                    await screenshot(page, `media-logs-${width}`);
                    await page.evaluate(() => {
                        for (const id of ['video-container', 'screen-container']) {
                            document.getElementById(id)!.hidden = true;
                        }
                        document.getElementById('logs-container')!.replaceChildren();
                        document.getElementById('app')!.hidden = true;
                        document.getElementById('login-panel')!.hidden = false;
                        document.getElementById('login-error')!.textContent = 'Sign-in failed. Please try again.';
                    });
                    assertEquals(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                    assert(
                        await page.evaluate(() => {
                            const r = document.getElementById('login-panel')!.getBoundingClientRect();
                            return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
                        }),
                        'Login card fits the viewport',
                    );
                    await screenshot(page, `login-${width}`);
                    await page.evaluate(() => {
                        document.getElementById('app')!.hidden = false;
                        document.getElementById('login-panel')!.hidden = true;
                    });
                });
            }
        } finally {
            await browser.close();
            await app.close();
        }
    },
});
