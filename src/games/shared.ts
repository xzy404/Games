/**
 * 各个游戏共用的数据层。
 *
 * 这里**只放和具体玩法无关**的东西：房间的读写与加锁、匹配队列、对局记录、战绩、
 * 以及「到点了该谁动」的推进骨架。
 *
 * 一条硬规矩：**共享层不做任何规则判断**。牌怎么发、什么叫合法、机器人怎么出，
 * 全在各游戏自己的 engine/bot 里 —— 共享层只负责「把状态安全地存下来」。
 *
 * 斗地主和 UNO 都建立在这上面，所以加第三个游戏时这一层不用再抄一遍。
 */

import type { GamesConfig } from '../config';
import { COLL, coll } from '../db';
import { roomCode, shuffle, withLock } from '../util';

/** 玩家操作导致的、可以直接展示给用户的错误（handler 会把它转成 {ok:false,error}） */
export class GameError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GameError';
    }
}

/** 结束态。各游戏自己的中间态（bidding / playing / …）由各游戏定义 */
export const FINISHED = 'finished';

// ---------------------------------------------------------------------------
// 形状约定

export interface SeatBase {
    idx: number;
    uid: number;
    uname: string;
    bot: boolean;
    /** 由机器人代打（可能是掉线自动托管的，也可能是玩家自己点的） */
    auto: boolean;
    /**
     * 玩家**主动**点的托管。
     * 区别在于：掉线托管一旦收到心跳就该收回操作权，而主动托管要一直保持到玩家自己取消 ——
     * 否则每一次轮询/操作都会把它解除，表现就是「走一步托管就掉了」。
     */
    manualAuto?: boolean;
    /** 本局得分 */
    score: number;
    lastSeen: number;
}

export interface RoomBase {
    /** 房间号 */
    _id: string;
    gid: string;
    domainId: string;
    /** 每次状态变化 +1，前端靠它判断要不要重绘 */
    rev: number;
    status: string;
    seats: SeatBase[];
    /** 该谁动了 */
    turn: number;
    /** 赢家座位号，-1 = 还没结果 */
    winner: number;
    /** 当前这一步的截止时间（ms），0 = 不计时 */
    deadline: number;
    /** 机器人「思考」到什么时候才动手（ms），0 = 未排期 */
    botDue: number;
    createdAt: number;
    updatedAt: number;
    finishAt: number;
    /** 已写入对局记录（防止一局结束后的每次 tick 都再写一条） */
    recorded?: boolean;
}

/** 建桌时给每个座位的描述 */
export interface DealSeat {
    uid: number;
    uname: string;
    bot?: boolean;
}

export function isBotUid(uid: number): boolean {
    return !uid || uid <= 0;
}

/** 这个座位现在是不是由机器人（或托管中的玩家）在动 */
export function isAutoSeat(room: RoomBase, seat: number): boolean {
    const s = room.seats[seat];
    return !!s && (s.bot || s.auto);
}

export function seatOfUid(room: RoomBase, uid: number): number {
    return room.seats.findIndex((s) => s.uid === uid && !s.bot);
}

// ---------------------------------------------------------------------------
// 房间读写

async function rawSave(room: RoomBase): Promise<void> {
    room.updatedAt = Date.now();
    await coll(COLL.room).replaceOne({ _id: room._id }, room, { upsert: true });
}

async function rawLoad<R>(code: string): Promise<R | null> {
    if (!code) return null;
    return coll(COLL.room).findOne({ _id: code }) as Promise<R | null>;
}

async function newRoomCode(): Promise<string> {
    for (let i = 0; i < 20; i++) {
        const code = roomCode(6);
        // eslint-disable-next-line no-await-in-loop
        const exists = await coll(COLL.room).findOne({ _id: code }, { projection: { _id: 1 } });
        if (!exists) return code;
    }
    return `${roomCode(6)}${Date.now() % 100}`;
}

