// @ts-check
/**
 * @fileoverview Inline SVG icons (based on Feather Icons, MIT License, https://feathericons.com).
 * Replaces the Google Fonts icon font, which was a third-party request and does not load in
 * every network.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @type {Record<string, string[]>} each entry: list of SVG element specs "tag|attr=value|..." */
const ICONS = {
    mic: [
        'path|d=M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z',
        'path|d=M19 10v2a7 7 0 0 1-14 0v-2',
        'line|x1=12|y1=19|x2=12|y2=23',
        'line|x1=8|y1=23|x2=16|y2=23',
    ],
    'mic-off': [
        'line|x1=1|y1=1|x2=23|y2=23',
        'path|d=M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6',
        'path|d=M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23',
        'line|x1=12|y1=19|x2=12|y2=23',
        'line|x1=8|y1=23|x2=16|y2=23',
    ],
    video: ['polygon|points=23 7 16 12 23 17 23 7', 'rect|x=1|y=5|width=15|height=14|rx=2|ry=2'],
    'video-off': [
        'path|d=M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10',
        'line|x1=1|y1=1|x2=23|y2=23',
    ],
    sun: [
        'circle|cx=12|cy=12|r=5',
        'path|d=M12 1v2m0 18v2M1 12h2m18 0h2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
    ],
    moon: ['path|d=M21 12.79A9 9 0 0 1 11.21 3 9 9 0 1 0 21 12.79z'],
    monitor: [
        'rect|x=2|y=3|width=20|height=14|rx=2|ry=2',
        'line|x1=8|y1=21|x2=16|y2=21',
        'line|x1=12|y1=17|x2=12|y2=21',
    ],
    'monitor-off': [
        'rect|x=2|y=3|width=20|height=14|rx=2|ry=2',
        'line|x1=8|y1=21|x2=16|y2=21',
        'line|x1=12|y1=17|x2=12|y2=21',
        'line|x1=1|y1=1|x2=23|y2=23',
    ],
    sliders: [
        'line|x1=4|y1=21|x2=4|y2=14',
        'line|x1=4|y1=10|x2=4|y2=3',
        'line|x1=12|y1=21|x2=12|y2=12',
        'line|x1=12|y1=8|x2=12|y2=3',
        'line|x1=20|y1=21|x2=20|y2=16',
        'line|x1=20|y1=12|x2=20|y2=3',
        'line|x1=1|y1=14|x2=7|y2=14',
        'line|x1=9|y1=8|x2=15|y2=8',
        'line|x1=17|y1=16|x2=23|y2=16',
    ],
    refresh: [
        'polyline|points=23 4 23 10 17 10',
        'polyline|points=1 20 1 14 7 14',
        'path|d=M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    ],
    x: ['line|x1=18|y1=6|x2=6|y2=18', 'line|x1=6|y1=6|x2=18|y2=18'],
    send: ['line|x1=22|y1=2|x2=11|y2=13', 'polygon|points=22 2 15 22 11 13 2 9 22 2'],
};

/**
 * @param {string} name
 * @returns {SVGSVGElement}
 */
export function createIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    for (const spec of ICONS[name] ?? []) {
        const [tag, ...attrs] = spec.split('|');
        const el = document.createElementNS(SVG_NS, tag);
        for (const attr of attrs) {
            const eq = attr.indexOf('=');
            el.setAttribute(attr.slice(0, eq), attr.slice(eq + 1));
        }
        svg.append(el);
    }
    return svg;
}

/**
 * Replaces the icon inside an element.
 * @param {Element} target
 * @param {string} name
 */
export function setIcon(target, name) {
    target.querySelector('svg.icon')?.remove();
    target.prepend(createIcon(name));
}

/** Renders every `[data-icon]` element in the document. */
export function renderIcons(root = document) {
    for (const el of root.querySelectorAll('[data-icon]')) {
        setIcon(el, /** @type {HTMLElement} */ (el).dataset.icon ?? '');
    }
}
