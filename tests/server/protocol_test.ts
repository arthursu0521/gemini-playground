import { assert, assertEquals, assertFalse } from '@std/assert';
import {
    decodeCloseCode,
    encodeCloseCode,
    isFatalCloseCode,
    LIVE_WS_PATH,
    LIVE_WS_PATH_PATTERN,
    truncateCloseReason,
} from '../../src/static/js/shared/protocol.js';

Deno.test('close codes round-trip through the browser-safe range', () => {
    for (const code of [1001, 1007, 1008, 1011, 1013]) {
        const encoded = encodeCloseCode(code);
        assert(encoded >= 4000 && encoded <= 4999, `${code} -> ${encoded}`);
        assertEquals(decodeCloseCode(encoded), code);
    }
    assertEquals(encodeCloseCode(1000), 1000);
    assertEquals(encodeCloseCode(1005), 1000);
    assertEquals(encodeCloseCode(1006), 4006);
    assertEquals(encodeCloseCode(3001), 3001);
    assertEquals(encodeCloseCode(4401), 4401);
    assertEquals(encodeCloseCode(999), 4006);
});

Deno.test('fatal close codes: bad key, invalid argument, relay refusals', () => {
    assert(isFatalCloseCode(4008));
    assert(isFatalCloseCode(4007));
    assert(isFatalCloseCode(4401));
    assert(isFatalCloseCode(4429));
    assertFalse(isFatalCloseCode(4011));
    assertFalse(isFatalCloseCode(1000));
    assertFalse(isFatalCloseCode(4502));
});

Deno.test('close reasons are cut to 123 UTF-8 bytes on a character boundary', () => {
    assertEquals(truncateCloseReason('short'), 'short');
    const long = '错'.repeat(100); // 300 bytes
    const cut = truncateCloseReason(long);
    assert(new TextEncoder().encode(cut).length <= 123);
    assert(cut.endsWith('...'));
    assertFalse(cut.includes('�'));
});

Deno.test('live path pattern accepts v1alpha/v1beta and the constrained endpoint only', () => {
    assert(LIVE_WS_PATH_PATTERN.test(LIVE_WS_PATH));
    assert(
        LIVE_WS_PATH_PATTERN.test('/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'),
    );
    assert(
        LIVE_WS_PATH_PATTERN.test(
            '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
        ),
    );
    assertFalse(LIVE_WS_PATH_PATTERN.test('/ws/anything'));
    assertFalse(LIVE_WS_PATH_PATTERN.test(`${LIVE_WS_PATH}/../x`));
});
