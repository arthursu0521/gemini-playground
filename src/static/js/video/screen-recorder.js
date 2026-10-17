// @ts-check
/**
 * @fileoverview Screen sharing with preview and frame sampling.
 */
import { ApplicationError, ErrorCodes, mediaError } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { FrameCapturer } from './frame-capturer.js';

export class ScreenRecorder {
    /** @param {{ video: HTMLVideoElement, container: HTMLElement }} elements */
    constructor(elements) {
        this.video = elements.video;
        this.container = elements.container;
        /** @type {MediaStream | null} */
        this.stream = null;
        /** @type {FrameCapturer | null} */
        this.capturer = null;
    }

    get isActive() {
        return this.stream !== null;
    }

    /**
     * @param {number} fps
     * @param {(base64Jpeg: string) => void} onFrame
     * @param {() => void} [onEnded] called when the user stops sharing from the browser UI
     */
    async start(fps, onFrame, onEnded) {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            throw new ApplicationError(
                'Screen sharing is not supported in this browser',
                ErrorCodes.SCREEN_NOT_SUPPORTED,
            );
        }
        try {
            this.stream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 5 } },
                audio: false,
            });
        } catch (error) {
            throw mediaError(error, 'screen');
        }
        this.video.srcObject = this.stream;
        await this.video.play().catch(() => {});
        this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
            this.stop();
            onEnded?.();
        });
        this.capturer = new FrameCapturer({ fps, onFrame });
        this.capturer.start(this.video);
        this.container.hidden = false;
        Logger.info('Screen sharing started', { fps });
    }

    stop() {
        if (!this.stream) return;
        this.capturer?.stop();
        this.capturer = null;
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.video.srcObject = null;
        this.container.hidden = true;
        Logger.info('Screen sharing stopped');
    }
}
