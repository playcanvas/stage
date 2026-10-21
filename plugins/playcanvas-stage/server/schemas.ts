// input schemas of the four tools: split-toolset field names, limits and describe texts
import {
    DB_BATCH_MAX,
    DB_QUERY_MAX,
    DB_STR_MAX,
    DB_WHERE_MAX,
    LIST_DEFAULT,
    LIST_MAX,
    MAX_FILE_PATHS,
    MAX_READ_PATHS,
    PREVIEW_MAX_WIDTHS
} from './constants.ts';

type S = Record<string, unknown>;
const str = (description: string, extra: S = {}) => ({ type: 'string', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });
const obj = (properties: S, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false
});

const SEG = String.raw`(?!\.\.?(?:/|$))[A-Za-z0-9_\-.~:@+]{1,200}`;
const COLLECTION = `^${SEG}(?:/${SEG}){0,14}$`;
const DOC_ID = `^${SEG}$`;

export const STAGE = obj({
    action: {
        type: 'string',
        enum: ['publish', 'list', 'read', 'delete'],
        description:
            "One of 'publish', 'list', 'read', 'delete'. Omitting it means 'publish'. **Calls** in the description says what each one does and takes, except as noted here."
    },
    file_path: str(
        'publish: the local .html scene page the agent publishes. With `asset: true`, it is the local file the agent uploads. A short, distinctive basename also serves as the title when nothing else gives one.'
    ),
    asset: bool(
        "publish with `url`: true uploads `file_path` (or each of `file_paths`) to that stage's asset store instead of publishing it as the page (see **Calls**)."
    ),
    file_paths: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_FILE_PATHS,
        items: { type: 'string', minLength: 1, maxLength: 1024 },
        description: `publish with \`asset: true\` only: up to ${MAX_FILE_PATHS} local image, video, PDF, font, stylesheet or script files to upload in one call under one approval, in place of \`file_path\`. A text file (CSV, Markdown, JSON, plain text) goes in a call of its own.`
    },
    icon: str(
        "One short generic word for the stage's browser-tab icon, such as chart, calendar, recipe, code or map: a plain signifier, never a product or brand name. The agent includes it on every page's first publish and omits it on a redeploy so the stage keeps its icon, passing a new one only when the person asks.",
        { maxLength: 40 }
    ),
    files: {
        type: ['object', 'array'],
        description:
            'Supporting files to publish alongside the page, as a map {"published/path": "source/path" | {from, contentType} | null}. The key is what the HTML references. The source is a path on disk, or {from, contentType} when the type cannot be inferred from the published extension. null removes that path on an update, and files left out are kept. A plain list publishes each file at its own spelling. Sources must be under the working directory or the agent\'s scratchpad directory.'
    },
    root: str(
        "With a dev server `url`: the project directory that server serves, where its source lives (required to attach). With `files`: the base directory that relative `files` sources resolve against, like a bundler root, which never changes published paths. Either way it is relative to the working directory, or absolute within it or within the agent's scratchpad directory.",
        { minLength: 1, maxLength: 1024 }
    ),
    limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIST_MAX,
        description: `list only: the maximum number of stages to return (default ${LIST_DEFAULT}).`
    },
    scope: {
        type: 'string',
        enum: ['mine', 'shared', 'all', 'files', 'assets'],
        description:
            "list: which listing to return. 'mine' is the default. The others are 'shared', 'all', 'files' (with `url`) and 'assets' (with `url`, continued with `after`). See **Calls**."
    },
    title: str(
        'publish: the fallback title for an HTML page whose file has no <title>. It is a name, not a summary, and the agent keeps it the same across redeploys.'
    ),
    description: str('publish: one sentence for the subtitle on the gallery card.', { maxLength: 1000 }),
    label: str(
        'A short name for this publish, at most 60 characters (e.g. "Draft to legal"). Optional. It is a few words, not a description.',
        { maxLength: 60 }
    ),
    url: str(
        "An existing stage's URL (http://localhost:<port>/stage/<uuid>). On a publish, it is the stage to update in place; the agent omits it for a new stage or a redeploy in the same conversation (see **To update a stage from an earlier conversation**). For read, delete and the other calls that take a URL, it is the stage to act on. On a publish without `file_path`, any other URL is a running dev server's page to attach to (`http://` on localhost, 127.0.0.1 or [::1], path and query kept), with the project directory as `root` (see **Live apps**)."
    ),
    allow: {
        type: 'array',
        maxItems: 16,
        items: { type: 'string', maxLength: 256 },
        description:
            'Attaching to a dev server only: other origins the app calls, such as its API server (http://localhost:3000), which the frame then allows: http(s) or ws(s), with no path.'
    },
    prompt: str(
        'read: what the agent needs from the stage. Local stages are always returned in full, so this is ignored.'
    ),
    force: bool(
        'publish: a last-resort overwrite that **discards** the newer published version. On a conflict, the agent merges its changes onto the newer content that the rejection hands it and publishes again. The agent passes true only when the person explicitly said to discard that specific version.'
    ),
    out_dir: str(
        "read with `path`: the directory to save into. The default is this stage's folder under ~/.playcanvas-stage/reads. A published file lands at <out_dir>/<published path>. An asset's file is named by its id plus its type's extension.",
        { maxLength: 4096 }
    ),
    path: str(
        `read: the file's published path inside the stage, exactly as a 'files' listing printed it ("index.html" is the page itself). The file is saved locally, the result says where, and a small text file's contents are included. It can instead be an uploaded asset's id (32 hex characters, from an 'assets' listing or an upload result), and that asset is saved to a local file. delete: the id of the one asset to remove.`,
        { maxLength: 512 }
    ),
    paths: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_READ_PATHS,
        items: { type: 'string', maxLength: 512 },
        description: `read: several published paths in place of \`path\`, up to ${MAX_READ_PATHS} in one call. Each file is saved as a single \`path\` would be, and the result lists where each one landed, or why it could not be read, with small text files' contents included while they fit.`
    },
    after: str("list with scope 'assets' only: the `next` value from a previous listing, passed to continue it.", {
        pattern: '^[A-Za-z0-9_=-]{1,4096}$'
    }),
    capabilities: {
        type: 'object',
        description:
            'publish: the runtime capabilities this page declares, as {name: config}. The agent loads the `stage-capabilities` skill before passing it. On a redeploy the agent omits the field to keep what the page has, and {} clears it.'
    },
    contract: str(
        "publish: the stage's runtime version. Leaving it out keeps the current version (the default), 'latest' upgrades, and an exact version pins or rolls back. It changes how the published page behaves, so the agent passes it only when the author explicitly intends that change."
    )
});

