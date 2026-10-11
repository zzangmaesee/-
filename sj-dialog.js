/*
 * 쓰자고 앱 창(알림·확인·입력) — 브라우저 기본 창 대신 사용(맨 위에 앱 주소가 표시되지 않음)
 *  SJ.alert(메시지, {title, ok})                     → Promise<void>
 *  SJ.confirm(메시지, {title, ok, cancel, danger})   → Promise<boolean>
 *  SJ.prompt(메시지, {title, value, placeholder, ok}) → Promise<string|null>
 * window.alert도 이 창으로 바꿉니다(기다리지 않는 알림용).
 */
(function () {
  "use strict";
  var queue = Promise.resolve(), cur = null;

  var css = document.createElement("style");
  css.textContent =
    ".sjdlg{position:fixed;inset:0;z-index:2000;background:rgba(43,37,64,.42);display:flex;align-items:center;justify-content:center;padding:20px}" +
    ".sjdlg[hidden]{display:none}" +
    ".sjdlg-box{width:min(400px,100%);background:#fff;border-radius:20px;padding:22px 18px 16px;box-shadow:0 10px 30px rgba(43,37,64,.18);animation:sjdlgUp .18s ease-out}" +
    "@keyframes sjdlgUp{from{transform:scale(.94);opacity:0}to{transform:none;opacity:1}}" +
    ".sjdlg-t{display:block;font-family:\"Tmoney RoundWind\",sans-serif!important;font-weight:800;font-size:21px;letter-spacing:-.8px;color:#5B4885;margin:0 0 10px}" +
    ".sjdlg-m{margin:0 0 16px;font-size:14px;line-height:1.6;color:#4b4462;white-space:pre-line;word-break:keep-all}" +
    ".sjdlg-in{width:100%;height:46px;border:1px solid #DED8E8;border-radius:12px;padding:0 12px;font-size:15px;margin:0 0 16px;font-family:inherit;color:#2b2540}" +
    ".sjdlg-in:focus{outline:2px solid #A7B8FA;border-color:#A7B8FA}" +
    ".sjdlg-b{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sjdlg-b.one{grid-template-columns:1fr}" +
    ".sjdlg-b button{height:48px;border-radius:12px;font-size:15px;font-weight:850;font-family:inherit;cursor:pointer}" +
    ".sjdlg-no{border:1px solid #DED8E8;background:#fff;color:#5B4885}.sjdlg-ok{border:0;background:#5B4885;color:#fff}.sjdlg-ok.danger{background:#C54862}";
  (document.head || document.documentElement).appendChild(css);

  function build() {
    var el = document.createElement("div");
    el.className = "sjdlg";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "sjdlgT");
    el.innerHTML = '<div class="sjdlg-box"><b class="sjdlg-t" id="sjdlgT"></b><p class="sjdlg-m"></p>' +
      '<input class="sjdlg-in" hidden><div class="sjdlg-b"><button type="button" class="sjdlg-no"></button><button type="button" class="sjdlg-ok"></button></div></div>';
    document.body.appendChild(el);
    return el;
  }

  function show(kind, msg, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var el = document.querySelector(".sjdlg") || build();
      var t = el.querySelector(".sjdlg-t"), m = el.querySelector(".sjdlg-m"), inp = el.querySelector(".sjdlg-in");
      var no = el.querySelector(".sjdlg-no"), ok = el.querySelector(".sjdlg-ok"), btns = el.querySelector(".sjdlg-b");
      var prevFocus = document.activeElement;
      t.textContent = o.title || "쓰자고";
      m.textContent = msg == null ? "" : String(msg);
      inp.hidden = kind !== "prompt";
      inp.value = o.value || "";
      inp.placeholder = o.placeholder || "";
      ok.textContent = o.ok || "확인";
      no.textContent = o.cancel || "취소";
      ok.classList.toggle("danger", !!o.danger);
      no.hidden = kind === "alert";
      btns.classList.toggle("one", kind === "alert");
      el.hidden = false;

      function done(v) {
        el.hidden = true;
        ok.onclick = no.onclick = el.onclick = inp.onkeydown = null;
        document.removeEventListener("keydown", onKey, true);
        cur = null;
        try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch (e) {}
        resolve(v);
      }
      var yes = function () { done(kind === "confirm" ? true : kind === "prompt" ? inp.value : undefined); };
      var cancel = function () { done(kind === "confirm" ? false : kind === "prompt" ? null : undefined); };
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        else if (e.key === "Enter" && (kind !== "confirm" || document.activeElement === ok)) { e.preventDefault(); yes(); }
      }
      ok.onclick = yes;
      no.onclick = cancel;
      el.onclick = function (e) { if (e.target === el) cancel(); };
      document.addEventListener("keydown", onKey, true);
      cur = { cancel: cancel };
      setTimeout(function () { (kind === "prompt" ? inp : (kind === "confirm" && o.danger ? no : ok)).focus(); }, 30);
    });
  }

  // 여러 창이 겹치지 않도록 차례로 표시
  function enqueue(kind, msg, o) {
    var p = queue.then(function () { return show(kind, msg, o); });
    queue = p.catch(function () {});
    return p;
  }

  window.SJ = window.SJ || {};
  window.SJ.alert = function (m, o) { return enqueue("alert", m, o); };
  window.SJ.confirm = function (m, o) { return enqueue("confirm", m, o); };
  window.SJ.prompt = function (m, o) { return enqueue("prompt", m, o); };
  window.SJ_DIALOG = { isOpen: function () { return !!cur; }, cancel: function () { if (cur) cur.cancel(); } };
  window.alert = function (m) { window.SJ.alert(m); };
})();
