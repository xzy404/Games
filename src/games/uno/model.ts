/**
 * UNO 的数据层。
 *
 * 房间读写、匹配队列、战绩这些「和玩法无关」的部分全在 `../shared.ts`，
 * 这里只剩三件 UNO 自己的事：
 *   1. 怎么建一桌（发牌）
 *   2. 一局结束后往对局记录 / 战绩里写哪些字段
 *   3. 推进一个房间时要调用的 `botAct` / `timeoutMove`
 */

import type { GamesConfig } from '../../config';
import { COLL, coll } from '../../db';
import * as S from '../shared';
import { botAct } from './bot';
import { SEATS } from './cards';
import { createRoom, timeoutMove } from './engine';
import type { Room } from './types';

export const BOT_NAMES = S.BOT_NAMES;
export const isBotUid = S.isBotUid;
export const heartbeat = S.heartbeat;
export const markAuto = S.markAuto;
export { GameError } from '../shared';

const GID = 'uno';

/** 战绩字段。`getStat` 始终返回同一形状，前端就不用为「没打过」写一堆兜底分支 */
export const STAT_FIELDS = ['games', 'wins', 'score', 'best'] as const;

/** 战绩的零值。房间页不查库，但也得给出同一形状 */
export const zeroStat = (): Record<string, number> => S.zeroStat(STAT_FIELDS);

/**
 * 一局结束后写对局记录 + 战绩。
 * 只在**首次**结算时调用（`room.recorded` 兜住）：不然结束后的每次 tick 都会再写一条。
 */
export async function recordFinish(room: Room): Promise<void> {
    if (!room.result) return;
    const r = room.result;
    const winnerUid = room.seats[room.winner] ? room.seats[room.winner].uid : 0;
    await S.recordMatch(GID, room.domainId, {
        // 主键就用房间号：一房只落一条记录，数据库层面也兜住重复入库
        _id: room._id,
        roomId: room._id,
        createAt: room.finishAt || Date.now(),
        startedAt: room.createdAt,
        duration: Math.max(0, Math.round(((room.finishAt || Date.now()) - room.createdAt) / 1000)),
        winner: room.winner,
        winnerUid,
        gain: r.gain,
        // 座位号一起记下来：赢家靠座位号认，不能靠 uid（一桌可能有好几个机器人，uid 都是 0）
        seats: r.seats.map((s, i) => ({
            idx: i, uid: s.uid, uname: s.uname, cards: s.cards, score: s.score,
        })),
    });
    await S.applyStat(GID, room.domainId, r.seats.map((s, i) => ({
        uid: s.uid,
        uname: s.uname,
        inc: {
            games: 1,
            wins: i === room.winner ? 1 : 0,
            score: s.score,
        },
        max: { best: s.score },
    })));
}

const repo = S.createRoomRepo<Room>({
    gid: GID,
    async persist(room, save) {
        if (room.status === 'finished' && !room.recorded) {
            // 先落库再写记录：中途报错也不会在下次 tick 重复入库
            room.recorded = true;
            await save(room);
            await recordFinish(room);
            return;
        }
        await save(room);
    },
});

export const loadRoom = repo.load;
export const saveRoom = repo.save;
export const persist = repo.persist;
export const withRoom = repo.withRoom;
export const findActiveRoom = repo.findActive;
export const findRecentRoom = repo.findRecent;
export const countActive = repo.countActive;

// ---------------------------------------------------------------------------
// 建桌 / 匹配 / 战绩

function build(domainId: string, seats: S.DealSeat[], cfg: GamesConfig, code: string): Room {
    return createRoom(GID, domainId, seats, cfg, code);
}

const SPEC: S.MatchSpec<Room> = { gid: GID, seats: SEATS, build };

export const queueInfo = (domainId: string, uid: number) => S.queueInfo(GID, domainId, uid);
export const enqueue = (domainId: string, uid: number, uname: string) => S.enqueue(GID, domainId, uid, uname);
export const dequeue = (domainId: string, uid: number) => S.dequeue(GID, domainId, uid);
export const matchQueue = (domainId: string, cfg: GamesConfig) => S.matchQueue(SPEC, domainId, cfg);
export const joinAndStart = (domainId: string, uid: number, uname: string, cfg: GamesConfig) => (
    S.joinAndStart(SPEC, domainId, uid, uname, cfg)
);

export function getStat(domainId: string, uid: number) {
    return S.getStat(GID, domainId, uid, zeroStat);
}

/** 大厅要的计数：进行中的桌数、排队人数、在线人数 */
export function roomStats(domainId: string) {
    return S.roomStats(GID, domainId);
}

export function recentMatches(domainId: string, limit = 20) {
    return S.recentMatches(GID, domainId, limit);
}

export function cleanup(cfg: GamesConfig) {
    return S.cleanupRooms(cfg);
}

/** 和机器人单练：一个人 + 机器人把桌子坐满 */
export async function startPractice(
    domainId: string, uid: number, uname: string, cfg: GamesConfig,
): Promise<{ room: Room | null; error?: string }> {
    const active = await repo.findActive(domainId, uid);
    if (active) return { room: active };
    await dequeue(domainId, uid);
    const seats: S.DealSeat[] = [{ uid, uname }];
    seats.push(...await S.pickBots(SEATS - 1));
    const code = await repo.newCode();
    const room = build(domainId, seats, cfg, code);
    await saveRoom(room);
    return { room };
}

// ---------------------------------------------------------------------------
// 推进

/** UNO 自己的推进钩子 */
const HOOKS: S.AdvanceHooks<Room> = {
    botAct(room, seat, cfg) { botAct(room, seat, cfg); },
    timeoutMove(room, cfg) { timeoutMove(room, cfg); },
};

/** 推进一个房间（单房间场景与测试用） */
export function advanceRoom(room: Room, cfg: GamesConfig): boolean {
    return S.advanceRoom(room, cfg, HOOKS);
}

/** 推进所有活跃房间，并顺手再试一次匹配 */
export async function roomTickAll(cfg: GamesConfig): Promise<number> {
    const n = await S.tickRooms<Room>(repo, cfg, HOOKS);
    const domains = await coll(COLL.queue).distinct('domainId', { gid: GID });
    for (const d of domains as string[]) {
        // eslint-disable-next-line no-await-in-loop
        await matchQueue(d, cfg);
    }
    return n;
}
