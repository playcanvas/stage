// on-disk state. only the daemon imports this, so there is a single writer.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';

import {
    AGENT_WORK_MS,
    ASSET_TYPES,
    COMMENT_IMAGE_MAX_BYTES,
    COMMENT_IMAGE_TYPES,
    COMMENT_MAX_BYTES,
    DIAG_MAX_BYTES,
    DIAG_MAX_ENTRIES,
    env,
    HOME,
    MAX_ASSET_BYTES,
    MAX_ASSET_FILES,
    MAX_ASSET_STORE_BYTES,
    MAX_SVG_ASSET_BYTES,
    MAX_VERSION_BYTES,
    MAX_VERSION_FILES,
    UUID_RE,
    VER_RE
} from './constants.ts';
import type { Live } from './live.ts';

export type FileEntry = { path: string; contentType: string; size: number; sha256: string };
export type Version = {
    ver: string;
    seq: number;
    at: string;
    label?: string;
    by: 'agent' | 'page';
    files: FileEntry[];
};
export type Meta = {
    id: string;
    title: string;
    description?: string;
    icon?: string;
    capabilities: Record<string, unknown>;
    contract: string;
    createdAt: string;
    updatedAt: string;
    ver: string;
    seq: number;
    versions: Version[];

    // a live stage proxies the project's own dev server instead of serving a published page
    live?: Live;
};
// delivered_at: a notice (monitor, codex watcher or prompt hook) told a session about it
export type Comment = {
    id: string;
    author: 'user' | 'agent';
    text: string;
    created_at: string;
    to_agent_at?: string;
    delivered_at?: string;

    // reference images the person attached, pasted or picked
    images?: { type: string }[];
};
export type Region = { x0: number; y0: number; x1: number; y1: number };
export type Anchor = {
    path?: string;
    span?: { quote: string };
    label?: string;
    detail?: string;
    snippet?: string;
    file?: string;
    region?: Region;
    inside?: string[];
    at?: { x: number; y: number };
    image?: { type: string };
    also?: { path: string; label?: string; snippet?: string; image?: { type: string } }[];
};
export type Thread = {
    id: string;
    created_at: string;
    ver?: string;
    resolved_at?: string;
    resolved_by?: 'agent' | 'user';
    agent_activated_at?: string;

    // when the agent last read the thread with a request of its still unanswered
    agent_seen_at?: string;
    anchor?: Anchor;
    comments: Comment[];
};
export type Asset = { id: string; name: string; contentType: string; size: number; sha256: string; createdAt: string };

export const ROOT = join(HOME, 'stages');

const now = () => new Date().toISOString();
export const refuse = (status: number, message: string): never => {
    throw Object.assign(new Error(message), { status });
};
export const attempt = <T>(f: () => T): [unknown, T?] => {
    try {
        return [undefined, f()];
    } catch (e) {
        return [e];
    }
};

export const writeAtomic = (file: string, data: string | Buffer) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
};

const readJson = <T>(file: string, fallback: T): T =>
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const writeJson = (file: string, v: unknown) => writeAtomic(file, JSON.stringify(v, null, 1));

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const dir = (id: string) => {
    if (!UUID_RE.test(id)) {
        throw new Error('bad stage id');
    }
    return join(ROOT, id);
};

/** resolves a published path inside a version dir; undefined when it escapes */
export const inside = (base: string, rel: string) => {
    const p = normalize(join(base, rel));
    return p.startsWith(base + sep) ? p : undefined;
};

export const exists = (id: string) => UUID_RE.test(id) && existsSync(join(ROOT, id, 'meta.json'));
export const meta = (id: string): Meta => readJson(join(dir(id), 'meta.json'), null as unknown as Meta);
const saveMeta = (m: Meta) => writeJson(join(dir(m.id), 'meta.json'), m);

export const list = (): Meta[] =>
    existsSync(ROOT)
        ? readdirSync(ROOT)
              .filter(exists)
              .map(meta)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : [];

export const versionDir = (id: string, ver: string) => {
    if (!VER_RE.test(ver)) {
        throw new Error('bad version');
    }
    return join(dir(id), 'v', ver);
};

