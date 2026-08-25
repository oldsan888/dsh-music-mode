/**
 * tool-dispatch.js · Regret-radio AI 叠加层工具派发（M4-3）
 *
 * dube 的 11 个 fire-and-forget 工具（SSE `tool` 事件）→ window.RegretRadio 桥接执行。
 * 契约源：packages/shared/src/tools.ts（ToolName / ToolArgs / ToolResult）。
 * 改写自 Regretio App.tsx dispatchTool：去 React state、只经桥接、不直读内部全局（ADR-4）。
 *
 * 三个高危坑（plans/05 §4 / §10）：
 *   ① index 工具 1-based → 桥接 0-based，须 toIndex0(n)=Number(n)-1；
 *   ② play_song / queue_add_song 是 {query} 非 {id,provider}，须 search 中转取首个；
 *   ③ set_assistant_name 真名以 done.assistant_name 为准，这里只回灌 + chip，不改 UI 名。
 *
 * 每个 handler async 返回 ToolResult 扩展 { name, ok, summary, chip }：
 *   - summary：回灌后端 recent_tool_results（修工具盲区），ai-overlay 收集 slice(-6)；
 *   - chip：对话线内联痕迹文案（仅有意义工具留痕，琐碎工具 chip=null）。
 * 防御：args 可能为 {}（解析失败）/ 缺必填 → no-op + 失败 summary，绝不抛。
 */
