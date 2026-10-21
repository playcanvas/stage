import { homedir } from 'node:os';
import { join } from 'node:path';

export const env = (k: string) => process.env[`STAGE_${k}`];

export const HOME = env('DIR') ?? join(homedir(), '.playcanvas-stage');
export const PORT = Number(env('PORT') ?? 47318);
export const HOST = '127.0.0.1';
export const AUTO_OPEN = env('AUTO_OPEN') !== '0';

// bumped when the daemon's api changes, so clients replace an older daemon still running
export const API_VERSION = 1;

export const MAX_PAGE_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BINARY_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_PUBLISH_BYTES = 64 * 1024 * 1024;
export const MAX_VERSION_BYTES = 256 * 1024 * 1024;
export const MAX_PUBLISH_FILES = 255;
export const MAX_VERSION_FILES = 511;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_SVG_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ASSET_FILES = 500;
export const MAX_ASSET_STORE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILE_PATHS = 25;
export const MAX_READ_PATHS = 256;
export const TITLE_SCAN_BYTES = 8192;
export const LIST_DEFAULT = 25;
export const LIST_MAX = 50;
export const REPLY_MAX_BYTES = 4096;
export const ENVELOPE_CHARS = 16000;

// a drawn comment area quotes at most this many covered elements (a 3d part list runs long)
export const REGION_INSIDE_MAX = 16;

// more anchors one comment can hold, Shift+clicked in after the first
export const ANCHOR_ALSO_MAX = 8;

// a thread the agent picked up shows as working this long without a reply, as claude.ai tracks a summon
export const AGENT_WORK_MS = 10 * 60 * 1000;

// each session's mcp server checks in this often with the stages it links to (its comment monitor polls faster);
// a check-in older than the ttl counts as gone
export const PRESENCE_MS = 5000;
export const PRESENCE_TTL_MS = 12000;

// a comment's captures from a page (a 3d scene's canvas): the largest stored size of each, and how many one read hands the agent
export const COMMENT_IMAGE_MAX_BYTES = 1024 * 1024;
export const COMMENT_IMAGES_PER_READ = 8;

// images the person attaches to one comment as references, pasted or picked
export const COMMENT_ATTACHMENTS_MAX = 4;
export const COMMENT_IMAGE_TYPES: Record<string, string> = {
    'image/webp': 'webp',
    'image/png': 'png',
    'image/jpeg': 'jpg'
};
export const DIAG_MAX_BYTES = 65536;
export const DIAG_MAX_ENTRIES = 500;
export const DB_BATCH_MAX = 50;
export const DB_QUERY_DEFAULT = 100;
export const DB_QUERY_MAX = 1000;
export const DB_WHERE_MAX = 10;
export const DB_STR_MAX = 262144;
export const DB_RESULT_CHARS = 300000;
export const DB_DOC_MAX_BYTES = 1024 * 1024;
export const DB_MAX_DOCS = 100000;
export const COMMENT_MAX_BYTES = 16384;
export const PREVIEW_MAX_WIDTHS = 3;
export const PREVIEW_SHOT_MAX_HEIGHT = 1568;
export const PREVIEW_DEFAULT_WIDTHS = [1280, 390];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ASSET_ID_RE = /^[0-9a-f]{32}$/;
export const VER_RE = /^[0-9a-f]{12}$/;
const SEG = String.raw`(?!\.\.?(?:/|$))[A-Za-z0-9_\-.~:@+]{1,200}`;
export const DOC_ID_RE = new RegExp(`^${SEG}$`);
export const COLLECTION_RE = new RegExp(`^${SEG}(?:/${SEG}){0,14}$`);
export const FIELD_RE = /^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$/u;
export const CURSOR_RE = /^[A-Za-z0-9_=-]{1,4096}$/;
export const CONTRACT_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;
export const PROFILE_ID_RE = /^u_[A-Za-z0-9_]{22}$/;
export const CONTRACT_VERSION = '1.0.0';
export const CAPABILITIES = ['db', 'user', 'assets', 'stage'];

export const PAGE_EXTS = ['.html', '.htm'];

// published supporting files: extension -> media type (reference c0173)
export const FILE_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.geojson': 'application/geo+json',
    '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.wasm': 'application/wasm'
};

export const ASSET_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.ts': 'text/plain',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript'
};

// text assets each need their own upload call, like the original
export const TEXT_ASSET_EXTS = ['.csv', '.md', '.markdown', '.json', '.txt'];

export const CDN_SCRIPT_HOSTS = [
    'https://cdnjs.cloudflare.com',
    'https://cdn.jsdelivr.net/npm/',
    'https://unpkg.com',
    'https://cdn.tailwindcss.com',
    'https://code.jquery.com'
];

export const FRAME_CSP = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${CDN_SCRIPT_HOSTS.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'"
].join('; ');

export const PERMISSIONS_POLICY =
    'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), payment=(), usb=(), serial=(), bluetooth=()';
