import { TITLE_SCAN_BYTES } from './constants.ts';

// the publish skeleton, byte for byte what the original tool wraps a page in
const RESET =
    ':root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}';
const RESET_NO_COVER =
    ':root{color-scheme:light}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}';
const HEAD = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${RESET}</style></head><body>`;
const HEAD_NO_COVER = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><style>${RESET_NO_COVER}</style></head><body>`;
const TAIL = '</body></html>';

const RUNTIME_OPEN = '<!-- frame-runtime -->';
const RUNTIME_CLOSE = '<!-- /frame-runtime -->';

/** strips a skeleton the page already carries (a page that republished itself) */
export const unwrap = (html: string) => {
    let s = html.replace(new RegExp(`${RUNTIME_OPEN}[\\s\\S]*?${RUNTIME_CLOSE}`, 'g'), '');
    for (const head of [HEAD, HEAD_NO_COVER]) {
        if (s.startsWith(head)) {
            s = s.slice(head.length);
            if (s.endsWith(TAIL)) {
                s = s.slice(0, -TAIL.length);
            }
            return s.replace(/^\n/, '').replace(/\n$/, '');
        }
    }
    return s;
};

/** title from a <title> in the first 8 KB, before any <svg> */
export const findTitle = (page: string) => {
    const head = page.slice(0, TITLE_SCAN_BYTES);
    const svg = head.search(/<svg[\s>]/i);
    const m = (svg >= 0 ? head.slice(0, svg) : head).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const t = m?.[1].replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 280) : undefined;
};

export const hasRuntimeMarkers = (page: string) => page.includes(RUNTIME_OPEN) || page.includes(RUNTIME_CLOSE);

/** wraps an authored .html body fragment the way publish does */
export const wrapHtml = (source: string) => {
    const body = unwrap(source);
    const vp = body.match(/<meta[^>]+name=["']?viewport["']?[^>]*>/i)?.[0];
    const head = vp && !/viewport-fit=cover/i.test(vp) ? HEAD_NO_COVER : HEAD;
    return `${head}\n${body}\n${TAIL}`;
};

/** the frame runtime goes first in <head>, so theme and capture exist before page code runs; with no <head>, after the doctype and <html> */
export const injectRuntime = (html: string, tag: string) => {
    const m = /<head(?:\s[^>]*)?>/i.exec(html) ?? /^(?:\s*<!doctype[^>]*>)?(?:\s*<html(?:\s[^>]*)?>)?/i.exec(html)!;
    const i = m.index + m[0].length;
    return html.slice(0, i) + tag + html.slice(i);
};
