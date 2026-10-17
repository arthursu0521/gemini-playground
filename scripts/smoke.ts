/**
 * Smoke test against the real Gemini API through a locally started relay.
 *
 *   deno task smoke                      # no key: checks that Google rejects a fake key through the relay
 *   GEMINI_API_KEY=AIza... deno task smoke   # real key: one Live voice turn + one chat completion
 *
 * Reads GEMINI_API_KEY from the environment or from .env. Prints no secrets.
 */
import { load } from '@std/dotenv';
import { LIVE_WS_PATH } from '../src/static/js/shared/protocol.js';
import { startAppServer } from '../tests/helpers/app_server.ts';

await load({ export: true });
const realKey = Deno.env.get('GEMINI_API_KEY') ?? '';
const key = realKey || 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00';
const liveModel = Deno.env.get('SMOKE_LIVE_MODEL') ?? 'gemini-3.8-live';
const chatModel = Deno.env.get('DEFAULT_CHAT_MODEL') ?? 'gemini-3.8-flash';
const app = startAppServer({});
let failed = false;

function report(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
    if (!ok) failed = true;
}

// --- Live API -----------------------------------------------------------------------------------
{
    const ws = new WebSocket(`${app.wsOrigin}${LIVE_WS_PATH}`);
    ws.binaryType = 'arraybuffer';
    let setupComplete = false;
    let transcript = '';
    let audioBytes = 0;
    const done = new Promise<{ code: number; reason: string } | 'turn'>((resolve) => {
        ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
        ws.onmessage = (e) => {
            const msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
            if (msg.setupComplete) {
                setupComplete = true;
                ws.send(JSON.stringify({
                    clientContent: {
                        turns: [{ role: 'user', parts: [{ text: 'Say hello in five words.' }] }],
                        turnComplete: true,
                    },
                }));
            }
            for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) audioBytes += atob(part.inlineData.data).length;
            }
            transcript += msg.serverContent?.outputTranscription?.text ?? '';
            if (msg.serverContent?.turnComplete) resolve('turn');
        };
    });
    ws.onopen = () => {
        ws.send(JSON.stringify({ auth: { apiKey: key } }));
        ws.send(JSON.stringify({
            setup: {
                model: `models/${liveModel}`,
                generationConfig: { responseModalities: ['AUDIO'] },
                outputAudioTranscription: {},
            },
        }));
    };
    const result = await Promise.race([done, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
    if (realKey) {
        report(
            `live ${liveModel}`,
            result === 'turn' && setupComplete && audioBytes > 0,
            result === 'turn'
                ? `${audioBytes} bytes of audio, transcript "${transcript.trim()}"`
                : `ended with ${JSON.stringify(result)}`,
        );
    } else {
        const ok = typeof result === 'object' && result.code === 4007 && /API key not valid/.test(result.reason);
        report('live (fake key)', ok, `relay closed with ${JSON.stringify(result)}`);
    }
    if (ws.readyState === WebSocket.OPEN) ws.close();
}

// --- OpenAI-compatible API ------------------------------------------------------------------------
{
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: chatModel, messages: [{ role: 'user', content: 'Reply with: pong' }] }),
    });
    const body = await res.text();
    if (realKey) {
        let content = '';
        try {
            content = JSON.parse(body).choices?.[0]?.message?.content ?? '';
        } catch { /* not JSON */ }
        report(
            `chat ${chatModel}`,
            res.ok && content.length > 0,
            `HTTP ${res.status} "${(content || body).slice(0, 80)}"`,
        );
    } else {
        report('chat (fake key)', res.status === 400 && body.includes('API key'), `HTTP ${res.status}`);
    }
}

const leaked = app.logs.some((line) => line.includes(key));
report('no key in server logs', !leaked, `${app.logs.length} log lines checked`);
await app.close();
Deno.exit(failed ? 1 : 0);
