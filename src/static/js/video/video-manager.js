// @ts-check
/**
 * @fileoverview Camera capture with preview, front/back switching and frame sampling.
 */
import { ApplicationError, ErrorCodes, mediaError } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { FrameCapturer } from './frame-capturer.js';

export class VideoManager {
    /**
     * @param {{ video: HTMLVideoElement, container: HTMLElement, preview?: HTMLCanvasElement | null }} elements
     */
    constructor(elements) {
        this.video = elements.video;
        this.container = elements.container;
        this.preview = elements.preview ?? null;
        /** @type {MediaStream | null} */
        this.stream = null;
        /** @type {FrameCapturer | null} */
        this.capturer = null;
        /** @type {'user' | 'environment'} */
        this.facingMode = 'user';
        this.fps = 1;
        /** @type {((base64: string) => void) | null} */
        this.onFrame = null;
    }

    get isActive() {
        return this.stream !== null;
    }

    /**
     * @param {number} fps
     * @param {(base64Jpeg: string) => void} onFrame
     */
    async start(fps, onFrame) {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new ApplicationError(
                'Camera capture is not supported in this browser',
                ErrorCodes.VIDEO_NOT_SUPPORTED,
            );
        }
        this.fps = fps;
        this.onFrame = onFrame;
        await this.#openStream();
        this.capturer = new FrameCapturer({ fps, onFrame, preview: this.preview });
        this.capturer.start(this.video);
        this.container.hidden = false;
        Logger.info('Camera started', { fps, facingMode: this.facingMode });
    }

    async #openStream() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: this.facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false,
            });
        } catch (error) {
            throw mediaError(error, 'camera');
        }
        this.video.srcObject = this.stream;
        await this.video.play().catch(() => {});
    }

    /** Switches between the front and back camera without restarting frame capture. */
    async flip() {
        if (!this.stream) return;
        const previous = this.facingMode;
        this.facingMode = previous === 'user' ? 'environment' : 'user';
        this.stream.getTracks().forEach((track) => track.stop());
        try {
            await this.#openStream();
            Logger.info('Camera flipped', { facingMode: this.facingMode });
        } catch (error) {
            this.facingMode = previous;
            await this.#openStream();
            throw error;
        }
    }

    stop() {
        this.capturer?.stop();
        this.capturer = null;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.video.srcObject = null;
        this.container.hidden = true;
        Logger.info('Camera stopped');
    }
}
