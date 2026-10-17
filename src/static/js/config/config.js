// @ts-check
/**
 * @fileoverview Client defaults. Everything here can be changed in the settings panel;
 * nothing secret belongs in this file (it is served to every visitor).
 */

/** Live API models offered in the model picker. Any other model id can be typed in. */
export const LIVE_MODELS = [
    { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live (recommended)' },
    { id: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live - extended thinking' },
    { id: 'gemini-3.5-live-translate-preview', label: 'Gemini 3.5 Live Translate (preview)' },
    { id: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live (legacy)' },
    { id: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Flash native audio (restricted)' },
];

/** Prebuilt voices supported by the native-audio Live models. */
export const VOICES = [
    ['Zephyr', 'Bright'],
    ['Puck', 'Upbeat'],
    ['Charon', 'Informative'],
    ['Kore', 'Firm'],
    ['Fenrir', 'Excitable'],
    ['Leda', 'Youthful'],
    ['Orus', 'Firm'],
    ['Aoede', 'Breezy'],
    ['Callirrhoe', 'Easy-going'],
    ['Autonoe', 'Bright'],
    ['Enceladus', 'Breathy'],
    ['Iapetus', 'Clear'],
    ['Umbriel', 'Easy-going'],
    ['Algieba', 'Smooth'],
    ['Despina', 'Smooth'],
    ['Erinome', 'Clear'],
    ['Algenib', 'Gravelly'],
    ['Rasalgethi', 'Informative'],
    ['Laomedeia', 'Upbeat'],
    ['Achernar', 'Soft'],
    ['Alnilam', 'Firm'],
    ['Schedar', 'Even'],
    ['Gacrux', 'Mature'],
    ['Pulcherrima', 'Forward'],
    ['Achird', 'Friendly'],
    ['Zubenelgenubi', 'Casual'],
    ['Vindemiatrix', 'Gentle'],
    ['Sadachbia', 'Lively'],
    ['Sadaltager', 'Knowledgeable'],
    ['Sulafat', 'Warm'],
].map(([name, style]) => ({ name, style }));

export const CONFIG = Object.freeze({
    DEFAULTS: Object.freeze({
        MODEL: 'gemini-3.8-live',
        VOICE: 'Aoede',
        LANGUAGE: 'auto',
        RESPONSE_TYPE: 'audio',
        VIDEO_FPS: 1,
        SYSTEM_INSTRUCTION: 'You are my helpful assistant. You can see and hear me, and respond with voice and text. ' +
            'If you are asked about things you do not know, you can use the google search tool to find the answer.',
    }),
    AUDIO: Object.freeze({
        /** Gemini Live expects 16 kHz mono PCM16 input... */
        INPUT_SAMPLE_RATE: 16000,
        /** ...and returns 24 kHz mono PCM16. */
        OUTPUT_SAMPLE_RATE: 24000,
        /** Microphone chunk length sent per realtimeInput message. */
        CHUNK_MS: 100,
    }),
    VIDEO: Object.freeze({
        /** Gemini processes at most ~1 frame per second; more only costs bandwidth. */
        MAX_FPS: 5,
        /** Longest edge of frames sent to the model. */
        MAX_EDGE: 1024,
        JPEG_QUALITY: 0.7,
        /** Send at least every Nth frame even when nothing moves. */
        FORCE_EVERY: 10,
    }),
    UI: Object.freeze({
        MAX_LOG_ENTRIES: 500,
    }),
    CONNECTION: Object.freeze({
        SETUP_TIMEOUT_MS: 20000,
        MAX_RECONNECT_ATTEMPTS: 3,
    }),
});

export default CONFIG;
