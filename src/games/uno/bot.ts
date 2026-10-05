/**
 * UNO 机器人。
 *
 * 只负责「选哪张牌」，所有合法性都由 engine 复核 —— 机器人出的牌和玩家出的牌
 * 走的是同一个 `play()`，没有第二条规则路径。
 */

import type { GamesConfig } from '../../config';
import { NO_COLOR, colorOf, isWild, kindOf, numOf, pointsOf } from './cards';
import { bestColor, draw, nextSeat, play, playableIn } from './engine';
import type { Room } from './types';

/** 下家手牌很少时，功能牌的价值会大幅上升 */
function isDanger(room: Room, seat: number): boolean {
    const n = room.hands[nextSeat(room, seat, 1)];
    return !!n && n.length <= 2;
}

/**
 * 「跳过下家」的牌，以及用它们的优先顺序。
 *
 * 只有这四种真的能挡住下家：+2 / 变色 +4 除了跳过还塞牌，禁止直接跳过，
 * 反转在**四人局**里等于换向 —— 下家一样没得打，所以也是实打实的拦牌。
 * （三人才需要另算，本游戏固定四人。）
 *
 * 排序依据是「同样的拦截效果，用便宜的那张」：+2 塞两张最赚；
 * 禁止和反转都是 20 分，先出谁都行；+4 同样只是跳过，但它是 50 分，
 * 留在手里最亏、打出去最心疼，所以放在最后 —— 但**只要没有别的拦牌，该用就得用**。
 */
const BLOCK_ORDER: Record<string, number> = {
    draw2: 0, skip: 1, reverse: 2, wild4: 3,
};

/**
 * 在能打的牌里挑一张。
 *
 * 思路（刻意做得简单、可解释）：
 *   · 下家快走完了 → 手里**任何**能拦住他的牌都要考虑，包括平时舍不得用的 +4。
 *     拦不住就输在这一手，这时候「省牌」毫无意义；
 *   · 自己快走完了（≤3 张）→ 同样优先甩拦牌：一张牌的两个作用都要吃掉；
 *   · 否则优先丢掉**罚分高**的牌 —— 反正要出，先出手里最贵的；
 *     同分时丢掉自己手里**最少**的那一色的那张，留下来的是「能接的色」；
 *   · 万能牌留到最后：实在没牌可打才用，变色也选手里最多的那一色。
 */
function choose(room: Room, seat: number, options: number[]): number {
    const hand = room.hands[seat];
    // 下家快走完（必须拦），或者**我自己**快走完（≤3 张：这时候功能牌既帮我少一张牌，
    // 又顺手拖住下家，是双份收益，比甩一张数字牌划算），两种情况都优先甩拦牌。
    const danger = isDanger(room, seat) || hand.length <= 3;
    const plain = options.filter((c) => !isWild(c));

    if (danger) {
        // 注意这里筛的是 `options` 而不是 `plain`：
        // +4 是万能牌（isWild），以前被排除在外，于是「下家只剩 1 张、我手里就一张 +4 能拦」
        // 的时候，它会去出一张普通的数字牌，把这一局直接送掉。
        const blockers = options.filter((c) => BLOCK_ORDER[kindOf(c)] !== undefined);
        if (blockers.length) {
            blockers.sort((a, b) => BLOCK_ORDER[kindOf(a)] - BLOCK_ORDER[kindOf(b)] || a - b);
            return blockers[0];
        }
    }

    // 万能牌只在没有普通牌可打时才考虑
    if (!plain.length) {
        const wilds = options.filter((c) => isWild(c));
        // 优先普通万能牌，把 +4 留成后手
        wilds.sort((a, b) => (kindOf(a) === 'wild' ? 0 : 1) - (kindOf(b) === 'wild' ? 0 : 1));
        return wilds[0] !== undefined ? wilds[0] : options[0];
    }

    const counts = [0, 0, 0, 0];
    for (const c of hand) {
        const k = colorOf(c);
        if (k >= 0) counts[k]++;
    }
    const ranked = plain.slice().sort((a, b) => {
        // 1) 先甩贵的（罚分高）
        const p = pointsOf(b) - pointsOf(a);
        if (p) return p;
        // 2) 同分时**从颜色最少的那个色里出**，把自己手里最多的那一色留下来当接应。
        //    （这里原来写反了：按颜色多的先出，等于每次都在拆自己最能接的那一色。）
        const q = counts[colorOf(a)] - counts[colorOf(b)];
        if (q) return q;
        // 3) 再按点数大的先走
        const n = numOf(b) - numOf(a);
        if (n) return n;
        return a - b;
    });
    return ranked[0];
}

/** 这个座位打算做什么。没得打就返回 null */
export function botMove(room: Room, seat: number): { card: number; color: number } | null {
    if (room.status !== 'playing' || room.turn !== seat) return null;
    const hand = room.hands[seat];
    if (!hand || !hand.length) return null;
    const options = playableIn(hand, room.top);
    if (!options.length) return null;
    const card = choose(room, seat, options);
    return { card, color: isWild(card) ? bestColor(hand) : NO_COLOR };
}

/** 机器人走一步。停在本座位的可能性是「摸到能打的牌」那一次 */
export function botAct(room: Room, seat: number, cfg: GamesConfig): void {
    if (room.status !== 'playing' || room.turn !== seat) return;
    const move = botMove(room, seat);
    if (move) {
        play(room, seat, move.card, move.color, cfg);
        return;
    }
    draw(room, seat, cfg);
    // 摸到能打的牌就顺手打掉，免得为了同一件事再等一个 tick
    if (room.status !== 'playing' || room.turn !== seat) return;
    const c = room.drawnCard;
    if (c < 0) return;
    play(room, seat, c, isWild(c) ? bestColor(room.hands[seat]) : NO_COLOR, cfg);
}

/**
 * 「提示」用：给人挑一张参考牌。返回 null 表示手里没有能打的了。
 * 和机器人共用同一套选择逻辑 —— 提示和机器人打法不同会很诡异。
 */
export function hint(room: Room, seat: number): number | null {
    const move = botMove(room, seat);
    return move ? move.card : null;
}
