# hydro-games

给 Hydro OJ 加的「游戏大全」插件：

| 路由 | 内容 |
| --- | --- |
| `/games` | 游戏列表，卡片式，每张卡带「进行中桌数 / 排队人数 / 在线人数」 |
| `/games/<id>` | 游戏大厅页。游戏信息 + 匹配面板 + 我的战绩 + 玩法说明 + 最近对局。**不画牌桌**，牌桌只属于房间页 |
| `/games/<id>/room/:rid` | 房间页：**只有牌桌**。回到进行中的对局，或查看已结束对局的记录（`meta.roomPage` 为真的游戏才有） |
| `/games/<id>/api/*` | 该游戏的 JSON 接口 |
| `/games/api/status` | 自检接口，无需登录，部署后先打这个确认插件真的挂上了 |

当前内置两个游戏：

- **斗地主**（`/games/ddz`）—— 3 人桌，叫分抢地主。视觉与交互参考 <https://qoj.ac/games/doudizhu>
- **UNO**（`/games/uno`）—— 4 人桌，同色同面接牌

线上环境（开发时以此为准）：

- OJ：<https://oj.xzy404.top>
- Hydro 后端 `v5.0.4`，前端 `@hydrooj/ui-default@4.58.4`（页面上的 `theme-4.58.4.css` / `hydro-4.58.4.js`）
- 后端与前端版本号**互相独立**，改插件时看前端那个。

---

## 目录结构

```
index.ts                    插件入口：Config schema / 路由注册 / 样式注入层 / 2 秒心跳
src/
  config.ts                 配置的单一来源（DEFAULT_CONFIG + 逐字段兜底）
  db.ts                     Mongo 集合名与索引
  registry.ts               ★ 游戏注册表 GAMES —— 加游戏只动这里
  handler.ts                通用路由：/games、/games/api/status、每个游戏一个页面类（+ 房间页）
  util.ts                   小工具（含按 key 串行化的互斥锁 withLock）
  version.ts
  games/shared.ts           ★ 游戏之间共用的数据层：房间读写与加锁、匹配队列、对局记录、战绩、
                              心跳/托管、超时推进骨架。**只放与玩法无关的东西**，不做任何规则判断
  games/ddz/                斗地主
    cards.ts                牌的编码与发牌（纯函数）
    combo.ts                牌型识别 analyze() 与比较 beats()
    engine.ts               状态机（叫分/出牌/超时/结算，纯函数，不碰数据库）
    bot.ts                  机器人决策
    model.ts                数据层：把 shared 绑到 ddz 上（建桌 / 写记录 / 推进钩子）
    view.ts                 对外视图（**别人的手牌永远不出门**）
    handler.ts              HTTP 接口
    meta.ts                 列表页与页面上的展示信息、玩法说明
    index.ts                GameModule 实现（把上面这些拼成注册表要的形状）
  games/uno/                UNO —— 目录结构与 ddz 一一对应
    cards.ts                108 张牌的编码、发牌、罚分
    engine.ts               状态机（出牌 / 摸牌 / 过 / 跳禁反转+2+4 / 结算）
    bot.ts                  机器人决策（与「提示」共用同一套选牌逻辑）
    model.ts / view.ts / handler.ts / meta.ts / index.ts
templates/
  game_main.html            列表页
  game_ddz.html / game_uno.html       游戏页（大厅页与房间页共用一份，靠 inRoomPage 分岔）
  game/partials/ddz_board.html        斗地主牌桌骨架（被游戏页 include）
  game/partials/uno_board.html        UNO 牌桌骨架
public/
  games.css                 全部样式（类名统一 .hg- 前缀）
  ddz.js / uno.js           各游戏前端（**不含任何规则判定**）
locales/*.yaml              文案
tools/
  pack.js                   打包脚本（自己写 ZIP 容器，零依赖）
  deploy.js                 SSH 部署/诊断（凭据走 HG_SSH_PASS 环境变量，不落盘）
  verify.sh                 部署后验证（文件哈希、静态资源字节数、索引、路由、日志）
  diag-bots.js              机器人行为诊断（**不参与打包、也不产生断言**，只把体感问题变成数字）
tests/
  run.js                    离线测试（见下）
  fetch-ui-templates.sh     拉取官方模板/语言包作测试夹具
```

---

## 加一个新游戏

公共层里**没有**任何针对具体游戏的 `if`。加新游戏就是「加一项 + 两个文件」：

