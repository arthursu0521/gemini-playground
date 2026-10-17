// @ts-check
/**
 * @fileoverview Entry point: starts the app once the DOM is ready.
 */
import { App } from './app.js';

function boot() {
    const app = new App();
    app.start();
    // Exposed for debugging in the browser console and for end-to-end tests.
    /** @type {any} */ (globalThis).geminiPlayground = app;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
