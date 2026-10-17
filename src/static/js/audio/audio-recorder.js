// @ts-check
/**
 * @fileoverview Microphone capture -> 16 kHz PCM16 base64 chunks for the Live API.
 * Owns every resource it creates (stream, context, nodes) and releases all of them in stop().
 */
import { CONFIG } from '../config/config.js';
import { ApplicationError, ErrorCodes, mediaError } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { arrayBufferToBase64 } from '../utils/utils.js';

const WORKLET_URL = new URL('./worklets/capture-processor.js', import.meta.url);

export class AudioRecorder {
    /** @param {{ sampleRate?: number, chunkMs?: number }} [options] */
    constructor(options = {}) {
        this.sampleRate = options.sampleRate ?? CONFIG.AUDIO.INPUT_SAMPLE_RATE;
        this.chunkMs = options.chunkMs ?? CONFIG.AUDIO.CHUNK_MS;
        /** @type {MediaStream | null} */
        this.stream = null;
        /** @type {AudioContext | null} */
        this.context = null;
        /** @type {MediaStreamAudioSourceNode | null} */
        this.source = null;
        /** @type {AudioWorkletNode | null} */
        this.node = null;
        this.isRecording = false;
    }

    /**
     * @param {(base64Pcm: string) => void} onChunk
     * @param {(level: number) => void} [onLevel] RMS level 0..1 per chunk
     */
    async start(onChunk, onLevel) {
        if (this.isRecording) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new ApplicationError(
                'Audio recording is not supported in this browser',
                ErrorCodes.AUDIO_NOT_SUPPORTED,
            );
        }
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
        } catch (error) {
            throw mediaError(error, 'microphone');
        }
        try {
            // Native sample rate on purpose; the worklet resamples to 16 kHz.
            this.context = new AudioContext({ latencyHint: 'interactive' });
            await this.context.audioWorklet.addModule(WORKLET_URL);
            this.source = this.context.createMediaStreamSource(this.stream);
            this.node = new AudioWorkletNode(this.context, 'pcm-capture', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: {
                    targetSampleRate: this.sampleRate,
                    chunkSamples: Math.round((this.sampleRate * this.chunkMs) / 1000),
                },
            });
            this.node.port.onmessage = (event) => {
                if (event.data?.type !== 'chunk' || !this.isRecording) return;
                onChunk(arrayBufferToBase64(event.data.pcm));
                onLevel?.(Math.min(1, event.data.rms * 4));
            };
            this.source.connect(this.node);
            // The node outputs silence; connecting it keeps the graph pulled in every browser.
            this.node.connect(this.context.destination);
            if (this.context.state === 'suspended') await this.context.resume();
            this.isRecording = true;
            Logger.info('Microphone recording started', { deviceSampleRate: this.context.sampleRate });
        } catch (error) {
            await this.stop();
            if (error instanceof ApplicationError) throw error;
            throw new ApplicationError(
                `Could not start audio processing: ${error instanceof Error ? error.message : error}`,
                ErrorCodes.AUDIO_INITIALIZATION_FAILED,
            );
        }
    }

    /** Stops the microphone and releases the audio context. Safe to call repeatedly. */
    async stop() {
        const wasRecording = this.isRecording;
        this.isRecording = false;
        try {
            this.node?.port.postMessage({ type: 'flush' });
            this.source?.disconnect();
            this.node?.disconnect();
        } catch { /* already disconnected */ }
        if (this.node) this.node.port.onmessage = null;
        this.stream?.getTracks().forEach((track) => track.stop());
        const context = this.context;
        this.node = null;
        this.source = null;
        this.stream = null;
        this.context = null;
        if (context && context.state !== 'closed') await context.close().catch(() => {});
        if (wasRecording) Logger.info('Microphone recording stopped');
    }
}
