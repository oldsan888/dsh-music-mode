(function () {
  'use strict';
  // DSH overlay（2026-08-19 端到端联调）：音乐 tab 是 DSH 内的 iframe，不需要
  // PWA 离线缓存。更关键的是 vendored SW 代理 /api/player/link 这类 SSE 长连会
  // fetch 失败（"FetchEvent ... network error"），直接把播放器在场通道挂死。
  // 因此：不再注册 SW，并把任何已注册的（含旧版本）卸载。
  if (!('serviceWorker' in navigator)) return;
  if (navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker
      .getRegistrations()
      .then(function (rs) { rs.forEach(function (r) { r.unregister(); }); })
      .catch(function () {});
  }
})();
