/** DSP tests for the AudioWorklet processors (run outside the audio thread with a stub port). */
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
    Downsampler,
    floatToInt16,
    PcmCaptureProcessor,
} from '../../src/static/js/audio/worklets/capture-processor.js';
import {
    LinearResampler,
    PcmPlayerProcessor,
    SampleQueue,
} from '../../src/static/js/audio/worklets/player-processor.js';

function sine(freq: number, rate: number, seconds: number) {
    const out = new Float32Array(Math.round(rate * seconds));
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
    return out;
}

/** Estimates the dominant frequency by counting zero crossings. */
function zeroCrossingFreq(samples: Float32Array, rate: number) {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
    return crossings / 2 / (samples.length / rate);
}

function feed(ds: Downsampler, input: Float32Array, blockSize = 128) {
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += blockSize) parts.push(...ds.process(input.subarray(i, i + blockSize)));
    return Float32Array.from(parts);
}

const rms = (s: Float32Array, skip = 0) =>
    Math.sqrt(s.subarray(skip).reduce((a, v) => a + v * v, 0) / (s.length - skip));

Deno.test('Downsampler 48k -> 16k keeps duration, pitch and level across 128-frame blocks', () => {
    const out = feed(new Downsampler(48000, 16000), sine(440, 48000, 1));
    assert(Math.abs(out.length - 16000) <= 30, `got ${out.length}`); // minus filter look-ahead
    assertAlmostEquals(zeroCrossingFreq(out, 16000), 440, 5);
    assertAlmostEquals(rms(out, 100), 0.5 / Math.SQRT2, 0.01);
});

Deno.test('Downsampler passes speech-band tones (3.4 kHz) almost unchanged', () => {
    const out = feed(new Downsampler(48000, 16000), sine(3400, 48000, 0.5));
    assertAlmostEquals(rms(out, 100), 0.5 / Math.SQRT2, 0.02);
});

Deno.test('Downsampler 44.1k -> 16k (fractional ratio) keeps duration and pitch', () => {
    const out = feed(new Downsampler(44100, 16000), sine(1000, 44100, 1));
    assert(Math.abs(out.length - 16000) <= 30, `got ${out.length}`);
    assertAlmostEquals(zeroCrossingFreq(out, 16000), 1000, 10);
});

Deno.test('Downsampler attenuates content above the new Nyquist frequency', () => {
    // 12 kHz would alias to 4 kHz at 16 kHz; it must be filtered out (>= 40 dB down).
    for (const freq of [9000, 12000, 20000]) {
        const level = rms(feed(new Downsampler(48000, 16000), sine(freq, 48000, 0.5)), 100);
        assert(level < 0.0035, `${freq} Hz aliased energy too high: ${level}`);
    }
});

Deno.test('Downsampler passthrough and upsampling', () => {
    const same = new Downsampler(16000, 16000).process(Float32Array.of(0.1, 0.2));
    assertEquals(Array.from(same), Array.from(Float32Array.of(0.1, 0.2)));
    const up = feed(new Downsampler(8000, 16000), sine(200, 8000, 1));
    assert(Math.abs(up.length - 16000) <= 30, `got ${up.length}`);
    assertAlmostEquals(zeroCrossingFreq(up.subarray(50), 16000), 200, 3);
});

Deno.test('floatToInt16 clamps and scales asymmetrically', () => {
    assertEquals(floatToInt16(1), 32767);
    assertEquals(floatToInt16(-1), -32768);
    assertEquals(floatToInt16(2), 32767);
    assertEquals(floatToInt16(-2), -32768);
    assertEquals(floatToInt16(0), 0);
});

Deno.test('PcmCaptureProcessor emits 100 ms chunks of 16 kHz PCM16 with RMS', () => {
    const messages: { type: string; pcm: ArrayBuffer; rms: number }[] = [];
    const proc = new PcmCaptureProcessor({
        processorOptions: { targetSampleRate: 16000, chunkSamples: 1600, inputSampleRate: 48000 },
    });
    proc.port = { postMessage: (m: never) => messages.push(m), onmessage: proc.port.onmessage };
    // 0.52 s: five full 100 ms chunks plus the resampler's few samples of look-ahead.
    const input = sine(440, 48000, 0.52);
    for (let i = 0; i < input.length; i += 128) assert(proc.process([[input.subarray(i, i + 128)]]));
    assertEquals(messages.length, 5);
    for (const m of messages) {
        assertEquals(m.type, 'chunk');
        assertEquals(m.pcm.byteLength, 3200);
    }
    for (const m of messages.slice(1)) assertAlmostEquals(m.rms, 0.5 / Math.SQRT2, 0.02);
    // flush emits the partial chunk that is still buffered
    proc.port.onmessage({ data: { type: 'flush' } });
    const partial = messages.at(-1)!;
    assertEquals(messages.length, 6);
    assert(partial.pcm.byteLength > 0 && partial.pcm.byteLength < 3200);
    proc.port.onmessage({ data: { type: 'flush' } });
    assertEquals(messages.length, 6, 'flushing an empty buffer sends nothing');
    assert(proc.process([[]]), 'no input is fine');
});

