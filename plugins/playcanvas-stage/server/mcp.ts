// stdio mcp server exposing Stage, StageComments, StageData and StageCheck
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { api, ensureDaemon, host } from './client.ts';
import { PRESENCE_MS } from './constants.ts';
import * as P from './prompts.ts';
import * as SC from './schemas.ts';
import { check } from './tools/check.ts';
import { comments } from './tools/comments.ts';
import { InputError, session, text } from './tools/common.ts';
import type { Result } from './tools/common.ts';
import { data } from './tools/data.ts';
import { stage } from './tools/stage.ts';
import { validate } from './validate.ts';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// the release workflow bumps the manifests, so the server reports the version they carry
const VERSION: string = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')
).version;

const TOOLS = [
    {
        name: 'Stage',
        description: P.STAGE,
        inputSchema: SC.STAGE,
        run: stage,
        annotations: { title: 'Stage', openWorldHint: false }
    },
    {
        name: 'StageComments',
        description: P.COMMENTS,
        inputSchema: SC.COMMENTS,
        run: comments,
        annotations: { title: 'Stage comments', openWorldHint: false }
    },
    {
        name: 'StageData',
        description: P.DATA,
        inputSchema: SC.DATA,
        run: data,
        annotations: { title: 'Stage database', openWorldHint: false }
    },
    {
        name: 'StageCheck',
        description: P.CHECK,
        inputSchema: SC.CHECK,
        run: check,
        annotations: { title: 'Stage check', readOnlyHint: true, openWorldHint: false }
    }
];

export const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) {
        return text(`unknown tool ${name}`, true);
    }
    const err = validate(t.inputSchema as never, args);
    if (err) {
        return text(`InputValidationError: ${err}`, true);
    }

    // validate() just checked args against this tool's schema, which its Input type mirrors
    return t
        .run(args as never)
        .catch((e: Error) => text(e instanceof InputError ? e.message : `${name} failed: ${e.message}`, true));
};

type Rpc = {
    id?: number | string;
    method?: string;
    params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
};

const handle = async (msg: Rpc) => {
    const { id, method, params } = msg;
    switch (method) {
        case 'initialize':
            return {
                protocolVersion: VERSIONS.find((v) => v === params?.protocolVersion) ?? VERSIONS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'playcanvas-stage', version: VERSION },
                instructions: P.INSTRUCTIONS
            };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: TOOLS.map(({ run: _run, ...t }) => t) };
        case 'tools/call':
            return callTool(params?.name ?? '', params?.arguments ?? {}).finally(() => void beat());
    }
    if (id === undefined) {
        return undefined;
    }
    throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
};

// checks in with the stages this session published or read, so their pages show whether the agent is there and
// comments reach only this session; never starts the daemon
const me = process.argv[1]?.endsWith('mcp.ts') ? host() : undefined;
const beat = () =>
    me &&
    ensureDaemon(false)
        .then(
            (c) =>
                c &&
                api('POST', '/_agent/presence', {
                    host: me.pid,
                    stages: [...new Set([...session.seen.keys(), ...session.linked])]
                })
        )
        .catch(() => undefined);

if (process.argv[1]?.endsWith('mcp.ts')) {
    setInterval(beat, PRESENCE_MS).unref();
    beat();
    const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
    createInterface({ input: process.stdin }).on('line', (line) => {
        if (!line.trim()) {
            return;
        }
        const msg = JSON.parse(line);
        handle(msg).then(
            (result) => msg.id !== undefined && result !== undefined && out({ jsonrpc: '2.0', id: msg.id, result }),
            (e: Error & { code?: number }) =>
                msg.id !== undefined &&
                out({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } })
        );
    });
}
