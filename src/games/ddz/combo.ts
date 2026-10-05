/**
 * 牌型识别与比较。
 *
 * 这里刻意使用「按 count 分组」的判定方式，而不是枚举所有子集：
 * 一个牌型里任何「点数出现了 3 张却没算进三张组」的牌都会变成非法翅膀，
 * 所以每个 count 组都必须被完整使用 —— 这让判定变成几条等式，没有歧义也没有分支爆炸。
 */

import { valueOf } from './cards';

export type ComboType =
    | 'single' | 'pair' | 'trio' | 'trio1' | 'trio2'
    | 'straight' | 'straight_pair'
    | 'plane' | 'plane1' | 'plane2'
    | 'four2' | 'four2p'
    | 'bomb' | 'rocket';

export interface Combo {
    type: ComboType;
    /** 比大小用的主牌值（顺子/连对取最大的一张） */
    key: number;
    /** 牌数，同类型必须等长才能比 */
    len: number;
}

export const COMBO_NAME: Record<ComboType, string> = {
    single: '单张',
    pair: '对子',
    trio: '三张',
    trio1: '三带一',
    trio2: '三带二',
    straight: '顺子',
    straight_pair: '连对',
    plane: '飞机',
    plane1: '飞机带单',
    plane2: '飞机带对',
    four2: '四带二',
    four2p: '四带两对',
    bomb: '炸弹',
    rocket: '王炸',
};

const MAX_STRAIGHT_VALUE = 14; // A；顺子/连对/飞机不能含 2 和王

function build(cards: number[]): {
    n: number;
    counts: Map<number, number>;
    values: number[];
    ofCount: (k: number) => number[];
} {
    const counts = new Map<number, number>();
    for (const c of cards) {
        const v = valueOf(c);
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    const values = [...counts.keys()].sort((a, b) => a - b);
    return {
        n: cards.length,
        counts,
        values,
        ofCount: (k: number) => values.filter((v) => counts.get(v) === k),
    };
}

function isConsecutive(values: number[]): boolean {
    if (!values.length) return false;
    for (let i = 1; i < values.length; i++) {
        if (values[i] !== values[i - 1] + 1) return false;
    }
    return true;
}

const mk = (type: ComboType, key: number, len: number): Combo => ({ type, key, len });

/**
 * 识别一手牌的牌型；不合法返回 null。
 */
export function analyze(cards: number[]): Combo | null {
    if (!Array.isArray(cards) || !cards.length) return null;
    if (new Set(cards).size !== cards.length) return null; // 重复的牌

    const { n, counts, values, ofCount } = build(cards);
    const maxV = values[values.length - 1];

    // 王炸
    if (n === 2 && counts.get(16) === 1 && counts.get(17) === 1) return mk('rocket', 100, 2);
    // 炸弹（四张同点）
    if (n === 4 && counts.size === 1) return mk('bomb', values[0], 4);
    if (n === 1) return mk('single', values[0], 1);
    if (n === 2 && counts.size === 1) return mk('pair', values[0], 2);
    if (n === 3 && counts.size === 1) return mk('trio', values[0], 3);

    const trios = ofCount(3);
    const pairs = ofCount(2);

    if (n === 4 && trios.length === 1) return mk('trio1', trios[0], 4);
    if (n === 5 && trios.length === 1 && pairs.length === 1) return mk('trio2', trios[0], 5);

    // 顺子：≥5 张，全是单张，连续，不含 2/王
    if (n >= 5 && counts.size === n && maxV <= MAX_STRAIGHT_VALUE && isConsecutive(values)) {
        return mk('straight', maxV, n);
    }
    // 连对：≥3 对，全是对子，连续，不含 2/王
    if (n >= 6 && n % 2 === 0 && counts.size === n / 2 && counts.size === pairs.length
        && maxV <= MAX_STRAIGHT_VALUE && isConsecutive(values)) {
        return mk('straight_pair', maxV, n);
    }
    // 飞机（不带牌）：全三张，连续
    if (n >= 6 && n % 3 === 0 && counts.size === n / 3 && counts.size === trios.length
        && maxV <= MAX_STRAIGHT_VALUE && isConsecutive(values)) {
        return mk('plane', maxV, n);
    }

    const fours = ofCount(4);

    // 飞机带单：n = 4k，恰好 k 个三张且连续，其余牌只能是对子/单张
    if (n >= 8 && n % 4 === 0) {
        const k = n / 4;
        if (trios.length === k && fours.length === 0
            && trios[trios.length - 1] <= MAX_STRAIGHT_VALUE && isConsecutive(trios)) {
            return mk('plane1', trios[trios.length - 1], n);
        }
    }
    // 飞机带对：n = 5k，恰好 k 个三张且连续，其余牌恰好全是 k 个对子
    if (n >= 10 && n % 5 === 0) {
        const k = n / 5;
        if (trios.length === k && fours.length === 0 && pairs.length === k
            && trios[trios.length - 1] <= MAX_STRAIGHT_VALUE && isConsecutive(trios)) {
            return mk('plane2', trios[trios.length - 1], n);
        }
    }
    // 四带二（两单）
    if (n === 6 && fours.length === 1) return mk('four2', fours[0], 6);
    // 四带两对
    if (n === 8 && fours.length === 1 && counts.size === 3 && pairs.length === 2) {
        return mk('four2p', fours[0], 8);
    }

    return null;
}

/** a 能不能压过 b（b 为 null 表示新一轮，随便出） */
export function beats(a: Combo | null, b: Combo | null): boolean {
    if (!a) return false;
    if (!b) return true;
    if (b.type === 'rocket') return false;
    if (a.type === 'rocket') return true;
    if (a.type === 'bomb' && b.type !== 'bomb') return true;
    if (b.type === 'bomb' && a.type !== 'bomb') return false;
    return a.type === b.type && a.len === b.len && a.key > b.key;
}

export function isBombLike(c: Combo | null): boolean {
    return !!c && (c.type === 'bomb' || c.type === 'rocket');
}

export function describeCombo(c: Combo | null): string {
    if (!c) return '—';
    return COMBO_NAME[c.type] || c.type;
}