export const page = (id: string, ver?: string) => {
    const m = meta(id);
    return readFileSync(join(versionDir(id, ver ?? m.ver), 'index.html'), 'utf8');
};

export type PublishInput = {
    id?: string;
    title: string;
    description?: string;
    icon?: string;
    label?: string;
    html: string;
    live?: Live;
    files?: Record<string, { data: Buffer; contentType: string } | null>;
    capabilities?: Record<string, unknown>;
    contract?: string;
    by?: 'agent' | 'page';
};

/** mints a new version: the page plus carried, replaced and removed files */
export const publish = (p: PublishInput) => {
    const id = p.id ?? randomUUID();
    const prev = p.id ? meta(id) : undefined;
    const next = new Map(prev?.versions.at(-1)!.files.map((f) => [f.path, f.size]));
    for (const [path, f] of Object.entries(p.files ?? {})) {
        if (f) {
            next.set(path, f.data.length);
        } else {
            next.delete(path);
        }
    }
    const bytes = [...next.values()].reduce((n, x) => n + x, Buffer.byteLength(p.html));
    if (next.size > MAX_VERSION_FILES) {
        refuse(
            413,
            `a version holds at most ${MAX_VERSION_FILES} files besides the page; this one would hold ${next.size}`
        );
    }
    if (bytes > MAX_VERSION_BYTES) {
        refuse(
            413,
            `a version holds at most ${MAX_VERSION_BYTES / 1024 / 1024}MB in all; this one would hold ${(bytes / 1024 / 1024).toFixed(1)}MB`
        );
    }
    const ver = randomBytes(6).toString('hex');
    const vdir = versionDir(id, ver);
    mkdirSync(vdir, { recursive: true });
    if (!p.live) {
        writeFileSync(join(vdir, 'index.html'), p.html);
    }

    const written: FileEntry[] = [];
    const removed: string[] = [];
    const files = new Map<string, FileEntry>();
    if (prev) {
        const pdir = versionDir(id, prev.ver);
        for (const f of prev.versions.at(-1)!.files) {
            if (p.files && f.path in p.files) {
                continue;
            }
            const to = inside(vdir, f.path)!;
            mkdirSync(dirname(to), { recursive: true });
            const from = join(pdir, f.path);

            // version files are never rewritten, so sharing one inode is safe; copy where links fail
            if (attempt(() => linkSync(from, to))[0]) {
                copyFileSync(from, to);
            }
            files.set(f.path, f);
        }
    }
    for (const [path, f] of Object.entries(p.files ?? {})) {
        if (f === null) {
            removed.push(path);
            continue;
        }
        const to = inside(vdir, path);
        if (!to) {
            throw new Error(`files: ${path} escapes the stage`);
        }
        mkdirSync(dirname(to), { recursive: true });

        // rename, never write through: `to` may be a hard link carried from the previous version
        writeAtomic(to, f.data);
        const e = { path, contentType: f.contentType, size: f.data.length, sha256: sha256(f.data) };
        files.set(path, e);
        written.push(e);
    }

    const at = now();
    const carried = p.capabilities === undefined;
    const m: Meta = {
        id,
        title: p.title,
        description: p.description ?? prev?.description,
        icon: p.icon ?? prev?.icon,
        // the scene tools keep a live app's edits in its db
        capabilities: { ...(p.live && { db: {} }), ...(p.capabilities ?? prev?.capabilities) },
        contract: p.contract === 'latest' || !p.contract ? (prev?.contract ?? '1.0.0') : p.contract,
        createdAt: prev?.createdAt ?? at,
        updatedAt: at,
        ver,
        seq: (prev?.seq ?? 0) + 1,
        ...(p.live && { live: p.live }),
        versions: [
            ...(prev?.versions ?? []),
            { ver, seq: (prev?.seq ?? 0) + 1, at, label: p.label, by: p.by ?? 'agent', files: [...files.values()] }
        ]
    };
    saveMeta(m);
    return { meta: m, written, removed, carried };
};

export const remove = (id: string) => rmSync(dir(id), { recursive: true, force: true });

// comments

