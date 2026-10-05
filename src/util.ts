export function now(): number {
    return Date.now();
}

export function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : (v > hi ? hi : v);
}

export function toInt(v: any, def = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? (n | 0) : def;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 生成 6 位房间号（去掉 0/O/1/I 这类容易看错的字符） */
export function roomCode(len = 6): string {
    const bytes = require('crypto').randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return s;
}

/**
 * 按 key 串行化的互斥锁。
 *
 * 同一个房间的所有写操作都经过它：pm2 单实例下这就够了，
 * 而且比「读-改-写」的乐观并发简单得多（乐观并发失败时用户看到的是「操作无效」，很难排查）。
 */
const locks = new Map<string, Promise<any>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const next = prev.then(() => gate);
    locks.set(key, next);
    return prev
        .catch(() => undefined)
        .then(fn)
        .finally(() => {
            release();
            if (locks.get(key) === next) locks.delete(key);
        });
}

export function shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
    }
    return a;
}

export function pickOne<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}
