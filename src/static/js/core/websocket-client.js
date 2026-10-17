// @ts-check
/**
 * @fileoverview Client for the Gemini Live API (BidiGenerateContent) through the relay server.
 *
 * - Credentials go in the first WebSocket message (`{"auth":{...}}`), never in the URL.
 * - `connect()` resolves when the server confirms the setup (`setupComplete`) and rejects with a
 *   readable error otherwise (bad key, timeout, network).
 * - Session resumption: the latest resumption handle is kept, and on `goAway` or an unexpected
 *   disconnect the client reconnects and resumes the same conversation.
 *
 * Events: open, setupcomplete, audio(ArrayBuffer), text(string), thought(string),
 * inputtranscription(string), outputtranscription(string), interrupted, generationcomplete,
 * turncomplete, toolcall(calls), toolcallcancellation(ids), toolresponse(responses), grounding,
 * usage, goaway(timeLeft), reconnecting({attempt, reason, resumable}), reconnected({resumed}),
 * close({code, reason}), log({type, message}).
 */
import { CONFIG } from '../config/config.js';
import { decodeCloseCode, isFatalCloseCode, LIVE_WS_PATH, RelayCloseCode } from '../shared/protocol.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { base64ToArrayBuffer, messageToText } from '../utils/utils.js';
import { EventEmitter } from './event-emitter.js';

/** @typedef {{ apiKey?: string, accessPassword?: string }} Credentials */
/** @typedef {import('../tools/tool-manager.js').ToolManager} ToolManager */

/**
 * Human-readable explanation for a close code (raw or relay-encoded).
 * @param {number} code
 * @param {string} reason
 */
export function describeClose(code, reason) {
    const decoded = decodeCloseCode(code);
    const known = {
        [RelayCloseCode.UNAUTHORIZED]: 'Authentication failed',
        [RelayCloseCode.AUTH_TIMEOUT]: 'Authentication timed out',
        [RelayCloseCode.RATE_LIMITED]: 'Rate limited by the server',
        [RelayCloseCode.UPSTREAM_UNAVAILABLE]: 'Could not reach Gemini',
        [RelayCloseCode.QUEUE_OVERFLOW]: 'Sent too much data before the session was ready',
        1006: 'Connection lost',
        1007: 'Gemini rejected the request',
        1008: 'Gemini refused the session (check the API key and model)',
        1011: 'Gemini internal error',
        1013: 'Gemini is overloaded, try again later',
    }[decoded];
    const parts = [known, reason].filter(Boolean);
    return parts.length ? parts.join(': ') : `Connection closed (code ${decoded})`;
}

export class MultimodalLiveClient extends EventEmitter {
    /**
     * @param {{
     *   url?: string,
     *   toolManager?: ToolManager | null,
     *   setupTimeoutMs?: number,
     *   maxReconnectAttempts?: number,
     *   reconnectDelayMs?: number,
     *   WebSocketImpl?: typeof WebSocket,
     * }} [options]
     */
    constructor(options = {}) {
        super();
        this.url = options.url ?? MultimodalLiveClient.defaultUrl();
        this.toolManager = options.toolManager ?? null;
        this.setupTimeoutMs = options.setupTimeoutMs ?? CONFIG.CONNECTION.SETUP_TIMEOUT_MS;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? CONFIG.CONNECTION.MAX_RECONNECT_ATTEMPTS;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 500;
        this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
        /** @type {'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed'} */
        this.state = 'idle';
        /** @type {WebSocket | null} */
        this.socket = null;
        /** @type {Record<string, unknown> | null} */
        this.setup = null;
        /** @type {Credentials | null} */
        this.credentials = null;
        /** @type {string | null} */
        this.resumeHandle = null;
        /** @type {Set<WebSocket>} sockets we closed on purpose */
        this.intentionallyClosed = new Set();
        this.reconnecting = false;
    }

