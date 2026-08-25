/**
 * sse-client.js · Regret-radio AI 叠加层流式对话（M4-1）
 *
 * 移植自 Regretio voice-client.ts streamChat：fetch + ReadableStream 手写 SSE 解析
 * + AbortController（barge-in 用）。挂到 window.RegretRadioAI.streamChat。
 *
 * 后端契约（apps/backend src/server.ts /api/chat/stream，见 plans/05 §1.1）：
 *   事件序列 meta → (sentence|audio|tool|tts_error 按 seq 交错) → done|error。
 *   SSE 帧 = "event: <kind>\ndata: <json>\n\n"，<json> 为事件对象剔除 kind。
 *   meta 永远第一、HTTP 层手写（不在 StreamEvent 联合里，易漏）。
 */
(function () {
  'use strict';
  var AI = (window.RegretRadioAI = window.RegretRadioAI || {});

  function base64ToBlob(b64, mime) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  /**
   * streamChat(input, handlers, signal)
   *
   * @param input    {{ user_id, user_message, session_id?, conversation_id?, voice?, recent_tool_results? }}
   * @param handlers {{ onMeta?, onSentence?(text,seq), onAudio?(wavBlob,seq,text),
   *                     onTool?(name,args), onTtsError?(fullText), onDone?(info), onError?(message) }}
   * @param signal   AbortSignal（可选，barge-in 时 abort 中断本轮）
   * @returns Promise<void>（流读完或被 abort 后 resolve；abort 会抛 AbortError，调用方需 catch）
   */
  async function streamChat(input, handlers, signal) {
    handlers = handlers || {};
    var r = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: signal,
    });
    if (!r.ok || !r.body) {
      var errText = '';
      try { errText = await r.text(); } catch (e) {}
      throw new Error('stream ' + r.status + ': ' + errText);
    }

    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });

      // SSE 事件以 \n\n 分隔
      var idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        var block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        var event = 'message';
        var data = '';
        var lines = block.split('\n');
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
        }
        if (!data) continue;

        var payload;
        try { payload = JSON.parse(data); } catch (e) { continue; }

        switch (event) {
          case 'meta':
            if (handlers.onMeta) handlers.onMeta(payload);
            break;
          case 'thinking':
            if (handlers.onThinking) handlers.onThinking(payload.text || '');
            break;
          case 'message':
            // 多条信息：从第 2 条起，在其首句之前收到，前端据此另起一个气泡。
            if (handlers.onMessage) handlers.onMessage(payload.index);
            break;
          case 'sentence':
            if (handlers.onSentence) handlers.onSentence(payload.text, payload.seq);
            break;
          case 'audio': {
            var wav = base64ToBlob(payload.wav_b64, 'audio/wav');
            if (handlers.onAudio) handlers.onAudio(wav, payload.seq, payload.text);
            break;
          }
          case 'tool':
            if (handlers.onTool) handlers.onTool(payload.name, payload.args || {});
            break;
          case 'tts_error':
            if (handlers.onTtsError) handlers.onTtsError(payload.full_text || '');
            break;
          case 'done':
            if (handlers.onDone) handlers.onDone(payload);
            break;
          case 'error':
            if (handlers.onError) handlers.onError(payload.message);
            break;
        }
      }
    }
  }

  AI.streamChat = streamChat;
  AI._base64ToBlob = base64ToBlob;
})();
