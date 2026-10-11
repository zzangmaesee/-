/*
 * 쓰자고 뒤로가기 처리 (재고 화면 index.html 전용)
 *  - 폰 뒤로가기 1번: 열려 있는 화면(수정·날짜·설정 등)을 닫고 이전 화면으로
 *  - 첫 화면에서 뒤로가기: "쓰자고를 종료할까요?" 확인 창
 *  - 확인 창에서 [종료] 또는 뒤로가기를 한 번 더 누르면 앱 종료
 * 원리: 첫 화면 위에 보이지 않는 '안전 기록'을 하나 쌓아 두고, 뒤로가기가 그 기록을 지울 때 가로챕니다.
 */
(function () {
  "use strict";
  if (!window.history || !history.pushState) return;

  // 위에 떠 있는 화면부터 닫기(나중에 열리는 화면이 앞쪽)
  var ORDER = ["notebook", "tipsheet", "calendar", "photomodal", "notifmodal", "locmodal", "form", "setmodal", "choice"];
  var exiting = false;

  function topModal() {
    for (var i = 0; i < ORDER.length; i++) {
      var m = document.getElementById(ORDER[i]);
      if (m && m.classList.contains("open")) return m;
    }
    return null;
  }

  function closeModal(m) {
    m.classList.remove("open");
    if (m.id === "choice") {
      var add = document.getElementById("add"), home = document.getElementById("navHome");
      if (add) add.classList.remove("on");
      if (home) home.classList.add("on");
    }
  }

  function guard() { history.pushState({ sj: "guard" }, ""); }

  // 종료 확인 창
  var sheet = document.createElement("div");
  sheet.className = "exitsheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "exitTitle");
  sheet.hidden = true;
  sheet.innerHTML =
    '<div class="exitbox"><b id="exitTitle">쓰자고를 종료할까요?</b>' +
    '<p>뒤로가기를 한 번 더 누르거나 [종료]를 누르면 앱이 닫혀요.</p>' +
    '<div class="exitbtns"><button type="button" class="exitstay">계속 쓰기</button>' +
    '<button type="button" class="exitgo">종료</button></div></div>';
  var css = document.createElement("style");
  css.textContent =
    ".exitsheet{position:fixed;inset:0;z-index:1000;background:rgba(43,37,64,.38);display:flex;align-items:flex-end;justify-content:center;padding:0 12px calc(16px + env(safe-area-inset-bottom))}" +
    ".exitsheet[hidden]{display:none}" +
    ".exitbox{width:min(536px,100%);background:#fff;border-radius:20px;padding:22px 18px 16px;box-shadow:0 10px 30px rgba(43,37,64,.18)}" +
    ".exitbox b{display:block;font-size:17px;color:#5B4885;font-weight:850}" +
    ".exitbox p{margin:8px 0 16px;font-size:13px;line-height:1.55;color:#686172}" +
    ".exitbtns{display:grid;grid-template-columns:1fr 1fr;gap:8px}" +
    ".exitbtns button{height:48px;border-radius:12px;font-size:15px;font-weight:850;font-family:inherit}" +
    ".exitstay{border:1px solid #DED8E8;background:#fff;color:#5B4885}" +
    ".exitgo{border:0;background:#5B4885;color:#fff}";
  document.head.appendChild(css);
  document.body.appendChild(sheet);

  function showExit() {
    sheet.hidden = false;
    var b = sheet.querySelector(".exitstay");
    if (b) b.focus();
  }
  function hideExit() { sheet.hidden = true; }

  function exitApp() {
    exiting = true;
    hideExit();
    // 쌓인 기록을 모두 지나 앱 밖으로 나갑니다(다른 쓰자고 화면에 도착하면 nav.js가 이어서 뒤로 이동)
    if (window.SJ_EXIT) SJ_EXIT.start();
    history.back();
  }

  sheet.querySelector(".exitstay").addEventListener("click", hideExit);
  sheet.querySelector(".exitgo").addEventListener("click", exitApp);
  sheet.addEventListener("click", function (e) { if (e.target === sheet) hideExit(); });

  window.addEventListener("popstate", function () {
    if (exiting || (window.SJ_EXIT && SJ_EXIT.pending())) return;   // 종료 진행은 nav.js가 처리
    // 확인 창이 떠 있을 때 뒤로가기 = 종료
    if (!sheet.hidden) { exitApp(); return; }
    var m = topModal();
    if (m) closeModal(m);
    else showExit();
    guard();
  });

  // 시작: 현재 위치를 '첫 화면'으로 표시하고 안전 기록 1개 쌓기(이미 쌓여 있으면 그대로)
  if (window.SJ_EXIT && SJ_EXIT.pending()) return;
  var st = history.state;
  if (!(st && st.sj === "guard")) {
    history.replaceState({ sj: "root" }, "");
    guard();
  }
})();
