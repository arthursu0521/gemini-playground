// @ts-check
/**
 * @fileoverview AudioWorklet that turns microphone audio at the device rate (44.1/48 kHz...)
 * into 16 kHz mono PCM16 chunks. Resampling happens here, so the AudioContext can run at the
 * native rate (Firefox refuses to connect a mic to a context with a different sample rate).
 * Self-contained on purpose: AudioWorklet module imports are not supported everywhere.
 */

/* global sampleRate, registerProcessor */

/**
 * Streaming band-limited resampler: windowed-sinc (Hann) low-pass evaluated at fractional input
 * positions, so it handles any ratio (48k -> 16k, 44.1k -> 16k, ...) without aliasing.
 * The kernel is tabulated at 64 sub-sample phases to keep the audio thread cheap.
 */
export class Downsampler {
    static PHASES = 64;

    /**
     * @param {number} inputRate
     * @param {number} outputRate
     * @param {{ zeroCrossings?: number }} [options] kernel half-width in output samples
     */
    constructor(inputRate, outputRate, options = {}) {
        this.ratio = inputRate / outputRate;
        // Normalised cutoff (1 = input Nyquist): 90% of the output Nyquist when downsampling.
        this.cutoff = 0.9 * Math.min(1, 1 / this.ratio);
        /** Kernel half-width in input samples. */
        this.half = Math.ceil((options.zeroCrossings ?? 8) * Math.max(1, this.ratio));
        const size = 2 * this.half * Downsampler.PHASES + 1;
        this.table = new Float32Array(size + 1);
        for (let i = 0; i <= size; i++) {
            const x = i / Downsampler.PHASES - this.half;
            const sinc = x === 0 ? this.cutoff : Math.sin(Math.PI * this.cutoff * x) / (Math.PI * x);
            const window = Math.abs(x) >= this.half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / this.half);
            this.table[i] = sinc * window;
        }
        // History so the first outputs have their left context (zeros = silence).
        /** @type {Float32Array} */
        this.buffer = new Float32Array(this.half);
        /** Time of the next output sample, as an index into `buffer`. */
        this.position = this.half;
    }

    /** @param {number} x offset in input samples, |x| <= half */
    kernel(x) {
        const t = (x + this.half) * Downsampler.PHASES;
        const i = Math.floor(t);
        const frac = t - i;
        return this.table[i] * (1 - frac) + this.table[i + 1] * frac;
    }

    /**
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    process(input) {
        if (this.ratio === 1) return input.slice();
        const buffer = new Float32Array(this.buffer.length + input.length);
        buffer.set(this.buffer);
        buffer.set(input, this.buffer.length);

        const out = [];
        // An output needs `half` samples of look-ahead.
        while (this.position + this.half < buffer.length) {
            const center = this.position;
            const start = Math.ceil(center - this.half);
            const end = Math.floor(center + this.half);
            let acc = 0;
            let weight = 0;
            for (let k = start; k <= end; k++) {
                const h = this.kernel(k - center);
                acc += buffer[k] * h;
                weight += h;
            }
            out.push(weight === 0 ? 0 : acc / weight); // normalise: unity gain at DC
            this.position += this.ratio;
        }
        const keepFrom = Math.max(0, Math.floor(this.position - this.half) - 1);
        this.buffer = buffer.slice(keepFrom);
        this.position -= keepFrom;
        return Float32Array.from(out);
    }
}

/**
 * @param {number} sample float in [-1, 1]
 * @returns {number} int16
 */
export function floatToInt16(sample) {
    const s = Math.max(-1, Math.min(1, sample));
    return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/** @type {any} */
const Base = /** @type {any} */ (globalThis).AudioWorkletProcessor ?? class {
    constructor() {
        /** @type {any} */
        this.port = { postMessage() {}, onmessage: null };
    }
};

export class PcmCaptureProcessor extends Base {
    /** @param {{ processorOptions?: { targetSampleRate?: number, chunkSamples?: number, inputSampleRate?: number } }} [options] */
    constructor(options = {}) {
        super();
        const opts = options.processorOptions ?? {};
        const target = opts.targetSampleRate ?? 16000;
        // `sampleRate` is a global inside AudioWorkletGlobalScope.
        const inputRate = opts.inputSampleRate ?? /** @type {any} */ (globalThis).sampleRate ?? 48000;
        this.downsampler = new Downsampler(inputRate, target);
        this.chunk = new Int16Array(opts.chunkSamples ?? 1600);
        this.index = 0;
        this.sumSquares = 0;
        this.port.onmessage = (/** @type {MessageEvent} */ event) => {
            if (event.data?.type === 'flush') this.emit();
        };
    }

    emit() {
        if (this.index === 0) return;
        const pcm = this.chunk.slice(0, this.index);
        const rms = Math.sqrt(this.sumSquares / this.index);
        this.port.postMessage({ type: 'chunk', pcm: pcm.buffer, rms }, [pcm.buffer]);
        this.index = 0;
        this.sumSquares = 0;
    }

    /** @param {Float32Array[][]} inputs */
    process(inputs) {
        const channel = inputs[0]?.[0];
        if (!channel) return true;
        const samples = this.downsampler.process(channel);
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            this.chunk[this.index++] = floatToInt16(s);
            this.sumSquares += s * s;
            if (this.index === this.chunk.length) this.emit();
        }
        return true;
    }
}

if (typeof (/** @type {any} */ (globalThis).registerProcessor) === 'function') {
    /** @type {any} */ (globalThis).registerProcessor('pcm-capture', PcmCaptureProcessor);
}
