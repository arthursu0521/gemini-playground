// @ts-check
/**
 * @fileoverview Plays the model's 24 kHz PCM16 audio through an AudioWorklet queue.
 */
import { CONFIG } from '../config/config.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { pcm16ToFloat32 } from '../utils/utils.js';

const WORKLET_URL = new URL('./worklets/player-processor.js', import.meta.url);

export class AudioPlayer {
    /** @param {{ sampleRate?: number }} [options] */
    constructor(options = {}) {
        this.inputSampleRate = options.sampleRate ?? CONFIG.AUDIO.OUTPUT_SAMPLE_RATE;
        /** @type {AudioContext | null} */
        this.context = null;
        /** @type {AudioWorkletNode | null} */
        this.node = null;
        /** @type {GainNode | null} */
        this.gain = null;
        /** @type {Promise<void> | null} */
        this.ready = null;
        this.muted = false;
        /** @type {(level: number) => void} */
        this.onLevel = () => {};
    }

    /** Creates the audio graph. Call from a user gesture so autoplay policies allow sound. */
    init() {
        if (!this.ready) {
            this.ready = this.#create().catch((error) => {
                this.ready = null;
                throw error;
            });
        }
        return this.ready;
    }

    async #create() {
        let context;
        try {
            // Running the context at 24 kHz lets the browser do high-quality resampling.
            context = new AudioContext({ sampleRate: this.inputSampleRate, latencyHint: 'interactive' });
        } catch {
            context = new AudioContext({ latencyHint: 'interactive' });
        }
        try {
            await context.audioWorklet.addModule(WORKLET_URL);
            const node = new AudioWorkletNode(context, 'pcm-player', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: { inputSampleRate: this.inputSampleRate, outputSampleRate: context.sampleRate },
            });
            const gain = context.createGain();
            node.connect(gain).connect(context.destination);
            node.port.onmessage = (event) => {
                if (event.data?.type === 'volume') this.onLevel(Math.min(1, event.data.value * 4));
            };
            this.context = context;
            this.node = node;
            this.gain = gain;
            Logger.info('Audio output ready', { contextSampleRate: context.sampleRate });
        } catch (error) {
            await context.close().catch(() => {});
            throw new ApplicationError(
                `Could not initialise audio output: ${error instanceof Error ? error.message : error}`,
                ErrorCodes.AUDIO_INITIALIZATION_FAILED,
            );
        }
    }

    async resume() {
        await this.init();
        if (this.context?.state === 'suspended') await this.context.resume();
    }

    /**
     * Queues a chunk of 24 kHz little-endian PCM16.
     * @param {ArrayBuffer} pcm16
     */
    play(pcm16) {
        if (this.muted || !this.node) return;
        const samples = pcm16ToFloat32(pcm16);
        this.node.port.postMessage({ type: 'push', samples }, [samples.buffer]);
    }

    /** Plays out whatever is buffered even if it is shorter than the jitter buffer. */
    flush() {
        this.node?.port.postMessage({ type: 'flush' });
    }

    /** Drops queued audio immediately (the user interrupted the model). */
    clear() {
        this.node?.port.postMessage({ type: 'clear' });
    }

    /** @param {boolean} muted */
    setMuted(muted) {
        this.muted = muted;
        if (muted) this.clear();
    }

    async close() {
        const context = this.context;
        this.node?.disconnect();
        this.node = null;
        this.gain = null;
        this.context = null;
        this.ready = null;
        if (context && context.state !== 'closed') await context.close().catch(() => {});
    }
}
