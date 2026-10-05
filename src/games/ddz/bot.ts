/**
 * 斗地主机器人。
 *
 * 设计原则：**候选出法一律交给 `analyze` 复核**，机器人只负责「挑哪个」。
 * 这样即使生成逻辑有漏洞，也不会出现非法出牌把整局卡死 —— 非法候选被静态过滤掉。
 */

import type { GamesConfig } from '../../config';
import { sortCards, valueOf } from './cards';
import {
    analyze, beats, isBombLike, type Combo, type ComboType,
} from './combo';
import { GameError } from '../shared';
import {
    bid, lowestCard, pass, play, roleOf,
} from './engine';
import type { Room } from './types';

const MAX_RUN_VALUE = 14; // A；顺子/连对/飞机不能含 2 和王

const SEATS = 3;

/** 我的下家。三家轮转，下家只可能是「队友」或「地主」——这决定了首发该送还是该顶 */
function nextOf(seat: number): number {
    return (seat + 1) % SEATS;
}

interface Cand { cards: number[]; combo: Combo; }

type ValueMap = Map<number, number[]>;

function countsOf(cards: number[]): ValueMap {
    const m: ValueMap = new Map();
    for (const c of sortCards(cards)) {
        const v = valueOf(c);
        if (!m.has(v)) m.set(v, []);
        (m.get(v) as number[]).push(c);
    }
    return m;
}

/** 手牌里点数出现次数 ≥ min 的所有点数（含 2 和王） */
function allValues(byValue: ValueMap, min: number): number[] {
    return [...byValue.keys()].filter((v) => (byValue.get(v) as number[]).length >= min).sort((a, b) => a - b);
}

/** 可用于顺子/连对/飞机的点数（不含 2 和王） */
function runValues(byValue: ValueMap, min: number): number[] {
    return allValues(byValue, min).filter((v) => v <= MAX_RUN_VALUE);
}

function runsOf(values: number[], len: number): number[][] {
    const out: number[][] = [];
    for (let i = 0; i + len <= values.length; i++) {
        let ok = true;
        for (let j = 1; j < len; j++) {
            if (values[i + j] !== values[i + j - 1] + 1) { ok = false; break; }
        }
        if (ok) out.push(values.slice(i, i + len));
    }
    return out;
}

function takeN(byValue: ValueMap, value: number, n: number): number[] {
    return ((byValue.get(value) as number[]) || []).slice(0, n);
}

function removeCards(byValue: ValueMap, cards: number[]): void {
    for (const c of cards) {
        const v = valueOf(c);
        const list = byValue.get(v);
        if (!list) continue;
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) byValue.delete(v);
    }
}

/**
 * 给三带/飞机挑翅膀。
 * 打分顺序刻意是「先别拆牌，再别动 2 和王」——拆炸弹去带牌是新手才犯的错。
 */
function takeWings(byValue: ValueMap, ban: Set<number>, k: number, size: number, used: Set<number>): number[] | null {
    const cost = (v: number, n: number) => {
        let r = 0;
        if (v >= 15) r += 4;
        if (n === 4) r += 2;
        else if (n === 3) r += 1;
        return r;
    };
    const pool = [...byValue.keys()]
        .filter((v) => !ban.has(v))
        .map((v) => ({ v, cards: (byValue.get(v) as number[]).filter((c) => !used.has(c)) }))
        .filter((x) => x.cards.length >= size)
        .sort((a, b) => cost(a.v, a.cards.length) - cost(b.v, b.cards.length) || a.v - b.v);
    const out: number[] = [];
    for (const item of pool) {
        if (out.length >= k * size) break;
        out.push(...item.cards.slice(0, size));
    }
    if (out.length < k * size) return null;
    return out;
}

function sizeOfPlane(type: ComboType, len: number): { k: number; wing: number } {
    if (type === 'plane') return { k: len / 3, wing: 0 };
    if (type === 'plane1') return { k: len / 4, wing: 1 };
    return { k: len / 5, wing: 2 };
}