    static defaultUrl() {
        const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${globalThis.location?.host ?? 'localhost'}${LIVE_WS_PATH}`;
    }

    get isReady() {
        return this.state === 'ready' || this.state === 'reconnecting';
    }

    /** State can change across awaits (user disconnects), so read it through a method. */
    #isClosed() {
        return this.state === 'closed';
    }

    /**
     * @param {Record<string, unknown>} setup BidiGenerateContentSetup (model, generationConfig, ...)
     * @param {Credentials} credentials
     */
    async connect(setup, credentials) {
        if (this.state === 'connecting' || this.isReady) {
            throw new ApplicationError('Already connected', ErrorCodes.INVALID_STATE);
        }
        this.setup = setup;
        this.credentials = credentials;
        this.resumeHandle = null;
        this.state = 'connecting';
        try {
            this.socket = await this.#open(null);
            this.state = 'ready';
            return true;
        } catch (error) {
            this.state = 'closed';
            throw error;
        }
    }

    /** Ends the session. No reconnect, no 'close' event (the caller initiated it). */
    disconnect() {
        const socket = this.socket;
        this.socket = null;
        this.state = 'closed';
        this.reconnecting = false;
        this.resumeHandle = null;
        this.toolManager?.cancel([...(this.toolManager?.pending.keys() ?? [])]);
        if (socket) this.#closeSocket(socket, 1000, 'client disconnect');
    }

    // ---------------------------------------------------------------------------------------
    // Sending
    // ---------------------------------------------------------------------------------------

    /** @param {string} text */
    sendText(text) {
        this.#send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
        this.emit('log', { type: 'client.text', message: text });
    }

    /** @param {string} base64Pcm 16 kHz mono PCM16 */
    sendAudio(base64Pcm) {
        return this.#send(
            {
                realtimeInput: {
                    audio: { data: base64Pcm, mimeType: `audio/pcm;rate=${CONFIG.AUDIO.INPUT_SAMPLE_RATE}` },
                },
            },
            true,
        );
    }

    /** @param {string} base64Jpeg */
    sendVideo(base64Jpeg) {
        return this.#send({ realtimeInput: { video: { data: base64Jpeg, mimeType: 'image/jpeg' } } }, true);
    }

    /** Tells the server the microphone stopped, so it can flush cached audio. */
    sendAudioStreamEnd() {
        return this.#send({ realtimeInput: { audioStreamEnd: true } }, true);
    }

    /** @param {object[]} functionResponses */
    sendToolResponse(functionResponses) {
        this.#send({ toolResponse: { functionResponses } }, true);
        this.emit('toolresponse', functionResponses);
    }

    /**
     * @param {object} message
     * @param {boolean} [realtime] realtime data is dropped (not thrown) when not connected
     */
    #send(message, realtime = false) {
        const socket = this.socket;
        if (!socket || socket.readyState !== 1 || !this.isReady) {
            if (realtime) return false;
            throw new ApplicationError('Not connected to Gemini', ErrorCodes.WEBSOCKET_NOT_CONNECTED);
        }
        socket.send(JSON.stringify(message));
        return true;
    }

    // ---------------------------------------------------------------------------------------
    // Connection management
    // ---------------------------------------------------------------------------------------

    /**
     * Opens a socket, authenticates, sends setup and resolves once setupComplete arrives.
     * @param {string | null} handle session resumption handle
     * @returns {Promise<WebSocket>}
     */
    #open(handle) {
        return new Promise((resolve, reject) => {
            const ws = new this.WebSocketImpl(this.url);
            ws.binaryType = 'arraybuffer';
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.#closeSocket(ws, 1000, 'setup timeout');
                reject(new ApplicationError('Gemini did not confirm the session in time', ErrorCodes.SETUP_TIMEOUT));
            }, this.setupTimeoutMs);

            const settle = (/** @type {Error | null} */ error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(ws);
            };

            ws.addEventListener('open', () => {
                this.emit('open');
                this.emit('log', { type: 'client.open', message: handle ? 'resuming session' : 'socket open' });
                ws.send(JSON.stringify({ auth: this.credentials ?? {} }));
                const setup = { ...this.setup, sessionResumption: handle ? { handle } : {} };
                ws.send(JSON.stringify({ setup }));
            });

            ws.addEventListener('message', async (event) => {
                let message;
                try {
                    message = JSON.parse(await messageToText(event.data));
                } catch (error) {
                    Logger.warn('Ignoring unparsable server message', error);
                    return;
                }
                if (message.setupComplete !== undefined && !settled) {
                    this.emit('log', { type: 'server.setupComplete', message: 'setup complete' });
                    settle(null);
                    this.emit('setupcomplete');
                    return;
                }
                this.#handleMessage(message);
            });

            ws.addEventListener('close', (event) => {
                const code = decodeCloseCode(event.code);
                const reason = event.reason ?? '';
                this.emit('log', { type: 'server.close', message: `code ${code}${reason ? `: ${reason}` : ''}` });
                if (!settled) {
                    // Google closes with 1007 "API key not valid" for bad keys (1008 for policy refusals).
                    const authFailed = code === 1008 || code === RelayCloseCode.UNAUTHORIZED ||
                        (code === 1007 && /api key/i.test(reason));
                    settle(
                        new ApplicationError(
                            describeClose(event.code, reason),
                            authFailed ? ErrorCodes.AUTHENTICATION_FAILED : ErrorCodes.WEBSOCKET_CONNECTION_FAILED,
                            { code, reason },
                        ),
                    );
                    return;
                }
                this.#onSocketClosed(ws, event.code, reason);
            });
        });
    }

    /**
     * @param {WebSocket} ws
     * @param {number} code
     * @param {string} reason
     */
    #closeSocket(ws, code, reason) {
        this.intentionallyClosed.add(ws);
        try {
            if (ws.readyState === 0 || ws.readyState === 1) ws.close(code, reason);
        } catch { /* ignore */ }
    }

    /**
     * @param {WebSocket} ws
     * @param {number} code raw close code
     * @param {string} reason
     */
    #onSocketClosed(ws, code, reason) {
        if (this.intentionallyClosed.delete(ws)) return;
        if (ws !== this.socket) return; // an old socket replaced by a reconnect
        if (this.#isClosed()) return;
        if (isFatalCloseCode(code) || this.maxReconnectAttempts <= 0) {
            this.#terminate(code, reason);
            return;
        }
        void this.#reconnect(`connection closed (${decodeCloseCode(code)})`, { code, reason });
    }

    /**
     * @param {number} code
     * @param {string} reason
     */
    #terminate(code, reason) {
        this.socket = null;
        this.state = 'closed';
        this.reconnecting = false;
        this.emit('close', { code: decodeCloseCode(code), reason: describeClose(code, reason) });
    }

    /**
     * Opens a replacement socket (resuming the session when a handle is known) and swaps it in.
     * @param {string} why
     * @param {{ code: number, reason: string }} [lastClose]
     */
    async #reconnect(why, lastClose) {
        if (this.reconnecting || this.state === 'closed') return;
        this.reconnecting = true;
        this.state = 'reconnecting';
        let last = lastClose ?? { code: 1006, reason: '' };
        for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
            const resumable = this.resumeHandle !== null;
            this.emit('reconnecting', { attempt, reason: why, resumable });
            try {
                const ws = await this.#open(this.resumeHandle);
                if (this.#isClosed()) {
                    this.#closeSocket(ws, 1000, 'client disconnect');
                    return;
                }
                const old = this.socket;
                this.socket = ws;
                this.state = 'ready';
                this.reconnecting = false;
                if (old && old !== ws) this.#closeSocket(old, 1000, 'replaced');
                this.emit('reconnected', { resumed: resumable });
                return;
            } catch (error) {
                if (this.#isClosed()) return;
                const details = error instanceof ApplicationError ? error.details : {};
                last = { code: Number(details.code ?? 1006), reason: String(details.reason ?? '') };
                Logger.warn(`Reconnect attempt ${attempt} failed`, error);
                if (isFatalCloseCode(last.code)) break;
                await new Promise((r) => setTimeout(r, this.reconnectDelayMs * 2 ** (attempt - 1)));
            }
        }
        if (!this.#isClosed()) {
            const old = this.socket;
            if (old) this.#closeSocket(old, 1000, 'giving up');
            this.#terminate(last.code, last.reason);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Receiving
    // ---------------------------------------------------------------------------------------

    /** @param {any} message */
    #handleMessage(message) {
        if (message.usageMetadata) this.emit('usage', message.usageMetadata);

        if (message.serverContent) {
            const content = message.serverContent;
            for (const part of content.modelTurn?.parts ?? []) {
                const inline = part.inlineData;
                if (inline?.mimeType?.startsWith('audio/pcm') && inline.data) {
                    this.emit('audio', base64ToArrayBuffer(inline.data));
                } else if (typeof part.text === 'string' && part.text) {
                    this.emit(part.thought ? 'thought' : 'text', part.text);
                }
            }
            if (content.inputTranscription?.text) this.emit('inputtranscription', content.inputTranscription.text);
            if (content.outputTranscription?.text) this.emit('outputtranscription', content.outputTranscription.text);
            if (content.groundingMetadata) this.emit('grounding', content.groundingMetadata);
            if (content.interrupted) {
                this.emit('log', { type: 'server.interrupted', message: 'interrupted' });
                this.emit('interrupted');
            }
            if (content.generationComplete) this.emit('generationcomplete');
            if (content.turnComplete) {
                this.emit('log', { type: 'server.turnComplete', message: 'turn complete' });
                this.emit('turncomplete');
            }
            return;
        }

        if (message.toolCall) {
            const calls = message.toolCall.functionCalls ?? [];
            this.emit('log', {
                type: 'server.toolCall',
                message: calls.map((/** @type {any} */ c) => c.name).join(', '),
            });
            this.emit('toolcall', calls);
            if (this.toolManager && calls.length) void this.#runTools(calls);
            return;
        }

        if (message.toolCallCancellation) {
            const ids = message.toolCallCancellation.ids ?? [];
            this.toolManager?.cancel(ids);
            this.emit('toolcallcancellation', ids);
            return;
        }

        if (message.sessionResumptionUpdate) {
            const { resumable, newHandle } = message.sessionResumptionUpdate;
            if (resumable && newHandle) this.resumeHandle = newHandle;
            return;
        }

        if (message.goAway) {
            this.emit('log', { type: 'server.goAway', message: `time left ${message.goAway.timeLeft ?? '?'}` });
            this.emit('goaway', message.goAway.timeLeft);
            void this.#reconnect('server requested reconnect (goAway)');
        }
    }

    /** @param {any[]} calls */
    async #runTools(calls) {
        const responses = await /** @type {ToolManager} */ (this.toolManager).executeAll(calls);
        if (responses.length && this.isReady) {
            try {
                this.sendToolResponse(responses);
            } catch (error) {
                Logger.warn('Could not send tool response', error);
            }
        }
    }
}
