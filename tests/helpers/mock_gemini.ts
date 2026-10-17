/**
 * A scriptable stand-in for generativelanguage.googleapis.com used by integration and e2e tests.
 * Live sessions: accepts the BidiGenerateContent WebSocket, checks `?key=`, answers `setup` with
 * `setupComplete` and lets each test script the rest. REST: records `/v1beta/openai/*` calls.
 */
export interface LiveConnection {
    id: number;
    url: URL;
    key: string | null;
    socket: WebSocket;
    messages: Record<string, unknown>[];
    /** Sends a server message as a binary frame, like Google does. */
    send(message: unknown): void;
    sendText(message: unknown): void;
    waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
    closed: Promise<{ code: number; reason: string }>;
}

export interface RestCall {
    path: string;
    method: string;
    headers: Headers;
    body: string;
}

export interface MockGeminiOptions {
    validKeys?: string[];
    /** Called for every parsed client message after the built-in setup handling. */
    onMessage?: (conn: LiveConnection, message: Record<string, unknown>) => void;
    /** Reply for REST calls; defaults to a canned chat completion. */
    onRest?: (call: RestCall) => Response | Promise<Response>;
    /** Delay before upgrading WebSockets (to test queueing in the relay). */
    acceptDelayMs?: number;
}

export interface MockGemini {
    baseUrl: string;
    connections: LiveConnection[];
    restCalls: RestCall[];
    nextConnection(timeoutMs?: number): Promise<LiveConnection>;
    close(): Promise<void>;
}

const encoder = new TextEncoder();

export function startMockGemini(options: MockGeminiOptions = {}): MockGemini {
    const connections: LiveConnection[] = [];
    const restCalls: RestCall[] = [];
    const waiters: Array<(c: LiveConnection) => void> = [];
    const validKeys = options.validKeys ?? ['AIzaTestKeyValid_0000000000000000000'];
    let counter = 0;

    const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
        const url = new URL(req.url);
        if (req.headers.get('upgrade') === 'websocket') {
            if (options.acceptDelayMs) await new Promise((r) => setTimeout(r, options.acceptDelayMs));
            const { socket, response } = Deno.upgradeWebSocket(req);
            const key = url.searchParams.get('key');
            let resolveClosed!: (v: { code: number; reason: string }) => void;
            const conn: LiveConnection = {
                id: ++counter,
                url,
                key,
                socket,
                messages: [],
                send: (m) => socket.readyState === WebSocket.OPEN && socket.send(encoder.encode(JSON.stringify(m))),
                sendText: (m) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(m)),
                waitFor(predicate, timeoutMs = 5000) {
                    const found = conn.messages.find(predicate);
                    if (found) return Promise.resolve(found);
                    return new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error('mock: message not received')), timeoutMs);
                        const check = () => {
                            const hit = conn.messages.find(predicate);
                            if (hit) {
                                clearTimeout(timer);
                                resolve(hit);
                            } else if (socket.readyState <= WebSocket.OPEN) {
                                setTimeout(check, 10);
                            }
                        };
                        check();
                    });
                },
                closed: new Promise((r) => (resolveClosed = r)),
            };
            socket.addEventListener('open', () => {
                if (!key || !validKeys.includes(key)) {
                    // Mirrors Google: an invalid key closes with 1007 INVALID_ARGUMENT.
                    socket.close(1007, 'API key not valid. Please pass a valid API key.');
                }
            });
            socket.addEventListener('message', (event) => {
                const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
                let message: Record<string, unknown>;
                try {
                    message = JSON.parse(text);
                } catch {
                    socket.close(1007, 'Request contains an invalid argument.');
                    return;
                }
                conn.messages.push(message);
                if ('setup' in message) conn.send({ setupComplete: {} });
                options.onMessage?.(conn, message);
            });
            socket.addEventListener('close', (e) => resolveClosed({ code: e.code, reason: e.reason }));
            connections.push(conn);
            waiters.splice(0).forEach((w) => w(conn));
            return response;
        }

        const call: RestCall = { path: url.pathname, method: req.method, headers: req.headers, body: await req.text() };
        restCalls.push(call);
        if (options.onRest) return await options.onRest(call);
        return Response.json({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        });
    });

    const addr = server.addr as Deno.NetAddr;
    return {
        baseUrl: `http://127.0.0.1:${addr.port}`,
        connections,
        restCalls,
        nextConnection(timeoutMs = 5000) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('mock: no upstream connection')), timeoutMs);
                waiters.push((c) => {
                    clearTimeout(timer);
                    resolve(c);
                });
            });
        },
        async close() {
            for (const c of connections) {
                try {
                    c.socket.close();
                } catch { /* ignore */ }
            }
            await server.shutdown();
        },
    };
}
