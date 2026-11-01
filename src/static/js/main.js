// @ts-check
/**
 * @fileoverview Entry point: starts the app once the DOM is ready.
 */
import { initPreferences, t, text } from './preferences.js';
import { App } from './app.js';
import { ensureSession } from './session-ui.js';

async function boot() {
    initPreferences();
    const login = /** @type {HTMLElement} */ (document.getElementById('login-panel'));
    const main = /** @type {HTMLElement} */ (document.getElementById('app'));
    const logout = /** @type {HTMLButtonElement} */ (document.getElementById('logout-button'));
    const form = /** @type {HTMLFormElement} */ (document.getElementById('login-form'));
    const input = /** @type {HTMLInputElement} */ (document.getElementById('login-password'));
    const error = /** @type {HTMLElement} */ (document.getElementById('login-error'));
    try {
        sessionStorage.removeItem('gemini_access_password');
        localStorage.removeItem('gemini_access_password');
    } catch { /* storage blocked */ }
    const config = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({
        sessionRequired: true,
    }));
    const required = config.sessionRequired;
    const showLogin = () => {
        main.hidden = true;
        login.hidden = false;
    };
    if (required) {
        const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' }).catch(() =>
            null
        );
        if (!response?.ok) showLogin();
    }
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = /** @type {HTMLButtonElement} */ (form.querySelector('button'));
        button.disabled = true;
        delete error.dataset.i18n;
        error.textContent = '';
        try {
            const response = await fetch('/auth/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ password: input.value }),
            });
            if (!response.ok) {
                throw new Error(
                    response.status === 401
                        ? 'Wrong password. Please try again.'
                        : response.status === 429
                        ? 'Too many attempts. Wait a minute.'
                        : response.status >= 500
                        ? 'Service unavailable. Please try again later.'
                        : 'Sign-in failed. Please try again.',
                );
            }
            input.value = '';
            login.hidden = true;
            main.hidden = false;
        } catch (e) {
            text(
                error,
                e instanceof TypeError
                    ? 'Service unavailable. Please try again later.'
                    : e instanceof Error
                    ? e.message
                    : 'Sign-in failed. Please try again.',
            );
        } finally {
            button.disabled = false;
        }
    });
    const app = new App();
    app.ensureSession = () => ensureSession(required, showLogin);
    app.client.on('close', () => {
        void app.ensureSession();
    });
    logout.hidden = !required;
    logout.addEventListener('click', async () => {
        app.disconnect();
        const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
        if (response?.ok) {
            input.value = '';
            showLogin();
        } else alert(t('Sign-out could not be confirmed. Please retry.'));
    });
    app.start();
    // Exposed for debugging in the browser console and for end-to-end tests.
    /** @type {any} */ (globalThis).geminiPlayground = app;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
