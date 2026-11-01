/// <reference lib="deno.unstable" />
import { argon2id, argon2Verify } from 'npm:hash-wasm@4.12.0';

export const SESSION_MS = 8 * 60 * 60 * 1000;
export const COOKIE = '__Host-gemini_session';
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export async function tokenDigest(value: string): Promise<string> {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
export function hashPassword(password: string) {
    return argon2id({
        password,
        salt: crypto.getRandomValues(new Uint8Array(16)),
        parallelism: 1,
        iterations: 2,
        memorySize: 19456,
        hashLength: 32,
        outputType: 'encoded',
    });
}
type Version = { generation: number; fingerprint: string };
type Session = { expires: number; version: string; generation: number };
export class SessionAuth {
    private now: () => number;
    private version?: Promise<string>;
    constructor(
        private options: {
            kv: () => Promise<Deno.Kv>;
            password?: string;
            passwordHash?: string;
            passwordVersion?: string;
            now?: () => number;
        },
    ) {
        this.now = options.now ?? Date.now;
    }
    private passwordVersion() {
        return this.version ??= this.options.passwordHash ? tokenDigest(this.options.passwordHash) : argon2id({
            password: this.options.password ?? '',
            salt: new TextEncoder().encode('gemini-password-version-v1'),
            parallelism: 1,
            iterations: 2,
            memorySize: 19456,
            hashLength: 32,
            outputType: 'hex',
        });
    }
    async publishVersion() {
        const kv = await this.options.kv();
        const fingerprint = await this.passwordVersion();
        const generation = Number(this.options.passwordVersion ?? '1');
        if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid password version');
        for (let i = 0; i < 20; i++) {
            const old = await kv.get<Version>(['auth', 'version'], { consistency: 'strong' });
            if (old.value && old.value.generation >= generation) {
                if (old.value.generation === generation && old.value.fingerprint === fingerprint) return;
                throw new Error('Stale or conflicting password version');
            }
            if ((await kv.atomic().check(old).set(['auth', 'version'], { generation, fingerprint }).commit()).ok) {
                return;
            }
        }
        throw new Error('Password version unavailable');
    }
    async revoke(token: string) {
        const kv = await this.options.kv();
        await kv.delete(['session', await tokenDigest(token)]);
    }
    async login(password: string, ip: string): Promise<string | null> {
        const kv = await this.options.kv();
        const key = ['login', await tokenDigest(ip || 'unknown'), Math.floor(this.now() / 60000)];
        let admitted = false;
        for (let i = 0; i < 50; i++) {
            const entry = await kv.get<number>(key, { consistency: 'strong' });
            if ((entry.value ?? 0) >= 5) throw new Error('Login throttled');
            const result = await kv.atomic().check(entry).set(key, (entry.value ?? 0) + 1, { expireIn: 120000 })
                .commit();
            if (result.ok) {
                admitted = true;
                break;
            }
        }
        if (!admitted) throw new Error('Login throttled');
        await this.publishVersion();
        if (this.options.passwordHash) {
            if (!/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/.test(this.options.passwordHash)) {
                throw new Error('Invalid password hash');
            }
            if (!await argon2Verify({ password, hash: this.options.passwordHash })) return null;
        } else {
            if (!this.options.password) return null;
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const hash = (p: string) =>
                argon2id({
                    password: p,
                    salt,
                    parallelism: 1,
                    iterations: 2,
                    memorySize: 19456,
                    hashLength: 32,
                    outputType: 'hex',
                });
            const [expected, actual] = await Promise.all([hash(this.options.password), hash(password)]);
            if (expected !== actual) return null;
        }
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        await kv.set(['session', await tokenDigest(token)], {
            expires: this.now() + SESSION_MS,
            version: await this.passwordVersion(),
            generation: Number(this.options.passwordVersion ?? '1'),
        }, { expireIn: SESSION_MS });
        return token;
    }
    async validate(token: string): Promise<boolean> {
        if (!/^[0-9a-f]{64}$/.test(token)) return false;
        try {
            await this.publishVersion();
            const kv = await this.options.kv();
            const { value } = await kv.get<Session>(['session', await tokenDigest(token)], { consistency: 'strong' });
            const version = await kv.get<Version>(['auth', 'version'], { consistency: 'strong' });
            return !!value && value.expires > this.now() && value.version === version.value?.fingerprint &&
                value.generation === version.value?.generation &&
                value.generation === Number(this.options.passwordVersion ?? '1') &&
                value.version === await this.passwordVersion();
        } catch {
            return false;
        }
    }
}
