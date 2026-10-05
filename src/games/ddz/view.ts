import { COMBO_NAME } from './combo';
import { roleOf, seatOfUid } from './engine';
import { isBotUid } from './model';
import type { PlayRecord, Room } from './types';

export interface PublicSeat {
    idx: number;
    uid: number;
    uname: string;
    bot: boolean;
    auto: boolean;
    cards: number;
    score: number;
    role: string;
    landlord: boolean;
    /** 是当前该动的座位 */
    active: boolean;
}

function lastRoundCards(room: Room): (PlayRecord | null)[] {
    const out: (PlayRecord | null)[] = [null, null, null];
    for (const p of room.plays) {
        if (p.roundId !== room.roundId) continue;
        if (p.pass) out[p.seat] = p;
        else out[p.seat] = p;
    }
    return out;
}

export function lastPlayCards(room: Room): number[] {
    if (!room.last) return [];
    for (let i = room.plays.length - 1; i >= 0; i--) {
        const p = room.plays[i];
        if (!p.pass && p.seat === room.last.seat) return p.cards;
    }
    return [];
}

/**
 * 给客户端的状态。
 *
 * 关键：**别人的手牌永远不出门**，只给张数。底牌在叫分阶段也不发。
 */
export function roomView(room: Room, uid: number) {
    const seat = seatOfUid(room, uid);
    const isPlayer = seat >= 0;
    const over = room.status === 'finished';
    const table = lastRoundCards(room);
    return {
        id: room._id,
        status: room.status,
        rev: room.rev,
        seat,
        isPlayer,
        seats: room.seats.map((s, i): PublicSeat => ({
            idx: i,
            uid: isBotUid(s.uid) ? 0 : s.uid,
            uname: s.uname,
            bot: s.bot,
            auto: s.auto,
            cards: room.hands[i] ? room.hands[i].length : 0,
            score: s.score,
            role: roleOf(room, i),
            landlord: i === room.landlord,
            active: !over && room.turn === i,
        })),
        hand: isPlayer ? (room.hands[seat] || []) : [],
        bottom: room.status === 'bidding' ? null : room.bottom,
        bottomCount: room.bottom.length,
        landlord: room.landlord,
        baseBet: room.baseBet,
        multiplier: room.multiplier,
        bidScores: room.bidScores,
        bidding: room.status === 'bidding',
        bidSeat: room.status === 'bidding' ? room.turn : -1,
        bidBest: room.bidScores.reduce((a, b) => Math.max(a, b), 0),
        turn: over ? -1 : room.turn,
        last: room.last ? { seat: room.last.seat, cards: lastPlayCards(room), type: room.last.combo.type } : null,
        table: table.map((p) => (p ? { seat: p.seat, pass: p.pass, cards: p.cards, type: p.type || '' } : null)),
        plays: room.plays.slice(-14).map((p) => ({
            seat: p.seat, pass: p.pass, cards: p.cards, type: p.type || '',
        })),
        roundId: room.roundId,
        winner: room.winner,
        result: room.result || null,
        deadline: room.deadline,
        serverNow: Date.now(),
        /** 已结束才有：完整回放（含三家的初始手牌，所以进行中一律为 null） */
        replay: over ? replayView(room) : null,
        myTurn: isPlayer && !over && room.turn === seat,
        /** 轮到我且必须出牌（本轮首发，不能过） */
        mustPlay: isPlayer && !over && room.turn === seat && (!room.last || room.last.seat === seat),
        comboNames: COMBO_NAME,
    };
}

/**
 * 已结束对局的完整回放数据：初始手牌 + 每一手，客户端据此重建任意一步的牌面。
 *
 * **只有 `finished` 的对局才发** —— 进行中的房间绝对不能带 `dealHands`，
 * 那等于把三家的底牌全公开了。
 */
export function replayView(room: Room) {
    if (room.status !== 'finished') return null;
    return {
        landlord: room.landlord,
        bottom: room.bottom.slice(),
        dealHands: (room.dealHands || []).map((h) => h.slice()),
        bidScores: room.bidScores.slice(),
        plays: room.plays.map((p) => ({
            seat: p.seat, pass: p.pass, cards: p.cards.slice(), type: p.type || '', roundId: p.roundId,
        })),
        seats: room.seats.map((s, i) => ({
            idx: i,
            uid: isBotUid(s.uid) ? 0 : s.uid,
            uname: s.uname,
            bot: s.bot,
            landlord: i === room.landlord,
        })),
    };
}

/** 最近对局记录的展示形态 */
export function matchView(match: any, uid: number) {
    const seats = (match.seats || []).map((s: any) => ({
        uid: s.uid,
        uname: s.uname || '机器人',
        role: s.role,
        score: s.score,
        me: !!uid && s.uid === uid,
        landlord: s.role === 'landlord',
    }));
    const me = seats.find((s: any) => s.me);
    return {
        roomId: match.roomId,
        createAt: match.createAt,
        duration: match.duration,
        baseBet: match.baseBet,
        multiplier: match.multiplier,
        bonus: match.bonus || '',
        landlordWin: match.landlordWin,
        seats,
        myScore: me ? me.score : null,
    };
}
