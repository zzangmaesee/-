/*
 * 쓰자고 빌드 설정 (비밀값 금지: 이 파일은 브라우저에서 누구나 볼 수 있습니다)
 *
 * target
 *   'web'  : 링크 배포용(친구 테스트). 광고 없음.
 *   'play' : 구글플레이 앱용(Capacitor 포장). 광고 허용.
 *
 * 광고는 target==='play' 이고 adsEnabled===true 일 때만 켜집니다.
 * 링크용(web)에서는 adsEnabled를 true로 바꿔도 광고가 켜지지 않습니다.
 */
(function () {
  "use strict";
  var target = "web";
  var cfg = {
    target: target,
    adsEnabled: false,
    appVersion: "1.0.14",
    dataVersion: 2,
    // 광고를 절대 넣지 않는 화면(재고 확인·수정·백업 등 핵심 기능 보호)
    adFreeScreens: ["inventory", "edit", "settings", "backup"],
    ai: {
      endpoint: "https://sseujago.zzangmaesee.workers.dev",   // AI 인식 Worker 주소(비밀값 아님, 키는 Worker에만 있음)
      dailyLimit: 3
    }
  };
  cfg.adsActive = cfg.target === "play" && cfg.adsEnabled === true;
  window.SJ_CONFIG = Object.freeze(cfg);

  // 광고 자리: data-ad-slot 요소는 광고가 꺼져 있으면 화면에서 제거됩니다.
  function clearSlots() {
    if (window.SJ_CONFIG.adsActive) return;
    var slots = document.querySelectorAll("[data-ad-slot]");
    for (var i = 0; i < slots.length; i++) slots[i].remove();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", clearSlots);
  else clearSlots();
})();
