/**
 * memory-panel.js · Regret-radio AI 叠加层「记忆」面板（M4-5）
 *
 * 渲染 dube 记忆的 CRUD 时间线到 #dube-memory-pane（ai-overlay 切到「记忆」tab 时调
 * AI.renderMemoryPanel(el)）。数据/写操作经 ai-client 的记忆 API（/api/memory*）。
 *
 * 后端状态：pending（待确认）/ active（已记住）/ deleted（软删，列表默认不返）。
 *   - 所有：可编辑内容(PATCH) / 删除(soft delete)；
 *   - pending：额外可 确认(→active) / 拒绝(删除)。
 */
(function () {
  'use strict';
  var AI = (window.RegretRadioAI = window.RegretRadioAI || {});

  function injectStyles() {
    if (document.getElementById('dube-mem-style')) return;
    var css = [
      '#dube-memory-pane .dube-mem-head{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 8px;position:sticky;top:0}',
      '#dube-memory-pane .dube-mem-head .t{font-size:12px;color:rgba(255,255,255,.55);letter-spacing:.4px}',
      '#dube-memory-pane .dube-mem-list{display:flex;flex-direction:column;gap:10px;padding:0 2px 8px}',
      '.dube-mem-item{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10)}',
      '.dube-mem-item.pending{background:rgba(244,180,90,.08);border-color:rgba(244,180,90,.30)}',
      '.dube-mem-content{font-size:13px;line-height:1.55;color:#fff;white-space:pre-wrap;word-break:break-word}',
      '.dube-mem-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}',
      '.dube-mem-badge{font-size:10.5px;padding:2px 8px;border-radius:9px;letter-spacing:.3px}',
      '.dube-mem-badge.active{background:rgba(126,226,168,.14);color:#7ee2a8;border:1px solid rgba(126,226,168,.3)}',
      '.dube-mem-badge.pending{background:rgba(244,210,138,.14);color:var(--champagne,#f4d28a);border:1px solid rgba(244,210,138,.32)}',
      '.dube-mem-tag{font-size:10.5px;padding:2px 8px;border-radius:9px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.1)}',
      '.dube-mem-date{font-size:10.5px;color:rgba(255,255,255,.35);margin-left:auto}',
      '.dube-mem-act{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}',
      '.dube-mem-act .fx-mini-btn{height:26px;padding:0 10px;font-size:11px}',
      '.dube-mem-edit{width:100%;box-sizing:border-box;min-height:60px;border-radius:10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.16);color:#fff;font-size:13px;font-family:inherit;padding:8px 10px;outline:none;resize:vertical}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'dube-mem-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(s) {
    if (!s) return '';
    try {
      // 后端 created_at 是 SQLite UTC（"YYYY-MM-DD HH:MM:SS"，无时区标记）——
      // 直接 new Date() 会被当本地时间解析，显示差 8 小时；补 "T…Z" 按 UTC 解析再本地化。
      var str = String(s);
      var iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str) ? str.replace(' ', 'T') + 'Z' : str;
      var d = new Date(iso);
      if (isNaN(d.getTime())) return str;
      return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return String(s); }
  }
  function statusLabel(st) { return st === 'pending' ? '待确认' : (st === 'active' ? '已记住' : (st || '')); }
  function toast(msg) { if (typeof showToast === 'function') showToast(msg); }

  function renderItem(m, listEl) {
    var card = document.createElement('div');
    card.className = 'dube-mem-item' + (m.status === 'pending' ? ' pending' : '');

    var content = document.createElement('div');
    content.className = 'dube-mem-content';
    content.textContent = m.content || '(空)';

    var meta = document.createElement('div');
    meta.className = 'dube-mem-meta';
    var badge = '<span class="dube-mem-badge ' + (m.status === 'pending' ? 'pending' : 'active') + '">' + esc(statusLabel(m.status)) + '</span>';
    var cat = m.category ? '<span class="dube-mem-tag">' + esc(m.category) + '</span>' : '';
    var tags = (m.tags || []).slice(0, 4).map(function (t) { return '<span class="dube-mem-tag">#' + esc(t) + '</span>'; }).join('');
    meta.innerHTML = badge + cat + tags + '<span class="dube-mem-date">' + esc(fmtDate(m.created_at)) + '</span>';

    var act = document.createElement('div');
    act.className = 'dube-mem-act';

    function mkBtn(label, handler) {
      var b = document.createElement('button');
      b.className = 'fx-mini-btn ghost';
      b.textContent = label;
      b.addEventListener('click', handler);
      return b;
    }

    // 编辑
    var editBtn = mkBtn('编辑', function () { startEdit(); });
    // 删除（两步确认，避免误删 + 便于无对话框环境测试）
    var delConfirming = false, delTimer = null;
    var delBtn = mkBtn('删除', function () {
      if (!delConfirming) {
        delConfirming = true; delBtn.textContent = '确认删除？';
        delTimer = setTimeout(function () { delConfirming = false; delBtn.textContent = '删除'; }, 3000);
        return;
      }
      clearTimeout(delTimer);
      delBtn.disabled = true;
      AI.deleteMemory(m.memory_id).then(function () {
        card.parentNode && card.parentNode.removeChild(card);
        toast('已删除该记忆');
        afterCountChange(listEl);
      }).catch(function (e) { delBtn.disabled = false; toast('删除失败'); });
    });

    act.appendChild(editBtn);
    if (m.status === 'pending') {
      act.appendChild(mkBtn('确认', function () {
        AI.confirmMemory(m.memory_id).then(function () {
          m.status = 'active';
          card.classList.remove('pending');
          rebuildMeta();
          rebuildActions();
          toast('已确认记住');
        }).catch(function () { toast('确认失败'); });
      }));
      act.appendChild(mkBtn('拒绝', function () {
        AI.rejectMemory(m.memory_id).then(function () {
          card.parentNode && card.parentNode.removeChild(card);
          toast('已拒绝该记忆');
          afterCountChange(listEl);
        }).catch(function () { toast('拒绝失败'); });
      }));
    }
    act.appendChild(delBtn);

    function rebuildMeta() {
      var badge2 = '<span class="dube-mem-badge ' + (m.status === 'pending' ? 'pending' : 'active') + '">' + esc(statusLabel(m.status)) + '</span>';
      meta.innerHTML = badge2 + cat + tags + '<span class="dube-mem-date">' + esc(fmtDate(m.created_at)) + '</span>';
    }
    function rebuildActions() {
      // 确认后去掉 确认/拒绝 按钮：简单起见整卡重建
      var fresh = renderItem(m, listEl);
      if (card.parentNode) card.parentNode.replaceChild(fresh, card);
    }

    function startEdit() {
      var ta = document.createElement('textarea');
      ta.className = 'dube-mem-edit';
      ta.value = m.content || '';
      var saveRow = document.createElement('div');
      saveRow.className = 'dube-mem-act';
      var saveBtn = mkBtn('保存', function () {
        var nv = ta.value.trim();
        if (!nv) { toast('内容不能为空'); return; }
        saveBtn.disabled = true;
        AI.updateMemory(m.memory_id, { content: nv }).then(function (updated) {
          m.content = (updated && updated.content) || nv;
          content.textContent = m.content;
          card.replaceChild(content, ta);
          card.replaceChild(act, saveRow);
          toast('已更新记忆');
        }).catch(function () { saveBtn.disabled = false; toast('更新失败'); });
      });
      var cancelBtn = mkBtn('取消', function () {
        card.replaceChild(content, ta);
        card.replaceChild(act, saveRow);
      });
      saveRow.appendChild(saveBtn);
      saveRow.appendChild(cancelBtn);
      card.replaceChild(ta, content);
      card.replaceChild(saveRow, act);
      ta.focus();
    }

    card.appendChild(content);
    card.appendChild(meta);
    card.appendChild(act);
    return card;
  }

  /** 当前助手名（未起名=dube；ai-client 单一真相源）。 */
  function aiName() {
    return (AI.getAssistantName && AI.getAssistantName()) || 'dube';
  }

  function afterCountChange(listEl) {
    if (listEl && !listEl.children.length) {
      listEl.innerHTML = '<div class="dube-empty">还没有记忆。多和 ' + esc(aiName()) + ' 聊聊，它会记住你的偏好。</div>';
    }
  }

  async function render(container) {
    if (!container) return;
    injectStyles();
    container.innerHTML =
      '<div class="dube-mem-head"><span class="t">' + esc(aiName()) + ' 的记忆</span>' +
      '<button class="fx-mini-btn ghost" id="dube-mem-refresh" style="height:26px;padding:0 10px;font-size:11px">刷新</button></div>' +
      '<div class="dube-mem-list">加载中…</div>';
    var listEl = container.querySelector('.dube-mem-list');
    var refreshBtn = container.querySelector('#dube-mem-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { render(container); });

    try {
      var res = await AI.fetchMemories();
      var items = (res && res.items) || [];
      if (!items.length) {
        listEl.innerHTML = '<div class="dube-empty">还没有记忆。多和 ' + esc(aiName()) + ' 聊聊，它会记住你的偏好。</div>';
        return;
      }
      listEl.innerHTML = '';
      items.forEach(function (m) { listEl.appendChild(renderItem(m, listEl)); });
    } catch (e) {
      listEl.innerHTML = '<div class="dube-empty">记忆加载失败：' + esc((e && e.message) || e) + '</div>';
    }
  }

  AI.renderMemoryPanel = render;
})();
