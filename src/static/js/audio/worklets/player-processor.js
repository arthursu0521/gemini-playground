// @ts-check
/**
 * @fileoverview AudioWorklet that plays a stream of 24 kHz PCM chunks gaplessly.
 * A queue lives on the audio thread, so playback is not disturbed by main-thread jank and an
 * interruption (`clear`) silences output within one render quantum (~3 ms).
 * Self-contained on purpose: AudioWorklet module imports are not supported everywhere.
 */

/** FIFO of Float32 chunks with a read offset; avoids reallocating on every push. */
export class SampleQueue {
    constructor() {
        /** @type {Float32Array[]} */
        this.chunks = [];
        this.offset = 0;
        this.length = 0;
    }

    /** @param {Float32Array} chunk */
    push(chunk) {
        if (chunk.length === 0) return;
        this.chunks.push(chunk);
        this.length += chunk.length;
    }

    /**
     * Fills `out` from the queue.
     * @param {Float32Array} out
     * @returns {number} samples written
     */
    read(out) {
        let written = 0;
        while (written < out.length && this.chunks.length > 0) {
            const head = this.chunks[0];
            const n = Math.min(out.length - written, head.length - this.offset);
            out.set(head.subarray(this.offset, this.offset + n), written);
            written += n;
            this.offset += n;
            if (this.offset === head.length) {
                this.chunks.shift();
                this.offset = 0;
            }
        }
        this.length -= written;
        return written;
    }

    clear() {
        this.chunks = [];
        this.offset = 0;
        this.length = 0;
    }
}

/** Streaming linear resampler (used only when the AudioContext could not run at 24 kHz). */
export class LinearResampler {
    /**
     * @param {number} inputRate
     * @param {number} outputRate
     */
    constructor(inputRate, outputRate) {
        this.step = inputRate / outputRate;
        this.position = 0;
        this.last = 0;
    }

    /**
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    process(input) {
        if (this.step === 1) return input;
        const out = [];
        // Virtual buffer: [last, ...input]; position is relative to `last` (index 0).
        while (this.position < input.length) {
            const i = Math.floor(this.position);
            const frac = this.position - i;
            const a = i === 0 ? this.last : input[i - 1];
            const b = input[i];
            out.push(a + (b - a) * frac);
            this.position += this.step;
        }
        this.position -= input.length;
        this.last = input[input.length - 1] ?? this.last;
        return Float32Array.from(out);
    }

    reset() {
        this.position = 0;
        this.last = 0;
    }
}

/** @type {any} */
const Base = /** @type {any} */ (globalThis).AudioWorkletProcessor ?? class {
    constructor() {
        /** @type {any} */
        this.port = { postMessage() {}, onmessage: null };
    }
};

export class PcmPlayerProcessor extends Base {
    /** @param {{ processorOptions?: { inputSampleRate?: number, outputSampleRate?: number, startThresholdMs?: number } }} [options] */
    constructor(options = {}) {
        super();
        const opts = options.processorOptions ?? {};
        const outputRate = opts.outputSampleRate ?? /** @type {any} */ (globalThis).sampleRate ?? 24000;
        const inputRate = opts.inputSampleRate ?? outputRate;
        this.resampler = inputRate === outputRate ? null : new LinearResampler(inputRate, outputRate);
        this.queue = new SampleQueue();
        this.playing = false;
        this.flushRequested = false;
        /** Jitter buffer: wait for this much audio before starting (or after an underrun). */
        this.startThreshold = Math.round(((opts.startThresholdMs ?? 80) / 1000) * outputRate);
        /** Start anyway after waiting this long with *some* audio queued. */
        this.maxWaitFrames = Math.round(0.25 * outputRate);
        this.waitedFrames = 0;
        this.volumeInterval = Math.round(0.05 * outputRate);
        this.framesSinceVolume = 0;
        this.sumSquares = 0;
        this.volumeFrames = 0;
        this.port.onmessage = (/** @type {MessageEvent} */ event) => this.onMessage(event.data);
    }

    /** @param {{ type: string, samples?: Float32Array }} message */
    onMessage(message) {
        switch (message?.type) {
            case 'push':
                if (message.samples) {
                    this.queue.push(this.resampler ? this.resampler.process(message.samples) : message.samples);
                }
                break;
            case 'flush':
                this.flushRequested = true;
                break;
            case 'clear':
                this.queue.clear();
                this.resampler?.reset();
                this.playing = false;
                this.flushRequested = false;
                this.waitedFrames = 0;
                this.port.postMessage({ type: 'cleared' });
                break;
        }
    }

    /**
     * @param {Float32Array[][]} _inputs
     * @param {Float32Array[][]} outputs
     */
    process(_inputs, outputs) {
        const out = outputs[0]?.[0];
        if (!out) return true;
        if (!this.playing && this.queue.length > 0) {
            this.waitedFrames += out.length;
            if (
                this.queue.length >= this.startThreshold || this.flushRequested ||
                this.waitedFrames >= this.maxWaitFrames
            ) {
                this.playing = true;
                this.waitedFrames = 0;
                this.port.postMessage({ type: 'playing' });
            }
        }
        let written = 0;
        if (this.playing) {
            written = this.queue.read(out);
            if (this.queue.length === 0) {
                this.playing = false;
                this.flushRequested = false;
                this.port.postMessage({ type: 'drained' });
            }
        }
        out.fill(0, written);
        for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

        for (let i = 0; i < out.length; i++) this.sumSquares += out[i] * out[i];
        this.volumeFrames += out.length;
        this.framesSinceVolume += out.length;
        if (this.framesSinceVolume >= this.volumeInterval) {
            this.port.postMessage({ type: 'volume', value: Math.sqrt(this.sumSquares / this.volumeFrames) });
            this.framesSinceVolume = 0;
            this.sumSquares = 0;
            this.volumeFrames = 0;
        }
        return true;
    }
}

if (typeof (/** @type {any} */ (globalThis).registerProcessor) === 'function') {
    /** @type {any} */ (globalThis).registerProcessor('pcm-player', PcmPlayerProcessor);
}
