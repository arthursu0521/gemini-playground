// @ts-check
/**
 * @fileoverview User settings persisted in Web Storage.
 *
 * The API key is kept in sessionStorage (gone when the tab closes) unless the user ticks
 * "Remember key", in which case it goes to localStorage. Keys are the same as in earlier versions,
 * so existing users keep their settings.
 */
import { CONFIG } from './config/config.js';
import { clampNumber } from './utils/utils.js';

/**
 * @typedef {{
 *   apiKey: string, rememberKey: boolean, accessPassword: string,
 *   model: string, voice: string, language: string, responseType: 'audio' | 'text',
 *   fps: number, systemInstruction: string, showDebug: boolean,
 * }} Settings
 */

const KEYS = {
    apiKey: 'gemini_api_key',
    rememberKey: 'gemini_remember_key',
    model: 'gemini_model',
    voice: 'gemini_voice',
    language: 'gemini_language',
    responseType: 'gemini_response_type',
    fps: 'video_fps',
    systemInstruction: 'system_instruction',
    showDebug: 'gemini_show_debug',
};

/**
 * Storage access can throw (privacy modes, blocked cookies); never let that break the app.
 * @param {() => Storage} getStorage
 */
function safeStorage(getStorage) {
    return {
        /** @param {string} key */
        get(key) {
            try {
                return getStorage().getItem(key);
            } catch {
                return null;
            }
        },
        /** @param {string} key @param {string} value */
        set(key, value) {
            try {
                getStorage().setItem(key, value);
            } catch { /* ignore */ }
        },
        /** @param {string} key */
        remove(key) {
            try {
                getStorage().removeItem(key);
            } catch { /* ignore */ }
        },
    };
}

export class SettingsStore {
    /**
     * @param {{ local?: () => Storage, session?: () => Storage }} [storages]
     */
    constructor(storages = {}) {
        this.local = safeStorage(storages.local ?? (() => globalThis.localStorage));
        this.session = safeStorage(storages.session ?? (() => globalThis.sessionStorage));
    }

    /** @returns {Settings} */
    load() {
        const local = this.local;
        const legacyKey = local.get(KEYS.apiKey);
        const rememberFlag = local.get(KEYS.rememberKey);
        // Older versions always stored the key in localStorage: treat that as "remember".
        const rememberKey = rememberFlag === null ? Boolean(legacyKey) : rememberFlag === 'true';
        const apiKey = (rememberKey ? legacyKey : this.session.get(KEYS.apiKey)) ?? '';
        const responseType = local.get(KEYS.responseType) === 'text' ? 'text' : 'audio';
        return {
            apiKey,
            rememberKey,
            accessPassword: this.session.get('gemini_access_password') ?? '',
            model: local.get(KEYS.model) || CONFIG.DEFAULTS.MODEL,
            voice: local.get(KEYS.voice) || CONFIG.DEFAULTS.VOICE,
            language: local.get(KEYS.language) || CONFIG.DEFAULTS.LANGUAGE,
            responseType,
            fps: clampNumber(local.get(KEYS.fps), 1, CONFIG.VIDEO.MAX_FPS, CONFIG.DEFAULTS.VIDEO_FPS),
            systemInstruction: local.get(KEYS.systemInstruction) ?? CONFIG.DEFAULTS.SYSTEM_INSTRUCTION,
            showDebug: local.get(KEYS.showDebug) === 'true',
        };
    }

    /** @param {Settings} settings */
    save(settings) {
        const { local, session } = this;
        local.set(KEYS.rememberKey, String(settings.rememberKey));
        if (settings.rememberKey) {
            local.set(KEYS.apiKey, settings.apiKey);
            session.remove(KEYS.apiKey);
        } else {
            session.set(KEYS.apiKey, settings.apiKey);
            local.remove(KEYS.apiKey);
        }
        // The access password only lives for the tab session.
        if (settings.accessPassword) session.set('gemini_access_password', settings.accessPassword);
        else session.remove('gemini_access_password');
        local.set(KEYS.model, settings.model);
        local.set(KEYS.voice, settings.voice);
        local.set(KEYS.language, settings.language);
        local.set(KEYS.responseType, settings.responseType);
        local.set(KEYS.fps, String(settings.fps));
        local.set(KEYS.systemInstruction, settings.systemInstruction);
        local.set(KEYS.showDebug, String(settings.showDebug));
    }

    /** Removes the stored API key and password from both storages. */
    forgetCredentials() {
        this.local.remove(KEYS.apiKey);
        this.session.remove(KEYS.apiKey);
        this.session.remove('gemini_access_password');
        this.local.set(KEYS.rememberKey, 'false');
    }
}