1. 建 `src/games/<id>/`，照 `games/ddz/` 或 `games/uno/` 的结构写。至少要导出这几样：
   - `meta.ts` → `GameMeta`（`id` / `route: 'game_<id>'` / `template` / `boardTemplate` / `script` / 文案）。
     有「对局/房间」概念的把 `roomPage: true` 打开，通用层会自动多注册一条
     `/games/<id>/room/:rid`，`pageData` 里读 `handler.args.rid` 决定载入哪一桌，
     模板上下文里拿到 `inRoomPage: true` —— **大厅页与房间页共用同一个模板**，
     用 `{% if inRoomPage %}` 分岔，别再给房间页单开一个文件（见下面「实现要点」）
   - `index.ts` → `GameModule`，必须实现 **全部** 6 个方法：
     `registerRoutes` / `pageData` / `tick` / `cleanup` / `status` / `summary`
     （`esbuild` 只剥类型不做检查，漏实现一个不会编译报错 —— 测试里的「注册表契约」一节就是专门拦这个的）
2. 在 `src/registry.ts` 的 `GAMES` 数组里加一项。
3. 补 `templates/game_<id>.html` 和 `public/<id>.js`（各一个，房间页不另开文件）。
4. 在 `locales/zh.yaml`（和 `en.yaml`）里加 `'game_<id>': 显示名`。

导航、路由、轮询、页面版式、样式注入都会自动带上，不用改 `index.ts` 和 `src/handler.ts`。

约定：

- 路由名必须是 `game_<id>` —— 测试里有断言钉着（`page_name` 与导航 i18n key 都依赖它）。
- `boardTemplate` 用 `game/partials/<id>_board.html`，页面模板用 `{% include game.boardTemplate %}`。
- 前端脚本里**不要写规则判定**。合法性由服务端唯一决定，否则规则会有两份实现并且慢慢不一致。
  UNO 更进一步：服务端连「你手里哪些牌现在能打」都算好了（`room.playable`），前端只负责把其余的画灰。
- 共用的东西放 `src/games/shared.ts`，**判断标准是「这段代码里有没有提到玩法」**。
  提到玩法的（发牌、什么叫合法、机器人怎么出）留在各游戏里；没提到的（房间读写与加锁、匹配队列、
  对局记录、战绩、托管、推进骨架）一律进共享层。共享层不做任何规则判断。
- 页面右上角要展示「游戏信息」的，把数据放进 `pageData()` 返回的 `lobby` / `gdada` 里即可。

---

## 游戏之间共用的那一层（`src/games/shared.ts`）

这是第二个游戏（UNO）加进来时才抽出来的。**判断标准只有一条：这段代码里有没有提到玩法。**
「房间的读写与加锁」「匹配队列」「对局记录」「战绩」「心跳与托管」「到点了该谁动」
全都与玩法无关，于是搬进 `shared.ts`；「牌怎么发、什么算合法、机器人怎么出」留在各游戏里。
一条硬规矩：**共享层不做任何规则判断。**

```ts
import * as S from '../shared';

// 1) 房间仓库：落库方式在创建时绑好，调用点保持 withRoom(id, fn) 这一种写法
const repo = S.createRoomRepo<Room>({
    gid: 'uno',
    async persist(room, save) {          // 可选：默认只是 replaceOne
        if (room.status === 'finished' && !room.recorded) {
            room.recorded = true;        // 先落库再写记录，中途报错也不会重复入库
            await save(room);
            await recordFinish(room);
            return;
        }
        await save(room);
    },
});
export const loadRoom = repo.load;
export const withRoom = repo.withRoom;

// 2) 匹配：只要告诉它「一桌几个座位」和「怎么建桌」
const SPEC: S.MatchSpec<Room> = { gid: 'uno', seats: SEATS, build };
export const joinAndStart = (domainId, uid, uname, cfg) => S.joinAndStart(SPEC, domainId, uid, uname, cfg);

// 3) 战绩：零值由各游戏定义，形状由共享层保证一致
export const STAT_FIELDS = ['games', 'wins', 'score', 'best'] as const;
export const zeroStat = () => S.zeroStat(STAT_FIELDS);

// 4) 推进：共享层管「什么时候该谁动」，各游戏只提供两个钩子
const HOOKS: S.AdvanceHooks<Room> = {
    botAct(room, seat, cfg) { botAct(room, seat, cfg); },
    timeoutMove(room, cfg) { timeoutMove(room, cfg); },
};
export const roomTickAll = (cfg) => S.tickRooms(repo, cfg, HOOKS);
```

