import { assert, assertEquals, assertThrows } from '@std/assert';
import { buildSetup } from '../../src/static/js/app.js';
import { SettingsStore } from '../../src/static/js/settings.js';
import { ToolManager } from '../../src/static/js/tools/tool-manager.js';

class MemoryStorage {
    data = new Map<string, string>();
    getItem(k: string) {
        return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.data.set(k, String(v));
    }
    removeItem(k: string) {
        this.data.delete(k);
    }
}

function stores(seed: Record<string, string> = {}) {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    for (const [k, v] of Object.entries(seed)) local.setItem(k, v);
    const store = new SettingsStore({
        local: () => local as unknown as Storage,
        session: () => session as unknown as Storage,
    });
    return { local, session, store };
}

Deno.test('tool declarations: built-in googleSearch plus one functionDeclarations block', () => {
    assertEquals(new ToolManager().getToolDeclarations(), [
        { googleSearch: {} },
        { functionDeclarations: [new ToolManager().functions.get('get_weather_on_date')!.getDeclaration()[0]] },
    ]);
});

Deno.test('tool calls run in parallel and every call gets a response with its id', async () => {
    const tools = new ToolManager({ registerDefaults: false });
    const order: string[] = [];
    tools.registerTool('slow', {
        getDeclaration: () => [{ name: 'slow' }],
        execute: async () => {
            await new Promise((r) => setTimeout(r, 30));
            order.push('slow');
            return 'S';
        },
    });
    tools.registerTool('fast', {
        getDeclaration: () => [{ name: 'fast' }],
        execute: () => {
            order.push('fast');
            return Promise.resolve('F');
        },
    });
    const responses = await tools.executeAll([
        { id: '1', name: 'slow', args: {} },
        { id: '2', name: 'fast', args: {} },
        { id: '3', name: 'missing', args: {} },
    ]);
    assertEquals(order, ['fast', 'slow']);
    assertEquals(responses, [
        { id: '1', name: 'slow', response: { output: 'S' } },
        { id: '2', name: 'fast', response: { output: 'F' } },
        { id: '3', name: 'missing', response: { error: 'Unknown tool: missing' } },
    ]);
});

Deno.test('cancelled tool calls are aborted and left out of the response', async () => {
    const tools = new ToolManager({ registerDefaults: false });
    let aborted = false;
    tools.registerTool('wait', {
        getDeclaration: () => [{ name: 'wait' }],
        execute: (_args, { signal }) =>
            new Promise((resolve) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    resolve('late');
                });
            }),
    });
    const pending = tools.executeAll([{ id: 'a', name: 'wait' }]);
    tools.cancel(['a']);
    assertEquals(await pending, []);
    assert(aborted);
});

Deno.test('duplicate tool or function names are rejected', () => {
    const tools = new ToolManager();
    assertThrows(() => tools.registerTool('weather', { builtin: true, getDeclaration: () => ({}) }));
    assertThrows(() =>
        tools.registerTool('weather2', {
            getDeclaration: () => [{ name: 'get_weather_on_date' }],
            execute: () => Promise.resolve(null),
        })
    );
});

Deno.test('weather demo tool validates input and labels its data as demo', async () => {
    const weather = new ToolManager().functions.get('get_weather_on_date')!;
    const signal = new AbortController().signal;
    const a = await weather.execute({ location: 'Paris', date: '2026-10-17' }, { signal }) as Record<string, unknown>;
    const b = await weather.execute({ location: 'paris', date: '2026-10-17' }, { signal }) as Record<string, unknown>;
    assertEquals({ ...a, location: '' }, { ...b, location: '' }, 'deterministic and case-insensitive');
    assert(String(a.note).includes('Demo data'));
    const responses = await new ToolManager().executeAll([{
        id: 'x',
        name: 'get_weather_on_date',
        args: { location: 'Paris', date: 'tomorrow' },
    }]);
    assertEquals(responses[0].response, { error: 'date must be YYYY-MM-DD' });
});

Deno.test('settings: API key lives in sessionStorage unless "remember" is ticked', () => {
    const { local, session, store } = stores();
    const s = store.load();
    assertEquals(s.rememberKey, false);
    assertEquals(s.model, 'gemini-3.8-live');
    store.save({ ...s, apiKey: 'AIzaSession' });
    assertEquals(session.getItem('gemini_api_key'), 'AIzaSession');
    assertEquals(local.getItem('gemini_api_key'), null);
    store.save({ ...s, apiKey: 'AIzaLocal', rememberKey: true });
    assertEquals(local.getItem('gemini_api_key'), 'AIzaLocal');
    assertEquals(session.getItem('gemini_api_key'), null);
    assertEquals(store.load().apiKey, 'AIzaLocal');
    store.forgetCredentials();
    assertEquals(store.load().apiKey, '');
});

Deno.test('settings: users of the old version keep their stored key and preferences', () => {
    const { store } = stores({
        gemini_api_key: 'AIzaOld',
        gemini_voice: 'Puck',
        gemini_language: 'cmn-CN',
        video_fps: '30',
        system_instruction: 'Be brief.',
    });
    const s = store.load();
    assertEquals(s.apiKey, 'AIzaOld');
    assertEquals(s.rememberKey, true);
    assertEquals(s.voice, 'Puck');
    assertEquals(s.language, 'cmn-CN');
    assertEquals(s.fps, 5, 'clamped to the new maximum');
    assertEquals(s.systemInstruction, 'Be brief.');
});

Deno.test('settings: storage that throws (privacy mode) does not break loading or saving', () => {
    const broken = () => {
        throw new Error('SecurityError');
    };
    const store = new SettingsStore({ local: broken, session: broken });
    const s = store.load();
    assertEquals(s.apiKey, '');
    store.save(s);
});

Deno.test('buildSetup: AUDIO modality, voice, optional language, transcription, compression, tools', () => {
    const tools = new ToolManager();
    const base = new SettingsStore({
        local: () => new MemoryStorage() as unknown as Storage,
        session: () => new MemoryStorage() as unknown as Storage,
    }).load();
    const setup = buildSetup({ ...base, voice: 'Kore', systemInstruction: '  Be nice. ' }, tools);
    assertEquals(setup.model, 'models/gemini-3.8-live');
    assertEquals(setup.generationConfig, {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    });
    assertEquals(setup.systemInstruction, { parts: [{ text: 'Be nice.' }] });
    assertEquals(setup.inputAudioTranscription, {});
    assertEquals(setup.outputAudioTranscription, {});
    assertEquals(setup.contextWindowCompression, { slidingWindow: {} });
    assertEquals(setup.tools, tools.getToolDeclarations());

    const withLang = buildSetup({ ...base, language: 'de-DE', model: 'models/custom', systemInstruction: '' }, tools);
    assertEquals(withLang.model, 'models/custom');
    assertEquals(
        (withLang.generationConfig as { speechConfig: { languageCode: string } }).speechConfig.languageCode,
        'de-DE',
    );
    assertEquals(withLang.systemInstruction, undefined);
});
