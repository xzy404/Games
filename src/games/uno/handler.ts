/**
 * UNO 的 HTTP 接口。
 *
 * 路径参数 `:op` 只表示端点种类（state / recent / action）；
 * 具体动作放在请求体/查询串的 `act` 字段里 —— 两者不能同名，
 * 因为 base layer 合并参数时 `{ ...params, ...query, ...body }`，body 会盖掉路径参数。
 */

import { Handler } from 'hydrooj';
import { getConfig } from '../../config';
import { COLORS, DECK_SIZE, NO_COLOR } from './cards';
import { hint } from './bot';
import { GameError, draw, pass, play } from './engine';
import { isAutoSeat } from '../shared';
import {
    dequeue, findActiveRoom, findRecentRoom, getStat, heartbeat, isBotUid, joinAndStart,
    loadRoom, matchQueue, queueInfo, recentMatches, startPractice, withRoom,
} from './model';
import { matchView, roomView } from './view';
import type { Room } from './types';

export const GID = 'uno';

/** 最近对局的硬上限：列表只保留这么多条，配置里调大也没用 */
export const RECENT_HARD_LIMIT = 20;

function domainOf(h: any): string {
    return (h.domain && h.domain._id) || h.args.domainId || 'system';
}

export class UnoApiHandler extends Handler {
    noCheckPermView = true;

    async get() { await this.dispatch(); }

    async post() { await this.dispatch(); }

    private reply(body: any): void {
        this.response.addHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        this.response.body = body;
    }

    private async dispatch(): Promise<void> {
        const op = String(this.args.op || '');
        const domainId = domainOf(this);
        try {
            if (op === 'state') return await this.opState(domainId);
            if (op === 'recent') return await this.opRecent(domainId);
            if (op === 'action') return await this.opAction(domainId);
            return this.reply({ ok: false, error: `未知接口：${op || '(空)'}` });
        } catch (e) {
            if (e instanceof GameError) {
                this.reply({ ok: false, error: e.message });
                return;
            }
            throw e;
        }
    }

    private uid(): number {
        return this.user._id || 0;
    }

    private requireLogin(): number {
        const uid = this.uid();
        if (isBotUid(uid)) throw new GameError('请先登录再开始游戏');
        return uid;
    }

    private async currentRoom(domainId: string, uid: number): Promise<Room | null> {
        const active = await findActiveRoom(domainId, uid);
        if (active) return active;
        return findRecentRoom(domainId, uid);
    }

    private async lobby(domainId: string, uid: number) {
        const cfg = getConfig();
        const [q, stat] = await Promise.all([
            queueInfo(domainId, uid),
            getStat(domainId, uid),
        ]);
        return {
            queue: {
                size: q.size,
                waiters: q.waiters,
                mine: !!q.mine,
                waited: q.mine ? Math.round((Date.now() - q.mine.joinedAt) / 1000) : 0,
            },
            stat,
            config: {
                enabled: cfg.enabled,
                botFillSeconds: cfg.botFillSeconds,
                turnTimeoutSeconds: cfg.turnTimeoutSeconds,
            },
        };
    }

    private async opState(domainId: string): Promise<void> {
        const uid = this.uid();
        const cfg = getConfig();
        // 房间页会带上 room=<房间号>：看指定的那一桌（可能是别人已结束的对局记录）。
        // 大厅页不带，由下面那段兜底决定「当前该看哪一桌」。
        const code = String(this.args.room || '');
        let asked = code ? await loadRoom(code) : null;
        if (asked && (asked.gid !== GID || asked.domainId !== domainId)) asked = null;

        // 先取 lobby：排队状态参与「要不要回退到上一局」的判断
        const lobby = await this.lobby(domainId, uid);

        // 没指定房间号时的兜底，按优先级：
        //   1. 我正在进行中的那一桌
        //   2. 都没有、并且**没在排队** → 10 分钟内刚结束的那一局（刷新后还能看结果）
        // 指定了房间号却找不到（写错、已被清理）：就当没有，不要悄悄换成「你在的那一桌」——
        // 那样地址栏写着 A、画面里是 B，最让人摸不着头脑。
        // 正在排队的人也一律不给旧房间：前端一看到「有房间」就会去显示那一局的状态，
        // 把排队人数和补机器人的倒计时挡掉。
        const room = asked || ((code || lobby.queue.mine) ? null : await this.currentRoom(domainId, uid));
        let view: any = null;
        if (room) {
            const seat = room.seats.find((s) => s.uid === uid && !s.bot);
            // 心跳不用每次都写库：5 秒一次足够判断掉线托管。
            // 主动托管的人不发心跳 —— 他的 auto 由自己控制，心跳只会白写一次库。
            if (seat && room.status !== 'finished' && !seat.manualAuto
                && (seat.auto || Date.now() - seat.lastSeen > 5000)) {
                await withRoom(room._id, (r) => { heartbeat(r, uid); });
                view = roomView(await findActiveRoom(domainId, uid) || room, uid);
            } else {
                view = roomView(room, uid);
            }
        }
        // 队列凑够 4 个真人就顺手开一局（秒开，不用等下一轮 tick）
        if (lobby.queue.size >= 4) {
            const created = await matchQueue(domainId, cfg);
            if (created.length) return await this.opState(domainId);
        }
        this.reply({
            ok: true,
            serverNow: Date.now(),
            room: view,
            // 必须嵌在 lobby 里：前端读的是 data.lobby.{queue,stat,config}，
            // 平铺到顶层会让大厅整块渲染不出来
            lobby,
        });
    }