export const COMMENTS = obj(
    {
        action: {
            type: 'string',
            enum: ['read', 'reply', 'resolve', 'watch'],
            description:
                "'read' reads the comment threads on the stage at `url` (add `thread_id` for one thread, or `cursor` to continue a listing); 'reply' posts `text` into the thread `thread_id`; 'resolve' marks that thread resolved; 'watch' manages this session's stage watches — with `url` it starts watching that stage (`on: false` stops), with no `url` it lists this session's watches and rooms."
        },
        url: str("The stage's URL. Required for every action except a bare 'watch' listing."),
        thread_id: str(
            'reply: id of the comment thread to reply into. resolve: the thread to mark resolved. read: read just this one thread (the size cap can still elide a very long thread). Thread ids come from action "read" and from comment notifications.'
        ),
        text: str('reply only: the reply text. Plain text, at most 4096 bytes of UTF-8.'),
        cursor: str(
            'read only: continue a listing that ended with a "more threads not listed" line — pass the cursor value that line names to render the threads it could not fit.'
        ),
        acknowledge_duplicate: bool(
            'reply only: post even though an agent reply already stands after every "sent to the agent" request on the thread. Without it such a reply is refused as a likely duplicate. Pass true only for a deliberate follow-up that adds something new — never to restate what the standing reply said.'
        ),
        on: bool('watch only: false stops watching the stage at `url`; omit (or true) to start.')
    },
    ['action']
);

