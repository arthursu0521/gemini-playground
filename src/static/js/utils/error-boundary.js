// @ts-check
/**
 * @fileoverview Application error type with stable error codes.
 */

/** @enum {string} */
export const ErrorCodes = Object.freeze({
    AUDIO_NOT_SUPPORTED: 'AUDIO_NOT_SUPPORTED',
    AUDIO_PERMISSION_DENIED: 'AUDIO_PERMISSION_DENIED',
    AUDIO_INITIALIZATION_FAILED: 'AUDIO_INITIALIZATION_FAILED',

    WEBSOCKET_CONNECTION_FAILED: 'WEBSOCKET_CONNECTION_FAILED',
    WEBSOCKET_NOT_CONNECTED: 'WEBSOCKET_NOT_CONNECTED',
    SETUP_TIMEOUT: 'SETUP_TIMEOUT',
    AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',

    VIDEO_NOT_SUPPORTED: 'VIDEO_NOT_SUPPORTED',
    VIDEO_PERMISSION_DENIED: 'VIDEO_PERMISSION_DENIED',
    VIDEO_START_FAILED: 'VIDEO_START_FAILED',

    SCREEN_NOT_SUPPORTED: 'SCREEN_NOT_SUPPORTED',
    SCREEN_PERMISSION_DENIED: 'SCREEN_PERMISSION_DENIED',
    SCREEN_START_FAILED: 'SCREEN_START_FAILED',

    TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
    INVALID_STATE: 'INVALID_STATE',
    INVALID_PARAMETER: 'INVALID_PARAMETER',
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
});

export class ApplicationError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     * @param {Record<string, unknown>} [details]
     */
    constructor(message, code = ErrorCodes.UNKNOWN_ERROR, details = {}) {
        super(message);
        this.name = 'ApplicationError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date().toISOString();
    }

    toJSON() {
        return { name: this.name, message: this.message, code: this.code, timestamp: this.timestamp };
    }
}

/**
 * Turns getUserMedia / getDisplayMedia failures into readable errors.
 * @param {unknown} error
 * @param {'microphone' | 'camera' | 'screen'} device
 * @returns {ApplicationError}
 */
export function mediaError(error, device) {
    const name = error instanceof Error ? error.name : '';
    const codes = {
        microphone: [ErrorCodes.AUDIO_PERMISSION_DENIED, ErrorCodes.AUDIO_INITIALIZATION_FAILED],
        camera: [ErrorCodes.VIDEO_PERMISSION_DENIED, ErrorCodes.VIDEO_START_FAILED],
        screen: [ErrorCodes.SCREEN_PERMISSION_DENIED, ErrorCodes.SCREEN_START_FAILED],
    }[device];
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return new ApplicationError(`Permission to use the ${device} was denied`, codes[0], { cause: name });
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return new ApplicationError(`No ${device} found`, codes[1], { cause: name });
    }
    if (name === 'NotReadableError') {
        return new ApplicationError(`The ${device} is in use by another application`, codes[1], { cause: name });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ApplicationError(`Could not start the ${device}: ${message}`, codes[1], { cause: name });
}