(function () {
  'use strict';
  var AI = (window.RegretRadioAI = window.RegretRadioAI || {});

  function player() { return (window.RegretRadio && window.RegretRadio.player) || null; }
  function stage() { return (window.RegretRadio && window.RegretRadio.stage) || null; }
  function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }
  function toIndex0(n) { return Number(n) - 1; } // 坑①：1-based → 0-based
  function pct(v) { return Math.round(clamp01(v) * 100) + '%'; }
  function qstr(args) { return (args && typeof args.query === 'string') ? args.query.trim() : ''; }
  function res(name, ok, summary, chip) {
    return { name: name, ok: !!ok, summary: summary || '', chip: chip || null };
  }

  var HANDLERS = {
    /* ── 传输（琐碎，不留痕 chip） ── */
    player_next: async function () {
      var p = player(); if (!p) return res('player_next', false, 'player_next：播放器未就绪');
      p.next(); return res('player_next', true, 'player_next：已切下一首');
    },
    player_prev: async function () {
      var p = player(); if (!p) return res('player_prev', false, 'player_prev：播放器未就绪');
      p.prev(); return res('player_prev', true, 'player_prev：已切上一首');
    },
    player_toggle: async function () {
      var p = player(); if (!p) return res('player_toggle', false, 'player_toggle：播放器未就绪');
      p.toggle(); return res('player_toggle', true, 'player_toggle：已切换播放/暂停');
    },
    player_pause: async function () { // 幂等暂停（已停则空操作；解"清空并暂停"冲突）
      var p = player(); if (!p) return res('player_pause', false, 'player_pause：播放器未就绪');
      if (typeof p.pause === 'function') p.pause(); else p.toggle();
      return res('player_pause', true, 'player_pause：已暂停');
    },
    player_play: async function () { // 幂等继续/播放
      var p = player(); if (!p) return res('player_play', false, 'player_play：播放器未就绪');
      if (typeof p.play === 'function') p.play(); else p.toggle();
      return res('player_play', true, 'player_play：已继续播放');
    },
    player_volume: async function (args) {
      var p = player(); if (!p) return res('player_volume', false, 'player_volume：播放器未就绪');
      if (typeof args.set === 'number') {
        var v = clamp01(args.set); p.setVolume(v);
        return res('player_volume', true, 'player_volume：音量设为 ' + pct(v));
      }
      if (typeof args.delta === 'number') {
        var nv = clamp01((p.getVolume() || 0) + args.delta); p.setVolume(nv);
        return res('player_volume', true, 'player_volume：音量调到 ' + pct(nv));
      }
      return res('player_volume', false, 'player_volume：缺 set/delta，未调整');
    },

    /* ── 搜索 / 播放 / 队列（留痕 chip） ── */
    search_music: async function (args) {
      var p = player(); if (!p) return res('search_music', false, 'search_music：播放器未就绪');
      var q = qstr(args); if (!q) return res('search_music', false, 'search_music：缺 query');
      var tracks;
      try { tracks = (await p.search(q)) || []; }
      catch (e) { return res('search_music', false, 'search_music("' + q + '")：搜索出错', null); }
      var n = tracks.length;
      return res('search_music', n > 0,
        'search_music("' + q + '")：' + (n ? ('找到 ' + n + ' 首，已展示') : '没搜到结果'),
        n ? ('🔍 搜"' + q + '" · ' + n + ' 首') : ('🔍 搜"' + q + '" · 无结果'));
    },
    play_song: async function (args) { // 坑②：{query} → search → tracks[0] → playTrack
      var p = player(); if (!p) return res('play_song', false, 'play_song：播放器未就绪');
      var q = qstr(args); if (!q) return res('play_song', false, 'play_song：缺 query');
      // 后端选定优先：事件带 resolved（后端已搜索选定、并已把该曲喂给模型播报）→ 照单直接播，
      // 不再自己搜（选定即权威，避免前后端各搜一次选出不同曲）；stage 展示后台补一发搜索（纯视觉，
      // 不阻塞、失败无妨）。无 resolved（后端超时降级/旧后端）→ 走下面旧路径。
      var rv = args && args.resolved;
      if (rv && rv.id) {
        var rt = {
          id: String(rv.id),
          provider: rv.provider === 'qq' ? 'qq' : 'netease',
          name: rv.name || '',
          artists: String(rv.artist || '').split(/\s*[\/、,&]\s*/).filter(Boolean),
          album: rv.album || '',
          cover: rv.cover || ''
        };
        var r0;
        try { r0 = await p.playTrack(rt); }
        catch (e) { return res('play_song', false, 'play_song("' + q + '")：《' + (rt.name || q) + '》播放出错', null); }
        try { var sp = p.search(q); if (sp && typeof sp.catch === 'function') sp.catch(function () {}); } catch (e2) {}
        if (r0 && r0.ok) {
          return res('play_song', true,
            'play_song("' + q + '")：已开始播放后端选定的《' + rt.name + '》- ' + (rv.artist || ''),
            '▶《' + rt.name + '》');
        }
        return res('play_song', false,
          'play_song("' + q + '")：《' + (rt.name || q) + '》没能播放（' + ((r0 && r0.reason) || '未知') + '）', null);
      }
      var tracks;
      try { tracks = (await p.search(q)) || []; }
      catch (e) { return res('play_song', false, 'play_song("' + q + '")：搜索出错', null); }
      if (!tracks.length) return res('play_song', false, 'play_song("' + q + '")：没找到 ' + q, '没找到《' + q + '》');
      var t = tracks[0];
      // 传完整 MusicTrack 给桥接 playTrack（携带 name/cover/artist），不依赖全局 playlist 池
      // 跨 await 存活——避免流式编排中 playStageIndex 偶发越界退化为无元数据最小对象。
      var r;
      try { r = await p.playTrack(t); }
      catch (e) { return res('play_song', false, 'play_song("' + q + '")：播放出错', null); }
      if (r && r.ok) {
        return res('play_song', true,
          'play_song("' + q + '")：已开始播放《' + t.name + '》，并展示 ' + tracks.length + ' 首搜索结果',
          '▶《' + t.name + '》');
      }
      return res('play_song', false,
        'play_song("' + q + '")：《' + t.name + '》没能播放（' + ((r && r.reason) || '未知') + '）', null);
    },
    play_stage_index: async function (args) { // 坑①：1-based → 0-based
      var p = player(); if (!p) return res('play_stage_index', false, 'play_stage_index：播放器未就绪');
      var idx1 = Number(args.index);
      if (!isFinite(idx1)) return res('play_stage_index', false, 'play_stage_index：index 非法');
      var r = await p.playStageIndex(toIndex0(idx1));
      if (r && r.ok) return res('play_stage_index', true, 'play_stage_index(' + idx1 + ')：已播放第 ' + idx1 + ' 首', '▶ 第 ' + idx1 + ' 首');
      return res('play_stage_index', false, 'play_stage_index(' + idx1 + ')：第 ' + idx1 + ' 首不存在（越界）', null);
    },
    queue_add_index: async function (args) { // 坑①：1-based → 0-based
      var p = player(); if (!p) return res('queue_add_index', false, 'queue_add_index：播放器未就绪');
      var idx1 = Number(args.index);
      if (!isFinite(idx1)) return res('queue_add_index', false, 'queue_add_index：index 非法');
      var r = p.queueAdd(toIndex0(idx1));
      if (r && r.ok) {
        return r.started
          ? res('queue_add_index', true, 'queue_add_index(' + idx1 + ')：第 ' + idx1 + ' 首已入队并开始播放', '▶ 第 ' + idx1 + ' 首')
          : res('queue_add_index', true, 'queue_add_index(' + idx1 + ')：第 ' + idx1 + ' 首已入队', '＋ 入队');
      }
      return res('queue_add_index', false, 'queue_add_index(' + idx1 + ')：第 ' + idx1 + ' 首不存在', null);
    },
    queue_add_song: async function (args) { // 坑②：{query} → search → tracks[0] → queueAdd
      var p = player(); if (!p) return res('queue_add_song', false, 'queue_add_song：播放器未就绪');
      var q = qstr(args); if (!q) return res('queue_add_song', false, 'queue_add_song：缺 query');
      var tracks;
      try { tracks = (await p.search(q)) || []; }
      catch (e) { return res('queue_add_song', false, 'queue_add_song("' + q + '")：搜索出错', null); }
      if (!tracks.length) return res('queue_add_song', false, 'queue_add_song("' + q + '")：没搜到 ' + q, '没找到《' + q + '》');
      var t = tracks[0];
      // 传完整 MusicTrack 入队（桥接已携带 name/cover/artist 等元数据）。
      var r = p.queueAdd(t);
      if (r && r.ok) {
        return r.started
          ? res('queue_add_song', true, 'queue_add_song("' + q + '")：《' + t.name + '》已入队并开始播放', '▶《' + t.name + '》')
          : res('queue_add_song', true, 'queue_add_song("' + q + '")：《' + t.name + '》已入队', '＋《' + t.name + '》');
      }
      return res('queue_add_song', false, 'queue_add_song("' + q + '")：《' + t.name + '》入队失败', null);
    },

    /* ── 天气（查天气：拉预报 + 回灌 + 出卡片，不切天气电台） ── */
    show_weather: async function (args) {
      if (!AI.getWeatherForecast) return res('show_weather', false, 'show_weather：天气接口未就绪');
      var city = (args && typeof args.city === 'string') ? args.city.trim() : '';
      var days = (args && typeof args.days === 'number' && isFinite(args.days)) ? Math.max(1, Math.min(7, Math.round(args.days))) : 3;
      var data;
      try { data = await AI.getWeatherForecast(city || undefined, days); }
      catch (e) { return res('show_weather', false, 'show_weather(' + (city || '当前城市') + ')：天气获取失败', null); }
      var now = data && data.now;
      if (!now) return res('show_weather', false, 'show_weather：天气数据为空', null);
      var loc = (data.location && data.location.name) || city || '当前城市';
      var daily = (data.daily || []).slice(0, days);
      var rangeLabel = (daily.length <= 1) ? '今天' : ('未来' + daily.length + '天');
      // 逐日明细写进回灌——让 dube 准确知道自己显示了几天，避免被追问时瞎编"调成一周了"
      var dayBits = daily.map(function (d, i) {
        var lab = (i === 0) ? '今天' : (i === 1) ? '明天' : ((d.fxDate || '').slice(5).replace('-', '/'));
        return lab + (d.textDay || '') + ' ' + (d.tempMin || '') + '~' + (d.tempMax || '') + '°';
      });
      var summary = 'show_weather(' + loc + '，' + rangeLabel + ')：当前' + (now.text || '') + (now.temp || '') + '°' +
        '（体感' + (now.feelsLike || now.temp || '') + '°，' + (now.windDir || '') + (now.windScale || '') + '级，湿度' + (now.humidity || '') + '%）' +
        '；' + dayBits.join('、');
      var r = res('show_weather', true, summary, null);
      // 结构化天气数据 → ai-overlay 在对话里渲染天气卡片
      r.weather = { location: loc, range: rangeLabel, now: now, daily: daily, updateTime: data.updateTime };
      return r;
    },

    /* ── 改名（坑③：不改 UI 名，真名读 done.assistant_name） ── */
    set_assistant_name: async function (args) {
      var name = (args && typeof args.name === 'string') ? args.name.trim() : '';
      if (!name) return res('set_assistant_name', false, 'set_assistant_name：缺 name');
      // 不在此改 UI 名：真名以本轮 done.assistant_name 为准（异步落库，可能下一轮才进 done）。
      // chip 只在「真的发生改名」时出——这是唯一可靠的改名信号（用户当轮明确请求改名，
      // LLM 才会调本工具）。finishTurn 不再据 done 差异补 chip，避免初始名与持久名不一致的假报。
      return res('set_assistant_name', true,
        'set_assistant_name("' + name + '")：改名请求已发出（真名以本轮 done 为准）',
        '已改名为 ' + name);
    },

    /* ── 队列编辑 / 播放模式 / 好恶（plans/07）── */
    queue_remove: async function (args) { // 坑①：1-based → 0-based
      var p = player(); if (!p) return res('queue_remove', false, 'queue_remove：播放器未就绪');
      var idx1 = Number(args.index);
      if (!isFinite(idx1)) return res('queue_remove', false, 'queue_remove：index 非法');
      var r = p.queueRemove(toIndex0(idx1));
      if (r && r.ok) return res('queue_remove', true,
        'queue_remove(' + idx1 + ')：已移除队列第 ' + idx1 + ' 首《' + (r.name || '') + '》',
        '✖ 移除《' + (r.name || ('第' + idx1 + '首')) + '》');
      return res('queue_remove', false, 'queue_remove(' + idx1 + ')：第 ' + idx1 + ' 首不存在（越界）', null);
    },
    queue_clear: async function () {
      var p = player(); if (!p) return res('queue_clear', false, 'queue_clear：播放器未就绪');
      var r = p.queueClear();
      var n = (r && r.cleared) || 0;
      return res('queue_clear', true, 'queue_clear：已清空队列（' + n + ' 首）并停止播放', '🗑 清空队列');
    },
    play_queue_index: async function (args) { // 坑①：1-based → 0-based；区别于 play_stage_index(搜索结果)
      var p = player(); if (!p) return res('play_queue_index', false, 'play_queue_index：播放器未就绪');
      var idx1 = Number(args.index);
      if (!isFinite(idx1)) return res('play_queue_index', false, 'play_queue_index：index 非法');
      var r = await p.playQueueIndex(toIndex0(idx1));
      if (r && r.ok) return res('play_queue_index', true,
        'play_queue_index(' + idx1 + ')：已播放队列第 ' + idx1 + ' 首《' + (r.name || '') + '》',
        '▶ 队列第 ' + idx1 + ' 首');
      return res('play_queue_index', false, 'play_queue_index(' + idx1 + ')：队列第 ' + idx1 + ' 首不存在', null);
    },
    set_play_mode: async function (args) {
      var p = player(); if (!p) return res('set_play_mode', false, 'set_play_mode：播放器未就绪');
      var mode = (args && typeof args.mode === 'string') ? args.mode.trim() : '';
      var LABEL = { loop: '顺序循环', single: '单曲循环', shuffle: '随机播放' };
      if (!LABEL[mode]) return res('set_play_mode', false, 'set_play_mode：未知模式「' + mode + '」', null);
      var r = p.setPlayMode(mode);
      if (r && r.ok) return res('set_play_mode', true, 'set_play_mode：播放模式 → ' + LABEL[mode], '🔁 ' + LABEL[mode]);
      return res('set_play_mode', false, 'set_play_mode：设置失败', null);
    },
    rate_song: async function (args) {
      var p = player(); if (!p) return res('rate_song', false, 'rate_song：播放器未就绪');
      var liked = !!(args && args.liked);
      var cur = (typeof p.getCurrentTrack === 'function') ? p.getCurrentTrack() : null;
      if (!cur || !cur.name) return res('rate_song', false, 'rate_song：当前没有在播的歌，无法记录好恶', null);
      try { p.reportEvent(liked ? 'like' : 'unlike'); }
      catch (e) { return res('rate_song', false, 'rate_song：埋点失败', null); }
      return liked
        ? res('rate_song', true, 'rate_song(like)：已记《' + cur.name + '》为喜欢（影响推荐）', '👍 喜欢《' + cur.name + '》')
        : res('rate_song', true, 'rate_song(dislike)：已记《' + cur.name + '》为不爱听（影响推荐）', '👎 不爱听《' + cur.name + '》');
    },
    remove_current: async function () {
      var p = player(); if (!p) return res('remove_current', false, 'remove_current：播放器未就绪');
      var r = p.removeCurrent();
      if (r && r.ok) {
        return r.emptied
          ? res('remove_current', true, 'remove_current：已移除《' + (r.name || '') + '》，队列已空、停止播放', '✖《' + (r.name || '当前') + '》（队列空）')
          : res('remove_current', true, 'remove_current：已切下一首并移除《' + (r.name || '') + '》', '⏭ 切歌+移除《' + (r.name || '当前') + '》');
      }
      return res('remove_current', false, 'remove_current：当前没有在播的歌', null);
    },
  };

  /**
   * dispatchTool(name, args) → Promise<ToolResult{ name, ok, summary, chip }>
   * 防御：args 非对象归一为 {}；未知工具 / 异常都回灌失败 summary，绝不抛。
   */
  async function dispatchTool(name, args) {
    args = (args && typeof args === 'object') ? args : {};
    var h = HANDLERS[name];
    if (!h) return res(name || 'unknown', false, '未知工具：' + name, null);
    try {
      var r = await h(args);
      reportState(); // DSH：工具执行后把播放器最新状态上报瘦身后端（§4.3 状态快照通道）
      return r;
    } catch (e) { return res(name, false, name + '：执行异常（' + ((e && e.message) || e) + '）', null); }
  }

  /**
   * DSH overlay（§4.3）：把浏览器播放器的当前状态快照推给瘦身后端（/api/player/state），
   * 供阿呆的 music_get_state 工具读取。浏览器播放器 = 唯一真相源。
   * 防御：读取/上报任何失败都静默（不打断播放器/不破工具路径）。
   */
  function reportState() {
    try {
      var p = player(); if (!p) return;
      var snapshot = { playing: false, now_playing: null, queue: [], search_results: [] };
      var cur = (typeof p.getCurrentTrack === 'function') ? p.getCurrentTrack() : null;
      if (cur && typeof cur === 'object') {
        snapshot.now_playing = {
          name: cur.name || '',
          artist: Array.isArray(cur.artists) ? cur.artists.join(' / ') : (cur.artist || cur.artists || ''),
          album: cur.album || '',
          id: String(cur.id || cur.song_id || ''),
          provider: cur.provider || ''
        };
      }
      try {
        snapshot.playing = !!(p.isPlaying && typeof p.isPlaying === 'function' ? p.isPlaying() : (cur && cur.name));
      } catch (e2) { snapshot.playing = !!(cur && cur.name); }
      try {
        var q = (typeof p.getQueue === 'function') ? p.getQueue() : null;
        if (Array.isArray(q)) snapshot.queue = q.map(function (t) { return (t && typeof t === 'object') ? (t.name || '') : String(t || ''); }).filter(Boolean);
      } catch (e3) { /* queue 可选，失败忽略 */ }
      var uid = (AI.getUserId && AI.getUserId()) || '';
      if (!uid) return;
      fetch('/api/player/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: uid, snapshot: snapshot })
      }).catch(function () {});
    } catch (e) { /* 上报绝不影响播放器 */ }
  }

  // DSH 快照通道：暴露给播放器主逻辑（app.js syncPlaybackStateFromAudioEvent 在
  // 播放/暂停/切歌/结束等状态变化时调用），让「用户手动操作 UI 切歌/暂停」也能把
  // 最新快照推给后端（原来只有工具执行后推，手动操作会使快照过期 -> music_get_state 报旧曲目）。
  window.__regretReportState = reportState;
  // 挂载即同步一次当前快照（兜底加载时序：无论 tool-dispatch 在播放器就绪前后加载，
  // 只要它一就绪就把「当前真实播放状态」推给后端一次）。
  try { reportState(); } catch (e) { /* 静默 */ }

  AI.dispatchTool = dispatchTool;
  AI.TOOL_NAMES = [
    'player_next', 'player_prev', 'player_toggle', 'player_volume',
    'search_music', 'play_song', 'play_stage_index', 'queue_add_index',
    'queue_add_song', 'show_weather', 'set_assistant_name',
    'queue_remove', 'queue_clear', 'play_queue_index', 'set_play_mode',
    'rate_song', 'remove_current', 'player_pause', 'player_play',
  ];
})();
