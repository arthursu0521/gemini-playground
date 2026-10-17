/** MultimodalLiveClient against a scripted in-memory WebSocket. */
import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from '@std/assert';
import { MultimodalLiveClient } from '../../src/static/js/core/websocket-client.js';
import { ToolManager } from '../../src/static/js/tools/tool-manager.js';
import { ApplicationError, ErrorCodes } from '../../src/static/js/utils/error-boundary.js';
import { arrayBufferToBase64 } from '../../src/static/js/utils/utils.js';
import { FakeWebSocket } from '../helpers/fake_websocket.ts';

const sockets: FakeWebSocket[] = [];
class ScriptedSocket extends FakeWebSocket {
    constructor(url: string) {
        super(url);
        sockets.push(this);
    }
    /** Parsed JSON of everything the client sent. */
    get json() {
        return this.sent.map((s) => JSON.parse(String(s)));
    }
    serve(message: unknown) {
        // Google sends binary frames.
        this.receive(new TextEncoder().encode(JSON.stringify(message)).buffer);
    }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const latest = () => sockets.at(-1) as ScriptedSocket;
const SETUP = { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'] } };

function makeClient(options: Record<string, unknown> = {}) {
    sockets.length = 0;
    const client = new MultimodalLiveClient({
        url: 'ws://relay/ws/x',
        WebSocketImpl: ScriptedSocket as unknown as typeof WebSocket,
        setupTimeoutMs: 200,
        reconnectDelayMs: 1,
        ...options,
    });
    const events: [string, unknown][] = [];
    for (
        const name of [
            'open',
            'setupcomplete',
            'audio',
            'text',
            'thought',
            'inputtranscription',
            'outputtranscription',
            'interrupted',
            'generationcomplete',
            'turncomplete',
            'toolcall',
            'toolcallcancellation',
            'toolresponse',
            'usage',
            'goaway',
            'reconnecting',
            'reconnected',
            'close',
            'grounding',
        ]
    ) client.on(name, (value: unknown) => events.push([name, value]));
    return { client, events, names: () => events.map(([n]) => n) };
}

async function connected(options: Record<string, unknown> = {}) {
    const ctx = makeClient(options);
    const promise = ctx.client.connect(SETUP, { apiKey: 'AIzaKey' });
    latest().open();
    latest().serve({ setupComplete: {} });
    await promise;
    return ctx;
}

Deno.test('connect sends auth first, then setup with session resumption, and resolves on setupComplete', async () => {
    const { client, names } = makeClient();
    let resolved = false;
    const promise = client.connect(SETUP, { apiKey: 'AIzaKey' }).then(() => (resolved = true));
    const ws = latest();
    assertEquals(ws.url, 'ws://relay/ws/x');
    assertEquals(ws.binaryType, 'arraybuffer');
    ws.open();
    assertEquals(ws.json, [
        { auth: { apiKey: 'AIzaKey' } },
        { setup: { ...SETUP, sessionResumption: {} } },
    ]);
    await tick();
    assertEquals(resolved, false, 'must wait for setupComplete, not just the socket');
    ws.serve({ setupComplete: {} });
    await promise;
    assertEquals(client.state, 'ready');
    assertEquals(names(), ['open', 'setupcomplete']);
});

Deno.test('connect rejects with AUTHENTICATION_FAILED when Gemini refuses the key (relay code 4008)', async () => {
    const { client, names } = makeClient();
    const promise = client.connect(SETUP, { apiKey: 'bad' });
    latest().open();
    latest().remoteClose(4008, 'API key not valid. Please pass a valid API key.');
    const error = await assertRejects(() => promise, ApplicationError);
    assertEquals(error.code, ErrorCodes.AUTHENTICATION_FAILED);
    assertEquals(
        error.message,
        'Gemini refused the session (check the API key and model): API key not valid. Please pass a valid API key.',
    );
    assertEquals(client.state, 'closed');
    assertEquals(names().includes('close'), false, 'a failed connect rejects instead of emitting close');
});

Deno.test('a bad key as Google actually reports it (1007 via relay 4007) is an authentication failure', async () => {
    const { client } = makeClient();
    const promise = client.connect(SETUP, { apiKey: 'bad' });
    latest().open();
    latest().remoteClose(4007, 'API key not valid. Please pass a valid API key.');
    const error = await assertRejects(() => promise, ApplicationError);
    assertEquals(error.code, ErrorCodes.AUTHENTICATION_FAILED);
    assertEquals(error.message, 'Gemini rejected the request: API key not valid. Please pass a valid API key.');
});

Deno.test('connect rejects when the relay rejects the password and when setup times out', async () => {
    const a = makeClient();
    const p1 = a.client.connect(SETUP, { accessPassword: 'x' });
    latest().open();
    latest().remoteClose(4401, 'Invalid access password');
    const e1 = await assertRejects(() => p1, ApplicationError);
    assertEquals(e1.message, 'Authentication failed: Invalid access password');

    const b = makeClient();
    const p2 = b.client.connect(SETUP, { apiKey: 'AIzaKey' });
    latest().open();
    const e2 = await assertRejects(() => p2, ApplicationError);
    assertEquals(e2.code, ErrorCodes.SETUP_TIMEOUT);
    assertEquals(latest().closedWith?.code, 1000);
});

Deno.test('server content is split into audio, text, thoughts, transcriptions and turn events', async () => {
    const { names, events } = await connected();
    const pcm = new Uint8Array([1, 2, 3, 4]);
    latest().serve({
        serverContent: {
            modelTurn: {
                parts: [
                    { inlineData: { mimeType: 'audio/pcm;rate=24000', data: arrayBufferToBase64(pcm) } },
                    { text: 'thinking...', thought: true },
                    { text: 'Hello' },
                ],
            },
            outputTranscription: { text: 'Hello there' },
            inputTranscription: { text: 'Hi' },
        },
        usageMetadata: { totalTokenCount: 5 },
    });
    latest().serve({ serverContent: { generationComplete: true } });
    latest().serve({ serverContent: { turnComplete: true } });
    latest().serve({ serverContent: { interrupted: true } });
    await tick();
    assertEquals(names().slice(2), [
        'usage',
        'audio',
        'thought',
        'text',
        'inputtranscription',
        'outputtranscription',
        'generationcomplete',
        'turncomplete',
        'interrupted',
    ]);
    const audio = events.find(([n]) => n === 'audio')![1] as ArrayBuffer;
    assertEquals(new Uint8Array(audio), pcm);
    assertEquals(events.find(([n]) => n === 'outputtranscription')![1], 'Hello there');
});

Deno.test('all function calls of a toolCall are answered in one toolResponse; cancellations are honoured', async () => {
    const tools = new ToolManager({ registerDefaults: false });
    tools.registerTool('echo', {
        getDeclaration: () => [{ name: 'echo' }],
        execute: (args: Record<string, unknown>) => Promise.resolve(args.v),
    });
    tools.registerTool('never', {
        getDeclaration: () => [{ name: 'never' }],
        execute: (_a: unknown, { signal }: { signal: AbortSignal }) =>
            new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))),
    });
    const { names } = await connected({ toolManager: tools });
    latest().serve({
        toolCall: {
            functionCalls: [
                { id: 'c1', name: 'echo', args: { v: 1 } },
                { id: 'c2', name: 'echo', args: { v: 2 } },
                { id: 'c3', name: 'never', args: {} },
            ],
        },
    });
    await tick(5);
    latest().serve({ toolCallCancellation: { ids: ['c3'] } });
    await tick(5);
    const responses = latest().json.filter((m) => m.toolResponse);
    assertEquals(responses, [{
        toolResponse: {
            functionResponses: [
                { id: 'c1', name: 'echo', response: { output: 1 } },
                { id: 'c2', name: 'echo', response: { output: 2 } },
            ],
        },
    }]);
    assert(names().includes('toolcallcancellation'));
});

