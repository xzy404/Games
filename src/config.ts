/**
 * 插件配置的单一来源。
 *
 * 规则：`Schema` 的默认值必须引用这里的常量，不要再写一遍字面量
 * （skill 里那条「一个事实只能有一个读取点」）。
 */

export interface GamesConfig {
    /** 总开关：关掉后 /games 页面仍然可访问，但所有匹配/出牌接口拒绝服务 */
    enabled: boolean;
    /** 排队等待多少秒后自动补机器人（0 = 永不补机器人，只能等真人） */
    botFillSeconds: number;
    /** 真人凑不齐时，每桌补几个机器人（1~2） */
    botFillCount: number;
    /** 出牌阶段每步限时（秒） */
    turnTimeoutSeconds: number;
    /** 叫分阶段每步限时（秒） */
    bidTimeoutSeconds: number;
    /** 机器人思考时间（毫秒） */
    botDelayMs: number;
    /** 「最近对局」条数 */
    recentLimit: number;
    /** 一局结束后房间保留多久（分钟） */
    roomTtlMinutes: number;
    /** 玩多久没有心跳就把座位交给机器人托管（秒） */
    autoPlayAfterSeconds: number;
}

export const DEFAULT_CONFIG: GamesConfig = {
    enabled: true,
    botFillSeconds: 20,
    botFillCount: 2,
    turnTimeoutSeconds: 60,
    bidTimeoutSeconds: 30,
    botDelayMs: 1200,
    recentLimit: 20,
    roomTtlMinutes: 30,
    autoPlayAfterSeconds: 30,
};

let current: GamesConfig = { ...DEFAULT_CONFIG };

export function setConfig(raw?: Partial<GamesConfig> | null): GamesConfig {
    // 每个字段都单独兜底：老站点在系统设置里存过的值会覆盖 schema 默认值，
    // 所以这里不能假设 raw 一定是完整的。
    const out: GamesConfig = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof GamesConfig)[]) {
        const v = (raw || {})[key];
        if (v === undefined || v === null) continue;
        if (typeof DEFAULT_CONFIG[key] === 'number') {
            const n = Number(v);
            if (Number.isFinite(n)) out[key] = n as never;
        } else if (typeof DEFAULT_CONFIG[key] === 'boolean') {
            out[key] = (v === true || v === 'true' || v === 1) as never;
        }
    }
    current = out;
    return current;
}

export function getConfig(): GamesConfig {
    return current;
}
