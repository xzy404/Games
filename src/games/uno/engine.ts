/**
 * UNO 状态机。
 *
 * 和斗地主一样：全部是对普通对象的纯变换（+ 时间戳），不碰数据库。
 * 这样离线测试可以直接打几百局随机对局，不用起 Mongo。
 *
 * 规则里唯一容易搞混的地方是「摸牌」：
 *   一个回合要么打出一张能打的牌，要么摸一张；
 *   摸到的牌如果正好能打，可以立刻打出去，也可以选择「过」（这时回合才结束）。
 *   `drewThisTurn` 就是用来表达「你现在有权利过」的 —— 没摸过牌的人必须出牌。
 */

import type { GamesConfig } from '../../config';
import { shuffle } from '../../util';
import { GameError, armDeadline, isAutoSeat, syncBotDue } from '../shared';
import {
    COLORS, COLOR_TEXT, DRAW2, DRAW4, NO_COLOR, SEATS,
    colorOf, deal, isWild, kindOf, numOf, pointsOf, sortHand,
} from './cards';
import type { Room, TopCard, UnoEvent } from './types';

export { GameError };
export { syncBotDue };

/** 这个座位现在是不是由机器人（或托管中的玩家）在动 */
export const isBotSeat = isAutoSeat;

export function seatOfUid(room: Room, uid: number): number {
    return room.seats.findIndex((s) => s.uid === uid && !s.bot);
}

export function topOf(card: number, color: number): TopCard {
    return { card, color, kind: kindOf(card), num: numOf(card) };
}

/**
 * 这张牌现在能不能打。
 *
 * 两条路：颜色对得上，或者「牌面」对得上（数字牌比点数，功能牌比功能）。
 * 这是整局唯一的合法性判定，客户端不做第二份 —— 服务端会把「你手里哪些能打」
 * 直接算好下发。
 *
 * `hand` 是**必填**的：官方规则里「变色 +4」只有在**手里没有当前颜色的牌**时才允许出
 *（否则它就变成了一张「任何时候都能出、还能给下家塞 4 张」的万能解，谁都拿它耍赖）。
 * 这条判断需要看整只手牌，所以不能只传一张牌 —— 签名里必须带上 hand，
 * 否则调用点很容易「忘了传」，规则就悄悄失效了。
 *
 * 变色牌（不带 +4）没有这个限制，随时能出。
 */
export function canPlay(c: number, top: TopCard, hand: number[]): boolean {
    if (isWild(c)) {
        // top.color 是 -1 的场合不存在（万能牌出完一定带一个指定颜色）
        if (kindOf(c) === 'wild4' && top.color >= 0 && hand.some((h) => colorOf(h) === top.color)) {
            return false;
        }
        return true;
    }
    if (colorOf(c) === top.color) return true;
    const k = kindOf(c);
    if (k !== top.kind) return false;
    return k === 'num' ? numOf(c) === top.num : true;
}

/** 手牌里能打的那些 */
export function playableIn(hand: number[], top: TopCard): number[] {
    return hand.filter((c) => canPlay(c, top, hand));
}

export function nextSeat(room: Room, from: number, step = 1): number {
    return (((from + step * room.dir) % SEATS) + SEATS) % SEATS;
}

// ---------------------------------------------------------------------------
// 摸牌堆

/**
 * 摸牌堆空了就把弃牌堆洗回去（顶张留在牌面）。
 * 洗之前必须先把顶张拿出来 —— 否则「刚打出的那张」会立刻又被摸回手里。
 */
function refill(room: Room): void {
    if (room.deck.length) return;
    if (room.discard.length <= 1) return;
    const top = room.discard.pop() as number;
    room.deck = shuffle(room.discard);
    room.discard = [top];
}

/** 摸一张；牌真的没了返回 -1 */
function drawOne(room: Room): number {
    refill(room);
    if (!room.deck.length) return -1;
    return room.deck.pop() as number;
}

/** 给某个座位发 n 张（+2 / +4 用），返回真正摸到的牌 */
export function giveCards(room: Room, seat: number, n: number): number[] {
    const got: number[] = [];
    for (let i = 0; i < n; i++) {
        const c = drawOne(room);
        if (c < 0) break;
        got.push(c);
    }
    if (got.length) room.hands[seat] = sortHand([...room.hands[seat], ...got]);
    return got;
}

// ---------------------------------------------------------------------------
// 建桌