    private async opRecent(domainId: string): Promise<void> {
        const cfg = getConfig();
        // 硬上限 20 条：最近对局是给人扫一眼的，再长也用不上，还得拖慢页面
        const limit = Math.max(1, Math.min(RECENT_HARD_LIMIT, Number(this.args.limit) || cfg.recentLimit));
        const list = await recentMatches(domainId, limit);
        this.reply({ ok: true, recent: list.map((m) => matchView(m, this.uid())) });
    }

    private async opAction(domainId: string): Promise<void> {
        const cfg = getConfig();
        const uid = this.uid();
        const op = String(this.args.act || '');
        const code = String(this.args.room || '');
        if (!cfg.enabled) throw new GameError('游戏功能已被管理员关闭');

        if (op === 'join') {
            const u = this.requireLogin();
            const room = await joinAndStart(domainId, u, this.user.uname, cfg);
            const lobby = await this.lobby(domainId, u);
            this.reply({
                ok: true, room: room ? roomView(room, u) : null, lobby,
            });
            return;
        }
        if (op === 'practice') {
            const u = this.requireLogin();
            const { room } = await startPractice(domainId, u, this.user.uname, cfg);
            const lobby = await this.lobby(domainId, u);
            this.reply({
                ok: true, room: room ? roomView(room, u) : null, lobby,
            });
            return;
        }
        if (op === 'leave') {
            const u = this.requireLogin();
            await dequeue(domainId, u);
            const lobby = await this.lobby(domainId, u);
            this.reply({ ok: true, room: null, lobby });
            return;
        }

        // 房间号客户端可以传，但**不是必须的**：「我在哪个房间」本来就是服务端知道的事。
        // 两个来源都认 —— 客户端手里的号可能是空的（旧版资源被缓存接着用），
        // 也可能已经过期（刷新后只剩「最近对局」）。
        const u = this.requireLogin();
        let roomId = code;
        if (!roomId) {
            const mine = await findActiveRoom(domainId, u) || await findRecentRoom(domainId, u);
            if (!mine) throw new GameError('你当前没有正在进行的对局');
            roomId = mine._id;
        }
        const result = await withRoom(roomId, (room) => {
            const seat = room.seats.findIndex((s) => s.uid === u && !s.bot);
            if (seat < 0) throw new GameError('你不在这个房间里');
            heartbeat(room, u);

            // 托管中不许自己动手：操作权已经交给机器人，两边同时出牌只会打架。
            //
            // 这一行**必须在 heartbeat 之后**：掉线托管的座位一回来，heartbeat 就把 auto
            // 解除了（`if (s.auto && !s.manualAuto) s.auto = false`），那种情况下应当允许
            // 他立刻自己出牌。而主动托管（manualAuto）不会被心跳解除，所以照样被拦下。
            //
            // 客户端已经把出牌区收起了，这里是给「界面还停在旧帧 / 手快点了两下」兜底 ——
            // 否则玩家会收到一句「这张牌现在打不出去」的误导提示（问题不在牌上）。
            if (op === 'play' || op === 'draw' || op === 'pass') {
                if (isAutoSeat(room, seat)) throw new GameError('正在托管中，先点「取消托管」再自己出牌');
            }

            switch (op) {
                case 'play':
                    play(room, seat, this.parseCard(), this.parseColor(), cfg);
                    break;
                case 'draw':
                    draw(room, seat, cfg);
                    break;
                case 'pass':
                    pass(room, seat, cfg);
                    break;
                case 'hint': {
                    // 托管中不给提示。提示**会替玩家选中一张牌**，而托管里的手牌一张都不该
                    // 被选起来（否则画面上就是唯一一张亮着的牌，和「已托管」自相矛盾）。
                    // 这里不抛错：提示只是「读」，不是「动手」，答「没有可提示的」更贴切。
                    if (isAutoSeat(room, seat)) return { hint: null };
                    const card = hint(room, seat);
                    return { hint: card === null ? null : [card] };
                }
                case 'surrender':
                    room.seats[seat].auto = true;
                    room.rev++;
                    room.updatedAt = Date.now();
                    break;
                case 'auto': {
                    const off = this.args.value === false || this.args.value === 'false' || this.args.value === 0;
                    // 玩家主动托管/取消：manualAuto 跟着走，这样它不会被心跳解除
                    const on = room.status !== 'finished' && !off;
                    const was = room.seats[seat].auto;
                    room.seats[seat].auto = on;
                    room.seats[seat].manualAuto = on;
                    if (!on) heartbeat(room, u);
                    // 托管与否是一处**画面变化**（牌亮暗、出牌区显隐、提示文案）。
                    // 别的客户端按 rev 变化才重画，所以这里必须抬 rev —— 否则另一个标签页
                    // 会一直停在使用者动手之前的画面上，看着就像「托管了牌还亮着」。
                    if (was !== on) room.rev++;
                    room.updatedAt = Date.now();
                    break;
                }
                case 'heartbeat':
                    break;
                default:
                    throw new GameError(`未知操作：${op || '(空)'}`);
            }
            return {};
        });
        const room = await findActiveRoom(domainId, u) || await findRecentRoom(domainId, u);
        const lobby = await this.lobby(domainId, u);
        this.reply({
            ok: true, ...result, room: room ? roomView(room, u) : null, lobby,
        });
    }

    private parseCard(): number {
        const raw = this.args.card;
        if (raw === undefined || raw === null || raw === '') throw new GameError('请选择要出的牌');
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n >= DECK_SIZE) throw new GameError('出的牌格式不对');
        return n;
    }

    /** 只有打万能牌时才需要，其余情况返回 NO_COLOR（-1） */
    private parseColor(): number {
        const raw = this.args.color;
        if (raw === undefined || raw === null || raw === '') return NO_COLOR;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n >= COLORS) throw new GameError('颜色只能是 0/1/2/3');
        return n;
    }
}
