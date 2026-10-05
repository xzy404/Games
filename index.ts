/**
 * hydro-games —— Hydro OJ 的「游戏大全」插件。
 *
 * 结构：
 *   /games              游戏列表（由 src/registry.ts 的 GAMES 生成）
 *   /games/<id>         单个游戏页（上半：游戏信息 + 匹配 + 牌桌；下半：最近对局）
 *   /games/<id>/api/*   该游戏的 JSON 接口
 *   /games/api/status   自检接口（无需登录）
 *
 * 加新游戏：在 src/registry.ts 的 GAMES 里加一项，再补 `templates/game_<id>.html`
 * 和 `public/<id>.js`，其余（路由、导航、轮询、玩法说明版式）全部复用。
 */

import { Context, PERM, Schema } from 'hydrooj';
import { DEFAULT_CONFIG, GamesConfig, getConfig, setConfig } from './src/config';
import { ensureIndexes, initDb } from './src/db';
import { registerRoutes } from './src/handler';
import { GAMES } from './src/registry';
import { VERSION } from './src/version';

export const name = 'hydro-games';

export const Config = Schema.object({
    enabled: Schema
        .boolean()
        .default(DEFAULT_CONFIG.enabled)
        .description('总开关。关闭后 /games 页面照常可看，但匹配与出牌接口会拒绝服务。可以在 系统设置 → hydro-games 里修改。'),
    botFillSeconds: Schema
        .number()
        .min(0)
        .default(DEFAULT_CONFIG.botFillSeconds)
        .description('凑不齐真人时，等待多少秒后补机器人（0 = 不补，一直等真人）。'),
    botFillCount: Schema
        .number()
        .min(0)
        .max(2)
        .default(DEFAULT_CONFIG.botFillCount)
        .description('每桌最多补几个机器人。'),
    turnTimeoutSeconds: Schema
        .number()
        .min(10)
        .default(DEFAULT_CONFIG.turnTimeoutSeconds)
        .description('出牌阶段每步限时（秒），超时自动过牌（本轮首发则自动出最小的牌）。'),
    bidTimeoutSeconds: Schema
        .number()
        .min(5)
        .default(DEFAULT_CONFIG.bidTimeoutSeconds)
        .description('叫分阶段每步限时（秒），超时视为不叫。'),
    botDelayMs: Schema
        .number()
        .min(0)
        .default(DEFAULT_CONFIG.botDelayMs)
        .description('机器人「思考」时长（毫秒），太短会显得很假。'),
    recentLimit: Schema
        .number()
        .min(1)
        .default(DEFAULT_CONFIG.recentLimit)
        .description('游戏页「最近对局」显示的条数。'),
    roomTtlMinutes: Schema
        .number()
        .min(1)
        .default(DEFAULT_CONFIG.roomTtlMinutes)
        .description('结束后的房间保留多少分钟（对局记录另有留存）。'),
    autoPlayAfterSeconds: Schema
        .number()
        .min(10)
        .default(DEFAULT_CONFIG.autoPlayAfterSeconds)
        .description('玩多久没有心跳就把座位交给机器人托管（秒）。重新打开页面会自动收回。'),
}).extra('family', 'setting_games');

/**
 * 把导航项固定到最右侧。
 *
 * `inject()` 只支持 `before`，没有 `after`；不传锚点就是 `push` —— 而 `push` 不去重，
 * 插件热重载后会留下两条一样的导航项。这里在每次注册和 app/started 时都归一化一次。
 */
function pinNavLast(): void {
    const nodes = (globalThis as any).Hydro?.ui?.nodes;
    const nav: any[] = nodes?.Nav;
    if (!Array.isArray(nav)) return;
    const mine = nav.filter((i) => i && i.name === 'game_main');
    if (mine.length === 1 && nav[nav.length - 1] === mine[0]) return;
    const rest = nav.filter((i) => i && i.name !== 'game_main');
    if (mine.length) rest.push(mine[mine.length - 1]);
    nodes.Nav = rest;
}

export function apply(ctx: Context, config?: Partial<GamesConfig>): void {
    const cfg = setConfig(config);
    const logger = ctx.logger ? ctx.logger('hydro-games') : (console as any);

    // 数据层：等 db 服务就绪再初始化
    ctx.inject(['db'], (c: any) => {
        initDb(c);
        ensureIndexes().catch((e: Error) => logger.error('ensureIndexes failed: %s', e.message));
    });

    registerRoutes(ctx);

    /**
     * 样式注入。
     *
     * 走 server layer 而不是覆盖模板，是为了不被 Hydro 升级搞坏；注入到每一页
     * 而不是只注入 /games，是因为 pjax 导航只在 `#panel` 里换内容，从首页点进
     * 游戏页时不会重新加载 <head>，只注入一处会「点进来没样式」。
     */
    ctx.inject(['server'], (c: any) => {
        c.server.addServerLayer('hydro-games-assets', async (koa: any, next: any) => {
            await next();
            if (typeof koa.body !== 'string') return;
            const type = `${koa.response?.type || ''}`;
            if (type && !type.includes('html')) return;
            if (koa.body.includes('/games.css')) return;
            const tag = `<link rel="stylesheet" href="/games.css?v=${VERSION}">`;
            const i = koa.body.lastIndexOf('</head>');
            koa.body = i >= 0 ? koa.body.slice(0, i) + tag + koa.body.slice(i) : `${tag}${koa.body}`;
        });
    });

    // 导航：`ctx.injectUI` 走 mixin，万一没挂上就退回全局的 inject
    const injectFn: any = (ctx as any).injectUI || (globalThis as any).Hydro?.ui?.inject;
    if (typeof injectFn === 'function') injectFn('Nav', 'game_main', { prefix: 'game' }, PERM.PERM_VIEW);
    pinNavLast();
    ctx.on('app/started', () => pinNavLast());

    // 周期推进：匹配、机器人、超时、清理
    let ticking = false;
    let ticks = 0;
    const timer = setInterval(async () => {
        if (ticking) return;
        ticking = true;
        ticks++;
        try {
            const cur = getConfig();
            if (!cur.enabled) return;
            for (const g of GAMES) {
                // eslint-disable-next-line no-await-in-loop
                await g.tick(cur);
            }
            if (ticks % 30 === 0) {
                for (const g of GAMES) {
                    // eslint-disable-next-line no-await-in-loop
                    await g.cleanup(cur);
                }
            }
        } catch (e) {
            logger.error('tick failed: %s', (e as Error).message);
        } finally {
            ticking = false;
        }
    }, 2000);
    ctx.effect(() => () => clearInterval(timer));

    logger.info('hydro-games v%s loaded (enabled=%s, games=%s)',
        VERSION, cfg.enabled, GAMES.map((g) => g.meta.id).join(','));
}

// 自检脚本与离线测试要用的出口（页面上不暴露任何东西）
export { GAMES, getGame } from './src/registry';
export { getConfig, setConfig, DEFAULT_CONFIG } from './src/config';
export { VERSION } from './src/version';
export type { GameMeta, GameModule } from './src/registry';