/**
 * 绑定到一个游戏的房间仓库。
 *
 * 存在的意义是 `withRoom` 里那句「读完 → 改 → 落库」需要一个**该游戏的**落库方式：
 * 斗地主首次结算要写对局记录 + 地主战绩，UNO 写的是另一套字段。
 * 把落库回调在创建时就绑好，调用点就能保持 `withRoom(id, fn)` 这一种写法。
 */
export function createRoomRepo<R extends RoomBase>(opts: {
    gid: string;
    /** 自定义落库：默认只是 replaceOne，游戏可以在这里加「首次结算写记录」 */
    persist?: (room: R, save: (r: R) => Promise<void>) => Promise<void>;
}) {
    const save = (room: R) => rawSave(room);
    const persist = opts.persist
        ? (room: R) => opts.persist!(room, save)
        : (room: R) => save(room);

    return {
        gid: opts.gid,
        save,
        persist,

        load(code: string): Promise<R | null> {
            return rawLoad<R>(code);
        },

        /** 读-改-写全在一个锁里，避免并发请求把同一房间的状态覆盖掉 */
        withRoom<T>(code: string, fn: (room: R) => T | Promise<T>): Promise<T> {
            return withLock(`room:${code}`, async () => {
                const room = await rawLoad<R>(code);
                if (!room) throw new GameError('房间不存在或已过期');
                const res = await fn(room);
                await persist(room);
                return res;
            });
        },

        findActive(domainId: string, uid: number): Promise<R | null> {
            if (isBotUid(uid)) return Promise.resolve(null);
            return coll(COLL.room).findOne({
                gid: opts.gid,
                domainId,
                status: { $nin: [FINISHED] },
                'seats.uid': uid,
            }) as Promise<R | null>;
        },

        findRecent(domainId: string, uid: number, withinMs = 10 * 60 * 1000): Promise<R | null> {
            if (isBotUid(uid)) return Promise.resolve(null);
            return coll(COLL.room).findOne({
                gid: opts.gid,
                domainId,
                status: FINISHED,
                'seats.uid': uid,
                finishAt: { $gt: Date.now() - withinMs },
            }, { sort: { finishAt: -1 } }) as Promise<R | null>;
        },

        countActive(domainId: string): Promise<number> {
            return coll(COLL.room).countDocuments({
                gid: opts.gid, domainId, status: { $nin: [FINISHED] },
            });
        },

        newCode: newRoomCode,
    };
}

export type RoomRepo<R extends RoomBase> = ReturnType<typeof createRoomRepo<R>>;

// ---------------------------------------------------------------------------
// 匹配队列

export const BOT_NAMES = [
    '机器人·小美', '机器人·阿灿', '机器人·老陈',
    '机器人·团团', '机器人·小柯', '机器人·阿福',
];

export interface QueueEntry {
    _id: string;
    gid: string;
    domainId: string;
    uid: number;
    uname: string;
    joinedAt: number;
}

export function queueId(gid: string, domainId: string, uid: number): string {
    return `${gid}#${domainId}#${uid}`;
}

export async function enqueue(gid: string, domainId: string, uid: number, uname: string): Promise<void> {
    const _id = queueId(gid, domainId, uid);
    await coll(COLL.queue).updateOne(
        { _id },
        { $set: { gid, domainId, uid, uname, joinedAt: Date.now() } },
        { upsert: true },
    );
}

export async function dequeue(gid: string, domainId: string, uid: number): Promise<void> {
    await coll(COLL.queue).deleteOne({ _id: queueId(gid, domainId, uid) });
}

