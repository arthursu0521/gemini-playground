// @ts-check
/**
 * @fileoverview Samples frames from a <video> element, scales them down, skips frames when nothing
 * moved and encodes JPEG off the main thread via canvas.toBlob(). Shared by camera and screen.
 */
import { CONFIG } from '../config/config.js';
import { arrayBufferToBase64 } from '../utils/utils.js';

/**
 * Fits width x height inside a square of `maxEdge`, keeping the aspect ratio.
 * @param {number} width
 * @param {number} height
 * @param {number} maxEdge
 */
export function fitWithin(width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Mean absolute luma difference between two RGBA thumbnails (0..255).
 * @param {Uint8ClampedArray} a
 * @param {Uint8ClampedArray} b
 */
export function frameDifference(a, b) {
    if (a.length !== b.length || a.length === 0) return 255;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) {
        const la = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
        const lb = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
        diff += Math.abs(la - lb);
    }
    return diff / (a.length / 4);
}

export class FrameCapturer {
    /**
     * @param {{
     *   fps?: number, maxEdge?: number, quality?: number,
     *   motionThreshold?: number, forceEvery?: number,
     *   onFrame: (base64Jpeg: string) => void,
     *   preview?: HTMLCanvasElement | null,
     * }} options
     */
    constructor(options) {
        this.fps = options.fps ?? 1;
        this.maxEdge = options.maxEdge ?? CONFIG.VIDEO.MAX_EDGE;
        this.quality = options.quality ?? CONFIG.VIDEO.JPEG_QUALITY;
        this.motionThreshold = options.motionThreshold ?? 2;
        this.forceEvery = options.forceEvery ?? CONFIG.VIDEO.FORCE_EVERY;
        this.onFrame = options.onFrame;
        this.preview = options.preview ?? null;
        this.canvas = document.createElement('canvas');
        this.thumb = document.createElement('canvas');
        this.thumb.width = 32;
        this.thumb.height = 24;
        /** @type {Uint8ClampedArray | null} */
        this.lastThumb = null;
        this.skipped = 0;
        this.framesSent = 0;
        this.running = false;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        this.timer = undefined;
        /** @type {HTMLVideoElement | null} */
        this.video = null;
    }

    /** @param {HTMLVideoElement} video */
    start(video) {
        this.video = video;
        this.running = true;
        this.lastThumb = null;
        this.skipped = 0;
        void this.#tick();
    }

    stop() {
        this.running = false;
        clearTimeout(this.timer);
        this.video = null;
    }

    async #tick() {
        if (!this.running) return;
        const started = performance.now();
        try {
            await this.#capture();
        } catch (error) {
            console.warn('Frame capture failed', error);
        }
        if (!this.running) return;
        const interval = 1000 / this.fps;
        this.timer = setTimeout(() => void this.#tick(), Math.max(0, interval - (performance.now() - started)));
    }

    #hasMotion() {
        if (this.motionThreshold <= 0 || !this.video) return true;
        const ctx = this.thumb.getContext('2d', { willReadFrequently: true });
        if (!ctx) return true;
        ctx.drawImage(this.video, 0, 0, this.thumb.width, this.thumb.height);
        const current = ctx.getImageData(0, 0, this.thumb.width, this.thumb.height).data;
        const previous = this.lastThumb;
        if (
            previous && frameDifference(previous, current) < this.motionThreshold && this.skipped + 1 < this.forceEvery
        ) {
            this.skipped++;
            return false;
        }
        this.lastThumb = current;
        this.skipped = 0;
        return true;
    }

    async #capture() {
        const video = this.video;
        if (!video || video.readyState < 2 || !video.videoWidth) return;
        if (!this.#hasMotion()) return;
        const { width, height } = fitWithin(video.videoWidth, video.videoHeight, this.maxEdge);
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, width, height);
        if (this.preview) {
            const pctx = this.preview.getContext('2d');
            pctx?.drawImage(this.canvas, 0, 0, this.preview.width, this.preview.height);
        }
        const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, 'image/jpeg', this.quality));
        if (!blob || !this.running) return;
        const base64 = arrayBufferToBase64(await /** @type {Blob} */ (blob).arrayBuffer());
        this.framesSent++;
        this.onFrame(base64);
    }
}
