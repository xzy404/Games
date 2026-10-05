import type { GamesConfig } from './config';

export interface GameMeta {
    /** 短 id，用于 URL：/games/<id> */
    id: string;
    /** 路由名（同时是导航项的名字，也是 i18n 的 key） */
    route: string;
    /**
     * 页面模板。**大厅页与房间页共用同一个文件**，靠上下文里的 `inRoomPage` 分岔。
     * 不给房间页单独开模板是刻意的：部署时多个新增文件就多一次漏传的机会，
     * 而漏传的后果是运行时 500（`Cannot get template ...`），排查起来还很绕。
     */
    template: string;
    /** 牌桌区域的模板（由页面模板 include） */
    boardTemplate: string;
    /** addon `public/` 下的客户端脚本 */
    script: string;
    title: string;
    tagline: string;
    players: string;
    /** 列表页上的大字符 */
    glyph: string;
    accent: string;
    rules: string[];
    tips: string[];
    /**
     * 是否有「房间页」：`/games/<id>/room/:rid`。
     * 有对局概念的游戏（斗地主这类）打开它，通用层会额外注册这条路由，
     * 并且给模板上下文传 `inRoomPage: true`（模板自己决定房间页要不要藏起大厅那几块）。
     */
    roomPage?: boolean;
}

export interface GameSummary {
    rooms: number;
    queue: number;
    online: number;
}

export interface GameModule {
    meta: GameMeta;
    /** 该游戏自己的路由（页面路由由通用层统一注册） */
    registerRoutes(ctx: any, cfg: GamesConfig): void;
    /** 页面首屏数据（服务端渲染，避免首屏还要请求一次） */
    pageData(handler: any): Promise<Record<string, any>>;
    /** 周期推进（匹配、机器人、超时） */
    tick(cfg: GamesConfig): Promise<void>;
    /** 过期房间/队列清理 */
    cleanup(cfg: GamesConfig): Promise<void>;
    status(domainId: string): Promise<Record<string, any>>;
    summary(domainId: string): Promise<GameSummary>;
}

// 注册表：加新游戏只要往这里加一项
// eslint-disable-next-line import/no-cycle
import { ddzModule } from './games/ddz';
// eslint-disable-next-line import/no-cycle
import { unoModule } from './games/uno';

export const GAMES: GameModule[] = [ddzModule, unoModule];

export function getGame(id: string): GameModule | undefined {
    return GAMES.find((g) => g.meta.id === id);
}
