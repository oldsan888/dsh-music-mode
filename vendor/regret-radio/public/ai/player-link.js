/**
 * player-link.js · Regret-radio 播放器在场通道（阶段 B，plans/2026-07-07）
 *
 * 浏览器开页面即挂一条长连 SSE（GET /api/player/link?user_id=）→ 后端知道「有能执行的播放器」。
 * 飞书这类无播放器的通道触发音乐动作时，后端把命令推到这条 SSE：
 *   收到 `command` 事件 → 复用 AI.dispatchTool（同 web 聊天工具执行路径）→ POST /api/player/ack 回执。
 *
 * 只依赖 AI.dispatchTool / AI.getUserId（tool-dispatch.js、ai-client.js 已先加载）+ window.RegretRadio（桥接）。
 * EventSource 自带断线重连；本模块再兜一层退避重连，保证页面开着就一直在场。
 */
(function () {
  'use strict';
  var AI = (window.RegretRadioAI = window.RegretRadioAI || {});

  var es = null;
  var backoff = 1000;
  var stopped = false;

  function ack(commandId, ok, result) {
    try {
      fetch('/api/player/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command_id: commandId, ok: !!ok, result: result || '' })
      }).catch(function () {});
    } catch (e) {}
  }

  function onCommand(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || !msg.command_id || !msg.name) return;
    var run;
    try {
      run = (AI.dispatchTool)
        ? AI.dispatchTool(msg.name, msg.args || {})
        : Promise.resolve({ ok: false, summary: 'dispatchTool 未就绪' });
    } catch (e) {
      run = Promise.resolve({ ok: false, summary: '执行异常：' + ((e && e.message) || e) });
    }
    Promise.resolve(run).then(
      function (r) { ack(msg.command_id, !!(r && r.ok), (r && r.summary) || ''); },
      function (e) { ack(msg.command_id, false, '执行异常：' + ((e && e.message) || e)); }
    );
  }

  // 到点提醒（plans/2026-07-07-scheduled-tasks 阶段1）：后端调度器到点推 `notify` 事件 →
  // 弹 dube 味 toast + 面板开着则落一条气泡。单向展示、无需 ACK（区别于 command）。
  // 阶段5 主动搭话（kind='proactive'）加两道前端闸：dube 正在流式回复时丢弃（宁静默不插嘴，
  // 后端「别插嘴」闸的双保险）；按 log_id 页签内去重（pushNotify 对全部连接广播；跨页签重复 v1 接受）。
  var seenProactive = {};
  function onNotify(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || !msg.text) return;
    if (msg.kind === 'proactive') {
      if (window.__dubeStreaming) return; // 正在对话，主动搭话直接放弃（不延迟补发）
      if (msg.log_id) {
        if (seenProactive[msg.log_id]) return;
        seenProactive[msg.log_id] = 1;
      }
    }
    try {
      if (AI.showReminder) AI.showReminder(msg.text);
      else if (typeof showToast === 'function') showToast(msg.text); // ai-overlay 未就绪的兜底
    } catch (e) {}
  }

  function reconnectLater() {
    if (stopped) return;
    var wait = Math.min(backoff, 15000);
    backoff = Math.min(backoff * 2, 15000);
    setTimeout(connect, wait);
  }

  function connect() {
    if (stopped) return;
    var uid = (AI.getUserId && AI.getUserId()) || '';
    if (!uid) { setTimeout(connect, 2000); return; } // 身份未就绪，稍后重试
    try {
      es = new EventSource('/api/player/link?user_id=' + encodeURIComponent(uid));
    } catch (e) { reconnectLater(); return; }
    es.addEventListener('command', onCommand);
    es.addEventListener('notify', onNotify);
    es.onopen = function () { backoff = 1000; }; // 连上即重置退避
    es.onerror = function () {
      // EventSource 会自动重连（readyState=CONNECTING）；仅当彻底 CLOSED 才手动退避重连。
      if (es && es.readyState === 2 /* CLOSED */) {
        try { es.close(); } catch (e2) {}
        es = null;
        reconnectLater();
      }
    };
  }

  // 页面加载即挂（在场通道）；window.RegretRadio 桥接与 ai-client / tool-dispatch 已先执行。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }
})();
