/*!
 * hydro-games / 斗地主 前端。
 *
 * 一条硬规矩：**这里没有规则判定**。牌型合法性、能不能压、该谁出牌、提示出什么，
 * 全部只由服务端决定 —— 客户端只负责「把服务端给的状态画出来」和「把点击发回去」。
 * 这样规则永远不会出现两份实现，也就不会两边不一致。
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
    if (window.__hgDdz) {
        window.__hgDdz.dead = true;
        clearInterval(window.__hgDdz.clock);
        clearTimeout(window.__hgDdz.poll);
        clearInterval(window.__hgDdz.replay);
    }
    var TOKEN = { dead: false, clock: 0, poll: 0, replay: 0 };
    window.__hgDdz = TOKEN;
    function alive() { return !TOKEN.dead && document.body.contains(root); }

    // 域名前缀：/d/<domain>/games/ddz 这类页面下，写死的相对路径会打到根域名
    var PREFIX = (/^\/d\/[^/]+(?=\/|$)/.exec(location.pathname) || [''])[0];
    var API = PREFIX + D.api;

    // 页面地址：大厅是 /games/<gid>，进了对局就换成 /games/<gid>/room/<房间号>
    var PAGE = PREFIX + '/games/' + (D.gid || 'ddz');
    function roomUrl(id) { return id ? (PAGE + '/room/' + encodeURIComponent(id)) : PAGE; }
    function goRoom(id) { location.assign(roomUrl(id)); }
    function goHome() { location.assign(PAGE); }

    // 只改地址栏，不压历史记录 —— 免得返回键卡在半路
    function syncUrl() {
        var want = roomUrl(S.room && S.room.id);
        if (location.pathname === want) return;
        try { history.replaceState(null, '', want); } catch (e) { /* 不支持就保持原地址 */ }
    }
    var FACE = (D.cardFace && D.cardFace.ranks) ? D.cardFace : {
        ranks: ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'],
        suits: ['♠', '♥', '♣', '♦'],
    };
    var CFG = (D.lobby && D.lobby.config) || {};
    // 房间页（/games/ddz/room/<房间号>）只有牌桌；大厅页不画牌桌，
    // 就算你正在局中，也要点「回到对局」过去看。
    var IN_ROOM = !!D.inRoom;
    // 房间页要一直盯着地址里那个房间号。房间不存在时 S.room 是 null，
    // 若此时改成「不带 room 参数」，服务端就会回退到「我在的那一桌」——
    // 地址写着 ZZZZZZ，画面却是另一局，比直接说「房间不存在」糟得多。
    var WANT_ROOM = D.rid || (D.room && D.room.id) || '';
    var STATUS_TEXT = { bidding: '叫分中', playing: '对局中', finished: '已结束' };
    var SEATS = 3;

    var $ = function (sel) { return root.querySelector(sel); };

    var S = {
        room: D.room || null,
        lobby: D.lobby || null,
        recent: D.recent || [],
        sel: [],
        busy: false,
        skew: 0,
        lastRecentAt: 0,
        fails: 0,
        pollTimer: 0,
        // 回放：step 是「已经走了几手」，-1 = 刚发牌、0 = 叫分结束（地主拿到底牌）
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

    function cardEl(id, extra) {
        var n = document.createElement('div');
        n.className = 'hg-card' + (extra ? ' ' + extra : '');
        if (id < 0) {
            n.classList.add('hg-card--back');
            return n;
        }
        n.dataset.card = String(id);
        var joker = id >= 52;
        var rank = joker ? (id === 52 ? '小' : '大') : FACE.ranks[id >> 2];
        var suit = joker ? '王' : FACE.suits[id & 3];
        if (id === 53 || (id < 52 && (id & 3) === 1)) n.classList.add('hg-card--red');
        n.appendChild(el('span', 'hg-card__rank', rank));
        n.appendChild(el('span', 'hg-card__suit', suit));
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
        // 少了它，玩家点出牌只会拿到一句「缺少房间号」——什么都做不了。
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
        // S.room 里躺着的那一局分两种：**进行中的**（bidding/playing）和**刚结束的**（finished）。
        // 两者的按钮状态完全不同 —— 「刚结束」在操作上跟「没有房间」几乎一样，
        // 只有「进行中」才该把「和机器人练习」封住（一桌就 3 个座位，再开一局会把现在的顶掉）。
        // 之前这里一律用 `!!S.room`，结果上一局结束后练习是灰的、匹配却能点。
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
            // 在进行中的对局里：主按钮改成「回到对局」，练习不能开 ——
            // 一桌就 3 个座位，再开一局会把现在的房间顶掉。
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
                ['地主胜场', st.landlordWins || 0],
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

    function timeText(ts) {        var d = new Date(ts);
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
        ['时间', '房间', '玩家（地主在前）', '结果', '底分 × 倍数', '我的得分'].forEach(function (t) {
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
            (m.seats || []).slice().sort(function (a, b) {
                return (b.landlord ? 1 : 0) - (a.landlord ? 1 : 0);
            }).forEach(function (s) {
                var span = el('span', 'hg-r-p' + (s.me ? ' is-me' : ''));
                if (s.landlord) span.appendChild(el('i', 'hg-r-landlord', '地主'));
                span.appendChild(document.createTextNode(s.uname));
                span.appendChild(el('i', 'hg-dim', (s.score > 0 ? '+' : '') + s.score));
                wrap.appendChild(span);
            });
            players.appendChild(wrap);
            tr.appendChild(players);

            var resCell = el('td');
            resCell.appendChild(el('span', m.landlordWin ? 'pos' : 'neg', m.landlordWin ? '地主胜' : '农民胜'));
            if (m.bonus) resCell.appendChild(el('span', 'hg-dim', m.bonus === 'spring' ? ' · 春天' : ' · 反春'));
            tr.appendChild(resCell);

            tr.appendChild(el('td', null, m.baseBet + ' × ' + m.multiplier));

            var sc = el('td');
            if (m.myScore === null || m.myScore === undefined) sc.appendChild(el('span', 'hg-dim', '—'));
            else sc.appendChild(el('span', m.myScore > 0 ? 'pos' : (m.myScore < 0 ? 'neg' : ''), (m.myScore > 0 ? '+' : '') + m.myScore));
            tr.appendChild(sc);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        box.appendChild(table);
    }

    // ── 牌桌 ───────────────────────────────────────────────────────
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
        $('[data-bet]').textContent = room.baseBet ? ('底分 ' + room.baseBet) : '';
        $('[data-multiplier]').textContent = room.multiplier > 1 ? ('倍数 × ' + room.multiplier) : '';

        renderSeat('L', room, (mySeat + 2) % SEATS);
        renderSeat('R', room, (mySeat + 1) % SEATS);

        var bottom = $('[data-bottom]');
        clear(bottom);
        if (room.bottom && room.bottom.length) {
            room.bottom.forEach(function (c) { bottom.appendChild(cardEl(c, 'hg-card--sm')); });
        } else {
            bottom.appendChild(el('span', 'hg-dim', '底牌'));
            for (var i = 0; i < 3; i++) bottom.appendChild(cardEl(-1, 'hg-card--sm'));
        }

        var table = $('[data-table]');
        clear(table);
        if (room.last && room.last.cards && room.last.cards.length) {
            var who = room.seats[room.last.seat];
            table.appendChild(el('span', 'hg-dim', (who ? who.uname : '') + ' 出：'));
            room.last.cards.forEach(function (c) { table.appendChild(cardEl(c, 'hg-card--md')); });
        } else if (room.status === 'playing') {
            table.appendChild(el('span', 'hg-empty', '新一轮，可以出任意牌型'));
        } else if (room.status === 'bidding') {
            table.appendChild(el('span', 'hg-empty', '叫分阶段 · 出价最高者成为地主'));
        }

        renderLog(room);
        renderMe(room, mySeat);
        renderReplay(room);
        renderResult(room);
        updateTimer();
    }

    function renderSeat(side, room, idx) {
        var box = root.querySelector('.hg-seat[data-side="' + side + '"]');
        if (!box) return;
        var s = room.seats[idx];
        if (!s) return;
        box.classList.toggle('is-active', !!s.active);

        var role = box.querySelector('[data-seat-role]');
        role.textContent = s.landlord ? '地主' : (s.role === 'farmer' ? '农民' : '');
        role.classList.toggle('hg-role--landlord', !!s.landlord);

        box.querySelector('[data-seat-name]').textContent = s.bot ? (s.uname + ' · 机器人') : s.uname;
        var cnt = box.querySelector('[data-seat-count]');
        cnt.textContent = String(s.cards);
        cnt.appendChild(el('small', null, ' 张'));

        var tag = box.querySelector('[data-seat-tag]');
        if (room.status === 'bidding') {
            tag.textContent = room.bidSeat === idx
                ? '叫分中…'
                : (room.bidScores[idx] ? ('叫 ' + room.bidScores[idx] + ' 分') : '');
        } else if (s.auto && !s.bot) tag.textContent = '已托管';
        else tag.textContent = '';

        var played = box.querySelector('[data-seat-played]');
        clear(played);
        var p = (room.table || [])[idx];
        if (p && p.pass) played.appendChild(el('span', 'hg-passmark', '不出'));
        else if (p && p.cards) p.cards.forEach(function (c) { played.appendChild(cardEl(c, 'hg-card--xs')); });
    }

    function renderLog(room) {
        var box = $('[data-log]');
        if (!box) return;
        box.textContent = (room.plays || []).slice(-3).map(function (p) {
            var s = room.seats[p.seat];
            var who = s ? s.uname : ('座位 ' + p.seat);
            if (p.pass) return who + ' 不出';
            var name = (room.comboNames && room.comboNames[p.type]) || '';
            return who + ' 出 ' + name + '（' + p.cards.length + ' 张）';
        }).join('　·　');
    }

    function renderMe(room, mySeat) {
        var me = room.seats[mySeat];
        var role = $('[data-me-role]');
        role.textContent = me ? (me.landlord ? '地主' : (me.role === 'farmer' ? '农民' : '')) : '';
        role.classList.toggle('hg-role--landlord', !!(me && me.landlord));
        $('[data-me-name]').textContent = me && room.seat >= 0 ? me.uname : (room.seat >= 0 ? '我' : '观战');
        $('[data-me-tag]').textContent = room.seat < 0
            ? '（观战中）'
            : (me && me.auto ? '已托管 · 点「取消托管」收回操作' : '');

        var over = room.status === 'finished';
        var isPlayer = room.seat >= 0;
        var bidbox = $('[data-bid]');
        var playbox = $('[data-play]');
        var idle = $('[data-idle]');
        var autobar = $('[data-autobar]');

        // 托管判定要在**画手牌之前**算出来：手牌上挂不挂选中高亮、下面几块显不显示，
        // 都得看它。晚一行算就会出现「按钮都收起了、牌还亮着」这种自相矛盾的画面。
        var auto = selfAuto();
        // 进托管就把已选的牌清掉：挂着高亮的选中态看着像「我还能出」，
        // 而出牌区其实是收着的，点了也出不去 —— 纯属误导。
        if (auto && S.sel.length) S.sel = [];

        var hand = $('[data-hand]');
        clear(hand);
        if (room.seat >= 0) {
            (room.hand || []).forEach(function (c) {
                var n = cardEl(c);
                if (!auto && S.sel.indexOf(c) >= 0) n.classList.add('is-selected');
                hand.appendChild(n);
            });
        } else {
            hand.appendChild(el('span', 'hg-dim', '你在观战，点「开始匹配」即可加入牌局。'));
        }

        bidbox.hidden = !(isPlayer && !over && room.bidding && room.myTurn && !auto);
        playbox.hidden = !(isPlayer && !over && room.status === 'playing' && room.myTurn && !auto);
        idle.hidden = !(bidbox.hidden && playbox.hidden);

        // 托管按钮不参与上面那三块的互斥：轮到自己时会切到出牌区，
        // 托管正是在这时候要能取消，所以它必须常驻。
        autobar.hidden = !isPlayer || over;
        if (!autobar.hidden) {
            var tb = autobar.querySelector('[data-act="toggle-auto"]');
            tb.textContent = auto ? '取消托管' : '托管';
            tb.disabled = S.busy;
            autobar.classList.toggle('is-auto', auto);
            $('[data-auto-hint]').textContent = auto ? '已交给机器人代打' : '离开一会儿就交给机器人';
        }

        if (!bidbox.hidden) {
            Array.prototype.forEach.call(bidbox.querySelectorAll('[data-bid-score]'), function (b) {
                var v = Number(b.dataset.bidScore);
                b.disabled = S.busy || (v !== 0 && v <= room.bidBest);
            });
        }
        if (!playbox.hidden) {
            var passBtn = playbox.querySelector('[data-act="pass"]');
            passBtn.disabled = S.busy || !!room.mustPlay || auto;
            var playBtn = playbox.querySelector('[data-act="play"]');
            playBtn.disabled = S.busy || !S.sel.length || auto;
            playbox.querySelector('[data-act="hint"]').disabled = S.busy || auto;
        }
        if (!idle.hidden) {
            var txt = '观战中';
            if (isPlayer && over) txt = '本局已结束';
            else if (isPlayer && auto) txt = '已托管 · 机器人正在替你打';
            else if (isPlayer && room.bidding) txt = '等待其他玩家叫分…';
            else if (isPlayer) {
                var cur = room.seats[room.turn];
                txt = '等待 ' + (cur ? cur.uname : '对手') + ' 出牌…';
            }
            $('[data-idle-text]').textContent = txt;
        }
    }

    // ── 回放 ───────────────────────────────────────────────────────
    // 服务端只给「发牌时三家的手牌 + 每一手」，这里把它重新展开成某一步的牌面。
    // 没有规则判定：牌型、合法性、谁赢全在服务端。
    function replayHands(rp, step) {
        if (!rp || !rp.dealHands) return [];
        var hands = rp.dealHands.map(function (h) { return h.slice(); });
        if (step < 0) return hands;                       // 底牌还没翻开
        if (rp.landlord >= 0 && hands[rp.landlord]) {
            hands[rp.landlord] = hands[rp.landlord].concat(rp.bottom || []);
        }
        for (var k = 0; k < step && k < rp.plays.length; k++) {
            var p = rp.plays[k];
            var h = hands[p.seat];
            if (p.pass || !h) continue;
            p.cards.forEach(function (c) {
                var i = h.indexOf(c);
                if (i >= 0) h.splice(i, 1);
            });
        }
        return hands;
    }

    function onReplay(go) {
        var rp = S.room && S.room.replay;
        if (!rp) return;
        var total = rp.plays.length;
        var s = (S.replayStep === undefined || S.replayStep > total) ? total : S.replayStep;
        if (go === 'play') {
            S.replayPlay = !S.replayPlay;
            tickReplay();
            renderRoom();
            return;
        }
        if (go === 'first') s = -1;
        else if (go === 'prev') s = Math.max(-1, s - 1);
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
            var total = rp ? rp.plays.length : 0;
            var s = (S.replayStep === undefined || S.replayStep > total) ? total : S.replayStep;
            if (s >= total) { S.replayPlay = false; clearInterval(TOKEN.replay); renderRoom(); return; }
            onReplay('next');
        }, 900);
    }

    function renderReplay(room) {
        var box = $('[data-replay]');
        if (!box) return;
        var rp = room && room.replay;
        if (!rp || !rp.dealHands || !rp.dealHands.length) { box.hidden = true; return; }
        box.hidden = false;
        clear(box);

        var total = rp.plays.length;
        var step = (S.replayStep === undefined || S.replayStep > total) ? total : S.replayStep;
        S.replayStep = step;

        var head = el('div', 'hg-replay__head');
        head.appendChild(el('b', null, '对局回放'));
        head.appendChild(el('span', 'hg-dim',
            step < 0 ? '刚发完牌' : (step === 0 ? '叫分结束 · 地主拿走底牌' : ('第 ' + step + ' / ' + total + ' 手'))));
        box.appendChild(head);

        var hands = replayHands(rp, step);
        var wrap = el('div', 'hg-replay__seats');
        rp.seats.forEach(function (s) {
            var cell = el('div', 'hg-replay__seat');
            var who = el('div', 'hg-replay__who');
            who.appendChild(el('span', 'hg-role' + (s.landlord ? ' hg-role--landlord' : ''), s.landlord ? '地主' : '农民'));
            who.appendChild(el('span', null, s.uname));
            who.appendChild(el('span', 'hg-dim', String((hands[s.idx] || []).length) + ' 张'));
            cell.appendChild(who);
            var cards = el('div', 'hg-hand hg-hand--flat');
            (hands[s.idx] || []).forEach(function (c) { cards.appendChild(cardEl(c, 'hg-card--xs')); });
            cell.appendChild(cards);
            wrap.appendChild(cell);
        });
        box.appendChild(wrap);

        var stage = el('div', 'hg-replay__stage');
        var cur = step > 0 ? rp.plays[step - 1] : null;
        if (cur) {
            var u = rp.seats[cur.seat];
            var label = (u ? u.uname : '座位 ' + cur.seat)
                + (cur.pass ? '：不出' : (' 出 ' + ((room.comboNames && room.comboNames[cur.type]) || '') + '：'));
            stage.appendChild(el('span', 'hg-dim', label));
            if (!cur.pass) cur.cards.forEach(function (c) { stage.appendChild(cardEl(c, 'hg-card--sm')); });
        } else if (step === 0) {
            stage.appendChild(el('span', 'hg-dim', '底牌：'));
            (rp.bottom || []).forEach(function (c) { stage.appendChild(cardEl(c, 'hg-card--sm')); });
        } else {
            stage.appendChild(el('span', 'hg-dim', '底牌还没翻开'));
        }
        box.appendChild(stage);

        var bar = el('div', 'hg-replay__bar');
        [['⏮', 'first', step <= -1], ['◀', 'prev', step <= -1],
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

        var title = el('div', 'hg-result__title');
        if (room.seat < 0) {
            title.textContent = '本局结束：' + (r.landlordWin ? '地主胜' : '农民胜');
        } else {
            var me = room.seats[room.seat];
            var win = me.landlord ? r.landlordWin : !r.landlordWin;
            title.textContent = (win ? '你赢了' : '你输了') + (me.landlord ? '（地主）' : '（农民）');
            title.classList.add(win ? 'is-win' : 'is-lose');
        }
        box.appendChild(title);
        box.appendChild(el('div', 'hg-dim', '底分 ' + r.baseBet + ' × 倍数 ' + r.multiplier
            + (r.bonus === 'spring' ? ' · 春天' : (r.bonus === 'anti' ? ' · 反春' : ''))));

        var row = el('div', 'hg-result__row');
        (r.seats || []).forEach(function (s) {
            row.appendChild(el('span', null,
                (s.role === 'landlord' ? '地主 ' : '农民 ') + s.uname + ' ' + (s.score > 0 ? '+' : '') + s.score));
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
        var total = (room.status === 'bidding' ? CFG.bidTimeoutSeconds : CFG.turnTimeoutSeconds) * 1000;
        var left = Math.max(0, room.deadline - serverNow());
        timer.style.setProperty('--hg-timer', (total > 0 ? Math.max(0, Math.min(100, left / total * 100)) : 0).toFixed(1) + '%');
        text.textContent = Math.ceil(left / 1000) + 's';
        timer.classList.toggle('is-urgent', left < 8000);
    }

    // ── 交互 ───────────────────────────────────────────────────────
    function onCard(node) {
        var room = S.room;
        if (!room || S.busy || !room.myTurn || room.status !== 'playing') return;
        // 托管中不能选牌。斗地主没有「可打亮/不可打暗」这套（选牌合法性由服务端在出牌时
        // 判定），所以少了这一下不会出现亮错牌，但会出现「已托管却还能把牌点起来」——
        // 选出牌区是收着的，点了也出不去，纯属误导。
        if (selfAuto()) {
            toast('正在托管中，先点「取消托管」再自己出牌');
            return;
        }
        var id = Number(node.dataset.card);
        var i = S.sel.indexOf(id);
        if (i >= 0) S.sel.splice(i, 1);
        else S.sel.push(id);
        var order = room.hand || [];
        S.sel.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
        renderRoom();
    }

    root.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var card = t.closest('.hg-card[data-card]');
        if (card && card.closest('[data-hand]')) { onCard(card); return; }

        var node = t.closest('[data-act],[data-bid-score]');
        if (!node || node.disabled) return;
        if (node.dataset.bidScore !== undefined) { doAct('bid', { score: Number(node.dataset.bidScore) }); return; }
        var a = node.dataset.act;
        if (a === 'join' || a === 'practice') { S.sel = []; doAct(a); return; }
        if (a === 'cancel-queue') { doAct('leave'); return; }
        if (a === 'play') { doAct('play', { cards: S.sel.slice() }); return; }
        if (a === 'pass') { doAct('pass'); return; }
        if (a === 'clear') { S.sel = []; renderRoom(); return; }
        if (a === 'hint') { doAct('hint'); return; }
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
            if (!r) { S.room = null; S.sel = []; }
            else if (!S.room || S.room.id !== r.id) { S.room = r; S.sel = []; }
            else S.room = r;
        }
        if (data.lobby) S.lobby = data.lobby;
        if (data.recent) S.recent = data.recent;
        // 提示会替玩家选中一手牌。托管中不能选中 —— 那会画出一手亮牌，和「已托管」打架。
        // （服务端在托管时已经回 null 了，这里是第二道；`S.room` 上面刚更新过，读得到最新的 auto。）
        if (data.hint && !selfAuto()) S.sel = data.hint.slice();
        // 开出一局就去它的房间页。只在房间号真的变了时动 ——
        // 否则房间页刷新、观战页都会被无谓地改写。
        var now = S.room ? S.room.id : '';
        if (now && now !== before) {
            // 房间页：本来就只有牌桌，换一局只改地址就够了
            if (IN_ROOM) syncUrl();
            else if (jump) {
                // 大厅里自己开出来的才真跳过去 —— 大厅不画牌桌，不跳就只能干瞪眼。
                // 先改地址再跳转：万一整页跳转被浏览器/pjax 拦下，地址也已经是房间页了。
                // 反过来，轮询发现「你在局中」时**不能**动大厅页的地址 ——
                // 那样人在大厅看战绩，地址栏却悄悄变成了 /room/xxx。
                syncUrl();
                goRoom(now);
            }
        }
    }

    function doAct(name, payload) {
        if (S.busy) return;
        S.busy = true;
        var before = S.room ? S.room.status : null;
        var played = (name === 'play' || name === 'pass' || name === 'bid');
        if (played) renderRoom();
        act(name, payload).then(function (res) {
            S.busy = false;
            if (!res.ok) { toast(res.error || '操作失败'); renderRoom(); return; }
            apply(res, true);
            if (played) S.sel = [];
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
        S.lastRecentAt = Date.now();
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