const commentsFile = (id: string) => join(dir(id), 'comments.json');
export const threads = (id: string): Thread[] => readJson(commentsFile(id), []);
export const saveThreads = (id: string, t: Thread[]) => writeJson(commentsFile(id), t);

type Image = { type: string; data: Buffer };

export const newThread = (id: string, text: string, anchor: Anchor | undefined, ver: string, images?: Image[]) => {
    if (Buffer.byteLength(text) > COMMENT_MAX_BYTES) {
        refuse(413, `a comment is at most ${COMMENT_MAX_BYTES} bytes`);
    }
    const t: Thread = { id: randomUUID(), created_at: now(), ver, anchor, comments: [] };
    const all = threads(id);
    all.push(t);
    saveThreads(id, all);
    return addComment(id, t.id, 'user', text, false, images);
};

const mentionsAgent = (text: string) => /(^|\s)@agent\b/i.test(text);

export const addComment = (
    id: string,
    tid: string,
    author: 'user' | 'agent',
    text: string,
    toAgent = false,
    images: Image[] = []
) => {
    if (Buffer.byteLength(text) > COMMENT_MAX_BYTES) {
        refuse(413, `a comment is at most ${COMMENT_MAX_BYTES} bytes`);
    }
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    if (!t || !UUID_RE.test(tid)) {
        return undefined;
    }
    const c: Comment = { id: randomUUID(), author, text, created_at: now() };
    for (const [k, img] of images.entries()) {
        writeAtomic(attachmentFile(id, tid, c.id, k, img.type), img.data);
    }
    if (images.length) {
        c.images = images.map((x) => ({ type: x.type }));
    }
    if (author === 'user' && (toAgent || mentionsAgent(text))) {
        c.to_agent_at = c.created_at;
        t.agent_activated_at ??= c.created_at;
    }
    t.comments.push(c);
    saveThreads(id, all);
    return { thread: t, comment: c };
};

/** "send to agent": activates the thread and marks its latest user comment */
export const sendToAgent = (id: string, tid: string) => {
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    if (!t) {
        return undefined;
    }
    const at = now();
    t.agent_activated_at ??= at;
    const last = t.comments.findLast((c) => c.author === 'user');
    if (last && !last.to_agent_at) {
        last.to_agent_at = at;
    }
    saveThreads(id, all);
    return t;
};

export const resolveThread = (id: string, tid: string, resolved: boolean, by: 'agent' | 'user') => {
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    if (!t) {
        return undefined;
    }
    if (resolved) {
        t.resolved_at = now();
        t.resolved_by = by;
    } else {
        delete t.resolved_at;
        delete t.resolved_by;
    }
    saveThreads(id, all);
    return t;
};

export const deleteThread = (id: string, tid: string) => {
    const t = threads(id).find((x) => x.id === tid);
    const s = t && agentStatus(t);

    // a request a session already heard of and has not answered is withdrawn in the next notice
    if (s && s.status !== 'queued') {
        writeJson(withdrawnFile(id), [...withdrawnOf(id), tid]);
    }
    if (UUID_RE.test(tid)) {
        rmSync(join(dir(id), 'comment-images', tid), { recursive: true, force: true });
    }
    return saveThreads(
        id,
        threads(id).filter((t) => t.id !== tid)
    );
};

// the bytes' own signature must match the claimed type, since the page supplies both
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
    'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/webp': (b) =>
        b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
};

/** decodes a data: url image (a capture or an attachment); undefined unless it is a small png, jpeg or webp */
export const commentImage = (url: unknown) => {
    const m =
        typeof url === 'string' &&
        url.length <= (COMMENT_IMAGE_MAX_BYTES * 4) / 3 + 64 &&
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!m) {
        return undefined;
    }
    const b = Buffer.from(m[2], 'base64');
    return b.length <= COMMENT_IMAGE_MAX_BYTES && SIGNATURES[m[1]](b) ? { type: m[1], data: b } : undefined;
};