Deno.test('realtime input uses the audio/video fields; nothing is sent when disconnected', async () => {
    const { client } = await connected();
    assert(client.sendAudio('AAAA'));
    assert(client.sendVideo('BBBB'));
    assert(client.sendAudioStreamEnd());
    client.sendText('hi');
    assertEquals(latest().json.slice(2), [
        { realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } },
        { realtimeInput: { video: { data: 'BBBB', mimeType: 'image/jpeg' } } },
        { realtimeInput: { audioStreamEnd: true } },
        { clientContent: { turns: [{ role: 'user', parts: [{ text: 'hi' }] }], turnComplete: true } },
    ]);
    assertEquals(JSON.stringify(latest().json).includes('mediaChunks'), false);

    client.disconnect();
    assertEquals(latest().closedWith?.code, 1000);
    assertEquals(client.sendAudio('AAAA'), false, 'mic chunks after disconnect are dropped');
    assertThrows(() => client.sendText('x'), ApplicationError);
});

Deno.test('goAway triggers a reconnect that resumes the session with the latest handle', async () => {
    const { client, events } = await connected();
    const first = latest();
    first.serve({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    first.serve({ sessionResumptionUpdate: { resumable: false, newHandle: '' } });
    first.serve({ sessionResumptionUpdate: { resumable: true, newHandle: 'h2' } });
    first.serve({ goAway: { timeLeft: '10s' } });
    await tick();
    const second = latest();
    assert(second !== first);
    second.open();
    assertEquals(second.json, [
        { auth: { apiKey: 'AIzaKey' } },
        { setup: { ...SETUP, sessionResumption: { handle: 'h2' } } },
    ]);
    second.serve({ setupComplete: {} });
    await tick();
    assertEquals(client.state, 'ready');
    assertEquals(first.closedWith?.code, 1000, 'old connection is closed after the swap');
    assertEquals(events.find(([n]) => n === 'reconnected')![1], { resumed: true });
    assertEquals(events.find(([n]) => n === 'goaway')![1], '10s');

    client.sendText('after');
    assertEquals(second.json.at(-1).clientContent.turns[0].parts[0].text, 'after');
});

Deno.test('an unexpected drop reconnects with backoff; fatal codes end the session with a close event', async () => {
    const { client, events } = await connected({ maxReconnectAttempts: 2 });
    latest().serve({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    latest().remoteClose(4011, 'Internal error');
    await tick();
    // attempt 1 fails at the network level, attempt 2 succeeds
    latest().fail();
    await tick(10);
    latest().open();
    latest().serve({ setupComplete: {} });
    await tick();
    assertEquals(client.state, 'ready');
    const reconnecting = events.filter(([n]) => n === 'reconnecting').map(([, v]) => v);
    assertEquals(reconnecting.length, 2);

    latest().remoteClose(4008, 'API key expired');
    await tick();
    assertEquals(client.state, 'closed');
    const close = events.find(([n]) => n === 'close')![1] as { code: number; reason: string };
    assertEquals(close.code, 1008);
    assertEquals(close.reason, 'Gemini refused the session (check the API key and model): API key expired');
});

Deno.test('reconnect gives up after max attempts and reports the last error', async () => {
    const { client, events } = await connected({ maxReconnectAttempts: 2 });
    latest().remoteClose(4006);
    for (let i = 0; i < 2; i++) {
        await tick(5);
        latest().fail();
    }
    await tick(10);
    assertEquals(client.state, 'closed');
    assertInstanceOf(events.find(([n]) => n === 'close')![1], Object);
});

Deno.test('disconnect during a reconnect stops it without emitting close', async () => {
    const { client, names } = await connected();
    latest().remoteClose(4011);
    await tick();
    const pending = latest();
    client.disconnect();
    pending.open();
    pending.serve({ setupComplete: {} });
    await tick();
    assertEquals(client.state, 'closed');
    assertEquals(names().includes('close'), false);
    assertEquals(names().includes('reconnected'), false);
});

Deno.test('connect twice is rejected', async () => {
    const { client } = await connected();
    await assertRejects(() => client.connect(SETUP, {}), ApplicationError, 'Already connected');
});
