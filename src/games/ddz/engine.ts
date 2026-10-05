/**
 * 斗地主状态机。
 *
 * 全部是对「普通对象」的纯变换（+ 时间戳），不碰数据库 —— 这样离线测试可以
 * 直接打几百局随机对局，而不用起 Mongo。
 */

import type { GamesConfig } from '../../config';
import { GameError, isAutoSeat, syncBotDue } from '../shared';
import { SEATS, deal, sortCards, valueOf } from './cards';
import { analyze, beats, isBombLike, type Combo } from './combo';
import type { PlayRecord, Room } from './types';

export { GameError };
export { syncBotDue };

export function roleOf(room: Room, seat: number): string {
    if (room.landlord < 0) return '';
    return seat === room.landlord ? 'landlord' : 'farmer';
}

/** 这个座位现在是不是由机器人（或托管中的玩家）在动 */
export const isBotSeat = isAutoSeat;

function maxBid(room: Room): number {
    return room.bidScores.reduce((a, b) => Math.max(a, b), 0);
}

function highestBidder(room: Room): number {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < SEATS; i++) {
        if (room.bidScores[i] > bestScore) {
            bestScore = room.bidScores[i];
            best = i;
        }
    }
    return best;
}

/** 一步开始：刷新截止时间并清掉上一步的机器人排期 */
function armTurn(room: Room, cfg: GamesConfig, isBid: boolean): void {
    room.deadline = Date.now() + (isBid ? cfg.bidTimeoutSeconds : cfg.turnTimeoutSeconds) * 1000;
    room.botDue = 0;
}

export function startDeal(room: Room, cfg: GamesConfig): void {
    const { hands, bottom } = deal();
    room.hands = hands;
    // 留一份「发牌时」的手牌给回放用：后面出牌会不断从 hands 里拿牌，
    // 而地主拿底牌发生在叫分之后，回放需要能回到这三家各 17 张的起点。
    room.dealHands = hands.map((h) => h.slice());
    room.bottom = bottom;
    room.landlord = -1;
    room.baseBet = 0;
    room.multiplier = 1;
    room.bidScores = [0, 0, 0];
    room.bidIdx = 0;
    const start = Math.floor(Math.random() * SEATS);
    room.bidOrder = [start, (start + 1) % SEATS, (start + 2) % SEATS];
    room.turn = room.bidOrder[0];
    room.last = null;
    room.passCount = 0;
    room.roundId = 1;
    room.plays = [];
    room.winner = -1;
    delete room.result;
    room.status = 'bidding';
    room.dealCount = (room.dealCount || 0) + 1;
    for (const s of room.seats) s.score = 0;
    armTurn(room, cfg, true);
    syncBotDue(room, cfg);
}

export function createRoom(gid: string, domainId: string, seats: {
    uid: number; uname: string; bot?: boolean;
}[], cfg: GamesConfig, code: string): Room {
    const ts = Date.now();
    const room: Room = {
        _id: code,
        gid,
        domainId,
        rev: 1,
        status: 'bidding',
        seats: seats.map((s, idx) => ({
            idx,
            uid: s.uid,
            uname: s.uname,
            bot: !!s.bot,
            auto: false,
            manualAuto: false,
            score: 0,
            lastSeen: ts,
        })),
        hands: [],
        dealHands: [],
        bottom: [],
        landlord: -1,
        baseBet: 0,
        multiplier: 1,
        bidOrder: [],
        bidIdx: 0,
        bidScores: [0, 0, 0],
        turn: 0,
        last: null,
        passCount: 0,
        roundId: 1,
        plays: [],
        winner: -1,
        deadline: 0,
        botDue: 0,
        createdAt: ts,
        updatedAt: ts,
        finishAt: 0,
        dealCount: 0,
    };
    startDeal(room, cfg);
    return room;
}

export function seatOfUid(room: Room, uid: number): number {
    return room.seats.findIndex((s) => s.uid === uid && !s.bot);
}

function becomeLandlord(room: Room, seat: number, score: number, cfg: GamesConfig): void {
    room.landlord = seat;
    room.baseBet = score;
    room.hands[seat] = sortCards([...room.hands[seat], ...room.bottom]);
    room.status = 'playing';
    room.turn = seat;
    room.last = null;
    room.passCount = 0;
    room.roundId = 1;
    armTurn(room, cfg, false);
    syncBotDue(room, cfg);
}

export function bid(room: Room, seat: number, score: number, cfg: GamesConfig): void {
    if (room.status !== 'bidding') throw new GameError('现在不是叫分阶段');
    if (room.turn !== seat) throw new GameError('还没轮到你叫分');
    if (!Number.isInteger(score) || score < 0 || score > 3) throw new GameError('叫分只能是 0/1/2/3');
    const best = maxBid(room);
    if (score !== 0 && score <= best) throw new GameError(`叫分必须高于 ${best} 分，或者选择不叫`);

    room.bidScores[seat] = score;
    room.updatedAt = Date.now();
    if (score === 3) {
        becomeLandlord(room, seat, 3, cfg);
        room.rev++;
        return;
    }
    room.bidIdx++;
    if (room.bidIdx >= SEATS) {
        const winner = highestBidder(room);
        if (winner < 0) {
            // 三家都不叫，重新发牌（座位不变）
            startDeal(room, cfg);
        } else {
            becomeLandlord(room, winner, room.bidScores[winner], cfg);
        }
    } else {
        room.turn = room.bidOrder[room.bidIdx];
        armTurn(room, cfg, true);
        syncBotDue(room, cfg);
    }
    room.rev++;
}

