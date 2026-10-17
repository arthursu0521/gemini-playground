/** In-memory WebSocket double implementing the WebSocketLike surface used by the relay. */
// deno-lint-ignore no-explicit-any
type Listener = (event: any) => void;

export class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = 0;
    binaryType = 'blob';
    sent: unknown[] = [];
    closedWith: { code?: number; reason?: string } | null = null;
    #listeners = new Map<string, Listener[]>();

    constructor(public url: string) {}

    addEventListener(type: string, listener: Listener) {
        const list = this.#listeners.get(type) ?? [];
        list.push(listener);
        this.#listeners.set(type, list);
    }

    removeEventListener(type: string, listener: Listener) {
        const list = this.#listeners.get(type) ?? [];
        this.#listeners.set(type, list.filter((l) => l !== listener));
    }

    dispatch(type: string, event: Record<string, unknown> = {}) {
        for (const listener of [...(this.#listeners.get(type) ?? [])]) listener({ type, ...event });
        const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
        if (typeof handler === 'function') handler.call(this, { type, ...event });
    }

    send(data: unknown) {
        if (this.readyState !== 1) throw new Error('InvalidStateError: socket not open');
        this.sent.push(data);
    }

    close(code?: number, reason?: string) {
        if (this.readyState >= 2) return;
        this.closedWith = { code, reason };
        this.readyState = 3;
        this.dispatch('close', { code: code ?? 1005, reason: reason ?? '', wasClean: true });
    }

    // --- test controls ---
    open() {
        this.readyState = 1;
        this.dispatch('open');
    }

    receive(data: unknown) {
        this.dispatch('message', { data });
    }

    remoteClose(code: number, reason = '') {
        this.readyState = 3;
        this.dispatch('close', { code, reason, wasClean: true });
    }

    fail() {
        this.dispatch('error');
        this.remoteClose(1006);
    }
}