几条容易踩的：

- **`tickRooms` 落库必须走 `repo.persist`，不能直接 `replaceOne`。** 一局就是在这一步结束的，
  结算记录（对局记录、战绩）挂在 `persist` 上；绕过它会出现「牌桌显示已结束、大厅却查不到这一局」
  这种半截状态。所以它收的是**房间仓库**而不是 `gid`。
- **托管是两态**（`auto` + `manualAuto`），`heartbeat()` 里必须有 `!manualAuto` 这个判断，
  否则玩家自己点的托管每 1.3 秒被心跳解除一次，表现就是「每走一步托管就掉」。
- **`botFillSeconds <= 0` 是「永不补机器人」。** 判断要写成 `cfg.botFillSeconds > 0 && waited >= ...`，
  只比较 `waited >= cfg.botFillSeconds` 的话 0 会变成「第一秒就补」—— 和配置说明正好相反。
- **客户端不要自己算「哪张牌能出」。** 服务端把 `playable: number[]` 一起下发，前端只负责画灰。
  这样「什么算合法」永远只有一份实现。
- **托管要在「五个地方」同时生效，少一个就会出现自相矛盾的画面**（线上报的「托管了牌还亮着」）：
  ① 服务端按 `canAct = myTurn && !isAutoSeat(...)` 收口**所有可操作字段**（`playable` / `canPass` /
  `drawnCard`）；② 客户端**先**算 `auto` 再画手牌；③ 进托管清掉选中态；④ 接口层拦下 `play`/`draw`/`pass`
  （`heartbeat` **之后**拦，否则掉线托管的人回不来）；⑤ 「提示」这条路 —— 它会在前端**替玩家选中一张牌**，
  所以托管时服务端回 `hint: null`、客户端也不应用。
  客户端的四个调用点统一走 `selfAuto()`，别再各写各的 `room.seats[room.seat].auto`。
- **`rev` 是「重绘契约」**：客户端只在 `rev` 变化时重画。handler 层改了 `roomView` 输出
  （切换托管、心跳解除掉线托管）就必须抬 `rev`，否则**另一个标签页**会一直停在旧画面上。
- **引擎里「上一手是我自己打的」= 我是本轮首发**：`pass()` 回「你是本轮首发，必须出牌」、
  `hint()`/`decide()` 把它当 target 为空，`play()` 也必须放行（否则 pass 和 play 互相堵死，
  `botAct` 的兜底出牌会抛异常逃出它自己的 `catch`）。

---

## 部署

插件目录放哪都行（只要 Hydro 进程读得到），**关键是路径要注册进 `addon.json`**。线上这台机器这两种都用过：

- `/root/.hydro/addons/hydro-games/` —— 和 Hydro 自己的数据放一起
- `/home/ubuntu/hydro-addons/games/` —— 本项目线上实际用的就是这个

注意目录名**不必等于包名**：这个目录叫 `games`，包名（`package.json` 的 `name`）是 `hydro-games`。加载不受影响（Hydro 用 `name` 做 key），但系统设置里的配置分组叫 `hydro-games`，找配置时别按目录名搜。

Hydro 是这样找到 addon 的（`src/options.ts` + `src/entry/common.ts`）：从 `~/.hydro/addon.json`（一个**绝对路径数组**）里取出每个目录，再用 `locateFile(dir, ['index.ts', 'index.js'])` 定位入口。两条结论：

- 入口必须是目录下的 `index.ts` 或 `index.js`，**与 `package.json` 的 `main` 无关**。入口里没有导出 `apply` 的话，只会打一行 `Addon init` 然后安静跳过（`common.ts` 里是 `if (m.apply) ctx.loader.reloadPlugin(...)`）。
- **目录放对 ≠ 插件生效**，路径还必须写进 `addon.json`。漏了这一步不会有任何报错——插件只是单纯不加载。反过来，只删注册项不删目录，通知栏会出现 `Addon not found: /...`。

> 路径按你自己的习惯放就行，目录名不必等于包名（Hydro 用 `package.json` 的 `name` 做 key，
> 配置分组显示的是 `hydro-games`）。下面以 `/home/ubuntu/hydro-addons/games` 为例。

