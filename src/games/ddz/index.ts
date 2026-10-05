import { PERM } from 'hydrooj';
import type { GamesConfig } from '../../config';
import { getConfig } from '../../config';
import { COLL, coll } from '../../db';
import type { GameModule } from '../../registry';
import { RANK_TEXT, SUIT_TEXT } from './cards';
import { DdzApiHandler, RECENT_HARD_LIMIT } from './handler';
import { DDZ_META } from './meta';
import {
    cleanup, countActive, getStat, loadRoom,
    queueInfo, recentMatches, roomStats, roomTickAll, zeroStat,
} from './model';
import { matchView, roomView } from './view';

const GID = 'ddz';

function domainOf(handler: any): string {
    return (handler.domain && handler.domain._id) || handler.args.domainId || 'system';
}

export const ddzModule: GameModule = {
    meta: DDZ_META,

    // 列表页的「进行中桌数 / 排队人数」就是靠这个
    summary: roomStats,

    registerRoutes(ctx: any) {
        ctx.Route('game_ddz_api', '/games/ddz/api/:op', DdzApiHandler, PERM.PERM_VIEW);
    },

    async pageData(handler: any) {
        const cfg = getConfig();
        const domainId = domainOf(handler);
        const uid = handler.user._id || 0;
        // 房间页（/games/ddz/room/<房间号>）会带上 rid：看指定的那一桌，
        // 可能是自己正在打的，也可能是别人的对局记录（那就是观战视图）。
        const rid = String(handler.args.rid || '').trim();

        const gdata = {
            gid: GID,
            api: `/games/${GID}/api`,
            script: DDZ_META.script,
            loggedIn: !!uid,
            recentLimit: cfg.recentLimit,
            // 牌面文案由服务端下发，前端不再自己写一份点数字表
            cardFace: { ranks: RANK_TEXT, suits: SUIT_TEXT },
        };

        if (rid) {
            // 房间页只要牌桌：队列、战绩、最近对局、在线人数一个都不查。
            // 这是玩家打开次数最多的页面，省掉这几条查询不亏。
            const asked = await loadRoom(rid);
            // 只认本游戏、本域的房间，避免用房间号串到别的域去
            const room = (asked && asked.gid === GID && asked.domainId === domainId) ? asked : null;
            return {
                game: DDZ_META,
                // 形状保持一致（前端读 `lobby.config` 拿超时秒数），但内容不查库
                lobby: {
                    queue: { size: 0, waiters: [], mine: false, waited: 0 },
                    stat: zeroStat(),
                    config: {
                        enabled: cfg.enabled,
                        botFillSeconds: cfg.botFillSeconds,
                        turnTimeoutSeconds: cfg.turnTimeoutSeconds,
                        bidTimeoutSeconds: cfg.bidTimeoutSeconds,
                    },
                    summary: { rooms: 0, queue: 0, online: 0 },
                },
                recent: [],
                room: room ? roomView(room, uid) : null,
                gdata,
            };
        }

        const [queue, stat, recent] = await Promise.all([
            queueInfo(domainId, uid),
            getStat(domainId, uid),
            recentMatches(domainId, Math.min(RECENT_HARD_LIMIT, cfg.recentLimit)),
        ]);
        // 大厅页永远不给房间 —— 就算你正在局中，牌桌也只在 /games/ddz/room/<房间号> 上。
        const sum = await roomStats(domainId);
        return {
            game: DDZ_META,
            lobby: {
                queue: {
                    size: queue.size,
                    waiters: queue.waiters,
                    mine: !!queue.mine,
                    waited: queue.mine ? Math.round((Date.now() - queue.mine.joinedAt) / 1000) : 0,
                },
                stat,
                config: {
                    enabled: cfg.enabled,
                    botFillSeconds: cfg.botFillSeconds,
                    turnTimeoutSeconds: cfg.turnTimeoutSeconds,
                    bidTimeoutSeconds: cfg.bidTimeoutSeconds,
                },
                summary: sum,
            },
            recent: recent.map((m) => matchView(m, uid)),
            room: null,
            gdata,
        };
    },

    async tick(cfg: GamesConfig) {
        // roomTickAll 内部已经顺带跑过一次匹配，这里不再重复
        await roomTickAll(cfg);
    },

    async cleanup(cfg: GamesConfig) {
        await cleanup(cfg);
    },

    async status(domainId: string) {
        const cfg = getConfig();
        const [rooms, waiting, matches] = await Promise.all([
            countActive(GID, domainId),
            coll(COLL.queue).countDocuments({ gid: GID, domainId }),
            coll(COLL.match).countDocuments({ gid: GID, domainId }),
        ]);
        return {
            gid: GID,
            title: DDZ_META.title,
            rooms,
            waiting,
            matches,
            botFillSeconds: cfg.botFillSeconds,
            turnTimeoutSeconds: cfg.turnTimeoutSeconds,
        };
    },
};
