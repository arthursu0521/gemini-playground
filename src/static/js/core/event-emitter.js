// @ts-check
/**
 * @fileoverview Tiny event emitter (replaces the CDN-loaded eventemitter3).
 * A listener that throws is reported to the console and does not break other listeners.
 */
export class EventEmitter {
    /** @type {Map<string, Set<(...args: any[]) => void>>} */
    #listeners = new Map();

    /**
     * @param {string} event
     * @param {(...args: any[]) => void} listener
     * @returns {() => void} unsubscribe function
     */
    on(event, listener) {
        let set = this.#listeners.get(event);
        if (!set) {
            set = new Set();
            this.#listeners.set(event, set);
        }
        set.add(listener);
        return () => this.off(event, listener);
    }

    /**
     * @param {string} event
     * @param {(...args: any[]) => void} listener
     */
    once(event, listener) {
        /** @param {any[]} args */
        const wrapper = (...args) => {
            this.off(event, wrapper);
            listener(...args);
        };
        return this.on(event, wrapper);
    }

    /**
     * @param {string} event
     * @param {(...args: any[]) => void} listener
     */
    off(event, listener) {
        this.#listeners.get(event)?.delete(listener);
    }

    /**
     * @param {string} event
     * @param {...any} args
     * @returns {boolean} whether any listener was called
     */
    emit(event, ...args) {
        const set = this.#listeners.get(event);
        if (!set || set.size === 0) return false;
        for (const listener of [...set]) {
            try {
                listener(...args);
            } catch (error) {
                console.error(`Listener for "${event}" failed`, error);
            }
        }
        return true;
    }

    /** @param {string} event */
    listenerCount(event) {
        return this.#listeners.get(event)?.size ?? 0;
    }

    /** @param {string} [event] */
    removeAllListeners(event) {
        if (event) this.#listeners.delete(event);
        else this.#listeners.clear();
    }
}
