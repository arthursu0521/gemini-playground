// @ts-check
/**
 * @fileoverview Application controller: wires the UI to the Live client, audio, video and tools.
 */
import { AudioPlayer } from './audio/audio-player.js';
import { AudioRecorder } from './audio/audio-recorder.js';
import { CONFIG, LIVE_MODELS, VOICES } from './config/config.js';
import { MultimodalLiveClient } from './core/websocket-client.js';
import { languages } from './language-selector.js';
import { SettingsStore } from './settings.js';
import { ToolManager } from './tools/tool-manager.js';
import { renderIcons, setIcon } from './ui/icons.js';
import { LogView } from './ui/log-view.js';
import { ApplicationError } from './utils/error-boundary.js';
import { Logger } from './utils/logger.js';
import { clampNumber } from './utils/utils.js';
import { ScreenRecorder } from './video/screen-recorder.js';
import { VideoManager } from './video/video-manager.js';

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return /** @type {T} */ (el);
}

/** @param {unknown} error */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the BidiGenerateContentSetup message from the settings.
 * @param {import('./settings.js').Settings} settings
 * @param {ToolManager} tools
 */
export function buildSetup(settings, tools) {
    const model = settings.model.trim() || CONFIG.DEFAULTS.MODEL;
    /** @type {Record<string, unknown>} */
    const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } };
    if (settings.language && settings.language !== 'auto') speechConfig.languageCode = settings.language;
    /** @type {Record<string, unknown>} */
    const setup = {
        model: model.startsWith('models/') ? model : `models/${model}`,
        // Native-audio Live models only produce AUDIO; text comes from the output transcription.
        generationConfig: { responseModalities: ['AUDIO'], speechConfig },
        tools: tools.getToolDeclarations(),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Sliding-window compression lifts the 15 min (audio) / 2 min (video) session limits.
        contextWindowCompression: { slidingWindow: {} },
    };
    if (settings.systemInstruction.trim()) {
        setup.systemInstruction = { parts: [{ text: settings.systemInstruction.trim() }] };
    }
    return setup;
}

export class App {
    constructor() {
        this.el = {
            apiKey: /** @type {HTMLInputElement} */ ($('api-key')),
            accessPassword: /** @type {HTMLInputElement} */ ($('access-password')),
            rememberKey: /** @type {HTMLInputElement} */ ($('remember-key')),
            configToggle: $('config-toggle'),
            configContainer: $('config-container'),
            model: /** @type {HTMLInputElement} */ ($('model-input')),
            modelList: $('model-list'),
            voice: /** @type {HTMLSelectElement} */ ($('voice-select')),
            language: /** @type {HTMLSelectElement} */ ($('language-select')),
            responseType: /** @type {HTMLSelectElement} */ ($('response-type-select')),
            fps: /** @type {HTMLInputElement} */ ($('fps-input')),
            systemInstruction: /** @type {HTMLTextAreaElement} */ ($('system-instruction')),
            debugToggle: /** @type {HTMLInputElement} */ ($('debug-toggle')),
            forgetKey: $('forget-key'),
            exportLogs: $('export-logs'),
            applyConfig: $('apply-config'),
            connect: /** @type {HTMLButtonElement} */ ($('connect-button')),
            status: $('status'),
            clearLogs: $('clear-logs'),
            logs: $('logs-container'),
            messageForm: /** @type {HTMLFormElement} */ ($('message-form')),
            message: /** @type {HTMLInputElement} */ ($('message-input')),
            send: /** @type {HTMLButtonElement} */ ($('send-button')),
            mic: /** @type {HTMLButtonElement} */ ($('mic-button')),
            camera: /** @type {HTMLButtonElement} */ ($('camera-button')),
            screen: /** @type {HTMLButtonElement} */ ($('screen-button')),
            inputLevel: /** @type {HTMLElement} */ ($('input-audio-visualizer').firstElementChild),
            outputLevel: /** @type {HTMLElement} */ ($('audio-visualizer').firstElementChild),
            videoContainer: $('video-container'),
            preview: /** @type {HTMLVideoElement} */ ($('preview')),
            framePreview: /** @type {HTMLCanvasElement} */ ($('frame-preview')),
            flipCamera: $('flip-camera'),
            stopVideo: $('stop-video'),
            screenContainer: $('screen-container'),
            screenPreview: /** @type {HTMLVideoElement} */ ($('screen-preview')),
            stopScreen: $('stop-screen'),
        };
        this.store = new SettingsStore();
        this.settings = this.store.load();
        this.log = new LogView(this.el.logs, { maxEntries: CONFIG.UI.MAX_LOG_ENTRIES });
        this.tools = new ToolManager();
        this.client = new MultimodalLiveClient({ toolManager: this.tools });
        this.player = new AudioPlayer();
        this.recorder = new AudioRecorder();
        this.camera = new VideoManager({
            video: this.el.preview,
            container: this.el.videoContainer,
            preview: this.el.framePreview,
        });
        this.screen = new ScreenRecorder({ video: this.el.screenPreview, container: this.el.screenContainer });
        this.busy = false;
    }

