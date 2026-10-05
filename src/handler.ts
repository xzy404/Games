/**
 * 通用路由：游戏大全列表页 + 自检接口 + 「每个游戏一个页面」的自动注册。
 *
 * 加新游戏不需要改这个文件：往 `src/registry.ts` 的 `GAMES` 里加一项，
 * 再补 `templates/game_<id>.html` 与 `public/<id>.js` 就行。
 */

import { Handler, PERM } from 'hydrooj';
import { getConfig } from './config';
import { GAMES, type GameModule } from './registry';
import { VERSION } from './version';

function domainOf(handler: any): string {
    return (handler.domain && handler.domain._id) || handler.args.domainId || 'system';
}

export class GameMainHandler extends Handler {
    async get(): Promise<void> {
        const domainId = domainOf(this);
        const cfg = getConfig();
        const games = await Promise.all(GAMES.map(async (g) => ({
            ...g.meta,
            summary: await g.summary(domainId),
        })));
        this.response.body = {
            games,
            enabled: cfg.enabled,
            botFillSeconds: cfg.botFillSeconds,
            loggedIn: !!this.user._id,
            assetVersion: VERSION,
        };
        this.response.template = 'game_main.html';
    }
}

/**
 * 无需登录的自检接口。
 * 部署脚本靠它确认插件真的挂载了、版本对不对、数据库通不通。
 */
export class GameStatusHandler extends Handler {
    noCheckPermView = true;

    async get(): Promise<void> {
        const cfg = getConfig();
        const domainId = domainOf(this);
        const games: Record<string, any>[] = [];
        for (const g of GAMES) {
            // eslint-disable-next-line no-await-in-loop
            games.push(await g.status(domainId));
        }
        this.response.addHeader('Cache-Control', 'no-store');
        this.response.body = {
            ok: true,
            plugin: 'hydro-games',
            version: VERSION,
            domainId,
            enabled: cfg.enabled,
            config: cfg,
            games,
        };
    }
}

function makePageHandler(g: GameModule): typeof Handler {
    const H = class extends Handler {
        async get(): Promise<void> {
            // 有没有带房间号决定这是大厅页还是房间页 —— 同一个 handler 两种形态
            const inRoom = !!String(this.args.rid || '').trim();
            const body = await g.pageData(this);
            this.response.body = {
                ...body,
                game: g.meta,
                inRoomPage: inRoom,
                assetVersion: VERSION,
                // 前端要的那份数据。模板里直接 {{ hgData|json|jsesc|safe }}，
                // 首屏不再额外发一次请求 —— 接口挂了也不会让页面看起来「没有数据」。
                hgData: {
                    game: {
                        id: g.meta.id,
                        title: g.meta.title,
                        tagline: g.meta.tagline,
                        players: g.meta.players,
                        accent: g.meta.accent,
                        boardTemplate: g.meta.boardTemplate,
                        script: g.meta.script,
                    },
                    lobby: body.lobby,
                    recent: body.recent,
                    room: body.room,
                    // 大厅页不画牌桌（就算你正在局中，牌桌在 /room/<房间号> 那边）
                    inRoom,
                    // 房间页请求的房间号。房间不存在时 room 是 null，前端得靠它继续问，
                    // 否则服务端会回退到「你在的那一桌」，画面和地址就对不上了。
                    rid: String(this.args.rid || ''),
                    ...body.gdata,
                },
            };
            // 大厅页与房间页是同一个模板，模板靠 `inRoomPage` 分岔。
            this.response.template = g.meta.template;
        }
    };
    // 路由名来自类名，重名会被 server 警告并互相覆盖 —— 给每个游戏一个独立的类名
    Object.defineProperty(H, 'name', { value: `Game${g.meta.id.toUpperCase()}PageHandler` });
    return H;
}

export function registerRoutes(ctx: any): void {
    const cfg = getConfig();
    ctx.Route('game_main', '/games', GameMainHandler, PERM.PERM_VIEW);
    ctx.Route('game_status', '/games/api/status', GameStatusHandler);
    for (const g of GAMES) {
        const H = makePageHandler(g);
        ctx.Route(g.meta.route, `/games/${g.meta.id}`, H, PERM.PERM_VIEW);
        // 房间页：同一个 handler，靠 args.rid 载入指定那一桌。
        // 路由名带 _room 后缀，导航高亮仍然靠 page_name.startsWith('game_<id>') 命中。
        if (g.meta.roomPage) {
            ctx.Route(`${g.meta.route}_room`, `/games/${g.meta.id}/room/:rid`, H, PERM.PERM_VIEW);
        }
        g.registerRoutes(ctx, cfg);
    }
}