```bash
# 1) 打包
node tools/pack.js
# → ../dist/hydro-games-<version>.zip
# 已排除：任何以点开头的路径段、tests/、tools/（打包脚本会自检并在出错时非 0 退出）

# 2) 上传、解开  （打包脚本跑完会把这几行原样打出来，照抄即可；两处由测试钉住，不会再各说各话）
#    腾讯云 OrcaTerm 面板可以直接把 zip 传上去，不一定要 scp
#    这个目录属主是 ubuntu，原则上不用 sudo
rm -rf /home/ubuntu/hydro-addons/games
mkdir -p /home/ubuntu/hydro-addons/games
unzip -o /tmp/hydro-games-0.5.1.zip -d /home/ubuntu/hydro-addons/games

# 3) 注册（第一次装才需要）
#    ⚠ 这一步目前在这台机器上**必然报错**，见下面「hydrooj CLI 挂了」一节，
#      路径早就注册过了，直接跳过、继续下一步即可。
sudo hydrooj addon add /home/ubuntu/hydro-addons/games

# 4) 重启
#    ⚠ 必须 sudo 加 bash -l。别的写法都会 command not found，原因见下面一节。
sudo bash -lc 'pm2 restart hydrooj'

# 5) 验证
curl -s http://127.0.0.1:8888/games/api/status
```

**第 4 步为什么要那么别扭**：hydrooj 是由 pm2 以 **root** 身份拉起的，而 pm2 装在 `/root/.nix-profile/bin/pm2`（nix 安装）。那个目录**只在 root 的 login shell 的 PATH 里**：

```bash
# root 的 login shell —— 只有这种能拿到 pm2
sudo bash -lc 'echo $PATH'      # → /root/.nix-profile/bin:/usr/local/sbin:...
sudo bash -lc 'command -v pm2'  # → /root/.nix-profile/bin/pm2  ✓
```

反例（**别跑，跑不通**，列在这里是为了别有人再改回去）：

```
✗ sudo pm2 restart hydrooj              # root 的普通 PATH 里没有 /root/.nix-profile/bin
✗ sudo bash -c 'command -v pm2'         # 空
✗ su - ubuntu -c 'pm2 restart hydrooj'  # command not found
```

所以那两种错写法和「用户不对」无关，换谁跑都不行：**必须同时满足「sudo」和「login shell」**。

### `hydrooj` CLI 挂了（Node 18 + cac 的兼容问题）

这台机器的 `/usr/local/bin/hydrooj` 用的 Node 18.19.1，而它依赖的 `cac` 调用了 `CustomEvent`——Node 18 里没有这个全局对象（Node 19+ 才有）。结果**任何** `hydrooj <子命令>` 都会崩：

```
ReferenceError: CustomEvent is not defined
    at CAC.parse (.../cac/dist/index.js:573:68)
```

好在 `addon add` 做的事只有一件：把目录路径写进 `/root/.hydro/addon.json`（一个绝对路径数组）。路径已存在时它本来也不写。所以：

- 只是想**升级已有插件** → 跳过 `addon add`，直接重启，没有影响（路径早就注册了）。
- 想**新增**一个 addon 路径 → 手工编辑 `/root/.hydro/addon.json` 加上绝对路径即可，别去修 CLI。

### 验证

**从服务器自己访问公网域名是通不了的**（`curl https://oj.xzy404.top/...` 返回 `000`，这是连接就没建立，不是 HTTP 状态码）。验证一律走回环地址，端口看 `/root/.hydro/config.json`（默认 `8888`）。

静态资源挂在**站点根**（`/games.css`，不是 `/games/games.css`）：

```bash
for f in games.css ddz.js uno.js; do
  curl -s -o /dev/null -w "$f %{http_code}\n" http://127.0.0.1:8888/$f
done
```

要是这几个 404，页面看得见但没样式、也没法出牌。**比对字节数**能识破「文件传了但进程没换」——服务端吐出来的长度必须和磁盘上一致。

也可以用现成的脚本一次跑完（含权限、哈希、索引、路由、日志检查）：

```bash
HG_SSH_PASS=xxx node tools/deploy.js              # 只诊断，全只读
HG_SSH_PASS=xxx node tools/deploy.js --go         # 真部署
HG_SSH_PASS=xxx node tools/deploy.js --script tools/verify.sh   # 部署后验证
```

**改了 `public/` 下的文件必须做两件事**：抬 `src/version.ts`（资源 URL 上的 `?v=` 是唯一能击穿 24 小时 HTTP 缓存的手段），以及**重启**（`public/` 还会在启动时被复制一份到 `~/.hydro/static`）。

