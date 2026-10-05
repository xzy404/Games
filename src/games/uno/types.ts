import type { SeatBase } from '../shared';
import type { Kind } from './cards';

/** 只有两个状态：打完了就是 finished。没有叫分那种中间态 */
export type RoomStatus = 'playing' | 'finished';

/** 座位。字段与 `SeatBase` 一致，共享层才能直接拿它算托管与心跳 */
export type Seat = SeatBase;

/** 牌面当前的要求。万能牌出过之后 `color` 是**被指定的**颜色 */
export interface TopCard {
    card: number;
    /** 0..3；万能牌被指定后的颜色 */
    color: number;
    kind: Kind;
    /** 数字牌的点数，其余为 -1 */
    num: number;
}

/**
 * 流水里的一条。
 *
 * 一局里所有会改变手牌的事都落一条，回放只要按顺序重放 events 就能回到任意一步 ——
 * 不需要为「摸了几张」「谁被罚牌」再写一套推导逻辑。
 */
export interface UnoEvent {
    seat: number;
    type: 'play' | 'draw' | 'pass';
    /** 打出的牌 */
    card?: number;
    /** 摸到的牌（+2 / +4 的罚牌会有多张） */
    cards?: number[];
    /** 出万能牌时指定的颜色 */
    color?: number;
    /** 是罚牌（被 +2 / +4 打的），展示时说得更明白一点 */
    penalty?: boolean;
    at: number;
}

export interface UnoResultSeat {
    uid: number;
    uname: string;
    /** 结束时手里还剩几张 */
    cards: number;
    /** 结算得分：赢家是别人手牌的罚分之和，其余人是自己剩余手牌的负罚分 */
    score: number;
}

export interface UnoResult {
    winner: number;
    seats: UnoResultSeat[];
    /** 赢家这一局拿到的总分 */
    gain: number;
}

export interface Room {
    /** 6 位房间号 */
    _id: string;
    gid: string;
    domainId: string;
    rev: number;
    status: RoomStatus;
    seats: Seat[];

    /** 每人的手牌（牌 id） */
    hands: number[][];
    /**
     * 发牌时的 7 张。回放要从这里出发 —— `hands` 后面会被摸牌/出牌不断改写，
     * 光靠它回不到开局。进行中的对局绝不外发。
     */
    dealHands: number[][];
    /** 摸牌堆（末尾是下一张要摸的） */
    deck: number[];
    /** 弃牌堆（末尾是牌面顶张） */
    discard: number[];
    /** 开局翻开的那一张 */
    first: number;
    top: TopCard;

    /** 出牌方向：1 顺时针，-1 逆时针 */
    dir: 1 | -1;
    /** 本回合是否已经摸过牌（摸过之后才允许「过」） */
    drewThisTurn: boolean;
    /** 本回合摸到且能直接打出的那张；-1 表示没有 */
    drawnCard: number;

    turn: number;
    winner: number;
    events: UnoEvent[];
    result?: UnoResult;

    deadline: number;
    botDue: number;
    createdAt: number;
    updatedAt: number;
    finishAt: number;
    dealCount: number;
    /** 已写入对局记录（防止重复入库） */
    recorded?: boolean;
}
