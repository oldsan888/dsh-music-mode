/**
 * voice-player.js · Regret-radio AI 叠加层语音播放（M4-2）
 *
 * 移植 Regretio voice-client.ts createVoicePlayer（WAV blob 按 seq 顺序播 +
 * setStreamActive 缓冲闸 + stop 打断），并净新增两件原参考实现没有的能力：
 *   - ducking：dube 说话时压低音乐主增益，说完还原（经桥接 setVolume/getVolume）；
 *   - barge-in：stop() 清队列停播 + 触发 onStateChange(false) 还原音乐。
 *
 * 只经 window.RegretRadio.player 操作音乐，绝不直读内部全局（ADR-4）。
 * TTS 走独立 new Audio() 元素（满音量），music 走主增益（ducking 时压低）——
 * 两路分离，互不打架（plans/05 §5）。
 */
(function () {
  'use strict';
  var AI = (window.RegretRadioAI = window.RegretRadioAI || {});

  /* ─────────── 移植：WAV blob seq 顺序播放队列 ─────────── */
  function createVoicePlayer() {
    var queue = [];
    var audio = null;
    var currentUrl = null; // 当前正在播的 objectURL——stop() 必须显式 revoke（否则每次 barge-in 泄漏一个 Blob）
    var playing = false;
    // 闸4：流是否仍在进行。队列排空但流未结束时停在缓冲态（waiting）而非报"说完了"，
    // 避免"播着突然停 / 播完又冒一段"的观感；下一段到了能无缝续上。
    var streamActive = false;
    var waiting = false; // 队列已排空，正等待后续音频
    var onStateChange = null;

    function playNext() {
      var next = queue.shift();
      if (!next) {
        if (streamActive) { waiting = true; return; } // 流还在，保持播放态等下一段
        playing = false;
        waiting = false;
        if (onStateChange) onStateChange(false);
        return;
      }
      waiting = false;
      var url = URL.createObjectURL(next.blob);
      currentUrl = url;
      audio = new Audio(url);
      audio.onended = function () { URL.revokeObjectURL(url); if (currentUrl === url) currentUrl = null; playNext(); };
      audio.onerror = function () { URL.revokeObjectURL(url); if (currentUrl === url) currentUrl = null; playNext(); }; // 跳坏句
      audio.play().catch(function () { playNext(); });
    }

    return {
      enqueue: function (blob, seq) {
        queue.push({ blob: blob, seq: seq });
        queue.sort(function (a, b) { return a.seq - b.seq; });
        if (!playing) {
          playing = true;
          if (onStateChange) onStateChange(true);
          playNext();
        } else if (waiting) {
          playNext(); // 之前排空进缓冲态，现在有新音频续播
        }
      },
      /** 标记本轮音频流是否还会有后续（闸4）。done/tts_error/error 三处都要置 false。 */
      setStreamActive: function (active) {
        streamActive = active;
        if (!active && waiting && queue.length === 0) {
          playing = false;
          waiting = false;
          if (onStateChange) onStateChange(false);
        }
      },
      stop: function () {
        queue.length = 0;
        if (audio) {
          // 摘掉回调再暂停：否则 pause 触发的收尾回调可能又调 playNext 续播；
          try { audio.onended = null; audio.onerror = null; audio.pause(); } catch (e) {}
        }
        // 关键：显式 revoke 当前正在播的 objectURL。暂停不触发 onended，此处不 revoke 就每次
        // barge-in 泄漏一个 Blob URL（长会话高频路径，累积可观）。
        if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
        audio = null;
        playing = false;
        waiting = false;
        streamActive = false;
        if (onStateChange) onStateChange(false);
      },
      isPlaying: function () { return playing; },
      setOnStateChange: function (cb) { onStateChange = cb; },
    };
  }

  /* ─────────── 净新增：音乐 ducking 控制器（经桥接操作音乐主增益） ─────────── */
  function createDuckController(opts) {
    opts = opts || {};
    var factor = (typeof opts.factor === 'number') ? opts.factor : 0.2;
    var ducked = false;
    var savedVol = null;
    function player() { return (window.RegretRadio && window.RegretRadio.player) || null; }
    return {
      duck: function () {
        if (ducked) return; // 已压低则不重复保存（防把 0.2 当原值）
        var p = player();
        if (!p || typeof p.getVolume !== 'function') return;
        savedVol = p.getVolume();
        if (savedVol == null) return;
        ducked = true;
        try { p.setVolume(Math.max(0, savedVol * factor)); } catch (e) {}
      },
      restore: function () {
        if (!ducked) return;
        var p = player();
        ducked = false;
        var v = savedVol;
        savedVol = null;
        if (p && v != null) { try { p.setVolume(v); } catch (e) {} }
      },
      isDucked: function () { return ducked; },
    };
  }

  /* ─────────── 组合：DJ 语音控制器（player + ducking + barge-in） ─────────── */
  function createDjVoice(opts) {
    opts = opts || {};
    var vp = createVoicePlayer();
    var duck = createDuckController(opts);
    var onSpeak = (typeof opts.onSpeakingChange === 'function') ? opts.onSpeakingChange : null;
    vp.setOnStateChange(function (speaking) {
      if (speaking) duck.duck(); else duck.restore();
      if (onSpeak) { try { onSpeak(speaking); } catch (e) {} }
    });
    return {
      enqueueAudio: function (blob, seq) { vp.enqueue(blob, seq); },
      setStreamActive: function (active) { vp.setStreamActive(active); },
      // barge-in：停播 + 还原音乐（onStateChange(false) → duck.restore）。
      // 进行中 streamChat 的 AbortController.abort() 由调用方（ai-overlay）负责。
      stop: function () { vp.stop(); },
      isSpeaking: function () { return vp.isPlaying(); },
      isDucked: function () { return duck.isDucked(); },
      _player: vp,
      _duck: duck,
    };
  }

  /* ─────────── autoplay / AudioContext 解锁（首次用户手势时调） ─────────── */
  // 保 TTS 首段有声 + STT 的 decodeAudioData 可用（plans/05 §5）。
  var _unlockCtx = null;
  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!_unlockCtx) _unlockCtx = new Ctx();
      if (_unlockCtx.state === 'suspended') _unlockCtx.resume();
    } catch (e) {}
  }

  Object.assign(AI, {
    createVoicePlayer: createVoicePlayer,
    createDuckController: createDuckController,
    createDjVoice: createDjVoice,
    unlockAudio: unlockAudio,
  });
})();