`/games/api/status` 正常会返回插件名、版本、当前配置和各游戏的房间/排队计数。它同时会验证数据库是否通。

关于打包：**别用 Windows 的 `Compress-Archive`**。它把条目名写成 `src\games\bot.ts`（反斜杠），不符合 ZIP 规范，Linux 上 `unzip` 会报 `appears to use backslashes as path separators` 并且**一个文件都不解出来**。`tools/pack.js` 自己写 ZIP 容器（零依赖），条目名强制正斜杠，并且打完包会自检。

---

## 机器人（对手）

两套机器人都在 `src/games/<游戏>/bot.ts` 里，规则和真人走的是**同一个** `play()`，没有第二条路径。

### 斗地主：「对真人留手」

斗地主的地主是**叫分叫出来的**，所以地主天然拿着三家牌里最好的那一份牌。实测（各 1000 局）：

| 对照 | 地主胜率 |
| --- | --- |
| 按叫分选出地主（现状） | **68%** |
| 强制指定地主、完全不看牌 | **48~51%** |
| 三家都是同样的机器人，只把其中一家标成「真人座位」 | 67.8% → **55.7%** |

第二行说明**农民机器人本身不弱，也没有串通**（随机指定地主时就是干净的 50/50）；
多出来的 20 个百分点全是「叫分挑牌」挑出来的。换句话说，真人只要不叫地主，
就有一大半的局要面对全场最好的牌 —— 这就是「跟机器人打赢不了几局」的来源，规则本身如此。

规则改不了，所以改成机器人对真人收力。关键是**只对真人对手生效**：

- 你当农民 → 坐在你对面的**地主**机器人收力，而**你的农民队友照常配合**；
- 你当地主 → 两个农民机器人都是你的对手，都收力。

收力的尺度（两条，都刻意压得很轻，不做「随机乱出」那一套）：

1. **不用炸弹**；
2. **不为了压牌动用 2 和王**（小牌照压 —— 不是乱让），且这条**只在真人还没进终局时生效**。

第 2 条之所以要加个「终局前」的限制，是因为量出来过：不分阶段地一直收力，真人胜率会从 26% 窜到
**81.7%**，那就不是「有机会赢」而是「不用玩也能赢」，对局直接失去意义。加上这条之后，
真人前半程能舒服地把牌铺开，最后几张还是得自己走完。

另外两条与留手无关、对所有局面都生效的修正（都是「不帮队友反而像在帮地主」的机械原因）：

- **「让队友走」只在队友是下家时才算配合。** 三家轮转下我的下家不是队友就一定是地主；
  队友坐在更后面时，我甩出去的最小单张要先过地主的手，等于把出牌权递给对面。
- **地主剩 ≤3 张时，农民该炸就炸。** 原来只有「地主剩 ≤2 张」才允许拆炸弹，已经来不及了。

### 怎么量这些数

`tools/diag-bots.js`（**不参与打包、也不产生测试断言**）专门把「机器人打得怪」这种主观抱怨变成数字：

```bash
NODE_PATH="<node>/workspace/node_modules;<repo>/_harness/node_modules" node tools/diag-bots.js 1000
```

它跑四组对照：发牌完整性（牌有没有重复/丢失）、各座位胜率（有没有谁被系统性照顾）、
行为计数（该拦没拦 / 压队友 / 让路）、以及**真人视角的胜率**（内建「老实人」和「休闲玩家」两种参照打法，
各自再跑「留手生效 / 不留手」两遍）。改机器人之前先跑一遍，改完再跑一遍，
两个数对不上就别改 —— 「顶牌」那类听着很合理的改动就是这么被否掉的（实测地主胜率反而升 2~4 个点）。

### UNO 不做留手

UNO 四人各自为战，基准就是 25%，且已经验证过：机器人互相之间的座位胜率、以及一个
「老实人」对着三个机器人的胜率，都在基准附近（发牌 108 张零重复零丢失）。
没有队友也没有串通，就没有「帮谁」的问题 —— 而且上一轮刚把「该拦不拦」修好，
再让机器人放水会自相矛盾。

---

## 配置

