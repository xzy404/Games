/**
 * 数据层。
 *
 * 一律通过 `ctx.db`（注入进来的 MongoService）拿集合，不用 `hydrooj` 里那个
 * `@deprecated` 的 db 代理 —— 后者依赖 `app.get('db')` 的时序，插件启动早期的
 * 调用会拿到 undefined。
 */

export const COLL = {
    /** 游戏房间（含进行中的牌局） */
    room: 'games_room',
    /** 匹配队列 */
    queue: 'games_queue',
    /** 已结束的对局（最近对局列表） */
    match: 'games_match',
    /** 每个用户在每个游戏里的战绩 */
    stat: 'games_stat',
} as const;

let mongo: any = null;

export function initDb(ctx: any): void {
    mongo = ctx.db;
}

export function getDb(): any {
    if (!mongo) throw new Error('hydro-games: database not ready');
    return mongo;
}

export function coll<T = any>(name: string): any {
    return getDb().collection(name) as T;
}

export async function ensureIndexes(): Promise<void> {
    const db = getDb();
    // ensureIndexes 内部已经处理了「非 0 号实例直接返回」，这里不用再判断
    await db.ensureIndexes(coll(COLL.room),
        { key: { gid: 1, domainId: 1, status: 1, updatedAt: -1 }, name: 'lobby' },
        // 给 cleanupRooms 的 `updatedAt < 阈值` 兜底。
        //
        // 这里**刻意不用 MongoDB 的 TTL**（即不写 expireAfterSeconds）。原因：所有时间字段
        // 存的是 `Date.now()`，是 number 而不是 BSON Date，而 Mongo 的 TTL 线程只认 Date，
        // 遇到数字会**静默跳过**——索引建了、名字还叫 ttl，却一条都不会删。过期清理实际由
        // `shared.ts` 的 `cleanupRooms()` 每分钟扫一次完成，索引只为这个查询服务。
        //
        // 同理，名字也不能叫 'ttl'：那会让人以为过期是 Mongo 负责的，排查时容易找错方向。
        { key: { updatedAt: 1 }, name: 'expire' },
    );
    await db.ensureIndexes(coll(COLL.queue),
        { key: { gid: 1, domainId: 1, joinedAt: 1 }, name: 'fifo' },
    );
    await db.ensureIndexes(coll(COLL.match),
        { key: { gid: 1, domainId: 1, createAt: -1 }, name: 'recent' },
    );
    await db.ensureIndexes(coll(COLL.stat),
        { key: { gid: 1, domainId: 1, uid: 1 }, name: 'basic', unique: true },
        { key: { gid: 1, domainId: 1, score: -1 }, name: 'score' },
    );
}
