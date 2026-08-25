/**
 * ai-client.js · Regret-radio AI 叠加层 REST 客户端（M4-1）
 *
 * 移植自 Regretio 前端 voice-client.ts / memory-client.ts，去 TypeScript、改挂
 * window.RegretRadioAI 命名空间（无构建、原生 <script> 引入，ADR-4 叠加层独立）。
 *
 * 职责：身份/会话（localStorage 单机单用户）+ 运行时配置/设置 + 会话生命周期
 *       + STT（MiMo ASR 要 PCM16LE WAV）+ 记忆 CRUD。
 * 流式对话（SSE）在 sse-client.js；播放器驱动一律经 window.RegretRadio（桥接）。
 *
 * 所有请求走相对路径 /api/*：dev 经 dev-server 反代到 :8090，prod 同源（M5）。
 */
(function () {
  'use strict';
  var AI = (window.RegretRadioAI = window.RegretRadioAI || {});

  /* ─────────────── 身份 / 会话（localStorage，单机单用户 Q7） ─────────────── */
  var USER_KEY = 'regretradio.user_id';
  var SESSION_KEY = 'regretradio.session_id';
  // DSH overlay：播放器 SSE 身份默认与 @deepseek-ai/dsh-tool-music 的默认 userId
  // 对齐；部署者可自定义（非空值写入 localStorage regretradio.user_id），见 README
  // 「Deployer: player user_id is configurable」。必须与 tool-music config.userId 一致。
  var DEFAULT_USER_ID = 'default';

  function rid(prefix) {
    return prefix + Math.random().toString(36).slice(2, 10);
  }
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  function getUserId() {
    // DSH overlay（2026-08-19，可部署化）：播放器 SSE 身份必须与 DSH 阿呆音乐
    // 工具（tool-music）的 user_id 一致，否则 relayPlayerCommand 找不到播放器。
    // 优先级：① 部署者自定义（localStorage regretradio.user_id 非空值，由部署的
    // AI 询问用户后写入）；② 默认 DEFAULT_USER_ID（与 tool-music 默认一致）。
    // 兼容：上游原版会把未设置的 localStorage 落成随机 u_* 身份（'u_' + 8 位
    // base36，长度约 5-14），会把它与 tool-music 默认错开 → 迁移为默认。
    var stored = lsGet(USER_KEY);
    if (typeof stored === 'string' && stored.trim()) {
      // 形如上游随机 u_*（'u_' 前缀 + 短 base36，长度约 5-14）→ 迁移默认；
      // 其余非空值视为部署者自定义身份，原样采用。
      var legacyRandom = stored.slice(0, 2) === 'u_' && stored.length <= 14;
      if (!legacyRandom) return stored.trim();
    }
    lsSet(USER_KEY, DEFAULT_USER_ID);
    return DEFAULT_USER_ID;
  }
  function getSessionId() {
    var id = lsGet(SESSION_KEY);
    if (!id) { id = rid('sess_'); lsSet(SESSION_KEY, id); }
    return id;
  }
  function rotateSessionId() {
    var id = rid('sess_');
    lsSet(SESSION_KEY, id);
    return id;
  }
  /** meta 事件回填后端真实 session_id，写回 localStorage 以便下次续话。 */
  function setSessionId(id) {
    if (id) lsSet(SESSION_KEY, id);
  }

  /* ─────────────── 当前助手名（单一真相源，供 overlay / discover / memory-panel 共用） ─────────────── */
  // 出厂默认 'dube'（与后端 DEFAULT_ASSISTANT_NAME 一致）；用户未起名时各处显示 dube，
  // 改名后（工具改名 / done 校正 / 配置加载）由写入方调 setAssistantName，广播 rr-ai:name 让各模块刷新文案。
  var assistantNameState = 'dube';
  function getAssistantName() {
    return assistantNameState;
  }
  function setAssistantName(name) {
    var n = (name == null ? '' : String(name)).trim() || 'dube';
    if (n === assistantNameState) return;
    assistantNameState = n;
    try {
      document.dispatchEvent(new CustomEvent('rr-ai:name', { detail: { name: n } }));
    } catch (e) {}
  }

  /* ─────────────── 运行时配置 / 用户设置 ─────────────── */
  async function getRuntimeConfig(userId) {
    try {
      var qs = userId ? '?user_id=' + encodeURIComponent(userId) : '';
      var res = await fetch('/api/config' + qs);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function updateSettings(userId, patch) {
    var res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ user_id: userId }, patch || {})),
    });
    if (!res.ok) {
      var msg = await res.json().catch(function () { return {}; });
      throw new Error((msg && msg.error) || ('设置更新失败 (' + res.status + ')'));
    }
    return await res.json();
  }

  /* ─────────────── 音乐建议（LLM 增强发现，按钮触发） ─────────────── */
  // GET /api/discover/home/ai —— 成功 { ...基线, dailySongs(重排), dj, picks:[{id,why}], enhanced:true, djAudio? }；
  // 降级 { ...基线, enhanced:false, reason }（no_user/not_logged_in/cold_start/rerank_unavailable/ai_error）。
  // tts=1 时附 djAudio（命中发现缓存、仅合成短句朗读）。严禁页面 mount 自调——只在用户按钮点击后请求。
  async function getDiscoverAi(userId, opts) {
    var uid = userId || getUserId();
    var qs = new URLSearchParams({ user_id: uid });
    if (opts && opts.tts) qs.set('tts', '1');
    // 朗读音色由后端按用户 settings.voice_mode 决定，不再从前端传 voice（旧硬编码已废）。
    var r = await fetch('/api/discover/home/ai?' + qs.toString());
    if (!r.ok) throw new Error('discover ' + r.status + ': ' + (await r.text().catch(function () { return ''; })));
    return r.json();
  }

  /* ─────────────── 天气预报（查天气） ─────────────── */
  async function getWeatherForecast(city, days) {
    var qs = new URLSearchParams();
    if (city) qs.set('city', city);
    if (days) qs.set('days', String(days));
    var s = qs.toString();
    var r = await fetch('/api/weather' + (s ? '?' + s : ''));
    if (!r.ok) throw new Error('weather ' + r.status + ': ' + (await r.text().catch(function () { return ''; })));
    return r.json();
  }

  /* ─────────────── 会话生命周期 ─────────────── */
  async function startNewChat(userId, oldSessionId) {
    var r = await fetch('/api/conversation/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, session_id: oldSessionId }),
    });
    if (!r.ok) throw new Error('new chat ' + r.status);
    return r.json();
  }

  /** FORGET ME：永久删除全部用户数据。 */
  async function forgetMe(userId) {
    var r = await fetch('/api/users/' + encodeURIComponent(userId) + '/data', { method: 'DELETE' });
    if (!r.ok) throw new Error('forget me ' + r.status);
    return r.json();
  }

  /* ─────────────── STT（MiMo ASR 不收 webm/opus，需 WAV PCM16LE） ─────────────── */
  function encodeWav(buffer) {
    var sampleRate = buffer.sampleRate;
    var numCh = 1; // 下采样到单声道
    var len = buffer.length;
    var mixed = new Float32Array(len);
    for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
      var data = buffer.getChannelData(ch);
      for (var i = 0; i < len; i++) mixed[i] += data[i] / buffer.numberOfChannels;
    }
    var pcm = new Int16Array(len);
    for (var k = 0; k < len; k++) {
      var s = Math.max(-1, Math.min(1, mixed[k]));
      pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    var dataSize = pcm.byteLength;
    var buf = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buf);
    var writeStr = function (off, str) {
      for (var n = 0; n < str.length; n++) view.setUint8(off + n, str.charCodeAt(n));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numCh * 2, true);
    view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer));
    return buf;
  }

  async function blobToWav(blob) {
    var arr = await blob.arrayBuffer();
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    var audioBuffer = await ctx.decodeAudioData(arr.slice(0));
    try { await ctx.close(); } catch (e) {}
    return new Blob([encodeWav(audioBuffer)], { type: 'audio/wav' });
  }

  async function sttUpload(blob) {
    var wav = await blobToWav(blob);
    var fd = new FormData();
    fd.append('audio', wav, 'in.wav');
    var r = await fetch('/api/stt', { method: 'POST', body: fd });
    if (!r.ok) {
      var t = await r.text().catch(function () { return ''; });
      throw new Error('STT ' + r.status + ': ' + t);
    }
    var j = await r.json();
    return j.text;
  }

  /* ─────────────── 记忆 CRUD ─────────────── */
  async function fetchMemories(userId, opts) {
    var uid = userId || getUserId();
    var params = new URLSearchParams({ user_id: uid });
    if (opts && opts.category) params.set('category', opts.category);
    if (opts && opts.status) params.set('status', opts.status);
    var r = await fetch('/api/memory?' + params.toString());
    if (!r.ok) throw new Error('fetch memories ' + r.status + ': ' + (await r.text().catch(function () { return ''; })));
    return r.json();
  }

  async function updateMemory(memoryId, patch) {
    var r = await fetch('/api/memory/' + encodeURIComponent(memoryId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ user_id: getUserId() }, patch || {})),
    });
    if (!r.ok) throw new Error('update memory ' + r.status + ': ' + (await r.text().catch(function () { return ''; })));
    var j = await r.json();
    return j.memory;
  }

  async function deleteMemory(memoryId) {
    var r = await fetch('/api/memory/' + encodeURIComponent(memoryId), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: getUserId() }),
    });
    if (!r.ok) throw new Error('delete memory ' + r.status + ': ' + (await r.text().catch(function () { return ''; })));
  }

  async function confirmMemory(memoryId) {
    var r = await fetch('/api/memory/' + encodeURIComponent(memoryId) + '/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: getUserId() }),
    });
    if (!r.ok) throw new Error('confirm memory ' + r.status + ': ' + (await r.text().catch(function () { return ''; })));
  }

  async function rejectMemory(memoryId) {
    var r = await fetch('/api/memory/' + encodeURIComponent(memoryId) + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: getUserId() }),
    });
    if (!r.ok) throw new Error('reject memory ' + r.status + ': ' + (await r.text().catch(function () { return ''; })));
  }

  /* ─────────────── 导出 ─────────────── */
  Object.assign(AI, {
    // 身份 / 会话
    getUserId: getUserId,
    getSessionId: getSessionId,
    rotateSessionId: rotateSessionId,
    setSessionId: setSessionId,
    // 当前助手名（未起名=dube；改名即广播 rr-ai:name）
    getAssistantName: getAssistantName,
    setAssistantName: setAssistantName,
    // 配置 / 设置
    getRuntimeConfig: getRuntimeConfig,
    updateSettings: updateSettings,
    // AI 发现 / 天气预报
    getDiscoverAi: getDiscoverAi,
    getWeatherForecast: getWeatherForecast,
    // 会话生命周期
    startNewChat: startNewChat,
    forgetMe: forgetMe,
    // STT
    sttUpload: sttUpload,
    blobToWav: blobToWav,
    // 记忆 CRUD
    fetchMemories: fetchMemories,
    updateMemory: updateMemory,
    deleteMemory: deleteMemory,
    confirmMemory: confirmMemory,
    rejectMemory: rejectMemory,
  });

  // 落真实单用户身份到桥接（M3 默认 'default' → localStorage 持久 id）。
  // 桥接 IIFE 已先于本脚本同步执行，window.RegretRadio 此时必在场。
  try {
    if (window.RegretRadio) window.RegretRadio.userId = getUserId();
  } catch (e) {}
})();
