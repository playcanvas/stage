// headless chrome for the browser tests: open a page, evaluate in it, close
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { cdpPipe, findChrome } from '../plugins/playcanvas-stage/server/preview.ts';

const FLAGS = [
    '--headless=new',
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-extensions',
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])
];

export const chrome = findChrome();

export const launch = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-chrome-'));
    const proc = spawn(chrome!, [...FLAGS, `--user-data-dir=${dir}`, 'about:blank'], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
    });
    const cdp = cdpPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable);

    const open = async (url: string, size = { width: 1000, height: 700 }) => {
        const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
        const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as {
            sessionId: string;
        };
        const send = (m: string, p: object = {}) => cdp.send(m, p, sessionId);
        const logs: string[] = [];
        cdp.on('Runtime.consoleAPICalled', (p, s) => {
            if (s !== sessionId) {
                return;
            }
            const args = (p.args as { value?: unknown; description?: string }[]) ?? [];
            logs.push(`${p.type}: ${args.map((a) => a.value ?? a.description).join(' ')}`);
        });
        cdp.on('Runtime.exceptionThrown', (p, s) => {
            if (s === sessionId) {
                logs.push(`exception: ${JSON.stringify(p.exceptionDetails)}`);
            }
        });
        // cross-origin frames (a stage in the viewer) are their own targets, attached as they appear
        const kids = new Set<string>();
        cdp.on('Target.attachedToTarget', (p, s) => s === sessionId && kids.add(p.sessionId as string));
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await send('Runtime.enable');
        await send('Page.enable');
        await send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url });

        /** evaluates `expr` in the page, or in a frame's session (awaiting a promise); throws on an exception */
        const evaluate = async <T = unknown>(expr: string, sid = sessionId) => {
            const r = (await cdp.send(
                'Runtime.evaluate',
                {
                    expression: expr,
                    awaitPromise: true,
                    returnByValue: true
                },
                sid
            )) as { result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
            if (r.exceptionDetails) {
                throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
            }
            return r.result.value as T;
        };

        /** polls `expr` until it is truthy */
        const until = async (expr: string, ms = 15000, sid = sessionId) => {
            const end = Date.now() + ms;
            let last: unknown;
            for (;;) {
                const [e, v] = await evaluate(expr, sid).then(
                    (x) => [null, x],
                    (x) => [x, undefined]
                );
                if (!e && v) {
                    return v;
                }
                last = e ?? v;
                if (Date.now() > end) {
                    throw new Error(`timed out waiting for ${expr} (last: ${String(last)})\n${logs.join('\n')}`);
                }
                await new Promise((r) => setTimeout(r, 100));
            }
        };
        const mouse = (type: string, x: number, y: number, extra: object = {}) =>
            send('Input.dispatchMouseEvent', {
                type,
                x,
                y,
                button: 'left',
                buttons: type === 'mouseReleased' || type === 'mouseMoved' ? 0 : 1,
                clickCount: 1,
                ...extra
            });
        const click = async (x: number, y: number, extra: object = {}) => {
            await mouse('mouseMoved', x, y);
            await mouse('mousePressed', x, y, extra);
            await mouse('mouseReleased', x, y, extra);
        };
        const drag = async ([x0, y0]: number[], [x1, y1]: number[], steps = 12) => {
            await mouse('mouseMoved', x0, y0);
            await mouse('mousePressed', x0, y0);
            for (let i = 1; i <= steps; i++) {
                await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1 });
            }
            await mouse('mouseReleased', x1, y1);
        };
        const key = async (k: string, code = k, extra: object = {}) => {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, ...extra });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, ...extra });
        };
        const type = (text: string) => send('Input.insertText', { text });

        /** a cross-origin frame's session, by the start of its url */
        const frame = async (prefix: string) => {
            for (let i = 0; i < 150; i++) {
                for (const sid of kids) {
                    const url = await evaluate<string>('location.href', sid).catch(() => '');
                    if (url.startsWith(prefix)) {
                        return {
                            evaluate: <T = unknown>(e: string) => evaluate<T>(e, sid),
                            until: (e: string, ms?: number) => until(e, ms, sid)
                        };
                    }
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error(`no frame at ${prefix}`);
        };
        return {
            send,
            evaluate,
            until,
            mouse,
            click,
            drag,
            key,
            type,
            frame,
            logs,
            close: () => cdp.send('Target.closeTarget', { targetId })
        };
    };

    const close = async () => {
        cdp.send('Browser.close').catch(() => {});
        await new Promise((r) => {
            proc.once('exit', r);
            setTimeout(() => (proc.kill('SIGKILL'), r(null)), 3000).unref();
        });
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    };
    return { open, close };
};