系统设置 → `hydro-games`（也可以直接改 `~/.hydro/setting.json` 里的 `hydro-games` 段）：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后页面照常可看，但匹配/出牌接口拒绝服务 |
| `botFillSeconds` | `20` | 等多少秒后补机器人。**`0` = 永远不补**，只能等真人凑齐（这个 0 语义有回归测试钉着） |
| `botFillCount` | `2` | 每桌最多补几个机器人 |
| `turnTimeoutSeconds` | `60` | 出牌限时，超时自动过牌（首发则出最小的一张） |
| `bidTimeoutSeconds` | `30` | 叫分限时，超时视为不叫 |
| `botDelayMs` | `1200` | 机器人「思考」时长 |
| `recentLimit` | `20` | 游戏页「最近对局」条数 |
| `roomTtlMinutes` | `30` | 结束后房间保留时长 |
| `autoPlayAfterSeconds` | `30` | 多久没心跳就把座位交给机器人托管 |

---

## 测试

离线测试，**不需要** OJ 实例、不需要 MongoDB —— 用内存版假 Mongo + 官方 ui-default 真模板跑完整个链路。

依赖装在受管的 node 工作区里，不写进插件目录：

```bash
# 一次性准备（`<node>` 是受管 node 的安装目录）
cd "<node>/workspace" && npm i esbuild nunjucks js-yaml jsesc jsdom

# 拉官方模板作夹具（模板测试必须用真布局，自写替身通过不代表线上通过）
HG_UI_DEST="<repo>/_harness/ui" bash tests/fetch-ui-templates.sh

# 跑测试
NODE_PATH="<node>/workspace/node_modules;<repo>/_harness/node_modules" node tests/run.js
```

**断言数：962**（测试会读 README 里这个数字并和实际值比对，所以改了测试记得同步改这里）

覆盖范围：

斗地主：

- 牌型识别 39 例（含各种「看着像但不是」的边界）、牌型比较 13 例
- 状态机 74 例：发牌/叫分递增/全不叫重发/出牌校验/炸弹加倍/春天/反春/超时/机器人排期
- 机器人 4 例：300 局随机对局自动打完，每一步独立复核合法性，并统计地主胜率
- **机器人的配合与留手 14 例**：让路只在队友是下家时生效、「对真人留手」的四条（不拆炸弹 / 不拿 2 和压真人的小牌但小牌照压 / 真人进终局后恢复全力 / 叫分变保守）
- 状态序列化 14 例：**对手的完整手牌不会出现在对外状态里**（只给张数、叫分阶段不给底牌）

UNO：

- 牌的表示 55 例：108 张的构成逐色核对（每色 0 一张、1–9 各两张、三种功能牌各两张）、
  id ↔ 颜色/牌面/点数双向自洽、罚分（功能牌 20 / 万能牌 50）、发牌不重不漏、起始牌不会是万能牌、手牌排序只是重排
- 规则引擎 108 例：能打/不能打的完整判定（同色 / 同数字 / 同功能牌 / 万能牌指定颜色之后按指定色认）、
  座位轮转与方向、**禁止跳过下家、反转掉头、+2 与 +4 的罚牌张数与跳过**、
  **变色 +4 只能在没有同色牌时出**、万能牌必须先选色、
  摸到能打的可以打也可以过、**没摸过牌的人不能过**、同一个回合不能摸两次、
  **摸牌堆空了把弃牌堆洗回来且顶张留在牌面**、出完最后一张立即结算且得分零和、超时一定交出回合
- 机器人 9 例：400 局全机器人对局全部正常结束，每一步独立复核「该打的时候确实有能打的牌」，
  能打时选的那张一定合法、打不出去时确实不硬闯；提示与机器人选择一致
- 状态序列化 52 例：**对手手牌不出门**（对整个对外状态做 JSON 指纹搜索）、
  `playable` 只在轮到自己时给且与引擎逐张一致、结束后才有回放、回放里四家起手牌齐备

公共：

- 注册表契约 54 例（两个游戏各 27）：每个游戏都必须实现 `GameModule` 的全部方法、meta 字段齐全、模板与脚本文件存在。**meta 上任何 `*Template` 字段都会被扫一遍确认文件真的存在**（线上踩过「字段加了、文件没传」）
- 数据层与 HTTP 接口 84 例 + UNO 数据层与接口 109 例：练习局打到分出胜负、战绩与对局记录只落一次、
  4 人排队秒开、补机器人、取消匹配、**`botFillSeconds = 0` 时等再久也不补机器人**、接口参数校验、房间页首屏数据