Deno.test('SampleQueue reads across chunk boundaries', () => {
    const q = new SampleQueue();
    q.push(Float32Array.of(1, 2, 3));
    q.push(Float32Array.of(4, 5));
    q.push(new Float32Array(0));
    const out = new Float32Array(4);
    assertEquals(q.read(out), 4);
    assertEquals(Array.from(out), [1, 2, 3, 4]);
    assertEquals(q.length, 1);
    assertEquals(q.read(out), 1);
    assertEquals(out[0], 5);
    assertEquals(q.length, 0);
    q.push(Float32Array.of(9));
    q.clear();
    assertEquals(q.read(out), 0);
});

Deno.test('LinearResampler 24k -> 48k doubles the sample count and keeps pitch', () => {
    const rs = new LinearResampler(24000, 48000);
    const input = sine(300, 24000, 1);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 480) parts.push(...rs.process(input.subarray(i, i + 480)));
    const out = Float32Array.from(parts);
    assert(Math.abs(out.length - 48000) <= 2, `got ${out.length}`);
    assertAlmostEquals(zeroCrossingFreq(out, 48000), 300, 3);
});

function player(threshold = 80) {
    const messages: { type: string; value?: number }[] = [];
    const proc = new PcmPlayerProcessor({
        processorOptions: { inputSampleRate: 24000, outputSampleRate: 24000, startThresholdMs: threshold },
    });
    proc.port = { postMessage: (m: never) => messages.push(m), onmessage: proc.port.onmessage };
    const render = () => {
        const out = [new Float32Array(128)];
        proc.process([], [out]);
        return out[0];
    };
    const push = (samples: Float32Array) => proc.port.onmessage({ data: { type: 'push', samples } });
    return { proc, messages, render, push, send: (type: string) => proc.port.onmessage({ data: { type } }) };
}

Deno.test('PcmPlayerProcessor waits for the jitter buffer, then plays in order and reports drained', () => {
    const p = player(80); // 80 ms at 24 kHz = 1920 samples
    p.push(new Float32Array(1000).fill(0.25));
    assertEquals(p.render()[0], 0, 'silence below threshold');
    p.push(new Float32Array(1000).fill(0.25));
    assertEquals(p.render()[0], 0.25, 'starts once threshold reached');
    assert(p.messages.some((m) => m.type === 'playing'));
    let frames = 128;
    while (!p.messages.some((m) => m.type === 'drained')) {
        p.render();
        frames += 128;
        assert(frames < 5000);
    }
    assertEquals(p.render()[0], 0);
});

Deno.test('PcmPlayerProcessor flush plays short tails, clear silences immediately', () => {
    const p = player(80);
    p.push(new Float32Array(200).fill(0.5));
    p.send('flush');
    const first = p.render();
    assertEquals(first[0], 0.5);
    assertEquals(first[127], 0.5);

    p.push(new Float32Array(10_000).fill(0.5));
    p.render();
    p.send('clear');
    assert(p.messages.some((m) => m.type === 'cleared'));
    assertEquals(Array.from(p.render()).every((v) => v === 0), true);
});

Deno.test('PcmPlayerProcessor starts after a max wait even below the threshold', () => {
    const p = player(1000);
    p.push(new Float32Array(500).fill(0.1));
    let started = false;
    for (let i = 0; i < 60 && !started; i++) started = p.render()[0] !== 0;
    assert(started, 'should start after ~250 ms of waiting');
});

Deno.test('PcmPlayerProcessor reports output volume periodically', () => {
    const p = player(10);
    p.push(new Float32Array(24000).fill(0.5));
    for (let i = 0; i < 20; i++) p.render();
    const volumes = p.messages.filter((m) => m.type === 'volume');
    assert(volumes.length >= 1);
    assert(volumes.at(-1)!.value! > 0.4);
});