const writeEntry = obj(
    {
        op: { type: 'string', enum: ['set', 'update', 'delete'] },
        collection: { type: 'string', maxLength: 1000, pattern: COLLECTION },
        doc_id: { type: 'string', pattern: DOC_ID },
        data: { type: 'object' },
        file_path: { type: 'string' },
        if_version: { type: 'integer', minimum: 1 }
    },
    ['op', 'collection', 'doc_id']
);

export const DATA = obj(
    {
        action: {
            type: 'string',
            enum: ['get', 'list', 'query', 'set', 'update', 'delete', 'str_replace', 'batch', 'profiles'],
            description:
                "Reads: 'get' (one document: `collection` + `doc_id`), 'list' (a page of a collection: `collection`, with optional `query.limit`/`query.cursor`), 'query' (filtered: `collection` + `query`), 'profiles' (people's display names: `ids`, nothing else). Writes: 'set' (replace) or 'update' (merge) with `collection`, `doc_id`, and either `data` or `file_path`; 'str_replace' with `collection`, `doc_id`, `field`, `old_str`, `new_str` — swaps one exact, unique piece of text inside a string field without resending the field (`replace_all`: every occurrence); 'delete' with `collection` + `doc_id`; 'batch' with `writes`. Every action takes the stage's `url`."
        },
        url: str("The stage's URL. Required."),
        writes: {
            type: 'array',
            minItems: 1,
            maxItems: DB_BATCH_MAX,
            items: writeEntry,
            description:
                "action 'batch' only: the writes to apply together, 1-50 entries of {op: 'set'|'update'|'delete', collection, doc_id, and for set/update exactly one of data (inline object) or file_path (a local JSON file), plus if_version — that document's last-read `version` (optional; omit it only for a document you have not read); if any pinned document has changed since, the whole batch writes nothing and the result names the entry and its current version}. Each document is addressed at most once; the batch commits all-or-nothing. Prefer it over separate calls whenever you write more than a couple of documents."
        },
        collection: {
            type: 'string',
            maxLength: 1000,
            pattern: COLLECTION,
            description:
                'Database collection path: an odd number (1-15) of "/"-separated segments (letters, digits, _ - . ~ : @ + per segment). Paths alternate collection/document, so "boards/b1/columns" is a collection and, with `doc_id` "c2", names the document "boards/b1/columns/c2". Per-user data: "data/users/<id>" (3 segments) is the collection holding that user\'s documents, "data/users/<id>/decks" is one document in it, and "data/users/<id>/decks/cards" a collection under that; "me" as the <id> means the current user. Required for every action except \'batch\' and \'profiles\'.'
        },
        ids: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: { type: 'string' },
            description:
                'action \'profiles\' only: the people to name, 1-64 ids exactly as a document or live event showed them ("u_" plus 22 characters).'
        },
        doc_id: {
            type: 'string',
            pattern: DOC_ID,
            description:
                "Document id (one path segment). Required for action 'get', 'set', 'update', 'str_replace' and 'delete'; not accepted with 'list' or 'query'."
        },
        query: {
            ...obj({
                where: {
                    type: 'array',
                    maxItems: DB_WHERE_MAX,
                    items: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 3,
                        prefixItems: [
                            { type: 'string' },
                            {
                                type: 'string',
                                enum: [
                                    'eq',
                                    'ne',
                                    'in',
                                    'not-in',
                                    'lt',
                                    'lte',
                                    'gt',
                                    'gte',
                                    'array-contains',
                                    '==',
                                    '!=',
                                    '<',
                                    '<=',
                                    '>',
                                    '>='
                                ]
                            },
                            {}
                        ]
                    }
                },
                order_by: obj({ field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } }, [
                    'field'
                ]),
                limit: { type: 'integer', minimum: 1, maximum: DB_QUERY_MAX },
                cursor: { type: 'string', maxLength: 4096 }
            }),
            description:
                "Options for action 'list' and 'query': `limit` (1-1000, default 100) and `cursor` (from a prior result's `next_cursor`) page through a collection; `where` clauses ([field, operator, value] triples) and `order_by` filter and order a 'query' only. A query with `order_by` is a single page: it returns at most `limit` documents in that order and never a `next_cursor`, so pass the `limit` you mean (up to 1000), or drop `order_by` and page with `cursor` to read a whole collection."
        },
        field: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description:
                'action \'str_replace\' only: the top-level string field of the document to edit — one plain key, e.g. "html" (1-200 bytes; no dots, slashes, brackets, quotes, backslashes, control or invisible formatting characters; not a reserved __name__ key).'
        },
        old_str: {
            type: 'string',
            minLength: 1,
            maxLength: DB_STR_MAX,
            description:
                "action 'str_replace' only: the exact text to replace, as it appears in the field's value. It must occur exactly once in that field; otherwise nothing is written and the result says whether it was absent or not unique."
        },
        new_str: {
            type: 'string',
            maxLength: DB_STR_MAX,
            description: "action 'str_replace' only: the replacement text (may be empty to delete old_str)."
        },
        replace_all: bool(
            "action 'str_replace' only: replace every occurrence of old_str in the field instead of requiring it to occur exactly once (default false). old_str must still occur at least once."
        ),
        if_version: {
            type: 'integer',
            minimum: 1,
            description:
                "action 'set', 'update', 'str_replace' or 'delete' (a 'batch' pins each entry in `writes` instead): the document's `version` as you last read it (every document a get, list or query returns carries it, and so does every set, update and str_replace result). Pass it on every write to a document you have read: the write applies only if the document is still at that version; otherwise nothing is written and the result names the current version — so pin the write instead of re-reading first to check. Optional; omit it only for a document you have not read."
        },
        data: {
            type: 'object',
            description:
                'set and update: the document fields to write, as a JSON object — pass exactly one of `data` or `file_path`. In an update, a field given as `{"__delete__": true}` is removed instead.'
        },
        file_path: str(
            'set and update: a local JSON file whose top-level object is sent as the document — an alternative to inline `data`, so a large document need not pass through the conversation.'
        ),
        out_dir: str(
            'get, list and query: when given, each returned document is written as pretty-printed JSON to <out_dir>/<collection path>/<doc_id>.json (directories created as needed) and the result lists the files instead of the document contents — use it for large documents or many of them.',
            { maxLength: 4096 }
        ),
        as_level: {
            type: 'string',
            enum: ['interact', 'admin'],
            description:
                "Act at this access level instead of your own — 'interact' is any signed-in viewer who can use the page, 'admin' a co-owner — to check what the page's access rules let such a user do. It narrows, never raises, your access; the call still reads and writes your own data/users subtree. At a lowered level a write the rules refuse reads as not found and a refused read as empty. Omit it to act as yourself."
        }
    },
    ['action']
);

