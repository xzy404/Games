import type { Combo } from './combo';

export type RoomStatus = 'bidding' | 'playing' | 'finished';

export interface Seat {
    idx: number;
    uid: number;
    /** 玩家昵称，0 表示机器人 */
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

export interface PlayRecord {
    seat: number;
    cards: number[];
    pass: boolean;
    type?: string;
    /** 第几轮（两家不出后会 +1，新一轮重新起手） */
    roundId: number;
    at: number;
}

export interface RoomResult {
    landlordWin: boolean;
    winner: number;
    landlord: number;
    baseBet: number;
    multiplier: number;
    /** 'spring' 春天 | 'anti' 反春 | '' */
    bonus: string;
    seats: { uid: number; uname: string; role: string; score: number }[];
}

export interface Room {
    /** 6 位房间号 */
    _id: string;
    gid: string;
    domainId: string;
    rev: number;
    status: RoomStatus;
    seats: Seat[];
    hands: number[][];
    /**
     * 刚发完牌、地主还没拿底牌时三家的手牌（各 17 张）。
     * 回放要靠它重建每一步的牌面 —— 出牌会把 `hands` 里的牌拿掉，
     * 光靠 `hands` 是回不到开头的。进行中对局绝不外发。
     */
    dealHands: number[][];
    bottom: number[];
    landlord: number;
    baseBet: number;
    multiplier: number;
    bidOrder: number[];
    bidIdx: number;
    bidScores: number[];
    turn: number;
    last: { seat: number; combo: Combo } | null;
    passCount: number;
    roundId: number;
    plays: PlayRecord[];
    winner: number;
    result?: RoomResult;
    deadline: number;
    botDue: number;
    createdAt: number;
    updatedAt: number;
    finishAt: number;
    dealCount: number;
    /** 已写入对局记录（防止重复入库） */
    recorded?: boolean;
}
