/*!
 * hydro-games / UNO 前端。
 *
 * 一条硬规矩：**这里没有规则判定**。哪张牌能打、打完之后谁被跳过、谁该摸几张，
 * 全部只由服务端决定 —— 服务端连「你手里哪些牌现在能打」都算好了（room.playable），
 * 客户端只负责把状态画出来、把点击发回去。
 */
(function () {
    'use strict';

    // 首屏数据由服务端内嵌成「字符串」再在这里解析：这样用户名里的引号、
    // 反斜杠、`</script>` 都伤不到页面（服务端用 jsesc 做好了脚本上下文转义）。
    var D = {};
    try { D = JSON.parse(window.HgData || '{}') || {}; } catch (e) { D = {}; }
    var root = document.getElementById('hg-app');
    if (!D || !root) return;

    // pjax 会重复执行脚本：旧的那份定时器/轮询必须自己停下来，否则会在
    // 已经被替换掉的 DOM 上一直发请求。
    if (window.__hgUno) {
        window.__hgUno.dead = true;
        clearInterval(window.__hgUno.clock);
        clearTimeout(window.__hgUno.poll);
        clearInterval(window.__hgUno.replay);
    }
    var TOKEN = { dead: false, clock: 0, poll: 0, replay: 0 };
    window.__hgUno = TOKEN;
    function alive() { return !TOKEN.dead && document.body.contains(root); }

    // 域名前缀：/d/<domain>/games/uno 这类页面下，写死的相对路径会打到根域名
    var PREFIX = (/^\/d\/[^/]+(?=\/|$)/.exec(location.pathname) || [''])[0];
    var API = PREFIX + D.api;

    // 页面地址：大厅是 /games/uno，进了对局就换成 /games/uno/room/<房间号>
    var PAGE = PREFIX + '/games/' + (D.gid || 'uno');
    function roomUrl(id) { return id ? (PAGE + '/room/' + encodeURIComponent(id)) : PAGE; }
    function goRoom(id) { location.assign(roomUrl(id)); }
    function goHome() { location.assign(PAGE); }

    // 只改地址栏，不压历史记录 —— 免得返回键卡在半路
    function syncUrl() {
        var want = roomUrl(S.room && S.room.id);
        if (location.pathname === want) return;
        try { history.replaceState(null, '', want); } catch (e) { /* 不支持就保持原地址 */ }
    }

    // 牌面文案整表由服务端下发：客户端不重新实现一遍牌的编码
    var FACE = (D.unoFace && D.unoFace.faces) ? D.unoFace : null;
    function faceOf(id) { return FACE ? FACE.faces[id] : ('#' + id); }
    function colorOf(id) { return FACE ? FACE.colors[id] : -1; }
    function colorName(i) { return (FACE && FACE.colorText[i]) || ''; }
    var OPTIONAL_COLOR = FACE && typeof FACE.wildFrom === 'number' ? FACE.wildFrom : 100;

    var CFG = (D.lobby && D.lobby.config) || {};
    // 房间页（/games/uno/room/<房间号>）只有牌桌；大厅页不画牌桌，
    // 就算你正在局中，也要点「回到对局」过去看。
    var IN_ROOM = !!D.inRoom;
    // 房间页要一直盯着地址里那个房间号。房间不存在时 S.room 是 null，
    // 若此时改成「不带 room 参数」，服务端就会回退到「我在的那一桌」——
    // 地址写着 ZZZZZZ，画面却是另一局，比直接说「房间不存在」糟得多。
    var WANT_ROOM = D.rid || (D.room && D.room.id) || '';
    var STATUS_TEXT = { playing: '对局中', finished: '已结束' };
    var SEATS = 4;
    // 相对座位：按座位号固定排（不随方向翻转），方向用顶栏的箭头表示。
    // 换方向就让三个人互换位置的话，玩家每出一张反转牌就要重新认人。
    var SIDES = ['L', 'T', 'R'];

    var $ = function (sel) { return root.querySelector(sel); };
    function $$(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

    var S = {
        room: D.room || null,
        lobby: D.lobby || null,
        recent: D.recent || [],
        sel: -1,
        busy: false,
        skew: 0,
        fails: 0,
        pollTimer: 0,
        lastDrawn: -1,
        // 回放：step = 已经走了几条流水，0 = 刚发完牌
        replayStep: undefined,
        replayPlay: false,
        replayTimer: 0,
    };

    // ── 基础工具 ────────────────────────────────────────────────────
    function toast(msg, ms) {
        var node = $('[data-toast]');
        if (!node) return;
        node.textContent = msg;
        node.hidden = false;
        clearTimeout(node._timer);
        node._timer = setTimeout(function () { node.hidden = true; }, ms || 2600);
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

    /**
     * 我的座位是不是托管中。观战 / 不在局中一律 false。
     *
     * 收成一个函数是有原因的：托管要在四个地方生效（画手牌、显隐操作区、点牌守卫、
     * 以及「提示」回包该不该应用），各写各的 `room.seats[room.seat].auto` 迟早会漏一处，
     * 漏掉的那处就是一张亮着的牌。
     */
    function selfAuto() {
        var r = S.room;
        if (!r || r.seat < 0 || !r.seats) return false;
        var mine = r.seats[r.seat];
        return !!(mine && mine.auto);
    }

    /**
     * 一张牌。
     * @param {number} id           牌 id；< 0 表示背面
     * @param {string} extra        额外 class
     * @param {number} colorOverride 强制底色（牌面顶张若是万能牌，用被指定的颜色画）
     */
    function cardEl(id, extra, colorOverride) {
        var n = document.createElement('div');
        n.className = 'hg-card hg-uno-card' + (extra ? ' ' + extra : '');
        if (id < 0) {
            n.classList.add('hg-card--back');
            return n;
        }
        n.dataset.card = String(id);
        var own = colorOf(id);
        var show = (colorOverride !== undefined && colorOverride !== null && colorOverride >= 0)
            ? colorOverride : own;
        if (show < 0) n.classList.add('hg-uno-card--wild');
        else n.classList.add('hg-uno-card--c' + show);
        n.appendChild(el('span', 'hg-card__rank', faceOf(id)));
        if (own < 0) n.appendChild(el('span', 'hg-card__suit', '变色'));
        else if (colorOverride !== undefined && colorOverride !== null && colorOverride >= 0
            && colorOverride !== own) {
            n.appendChild(el('span', 'hg-card__suit', '→' + colorName(colorOverride)));
        }
        return n;
    }

    function qs(data) {
        var parts = [];
        Object.keys(data || {}).forEach(function (k) {
            if (data[k] === undefined || data[k] === null || data[k] === '') return;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k]));
        });
        return parts.length ? '?' + parts.join('&') : '';
    }

    function request(kind, op, data) {
        var init = {
            method: kind,
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        };
        var url = API + '/' + op;
        if (kind === 'GET') url += qs(data);
        else {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(data || {});
        }
        return fetch(url, init).then(function (res) {
            return res.text().then(function (text) {
                var json = null;
                try { json = JSON.parse(text); } catch (e) { json = null; }
                if (!json) {
                    // 200 不等于成功：把「不是 JSON」和「空 body」分开说清楚，
                    // 它们指向完全不同的层（前者多半是被页面/网关拦了）
                    var why = text ? ('返回的不是 JSON（前 160 字）：' + text.slice(0, 160))
                        : '返回了空 body';
                    throw new Error('接口异常（HTTP ' + res.status + '，'
                        + (res.headers.get('content-type') || '未知类型') + '）' + why);
                }
                return json;
            });
        });
    }

    function act(name, payload) {
        // 房间号要带上：服务端靠它定位房间并加锁（handler.ts 的 opAction）。
        // 少了它，服务端也会回退去查「我在哪一桌」，但多带一次更省一次查询。
        var body = { act: name, room: (S.room && S.room.id) || '' };
        Object.keys(payload || {}).forEach(function (k) { body[k] = payload[k]; });
        return request('POST', 'action', body);
    }

    function serverNow() { return Date.now() + S.skew; }

    // ── 匹配 / 战绩 ────────────────────────────────────────────────
    function renderLobby() {
        var box = $('[data-lobby]');
        var statBox = $('[data-stat]');
        var lobby = S.lobby || {};
        var q = lobby.queue || { size: 0, waiters: [], mine: false, waited: 0 };
        // S.room 里躺着的那一局分两种：**进行中的**和**刚结束的**。
        // 两者的按钮状态完全不同 —— 「刚结束」在操作上跟「没有房间」几乎一样，
        // 只有「进行中」才该把「和机器人练习」封住（一桌就 4 个座位，再开一局会把现在的顶掉）。
        var inRoom = !!S.room;
        var live = inRoom && S.room.status !== 'finished';

        if (box) {
            clear(box);
            var row = el('div', 'hg-lobby__row');
            var cnt = el('div', 'hg-lobby__count');
            cnt.appendChild(document.createTextNode(String(q.size)));
            cnt.appendChild(el('small', null, '/ ' + SEATS + ' 人'));
            row.appendChild(cnt);
            row.appendChild(el('span', 'hg-dim', CFG.enabled === false ? '游戏已关闭' : '凑齐 ' + SEATS + ' 人立即开局'));
            box.appendChild(row);

            var btns = el('div', 'hg-lobby__btns');
            var joinBtn = el('button', 'hg-btn hg-btn--primary',
                live ? '回到对局' : (q.mine ? '匹配中…' : '开始匹配'));
            joinBtn.dataset.act = live ? 'go-room' : 'join';
            joinBtn.disabled = CFG.enabled === false || (!live && !!q.mine);
            btns.appendChild(joinBtn);

            // 练习是「拿一个新的房间」，跟正在打的那一局不冲突，所以只在**进行中**才封它。
            // 排队中点练习也是允许的：服务端会先把人移出队列再开局。
            var prac = el('button', 'hg-btn', '和机器人练习');
            prac.dataset.act = 'practice';
            prac.disabled = CFG.enabled === false || live;
            btns.appendChild(prac);

            if (q.mine) {
                var cancel = el('button', 'hg-btn hg-btn--ghost', '取消匹配');
                cancel.dataset.act = 'cancel-queue';
                btns.appendChild(cancel);
            }
            box.appendChild(btns);

            // 提示按「此刻最要紧的事」排优先级：进行中 > 正在排队 > 上一局刚结束 > 没登录。
            // 「排队」必须排在「上一局刚结束」前面 —— 点了开始匹配之后，那个已结束的房间
            // 还会被轮询带回来（它是 10 分钟内最近的一局），排前面会把排队人数和
            // 自动补机器人的倒计时整个吞掉。
            if (live) {
                box.appendChild(el('p', 'hg-my-room', '你正在房间 ' + S.room.id + ' 里。'));
            } else if (q.mine) {
                var lines = ['正在排队，已有 ' + q.size + '/' + SEATS + ' 人。'];
                if (CFG.botFillSeconds > 0) {
                    var left = Math.max(0, CFG.botFillSeconds - q.waited);
                    lines.push(left > 0 ? (left + ' 秒后若还没凑齐会自动补机器人。') : '马上补机器人开局。');
                }
                box.appendChild(el('p', 'hg-dim', lines.join(' ')));
            } else if (inRoom) {
                box.appendChild(el('p', 'hg-dim', '房间 ' + S.room.id + ' 的对局已结束。'));
            } else if (!D.loggedIn) {
                box.appendChild(el('p', 'hg-dim', '开始对局需要先登录。'));
            }

            if (q.size) {
                var ul = el('ul', 'hg-queue');
                q.waiters.forEach(function (w) {
                    var li = el('li');
                    li.appendChild(el('span', null, w.uname || ('用户 ' + w.uid)));
                    li.appendChild(el('span', 'hg-dim', '已等待 ' + w.waited + ' 秒'));
                    ul.appendChild(li);
                });
                box.appendChild(ul);
            }
        }

        if (statBox) {
            clear(statBox);
            var st = (lobby && lobby.stat) || {};
            var grid = el('div', 'hg-stat-grid');
            [
                ['总场次', st.games || 0],
                ['胜场', st.wins || 0],
                ['累计得分', st.score || 0],
                ['最高单局', st.best || 0],
            ].forEach(function (pair) {
                var cell = el('div');
                cell.appendChild(el('span', null, pair[0]));
                cell.appendChild(el('b', null, pair[1]));
                grid.appendChild(cell);
            });
            statBox.appendChild(grid);
            if (!st.games) statBox.appendChild(el('p', 'hg-dim', '还没有战绩，先来一局吧。'));
        }
    }

    function timeText(ts) {
        var d = new Date(ts);
        var p = function (n) { return n < 10 ? '0' + n : String(n); };
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function renderRecent() {
        var box = $('[data-recent]');
        if (!box) return;
        clear(box);
        var list = S.recent || [];
        if (!list.length) {
            box.appendChild(el('div', 'hg-empty', '还没有对局记录。'));
            return;
        }
        var table = el('table', 'hg-recent');
        var thead = el('thead');
        var htr = el('tr');
        ['时间', '房间', '玩家', '结果', '我的得分'].forEach(function (t) {
            htr.appendChild(el('th', null, t));
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        var tbody = el('tbody');
        list.forEach(function (m) {
            // 整行都是入口：点进去看那一局的记录
            var tr = el('tr', 'hg-recent__row');
            tr.dataset.act = 'open-room';
            tr.dataset.room = m.roomId;
            tr.title = '查看这一局';
            tr.appendChild(el('td', 'hg-dim', timeText(m.createAt)));
            tr.appendChild(el('td', 'hg-dim', m.roomId));

            var players = el('td');
            var wrap = el('div', 'hg-r-players');
            (m.seats || []).forEach(function (s) {
                var span = el('span', 'hg-r-p' + (s.me ? ' is-me' : ''));
                if (s.winner) span.appendChild(el('i', 'hg-r-winner', '赢'));
                span.appendChild(document.createTextNode(s.uname));
                span.appendChild(el('i', 'hg-dim', '剩 ' + s.cards));
                span.appendChild(el('i', 'hg-dim', (s.score > 0 ? '+' : '') + s.score));
                wrap.appendChild(span);
            });
            players.appendChild(wrap);
            tr.appendChild(players);

            var resCell = el('td');
            var w = (m.seats || []).find(function (s) { return s.winner; });
            resCell.appendChild(el('span', null, w ? (w.uname + ' 胜') : '—'));
            tr.appendChild(resCell);

            var sc = el('td');
            if (m.myScore === null || m.myScore === undefined) sc.appendChild(el('span', 'hg-dim', '—'));
            else sc.appendChild(el('span', m.myScore > 0 ? 'pos' : (m.myScore < 0 ? 'neg' : ''),
                (m.myScore > 0 ? '+' : '') + m.myScore));
            tr.appendChild(sc);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        box.appendChild(table);
    }

    // ── 牌桌 ───────────────────────────────────────────────────────
    /** 某个座位在这局里最后一条流水（用来在座位上显示「刚做了什么」） */
    function seatLastEvent(room, idx) {
        var ev = room.events || [];
        for (var i = ev.length - 1; i >= 0; i--) if (ev[i].seat === idx) return ev[i];
        return null;
    }

    function renderRoom() {
        var section = $('[data-board-section]');
        var room = S.room;
        if (!section) return;
        var noRoom = $('[data-noroom]');
        if (noRoom) noRoom.hidden = !!room;
        if (!IN_ROOM || !room) { section.hidden = true; return; }
        section.hidden = false;

        var mySeat = room.seat >= 0 ? room.seat : 0;
        $('[data-room-code]').textContent = room.id;
        $('[data-room-status]').textContent = STATUS_TEXT[room.status] || room.status;
        $('[data-dir]').textContent = room.status === 'finished' ? '' : (room.dir === 1 ? '↻ 顺时针' : '↺ 逆时针');
        var colorChip = $('[data-color]');
        clear(colorChip);
        if (room.status !== 'finished' && room.color >= 0) {
            colorChip.appendChild(el('i', 'hg-uno-dot hg-uno-dot--c' + room.color));
            colorChip.appendChild(document.createTextNode('当前 ' + colorName(room.color) + '色'));
        }
        $('[data-deck]').textContent = '摸牌堆 ' + room.deckCount + ' · 弃牌 ' + room.discardCount;

        SIDES.forEach(function (side, k) {
            renderSeat(side, room, (mySeat + k + 1) % SEATS);
        });

        renderPiles(room);
        renderLog(room);
        renderMe(room, mySeat);
        renderReplay(room);
        renderResult(room);
        updateTimer();
    }

    function renderPiles(room) {
        var draw = $('[data-pile-draw]');
        var top = $('[data-pile-top]');
        if (draw) {
            clear(draw);
            if (room.deckCount > 0) {
                draw.appendChild(cardEl(-1, 'hg-card--md'));
                draw.appendChild(el('span', 'hg-dim', room.deckCount + ' 张'));
            } else {
                draw.appendChild(el('span', 'hg-dim', '摸牌堆空了'));
            }
        }
        if (top) {
            clear(top);
            var t = room.top;
            // 万能牌用「被指定的颜色」画 —— 玩家要一眼看出现在该出什么色
            top.appendChild(cardEl(t.card, 'hg-card--md', t.color));
        }
    }

    function renderSeat(side, room, idx) {
        var box = root.querySelector('.hg-seat[data-side="' + side + '"]');
        if (!box) return;
        var s = room.seats[idx];
        if (!s) return;
        box.classList.toggle('is-active', !!s.active);

        box.querySelector('[data-seat-name]').textContent = s.bot ? (s.uname + ' · 机器人') : s.uname;
        var cnt = box.querySelector('[data-seat-count]');
        cnt.textContent = String(s.cards);
        cnt.appendChild(el('small', null, ' 张'));

        var tag = box.querySelector('[data-seat-tag]');
        if (s.auto && !s.bot) tag.textContent = '已托管';
        else if (s.uno) tag.textContent = 'UNO！';
        else tag.textContent = '';

        var played = box.querySelector('[data-seat-played]');
        clear(played);
        var ev = seatLastEvent(room, idx);
        if (ev) played.appendChild(eventNode(ev, true));
    }

    /** 把一条流水画成小卡片/文字 */
    function eventNode(ev, compact) {
        var wrap = el('span', 'hg-evn');
        if (ev.type === 'play') {
            wrap.appendChild(cardEl(ev.card, compact ? 'hg-card--xs' : 'hg-card--sm', ev.color));
        } else if (ev.type === 'draw') {
            var n = (ev.cards || []).length;
            for (var i = 0; i < n && i < 4; i++) wrap.appendChild(cardEl(-1, 'hg-card--xs'));
            wrap.appendChild(el('span', 'hg-dim', n > 4 ? ('+' + n) : ''));
        } else {
            wrap.appendChild(el('span', 'hg-dim', '过'));
        }
        return wrap;
    }

    function renderLog(room) {
        var box = $('[data-log]');
        if (!box) return;
        box.textContent = (room.events || []).slice(-3).map(function (ev) {
            var s = room.seats[ev.seat];
            return (s ? s.uname : ('座位 ' + ev.seat)) + ' ' + (ev.text || '');
        }).join('　·　');
    }

    function renderMe(room, mySeat) {
        var me = room.seats[mySeat];
        $('[data-me-name]').textContent = room.seat >= 0 ? ((me && me.uname) || '我') : '观战';
        var tag = '';
        if (room.seat < 0) tag = '（观战中）';
        else if (me && me.auto) tag = '已托管 · 点「取消托管」收回操作';
        else if (me && me.cards === 1) tag = 'UNO！';
        $('[data-me-tag]').textContent = tag;

        // 托管判定必须在**画手牌之前**算出来：手牌的亮/暗和下面按钮的显隐用的是
        // 同一个依据，晚一行算就会出现「按钮都收起了、牌还亮着」这种自相矛盾的画面。
        var auto = selfAuto();
        // 托管中的牌一律暗着：不是「这几张打不出去」，而是「现在轮不到你动手」。
        // 服务端在托管时也把 playable 置空了，这里再与一次是为了两边永远一致
        // （真出现不一致时，宁可显示成「不能打」）。
        if (auto && S.sel >= 0) S.sel = -1;

        var hand = $('[data-hand]');
        clear(hand);
        if (room.seat >= 0) {
            var playable = room.playable || [];
            (room.hand || []).forEach(function (c) {
                var n = cardEl(c);
                var ok = !auto && playable.indexOf(c) >= 0;
                if (!ok) n.classList.add('is-dim');
                if (!auto && S.sel === c) n.classList.add('is-selected');
                hand.appendChild(n);
            });
            if (!(room.hand || []).length) hand.appendChild(el('span', 'hg-dim', '（没有手牌）'));
        } else {
            hand.appendChild(el('span', 'hg-dim', '你在观战，点「开始匹配」即可加入牌局。'));
        }

        var over = room.status === 'finished';
        var isPlayer = room.seat >= 0;
        var playbox = $('[data-play]');
        var idle = $('[data-idle]');
        var autobar = $('[data-autobar]');
        var colorbox = $('[data-colorbox]');

        // 托管中不能自己操作：手已经交给机器人了，按钮留着只会打架
        var canAct = isPlayer && !over && room.myTurn && !auto;
        playbox.hidden = !canAct;
        // 选色框只在「选了一张万能牌、又点了出牌」之后才出现；一旦不能再操作就必须收起。
        // 收起这步要放在算 idle **之前**：否则「托管时恰好开着选色框」这一帧里，
        // idle 会按「选色框还在」判成 hidden，随后选色框才被收起 —— 中间那块就空了，什么都不显示。
        if (colorbox && !colorbox.hidden && !canAct) colorbox.hidden = true;
        idle.hidden = !(playbox.hidden && (colorbox ? colorbox.hidden : true));

        // 托管按钮不参与上面那几块的互斥：轮到自己时会切到出牌区，
        // 托管正是在这时候要能取消，所以它必须常驻。
        autobar.hidden = !isPlayer || over;
        if (!autobar.hidden) {
            var tb = autobar.querySelector('[data-act="toggle-auto"]');
            tb.textContent = auto ? '取消托管' : '托管';
            tb.disabled = S.busy;
            autobar.classList.toggle('is-auto', auto);
            $('[data-auto-hint]').textContent = auto ? '已交给机器人代打' : '离开一会儿就交给机器人';
        }

        if (!playbox.hidden) {
            var playable2 = room.playable || [];
            var selOk = S.sel >= 0 && playable2.indexOf(S.sel) >= 0;
            var playBtn = playbox.querySelector('[data-act="play"]');
            playBtn.disabled = S.busy || !selOk;
            playbox.querySelector('[data-act="draw"]').disabled = S.busy || room.drewThisTurn || room.deckCount <= 0;
            playbox.querySelector('[data-act="pass"]').disabled = S.busy || !room.canPass;
            playbox.querySelector('[data-act="clear"]').disabled = S.busy || S.sel < 0;
        }
        if (!idle.hidden && colorbox && colorbox.hidden) {
            var txt = '观战中';
            if (isPlayer && over) txt = '本局已结束';
            else if (isPlayer && auto) txt = '已托管 · 机器人正在替你打';
            else if (isPlayer) {
                var cur = room.seats[room.turn];
                txt = '等待 ' + (cur ? cur.uname : '对手') + ' 出牌…';
            }
            $('[data-idle-text]').textContent = txt;
        }
    }

    // ── 回放 ───────────────────────────────────────────────────────
    /**
     * 服务端只给「起手牌 + 开局牌面 + 全部流水」，这里按顺序重放。
     * 出牌/摸牌/罚牌都是同一种数据，所以不需要服务端预先算好每一帧。
     */
    function replayState(rp, step) {
        var hands = (rp.dealHands || []).map(function (h) { return h.slice(); });
        var top = rp.first;
        var color = rp.firstColor;
        var ev = rp.events || [];
        var log = [];
        for (var k = 0; k < step && k < ev.length; k++) {
            var e = ev[k];
            log.push(e);
            if (e.type === 'play') {
                var h = hands[e.seat];
                if (h) {
                    var i = h.indexOf(e.card);
                    if (i >= 0) h.splice(i, 1);
                }
                top = e.card;
                color = e.color >= 0 ? e.color : colorOf(e.card);
            } else if (e.type === 'draw') {
                (e.cards || []).forEach(function (c) { if (hands[e.seat]) hands[e.seat].push(c); });
            }
        }
        return { hands: hands, top: top, color: color, log: log };
    }

    function onReplay(go) {
        var rp = S.room && S.room.replay;
        if (!rp) return;
        var total = (rp.events || []).length;
        var s = (S.replayStep === undefined || S.replayStep > total) ? total : S.replayStep;
        if (go === 'play') {
            S.replayPlay = !S.replayPlay;
            tickReplay();
            renderRoom();
            return;
        }
        if (go === 'first') s = 0;
        else if (go === 'prev') s = Math.max(0, s - 1);
        else if (go === 'next') s = Math.min(total, s + 1);
        else if (go === 'last') s = total;
        S.replayStep = s;
        renderRoom();
    }

    function tickReplay() {
        clearInterval(TOKEN.replay);
        if (!S.replayPlay) return;
        TOKEN.replay = setInterval(function () {
            if (!alive() || !S.replayPlay) { clearInterval(TOKEN.replay); return; }
            var rp = S.room && S.room.replay;
            var total = rp ? (rp.events || []).length : 0;
            var s = (S.replayStep === undefined || S.replayStep > total) ? total : S.replayStep;
            if (s >= total) { S.replayPlay = false; clearInterval(TOKEN.replay); renderRoom(); return; }
            onReplay('next');
        }, 900);
    }

    function renderReplay(room) {
        var box = $('[data-replay]');
        if (!box) return;
        var rp = room && room.replay;
        if (!rp || !(rp.dealHands || []).length) { box.hidden = true; return; }
        box.hidden = false;
        clear(box);

        var total = (rp.events || []).length;
        var step = (S.replayStep === undefined || S.replayStep > total) ? total : S.replayStep;
        S.replayStep = step;

        var st = replayState(rp, step);

        var head = el('div', 'hg-replay__head');
        head.appendChild(el('b', null, '对局回放'));
        head.appendChild(el('span', 'hg-dim',
            step === 0 ? '刚发完牌' : ('第 ' + step + ' / ' + total + ' 步')));
        box.appendChild(head);

        var handsWrap = el('div', 'hg-replay__seats hg-replay__seats--4');
        rp.seats.forEach(function (s) {
            var cell = el('div', 'hg-replay__seat');
            var who = el('div', 'hg-replay__who');
            who.appendChild(el('span', null, s.uname));
            who.appendChild(el('span', 'hg-dim', String((st.hands[s.idx] || []).length) + ' 张'));
            if (s.idx === rp.winner) who.appendChild(el('span', 'hg-r-winner', '赢'));
            cell.appendChild(who);
            var cards = el('div', 'hg-hand hg-hand--flat');
            (st.hands[s.idx] || []).forEach(function (c) { cards.appendChild(cardEl(c, 'hg-card--xs')); });
            cell.appendChild(cards);
            handsWrap.appendChild(cell);
        });
        box.appendChild(handsWrap);

        var stage = el('div', 'hg-replay__stage');
        stage.appendChild(el('span', 'hg-dim', '牌面：'));
        stage.appendChild(cardEl(st.top, 'hg-card--sm', st.color));
        if (step > 0) {
            var cur = st.log[st.log.length - 1];
            var u = rp.seats[cur.seat];
            stage.appendChild(el('span', 'hg-dim', '　' + (u ? u.uname : ('座位 ' + cur.seat)) + ' ' + (cur.text || '')));
        }
        box.appendChild(stage);

        var bar = el('div', 'hg-replay__bar');
        [['⏮', 'first', step <= 0], ['◀', 'prev', step <= 0],
            [S.replayPlay ? '❚❚' : '▶', 'play', total === 0],
            ['▶', 'next', step >= total], ['⏭', 'last', step >= total]]
            .forEach(function (b) {
                var btn = el('button', 'hg-btn hg-btn--sm', b[0]);
                btn.dataset.act = 'replay';
                btn.dataset.go = b[1];
                btn.disabled = b[2];
                bar.appendChild(btn);
            });
        box.appendChild(bar);
    }

    function renderResult(room) {
        var box = $('[data-result]');
        if (!box) return;
        var r = room.result;
        if (room.status !== 'finished' || !r) { box.hidden = true; return; }
        box.hidden = false;
        clear(box);

        var win = room.seats[r.winner];
        var title = el('div', 'hg-result__title');
        if (room.seat < 0) {
            title.textContent = '本局结束：' + ((win && win.uname) || '') + ' 获胜';
        } else {
            var iWon = room.seat === r.winner;
            title.textContent = iWon ? '你赢了' : '你输了';
            title.classList.add(iWon ? 'is-win' : 'is-lose');
        }
        box.appendChild(title);
        box.appendChild(el('div', 'hg-dim', '赢家 ' + ((win && win.uname) || '') + ' 收走 ' + r.gain + ' 分'));

        var row = el('div', 'hg-result__row');
        (r.seats || []).forEach(function (s, i) {
            row.appendChild(el('span', null,
                (i === r.winner ? '🏆 ' : '') + s.uname + ' 剩 ' + s.cards + ' 张 '
                + (s.score > 0 ? '+' : '') + s.score));
        });
        box.appendChild(row);

        var btns = el('div', 'hg-result__btns');
        // 结束后回大厅重新排队，而不是在原地再开一局 —— 这个房间号已经用掉了
        var home = el('button', 'hg-btn hg-btn--primary', '回到大厅');
        home.dataset.act = 'home';
        btns.appendChild(home);
        box.appendChild(btns);
    }

    function updateTimer() {
        var timer = $('[data-timer]');
        if (!timer) return;
        var room = S.room;
        var text = timer.querySelector('[data-timer-text]');
        if (!room || !room.deadline || room.status === 'finished') {
            timer.style.setProperty('--hg-timer', '0%');
            text.textContent = '';
            timer.classList.remove('is-urgent');
            return;
        }
        var total = (CFG.turnTimeoutSeconds || 30) * 1000;
        var left = Math.max(0, room.deadline - serverNow());
        timer.style.setProperty('--hg-timer',
            (total > 0 ? Math.max(0, Math.min(100, left / total * 100)) : 0).toFixed(1) + '%');
        text.textContent = Math.ceil(left / 1000) + 's';
        timer.classList.toggle('is-urgent', left < 8000);
    }

    // ── 交互 ───────────────────────────────────────────────────────
    function onCard(node) {
        var room = S.room;
        if (!room || S.busy || !room.myTurn || room.status !== 'playing') return;
        // 托管中就直说「托管中」，别让玩家以为是自己选的牌有问题。
        // 服务端托管时 playable 是空的，不先拦这一下会掉到下面那句
        // 「要出X色或者同样的牌面」——答非所问。
        if (selfAuto()) {
            toast('正在托管中，先点「取消托管」再自己出牌');
            return;
        }
        var id = Number(node.dataset.card);
        var playable = room.playable || [];
        if (playable.indexOf(id) < 0) {
            // 能不能打是服务端说了算；这里只是把原因说清楚，不做第二份判断
            toast('这张牌现在打不出去：要出' + colorName(room.color) + '色或者同样的牌面');
            return;
        }
        S.sel = (S.sel === id) ? -1 : id;
        var colorbox = $('[data-colorbox]');
        if (colorbox) colorbox.hidden = true;
        renderRoom();
    }

    function submitPlay() {
        var room = S.room;
        if (!room || S.busy || S.sel < 0) return;
        if (S.sel >= OPTIONAL_COLOR) {
            // 万能牌要先选颜色 —— 选完颜色才真的发请求
            var box = $('[data-colorbox]');
            if (box) {
                box.hidden = false;
                var idle = $('[data-idle]');
                if (idle) idle.hidden = true;
            }
            return;
        }
        doAct('play', { card: S.sel });
    }

    function submitColor(color) {
        var box = $('[data-colorbox]');
        if (box) box.hidden = true;
        if (S.sel < 0) return;
        doAct('play', { card: S.sel, color: color });
    }

    root.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var card = t.closest('.hg-card[data-card]');
        if (card && card.closest('[data-hand]')) { onCard(card); return; }

        var colorBtn = t.closest('[data-color]');
        if (colorBtn && !colorBtn.disabled) { submitColor(Number(colorBtn.dataset.color)); return; }

        var node = t.closest('[data-act]');
        if (!node || node.disabled) return;
        var a = node.dataset.act;
        if (a === 'join' || a === 'practice') { S.sel = -1; doAct(a); return; }
        if (a === 'cancel-queue') { doAct('leave'); return; }
        if (a === 'play') { submitPlay(); return; }
        if (a === 'draw') { doAct('draw'); return; }
        if (a === 'pass') { doAct('pass'); return; }
        if (a === 'clear') {
            S.sel = -1;
            var cb = $('[data-colorbox]');
            if (cb) cb.hidden = true;
            renderRoom();
            return;
        }
        if (a === 'replay') { onReplay(node.dataset.go); return; }
        if (a === 'toggle-auto') {
            var me = S.room && S.room.seat >= 0 ? S.room.seats[S.room.seat] : null;
            doAct('auto', { value: !(me && me.auto) });
            return;
        }
        // 下面几个是纯跳转，不发请求
        if (a === 'go-room') { goRoom(S.room && S.room.id); return; }
        if (a === 'home') { goHome(); return; }
        if (a === 'open-room') { goRoom(node.dataset.room); return; }
    });

    /**
     * @param {boolean} jump 允许把浏览器带到房间页。只有玩家自己点出来的动作才给 true：
     *   轮询在大厅页也会带回「我在的那一桌」，但这时候把人弹走等于剥夺了他呆在大厅看
     *   战绩/最近对局的权利 —— 他得主动点「回到对局」才过去。
     */
    function apply(data, jump) {
        if (data.serverNow) S.skew = data.serverNow - Date.now();
        var before = S.room ? S.room.id : '';
        if (data.room !== undefined) {
            var r = data.room;
            var changed = !r || !S.room || S.room.id !== r.id;
            S.room = r || null;
            if (changed) S.sel = -1;
            // 轮到我、而我选中的那张已经不在手里了（被别人接走了 / 自己打出去了），清掉选择
            else if (S.room && S.room.seat >= 0 && S.sel >= 0
                && (S.room.hand || []).indexOf(S.sel) < 0) S.sel = -1;
        }
        if (data.lobby) S.lobby = data.lobby;
        if (data.recent) S.recent = data.recent;
        // 提示会替玩家选中一张牌。托管中不能选中 —— 那会画出唯一一张亮牌，和「已托管」打架。
        // （服务端在托管时已经回 null 了，这里是第二道；`S.room` 上面刚更新过，读得到最新的 auto。）
        if (data.hint && data.hint.length && !selfAuto()) S.sel = data.hint[0];
        // 开出一局就去它的房间页。只在房间号真的变了时动 ——
        // 否则房间页刷新、观战页都会被无谓地改写。
        var now = S.room ? S.room.id : '';
        if (now && now !== before) {
            // 房间页：本来就只有牌桌，换一局只改地址就够了
            if (IN_ROOM) syncUrl();
            else if (jump) {
                // 大厅里自己开出来的才真跳过去 —— 大厅不画牌桌，不跳就只能干瞪眼。
                // 先改地址再跳转：万一整页跳转被浏览器/pjax 拦下，地址也已经是房间页了。
                syncUrl();
                goRoom(now);
            }
        }
    }

    function doAct(name, payload) {
        if (S.busy) return;
        S.busy = true;
        var before = S.room ? S.room.status : null;
        var moving = (name === 'play' || name === 'draw' || name === 'pass');
        if (moving) renderRoom();
        act(name, payload).then(function (res) {
            S.busy = false;
            if (!res.ok) { toast(res.error || '操作失败'); renderRoom(); return; }
            apply(res, true);
            if (moving) {
                S.sel = -1;
                // 摸到一张能直接打的牌：替玩家选中，省一次点击
                if (res.room && res.room.drawnCard >= 0 && res.room.drawnCard !== S.lastDrawn) {
                    S.lastDrawn = res.room.drawnCard;
                    S.sel = res.room.drawnCard;
                }
            }
            renderLobby();
            renderRoom();
            if (res.recent) renderRecent();
            if (S.room && S.room.status === 'finished' && before !== 'finished') loadRecent();
        }).catch(function (e) {
            S.busy = false;
            toast(e.message || '网络异常，请稍后重试', 4000);
            renderRoom();
        });
    }

    // ── 轮询 ───────────────────────────────────────────────────────
    function loadRecent() {
        // 房间页没有「最近对局」这一块，别白拉一次接口
        if (!$('[data-recent]')) return;
        request('GET', 'recent', { limit: CFG.recentLimit || 20 }).then(function (res) {
            if (res && res.ok && res.recent) { S.recent = res.recent; renderRecent(); }
        }).catch(function () { /* 最近对局失败不该影响牌桌 */ });
    }

    function poll() {
        clearTimeout(S.pollTimer);
        if (!alive()) return;
        request('GET', 'state', { room: S.room ? S.room.id : WANT_ROOM }).then(function (res) {
            S.fails = 0;
            if (!res.ok) throw new Error(res.error || '状态获取失败');
            var beforeRev = S.room ? S.room.rev : -1;
            var beforeStatus = S.room ? S.room.status : null;
            apply(res);
            renderLobby();
            var room = S.room;
            if (!room) renderRoom();
            else if (room.rev !== beforeRev) renderRoom();
            else updateTimer();
            if (beforeStatus !== 'finished' && room && room.status === 'finished') loadRecent();
        }).catch(function (e) {
            S.fails++;
            if (S.fails === 1 || S.fails % 5 === 0) toast(e.message || '状态同步失败', 4000);
        }).then(function () {
            if (!alive()) return;
            var inGame = S.room && S.room.status !== 'finished';
            var wait = inGame ? 1300 : 2600;
            if (document.hidden) wait = 6000;
            S.pollTimer = setTimeout(poll, wait);
        });
    }

    TOKEN.clock = setInterval(function () {
        if (!alive()) { clearInterval(TOKEN.clock); return; }
        if (S.room && S.room.deadline) updateTimer();
    }, 250);

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && alive()) { clearTimeout(S.pollTimer); poll(); }
    });

    var refresh = $('[data-recent-refresh]');
    if (refresh) refresh.addEventListener('click', loadRecent);

    renderLobby();
    renderRoom();
    renderRecent();
    loadRecent();
    poll();
})();
