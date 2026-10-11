/*
 * 쓰자고 공통: 앱 종료 이어가기 (모든 화면에서 맨 먼저 실행)
 * 재고 화면에서 [종료]를 누르면 'sj-exit-at'에 시각을 남기고 뒤로 이동합니다.
 * 뒤로 이동해 도착한 화면이 쓰자고의 다른 화면이면, 3초 안의 종료 요청일 때 계속 뒤로 이동해 앱을 빠져나갑니다.
 */
(function () {
  "use strict";
  var KEY = "sj-exit-at";
  function exitPending() {
    try {
      var t = Number(sessionStorage.getItem(KEY)) || 0;
      return t && Date.now() - t < 3000;
    } catch (e) { return false; }
  }
  function continueExit() {
    try { document.documentElement.style.visibility = "hidden"; } catch (e) {}
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) {}   // 단계마다 시간 갱신
    history.back();
  }
  if (exitPending()) continueExit();
  // 같은 화면 안의 기록(재고 화면의 안전 기록 등)을 지날 때도 계속 뒤로
  window.addEventListener("popstate", function () { if (exitPending()) continueExit(); });
  window.addEventListener("pageshow", function (e) {
    if (e.persisted && exitPending()) continueExit();
    else { try { document.documentElement.style.visibility = ""; } catch (err) {} }
  });
  window.SJ_EXIT = {
    start: function () {
      try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) {}
    },
    pending: exitPending
  };
})();

/*
 * 하단 메뉴 즉시 이동: 손가락이 닿는 순간(pointerdown) 바로 다음 화면으로 이동합니다.
 * (손을 뗄 때까지 기다리는 click보다 빠름. 키보드·접근성 도구의 click도 그대로 동작)
 */
(function () {
  "use strict";
  var going = false;
  function same(a) {
    try { var u = new URL(a.href, location.href); return u.pathname === location.pathname && u.search === location.search; }
    catch (e) { return true; }
  }
  document.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var a = e.target && e.target.closest && e.target.closest(".nav a[href]");
    if (!a || same(a)) return;
    going = true;
    location.assign(a.href);
  }, true);
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest(".nav a[href]");
    if (a && going) e.preventDefault();
  }, true);
  window.addEventListener("pageshow", function () { going = false; });
})();
