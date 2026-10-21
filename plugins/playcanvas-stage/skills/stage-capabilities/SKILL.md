---
name: stage-capabilities
description: Runtime capabilities for Stage pages - a shared document database, the current viewer, an asset store for uploaded files, and self-republishing - with the window.agent call contract. Load before passing `capabilities` to the Stage tool or writing any `window.agent.*` code.
---

# Stage runtime capabilities

A published Stage page can declare **runtime capabilities** — abilities the local viewer grants the page at open time — by passing `capabilities: {name: config}` to the Stage tool. Declaration gestures: **omitting** `capabilities` on a redeploy carries the stored declaration forward unchanged (and preserves the stage's stored contract pin); an **empty object** `{}` is the explicit clear-all; a **non-empty object** is a full-set declaration (anything stored but not restated is revoked). Moving a republished stage's runtime version is a deliberate gesture — pass `contract: 'latest'` to upgrade, or a specific version to pin or roll back — never a side effect of editing.

**A page that republishes itself** through the `stage` capability sends its whole document in exactly the shape the Stage tool publishes, so a later publish from the tool recognizes and replaces the skeleton instead of nesting it: `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>` the same small reset the tool's description names `</style></head><body>` — no whitespace between those tags and nothing else in the head — then the page content exactly as it was written for the tool (its `<title>` and `<style>` first, inside the body, regenerated from the page's state), then `</body></html>`. Build that string from the page's own template and current state, not from `document.documentElement.outerHTML`: the live DOM carries whatever scripts and the viewer runtime added.

**Available capabilities:** `db`, `user`, `assets`, `stage` — the complete set of capability names you may declare. Each takes an empty config object: `capabilities: {db: {}, user: {}}`. Declare only what the page uses.

| name     | what the page gets                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db`     | a document database shared by every open view of this stage, durable across reloads and republishes; the agent reads and writes it with the `StageData` tool |
| `user`   | who is viewing (`{id, name}`), and `data/users/me` resolving to that person                                                                                  |
| `assets` | an asset store for files people add through the page (and files the agent uploads with `asset: true`)                                                        |
| `stage`  | the page can publish a new version of itself                                                                                                                 |

**Call contract** (runtime contract 1.0.0). `window.agent.use(name)` returns a Promise of the capability's handle, or of `null` when the published version does not declare that name (or in `StageCheck` preview, where no runtime exists). Always handle `null` — render a static fallback — and never assume a handle exists.

```ts
interface Agent {
    use(name: 'db'): Promise<Db | null>;
    use(name: 'user'): Promise<User | null>;
    use(name: 'assets'): Promise<Assets | null>;
    use(name: 'stage'): Promise<StageSelf | null>;
}

// db — paths alternate collection/document: "tasks/t1", "boards/b1/columns/c2".
// "data/users/me/…" is the current viewer's own subtree (declare `user` too).
interface Db {
    doc(path: string): DocRef; // path = "<collection>/<id>"
    collection(path: string): Query; // odd number of segments
    batch(writes: { op: 'set' | 'update' | 'delete'; path: string; data?: object }[]): Promise<void>; // ≤ 50, all-or-nothing
}
interface DocRef {
    get(): Promise<Snapshot>;
    set(data: object): Promise<void>; // replace
    update(data: object): Promise<void>; // deep-merge; a field set to {"__delete__": true} is removed
    delete(): Promise<void>;
    onSnapshot(cb: (s: Snapshot) => void): () => void; // called now and on every change; returns unsubscribe
}
interface Query {
    doc(id: string): DocRef;
    where(
        field: string,
        op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains',
        value: unknown
    ): Query;
    orderBy(field: string, direction?: 'asc' | 'desc'): Query;
    limit(n: number): Query; // ≤ 1000
    get(): Promise<{ docs: Snapshot[] }>;
    onSnapshot(cb: (r: { docs: Snapshot[] }) => void): () => void;
}
interface Snapshot {
    id: string;
    exists: boolean;
    version?: number;
    data(): any;
}

interface User {
    me(): Promise<{ id: string; name: string }>;
} // id is "u_" + 22 chars

interface Assets {
    upload(
        file: Blob | File,
        name?: string
    ): Promise<{ id: string; url: string; name: string; contentType: string; size: number }>;
    list(): Promise<{ id: string; url: string; name: string; contentType: string; size: number }[]>;
    url(id: string): string; // "/_blob/<id>", usable in <img src>, fetch, CSS url()
}

interface StageSelf {
    publish(html: string): Promise<{ ver: string; seq: number }>;
} // rejects with code "conflict" when a newer version exists
```

Writes reject with an `Error` whose `code` is one of `not_found`, `invalid_argument`, `version_mismatch`, `edit_no_match`, `edit_ambiguous`, `too_large`, `not_declared`. A write to a document this page has read is pinned to the version it read, so a concurrent change from another view or from the agent fails with `version_mismatch` instead of being overwritten — re-read, reapply, write again.

**Patterns**

- Records people or the agent add later (placements, annotations, a review checklist) live in `db`, one document per record in a collection, never in the page source or `localStorage`. Render from `collection(...).onSnapshot(...)` so the page stays current when the agent writes rows with `StageData`.
- Seed example rows only when the collection is empty, and mark them as examples.
- Per-person state (a viewer's votes, drafts, preferences that must survive) goes under `data/users/me/…` with `user` declared.
- Files people add: `assets.upload(file)` from an `<input type=file>` or drop handler, then store the returned `id` in a `db` document; render with `assets.url(id)`.
- Every capability call can fail: catch it, show the error in the page, and keep the rest of the page working.
- The runtime reports console errors, uncaught errors, failed loads and failed capability calls to `StageCheck` `verify` — after publishing, open the page (or ask the user to), then verify.

Tool spelling in this session: the `Stage` tool's `action: "read_db"` / `"write_db"` with a `db_op` are the `StageData` tool, whose `action` is that `db_op` ("get", "list", "query", "set", "update", "str_replace", "delete", "batch") with the other fields unchanged; the `Stage` tool's `action: "verify"` / `action: "preview"` are the `StageCheck` tool's.