export const CHECK = obj(
    {
        action: {
            type: 'string',
            enum: ['verify', 'preview'],
            description:
                "'verify' reads the runtime diagnostics (console output, uncaught errors, failed resource loads, capability-call outcomes) that viewers' browsers captured for a stage's current version — pass `url`, or omit it to target this session's most recent publish. An empty result can mean no viewer has loaded the version yet, which is NOT evidence of a clean render. 'preview' renders a local page file before you publish it — pass `file_path` (one .html file; files published beside it are not loaded), optionally `widths` (viewport widths in px, default 1280 and 390) and `themes` ('light', 'dark', default both) — and returns a screenshot per width and theme (each shows at most the top 1568 px of the page) plus a checklist of layout and load problems (horizontal overflow, clipped content, theme-only color variables, blocked or local-only loads, diagram and console errors). Nothing is uploaded."
        },
        url: str("verify: the stage's URL — omit to target this session's most recent publish."),
        file_path: str('preview: the local .html page to render.'),
        widths: {
            type: 'array',
            minItems: 1,
            maxItems: PREVIEW_MAX_WIDTHS,
            items: { type: 'integer', minimum: 320, maximum: 2560 },
            description: 'preview only: viewport widths to render at, in CSS pixels (default 1280 and 390; at most 3).'
        },
        themes: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: { type: 'string', enum: ['light', 'dark'] },
            description:
                "preview only: color themes to render, 'light' and/or 'dark' (default both) — each sets the page's data-theme attribute and the emulated prefers-color-scheme together."
        }
    },
    ['action']
);