function genByType(hand: number[], type: ComboType, len: number, minKey: number): number[][] {
    const byValue = countsOf(hand);
    const res: number[][] = [];
    const add = (c: number[]) => { if (c.length) res.push(sortCards(c)); };

    switch (type) {
        case 'single':
            for (const v of allValues(byValue, 1)) if (v > minKey) add(takeN(byValue, v, 1));
            break;
        case 'pair':
            for (const v of allValues(byValue, 2)) if (v > minKey) add(takeN(byValue, v, 2));
            break;
        case 'trio':
            for (const v of allValues(byValue, 3)) if (v > minKey) add(takeN(byValue, v, 3));
            break;
        case 'trio1':
        case 'trio2': {
            const size = type === 'trio1' ? 1 : 2;
            for (const v of allValues(byValue, 3)) {
                if (v <= minKey) continue;
                const main = takeN(byValue, v, 3);
                const wings = takeWings(byValue, new Set([v]), 1, size, new Set(main));
                if (wings) add([...main, ...wings]);
            }
            break;
        }
        case 'straight':
            for (const run of runsOf(runValues(byValue, 1), len)) {
                if (run[run.length - 1] <= minKey) continue;
                add(run.flatMap((v) => takeN(byValue, v, 1)));
            }
            break;
        case 'straight_pair':
            for (const run of runsOf(runValues(byValue, 2), len / 2)) {
                if (run[run.length - 1] <= minKey) continue;
                add(run.flatMap((v) => takeN(byValue, v, 2)));
            }
            break;
        case 'plane':
        case 'plane1':
        case 'plane2': {
            const { k, wing } = sizeOfPlane(type, len);
            for (const run of runsOf(runValues(byValue, 3), k)) {
                if (run[run.length - 1] <= minKey) continue;
                const main = run.flatMap((v) => takeN(byValue, v, 3));
                if (!wing) { add(main); continue; }
                const wings = takeWings(byValue, new Set(run), k, wing, new Set(main));
                if (wings) add([...main, ...wings]);
            }
            break;
        }
        case 'four2':
        case 'four2p': {
            const size = type === 'four2' ? 1 : 2;
            for (const v of allValues(byValue, 4)) {
                if (v <= minKey) continue;
                const main = takeN(byValue, v, 4);
                const wings = takeWings(byValue, new Set([v]), 2, size, new Set(main));
                if (wings) add([...main, ...wings]);
            }
            break;
        }
        case 'bomb':
            for (const v of allValues(byValue, 4)) if (v > minKey) add(takeN(byValue, v, 4));
            break;
        case 'rocket':
            if (byValue.has(16) && byValue.has(17)) add([52, 53]);
            break;
        default:
            break;
    }
    return res;
}

