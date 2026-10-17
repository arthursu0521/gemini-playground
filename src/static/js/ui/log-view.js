// @ts-check
/**
 * @fileoverview Conversation / log panel. Keeps at most `maxEntries` DOM nodes, streams partial
 * transcripts into one entry per turn, and hides protocol details unless debug is on.
 * Text is always inserted with textContent (never innerHTML).
 */

/** @typedef {'system' | 'debug' | 'error' | 'user' | 'ai'} EntryType */

const LABELS = { system: 'System', debug: 'Debug', error: 'Error', user: 'You', ai: 'Gemini' };

export class LogView {
    /**
     * @param {HTMLElement} container
     * @param {{ maxEntries?: number, now?: () => Date }} [options]
     */
    constructor(container, options = {}) {
        this.container = container;
        this.maxEntries = options.maxEntries ?? 500;
        this.now = options.now ?? (() => new Date());
        /** @type {Map<'user' | 'ai', HTMLElement>} open streaming entries */
        this.streams = new Map();
    }

    /**
     * @param {EntryType} type
     * @param {string} text
     * @returns {HTMLElement}
     */
    add(type, text) {
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.setAttribute('role', type === 'error' ? 'alert' : 'listitem');

        const time = document.createElement('time');
        time.className = 'timestamp';
        time.textContent = this.now().toLocaleTimeString();

        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = LABELS[type];

        const body = document.createElement('span');
        body.className = 'text';
        body.textContent = text;

        entry.append(time, label, body);
        const stick = this.#isScrolledToBottom();
        this.container.append(entry);
        this.#trim();
        if (stick) this.container.scrollTop = this.container.scrollHeight;
        return entry;
    }

    /**
     * Appends text to the current streaming entry of a speaker (creating it if needed).
     * @param {'user' | 'ai'} type
     * @param {string} text
     */
    stream(type, text) {
        let entry = this.streams.get(type);
        if (!entry || !entry.isConnected) {
            entry = this.add(type, '');
            entry.classList.add('streaming');
            this.streams.set(type, entry);
        }
        const body = /** @type {HTMLElement} */ (entry.querySelector('.text'));
        const stick = this.#isScrolledToBottom();
        body.textContent += text;
        if (stick) this.container.scrollTop = this.container.scrollHeight;
    }

    /**
     * Closes streaming entries so the next fragment starts a new one.
     * @param {'user' | 'ai'} [type] both when omitted
     */
    endStream(type) {
        const types = type ? [type] : /** @type {const} */ (['user', 'ai']);
        for (const t of types) {
            this.streams.get(t)?.classList.remove('streaming');
            this.streams.delete(t);
        }
    }

    clear() {
        this.container.replaceChildren();
        this.streams.clear();
    }

    /** @param {boolean} show */
    setShowDebug(show) {
        this.container.classList.toggle('show-debug', show);
    }

    get size() {
        return this.container.childElementCount;
    }

    #trim() {
        while (this.container.childElementCount > this.maxEntries) {
            this.container.firstElementChild?.remove();
        }
    }

    #isScrolledToBottom() {
        const c = this.container;
        return c.scrollHeight - c.scrollTop - c.clientHeight < 40;
    }
}
