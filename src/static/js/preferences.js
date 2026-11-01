import { createIcon } from './ui/icons.js';

// UI preferences are independent of the model's speech language and credentials.
const translations = {
    'Gemini Live Playground': 'Gemini Live 实验室',
    'Welcome back.': '欢迎回来。',
    'Your space to explore real-time AI. Sign in to start a conversation.': '在这里探索实时 AI。登录后即可开始对话。',
    'Access password': '访问密码',
    'Enter your access password': '请输入访问密码',
    'Sign in': '登录',
    'A private workspace for voice, text, and vision.': '私密的语音、文字与视觉工作空间。',
    'A little more conversation. A world of possibility.': '多一点交流，发现无限可能。',
    'Live playground': '实时实验室',
    'Gemini API key': 'Gemini API 密钥',
    'or access password': '或输入访问密码',
    'Keep the key in this browser after the tab is closed': '关闭标签页后仍在此浏览器中保存密钥',
    'Remember key': '记住密钥',
    'Settings': '设置',
    'Session settings': '会话设置',
    'Make this conversation your own.': '让对话更合你意。',
    'Close settings': '关闭设置',
    'Model': '模型',
    'Voice': '音色',
    'Language': '语音语言',
    'Response': '回复方式',
    'Voice + transcript': '语音与文字',
    'Text only (voice muted)': '仅文字（语音静音）',
    'Video FPS': '视频帧率',
    'Gemini looks at about one frame per second; more only costs bandwidth.':
        'Gemini 每秒约处理一帧画面；提高帧率只会增加带宽消耗。',
    'System instruction': '系统指令',
    'Enter custom system instructions...': '输入自定义系统指令…',
    'Show protocol details in the log': '在日志中显示协议详情',
    'Connected tools': '已连接的工具',
    'Google Search grounds answers on the web. The weather tool returns clearly labeled demo data. Tool activity appears in your conversation.':
        'Google 搜索为回答提供网络依据。天气工具返回明确标注的演示数据。工具活动会显示在对话中。',
    'Forget saved key': '删除已保存的密钥',
    'Export logs': '导出日志',
    'Done': '完成',
    'Settings apply to the next connection.': '设置将在下次连接时生效。',
    'Sign out': '退出登录',
    'Connect': '连接',
    'Disconnect': '断开连接',
    'Disconnected': '未连接',
    'Connected': '已连接',
    'Connecting...': '正在连接…',
    'Reconnecting...': '正在重新连接…',
    'Clear conversation': '清空对话',
    'Clear': '清空',
    'Conversation': '对话',
    'Voice · Text · Vision': '语音 · 文字 · 视觉',
    'Message': '消息',
    'Type a message...': '输入消息…',
    'Send': '发送',
    'Start microphone': '开启麦克风',
    'Stop microphone': '关闭麦克风',
    'Start camera': '开启摄像头',
    'Stop camera': '关闭摄像头',
    'Share screen': '共享屏幕',
    'Input audio': '输入音频',
    'Output audio': '输出音频',
    'Frame sent to Gemini (click to enlarge)': '发送给 Gemini 的画面（点击放大）',
    'Switch camera': '切换摄像头',
    'Stop video': '停止视频',
    'Stop sharing': '停止共享',
    'Interface language': '界面语言',
    'Appearance': '外观',
    'Light': '浅色',
    'Dark': '深色',
    'System': '系统',
    'Follow system': '跟随系统',
    'Debug': '调试',
    'Error': '错误',
    'You': '你',
    'A conversation starts here': '对话从这里开始',
    'Connect, then speak, type, or share your view.': '连接后，即可说话、打字或共享画面。',
    'Auto-detect': '自动检测',
    'Gemini API key (optional)': 'Gemini API 密钥（可选）',
    'Saved key removed from this browser': '已从此浏览器删除保存的密钥',
    'Microphone on': '麦克风已开启',
    'Microphone off': '麦克风已关闭',
    'Camera on': '摄像头已开启',
    'Camera off': '摄像头已关闭',
    'Screen sharing ended': '屏幕共享已结束',
    'Screen sharing on': '屏幕共享已开启',
    'Screen sharing off': '屏幕共享已关闭',
    'Screen sharing cancelled': '已取消屏幕共享',
    'Model interrupted': '模型回复已中断',
    'Session resumed': '会话已恢复',
    'Reconnected (new session)': '已重新连接（新会话）',
    'Wrong password. Please try again.': '密码错误，请重试。',
    'Service unavailable. Please try again later.': '服务暂不可用，请稍后重试。',
    'Too many attempts. Wait a minute.': '尝试次数过多，请稍后再试。',
    'Sign-in failed. Please try again.': '登录失败，请重试。',
    'Sign-out could not be confirmed. Please retry.': '无法确认是否已退出，请重试。',
    'Authentication failed': '身份验证失败',
    'Authentication timed out': '身份验证超时',
    'Rate limited by the server': '请求过于频繁',
    'Could not reach Gemini': '无法连接 Gemini',
    'Sent too much data before the session was ready': '会话就绪前发送的数据过多',
    'Connection lost': '连接已丢失',
    'Gemini rejected the request': 'Gemini 拒绝了请求',
    'Gemini refused the session (check the API key and model)': 'Gemini 拒绝了会话（请检查 API 密钥和模型）',
    'Gemini internal error': 'Gemini 内部错误',
    'Gemini is overloaded, try again later': 'Gemini 当前繁忙，请稍后重试',
    'Already connected': '已经连接',
    'Not connected to Gemini': '尚未连接 Gemini',
    'WebSocket connection failed': 'WebSocket 连接失败',
    'Timed out waiting for setupComplete': '等待会话初始化超时',
    'Gemini did not confirm the session in time': 'Gemini 未及时确认会话',
    'Audio recording is not supported in this browser': '此浏览器不支持录音',
    'Screen sharing is not supported in this browser': '此浏览器不支持屏幕共享',
    'Camera capture is not supported in this browser': '此浏览器不支持摄像头采集',
    'socket open': '连接已打开',
    'resuming session': '正在恢复会话',
    'setup complete': '初始化完成',
    'interrupted': '已中断',
    'turn complete': '本轮结束',
    'location is required': '必须填写地点',
    'date must be YYYY-MM-DD': '日期格式必须为 YYYY-MM-DD',
    'Bright': '明亮',
    'Upbeat': '欢快',
    'Informative': '知性',
    'Firm': '坚定',
    'Excitable': '热情',
    'Youthful': '年轻',
    'Breezy': '轻快',
    'Easy-going': '随和',
    'Breathy': '气声',
    'voice.Clear': '清晰',
    'Smooth': '流畅',
    'Gravelly': '沙哑',
    'Soft': '柔和',
    'Even': '平稳',
    'Mature': '成熟',
    'Forward': '直率',
    'Friendly': '友好',
    'Casual': '轻松',
    'Gentle': '温柔',
    'Lively': '活泼',
    'Knowledgeable': '博学',
    'Warm': '温暖',
    'recommended': '推荐',
    'extended thinking': '扩展思考',
    'preview': '预览',
    'legacy': '旧版',
    'restricted': '受限',
    'native audio': '原生音频',
};
let language = 'zh-CN';
let theme = 'system';
function read(key, fallback, allowed) {
    try {
        const value = localStorage.getItem(key);
        return allowed.includes(value) ? value : fallback;
    } catch {
        return fallback;
    }
}
function save(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch { /* blocked storage */ }
}
export function t(source) {
    if (language === 'en') return source === 'voice.Clear' ? 'Clear' : source;
    if (translations[source]) return translations[source];
    // Only application-owned UI strings enter this function; never user/model transcripts.
    const patterns = [
        [/^Connected to (.*)$/s, '已连接到 $1'],
        [/^Connection failed: (.*)$/s, '连接失败：$1'],
        [/^Audio output unavailable, continuing with text: (.*)$/s, '音频输出不可用，继续使用文字：$1'],
        [/^Using tool (.*)$/s, '正在使用工具 $1'],
        [/^Thinking: (.*)$/s, '思考：$1'],
        [/^Reconnecting \(attempt (\d+)\)(.*)$/s, '正在重新连接（第 $1 次）$2'],
        [/^Connection closed \(code (\d+)\)$/s, '连接已关闭（代码 $1）'],
        [/^Permission to use the (microphone|camera|screen) was denied$/, '使用$1的权限被拒绝'],
        [/^No (microphone|camera|screen) found$/, '未找到$1'],
        [/^The (microphone|camera|screen) is in use by another application$/, '$1正被其他应用使用'],
        [/^Could not start the (microphone|camera|screen): (.*)$/s, '无法启动$1：$2'],
    ];
    for (const [pattern, replacement] of patterns) {
        if (pattern.test(source)) {
            return source.replace(pattern, replacement).replace('microphone', '麦克风').replace('camera', '摄像头')
                .replace('screen', '屏幕').replace(', resuming session', '，正在恢复会话');
        }
    }
    for (
        const [prefix, translated] of [
            ['Could not initialise audio output: ', '无法初始化音频输出：'],
            ['Could not start audio processing: ', '无法启动音频处理：'],
        ]
    ) if (source.startsWith(prefix)) return translated + t(source.slice(prefix.length));
    // Model descriptions are UI metadata, not model IDs or generated text.
    if (source.startsWith('Gemini ')) {
        let result = source;
        for (const key of ['recommended', 'extended thinking', 'preview', 'legacy', 'restricted', 'native audio']) {
            result = result.replaceAll(key, translations[key]);
        }
        return result;
    }
    // Close descriptions may include a remote diagnostic after the known prefix.
    for (const [en, zh] of Object.entries(translations)) {
        if (source.startsWith(en + ': ')) return zh + '：' + source.slice(en.length + 2);
    }
    return source;
}
export function text(el, source) {
    el.dataset.i18n = source;
    el.textContent = t(source);
}
export function attribute(el, name, source) {
    el.setAttribute(`data-i18n-${name}`, source);
    el.setAttribute(name, t(source));
}
function refresh() {
    document.documentElement.lang = language;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const name of ['aria-label', 'placeholder', 'title', 'label']) {
        for (const el of document.querySelectorAll(`[data-i18n-${name}]`)) {
            el.setAttribute(name, t(el.getAttribute(`data-i18n-${name}`)));
        }
    }
    for (const el of document.querySelectorAll('[data-voice-name]')) {
        el.textContent = `${el.dataset.voiceName} (${
            t(el.dataset.voiceStyle === 'Clear' ? 'voice.Clear' : el.dataset.voiceStyle)
        })`;
    }
    for (const el of document.querySelectorAll('[data-language-code]')) {
        const code = el.dataset.languageCode === 'cmn-CN'
            ? 'zh-CN'
            : el.dataset.languageCode === 'ar-XA'
            ? 'ar'
            : el.dataset.languageCode;
        try {
            el.textContent = new Intl.DisplayNames([language], { type: 'language' }).of(code);
        } catch { /* retain name */ }
    }
    for (const el of document.querySelectorAll('[data-ui-language]')) {
        el.dataset.state = language;
        el.textContent = language === 'en' ? 'EN' : '中';
        const label = `${t('Interface language')}: ${language === 'en' ? 'English' : '简体中文'}`;
        el.setAttribute('aria-label', label);
        el.title = label;
    }
    for (const el of document.querySelectorAll('[data-ui-theme]')) {
        el.dataset.state = theme;
        el.replaceChildren(createIcon({ system: 'monitor', light: 'sun', dark: 'moon' }[theme]));
        const label = `${t('Appearance')}: ${t({ system: 'Follow system', light: 'Light', dark: 'Dark' }[theme])}`;
        el.setAttribute('aria-label', label);
        el.title = label;
    }
    const logs = document.getElementById('logs-container');
    if (logs) {
        logs.dataset.emptyTitle = t('A conversation starts here');
        logs.dataset.emptyHint = t('Connect, then speak, type, or share your view.');
    }
}
export function initPreferences() {
    language = read('gemini_ui_language', 'zh-CN', ['zh-CN', 'en']);
    theme = read('gemini_ui_theme', 'system', ['system', 'light', 'dark']);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
        document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    media.addEventListener('change', applyTheme);
    for (const el of document.querySelectorAll('[data-ui-language]')) {
        el.addEventListener('click', () => {
            language = language === 'en' ? 'zh-CN' : 'en';
            save('gemini_ui_language', language);
            refresh();
        });
    }
    for (const el of document.querySelectorAll('[data-ui-theme]')) {
        el.addEventListener('click', () => {
            const modes = ['system', 'light', 'dark'];
            theme = modes[(modes.indexOf(theme) + 1) % modes.length];
            save('gemini_ui_theme', theme);
            refresh();
            applyTheme();
        });
    }
    globalThis.addEventListener('ui-options-ready', refresh);
    refresh();
    applyTheme();
}
