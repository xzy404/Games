/**
 * UNO 的牌的表示。
 *
 * 一张牌就是一个 0..107 的整数，整体分三段：
 *
 *   0..99    四色牌。`color = id / 25`（0 红 / 1 黄 / 2 绿 / 3 蓝），`slot = id % 25`：
 *              slot 0        数字 0（每色一张）
 *              slot 1..9     数字 1..9（第一张）
 *              slot 10..18   数字 1..9（第二张）
 *              slot 19,20    禁止（Skip）
 *              slot 21,22    反转（Reverse）
 *              slot 23,24    +2（Draw Two）
 *            每色 25 张 × 4 色 = 100 张
 *   100..103 变色（Wild）×4
 *   104..107 变色 +4（Wild Draw Four）×4
 *
 * 整副 108 张，和实体牌完全一致。
 *
 * 把「花色」和「牌面」编码进一个整数，好处是手牌、弃牌堆、牌堆都是 `number[]`，
 * 存进 Mongo 直接就是一串数字，重放、比对、去重都不需要额外的序列化。
 */

import { shuffle } from '../../util';

export const COLORS = 4;
/** 红 黄 绿 蓝 —— 顺序即 color 的取值 */
export const COLOR_TEXT = ['红', '黄', '绿', '蓝'];
export const COLOR_CODE = ['r', 'y', 'g', 'b'];
export const COLOR_HEX = ['#d92b2b', '#d9a800', '#1f9d55', '#2563eb'];

/** 每色 25 张 */
export const PER_COLOR = 25;
/** 四色牌的末尾 */
export const COLORED_MAX = COLORS * PER_COLOR; // 100
export const WILD_FIRST = COLORED_MAX;          // 100
export const WILD4_FIRST = COLORED_MAX + 4;     // 104
export const DECK_SIZE = COLORED_MAX + 8;       // 108

/** 每人起手 7 张 */
export const HAND_SIZE = 7;
/** 一桌 4 人 */
export const SEATS = 4;

/** 万能牌的「花色」：没有颜色 */
export const NO_COLOR = -1;

export type Kind = 'num' | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4';

/** 万能牌额外抽几张 */
export const DRAW2 = 2;
export const DRAW4 = 4;

export const FULL_DECK: number[] = Array.from({ length: DECK_SIZE }, (_, i) => i);

export function isWild(c: number): boolean {
    return c >= WILD_FIRST;
}

/** 0..3；万能牌返回 NO_COLOR */
export function colorOf(c: number): number {
    return c < COLORED_MAX ? Math.floor(c / PER_COLOR) : NO_COLOR;
}

export function kindOf(c: number): Kind {
    if (c >= WILD4_FIRST) return 'wild4';
    if (c >= WILD_FIRST) return 'wild';
    const slot = c % PER_COLOR;
    if (slot === 0) return 'num';
    if (slot <= 18) return 'num';
    if (slot <= 20) return 'skip';
    if (slot <= 22) return 'reverse';
    return 'draw2';
}

/** 数字牌的点数 0..9；非数字牌返回 NO_COLOR（-1） */
export function numOf(c: number): number {
    if (isWild(c)) return -1;
    const slot = c % PER_COLOR;
    if (slot === 0) return 0;
    if (slot <= 9) return slot;
    if (slot <= 18) return slot - 9;
    return -1;
}

/** 结算用的罚分：数字牌面值，功能牌 20，万能牌 50 */
export function pointsOf(c: number): number {
    const k = kindOf(c);
    if (k === 'num') return numOf(c);
    if (k === 'wild' || k === 'wild4') return 50;
    return 20;
}

/** 牌面上写的字：数字牌写点数，功能牌写符号 */
export function faceOf(c: number): string {
    const k = kindOf(c);
    if (k === 'num') return String(numOf(c));
    if (k === 'skip') return '⊘';
    if (k === 'reverse') return '⇄';
    if (k === 'draw2') return '+2';
    if (k === 'wild') return '★';
    return '+4';
}

/** 中文名，日志和回放里用 */
export function cardName(c: number): string {
    const k = kindOf(c);
    if (k === 'wild') return '变色牌';
    if (k === 'wild4') return '变色 +4';
    const color = COLOR_TEXT[colorOf(c)];
    if (k === 'num') return `${color} ${numOf(c)}`;
    if (k === 'skip') return `${color} 禁止`;
    if (k === 'reverse') return `${color} 反转`;
    return `${color} +2`;
}

/**
 * 手牌排序：先按颜色（万能牌统一排在最后），同色内数字在前、功能牌在后。
 * 只影响显示与「摸到的牌插到哪」，不参与任何规则判断。
 */
function sortKey(c: number): [number, number, number] {
    if (isWild(c)) return [COLORS + 1, c >= WILD4_FIRST ? 1 : 0, 0];
    const k = kindOf(c);
    const kr = k === 'num' ? 0 : (k === 'skip' ? 1 : (k === 'reverse' ? 2 : 3));
    return [colorOf(c), kr, k === 'num' ? numOf(c) : 0];
}

export function sortHand(hand: number[]): number[] {
    return hand.slice().sort((a, b) => {
        const x = sortKey(a);
        const y = sortKey(b);
        for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
        return a - b;
    });
}

/** 洗好的整副牌 */
export function newDeck(): number[] {
    return shuffle(FULL_DECK);
}

/**
 * 发牌：每人 7 张，再翻一张做起始牌。
 *
 * 起始牌刻意**不翻万能牌** —— 万能牌一翻开就得立刻指定颜色，而这时候还没有
 * 「上家」，凭空多一个「谁选色」的状态。翻到万能牌就把它塞回牌堆底部重翻。
 */
export function deal(): { hands: number[][]; deck: number[]; first: number } {
    const deck = newDeck();
    const hands: number[][] = [];
    for (let i = 0; i < SEATS; i++) hands.push(sortHand(deck.splice(0, HAND_SIZE)));
    let first = -1;
    while (deck.length) {
        const c = deck.pop() as number;
        if (!isWild(c)) { first = c; break; }
        deck.unshift(c);
    }
    // 理论上不可能（108 张里只有 8 张万能牌），留个兜底免得死循环
    if (first < 0) { first = 0; deck.push(0); }
    return { hands, deck, first };
}

/** 拼一副 108 张的牌面清单，牌桌/回放上偶尔要按花色展示 */
export function groupByColor(): number[][] {
    const out: number[][] = [[], [], [], [], []];
    for (const c of FULL_DECK) out[isWild(c) ? 4 : colorOf(c)].push(c);
    return out;
}