export async function queueInfo(gid: string, domainId: string, uid: number): Promise<{
    size: number;
    waiters: { uid: number; uname: string; waited: number }[];
    mine: QueueEntry | null;
}> {
    const list = await coll(COLL.queue).find({ gid, domainId })
        .sort({ joinedAt: 1 }).limit(20).toArray() as QueueEntry[];
    const ts = Date.now();
    return {
        size: list.length,
        waiters: list.map((q) => ({ uid: q.uid, uname: q.uname, waited: Math.round((ts - q.joinedAt) / 1000) })),
        mine: list.find((q) => q.uid === uid) || null,
    };
}

export async function pickBots(count: number, exclude: string[] = [], names = BOT_NAMES) {
    const pool = names.filter((n) => !exclude.includes(n));
    const use = pool.length >= count ? pool : names;
    const picked: string[] = [];
    while (picked.length < count) {
        const n = use[Math.floor(Math.random() * use.length)];
        if (!picked.includes(n)) picked.push(n);
    }
    return picked.map((n) => ({ uid: 0, uname: n, bot: true as const }));
}

export interface MatchSpec<R extends RoomBase> {
    gid: string;
    /** 一桌几个座位 */
    seats: number;
    /** 用给定座位建一个房间（各游戏自己决定怎么发牌） */
    build(domainId: string, seats: DealSeat[], cfg: GamesConfig, code: string): R;
    /** 机器人名字池（不写就用默认那批） */
    botNames?: string[];
}

/**
 * 把队列凑成一桌。
 *
 * 优先真人；等待超过 `botFillSeconds` 就**把桌子补满**机器人 ——
 * 补不满的桌子开不了局，与其让玩家干等，不如先打上。
 *
 * `botFillSeconds <= 0` 是「永不补机器人」：管理员靠它把「只能和真人打」打开。
 * 注意这里必须写成 `> 0 &&`，光比较 `waited >= cfg.botFillSeconds` 的话 0 会
 * 变成「第一秒就补」—— 和文档正好相反，而且看代码很容易看漏。
 */
export async function matchQueue<R extends RoomBase>(
    spec: MatchSpec<R>, domainId: string, cfg: GamesConfig,
): Promise<R[]> {
    if (!cfg.enabled) return [];
    const list = await coll(COLL.queue).find({ gid: spec.gid, domainId })
        .sort({ joinedAt: 1 }).toArray() as QueueEntry[];
    if (!list.length) return [];
    const waited = (Date.now() - list[0].joinedAt) / 1000;
    const fillable = cfg.botFillSeconds > 0;
    const humans = list.length >= spec.seats
        ? list.slice(0, spec.seats)
        : (fillable && waited >= cfg.botFillSeconds ? list : []);
    if (!humans.length) return [];

    const seats: DealSeat[] = humans.map((h) => ({ uid: h.uid, uname: h.uname }));
    const needBots = spec.seats - seats.length;
    if (needBots > 0) seats.push(...await pickBots(needBots, [], spec.botNames));
    if (seats.length < spec.seats) return [];

    const code = await newRoomCode();
    const room = spec.build(domainId, shuffle(seats), cfg, code);
    await rawSave(room);
    await coll(COLL.queue).deleteMany({ _id: { $in: humans.map((h) => h._id) } });
    return [room];
}

export async function joinAndStart<R extends RoomBase>(
    spec: MatchSpec<R>, domainId: string, uid: number, uname: string, cfg: GamesConfig,
): Promise<R | null> {
    const repo = createRoomRepo<R>({ gid: spec.gid });
    const active = await repo.findActive(domainId, uid);
    if (active) return active;
    await enqueue(spec.gid, domainId, uid, uname);
    const created = await matchQueue(spec, domainId, cfg);
    return created.length ? created[0] : null;
}

// ---------------------------------------------------------------------------
// 对局记录与战绩

export async function recordMatch(gid: string, domainId: string, doc: Record<string, any>): Promise<void> {
    await coll(COLL.match).insertOne({ ...doc, gid, domainId });
}

export interface StatDelta {
    uid: number;
    uname: string;
    inc: Record<string, number>;
    /** $max 更新的字段（比如最高得分） */
    max?: Record<string, number>;
}