function advanceTurn(room: Room, cfg: GamesConfig): void {
    room.turn = (room.turn + 1) % SEATS;
    armTurn(room, cfg, false);
    syncBotDue(room, cfg);
}

function pushPlay(room: Room, rec: PlayRecord): void {
    room.plays.push(rec);
    if (room.plays.length > 400) room.plays.splice(0, room.plays.length - 400);
}

export function play(room: Room, seat: number, cards: number[], cfg: GamesConfig): Combo {
    if (room.status !== 'playing') throw new GameError('现在不能出牌');
    if (room.turn !== seat) throw new GameError('还没轮到你出牌');
    if (!Array.isArray(cards) || !cards.length) throw new GameError('请选择要出的牌');
    const hand = room.hands[seat];
    for (const c of cards) {
        if (!hand.includes(c)) throw new GameError('出的牌不在你手里');
    }
    const combo = analyze(cards);
    if (!combo) throw new GameError('牌型不合法');
    // 「上一手是我自己打的」意味着我赢了这一轮，现在由我重新起头 —— 这时出什么都合法。
    // 全引擎都是这么理解的：`pass()` 在这种局面回「你是本轮首发，必须出牌」，
    // `hint()` / `decide()` 也把它当成 target 为空（见各自的第一行）。
    // 只有这里漏了 `room.last.seat !== seat`，于是同一个局面下
    // pass 说「你必须出牌」、play 说「你压不过上家」，谁都动不了 —— 死锁。
    //
    // 正常对局走不到：两家都过之后 `passCount >= 2` 会把 `last` 清成 null。
    // 这一条兜的是「回合/上一手被人为摆过、状态从外部恢复」这类不一致局面，
    // 以及 `botAct` 的兜底出牌（它先 pass 失败、再拿最小单张去出，正好撞上这条路）。
    if (room.last && room.last.seat !== seat && !beats(combo, room.last.combo)) {
        throw new GameError('这手牌压不过上家');
    }
    room.hands[seat] = hand.filter((c) => !cards.includes(c));
    if (isBombLike(combo)) room.multiplier *= 2;
    room.last = { seat, combo };
    room.passCount = 0;
    pushPlay(room, {
        seat, cards: sortCards(cards), pass: false, type: combo.type, roundId: room.roundId, at: Date.now(),
    });
    room.updatedAt = Date.now();
    if (!room.hands[seat].length) {
        room.winner = seat;
        settle(room);
        room.rev++;
        return combo;
    }
    advanceTurn(room, cfg);
    room.rev++;
    return combo;
}

export function pass(room: Room, seat: number, cfg: GamesConfig): void {
    if (room.status !== 'playing') throw new GameError('现在不能过牌');
    if (room.turn !== seat) throw new GameError('还没轮到你');
    if (!room.last) throw new GameError('你是本轮首发，必须出牌');
    if (room.last.seat === seat) throw new GameError('你是本轮首发，必须出牌');
    room.passCount++;
    pushPlay(room, {
        seat, cards: [], pass: true, roundId: room.roundId, at: Date.now(),
    });
    if (room.passCount >= 2) {
        room.last = null;
        room.passCount = 0;
        room.roundId++;
    }
    room.updatedAt = Date.now();
    advanceTurn(room, cfg);
    room.rev++;
}

export function settle(room: Room): void {
    const landlord = room.landlord;
    const landlordWin = room.winner === landlord;
    let multiplier = room.multiplier;
    let bonus = '';
    const landlordPlays = room.plays.filter((p) => !p.pass && p.seat === landlord).length;
    const farmerPlays = room.plays.filter((p) => !p.pass && p.seat !== landlord).length;
    if (landlordWin && farmerPlays === 0) {
        multiplier *= 2;
        bonus = 'spring';
    } else if (!landlordWin && landlordPlays <= 1) {
        multiplier *= 2;
        bonus = 'anti';
    }
    const unit = Math.max(1, room.baseBet) * multiplier;
    room.seats.forEach((s, i) => {
        if (i === landlord) s.score = landlordWin ? 2 * unit : -2 * unit;
        else s.score = landlordWin ? -unit : unit;
    });
    room.multiplier = multiplier;
    room.status = 'finished';
    room.finishAt = Date.now();
    room.deadline = 0;
    room.botDue = 0;
    room.updatedAt = room.finishAt;
    room.result = {
        landlordWin,
        winner: room.winner,
        landlord,
        baseBet: Math.max(1, room.baseBet),
        multiplier,
        bonus,
        seats: room.seats.map((s, i) => ({
            uid: s.uid,
            uname: s.uname,
            role: i === landlord ? 'landlord' : 'farmer',
            score: s.score,
        })),
    };
    room.rev++;
}

/** 超时自动行为：叫分=不叫，出牌=过牌（首发则出最小的一张） */
export function timeoutMove(room: Room, cfg: GamesConfig): void {
    const seat = room.turn;
    if (room.status === 'bidding') {
        bid(room, seat, 0, cfg);
        return;
    }
    if (room.status !== 'playing') return;
    if (room.last && room.last.seat !== seat) {
        pass(room, seat, cfg);
        return;
    }
    const hand = room.hands[seat];
    if (!hand.length) return;
    const lowest = lowestCard(hand);
    if (lowest === null) return;
    play(room, seat, [lowest], cfg);
}

/** 手牌里最小的一张（超时/提示用） */
export function lowestCard(hand: number[]): number | null {
    if (!hand.length) return null;
    let lowest = hand[0];
    for (const c of hand) if (valueOf(c) < valueOf(lowest)) lowest = c;
    return lowest;
}