- 模板渲染 27 例：用官方 `layout/basic.html` 真渲染，检查导航是中文而非裸 key、样式表位置正确，并用真实 JS 引擎执行页面里内嵌的 `<script>`，验证首屏 JSON 能被解析回来
- 前端真跑 266 例（jsdom + 真接口）：把 `public/ddz.js` 与 `public/uno.js` 放进 jsdom 执行，`fetch` 直接接到真实的 `*ApiHandler` 上，验证「点击 → 请求 → 渲染」整条链路。大厅页与房间页分别启动（页面形态由 URL + `hgData.inRoom` 决定）：
  - 大厅页：**就算正在局中也不画牌桌**（牌桌只属于 `/room/<房间号>`）、点「和机器人练习」真的开出一局并把地址换成 `/room/房间号`、玩法说明排在匹配与战绩之后、最近对局整行是入口
  - 房间页：页面里**没有**游戏名/匹配/战绩/玩法说明，只有牌桌；房间号不存在时只说「房间不存在或已结束」，不会悄悄换成你在的那一桌
  - 斗地主牌桌：真的点一次「出牌」（走 `POST action`，并检查请求体带上了房间号）、出牌后客户端和服务端两边的手牌都少 1 张、托管按钮在轮到自己时仍然可见、**点托管后出牌区收起且服务端真的置上托管**、**连续三次轮询和「机器人替我走一手」之后托管仍然保持**（`manualAuto` 不会被心跳解除）、结束后结果区是「回到大厅」且没有「收起」、**回放能从「发牌 51 张」走到「地主 20 张」再走到最后一手**
  - UNO 牌桌：打不出去的牌画灰、**点灰牌只提示不发请求**、选牌是单选且能换、出牌请求带上选的牌且服务端牌面真的变了、**点万能牌先弹选色框、没选颜色一个请求都不发、选完颜色才发且服务端记下指定的颜色**、**摸到能打的牌会自动替玩家选中并且「过」按钮从禁用变可用**、结束后结果区与**四家回放**（回到开局 28 张、走到最后与服务端手牌总数一致）
  - 大厅按钮状态矩阵（5 种组合）与「动作名闭合」检查**两个游戏都跑**：脚本派发的每个 `data-act` 都必须有处理分支，每个分支都必须有人派发它（防止删按钮留下死代码）
