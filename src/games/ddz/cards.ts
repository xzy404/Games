/**
 * 牌的表示。
 *
 * 一张牌就是一个 0..53 的整数：
 *   0..51  普通牌，rank = c >> 2 (0..12 → 3,4,...,10,J,Q,K,A,2)，suit = c & 3
 *   52     小王
 *   53     大王
 *
 * value 是比大小的唯一依据：3..10 → 3..10，J/Q/K/A/2 → 11..15，小王 16，大王 17。
 */

import { shuffle } from '../../util';

export const RANK_TEXT = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const SUIT_TEXT = ['♠', '♥', '♣', '♦'];
export const JOKER_SMALL = 52;
export const JOKER_BIG = 53;
export const DECK_SIZE = 54;

/** 一手牌张数 */
export const HAND_SIZE = 17;
/** 底牌张数 */
export const BOTTOM_SIZE = 3;
/** 一桌人数 */
export const SEATS = 3;

export const FULL_DECK: number[] = Array.from({ length: DECK_SIZE }, (_, i) => i);

export function isJoker(c: number): boolean {
    return c >= JOKER_SMALL;
}

/** 0..12 普通点数，13 小王，14 大王 */
export function rankOf(c: number): number {
    return c >= JOKER_SMALL ? c - 39 : c >> 2;
}

export function suitOf(c: number): number {
    return c & 3;
}

/** 比大小用的值：3..15 普通牌，16 小王，17 大王 */
export function valueOf(c: number): number {
    return c >= JOKER_SMALL ? c - 36 : (c >> 2) + 3;
}

export function sortCards(cards: number[]): number[] {
    return cards.slice().sort((a, b) => valueOf(a) - valueOf(b) || a - b);
}

export function cardName(c: number): string {
    if (c === JOKER_SMALL) return '小王';
    if (c === JOKER_BIG) return '大王';
    return SUIT_TEXT[suitOf(c)] + RANK_TEXT[rankOf(c)];
}

export function describeCards(cards: number[]): string {
    return sortCards(cards).map(cardName).join(' ');
}

/** 从 54 张里抽出 n 张（不重复），前 HAND_SIZE/BOTTOM_SIZE 张即可组成一局 */
export function deal(): { hands: number[][]; bottom: number[] } {
    const deck = shuffle(FULL_DECK);
    const hands: number[][] = [];
    for (let i = 0; i < SEATS; i++) {
        hands.push(sortCards(deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE)));
    }
    return { hands, bottom: sortCards(deck.slice(SEATS * HAND_SIZE)) };
}
