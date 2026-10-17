import { assertEquals, assertStringIncludes } from '@std/assert';
import { createLogger, redact } from '../../src/server/log.ts';

const KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';

Deno.test('redact removes Google keys, query secrets, bearer tokens and JSON secrets', () => {
    assertEquals(redact(`key ${KEY} used`), 'key [REDACTED_KEY] used');
    assertEquals(redact('wss://h/ws/path?key=abc123&x=1'), 'wss://h/ws/path?key=[REDACTED]&x=1');
    assertEquals(redact('/x?access_token=tok.en&y'), '/x?access_token=[REDACTED]&y');
    assertEquals(redact('Authorization: Bearer sk-abc.def'), 'Authorization: Bearer [REDACTED]');
    assertEquals(
        redact('{"auth":{"apiKey":"abc","accessPassword":"pw"}}'),
        '{"auth":{"apiKey":"[REDACTED]","accessPassword":"[REDACTED]"}}',
    );
});

Deno.test('redact removes configured secrets of 8+ characters only', () => {
    assertEquals(redact('pw is hunter2hunter2!', ['hunter2hunter2']), 'pw is [REDACTED]!');
    assertEquals(redact('shorter text', ['short']), 'shorter text');
});

Deno.test('logger respects level and redacts fields', () => {
    const lines: string[] = [];
    const sink = {
        log: (l: string) => lines.push(l),
        warn: (l: string) => lines.push(l),
        error: (l: string) => lines.push(l),
    };
    const logger = createLogger('info', ['my-access-password'], sink);
    logger.debug('hidden');
    logger.info('upstream', { url: `wss://x/?key=${KEY}`, note: 'pw=my-access-password' });
    logger.error('boom', { error: new Error(`bad ${KEY}`) });
    assertEquals(lines.length, 2);
    assertStringIncludes(lines[0], 'INFO upstream');
    assertEquals(lines.join('\n').includes(KEY), false);
    assertEquals(lines.join('\n').includes('my-access-password'), false);
    assertStringIncludes(lines[1], 'ERROR boom error="bad [REDACTED_KEY]"');
});