- 安全边界：**进行中的对局绝不能带回放数据**（`dealHands` 是各家发牌时的手牌）。测试里直接检查对外状态的 JSON 里搜不到 `dealHands`
- 安全：把 `"`、`\`、`</script>`、U+2028 塞进用户名，验证砸不坏页面脚本
- 打包卫生 30 例：真的跑一遍打包脚本，检查 zip 条目名是正斜杠（不是反斜杠）、不含以点开头的路径段、不含 `tests/` 与 `tools/`、含 `index.ts`；另外检查源码目录里没有以点开头的路径段、所有文本文件都是 LF 换行；**还有 13 条专门盯「部署提示与本文档是否同源」**——`sudo bash -lc` 必须都在、两种错的重启写法在「可照抄」的命令块里不许出现、但又必须作为反面教材留在正文里，另外远程目录必须一致、必须 curl 回环而不是公网域名、必须带上 `addon add`（这几个坑都真踩过）

---

## 实现要点（改代码前先看这几条）

- **参数合并顺序**：Hydro 的 base layer 里是 `{ ...ctx.params, ...ctx.query, ...ctx.request.body }`，**body 会盖掉路径参数**。所以游戏接口的 `:op` 只表示端点（`state`/`recent`/`action`），具体动作放在 `act` 字段里，两者绝不能同名。
- **内嵌 JSON 必须加引号**：模板里是 `window.HgData = '{{ hgData|json|jsesc|safe }}';`，前端再 `JSON.parse`。`jsesc` 的脚本上下文转义只处理 `</script>`、反斜杠和行分隔符，**不转义 `"`** —— 裸写 JSON 时只要有个用户名带引号，整段脚本就是语法错误。官方 `layout/html5.html` 内嵌 `UiContext` 用的也是这个写法。
- **`injectUI` 只支持 `before`**，没有 `after`，不传锚点就是 `push` 且**不去重**。所以导航位置是注册后统一归一化的（`pinNavLast`），并把锚点写成不依赖其它插件名字的形式 —— 否则插件一禁用，锚点就没了。
- **样式走 server layer 注入到每一页**，而不是只注入 `/games`：pjax 导航只换 `#panel` 里的内容，从首页点进游戏页不会重新加载 `<head>`，只注入一处会「点进来没样式」。
- **改了 `public/` 下的东西记得抬 `src/version.ts`**：Hydro 会把 addon 的 `public/` 挂在站点根并缓存 24 小时（`server.addServerLayer(addon_public, cache(dir, {maxAge}))`），资源 URL 上的 `?v=` 就是我们唯一的击穿手段（测试里有断言钉着这个版本号）。
- **数据库用注入的 `ctx.db`**，不用已废弃的 `db` 代理（那个依赖 `app.get('db')` 的时序）。
- **读-改-写一律走 `withRoom` / `withLock`**，避免并发请求把同一房间的状态覆盖掉。
- **对局记录用 `room.recorded` 去重**，否则一局结束后的每次 tick 都会再写一条。
- **托管分两种，别再用一个 `auto` 字段表示**：`auto` + `manualAuto` —— 掉线自动托管的那个座位一收到心跳就该收回操作权，玩家自己点的托管则要一直保持到他自己取消。`heartbeat()` 里少了 `!manualAuto` 这个判断，表现就是「每走一步托管都掉，得再点一下」（轮询每 1.3 秒带一次心跳）。回归测试钉着这条。
- **房间页要一直带着地址里的房间号问服务端**（`hgData.rid`）。房间不存在时 `room` 是 null，此时若改成不带 `room` 参数，服务端会回退到「你在的那一桌」—— 地址写着 A、画面里是 B。指定了房间号却查不到，就应该老老实实说「房间不存在」。
- **大厅页不画牌桌，轮询也不许把人弹走**：`apply(data, jump)` 的 `jump` 只有玩家自己点出来的动作才给 `true`。否则在大厅看战绩/最近对局时会被一路弹回牌桌。
- **别给同一页面形态再开一个模板文件。** 大厅页与房间页共用 `game_<id>.html`，用上下文里的 `inRoomPage` 分岔。多一个文件就多一次「部署时漏传」的机会，而漏传的后果是运行时 500 —— `Cannot get template game_xxx.html`，栈里还指向 `Loader.getSource`，一眼看不出是部署问题还是代码问题（线上真踩过）。注册表契约里有一条断言会把 meta 上所有 `*Template` 字段扫一遍，确认文件都在。
- **`pageData` 要按页面形态裁剪查询。** 房间页只有牌桌，队列 / 战绩 / 最近对局 / 在线人数都不必查 —— 它是玩家打开次数最多的页面。
- **过期清理是我们自己扫的，不是 MongoDB 的 TTL。** 所有时间字段存的是 `Date.now()`（number），而 Mongo 的 TTL 线程**只认 BSON Date**，遇到数字会静默跳过 —— 索引建了、名字还叫 `ttl`，却一条都不会删。所以 `games_room` 上那个索引叫 `expire` 而不是 `ttl`（只为 `cleanupRooms` 的 `updatedAt < 阈值` 查询服务），真正的清理是 `cleanupRooms()` 每分钟扫一次。名字起对了才不会让人去翻 Mongo 的 TTL 文档找原因。
- **别指望 `hydrooj` CLI。** 这台机器上它用的 Node 18 没有 `CustomEvent`，`cac` 一解析参数就 `ReferenceError`，**任何子命令都跑不了**（`addon add` 也一样）。新增 addon 只能手改 `/root/.hydro/addon.json`。见「部署」一节。
- **「让队友」这类配合规则，一定要连「谁在我下家」一起判。** 三家轮转下，我的下家不是队友就一定是地主；只判「队友牌少」而不判座位关系，会有一半场次把最小单张直接喂给地主 —— 看起来就是「机器人帮地主」。改这类规则时把「下家是谁」当成前置条件写进注释，不然下一个改的人会再漏一次。
- **给机器人做「收力」要盯两个边界：只对手真人、且分阶段。** 只判「桌上有真人」会把真人的农民队友一起削弱（那就又变成「不帮队友」了，正是上一版刚修好的问题）；不分阶段地一直收力，实测真人胜率会窜到 81.7%（对局失去意义）。两处都有断言钉着。
- **别用「听起来更专业」的战术改机器人。** 「顶牌」（下家是地主时甩最长/最大的牌）在 1000 局 × 5 档阈值下把地主胜率从 66.8% 推到了 68.9%~70.4%，是负收益，已回退。改机器人前先跑 `tools/diag-bots.js`，用数字决定，不要用直觉。