export async function applyStat(
    gid: string, domainId: string, deltas: StatDelta[],
): Promise<void> {
    const ops = deltas
        .filter((d) => !isBotUid(d.uid))
        .map((d) => {
            const upd: Record<string, any> = {
                $inc: d.inc,
                $set: { uname: d.uname, updatedAt: Date.now() },
            };
            if (d.max && Object.keys(d.max).length) upd.$max = d.max;
            return coll(COLL.stat).updateOne({ gid, domainId, uid: d.uid }, upd, { upsert: true });
        });
    await Promise.all(ops);
}

/** 战绩的零值。始终返回同一形状，前端就不用为「没打过」写一堆兜底分支 */
export function zeroStat(fields: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of fields) out[f] = 0;
    return out;
}

export async function getStat(
    gid: string, domainId: string, uid: number, zero: () => Record<string, number>,
): Promise<Record<string, number>> {
    // 游客和机器人都没有战绩行，但形状要一致 —— 页面和接口拿到的 lobby 结构必须相同
    if (isBotUid(uid)) return zero();
    const doc = await coll(COLL.stat).findOne({ gid, domainId, uid });
    return doc || zero();
}

export async function recentMatches(gid: string, domainId: string, limit = 20): Promise<any[]> {
    return coll(COLL.match).find({ gid, domainId }).sort({ createAt: -1 }).limit(limit).toArray();
}

/** 大厅/列表页要的计数：进行中的桌数、排队人数、在线人数 */
export async function roomStats(gid: string, domainId: string): Promise<{
    rooms: number; queue: number; online: number;
}> {
    const ts = Date.now();
    const [rooms, q] = await Promise.all([
        coll(COLL.room).find({ gid, domainId, status: { $nin: [FINISHED] } })
            .project({ seats: 1 }).limit(200).toArray() as Promise<Pick<RoomBase, 'seats'>[]>,
        coll(COLL.queue).countDocuments({ gid, domainId }),
    ]);
    let online = 0;
    for (const r of rooms) {
        for (const s of r.seats || []) {
            if (!s.bot && s.lastSeen && ts - s.lastSeen < 60000) online++;
        }
    }
    return { rooms: rooms.length, queue: q, online: online + q };
}

// ---------------------------------------------------------------------------
// 推进

/**
 * 心跳：刷新 lastSeen，并解除**掉线**托管。
 *
 * 玩家自己点的托管（manualAuto）不能动：心跳每来一次都解除的话，
 * 托管等于一步都撑不过去（表现就是「每走一步托管就掉了」）。
 *
 * 解除托管要顺带抬 `rev` —— 托管与否直接决定客户端画的是「牌全暗 + 出牌区收起」
 * 还是「能打的牌亮着」，这是一次实打实的画面变化。别的客户端（另一个标签页、
 * 只靠轮询的那一个）是**按 rev 变化才重画**的，不抬 rev 它们会一直停在旧画面上，
 * 看起来就是「托管了但牌还亮着」。
 */
export function heartbeat(room: RoomBase, uid: number): boolean {
    const seat = seatOfUid(room, uid);
    if (seat < 0) return false;
    let changed = false;
    const s = room.seats[seat];
    if (s.auto && !s.manualAuto) { s.auto = false; changed = true; }
    s.lastSeen = Date.now();
    if (changed) room.rev++;
    return changed;
}

/** 太久没动静的座位交给机器人 */
export function markAuto(room: RoomBase, cfg: GamesConfig): boolean {
    if (room.status === FINISHED) return false;
    const limit = Date.now() - cfg.autoPlayAfterSeconds * 1000;
    let changed = false;
    for (const s of room.seats) {
        if (s.bot || s.auto) continue;
        if (s.lastSeen && s.lastSeen < limit) { s.auto = true; changed = true; }
    }
    return changed;
}

