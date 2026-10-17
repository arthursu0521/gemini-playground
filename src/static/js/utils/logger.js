// @ts-check
/**
 * @fileoverview Console logger with an in-memory ring buffer (exportable for bug reports).
 * Values that look like credentials are masked before they are stored or printed.
 */
import { EventEmitter } from '../core/event-emitter.js';

/** @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel */
/** @typedef {{ timestamp: string, level: LogLevel, message: string, data?: unknown }} LogEntry */

const SECRET_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;

/** @param {unknown} data */
function mask(data) {
    if (data === undefined || data === null) return data;
    if (data instanceof Error) return { name: data.name, message: data.message.replace(SECRET_PATTERN, '[KEY]') };
    try {
        return JSON.parse(JSON.stringify(data).replace(SECRET_PATTERN, '[KEY]'));
    } catch {
        return String(data);
    }
}

export class Logger {
    static events = new EventEmitter();
    static maxStoredLogs = 1000;
    /** @type {LogEntry[]} */
    static logs = [];
    static debugEnabled = false;

    /**
     * @param {LogLevel} level
     * @param {string} message
     * @param {unknown} [data]
     */
    static log(level, message, data) {
        /** @type {LogEntry} */
        const entry = { timestamp: new Date().toISOString(), level, message, data: mask(data) };
        Logger.logs.push(entry);
        if (Logger.logs.length > Logger.maxStoredLogs) Logger.logs.shift();
        if (level !== 'debug' || Logger.debugEnabled) {
            const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
            if (entry.data === undefined) fn(`[${level}] ${message}`);
            else fn(`[${level}] ${message}`, entry.data);
        }
        Logger.events.emit('log', entry);
    }

    /** @param {string} message @param {unknown} [data] */
    static debug(message, data) {
        Logger.log('debug', message, data);
    }

    /** @param {string} message @param {unknown} [data] */
    static info(message, data) {
        Logger.log('info', message, data);
    }

    /** @param {string} message @param {unknown} [data] */
    static warn(message, data) {
        Logger.log('warn', message, data);
    }

    /** @param {string} message @param {unknown} [data] */
    static error(message, data) {
        Logger.log('error', message, data);
    }

    /** Downloads the stored logs as JSON. */
    static export() {
        const blob = new Blob([JSON.stringify(Logger.logs, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gemini-playground-logs-${new Date().toISOString()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
