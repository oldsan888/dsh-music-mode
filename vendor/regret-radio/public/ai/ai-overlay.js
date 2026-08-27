/**
 * ai-overlay.js · Regret-radio AI 叠加层主集成（M4-4）
 *
 * 把前几块（sse-client / voice-player / tool-dispatch / ai-client）编排起来，并完成
 * #playlist-panel 的「保壳换芯」：保留 id + 外层交互壳/全局选择器引用，运行期把 dube
 * 对话/记忆面板注入 #playlist-panel（旧内容已在 index.html 包进隐藏的 #playlist-legacy）。
 *
 * 编排主链路：用户投递（输入坞/语音/桥接 _emitUserMessage）→ barge-in 打断上一轮 →
 *   streamChat → 逐句字幕气泡 + 逐句 TTS（voice-player，含 ducking）+ 工具派发（→桥接）
 *   + 工具完成痕迹 chip + 慢编排进度态 + recent_tool_results 回灌 + done 改名。
 *
 * 所有播放器操作经 window.RegretRadio 桥接；不直读 playQueue/currentIdx（ADR-4）。
 */
(function () {
  'use strict';
  var AI = (window.RegretRadioAI = window.RegretRadioAI || {});

  /* ─────────────── 状态 ─────────────── */
  var dj = null;                // djVoice 实例（voice-player）
  var activeAbort = null;       // 进行中 streamChat 的 AbortController（barge-in 用）
  var activeTurn = null;        // 进行中 dube 回合句柄（抢发打断时清掉未产出内容的空壳气泡）
  var convId = null;            // meta 回填的 conversation_id
  var recentResults = [];       // 工具回灌摘要（滚动，发送时取 slice(-6)）
  var assistantName = 'assistant';
  var pastNames = {};           // 显示过的旧名集合——用于忽略后端滞后回传的旧 done.assistant_name
  // 深度思考开关（持久化）。MiMo 工具调用准确率在 Thinking 模式下显著更高（官方数据），代价是首响变慢。
  var deepThinking = (function () { try { return localStorage.getItem('regretradio.deep_thinking') === '1'; } catch (e) { return false; } })();
  // 详细模式开关（UI 展示密度，regretradio.dube_detail，dube-panel-chat-design.md §3.1）：
  // 开 = 回合内显示 think/tool 详细步骤；关 = 只显示指令与回复正文。与 deepThinking（控模型
  // Thinking，旧键）语义分离、互不影响。默认 false（简洁）。
  var detailMode = (function () { try { return localStorage.getItem('regretradio.dube_detail') === '1'; } catch (e) { return false; } })();
  var audioUnlocked = false;
  var curTab = 'chat';
  var memoryLoadToken = 0;
  var built = false;
  var els = {};                 // 关键 DOM 缓存

  /* ─────────────── 样式注入（AI UI 自带，避免改 index.html CSS） ─────────────── */
  function injectStyles() {
    if (document.getElementById('dube-style')) return;
    var css = [
      '#dube-panel{display:flex;flex-direction:column;height:72vh;max-height:calc(100vh - 108px);min-height:340px;color:#fff;font-size:13px}',
      '#dube-panel .dube-head{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 10px;flex:0 0 auto}',
      '#dube-panel .dube-head .fx-title{font-size:14px;letter-spacing:.5px}',
      '#dube-panel .dube-head .fx-sub{font-size:10.5px;color:rgba(255,255,255,.42);letter-spacing:.4px;margin-top:2px}',
      '#dube-panel .dube-head-act{display:flex;gap:6px;align-items:center;flex:0 0 auto}',
      // 表头动作按钮：紧凑图标方钮（省横向空间，留余地给后续按钮），靠 title 提示语义。
      // transition 已恢复（.18s，同全应用微交互节奏）。曾注记"过渡值永远卡在起点、根因另行立案"——已结案：
      // 不是本应用的 bug，是 preview 调试环境假象：无人观看预览时标签页 visibilityState=hidden，Chromium
      // 暂停渲染帧循环（rAF 一次不跑、document.timeline 冻结在 0），全页所有 CSS 过渡一律停在起点（面板外
      // 元素同样冻结），而类切换/样式重算不依赖帧时钟，故非过渡属性"瞬时生效"造成面板独坏的错觉。
      // 真机/可见页过渡一直健康（同面板 .panel-tab/.queue-item 带 transition 日用无恙，app.js rAF 主循环已
      // 排除嫌疑：其每帧只写 Three 场景与 #thumb-cover）。隐藏页里调过渡：用 getAnimations() seek/finish 验终态。
      '#dube-panel .dube-icobtn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:rgba(255,255,255,.78);font-size:14px;line-height:1;cursor:pointer;padding:0;transition:color .18s ease,border-color .18s ease,background-color .18s ease}',
      '#dube-panel .dube-icobtn:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.2);color:#fff}',
      // 切换态（思考/常开）：金色 active（同 dube 名字标签的香槟金）
      '#dube-panel .dube-icobtn.active{color:var(--champagne,#f4d28a);border-color:rgba(244,210,138,.55);background:rgba(244,210,138,.14)}',
      // 「清空」危险态：仅 hover 变红，避免误点；并与右侧「关闭」拉开距离 + 左侧细分隔线（危险区隔离，防串手）
      '#dube-panel .dube-icobtn.danger:hover{color:#ff9a9a;border-color:rgba(255,120,120,.5);background:rgba(255,90,90,.12)}',
      '#dube-panel .dube-icobtn.danger{margin-left:10px;position:relative}',
      "#dube-panel .dube-icobtn.danger::before{content:'';position:absolute;left:-8px;top:6px;bottom:6px;width:1px;background:rgba(255,255,255,.12)}",
      // 应用内确认弹窗（替代原生 confirm，玻璃质感对齐整套 UI）
      '.dube-confirm-mask{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(6,7,11,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:dubeConfirmFade .16s ease}',
      '@keyframes dubeConfirmFade{from{opacity:0}to{opacity:1}}',
      '.dube-confirm{width:min(360px,86vw);padding:20px 22px;border-radius:18px;color:#fff;font-size:13px;background:linear-gradient(145deg,rgba(31,32,35,.96),rgba(13,14,17,.96));border:1px solid rgba(255,255,255,.13);box-shadow:0 34px 100px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.08);animation:dubeConfirmPop .18s cubic-bezier(.16,1,.3,1)}',
      '@keyframes dubeConfirmPop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}',
      '.dube-confirm-title{font-size:15px;font-weight:600;letter-spacing:.4px;margin-bottom:9px}',
      '.dube-confirm-msg{font-size:12.5px;line-height:1.7;color:rgba(255,255,255,.62);white-space:pre-wrap}',
      '.dube-confirm-act{display:flex;justify-content:flex-end;gap:9px;margin-top:18px}',
      '.dube-confirm-btn{padding:7px 16px;border-radius:10px;font-size:12.5px;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:rgba(255,255,255,.8);font-family:inherit}',
      '.dube-confirm-btn.ghost:hover{background:rgba(255,255,255,.1)}',
      '.dube-confirm-btn.primary{border-color:rgba(244,210,138,.55);background:rgba(244,210,138,.14);color:var(--champagne,#f4d28a)}',
      '.dube-confirm-btn.danger{border-color:rgba(255,120,120,.5);background:rgba(255,90,90,.14);color:#ff9a9a}',
      '.dube-confirm-btn:focus{outline:none;box-shadow:0 0 0 2px rgba(244,210,138,.42)}',
      '.dube-confirm-btn.danger:focus{box-shadow:0 0 0 2px rgba(255,120,120,.48)}',
      '#dube-tabs{display:flex;gap:4px;flex:0 0 auto;margin-bottom:10px;padding:3px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07)}',
      '#dube-tabs .panel-tab{cursor:pointer;flex:1;justify-content:center;border-radius:9px}',
      '#dube-tabs .dube-tab-count{display:none;min-width:17px;height:17px;padding:0 5px;align-items:center;justify-content:center;border-radius:999px;background:rgba(244,210,138,.14);color:var(--champagne,#f4d28a);font-size:9.5px;font-variant-numeric:tabular-nums}',
      '#dube-tabs .dube-tab-count.show{display:inline-flex}',
      // 隐藏滚动条但保留滚动（滚轮/触控/拖拽仍可用），视觉更干净——同 track-detail-modal 的隐藏写法
      '#dube-chat-pane,#dube-memory-pane{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none}',
      '#dube-chat-pane::-webkit-scrollbar,#dube-memory-pane::-webkit-scrollbar{width:0;height:0;display:none}',
      '#dube-chat-list{display:flex;flex-direction:column;gap:12px;padding:2px 2px 8px}',
      // 听歌画像：把后台事件翻译成用户看得懂、能验证的结论，而不是只暴露数据库计数。
      '#dube-memory-pane .dube-mem-list{display:flex;flex-direction:column;gap:10px;padding:2px 2px 8px}',
      '#dube-memory-pane .dube-empty{color:rgba(255,255,255,.38);font-size:12px;text-align:center;padding:20px 8px}',
      '.dube-insight-hero{position:relative;overflow:hidden;padding:15px 15px 14px;border-radius:15px;background:linear-gradient(135deg,rgba(var(--fc-accent-rgb,0,245,212),.12),rgba(244,210,138,.07));border:1px solid rgba(var(--fc-accent-rgb,0,245,212),.18)}',
      '.dube-insight-hero::after{content:"";position:absolute;right:-22px;top:-32px;width:94px;height:94px;border-radius:50%;background:rgba(var(--fc-accent-rgb,0,245,212),.08);filter:blur(2px)}',
      '.dube-insight-kicker{display:flex;align-items:center;gap:7px;color:rgba(255,255,255,.52);font-size:10.5px;letter-spacing:.5px}',
      '.dube-insight-live{width:6px;height:6px;border-radius:50%;background:rgb(var(--fc-accent-rgb,0,245,212));box-shadow:0 0 0 4px rgba(var(--fc-accent-rgb,0,245,212),.10)}',
      '.dube-insight-title{position:relative;z-index:1;margin-top:7px;font-size:17px;font-weight:680;line-height:1.35;color:#fff}',
      '.dube-insight-desc{position:relative;z-index:1;margin-top:5px;color:rgba(255,255,255,.5);font-size:11px;line-height:1.55}',
      '.dube-insight-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}',
      '.dube-insight-metric{min-width:0;padding:10px 5px 9px;text-align:center;border-radius:11px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.075)}',
      '.dube-insight-metric strong{display:block;color:#fff;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.dube-insight-metric span{display:block;margin-top:3px;color:rgba(255,255,255,.42);font-size:9.5px;white-space:nowrap}',
      '.dube-insight-section{padding:12px 13px;border-radius:13px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075)}',
      '.dube-insight-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}',
      '.dube-insight-section-title{color:rgba(255,255,255,.82);font-size:11.5px;font-weight:650;letter-spacing:.25px}',
      '.dube-insight-section-note{color:rgba(255,255,255,.32);font-size:9.5px}',
      '.dube-insight-tags{display:flex;flex-wrap:wrap;gap:6px}',
      '.dube-insight-tag{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border-radius:999px;background:rgba(var(--fc-accent-rgb,0,245,212),.08);border:1px solid rgba(var(--fc-accent-rgb,0,245,212),.16);color:rgba(225,255,250,.82);font-size:10.5px}',
      '.dube-insight-tag.negative{background:rgba(255,130,130,.055);border-color:rgba(255,130,130,.14);color:rgba(255,190,190,.76)}',
      '.dube-insight-tag small{color:rgba(255,255,255,.34);font-size:9px}',
      '.dube-insight-empty-inline{color:rgba(255,255,255,.34);font-size:10.5px;line-height:1.55}',
      '.dube-insight-track-list,.dube-event-list{display:flex;flex-direction:column;gap:3px}',
      '.dube-insight-track,.dube-event-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 2px;border-bottom:1px solid rgba(255,255,255,.055)}',
      '.dube-insight-track:last-child,.dube-event-row:last-child{border-bottom:0}',
      '.dube-insight-track-icon,.dube-event-icon{width:23px;height:23px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:rgba(255,255,255,.055);color:var(--champagne,#f4d28a);font-size:10px}',
      '.dube-insight-track-main,.dube-event-main{min-width:0}',
      '.dube-insight-track-name,.dube-event-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.78);font-size:10.5px}',
      '.dube-insight-track-sub,.dube-event-sub{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.34);font-size:9.5px}',
      '.dube-insight-track-count,.dube-event-time{color:rgba(255,255,255,.38);font-size:9.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dube-insight-explain{font-size:10px;line-height:1.65;color:rgba(255,255,255,.38)}',
      '.dube-insight-explain strong{color:rgba(255,255,255,.65);font-weight:600}',
      '.dube-insight-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:1px 2px}',
      '.dube-insight-updated{color:rgba(255,255,255,.28);font-size:9.5px}',
      '#dube-memory-pane #dube-music-stat-refresh{height:27px;padding:0 11px;font-size:10px}',
      '@media(max-width:520px){.dube-insight-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '.dube-turn{display:flex;flex-direction:column;gap:6px}',
      '.dube-turn.user{align-items:flex-end}',
      '.dube-bubble{max-width:88%;padding:8px 12px;border-radius:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      '.dube-bubble.user{background:rgba(var(--fc-accent-rgb,0,245,212),.16);border:1px solid rgba(var(--fc-accent-rgb,0,245,212),.28);border-bottom-right-radius:4px}',
      '.dube-bubble.dube{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);border-bottom-left-radius:4px}',
      // 轻量 Markdown 渲染样式
      '.dube-bubble .dube-md-p{margin:0}',
      '.dube-bubble .dube-md-p + .dube-md-p{margin-top:5px}',
      '.dube-bubble .dube-md-list{margin:5px 0 2px;padding-left:18px}',
      '.dube-bubble .dube-md-list li{margin:3px 0;line-height:1.5}',
      '.dube-bubble strong{color:var(--champagne,#f4d28a);font-weight:600}',
      '.dube-bubble code{background:rgba(255,255,255,.10);padding:1px 5px;border-radius:5px;font-size:12px}',
      '.dube-bubble.sys{background:rgba(244,180,90,.10);border:1px solid rgba(244,180,90,.30);color:#f4d28a;font-size:12px}',
      '.dube-bubble.err{background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.32);color:#ff9a9a;font-size:12px}',
      // 多条信息：第 2 条起在生成中先显「正在输入」三点动画（收到首字即替换）
      '.dube-bubble.dube-typing{padding:10px 14px}',
      '.dube-typing-dots{display:inline-flex;gap:4px;align-items:center}',
      '.dube-typing-dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.5);animation:dubeTyping 1.2s infinite ease-in-out}',
      '.dube-typing-dots i:nth-child(2){animation-delay:.15s}',
      '.dube-typing-dots i:nth-child(3){animation-delay:.3s}',
      '@keyframes dubeTyping{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',
      '.dube-name{font-size:10.5px;color:var(--champagne,#f4d28a);letter-spacing:.5px;margin-left:2px}',
      // 思考过程折叠块（开「思考」时展示模型推理，默认展开、可收起）
      '.dube-think-block{align-self:stretch;border-radius:11px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);overflow:hidden}',
      '.dube-think-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;cursor:pointer;font-size:11px;color:rgba(255,255,255,.46);user-select:none}',
      '.dube-think-head:hover{color:rgba(255,255,255,.72)}',
      '.dube-think-toggle{font-size:10.5px;color:rgba(255,255,255,.34)}',
      '.dube-think-body{display:none;padding:0 10px 9px;font-size:11.5px;line-height:1.6;color:rgba(255,255,255,.5);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;scrollbar-width:none}',
      '.dube-think-block.expanded .dube-think-body{display:block}',
      '.dube-think-body::-webkit-scrollbar{width:0;height:0;display:none}',
      '.dube-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.dube-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 9px;border-radius:11px;background:rgba(10,10,16,.6);border:1px solid rgba(244,210,138,.30);color:var(--champagne,#f4d28a);letter-spacing:.3px}',
      '.dube-chip.fail{border-color:rgba(255,120,120,.34);color:#ff9a9a}',
      '.dube-chip .dube-spin{width:10px;height:10px;border:1.5px solid rgba(244,210,138,.24);border-top-color:var(--champagne,#f4d28a);border-radius:50%;animation:spin .7s linear infinite;flex:0 0 auto}',
      // 输入坞（#dube-dock/#dube-input/#dube-mic/#dube-send）已删除：对话由 DSH 主对话区驱动，
      // 面板仅承载对话镜像。助手名不再品牌化显示（可改名，避免硬编码）。
      '.dube-name{display:none}',
      '@keyframes dubePulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '.dube-empty{color:rgba(255,255,255,.4);font-size:12px;line-height:1.7;padding:14px 4px}',
      // 天气卡片（查天气：对话内出预报，不切电台）
      '.dube-weather{align-self:flex-start;max-width:88%;padding:11px 13px;border-radius:14px;border-bottom-left-radius:4px;background:rgba(var(--fc-accent-rgb,0,245,212),.08);border:1px solid rgba(var(--fc-accent-rgb,0,245,212),.26)}',
      '.dube-weather .dw-head{display:flex;align-items:baseline;gap:8px}',
      '.dube-weather .dw-loc{font-size:14px;font-weight:600;color:#fff}',
      '.dube-weather .dw-range{font-size:11px;color:rgba(255,255,255,.45)}',
      '.dube-weather .dw-now{font-size:13px;color:var(--champagne,#f4d28a);margin-left:auto}',
      '.dube-weather .dw-sub{font-size:11px;color:rgba(255,255,255,.55);margin-top:3px}',
      '.dube-weather .dw-days{display:flex;flex-direction:column;gap:4px;margin-top:9px}',
      '.dube-weather .dw-day{display:flex;align-items:center;gap:10px;font-size:12px}',
      '.dube-weather .dw-date{width:40px;color:rgba(255,255,255,.6);flex:0 0 auto}',
      '.dube-weather .dw-txt{flex:1;color:rgba(255,255,255,.82)}',
      '.dube-weather .dw-temp{color:#fff;flex:0 0 auto}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'dube-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ─────────────── 面板换芯：注入 #dube-panel 到 #playlist-panel ─────────────── */
  function buildPanel() {
    if (built) return true;
    var panel = document.getElementById('playlist-panel');
    if (!panel) return false;
    injectStyles();
    var root = document.createElement('div');
    root.id = 'dube-panel';
    root.innerHTML =
      '<div class="dube-head">' +
        '<div><div class="fx-title" id="dube-title">对话面板</div><div class="fx-sub" id="dube-sub"></div></div>' +
        '<div class="dube-head-act">' +
          // 图标统一走 stroke SVG：emoji 跨平台渲染不一、吃不到 currentColor/active 金色态
          '<button class="dube-icobtn" id="dube-think" title="详细模式：开/关（显示思考/工具步骤）" aria-label="详细模式开关"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.9 10.55c.57.5.9 1.21.9 1.95V16h6v-.5c0-.74.33-1.45.9-1.95A6 6 0 0 0 12 3z"/></svg></button>' +
          '<button class="dube-icobtn" id="dube-pin" title="常开（面板不自动隐藏）" aria-label="常开开关"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg></button>' +
          '<button class="dube-icobtn danger" id="dube-forget" title="清空全部音乐助手数据" aria-label="清空全部音乐助手数据"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
          '<button class="dube-icobtn" id="dube-close" title="关闭" aria-label="关闭面板"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
        '</div>' +
      '</div>' +
      '<div class="panel-tabs" id="dube-tabs" role="tablist" aria-label="对话面板内容">' +
        '<button class="panel-tab active" id="dube-tab-chat" role="tab" aria-selected="true" aria-controls="dube-chat-pane">对话记录</button>' +
        '<button class="panel-tab" id="dube-tab-memory" role="tab" aria-selected="false" aria-controls="dube-memory-pane">听歌画像 <span class="dube-tab-count" id="dube-event-count"></span></button>' +
      '</div>' +
      '<div id="dube-chat-pane" role="tabpanel" aria-labelledby="dube-tab-chat"><div id="dube-chat-list"></div></div>' +
      '<div id="dube-memory-pane" role="tabpanel" aria-labelledby="dube-tab-memory" style="display:none"></div>';
    panel.appendChild(root);
    els.root = root;
    els.title = root.querySelector('#dube-title');
    els.sub = root.querySelector('#dube-sub');
    els.chatPane = root.querySelector('#dube-chat-pane');
    els.chatList = root.querySelector('#dube-chat-list');
    els.memPane = root.querySelector('#dube-memory-pane');
    els.tabChat = root.querySelector('#dube-tab-chat');
    els.tabMem = root.querySelector('#dube-tab-memory');
    els.eventCount = root.querySelector('#dube-event-count');
    els.pin = root.querySelector('#dube-pin');
    els.think = root.querySelector('#dube-think');
    wire();
    built = true;
    updateNameUI(); // 面板刚建好：把当前名（配置可能已先于 DOM 就绪加载到）刷进标题/占位/入口按钮
    showEmptyState();
    updatePinUI(); // 同步「常开」按钮的金色 active 态（持久化 pin 偏好）
    updateThinkUI(); // 同步「思考」按钮态（持久化 deep_thinking 偏好）
    updateDetailUI(); // Phase 1：同步「详细模式」按钮态（持久化 dube_detail 偏好）
    return true;
  }

  function showEmptyState() {
    if (!els.chatList) return;
    var html = '<div class="dube-empty">这里同步当前 DSH 会话，方便你在听歌时回看上下文。<br>发送消息仍使用页面底部输入框。</div>';
    var empty = els.chatList.querySelector('.dube-empty');
    // 已是空态 → 原地刷新文案（配置加载/改名后名字要跟上，此前有子元素就跳过导致旧名残留）
    if (empty && els.chatList.children.length === 1) { els.chatList.innerHTML = html; return; }
    if (!els.chatList.children.length) els.chatList.innerHTML = html;
  }

  /* ─────────────── 事件接线 ─────────────── */
  function wire() {
    els.tabChat.addEventListener('click', function () { switchTab('chat'); });
    els.tabMem.addEventListener('click', function () { switchTab('memory'); });
    els.root.querySelector('#dube-pin').addEventListener('click', togglePin);
    els.root.querySelector('#dube-close').addEventListener('click', closePanel);
    els.root.querySelector('#dube-forget').addEventListener('click', forgetAll);
    els.root.querySelector('#dube-think').addEventListener('click', toggleDetail); // Phase 1：详细模式开关
  }

  function submitInput() {
    // 面板已改为只读对话镜像（输入坞 #dube-dock 已删除，输入在 DSH 主对话区驱动）。
    if (!els.input) return;
    var text = (els.input.value || '').trim();
    if (!text) return;
    els.input.value = '';
    ensureUnlock();
    // 经桥接 _emitUserMessage 投递（解耦：语音/其他来源也走同一出口）
    if (window.RegretRadio && window.RegretRadio._emitUserMessage) window.RegretRadio._emitUserMessage(text);
    else handleUserMessage(text);
  }

  /* ─────────────── tab 切换 ─────────────── */
  function switchTab(tab) {
    curTab = (tab === 'memory') ? 'memory' : 'chat';
    els.tabChat.classList.toggle('active', curTab === 'chat');
    els.tabMem.classList.toggle('active', curTab === 'memory');
    els.tabChat.setAttribute('aria-selected', curTab === 'chat' ? 'true' : 'false');
    els.tabMem.setAttribute('aria-selected', curTab === 'memory' ? 'true' : 'false');
    els.chatPane.style.display = curTab === 'chat' ? '' : 'none';
    els.memPane.style.display = curTab === 'memory' ? '' : 'none';
    if (els.sub) els.sub.textContent = curTab === 'memory' ? '行为如何变成推荐，一眼看懂' : '当前会话的只读镜像';
    if (els.think) els.think.style.display = curTab === 'chat' ? '' : 'none';
    // 输入坞是对话行为，记忆 tab 下藏起——避免「像是在对记忆列表输入」的歧义
    if (els.dock) els.dock.style.display = curTab === 'chat' ? '' : 'none';
    if (curTab === 'memory') openMemoryTab();
  }

  function openMemoryTab() {
    // 事件只是原料；用户真正需要的是「发生了什么 → 系统学到了什么 → 会怎样使用」。
    renderMusicEventStats(els.memPane);
  }

  /* ─────────────── 音乐事件面板（原「记忆」tab 换芯） ─────────────── */
  function renderMusicEventStats(container) {
    if (!container) return;
    var token = ++memoryLoadToken;
    var uid = (window.RegretRadioAI && window.RegretRadioAI.getUserId && window.RegretRadioAI.getUserId()) || 'default';
    container.innerHTML =
      '<div class="dube-mem-list"><div class="dube-empty">正在整理你的听歌轨迹…</div></div>';
    Promise.all([
      fetch('/api/music/taste-summary?user_id=' + encodeURIComponent(uid)).then(function (r) { return r.ok ? r.json() : null; }),
      fetch('/api/music/events?user_id=' + encodeURIComponent(uid) + '&limit=12').then(function (r) { return r.ok ? r.json() : null; }),
    ])
      .then(function (rows) {
        if (token !== memoryLoadToken) return;
        var st = rows[0];
        var recent = rows[1] && Array.isArray(rows[1].items) ? rows[1].items : [];
        if (!st) { container.innerHTML = musicInsightError('暂时读不到听歌画像。播放器仍可正常使用。'); return; }
        var total = Number(st.totalEvents) || 0;
        var types = st.eventTypes || {};
        var analyzed = Number(st.analyzedEvents) || 0;
        var positive = st.preferences && Array.isArray(st.preferences.positive) ? st.preferences.positive : [];
        var negative = st.preferences && Array.isArray(st.preferences.negative) ? st.preferences.negative : [];
        var repeatTracks = Array.isArray(st.repeatTracks) ? st.repeatTracks : [];
        var quickSkipTracks = Array.isArray(st.quickSkipTracks) ? st.quickSkipTracks : [];
        var hasProfile = positive.length || negative.length || repeatTracks.length || quickSkipTracks.length;
        var stateTitle = !total ? '还没有可分析的听歌动作' : hasProfile ? '画像正在形成，推荐会随行为更新' : '正在积累信号，还不足以形成倾向';
        var windowNote = '分析最近 ' + (Number(st.windowDays) || 180) + ' 天的 ' + analyzed + ' 条事件' + (st.truncated ? '（仅取最近一部分）' : '');
        container.innerHTML =
          '<div class="dube-mem-list">' +
            '<div class="dube-insight-hero">' +
              '<div class="dube-insight-kicker"><span class="dube-insight-live"></span>实时听歌画像</div>' +
              '<div class="dube-insight-title">' + esc(stateTitle) + '</div>' +
              '<div class="dube-insight-desc">已记录 ' + total + ' 次播放、切歌、明确喜恶或排队动作。' + esc(windowNote) + '。</div>' +
            '</div>' +
            '<div class="dube-insight-metrics">' +
              insightMetric(types.play_started, '开始播放') +
              insightMetric(types.play_completed, '完整听完') +
              insightMetric(types.skipped, '主动跳过') +
              insightMetric(types.liked, '明确喜欢') +
            '</div>' +
            insightPreferenceSection(positive, negative) +
            insightTrackSection('反复完整播放', '较强的喜欢信号', repeatTracks, '↻', 'plays', '次听完') +
            insightTrackSection('15 秒内快切', '较强的不喜欢信号', quickSkipTracks, '↷', 'skips', '次快切') +
            insightRecentSection(recent) +
            '<div class="dube-insight-section">' +
              '<div class="dube-insight-section-head"><span class="dube-insight-section-title">系统怎样理解这些事件</span></div>' +
              '<div class="dube-insight-explain"><strong>你在对话中明确说喜欢</strong>，由 DSH 记录为最强正向信号；<strong>完整听完、主动排队</strong>只会逐步增强行为倾向；<strong>15 秒内快切</strong>是较强负向信号。红心收藏属于音乐平台操作，不计入这里的“明确喜欢”。旧行为会逐渐降权，近 30 天影响更明显。</div>' +
            '</div>' +
            '<div class="dube-insight-actions"><span class="dube-insight-updated">更新于 ' + esc(formatInsightTime(st.generatedAt)) + '</span><button class="fx-mini-btn ghost" id="dube-music-stat-refresh">刷新画像</button></div>' +
          '</div>';
        if (els.eventCount) {
          els.eventCount.textContent = total > 999 ? '999+' : String(total);
          els.eventCount.classList.toggle('show', total > 0);
        }
        var ref = container.querySelector('#dube-music-stat-refresh');
        if (ref) {
          ref.addEventListener('click', function () {
            ref.disabled = true;
            ref.textContent = '刷新中…';
            setTimeout(function () { renderMusicEventStats(container); }, 180);
          });
        }
      })
      .catch(function () {
        if (token !== memoryLoadToken) return;
        container.innerHTML = musicInsightError('暂时读不到听歌画像。播放器仍可正常使用。');
      });
  }

  function insightMetric(value, label) {
    return '<div class="dube-insight-metric"><strong>' + (Number(value) || 0) + '</strong><span>' + esc(label) + '</span></div>';
  }

  function insightPreferenceSection(positive, negative) {
    function tags(rows, cls) {
      if (!rows.length) return '<span class="dube-insight-empty-inline">暂无足够证据</span>';
      return rows.slice(0, 8).map(function (p) {
        var status = p.status === 'confirmed' ? '已确认' : '行为推断';
        return '<span class="dube-insight-tag ' + cls + '">' + esc(p.artist || '未知歌手') + '<small>' + status + '</small></span>';
      }).join('');
    }
    return '<div class="dube-insight-section">' +
      '<div class="dube-insight-section-head"><span class="dube-insight-section-title">歌手倾向</span><span class="dube-insight-section-note">推断，不是定论</span></div>' +
      '<div class="dube-insight-section-note" style="margin-bottom:6px">更常完整听完 / 对话中明确说喜欢</div><div class="dube-insight-tags">' + tags(positive, '') + '</div>' +
      '<div class="dube-insight-section-note" style="margin:10px 0 6px">更常较早跳过</div><div class="dube-insight-tags">' + tags(negative, 'negative') + '</div>' +
    '</div>';
  }

  function insightTrackSection(title, note, rows, icon, countKey, suffix) {
    if (!rows.length) return '';
    var body = rows.slice(0, 6).map(function (t) {
      return '<div class="dube-insight-track"><span class="dube-insight-track-icon">' + icon + '</span><span class="dube-insight-track-main"><span class="dube-insight-track-name">' + esc(t.title || '未知歌曲') + '</span><span class="dube-insight-track-sub">' + esc(t.artist || '未知歌手') + '</span></span><span class="dube-insight-track-count">' + (Number(t[countKey]) || 0) + suffix + '</span></div>';
    }).join('');
    return '<div class="dube-insight-section"><div class="dube-insight-section-head"><span class="dube-insight-section-title">' + esc(title) + '</span><span class="dube-insight-section-note">' + esc(note) + '</span></div><div class="dube-insight-track-list">' + body + '</div></div>';
  }

  function insightRecentSection(rows) {
    var labels = { play_started: ['▶', '开始播放'], play_completed: ['✓', '完整听完'], skipped: ['↷', '主动跳过'], liked: ['♥', 'DSH 记为明确喜欢'], unliked: ['×', 'DSH 记为明确不喜欢'], queued: ['+', '加入队列'] };
    var body = rows.length ? rows.slice(0, 8).map(function (ev) {
      var meta = labels[ev.event_type] || ['·', ev.event_type || '未知事件'];
      var pos = ev.event_type === 'skipped' && ev.position_ms != null ? ' · ' + formatDuration(ev.position_ms) + ' 时' : '';
      return '<div class="dube-event-row"><span class="dube-event-icon">' + meta[0] + '</span><span class="dube-event-main"><span class="dube-event-name">' + esc(meta[1] + '《' + (ev.track_title || '未知歌曲') + '》') + '</span><span class="dube-event-sub">' + esc((ev.track_artist || '未知歌手') + pos) + '</span></span><span class="dube-event-time">' + esc(formatInsightTime(ev.created_at)) + '</span></div>';
    }).join('') : '<div class="dube-insight-empty-inline">播放一首歌后，刚发生的动作会显示在这里。</div>';
    return '<div class="dube-insight-section"><div class="dube-insight-section-head"><span class="dube-insight-section-title">最近发生</span><span class="dube-insight-section-note">最多显示 8 条</span></div><div class="dube-event-list">' + body + '</div></div>';
  }

  function formatDuration(ms) {
    var seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function formatInsightTime(value) {
    if (!value) return '刚刚';
    var normalized = String(value).replace(' ', 'T') + (String(value).indexOf('Z') >= 0 || /[+-]\d\d:?\d\d$/.test(String(value)) ? '' : 'Z');
    var date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) return String(value).slice(0, 16);
    var delta = Date.now() - date.getTime();
    if (delta >= 0 && delta < 60000) return '刚刚';
    if (delta >= 0 && delta < 3600000) return Math.floor(delta / 60000) + ' 分钟前';
    if (delta >= 0 && delta < 86400000) return Math.floor(delta / 3600000) + ' 小时前';
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }

  function musicInsightError(message) {
    return '<div class="dube-mem-list"><div class="dube-empty">' + esc(message) + '<br><button class="fx-mini-btn ghost" style="margin-top:12px" onclick="window.RegretRadioAI.switchTab(\'memory\')">重新加载</button></div></div>';
  }

  /* ─────────────── 开/关/切换/常开（复用 togglePlaylistPanel 外壳 + 流式豁免自动隐藏） ─────────────── */
  function isPanelOpen() {
    var p = document.getElementById('playlist-panel');
    return !!(p && (p.classList.contains('show') || p.classList.contains('peek')));
  }
  function openPanel() {
    buildPanel();
    var panel = document.getElementById('playlist-panel');
    if (typeof togglePlaylistPanel === 'function') togglePlaylistPanel(true);
    else if (panel) panel.classList.add('show');
    switchTab('chat');
    updatePinUI();
  }
  function closePanel() {
    window.__dubeStreaming = false;
    // 必须先取消常开：否则 pinned + setPeek 关闭守卫会挡住、且 peek 类残留 → 关不掉（用户报的 bug）。
    if (typeof setPlaylistPanelPinned === 'function' && window.playlistPanelPinned) {
      setPlaylistPanelPinned(false, true); // 静默取消常开
    }
    var panel = document.getElementById('playlist-panel');
    if (typeof setPeek === 'function' && panel) { try { setPeek(panel, false, 'pl'); } catch (e) {} }
    if (typeof togglePlaylistPanel === 'function') togglePlaylistPanel(false);
    if (panel) { panel.classList.remove('show'); panel.classList.remove('peek'); }
    updatePinUI();
  }
  // dube 入口按钮：开着就关、关着就开（同 Home 按钮的切换语义）
  function togglePanel() {
    if (isPanelOpen()) closePanel();
    else openPanel();
  }
  // 「常开」切换：用金色 active 态表达（代替原来一闪而过的横幅），静默不弹 toast
  function togglePin() {
    if (typeof setPlaylistPanelPinned === 'function') {
      setPlaylistPanelPinned(!window.playlistPanelPinned, true);
    }
    updatePinUI();
  }
  function updatePinUI() {
    var pinned = !!window.playlistPanelPinned;
    if (els.pin) {
      els.pin.classList.toggle('active', pinned); // 图标按钮，态靠金色，文字常驻 📌
      els.pin.title = pinned ? '已常开（点击取消）' : '常开（面板不自动隐藏）';
    }
  }
  // 「思考」切换：金色 active 态；持久化到 localStorage；下一轮对话起随 deep_thinking 发给后端
  function toggleThink() {
    deepThinking = !deepThinking;
    try { localStorage.setItem('regretradio.deep_thinking', deepThinking ? '1' : '0'); } catch (e) {}
    updateThinkUI();
    if (typeof showToast === 'function') showToast(deepThinking ? '已开启深度思考（更准但更慢）' : '已关闭深度思考');
  }
  function updateThinkUI() {
    if (els.think) {
      els.think.classList.toggle('active', deepThinking); // 图标按钮，态靠金色，文字常驻 🧠
      els.think.title = deepThinking
        ? '深度思考已开：工具调用更准，回应慢几秒。点击关闭'
        : '深度思考：工具调用更准（放歌/队列/改名更听话），但回应会慢几秒';
    }
  }

  /* —— Phase 1（dube-panel-chat-design.md §3.1）：dube-think 改为「详细模式」开关 —— */
  // 控制 UI 展示密度（regretradio.dube_detail），与 deepThinking（控模型 Thinking）分离。
  function toggleDetail() {
    detailMode = !detailMode;
    try { localStorage.setItem('regretradio.dube_detail', detailMode ? '1' : '0'); } catch (e) {}
    updateDetailUI();
    if (typeof showToast === 'function') {
      showToast(detailMode ? '详细模式：开（显示思考/工具步骤）' : '详细模式：关（只显示指令与回复）');
    }
  }
  function updateDetailUI() {
    if (els.think) {
      els.think.classList.toggle('active', detailMode);
      els.think.title = detailMode
        ? '详细模式已开：显示思考/工具详细步骤。点击关闭'
        : '详细模式：显示思考/工具详细步骤（当前只显示指令与回复）。点击开启';
    }
  }

  /* ─────────────── 聊天渲染 ─────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 行内 Markdown：先 HTML 转义（防 XSS），再做 **粗体** / *斜体* / `代码`
  function mdInline(s) {
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    return s;
  }
  // 轻量 Markdown 渲染：仅支持 粗体/斜体/代码 + 无序/有序列表 + 段落换行（安全，不引第三方库）
  function renderMarkdown(md) {
    var lines = String(md == null ? '' : md).split('\n');
    var html = '';
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*(?:[-*•]|\d+[.、])\s+(.*)$/.exec(lines[i]);
      if (m) {
        if (!inList) { html += '<ul class="dube-md-list">'; inList = true; }
        html += '<li>' + mdInline(m[1]) + '</li>';
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        if (lines[i].trim()) html += '<div class="dube-md-p">' + mdInline(lines[i]) + '</div>';
      }
    }
    if (inList) html += '</ul>';
    return html;
  }
  function scrollChatBottom() {
    if (els.chatPane) els.chatPane.scrollTop = els.chatPane.scrollHeight;
  }
  function clearEmpty() {
    var e = els.chatList && els.chatList.querySelector('.dube-empty');
    if (e) e.remove();
  }
  // 有界对话：长会话里气泡 DOM 只增不减会拖慢渲染、吃内存。封顶只保留最近 MAX 个回合，
  // 移除最老的（连带其子元素与事件监听一并被 GC）。新回合总是最新，不会被误删。
  var MAX_TURNS = 120;
  function capChatList() {
    if (!els.chatList) return;
    var turns = els.chatList.querySelectorAll('.dube-turn');
    for (var i = 0; i < turns.length - MAX_TURNS; i++) {
      if (turns[i] && turns[i].parentNode) turns[i].parentNode.removeChild(turns[i]);
    }
  }
  /* —— Phase 1（dube-panel-chat-design.md §3.2）：结构化事件渲染骨架 —— */
  // 把带 turnId 的结构化事件渲染成面板。统一装配路径：user→addUserBubble；每个 turnId 的
  // assistant 与其同 turnId 的全部 step → 同一个 startDubeTurn() 回合句柄（先按原始顺序
  // 步骤、后正文）。详细模式关时跳过 step（不产生任何 step DOM）。
  function renderStructuredEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    if (!els.chatList) { buildPanel(); }
    if (!els.chatList) return;
    clearEmpty();
    // 按 turnId 分组，保持首次出现顺序；同一 turnId 内事件保持数组原始顺序。
    var order = [];
    var groups = {};
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev || typeof ev.kind !== 'string') continue;
      var tid = String(ev.turnId == null ? '' : ev.turnId);
      if (!groups[tid]) { groups[tid] = []; order.push(tid); }
      groups[tid].push(ev);
    }
    for (var g = 0; g < order.length; g++) {
      var turnEvents = groups[order[g]] || [];
      var userText = null;
      var steps = [];
      var assistantText = null;
      for (var k = 0; k < turnEvents.length; k++) {
        var e = turnEvents[k];
        if (e.kind === 'user') userText = String(e.text == null ? '' : e.text);
        else if (e.kind === 'step') steps.push(e); // 保留原始顺序（含 type: think|tool）
        else if (e.kind === 'assistant') assistantText = String(e.text == null ? '' : e.text);
      }
      if (userText) addUserBubble(userText); // 无用户文本的回合（纯助手/工具增量）不产生空气泡
      var handle = startDubeTurn();
      // 详细模式开才插步骤：按原始顺序，think 直接、tool 前缀 🔧，均进 appendThinking（不造独立 chip）。
      if (detailMode) {
        for (var s = 0; s < steps.length; s++) {
          var st = steps[s];
          var label = String(st.text == null ? '' : st.text);
          if (st.type === 'tool') label = '🔧 ' + label;
          handle.appendThinking(label);
        }
      }
      if (assistantText && assistantText.trim()) handle.appendSentence(assistantText, String(g));
      capChatList();
      scrollChatBottom();
    }
  }

  // mock 入口（仅手测；正式接真实消息时移除，勿留生产后门）。
  function debugInjectEvents(events) {
    if (!Array.isArray(events)) { if (typeof showToast === 'function') showToast('debugInjectEvents 需要事件数组'); return; }
    buildPanel();
    renderStructuredEvents(events);
  }

  function addUserBubble(text) {
    clearEmpty();
    var turn = document.createElement('div');
    turn.className = 'dube-turn user';
    turn.innerHTML = '<div class="dube-bubble user">' + esc(text) + '</div>';
    els.chatList.appendChild(turn);
    capChatList();
    scrollChatBottom();
  }
  /** 到点提醒气泡（后端 notify 事件推来）：复用 dube 气泡结构，单条即完（非流式回合）。 */
  function addDubeReminder(text) {
    if (!els.chatList) return;
    clearEmpty();
    var turn = document.createElement('div');
    turn.className = 'dube-turn dube';
    var nameEl = document.createElement('div');
    nameEl.className = 'dube-name';
    nameEl.textContent = assistantName;
    var bubble = document.createElement('div');
    bubble.className = 'dube-bubble dube';
    bubble.innerHTML = renderMarkdown(text);
    turn.appendChild(nameEl);
    turn.appendChild(bubble);
    els.chatList.appendChild(turn);
    capChatList();
    scrollChatBottom();
  }
  /**
   * 展示一条到点提醒（player-link.js 收 notify 事件时调）：总弹 toast；面板开着则同时落一条 dube 气泡。
   * 走确定性模板文案（后端 renderReminder），不触发聊天流程。
   */
  function showReminder(text) {
    if (!text) return;
    if (typeof showToast === 'function') showToast(text);
    if (isPanelOpen()) {
      buildPanel(); // 幂等：保证 els.chatList 就绪
      addDubeReminder(text);
    }
  }
  /** 起一轮 dube 回合，返回操作句柄。 */
  function startDubeTurn() {
    clearEmpty();
    var turn = document.createElement('div');
    turn.className = 'dube-turn dube';
    var nameEl = document.createElement('div');
    nameEl.className = 'dube-name';
    nameEl.textContent = assistantName;
    function mkBubble() {
      var b = document.createElement('div');
      b.className = 'dube-bubble dube';
      b.style.display = 'none'; // 还没有文本前不显示空气泡
      return b;
    }
    var bubble = mkBubble(); // 首条气泡
    var chips = document.createElement('div');
    chips.className = 'dube-chips';
    turn.appendChild(nameEl);
    turn.appendChild(bubble);
    turn.appendChild(chips);
    els.chatList.appendChild(turn);
    capChatList();
    scrollChatBottom();
    var seen = {};
    var hasText = false;
    var gotContent = false; // 是否产出过任何真实内容（文本/思考/工具 chip/天气/错误）——抢发打断时据此判空壳
    var curBubble = bubble;  // 多条信息：当前正在填字的气泡（startMessage 时切到新建气泡）
    var typingOn = false;    // 当前气泡是否处于「正在输入」占位态
    var rawText = ''; // 当前气泡累积的原始 Markdown 文本，整段重渲染（dube 逐句下发，需还原列表/换行结构）
    var thinkWrap = null, thinkBody = null, thinkRaw = ''; // 思考过程块（开思考时流式追加，可折叠）
    return {
      el: turn,
      // 深度思考 delta：懒建折叠块（默认展开，让用户看到它在想），点表头收起/展开。
      appendThinking: function (text) {
        if (text == null || text === '') return;
        gotContent = true;
        if (!thinkWrap) {
          thinkWrap = document.createElement('div');
          thinkWrap.className = 'dube-think-block expanded';
          var head = document.createElement('div');
          head.className = 'dube-think-head';
          head.innerHTML = '<span class="dube-think-tag">💭 思考过程</span><span class="dube-think-toggle">收起 ▾</span>';
          thinkBody = document.createElement('div');
          thinkBody.className = 'dube-think-body';
          head.addEventListener('click', function () {
            var exp = thinkWrap.classList.toggle('expanded');
            var tg = head.querySelector('.dube-think-toggle');
            if (tg) tg.textContent = exp ? '收起 ▾' : '展开 ▸';
          });
          thinkWrap.appendChild(head);
          thinkWrap.appendChild(thinkBody);
          turn.insertBefore(thinkWrap, bubble); // 名字之后、气泡之前
        }
        thinkRaw += text;
        thinkBody.textContent = thinkRaw;
        scrollChatBottom();
      },
      // 多条信息：另起一条。新建气泡插到 chips 之前（chips 常驻回合底部），先显「正在输入」
      // 三点动画，收到首字即替换。text-only 模式字几乎同刻到达 → 动画一闪而过（无妨）。
      startMessage: function () {
        rawText = '';
        var nb = mkBubble();
        nb.style.display = '';
        nb.classList.add('dube-typing');
        nb.innerHTML = '<span class="dube-typing-dots"><i></i><i></i><i></i></span>';
        turn.insertBefore(nb, chips);
        curBubble = nb;
        typingOn = true;
        gotContent = true; // 已另起气泡：本回合不再算空壳
        scrollChatBottom();
      },
      appendSentence: function (text, seq) {
        if (text == null) return;
        // 去重：同 seq 句子只上一次（onSentence 与 audio 的 text 不重复触发本函数，这里只防同 seq 重发）
        var key = String(seq);
        if (seen[key]) return; seen[key] = 1;
        // dube 逐句下发：列表项各自一句。进入或离开列表块时补换行还原结构，
        // 普通散句之间仍直接相连（保持自然流式观感）。
        var LIST_RE = /^\s*(?:[-*•]|\d+[.、])\s/;
        var lastLine = rawText.slice(rawText.lastIndexOf('\n') + 1);
        if (rawText && (LIST_RE.test(text) || LIST_RE.test(lastLine))) rawText += '\n';
        rawText += text;
        if (typingOn) { curBubble.classList.remove('dube-typing'); typingOn = false; }
        curBubble.style.display = '';
        curBubble.innerHTML = renderMarkdown(rawText);
        hasText = true;
        gotContent = true;
        scrollChatBottom();
      },
      setFullText: function (text) {
        rawText = text || '';
        if (typingOn) { curBubble.classList.remove('dube-typing'); typingOn = false; }
        curBubble.style.display = '';
        curBubble.innerHTML = renderMarkdown(rawText);
        hasText = !!text;
        if (text) gotContent = true;
        scrollChatBottom();
      },
      hasText: function () { return hasText; },
      // 是否是「空壳」回合：没产出过任何真实内容（只有名字标签 + 可能的转圈进度）。
      // 抢发打断上一轮时据此把它整条移除，避免残留一个只写着「dube」的空气泡。
      isEmpty: function () { return !gotContent; },
      remove: function () { if (turn.parentNode) turn.parentNode.removeChild(turn); },
      addWeatherCard: function (w) {
        if (!w || !w.now) return;
        gotContent = true;
        var now = w.now;
        var daily = w.daily || [];
        function dayLabel(d, i) {
          if (i === 0) return '今天';
          if (i === 1) return '明天';
          var m = /\d{4}-(\d{2})-(\d{2})/.exec(d.fxDate || '');
          return m ? (parseInt(m[1], 10) + '/' + parseInt(m[2], 10)) : ('第' + (i + 1) + '天');
        }
        var rows = daily.map(function (d, i) {
          return '<div class="dw-day"><span class="dw-date">' + esc(dayLabel(d, i)) + '</span>' +
            '<span class="dw-txt">' + esc(d.textDay || '') + '</span>' +
            '<span class="dw-temp">' + esc((d.tempMin || '') + '~' + (d.tempMax || '') + '°') + '</span></div>';
        }).join('');
        var card = document.createElement('div');
        card.className = 'dube-weather';
        var range = w.range || (daily.length <= 1 ? '今天' : '未来' + daily.length + '天');
        card.innerHTML =
          '<div class="dw-head"><span class="dw-loc">' + esc(w.location || '') + '</span>' +
          '<span class="dw-range">' + esc(range) + '</span>' +
          '<span class="dw-now">' + esc((now.text || '') + ' ' + (now.temp || '') + '°') + '</span></div>' +
          '<div class="dw-sub">' + esc('体感' + (now.feelsLike || now.temp || '') + '° · ' + (now.windDir || '') + (now.windScale || '') + '级 · 湿度' + (now.humidity || '') + '%') + '</div>' +
          (rows ? '<div class="dw-days">' + rows + '</div>' : '');
        turn.insertBefore(card, chips); // 气泡之后、chips 之前
        scrollChatBottom();
      },
      addChip: function (text, ok) {
        gotContent = true;
        var c = document.createElement('span');
        c.className = 'dube-chip' + (ok ? '' : ' fail');
        c.textContent = text;
        chips.appendChild(c);
        scrollChatBottom();
        return c;
      },
      addProgress: function (text) {
        var c = document.createElement('span');
        c.className = 'dube-chip';
        c.innerHTML = '<span class="dube-spin"></span><span>' + esc(text || '思考中…') + '</span>';
        chips.appendChild(c);
        scrollChatBottom();
        return { done: function () { if (c && c.parentNode) c.parentNode.removeChild(c); } };
      },
      addError: function (text) {
        gotContent = true;
        var b = document.createElement('div');
        b.className = 'dube-bubble err';
        b.textContent = text || '出错了';
        turn.appendChild(b);
        scrollChatBottom();
      },
      // 带可点超链接的提示气泡（未接入 AI 引导用）：text 后接一个链接，点击触发 onClick。
      addErrorLink: function (text, linkLabel, onClick) {
        gotContent = true;
        var b = document.createElement('div');
        b.className = 'dube-bubble err';
        b.appendChild(document.createTextNode(text || ''));
        var a = document.createElement('a');
        a.href = 'javascript:void(0)';
        a.textContent = linkLabel || '点击这里';
        a.style.cssText = 'color:var(--champagne,#f4d28a);text-decoration:underline;cursor:pointer;font-weight:600;';
        a.addEventListener('click', function (e) { e.preventDefault(); if (onClick) { try { onClick(); } catch (err) {} } });
        b.appendChild(a);
        turn.appendChild(b);
        scrollChatBottom();
      },
    };
  }

  /* ─────────────── 编排主链路 ─────────────── */
  function ensureUnlock() {
    if (!audioUnlocked) { try { AI.unlockAudio(); } catch (e) {} audioUnlocked = true; }
  }
  // 从桥接读「当前播放 + 队列」，拼成喂给 dube 的现状文本（每轮发送，修"不知道在放什么"）
  function buildPlayerState() {
    try {
      var p = window.RegretRadio && window.RegretRadio.player;
      if (!p) return '';
      var cur = (typeof p.getCurrentTrack === 'function') ? p.getCurrentTrack() : null;
      var q = (typeof p.getQueue === 'function') ? (p.getQueue() || []) : [];
      function label(t) { return t && t.name ? ('《' + t.name + '》' + (t.artists && t.artists.length ? ' - ' + t.artists.join('/') : '')) : '（未知曲目）'; }
      function same(a, b) { return a && b && String(a.id) === String(b.id) && (a.provider || '') === (b.provider || ''); }
      var lines = [];
      lines.push(cur ? ('当前播放：' + label(cur)) : '当前没有在播放的歌曲。');
      if (q.length) {
        // 全量带 1-based 序号 + 标注当前（▶）——让 AI 能把歌名→队列序号（移除）、定位"队列第N首"（播放）、识别"这首"=当前。
        var MAX = 30;
        var rows = q.slice(0, MAX).map(function (t, i) { return (i + 1) + '. ' + label(t) + (same(t, cur) ? ' （▶ 当前）' : ''); });
        lines.push('播放队列共 ' + q.length + ' 首（"队列第 N 首"指下列序号：播放用 play_queue_index(N)、移除用 queue_remove(N)）：');
        lines.push(rows.join('\n') + (q.length > MAX ? '\n…（仅列前 ' + MAX + ' 首）' : ''));
        if (!cur) lines.push('（队列有歌但未开始播——要播用 play_queue_index 或 player_next。）');
      } else {
        lines.push('播放队列为空。');
      }
      return lines.join('\n');
    } catch (e) { return ''; }
  }
  // 从桥接读「当前搜索结果池」，带序号喂给 dube——用户说"第 N 首"时它能直接 play_stage_index(N)，
  // 还能据歌名应话（无论结果来自 AI 搜歌还是用户手动搜，都同步给 AI，搜索组件与 AI 联调）。
  function buildSearchResults() {
    try {
      var p = window.RegretRadio && window.RegretRadio.player;
      if (!p || typeof p.getSearchResults !== 'function') return '';
      var list = p.getSearchResults() || [];
      if (!list.length) return '';
      function label(t) { return t && t.name ? ('《' + t.name + '》' + (t.artists && t.artists.length ? ' - ' + t.artists.join('/') : '')) : '（未知曲目）'; }
      var lines = list.slice(0, 18).map(function (t, i) { return (i + 1) + '. ' + label(t); });
      return '当前搜索结果共 ' + list.length + ' 首（用户说"第 N 首/播放第 N 首"即指这里，用 play_stage_index(N) 播）：\n' + lines.join('\n');
    } catch (e) { return ''; }
  }
  function initVoice() {
    if (dj) return;
    dj = AI.createDjVoice({ factor: 0.2 });
  }
  function updateNameUI() {
    if (els.title) els.title.textContent = '对话面板';
    if (els.sub) els.sub.textContent = curTab === 'memory' ? '行为如何变成推荐，一眼看懂' : '当前会话的只读镜像';
    // 输入坞已删除，无 placeholder/输入框可设
    // 入口按钮（index.html 静态 title 只是初始值，这里跟随当前名）
    var btn = document.getElementById('dube-btn');
    if (btn) {
      btn.title = '对话面板';
      btn.setAttribute('aria-label', '对话面板');
    }
    // 同步刷新已有 dube 气泡的名字标签（改名后历史气泡也显示当前名，避免新旧名混杂）
    if (els.chatList) {
      var labels = els.chatList.querySelectorAll('.dube-name');
      for (var i = 0; i < labels.length; i++) labels[i].textContent = assistantName;
    }
    showEmptyState(); // 空态欢迎语的名字也跟上（有消息时是 no-op）
    // 广播给其他模块（discover 控制台 / 发现子视图 / 记忆面板）
    if (AI.setAssistantName) AI.setAssistantName(assistantName);
  }

  async function handleUserMessage(text) {
    text = (text || '').trim();
    if (!text) return;
    buildPanel();
    initVoice();
    ensureUnlock();

    // —— barge-in：打断上一轮 ——
    if (activeAbort) {
      try { activeAbort.abort(); } catch (e) {}
      activeAbort = null;
      // 抢发：上一轮还没产出任何内容就被打断 → 移除它留下的空壳气泡（只有名字标签/转圈，
      // 无文本/工具 chip/天气/错误）。后端同 session 的上一回合也已被 turn-registry 抢占收尾。
      if (activeTurn && typeof activeTurn.isEmpty === 'function' && activeTurn.isEmpty()) {
        try { activeTurn.remove(); } catch (e) {}
      }
    }
    activeTurn = null;
    if (dj) dj.stop();

    openPanel();
    addUserBubble(text);
    // 未接入 AI 守卫（09 P5）：source=none 时不发起对话，友好提示 + 直达配置（不配也能纯听歌）。
    if (AI.aiStatus && AI.aiStatus.source === 'none') {
      startDubeTurn().addErrorLink('还没接入 AI 模型，不配也能纯听歌 🎧　', '点击这里开始配置你的 AI 模型', function () { if (AI.openProviderConfig) AI.openProviderConfig(); });
      if (AI.openProviderConfig) { try { AI.openProviderConfig(); } catch (e) {} }
      return;
    }
    var turn = startDubeTurn();
    activeTurn = turn; // 记录进行中回合，供下次抢发时清理空壳
    var progress = turn.addProgress(assistantName + ' 正在想…');
    var firstContent = false;
    var ac = new AbortController();
    activeAbort = ac;
    window.__dubeStreaming = true;
    if (dj) dj.setStreamActive(true);

    var toolChain = Promise.resolve(); // 串行化工具派发，保 chip 顺序
    var renamedThisTurn = false; // 本轮是否经 set_assistant_name 工具改名（其 chip 由 tool-dispatch 出，finishTurn 不再重复）

    function stopStream() {
      window.__dubeStreaming = false;
      if (dj) dj.setStreamActive(false);
    }

    try {
      await AI.streamChat({
        user_id: AI.getUserId(),
        session_id: AI.getSessionId(),
        conversation_id: convId || undefined,
        user_message: text,
        recent_tool_results: recentResults.slice(-6),
        player_state: buildPlayerState(), // 当前播放 + 队列，喂给 dube（知道在放什么/队列）
        search_results: buildSearchResults(), // 当前搜索结果池（带序号），让"第 N 首"可直接 play_stage_index
        deep_thinking: deepThinking, // 「思考」开关：开启走 MiMo Thinking，工具调用更准（代价首响慢）
      }, {
        onMeta: function (m) {
          if (!m) return;
          if (m.session_id) AI.setSessionId(m.session_id);
          if (m.conversation_id) convId = m.conversation_id;
        },
        onThinking: function (t) { turn.appendThinking(t); }, // 思考 delta → 折叠块
        onMessage: function () {
          // 多条信息：另起一条气泡（第 2 条起）。首条已出内容→进度圈通常已关，保险再关一次。
          if (!firstContent) { firstContent = true; progress.done(); }
          turn.startMessage();
        },
        onSentence: function (t, seq) {
          if (!firstContent) { firstContent = true; progress.done(); }
          turn.appendSentence(t, seq);
        },
        onAudio: function (wav, seq) {
          if (!firstContent) { firstContent = true; progress.done(); }
          if (dj) dj.enqueueAudio(wav, seq);
        },
        onTool: function (name, args) {
          // 改名乐观更新：收到工具事件即把名字改到 args.name（标题 + 所有气泡标签立即变），
          // 不等后端滞后一轮的 done.assistant_name。真名稍后由 finishTurn 以 done 兜底校正。
          if (name === 'set_assistant_name' && args && typeof args.name === 'string') {
            var nn = args.name.trim();
            if (nn) {
              renamedThisTurn = true; // 工具路径：chip 由 tool-dispatch 给，finishTurn 不再据 done 标记补 chip
              if (nn !== assistantName) {
                pastNames[assistantName] = 1;
                assistantName = nn;
                updateNameUI();
              }
            }
          }
          toolChain = toolChain.then(function () {
            return AI.dispatchTool(name, args).then(function (r) {
              if (!r) return;
              // 有界：只留最近若干条（发送时取 slice(-6)，多留些做缓冲）。不封顶会随长会话只增不减。
              if (r.summary) { recentResults.push(r.summary); if (recentResults.length > 24) recentResults = recentResults.slice(-24); }
              if (r.weather) turn.addWeatherCard(r.weather); // 查天气：对话内出预报卡片
              if (r.chip) turn.addChip(r.chip, r.ok);
            });
          });
        },
        onTtsError: function (full) {
          stopStream();
          if (full) turn.setFullText(full); // 整段回显原文
        },
        onDone: function (info) {
          stopStream();
          finishTurn(info, turn, renamedThisTurn);
        },
        onError: function (msg) {
          stopStream();
          progress.done();
          turn.addError(msg || '出了点问题');
        },
      }, ac.signal);
    } catch (e) {
      stopStream();
      progress.done();
      if (!(e && e.name === 'AbortError')) turn.addError(String((e && e.message) || e));
    } finally {
      progress.done();
      if (activeAbort === ac) activeAbort = null;
    }
  }

  function finishTurn(info, turn, renamedViaTool) {
    if (!info) return;
    // 真名以 done.assistant_name 校正。chip 的两条出口：
    //  ① 工具改名（renamedViaTool）：chip 已由 tool-dispatch 给，这里不重复，只静默对齐名字；
    //  ② 同步快路径改名（info.assistant_name_changed=true，LLM 没调工具时走这条）：后端确认"本轮刚改名"，
    //     这里更新名字并补「已改名为」chip。
    // 关键：**只有 assistant_name_changed 才上 chip**——避免页面初始名 dube 与已持久化名不一致时
    //  把 done 回传的持久名误当成"刚改名"（用户报过的假 chip）。pastNames 仍防异步回传旧名把乐观更新回退。
    var dn = info.assistant_name;
    if (dn && dn !== assistantName && !pastNames[dn]) {
      pastNames[assistantName] = 1;
      assistantName = dn;
      updateNameUI();
      if (info.assistant_name_changed && !renamedViaTool) turn.addChip('已改名为 ' + assistantName, true);
    }
    // 若全程没出文本但有 assistant_response，兜底显示
    if (!turn.hasText() && info.assistant_response) turn.setFullText(info.assistant_response);
  }

  // 应用内确认弹窗（替代原生 confirm）。返回 Promise<boolean>。
  // 危险操作默认聚焦「取消」；Esc / 点遮罩 = 取消；聚焦按钮上 Enter/Space 原生触发。
  function showConfirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'dube-confirm-mask';
      mask.innerHTML =
        '<div class="dube-confirm" role="dialog" aria-modal="true">' +
          '<div class="dube-confirm-title">' + esc(opts.title || '确认') + '</div>' +
          '<div class="dube-confirm-msg">' + esc(opts.message || '') + '</div>' +
          '<div class="dube-confirm-act">' +
            '<button class="dube-confirm-btn ghost" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>' +
            '<button class="dube-confirm-btn ' + (opts.danger ? 'danger' : 'primary') + '" data-act="ok">' + esc(opts.okText || '确定') + '</button>' +
          '</div>' +
        '</div>';
      function close(val) {
        document.removeEventListener('keydown', onKey, true);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(val);
      }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(false); } }
      mask.addEventListener('click', function (e) { if (e.target === mask) close(false); });
      mask.querySelector('[data-act="cancel"]').addEventListener('click', function () { close(false); });
      mask.querySelector('[data-act="ok"]').addEventListener('click', function () { close(true); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(mask);
      // 危险操作默认聚焦「取消」（更安全）；普通确认聚焦「确定」。
      var def = mask.querySelector('[data-act="' + (opts.danger ? 'cancel' : 'ok') + '"]');
      if (def) setTimeout(function () { try { def.focus(); } catch (e) {} }, 0);
    });
  }

  // FORGET ME（测试便捷）：清空本用户全部数据（记忆/对话/听歌偏好/助手设置），保留账号登录。
  function forgetAll() {
    if (!AI.forgetMe) { if (typeof showToast === 'function') showToast('清空接口未就绪'); return; }
    showConfirm({
      title: '清空全部数据？',
      message: '记忆 / 对话 / 听歌偏好 / 助手设置都会删除（账号登录保留）。\n此操作不可撤销。',
      okText: '清空', cancelText: '取消', danger: true,
    }).then(function (ok) {
      if (!ok) return;
      AI.forgetMe(AI.getUserId()).then(function (r) {
        // 本地复位：停流、轮换会话、清对话、助手名回默认、空态
        if (activeAbort) { try { activeAbort.abort(); } catch (e) {} activeAbort = null; }
        if (dj) dj.stop();
        window.__dubeStreaming = false;
        AI.rotateSessionId();
        convId = null;
        recentResults = [];
        pastNames = {};
        assistantName = 'assistant';
        updateNameUI();
        if (els.chatList) { els.chatList.innerHTML = ''; showEmptyState(); }
        if (curTab === 'memory') openMemoryTab(); // 记忆面板开着则刷新
        if (typeof showToast === 'function') showToast('已清空全部数据（删除 ' + ((r && r.deleted) || 0) + ' 条），登录已保留');
      }).catch(function (e) {
        if (typeof showToast === 'function') showToast('清空失败：' + ((e && e.message) || e));
      });
    });
  }

  function newChat() {
    if (activeAbort) { try { activeAbort.abort(); } catch (e) {} activeAbort = null; }
    if (dj) dj.stop();
    window.__dubeStreaming = false;
    var old = AI.getSessionId();
    AI.startNewChat(AI.getUserId(), old).then(function (r) {
      if (r && r.session_id) AI.setSessionId(r.session_id);
      convId = (r && r.conversation_id) || null;
    }).catch(function () {
      AI.rotateSessionId(); convId = null;
    });
    recentResults = [];
    if (els.chatList) { els.chatList.innerHTML = ''; showEmptyState(); }
  }

  /* ─────────────── 语音输入（MediaRecorder → STT → emit） ─────────────── */
  var recorder = null, recChunks = [], recording = false;
  async function toggleRecord() {
    ensureUnlock();
    if (recording) { stopRecord(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (typeof showToast === 'function') showToast('当前环境不支持录音');
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
        if (!blob.size) return;
        AI.sttUpload(blob).then(function (textOut) {
          var t = (textOut || '').trim();
          if (t) {
            if (window.RegretRadio && window.RegretRadio._emitUserMessage) window.RegretRadio._emitUserMessage(t);
            else handleUserMessage(t);
          } else if (typeof showToast === 'function') showToast('没听清，再说一次？');
        }).catch(function (err) {
          if (typeof showToast === 'function') showToast('语音识别失败');
        });
      };
      recorder.start();
      recording = true;
      if (els.mic) els.mic.classList.add('rec');
      // 录音也是 barge-in：停掉上一轮播放
      if (dj) dj.stop();
      if (activeAbort) { try { activeAbort.abort(); } catch (e) {} activeAbort = null; }
    } catch (e) {
      if (typeof showToast === 'function') showToast('麦克风不可用');
    }
  }
  function stopRecord() {
    recording = false;
    if (els.mic) els.mic.classList.remove('rec');
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) {} }
  }

  /* ─────────────── 初始化 ─────────────── */
  function init() {
    if (!buildPanel()) {
      document.addEventListener('DOMContentLoaded', buildPanel);
      window.addEventListener('load', buildPanel);
    }
    // 注册用户消息处理器（输入坞 / 语音 / 外部都经 _emitUserMessage 投递）
    if (window.RegretRadio && window.RegretRadio.onUserMessage) {
      window.RegretRadio.onUserMessage(handleUserMessage);
    }
    // 拉运行时配置，拿当前助手名
    if (AI.getRuntimeConfig) {
      AI.getRuntimeConfig(AI.getUserId && AI.getUserId()).then(function (cfg) {
        if (cfg && cfg.assistant_name) { assistantName = cfg.assistant_name; updateNameUI(); showEmptyState(); }
      }).catch(function () {});
    }
  }

  // 对外：dube 入口按钮 / 空卡片重路由调用
  AI.openPanel = openPanel;
  AI.closePanel = closePanel;
  AI.togglePanel = togglePanel;
  AI.handleUserMessage = handleUserMessage;
  AI.switchTab = switchTab;
  AI.showReminder = showReminder; // 到点提醒展示（player-link.js 收 notify 事件时调）
  AI.renderStructuredEvents = renderStructuredEvents; // Phase 1：结构化事件渲染骨架
  AI.debugInjectEvents = debugInjectEvents; // Phase 1：mock 入口（仅手测）

  /* —— Phase 2（dube-panel-chat-design.md §5）：DSH 父窗口对话桥 —— */
  // 收 DSH 音乐 tab 父窗口经 postMessage 推来的真实对话事件，喂给渲染骨架。
  window.addEventListener('message', function (ev) {
    var data = (ev && ev.data) || null;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'dube-panel.reset') {
      if (!els.chatList) buildPanel();
      if (els.chatList) { els.chatList.innerHTML = ''; showEmptyState(); }
      return;
    }
    if (data.type === 'dube-panel.events' && Array.isArray(data.payload)) {
      try { AI.renderStructuredEvents(data.payload); } catch (e) { /* 渲染失败绝不影响播放器 */ }
    }
  });
  // 就绪握手：本面板脚本加载完即通知父窗口，让它把最近会话回放过来（防首帧丢事件）。
  if (window.parent && window.parent !== window) {
    try { window.parent.postMessage({ type: 'dube-panel.ready' }, '*'); } catch (e) { /* 静默 */ }
  }

  init();
})();
