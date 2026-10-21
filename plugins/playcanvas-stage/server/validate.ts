// the json-schema subset schemas.ts uses; unknown keys are rejected like the original's strict objects

type Schema = {
    type?: string | string[];
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean;
    enum?: unknown[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    items?: Schema;
    prefixItems?: Schema[];
    minItems?: number;
    maxItems?: number;
};

const kind = (v: unknown) =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const fits = (v: unknown, t: string) =>
    kind(v) === t || (t === 'number' && typeof v === 'number') || (t === 'integer' && kind(v) === 'integer');

/** returns the first problem as a message, or undefined when the value fits */
export const validate = (s: Schema, v: unknown, at = 'input'): string | undefined => {
    if (s.type) {
        const types = Array.isArray(s.type) ? s.type : [s.type];
        if (!types.some((t) => fits(v, t))) {
            return `${at}: expected ${types.join(' or ')}, got ${kind(v)}`;
        }
    }
    if (s.enum && !s.enum.includes(v)) {
        return `${at}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`;
    }
    if (typeof v === 'string') {
        if (s.minLength !== undefined && v.length < s.minLength) {
            return `${at}: must be at least ${s.minLength} characters`;
        }
        if (s.maxLength !== undefined && v.length > s.maxLength) {
            return `${at}: must be at most ${s.maxLength} characters`;
        }
        if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) {
            return `${at}: ${JSON.stringify(v)} is not a valid value`;
        }
    }
    if (typeof v === 'number') {
        if (s.minimum !== undefined && v < s.minimum) {
            return `${at}: must be ≥ ${s.minimum}`;
        }
        if (s.maximum !== undefined && v > s.maximum) {
            return `${at}: must be ≤ ${s.maximum}`;
        }
    }
    if (Array.isArray(v)) {
        if (s.minItems !== undefined && v.length < s.minItems) {
            return `${at}: needs at least ${s.minItems} entries`;
        }
        if (s.maxItems !== undefined && v.length > s.maxItems) {
            return `${at}: takes at most ${s.maxItems} entries`;
        }
        for (const [i, x] of v.entries()) {
            const e = s.prefixItems?.[i] ?? (s.prefixItems ? undefined : s.items);
            const err = e && validate(e, x, `${at}[${i}]`);
            if (err) {
                return err;
            }
        }
    }
    if (kind(v) === 'object' && s.properties) {
        const o = v as Record<string, unknown>;
        for (const k of s.required ?? []) {
            if (o[k] === undefined) {
                return `${at}.${k}: required`;
            }
        }
        for (const [k, x] of Object.entries(o)) {
            const p = s.properties[k];
            if (!p) {
                if (s.additionalProperties === false) {
                    return `${at}: unknown field \`${k}\` — remove it`;
                }
                continue;
            }
            if (x === undefined) {
                continue;
            }
            const err = validate(p, x, at === 'input' ? k : `${at}.${k}`);
            if (err) {
                return err;
            }
        }
    }
    return undefined;
};
