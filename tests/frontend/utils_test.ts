import { assert, assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import { encodeBase64 } from '@std/encoding/base64';
import { EventEmitter } from '../../src/static/js/core/event-emitter.js';
import {
    arrayBufferToBase64,
    base64ToArrayBuffer,
    clampNumber,
    messageToText,
    pcm16ToFloat32,
} from '../../src/static/js/utils/utils.js';
import { ApplicationError, ErrorCodes, mediaError } from '../../src/static/js/utils/error-boundary.js';

Deno.test('base64 round-trips large buffers and matches @std/encoding', () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
    const encoded = arrayBufferToBase64(bytes.buffer);
    assertEquals(encoded, encodeBase64(bytes));
    assertEquals(new Uint8Array(base64ToArrayBuffer(encoded)), bytes);
    assertEquals(arrayBufferToBase64(new Uint8Array(0)), '');
});

Deno.test('pcm16ToFloat32 decodes little-endian samples', () => {
    const view = new DataView(new ArrayBuffer(6));
    view.setInt16(0, 0x7fff, true);
    view.setInt16(2, -0x8000, true);
    view.setInt16(4, 0, true);
    const out = pcm16ToFloat32(view.buffer);
    assertAlmostEquals(out[0], 1, 1e-4);
    assertEquals(out[1], -1);
    assertEquals(out[2], 0);
    assertEquals(pcm16ToFloat32(new ArrayBuffer(3)).length, 1, 'odd trailing byte is ignored');
});

Deno.test('messageToText accepts string, ArrayBuffer, views and Blob', async () => {
    assertEquals(await messageToText('a'), 'a');
    assertEquals(await messageToText(new TextEncoder().encode('b').buffer), 'b');
    assertEquals(await messageToText(new TextEncoder().encode('c')), 'c');
    assertEquals(await messageToText(new Blob(['d'])), 'd');
    await assertRejects(() => messageToText(42), TypeError);
});

Deno.test('clampNumber', () => {
    assertEquals(clampNumber('3', 1, 5, 1), 3);
    assertEquals(clampNumber('99', 1, 5, 1), 5);
    assertEquals(clampNumber('-1', 1, 5, 1), 1);
    assertEquals(clampNumber('abc', 1, 5, 2), 2);
    assertEquals(clampNumber(null, 1, 5, 2), 1);
});

Deno.test('EventEmitter: on/off/once, unsubscribe, isolation of throwing listeners', () => {
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    const off = emitter.on('x', (v: unknown) => seen.push(v));
    emitter.once('x', (v: unknown) => seen.push(`once:${v}`));
    const originalError = console.error;
    console.error = () => {};
    emitter.on('x', () => {
        throw new Error('listener bug');
    });
    try {
        assert(emitter.emit('x', 1));
        emitter.emit('x', 2);
    } finally {
        console.error = originalError;
    }
    off();
    emitter.emit('x', 3);
    assertEquals(seen, [1, 'once:1', 2]);
    assertEquals(emitter.emit('none'), false);
    emitter.removeAllListeners();
    assertEquals(emitter.listenerCount('x'), 0);
});

Deno.test('mediaError maps DOMException names to readable errors', () => {
    const denied = mediaError(Object.assign(new Error('x'), { name: 'NotAllowedError' }), 'microphone');
    assert(denied instanceof ApplicationError);
    assertEquals(denied.code, ErrorCodes.AUDIO_PERMISSION_DENIED);
    assertEquals(denied.message, 'Permission to use the microphone was denied');
    assertEquals(
        mediaError(Object.assign(new Error('x'), { name: 'NotFoundError' }), 'camera').message,
        'No camera found',
    );
    assertEquals(mediaError(new Error('boom'), 'screen').message, 'Could not start the screen: boom');
});