export function candidates(hand: number[], target: Combo | null): Cand[] {
    const out: Cand[] = [];
    const push = (cards: number[]) => {
        const combo = analyze(cards);
        if (!combo) return;
        if (target && !beats(combo, target)) return;
        out.push({ cards, combo });
    };
    if (target) {
        for (const c of genByType(hand, target.type, target.len, target.key)) push(c);
    }
    if (!target || target.type !== 'rocket') {
        const bombFloor = target && target.type === 'bomb' ? target.key : 0;
        for (const c of genByType(hand, 'bomb', 4, bombFloor)) push(c);
    }
    if (!target || target.type !== 'rocket') {
        for (const c of genByType(hand, 'rocket', 2, 0)) push(c);
    }
    const seen = new Set<string>();
    return out.filter((x) => {
        const key = sortCards(x.cards).join(',');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 把手牌贪心拆成若干手，用于首发时挑一手打出去 */
export function decompose(hand: number[]): number[][] {
    const byValue = countsOf(hand);
    const plays: number[][] = [];
    const grab = (values: number[], n: number) => {
        const cards: number[] = [];
        for (const v of values) {
            const got = takeN(byValue, v, n);
            cards.push(...got);
            removeCards(byValue, got);
        }
        return cards;
    };

    if (byValue.has(16) && byValue.has(17)) plays.push(grab([16, 17], 1));
    for (const v of allValues(byValue, 4)) plays.push(grab([v], 4));

    // 顺子（优先长的）
    for (;;) {
        const vs = runValues(byValue, 1);
        let best: number[] | null = null;
        for (let len = Math.min(12, vs.length); len >= 5; len--) {
            const rs = runsOf(vs, len);
            if (rs.length) { best = rs[0]; break; }
        }
        if (!best) break;
        plays.push(grab(best, 1));
    }
    // 连对
    for (;;) {
        const vs = runValues(byValue, 2);
        let best: number[] | null = null;
        for (let len = Math.min(10, vs.length); len >= 3; len--) {
            const rs = runsOf(vs, len);
            if (rs.length) { best = rs[0]; break; }
        }
        if (!best) break;
        plays.push(grab(best, 2));
    }
    // 飞机
    for (;;) {
        const rs = runsOf(runValues(byValue, 3), 2);
        if (!rs.length) break;
        plays.push(grab(rs[0], 3));
    }
    // 三张（尽量带牌）
    for (const v of allValues(byValue, 3)) {
        const main = grab([v], 3);
        const ban = new Set([v]);
        const used = new Set(main);
        const wings = takeWings(byValue, ban, 1, 2, used) || takeWings(byValue, ban, 1, 1, used);
        if (wings) {
            removeCards(byValue, wings);
            plays.push(sortCards([...main, ...wings]));
        } else plays.push(main);
    }
    for (const v of allValues(byValue, 2)) plays.push(grab([v], 2));
    for (const v of allValues(byValue, 1)) plays.push(grab([v], 1));
    return plays.filter((p) => p.length);
}

function isOpponent(room: Room, me: number, other: number): boolean {
    const a = roleOf(room, me);
    const b = roleOf(room, other);
    if (!a || !b) return other !== me;
    return a !== b;
}

/** 队友的座位号。地主没有队友，返回 -1 */function teammateOf(room: Room, seat: number): number {
    if (room.landlord < 0 || seat === room.landlord) return -1;
    for (let i = 0; i < room.hands.length; i++) {
        if (i !== seat && !isOpponent(room, seat, i)) return i;
    }
    return -1;
}

/**
 * 叫分门槛：牌力达到多少才叫 3 / 2 / 1 分。
 *
 * 这个数字直接决定「地主有多强」，因为地主是**叫分选出来的** ——
 * 门槛越低，越容易出现「三份牌里最好的那份被挑走当地主」，农民就越难打。
 * 实测（1000 局）：门槛 3.2 时地主胜率 67.8%，而把地主随机指定（完全不看牌）
 * 只有 50.6% —— 也就是说那 17 个百分点全是叫分挑牌挑出来的，跟农民会不会打无关。
 *
 * 做成可导出的常量是为了让 `tools/diag-bots.js` 能扫参定档。
 */
export const BID_STEPS = { three: 6.0, two: 4.6, one: 3.2 };

/** 对真人留手时的叫分门槛：只有真正的好牌才抢地主 */
const MERCY_BID_STEPS = { three: 12.0, two: 9.0, one: 5.5 };

/**
 * 这一手要不要「对真人留手」。
 *
 * 斗地主的地主是**叫分叫出来的**，所以地主天然拿着三家牌里最好的那一份。
 * 实测 1000 局：叫分选出来的地主胜率 68.9%，而把地主随机指定（完全不看牌）
 * 只有 47.7% —— 那 20 个百分点全是叫分挑牌挑出来的，跟农民会不会打毫无关系。
 * 换句话说，真人只要不叫地主，就有一大半的局要面对「全场最好的牌」。
 * 这就是「跟机器人打根本赢不了几局」的来源。
 *
 * 规则不能改，所以改成「机器人对真人收力」。关键是**只对真人对手生效**：
 *  · 你当农民时 —— 坐在你对面的地主机器人收力，而**你的农民队友照常配合**
 *    （不然又把上一版修好的「帮队友」改回「不帮队友」了）；
 *  · 你当地主时 —— 两个农民机器人都是你的对手，都收力。
 * 满屋子机器人（观战、回放、压测）时这条不生效，对局强度一点不变。
 *
 * 收力的尺度刻意压得很轻：不用炸弹 + 不为了压牌动用 2/王 + 叫分变保守。
 * 不做「随机乱出」那一套 —— 机器人打得像机器人才是之前被吐槽的点，
 * 不能用新的傻来治旧的强。「不拿 2/王 压」那条还有个前置条件，见 `shouldHoldBack`。
 */
function mercy(room: Room, seat: number): boolean {
    return room.seats.some((s, i) => i !== seat && !s.bot && isOpponent(room, seat, i));
}

/**
 * 留手的**尺度**：只在真人还没进入终局时收力（真人手里还 ≥ MERCY_HAND_FLOOR 张）。
 *
 * 这一条是量出来的。不分阶段地一直收力，真人胜率会从 26% 窜到 **81.7%** ——
 * 那不是「有机会赢」，是「不用玩也能赢」，对局直接失去意义。
 * 卡到终局之后就照常打：前半程你能舒服地把牌铺开，最后几张还是得自己想办法走完。
 */
const MERCY_HAND_FLOOR = 6;

function shouldHoldBack(room: Room, seat: number): boolean {
    if (!mercy(room, seat)) return false;
    const humanMin = Math.min(...room.hands.map((h, i) => (
        i !== seat && !room.seats[i].bot ? h.length : 99
    )));
    return humanMin >= MERCY_HAND_FLOOR;
}

export function botBid(room: Room, seat: number, cfg: GamesConfig): number {
    const byValue = countsOf(room.hands[seat]);
    let power = 0;
    if (byValue.has(16)) power += 1.6;
    if (byValue.has(17)) power += 1.8;
    power += ((byValue.get(15) as number[]) || []).length * 0.85;
    power += ((byValue.get(14) as number[]) || []).length * 0.35;
    power += ((byValue.get(13) as number[]) || []).length * 0.2;
    for (const v of byValue.keys()) {
        const n = (byValue.get(v) as number[]).length;
        if (n === 4) power += 2.2;
        else if (n === 3) power += 0.3;
    }
    void cfg;
    const steps = mercy(room, seat) ? MERCY_BID_STEPS : BID_STEPS;
    const want = power >= steps.three ? 3 : (power >= steps.two ? 2 : (power >= steps.one ? 1 : 0));
    const best = room.bidScores.reduce((a, b) => Math.max(a, b), 0);
    if (want > best) return want;
    // 三家都不叫会重新发牌，机器人兜底当一次地主
    if (best === 0 && room.bidIdx === room.bidOrder.length - 1) return 1;
    return 0;
}

export interface BotDecision { cards: number[] | null; pass: boolean }

export function decide(room: Room, seat: number): BotDecision {
    const hand = room.hands[seat];
    if (!hand.length) return { cards: null, pass: true };
    const target = (room.last && room.last.seat !== seat) ? room.last.combo : null;
    // 对真人留手：炸弹这种「一出手就把对局打死」的东西收起来。
    // 只压牌时的炸弹，别的行为一律不变 —— 收力要收得可解释，不要变成乱打。
    const holdBack = shouldHoldBack(room, seat);

    if (target) {
        const cands = candidates(hand, target);
        const finisher = cands.find((c) => c.cards.length === hand.length);
        if (finisher) return { cards: finisher.cards, pass: false };

        const soft = cands.filter((c) => !isBombLike(c.combo));
        const bombs = cands.filter((c) => isBombLike(c.combo));
        const lastSeat = (room.last as { seat: number }).seat;
        const lastCount = room.hands[lastSeat].length;

        if (!isOpponent(room, seat, lastSeat)) {
            // 队友出的牌不压，除非地主快走完了
            const landlordCount = room.landlord >= 0 ? room.hands[room.landlord].length : 99;
            if (landlordCount > 2) return { cards: null, pass: true };
        }
        if (soft.length) {
            soft.sort((a, b) => a.combo.key - b.combo.key || a.cards.length - b.cards.length);
            // 对真人留手：只在这手牌「必须动用 2 或王」时才收力（小牌照常压，不是乱让）。
            // 效果正好落在真人的体感上 —— 你出的小牌不会动不动就被一张 2 顶掉。
            // 能一把走完的场面在上面就返回了，所以这里不会拦着机器人赢。
            if (holdBack && soft[0].combo.key >= 15) return { cards: null, pass: true };
            return { cards: soft[0].cards, pass: false };
        }
        if (bombs.length && !holdBack) {
            // 农民手里的炸弹是「最后一道闸」，什么时候放是农民配合里最关键的一个判断。
            // 除了「谁快走完谁危险」之外，还要单独盯**地主**：地主剩 3 张时其实已经
            // 进入危险区（一手对子加一张单张就结束了），这时再舍不得炸就来不及了。
            const landlordN = room.landlord >= 0 ? room.hands[room.landlord].length : 99;
            const danger = lastCount <= 2 || hand.length <= 6
                || landlordN <= 3
                || room.hands.some((h, i) => i !== seat && isOpponent(room, seat, i) && h.length <= 2);
            if (danger) {
                bombs.sort((a, b) => a.combo.key - b.combo.key);
                return { cards: bombs[0].cards, pass: false };
            }
        }
        return { cards: null, pass: true };
    }

    // 首发
    if (analyze(hand)) return { cards: hand, pass: false };
    const plays = decompose(hand).map((p) => ({ p, combo: analyze(p) as Combo }))
        .filter((x) => !!x.combo && !isBombLike(x.combo));
    if (!plays.length) {
        const l = lowestCard(hand);
        return l === null ? { cards: null, pass: true } : { cards: [l], pass: false };
    }

    const landlordN = room.landlord >= 0 ? room.hands[room.landlord].length : 99;
    const mate = teammateOf(room, seat);
    const mateN = mate >= 0 ? room.hands[mate].length : 99;
    const next = nextOf(seat);

    // ── 农民首发：队友快走完了，先让路 ──────────────────────────────
    // 「让队友走」是农民之间真正算得上配合的动作之一：队友只剩一两张时，
    // 手里那点牌与其自己拆着出，不如甩一张**最小的单张**，让队友随便一张都能接上、
    // 直接把牌走完。少了这一步，两个农民就只是各打各的，地主挨个压过去就行 ——
    // 玩家看到的正是「不帮农民队友，反而像在帮地主」。
    //
    // 但它有个前提：**队友必须是我的下家**。三家轮转下，我的下家不是队友就一定是地主，
    // 队友如果坐在更后面，我出的牌要先过地主的手，地主随手就接走了 ——
    // 这时候「送一张最小单张」等于把出牌权递给对面，是反向的「帮忙」。
    // 原先漏判了这一条，所以有一部分让路其实是在帮地主。
    //
    // 地主只剩 1 张时不适用：这时候要出「他接不住的牌型」（对子/连牌，一张牌压不了），
    // 让牌反而会把机会交出去，所以留给下面那条抢着走完的逻辑。
    //
    // 试过、但**测出来是负收益**、所以没保留的做法：下家是地主时改成「顶牌」
    // （甩最长/最大的牌逼地主交牌）。1000 局 × 5 档阈值实测，地主胜率从 66.8%
    // 反而升到 68.9%~70.4% —— 顶牌同样在消耗自己，而地主的牌更整齐、更经得起对拼。
    if (mate >= 0 && next === mate && mateN <= 2 && landlordN > 1) {
        const l = lowestCard(hand);
        if (l !== null) return { cards: [l], pass: false };
    }

    const minOpp = Math.min(...room.hands.map((h, i) => (isOpponent(room, seat, i) ? h.length : 99)));
    if (minOpp <= 2) {
        plays.sort((a, b) => b.p.length - a.p.length || a.combo.key - b.combo.key);
        return { cards: plays[0].p, pass: false };
    }
    plays.sort((a, b) => {
        const ea = a.combo.key <= 11 ? 0 : 1;
        const eb = b.combo.key <= 11 ? 0 : 1;
        return ea - eb || b.p.length - a.p.length || a.combo.key - b.combo.key;
    });
    return { cards: plays[0].p, pass: false };
}

/** 让机器人走一步（自己处理「叫分 / 出牌 / 过牌」） */
export function botAct(room: Room, seat: number, cfg: GamesConfig): BotDecision {
    if (room.status === 'bidding') {
        bid(room, seat, botBid(room, seat, cfg), cfg);
        return { cards: null, pass: true };
    }
    const d = decide(room, seat);
    try {
        if (d.pass || !d.cards || !d.cards.length) pass(room, seat, cfg);
        else play(room, seat, d.cards, cfg);
    } catch (e) {
        if (!(e instanceof GameError)) throw e;
        // 兜底：绝不因为 AI 出错把整局卡死
        try {
            pass(room, seat, cfg);
        } catch {
            const l = lowestCard(room.hands[seat]);
            if (l !== null) play(room, seat, [l], cfg);
        }
    }
    return d;
}

/** 「提示」：给真人玩家推荐一手能压过上家的牌 */
export function hint(room: Room, seat: number): number[] | null {
    const hand = room.hands[seat];
    const target = (room.last && room.last.seat !== seat) ? room.last.combo : null;
    if (!target) {
        if (analyze(hand)) return hand;
        const plays = decompose(hand).filter((p) => analyze(p));
        if (!plays.length) return lowestCard(hand) === null ? null : [lowestCard(hand) as number];
        plays.sort((a, b) => (analyze(a) as Combo).key - (analyze(b) as Combo).key);
        return plays[0];
    }
    const cands = candidates(hand, target)
        .filter((c) => !isBombLike(c.combo))
        .sort((a, b) => a.combo.key - b.combo.key || a.cards.length - b.cards.length);
    const best = cands[0] || candidates(hand, target).sort((a, b) => a.combo.key - b.combo.key)[0];
    return best ? best.cards : null;
}
