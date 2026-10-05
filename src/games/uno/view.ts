import {
    COLOR_HEX, COLOR_TEXT, FULL_DECK, WILD_FIRST,
    cardName, colorOf, faceOf, pointsOf,
} from './cards';
import { playableIn, seatOfUid } from './engine';
import { isBotUid } from './model';
import { isAutoSeat } from '../shared';
import type { Room, UnoEvent } from './types';

export interface PublicSeat {
    idx: number;
    uid: number;
    uname: string;
    bot: boolean;
    auto: boolean;
    /** 手牌张数。**别人的牌永远不出门** */
    cards: number;
    score: number;
    active: boolean;
    me: boolean;
    /** 只剩一张了，喊一声 UNO */
    uno: boolean;
}

function eventView(e: UnoEvent) {
    return {
        seat: e.seat,
        type: e.type,
        card: e.card === undefined ? -1 : e.card,
        cards: e.cards || [],
        color: e.color === undefined ? -1 : e.color,
        penalty: !!e.penalty,
        at: e.at,
        text: describe(e),
    };
}

function describe(e: UnoEvent): string {
    if (e.type === 'pass') return '过牌';
    if (e.type === 'draw') {
        const n = (e.cards || []).length;
        return e.penalty ? `被罚摸 ${n} 张` : `摸 ${n} 张`;
    }
    const base = e.card === undefined ? '出牌' : `出 ${cardName(e.card)}`;
    return e.color >= 0 && e.card !== undefined && colorOf(e.card) < 0
        ? `${base} → 指定${COLOR_TEXT[e.color]}色`
        : base;
}

/**
 * 给客户端的状态。
 *
 * `playable` 是关键：客户端**不做**任何合法性判断，能不能点是服务端算好的。
 * 这样「牌能不能打」就永远只有一份实现（engine.canPlay）。
 *
 * 但「能打」和「你有权打」是两件事，别混在一个字段里。客户端连牌面的亮/暗都是
 * 照 `playable` 画的，所以托管中若照样下发 `playable`，会看到「出牌区已经收起、
 * 提示写着已托管，可手里明明有几张牌亮着」—— 两边说法不一致。
 * 因此下面用 `canAct`（= 轮到我 **且** 操作权在我手上）去收口
 * `playable` / `canPass` / `drawnCard` 这三个**可操作**字段；
 * `myTurn` 保持原义，只描述「轮到谁」这个事实 —— 前端拿它做出牌区显隐和点牌的前置判断
 * （座位上的高亮是另一路，走的是每条 `seats[].active`，与托管无关）。
 */
export function roomView(room: Room, uid: number) {
    const seat = seatOfUid(room, uid);
    const isPlayer = seat >= 0;
    const over = room.status === 'finished';
    const myTurn = isPlayer && !over && room.turn === seat;
    const myHand = isPlayer ? (room.hands[seat] || []) : [];
    /** 操作权在不在我手上：轮到我，且这个座位没有交给机器人（托管 / 掉线托管） */
    const canAct = myTurn && !isAutoSeat(room, seat);

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
            active: !over && room.turn === i,
            me: i === seat,
            uno: !over && room.hands[i] ? room.hands[i].length === 1 : false,
        })),
        hand: myHand,
        /** 我现在能打哪几张。空数组 = 只能摸牌（托管中也是空数组：你没得打） */
        playable: canAct ? playableIn(myHand, room.top) : [],
        top: { card: room.top.card, color: room.top.color, kind: room.top.kind, num: room.top.num },
        color: room.top.color,
        dir: room.dir,
        deckCount: room.deck.length,
        discardCount: room.discard.length,
        turn: over ? -1 : room.turn,
        myTurn,
        /** 摸过牌之后才有权利「过」 */
        canPass: canAct && room.drewThisTurn,
        drewThisTurn: room.drewThisTurn,
        /** 托管中不给 —— 给了客户端会替玩家选中一张牌，那又是一张「亮着的牌」 */
        drawnCard: canAct ? room.drawnCard : -1,
        last: room.events.length ? eventView(room.events[room.events.length - 1]) : null,
        events: room.events.slice(-12).map(eventView),
        winner: room.winner,
        result: room.result || null,
        deadline: room.deadline,
        serverNow: Date.now(),
        /** 已结束才有：完整回放（含四家的起手牌，所以进行中一律为 null） */
        replay: over ? replayView(room) : null,
    };
}

/**
 * 已结束对局的回放数据：起手牌 + 开局牌面 + 全部流水。
 *
 * 客户端按 events 顺序重放就能回到任意一步，**不需要**在服务端算好每一帧。
 * 只有 `finished` 的对局才发 —— 进行中带 `dealHands` 等于把四家的牌全公开了。
 */
export function replayView(room: Room) {
    if (room.status !== 'finished') return null;
    return {
        first: room.first,
        firstColor: colorOf(room.first),
        dealHands: (room.dealHands || []).map((h) => h.slice()),
        events: room.events.map(eventView),
        winner: room.winner,
        seats: room.seats.map((s, i) => ({
            idx: i,
            uid: isBotUid(s.uid) ? 0 : s.uid,
            uname: s.uname,
            bot: s.bot,
        })),
    };
}

/** 最近对局记录的展示形态 */
export function matchView(match: any, uid: number) {
    // 赢家按**座位号**认，不按 uid —— 一桌可能有 3 个机器人，uid 全是 0
    const seats = (match.seats || []).map((s: any) => ({
        idx: s.idx,
        uid: s.uid,
        uname: s.uname || '机器人',
        cards: s.cards || 0,
        score: s.score || 0,
        me: !!uid && s.uid === uid,
        winner: s.idx === match.winner,
    }));
    const me = seats.find((s: any) => s.me);
    return {
        roomId: match.roomId,
        createAt: match.createAt,
        duration: match.duration,
        winnerSeat: match.winner,
        seats,
        myScore: me ? me.score : null,
        iWon: !!(me && me.winner),
    };
}

/**
 * 牌面文案，由服务端整表下发。
 *
 * 不是「发几条规则让前端自己算」，而是把 108 张牌的**成品**（字号/颜色/罚分）
 * 直接给出去 —— 客户端只需要 `FACE.face[id]` 查表，编码方式就永远只有一份实现。
 * 一张牌摊到 4 个字符左右，整表不到 1KB。
 */
export const UNO_FACE = {
    colorText: COLOR_TEXT,
    colorHex: COLOR_HEX,
    faces: FULL_DECK.map(faceOf),
    colors: FULL_DECK.map(colorOf),
    points: FULL_DECK.map(pointsOf),
    /** >= 这个 id 就是万能牌（前端据此决定要不要弹选色框） */
    wildFrom: WILD_FIRST,
};