/** 重新开始一步的计时：刷新截止时间，并清掉上一步的机器人排期 */
export function armDeadline(room: RoomBase, seconds: number): void {
    room.deadline = Date.now() + seconds * 1000;
    room.botDue = 0;
}

/** 当前回合该谁动：刷新机器人思考时间。每步只排一次（botDue 为 0 时排期） */
export function syncBotDue(room: RoomBase, cfg: GamesConfig, now = Date.now()): void {
    if (room.status === FINISHED) {
        room.botDue = 0;
        return;
    }
    if (!isAutoSeat(room, room.turn)) {
        room.botDue = 0;
        return;
    }
    if (!room.botDue) {
        const delay = Math.max(0, cfg.botDelayMs);
        const jitter = delay > 0 ? Math.floor(Math.random() * Math.max(1, Math.floor(delay / 2))) : 0;
        room.botDue = now + delay + jitter;
    }
}

export interface AdvanceHooks<R extends RoomBase> {
    /** 机器人走一步。**必须自己复核合法性** —— 这里不保证玩家的手牌还有什么 */
    botAct(room: R, seat: number, cfg: GamesConfig): void;
    /** 到点了还没动作的人怎么办 */
    timeoutMove(room: R, cfg: GamesConfig): void;
}

/** 推进一个房间：托管判定 → 机器人到点 → 超时 */
export function advanceRoom<R extends RoomBase>(
    room: R, cfg: GamesConfig, hooks: AdvanceHooks<R>,
): boolean {
    if (room.status === FINISHED) return false;
    let changed = markAuto(room, cfg);
    const cur = room.turn;
    if (isAutoSeat(room, cur)) {
        syncBotDue(room, cfg);
        if (Date.now() >= room.botDue) {
            hooks.botAct(room, cur, cfg);
            changed = true;
            // 一次 tick 只走一步：连续走多步会让整局瞬间结束，玩家看不到过程
        }
    } else if (room.deadline && Date.now() > room.deadline) {
        hooks.timeoutMove(room, cfg);
        changed = true;
    }
    if (changed) room.updatedAt = Date.now();
    return changed;
}

/**
 * 按房间推进一个游戏的所有活跃房间。
 *
 * 这里刻意用「房间 id 一把锁」而不是直接拿列表里的对象：
 * 列表是别的请求刚写进去的一份快照，拿它改完再存会把并发写覆盖掉。
 *
 * 落库走的是 `repo.persist` 而不是裸 save —— 一局就是在这一步结束的，
 * 结算记录（对局记录、战绩）挂在 persist 上，绕过它就会出现「牌桌显示已结束、
 * 大厅却查不到这一局」这种半截状态。
 */
export async function tickRooms<R extends RoomBase>(
    repo: RoomRepo<R>, cfg: GamesConfig, hooks: AdvanceHooks<R>,
): Promise<number> {
    const rooms = await coll(COLL.room).find({
        gid: repo.gid,
        status: { $nin: [FINISHED] },
        updatedAt: { $gt: Date.now() - 30 * 60 * 1000 },
    }).limit(200).toArray() as R[];
    let n = 0;
    for (const r of rooms) {
        // eslint-disable-next-line no-await-in-loop
        await withLock(`room:${r._id}`, async () => {
            const room = await rawLoad<R>(r._id);
            if (!room || room.status === FINISHED) return;
            if (advanceRoom(room, cfg, hooks)) {
                await repo.persist(room);
                n++;
            }
        });
    }
    return n;
}

/** 过期房间/队列清理 */
export async function cleanupRooms(cfg: GamesConfig): Promise<void> {
    const ttl = Date.now() - cfg.roomTtlMinutes * 60 * 1000;
    await coll(COLL.room).deleteMany({ updatedAt: { $lt: ttl } });
    await coll(COLL.queue).deleteMany({ joinedAt: { $lt: Date.now() - 30 * 60 * 1000 } });
}