// a thread's captures: n 0 is its anchor's, n >= 1 the one of its nth Shift-picked `also` anchor
const imageTarget = (t: Thread | undefined, n: number) => (n === 0 ? t?.anchor : t?.anchor?.also?.[n - 1]);
const imageFile = (id: string, tid: string, n: number, type: string) =>
    join(dir(id), 'comment-images', tid, `${n ? `also-${n}` : 'area'}.${COMMENT_IMAGE_TYPES[type]}`);

/** stores one of a thread's captures and records its type on the anchor it shows */
export const setThreadImage = (id: string, tid: string, img: { type: string; data: Buffer }, n = 0) => {
    const all = threads(id);
    const t = all.find((x) => x.id === tid);
    const a = imageTarget(t, n);
    if (!a || !UUID_RE.test(tid)) {
        return undefined;
    }
    writeAtomic(imageFile(id, tid, n, img.type), img.data);
    a.image = { type: img.type };
    saveThreads(id, all);
    return t;
};

// a comment's attachments sit beside its thread's captures, so deleting the thread drops them too
const attachmentFile = (id: string, tid: string, cid: string, k: number, type: string) =>
    join(dir(id), 'comment-images', tid, `${cid}-${k}.${COMMENT_IMAGE_TYPES[type]}`);

export const commentAttachment = (id: string, tid: string, cid: string, k: number) => {
    const type = threads(id)
        .find((x) => x.id === tid)
        ?.comments.find((c) => c.id === cid)?.images?.[k]?.type;
    const file = type && UUID_RE.test(tid) && UUID_RE.test(cid) ? attachmentFile(id, tid, cid, k, type) : '';
    return file && existsSync(file) ? { type: type!, file } : undefined;
};

export const threadImage = (id: string, tid: string, n = 0) => {
    const type = imageTarget(
        threads(id).find((x) => x.id === tid),
        n
    )?.image?.type;
    const file = type && UUID_RE.test(tid) ? imageFile(id, tid, n, type) : '';
    return file && existsSync(file) ? { type: type!, file } : undefined;
};

// the request the agent still owes an answer on: the latest comment sent to it, if nothing answered it since
const openAsk = (t: Thread) => {
    if (t.resolved_at) {
        return undefined;
    }
    const i = t.comments.findLastIndex((c) => !!c.to_agent_at);
    return i >= 0 && !t.comments.slice(i + 1).some((c) => c.author === 'agent') ? t.comments[i] : undefined;
};

/** The agent's progress on a thread: queued until a session hears of it, then working until it answers or AGENT_WORK_MS passes */
export const agentStatus = (t: Thread, at = Date.now()) => {
    const ask = openAsk(t);
    if (!ask) {
        return undefined;
    }
    const seen = t.agent_seen_at && t.agent_seen_at >= ask.to_agent_at! ? t.agent_seen_at : undefined;
    const start = [ask.delivered_at, seen].filter(Boolean).sort().pop();
    if (!start) {
        return { status: 'queued' as const };
    }
    const until = Date.parse(start) + AGENT_WORK_MS;
    return at < until
        ? { status: 'working' as const, until: new Date(until).toISOString() }
        : { status: 'waiting' as const };
};

/** marks threads with an open request as read by the agent; true when any changed */
export const markSeen = (id: string) => {
    const all = threads(id);
    const at = now();
    const open = all.filter(openAsk);
    for (const t of open) {
        t.agent_seen_at = at;
    }
    if (open.length) {
        saveThreads(id, all);
    }
    return open.length > 0;
};

// comments sent to the agent that no notice has mentioned yet, and threads deleted while it was on them,
// on every stage or only on `ids`
const noticeFile = join(HOME, 'notice.json');
const withdrawnFile = (id: string) => join(dir(id), 'withdrawn.json');
const withdrawnOf = (id: string): string[] => readJson(withdrawnFile(id), []);
export const pending = (ids?: string[]) => {
    const seen: Record<string, string> = readJson(noticeFile, {});
    const out: { id: string; title: string; count: number; withdrawn: string[] }[] = [];
    const next = { ...seen };
    for (const m of list().filter((a) => !ids || ids.includes(a.id))) {
        const since = seen[m.id] ?? '';
        let count = 0;
        const all = threads(m.id);
        const at = now();
        for (const t of all) {
            for (const c of t.comments) {
                if (c.to_agent_at && c.to_agent_at > since) {
                    count++;
                    c.delivered_at ??= at;
                }
            }
        }
        if (count) {
            saveThreads(m.id, all);
        }
        const withdrawn = existsSync(withdrawnFile(m.id)) ? withdrawnOf(m.id) : [];
        if (withdrawn.length) {
            rmSync(withdrawnFile(m.id), { force: true });
        }
        if (count || withdrawn.length) {
            out.push({ id: m.id, title: m.title, count, withdrawn });
        }
        next[m.id] = at;
    }
    if (out.some((p) => p.count)) {
        writeJson(noticeFile, next);
    }
    return out;
};

