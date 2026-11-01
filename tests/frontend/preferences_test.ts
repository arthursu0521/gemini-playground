import { assertEquals } from '@std/assert';
import { t } from '../../src/static/js/preferences.js';

Deno.test('UI dictionary defaults to Chinese, translates owned labels and preserves unknown diagnostics', () => {
    assertEquals(t('Connect'), '连接');
    assertEquals(t('Clear'), '清空');
    assertEquals(t('voice.Clear'), '清晰');
    assertEquals(t('System'), '系统');
    assertEquals(t('Follow system'), '跟随系统');
    assertEquals(t('unknown diagnostic 123'), 'unknown diagnostic 123');
    assertEquals(t('Using tool get_weather_on_date'), '正在使用工具 get_weather_on_date');
    assertEquals(t('Connected to gemini-3.8-live'), '已连接到 gemini-3.8-live');
    assertEquals(t('Permission to use the microphone was denied'), '使用麦克风的权限被拒绝');
});