export function createRoom(gid: string, domainId: string, seats: {
    uid: number; uname: string; bot?: boolean;
}[], cfg: GamesConfig, code: string): Room {
    const ts = Date.now();
    const room: Room = {
        _id: code,
        gid,
        domainId,
        rev: 1,
        status: 'playing',
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
        deck: [],
        discard: [],
        first: -1,
        top: topOf(0, 0),
        dir: 1,
        drewThisTurn: false,
        drawnCard: -1,
        turn: 0,
        winner: -1,
        events: [],
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

export function startDeal(room: Room, cfg: GamesConfig): void {
    const { hands, deck, first } = deal();
    room.hands = hands;
    room.dealHands = hands.map((h) => h.slice());
    room.deck = deck;
    room.discard = [first];
    room.first = first;
    room.top = topOf(first, colorOf(first));
    room.dir = 1;
    room.drewThisTurn = false;
    room.drawnCard = -1;
    room.winner = -1;
    room.events = [];
    delete room.result;
    room.status = 'playing';
    room.dealCount = (room.dealCount || 0) + 1;
    for (const s of room.seats) s.score = 0;
    // 随机一家起手
    room.turn = Math.floor(Math.random() * SEATS);
    armDeadline(room, cfg.turnTimeoutSeconds);
    syncBotDue(room, cfg);
}

// ---------------------------------------------------------------------------
// 推进

function pushEvent(room: Room, ev: UnoEvent): void {
    room.events.push(ev);
    if (room.events.length > 600) room.events.splice(0, room.events.length - 600);
}

/** 回合交给下家（或下下家），并重置本回合的「已摸牌」状态 */
function advance(room: Room, cfg: GamesConfig, step: number): void {
    room.turn = nextSeat(room, room.turn, step);
    room.drewThisTurn = false;
    room.drawnCard = -1;
    armDeadline(room, cfg.turnTimeoutSeconds);
    syncBotDue(room, cfg);
}

/**
 * 出一张牌。
 *
 * `chosenColor` 只有打万能牌时才有意义，其余情况不校验（传 -1 即可）。
 */
export function play(room: Room, seat: number, card: number, chosenColor: number, cfg: GamesConfig): void {
    if (room.status !== 'playing') throw new GameError('这一局已经结束了');
    if (room.turn !== seat) throw new GameError('还没轮到你出牌');
    const hand = room.hands[seat];
    if (!Array.isArray(hand)) throw new GameError('你不在这个房间里');
    const idx = hand.indexOf(card);
    if (idx < 0) throw new GameError('这张牌不在你手里');
    if (!canPlay(card, room.top, hand)) {
        // +4 被拒的原因和「接不上」完全不同，分开报 —— 否则玩家会以为自己看错了牌
        if (kindOf(card) === 'wild4' && hand.some((h) => colorOf(h) === room.top.color)) {
            throw new GameError(
                `手里还有${COLOR_TEXT[room.top.color]}色的牌，变色 +4 只能在没有同色牌时出`,
            );
        }
        throw new GameError(`要出${COLOR_TEXT[room.top.color]}色或者同样的牌面`);
    }

    const kind = kindOf(card);
    let color = colorOf(card);
    if (isWild(card)) {
        if (!Number.isInteger(chosenColor) || chosenColor < 0 || chosenColor >= COLORS) {
            throw new GameError('万能牌要先选一个颜色');
        }
        color = chosenColor;
    }

    hand.splice(idx, 1);
    room.discard.push(card);
    room.top = topOf(card, color);
    room.drewThisTurn = false;
    room.drawnCard = -1;
    room.updatedAt = Date.now();
    pushEvent(room, {
        seat, type: 'play', card, color, at: room.updatedAt,
    });

    if (!hand.length) {
        room.winner = seat;
        settle(room);
        room.rev++;
        return;
    }

    // 牌面效果。skip / +2 / +4 都是「跳过下家」，所以步长是 2
    let step = 1;
    if (kind === 'skip') {
        step = 2;
    } else if (kind === 'reverse') {
        room.dir = (room.dir === 1 ? -1 : 1) as 1 | -1;
    } else if (kind === 'draw2' || kind === 'wild4') {
        const victim = nextSeat(room, seat, 1);
        const n = kind === 'draw2' ? DRAW2 : DRAW4;
        const got = giveCards(room, victim, n);
        pushEvent(room, {
            seat: victim, type: 'draw', cards: got, penalty: true, at: room.updatedAt,
        });
        step = 2;
    }
    advance(room, cfg, step);
    room.rev++;
}

/**
 * 摸一张牌。
 *
 * 摸到的牌能打就停在本座位（这时玩家可以立刻打出去，也可以点「过」）；
 * 不能打就直接交给下家 —— 让玩家为了「一张打不出去的牌」再点一次过，
 * 只是白白多一次点击。
 */
export function draw(room: Room, seat: number, cfg: GamesConfig): number {
    if (room.status !== 'playing') throw new GameError('这一局已经结束了');
    if (room.turn !== seat) throw new GameError('还没轮到你摸牌');
    if (room.drewThisTurn) throw new GameError('这一回合已经摸过牌了');

    const c = drawOne(room);
    if (c < 0) {
        // 牌堆和弃牌堆都空了（只有极端情况才会发生）：这一手直接过
        room.updatedAt = Date.now();
        advance(room, cfg, 1);
        room.rev++;
        return -1;
    }

    room.hands[seat] = sortHand([...room.hands[seat], c]);
    room.updatedAt = Date.now();
    pushEvent(room, { seat, type: 'draw', cards: [c], at: room.updatedAt });

    // 手牌要用**摸完之后**的那副：+4 的合法性和「现在手里有没有同色牌」有关，
    // 而刚摸进来的这张也算手里的牌
    if (canPlay(c, room.top, room.hands[seat])) {
        room.drewThisTurn = true;
        room.drawnCard = c;
    } else {
        advance(room, cfg, 1);
    }
    room.rev++;
    return c;
}

/** 过牌。只有「本回合已经摸过牌」的人有权利过 */
export function pass(room: Room, seat: number, cfg: GamesConfig): void {
    if (room.status !== 'playing') throw new GameError('这一局已经结束了');
    if (room.turn !== seat) throw new GameError('还没轮到你');
    if (!room.drewThisTurn) throw new GameError('请出一张能打的牌，或者先摸一张');
    room.updatedAt = Date.now();
    pushEvent(room, { seat, type: 'pass', at: room.updatedAt });
    advance(room, cfg, 1);
    room.rev++;
}

// ---------------------------------------------------------------------------
// 结算

/** 结算：赢家收走其他人手牌的罚分，其余人各自扣掉自己剩牌的罚分（零和） */
export function settle(room: Room): void {
    const rest = room.hands.map((h) => h.reduce((a, c) => a + pointsOf(c), 0));
    const gain = rest.reduce((a, n, i) => (i === room.winner ? a : a + n), 0);
    room.seats.forEach((s, i) => { s.score = i === room.winner ? gain : -rest[i]; });
    room.status = 'finished';
    room.finishAt = Date.now();
    room.deadline = 0;
    room.botDue = 0;
    room.drewThisTurn = false;
    room.drawnCard = -1;
    room.updatedAt = room.finishAt;
    room.result = {
        winner: room.winner,
        gain,
        seats: room.seats.map((s, i) => ({
            uid: s.uid,
            uname: s.uname,
            cards: room.hands[i].length,
            score: s.score,
        })),
    };
    room.rev++;
}

// ---------------------------------------------------------------------------
// 兜底

/**
 * 手牌里出现次数最多的颜色 —— 打万能牌时选它。
 * 平局时按红黄绿蓝的顺序取，保证同样的手牌永远选同一个色（便于复现问题）。
 */
export function bestColor(hand: number[]): number {
    const cnt = [0, 0, 0, 0];
    for (const c of hand) {
        const k = colorOf(c);
        if (k >= 0) cnt[k]++;
    }
    let best = 0;
    for (let i = 1; i < COLORS; i++) if (cnt[i] > cnt[best]) best = i;
    return best;
}

/**
 * 超时自动行为：能打就打，不能打就摸；摸到能打的顺手打出去。
 * 无论如何都要把回合交出去，否则整桌就卡在某个人身上了。
 *
 * 和机器人（bot.ts）的分工：托管中的座位走的是机器人的选牌逻辑，
 * 这里只管「没托管但人不在」的情况 —— 目标是把牌局推下去，选哪张牌不重要，
 * 所以取排好序的手牌里第一张能打的（结果确定，便于复现问题）。
 */
export function timeoutMove(room: Room, cfg: GamesConfig): void {
    if (room.status !== 'playing') return;
    const seat = room.turn;
    if (room.drewThisTurn) { pass(room, seat, cfg); return; }

    const hand = room.hands[seat] || [];
    const options = playableIn(hand, room.top);
    if (options.length) {
        const card = options[0];
        play(room, seat, card, isWild(card) ? bestColor(hand) : NO_COLOR, cfg);
        return;
    }

    draw(room, seat, cfg);
    if (room.status !== 'playing' || room.turn !== seat) return;
    const c = room.drawnCard;
    if (c < 0) { pass(room, seat, cfg); return; }
    play(room, seat, c, isWild(c) ? bestColor(room.hands[seat]) : NO_COLOR, cfg);
}