/** comments the agent just read need no notice */
export const ack = (id: string) => writeJson(noticeFile, { ...readJson(noticeFile, {}), [id]: now() });

// assets

const assetsFile = (id: string) => join(dir(id), 'assets.json');
export const assets = (id: string): Asset[] => readJson(assetsFile(id), []);
export const assetPath = (id: string, aid: string) => join(dir(id), 'assets', aid);
export const addAsset = (id: string, name: string, contentType: string, data: Buffer) => {
    if (!Object.values(ASSET_TYPES).includes(contentType)) {
        refuse(
            415,
            `${contentType} is not an uploadable asset type (images, video, PDF, fonts, CSS, JS, CSV, Markdown, JSON, plain text)`
        );
    }
    const max = contentType === 'image/svg+xml' ? MAX_SVG_ASSET_BYTES : MAX_ASSET_BYTES;
    if (data.length > max) {
        refuse(413, `an asset of this type is at most ${max / 1024 / 1024}MB`);
    }
    const all = assets(id);
    if (all.length >= MAX_ASSET_FILES) {
        refuse(413, `the asset store holds at most ${MAX_ASSET_FILES} files`);
    }
    if (all.reduce((n, x) => n + x.size, data.length) > MAX_ASSET_STORE_BYTES) {
        refuse(413, `the asset store holds at most ${MAX_ASSET_STORE_BYTES / 1024 / 1024 / 1024}GB`);
    }
    const a: Asset = {
        id: randomBytes(16).toString('hex'),
        name: String(name).slice(0, 255),
        contentType,
        size: data.length,
        sha256: sha256(data),
        createdAt: now()
    };
    writeAtomic(assetPath(id, a.id), data);
    writeJson(assetsFile(id), [...all, a]);
    return a;
};
export const deleteAsset = (id: string, aid: string) => {
    const all = assets(id);
    if (!all.some((a) => a.id === aid)) {
        return false;
    }
    rmSync(assetPath(id, aid), { force: true });
    writeJson(
        assetsFile(id),
        all.filter((a) => a.id !== aid)
    );
    return true;
};

// diagnostics captured by viewers' browsers, per version

const diagFile = (id: string, ver: string) => join(dir(id), 'diag', `${ver}.json`);
export const diag = (id: string, ver: string): { entries: unknown[]; truncated: boolean } | undefined =>
    existsSync(diagFile(id, ver)) ? readJson(diagFile(id, ver), { entries: [], truncated: false }) : undefined;
export const addDiag = (id: string, ver: string, entries: unknown[]) => {
    if (!VER_RE.test(ver)) {
        return;
    }
    const d = diag(id, ver) ?? { entries: [], truncated: false };
    let bytes = JSON.stringify(d.entries).length;
    for (const e of entries) {
        const n = JSON.stringify(e).length;
        if (d.entries.length >= DIAG_MAX_ENTRIES || bytes + n > DIAG_MAX_BYTES) {
            d.truncated = true;
            break;
        }
        d.entries.push(e);
        bytes += n;
    }
    writeJson(diagFile(id, ver), d);
};

// the one local person

export const me = () => {
    const name = env('USER') ?? userInfo().username;
    const b = createHash('sha256').update(`local:${name}`).digest('base64url').replace(/-/g, '_');
    return { id: `u_${b.slice(0, 22)}`, name };
};

export const size = (file: string) => statSync(file).size;