    start() {
        renderIcons();
        this.#populateSettings();
        this.#bindUi();
        this.#bindClient();
        this.#setConnected(false);
        void this.#loadServerConfig();
        globalThis.addEventListener('unhandledrejection', (event) => {
            Logger.error('Unhandled error', event.reason);
            this.log.add('error', errorMessage(event.reason));
        });
    }

    // -----------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------

    #populateSettings() {
        const { el, settings } = this;
        for (const model of LIVE_MODELS) {
            const option = document.createElement('option');
            option.value = model.id;
            option.label = model.label;
            el.modelList.append(option);
        }
        for (const voice of VOICES) el.voice.add(new Option(`${voice.name} (${voice.style})`, voice.name));
        el.language.add(new Option('Auto-detect', 'auto'));
        for (const lang of languages) el.language.add(new Option(lang.name, lang.code));

        el.apiKey.value = settings.apiKey;
        el.accessPassword.value = settings.accessPassword;
        el.rememberKey.checked = settings.rememberKey;
        el.model.value = settings.model;
        el.voice.value = settings.voice;
        el.language.value = settings.language;
        if (!el.language.value) el.language.value = 'auto';
        el.responseType.value = settings.responseType;
        el.fps.value = String(settings.fps);
        el.systemInstruction.value = settings.systemInstruction;
        el.debugToggle.checked = settings.showDebug;
        this.log.setShowDebug(settings.showDebug);
        Logger.debugEnabled = settings.showDebug;
    }

    #readSettings() {
        const { el } = this;
        /** @type {import('./settings.js').Settings} */
        const settings = {
            apiKey: el.apiKey.value.trim(),
            accessPassword: el.accessPassword.value,
            rememberKey: el.rememberKey.checked,
            model: el.model.value.trim() || CONFIG.DEFAULTS.MODEL,
            voice: el.voice.value || CONFIG.DEFAULTS.VOICE,
            language: el.language.value || 'auto',
            responseType: el.responseType.value === 'text' ? 'text' : 'audio',
            fps: clampNumber(el.fps.value, 1, CONFIG.VIDEO.MAX_FPS, CONFIG.DEFAULTS.VIDEO_FPS),
            systemInstruction: el.systemInstruction.value,
            showDebug: el.debugToggle.checked,
        };
        el.fps.value = String(settings.fps);
        this.settings = settings;
        this.store.save(settings);
        return settings;
    }

    async #loadServerConfig() {
        try {
            const res = await fetch('api/config', { headers: { accept: 'application/json' } });
            if (!res.ok) return;
            const config = await res.json();
            if (config.serverKeyAvailable) {
                this.el.accessPassword.hidden = false;
                this.el.apiKey.placeholder = 'Gemini API key (optional)';
            }
        } catch {
            // Static hosting without the server: keep the API key field only.
        }
    }

    // -----------------------------------------------------------------------------------------
    // UI events
    // -----------------------------------------------------------------------------------------

    #bindUi() {
        const { el } = this;
        const toggleConfig = () => {
            const open = el.configContainer.classList.toggle('active');
            el.configToggle.setAttribute('aria-expanded', String(open));
            if (!open) this.#readSettings();
        };
        el.configToggle.addEventListener('click', toggleConfig);
        el.applyConfig.addEventListener('click', toggleConfig);
        el.debugToggle.addEventListener('change', () => {
            this.log.setShowDebug(el.debugToggle.checked);
            Logger.debugEnabled = el.debugToggle.checked;
            this.#readSettings();
        });
        el.rememberKey.addEventListener('change', () => this.#readSettings());
        el.forgetKey.addEventListener('click', () => {
            this.store.forgetCredentials();
            el.apiKey.value = '';
            el.accessPassword.value = '';
            el.rememberKey.checked = false;
            this.log.add('system', 'Saved key removed from this browser');
        });
        el.exportLogs.addEventListener('click', () => Logger.export());
        el.clearLogs.addEventListener('click', () => this.log.clear());
        el.responseType.addEventListener('change', () => {
            this.player.setMuted(el.responseType.value === 'text');
            this.#readSettings();
        });

        el.connect.addEventListener('click', () => {
            if (this.client.isReady || this.client.state === 'connecting') this.disconnect();
            else void this.connect();
        });
        el.messageForm.addEventListener('submit', (event) => {
            event.preventDefault();
            this.#sendMessage();
        });
        el.mic.addEventListener('click', () => void this.#toggleMic());
        el.camera.addEventListener('click', () => void this.#toggleCamera());
        el.stopVideo.addEventListener('click', () => this.#stopCamera());
        el.flipCamera.addEventListener('click', () => {
            this.camera.flip().catch((error) => this.log.add('error', errorMessage(error)));
        });
        el.framePreview.addEventListener('click', () => el.framePreview.classList.toggle('enlarged'));
        el.screen.addEventListener('click', () => void this.#toggleScreen());
        el.stopScreen.addEventListener('click', () => this.#stopScreen());
    }

    // -----------------------------------------------------------------------------------------
    // Connection
    // -----------------------------------------------------------------------------------------

    async connect() {
        if (this.busy) return;
        const settings = this.#readSettings();
        if (!settings.apiKey && !settings.accessPassword) {
            this.log.add('error', 'Enter a Gemini API key (or the access password) first');
            this.el.apiKey.focus();
            return;
        }
        this.busy = true;
        this.#setStatus('Connecting...');
        this.el.connect.disabled = true;
        try {
            // Created inside the click handler so browsers allow audio playback.
            try {
                await this.player.resume();
            } catch (error) {
                this.log.add('error', `Audio output unavailable, continuing with text: ${errorMessage(error)}`);
            }
            this.player.setMuted(settings.responseType === 'text');
            await this.client.connect(buildSetup(settings, this.tools), {
                apiKey: settings.apiKey || undefined,
                accessPassword: settings.accessPassword || undefined,
            });
            this.#setConnected(true);
            this.log.add('system', `Connected to ${settings.model}`);
        } catch (error) {
            Logger.error('Connection failed', error);
            this.log.add('error', `Connection failed: ${errorMessage(error)}`);
            this.#setConnected(false);
        } finally {
            this.busy = false;
            this.el.connect.disabled = false;
        }
    }

    disconnect() {
        this.client.disconnect();
        this.#stopMediaAndReset();
        this.log.add('system', 'Disconnected');
    }

    #stopMediaAndReset() {
        void this.#stopMic();
        this.#stopCamera();
        this.#stopScreen();
        this.player.clear();
        this.log.endStream();
        this.#setConnected(false);
    }

    /** @param {boolean} connected */
    #setConnected(connected) {
        const { el } = this;
        el.connect.textContent = connected ? 'Disconnect' : 'Connect';
        el.connect.classList.toggle('connected', connected);
        for (const control of [el.message, el.send, el.mic, el.camera, el.screen]) control.disabled = !connected;
        this.#setStatus(connected ? 'Connected' : 'Disconnected');
    }

    /** @param {string} text */
    #setStatus(text) {
        this.el.status.textContent = text;
    }

    #bindClient() {
        const { client, log, player } = this;
        client.on('audio', (/** @type {ArrayBuffer} */ data) => player.play(data));
        client.on('text', (/** @type {string} */ text) => log.stream('ai', text));
        client.on('outputtranscription', (/** @type {string} */ text) => log.stream('ai', text));
        client.on('inputtranscription', (/** @type {string} */ text) => log.stream('user', text));
        client.on('thought', (/** @type {string} */ text) => log.add('debug', `Thinking: ${text}`));
        client.on('interrupted', () => {
            player.clear();
            log.endStream('ai');
            log.add('debug', 'Model interrupted');
        });
        client.on('generationcomplete', () => player.flush());
        client.on('turncomplete', () => {
            player.flush();
            log.endStream();
        });
        client.on('toolcall', (/** @type {any[]} */ calls) => {
            for (const call of calls) log.add('system', `Using tool ${call.name}`);
        });
        client.on('reconnecting', (/** @type {{attempt: number, resumable: boolean}} */ info) => {
            this.#setStatus('Reconnecting...');
            log.add('system', `Reconnecting (attempt ${info.attempt})${info.resumable ? ', resuming session' : ''}`);
        });
        client.on('reconnected', (/** @type {{resumed: boolean}} */ info) => {
            this.#setStatus('Connected');
            log.add('system', info.resumed ? 'Session resumed' : 'Reconnected (new session)');
        });
        client.on('close', (/** @type {{code: number, reason: string}} */ info) => {
            log.add('error', info.reason);
            this.#stopMediaAndReset();
        });
        client.on('log', (/** @type {{type: string, message: string}} */ entry) => {
            log.add('debug', `${entry.type}: ${entry.message}`);
        });
        player.onLevel = (level) => this.#setLevel(this.el.outputLevel, level);
    }

    #sendMessage() {
        const text = this.el.message.value.trim();
        if (!text) return;
        try {
            this.log.endStream();
            this.log.add('user', text);
            this.client.sendText(text);
            this.el.message.value = '';
        } catch (error) {
            this.log.add('error', errorMessage(error));
        }
    }

    // -----------------------------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------------------------

    /**
     * @param {HTMLElement} bar
     * @param {number} level 0..1
     */
    #setLevel(bar, level) {
        bar.style.width = `${Math.round(level * 100)}%`;
    }

    /**
     * @param {HTMLButtonElement} button
     * @param {boolean} active
     * @param {string} icon
     * @param {string} label
     */
    #setToggle(button, active, icon, label) {
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', label);
        setIcon(button, icon);
    }

    async #toggleMic() {
        if (this.recorder.isRecording) {
            await this.#stopMic();
            this.client.sendAudioStreamEnd();
            return;
        }
        try {
            await this.player.resume();
            await this.recorder.start(
                (base64) => this.client.sendAudio(base64),
                (level) => this.#setLevel(this.el.inputLevel, level),
            );
            this.#setToggle(this.el.mic, true, 'mic-off', 'Stop microphone');
            this.log.add('system', 'Microphone on');
        } catch (error) {
            this.log.add('error', errorMessage(error));
        }
    }

    async #stopMic() {
        if (!this.recorder.isRecording) return;
        await this.recorder.stop();
        this.#setLevel(this.el.inputLevel, 0);
        this.#setToggle(this.el.mic, false, 'mic', 'Start microphone');
        this.log.add('system', 'Microphone off');
    }

    async #toggleCamera() {
        if (this.camera.isActive) {
            this.#stopCamera();
            return;
        }
        try {
            await this.camera.start(this.settings.fps, (base64) => this.client.sendVideo(base64));
            this.#setToggle(this.el.camera, true, 'video-off', 'Stop camera');
            this.log.add('system', 'Camera on');
        } catch (error) {
            this.camera.stop();
            this.log.add('error', errorMessage(error));
        }
    }

    #stopCamera() {
        if (!this.camera.isActive) return;
        this.camera.stop();
        this.#setToggle(this.el.camera, false, 'video', 'Start camera');
        this.log.add('system', 'Camera off');
    }

    async #toggleScreen() {
        if (this.screen.isActive) {
            this.#stopScreen();
            return;
        }
        try {
            await this.screen.start(this.settings.fps, (base64) => this.client.sendVideo(base64), () => {
                this.#setToggle(this.el.screen, false, 'monitor', 'Share screen');
                this.log.add('system', 'Screen sharing ended');
            });
            this.#setToggle(this.el.screen, true, 'monitor-off', 'Stop sharing');
            this.log.add('system', 'Screen sharing on');
        } catch (error) {
            if (error instanceof ApplicationError && error.code === 'SCREEN_PERMISSION_DENIED') {
                this.log.add('system', 'Screen sharing cancelled');
            } else {
                this.log.add('error', errorMessage(error));
            }
        }
    }

    #stopScreen() {
        if (!this.screen.isActive) return;
        this.screen.stop();
        this.#setToggle(this.el.screen, false, 'monitor', 'Share screen');
        this.log.add('system', 'Screen sharing off');
    }
}
