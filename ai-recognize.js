/*
 * 쓰자고 AI 사진 인식(찍자고) 어댑터 + 쓰자팁 지갑
 * recognizeProducts(file) → 표준 결과 {ok, items[], remaining, code, message}
 *  - 공급자(Gemini 등)는 Worker 쪽에 숨겨져 있어, 공급자가 바뀌어도 이 함수 모양은 그대로 둡니다.
 *  - 전송 전 긴 변 1024px JPEG로 다시 그려 EXIF(위치 등 메타데이터)를 제거합니다.
 *  - 비밀값 없음: endpoint 주소는 config.js에 있고 누구나 볼 수 있어도 괜찮습니다.
 */
(function () {
  "use strict";
  var DEVICE_KEY = "sj-device-id";
  var MAX_SIDE = 1024;
  var TIMEOUT_MS = 40000;

  function endpoint() {
    var ai = (window.SJ_CONFIG || {}).ai || {};
    return (ai.endpoint || "").replace(/\/+$/, "");
  }

  function deviceId() {
    var id = "";
    try { id = localStorage.getItem(DEVICE_KEY) || ""; } catch (e) {}
    if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) {
      if (window.crypto && crypto.randomUUID) id = crypto.randomUUID();
      else {
        var a = new Uint8Array(16);
        (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
        id = Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
      }
      try { localStorage.setItem(DEVICE_KEY, id); } catch (e) {}
    }
    return id;
  }

  // 긴 변 1024px JPEG로 축소 + 메타데이터 제거(캔버스에 다시 그리면 EXIF가 남지 않음)
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || "image/")) return reject(new Error("BAD_IMAGE_TYPE"));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          var sc = Math.min(1, MAX_SIDE / Math.max(w, h));
          var c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(w * sc));
          c.height = Math.max(1, Math.round(h * sc));
          var x = c.getContext("2d");
          x.fillStyle = "#fff";
          x.fillRect(0, 0, c.width, c.height);
          x.drawImage(img, 0, 0, c.width, c.height);
          var data = c.toDataURL("image/jpeg", 0.85);
          URL.revokeObjectURL(url);
          resolve(data.slice(data.indexOf(",") + 1));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("BAD_IMAGE")); };
      img.src = url;
    });
  }

  function failResult(code, message, extra) {
    var r = { ok: false, items: [], code: code, message: message };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  async function recognizeProducts(file, opts) {
    opts = opts || {};
    var base = endpoint();
    if (!base) return failResult("NO_ENDPOINT", "AI 인식이 아직 설정되지 않았습니다.");
    if (!navigator.onLine) return failResult("OFFLINE", "인터넷 연결이 없어 AI 인식을 할 수 없습니다.");

    var image;
    try { image = await shrink(file); }
    catch (e) { return failResult("BAD_IMAGE", "이 사진은 열 수 없습니다. 다른 사진을 선택해 주세요."); }

    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
    try {
      var out = await withHuman(function (ts) {
        return fetch(base + "/recognize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId: deviceId(), image: image, mime: "image/jpeg", categories: opts.categories, ts: ts || undefined }),
          signal: ac.signal
        });
      });
      var res = out.res, j = out.json;
      if (!j || typeof j !== "object") return failResult("BAD_RESPONSE", "AI 인식 응답을 읽지 못했습니다.");
      if (!res.ok || !j.ok) return failResult(j.code || "HTTP_" + res.status, j.message || "찍자고 인식에 실패했습니다.", { remaining: j.remaining, balance: j.balance, photos: j.photos, cost: j.cost });
      var items = (Array.isArray(j.items) ? j.items : []).filter(function (it) {
        return it && typeof it.name === "string" && it.name.trim();
      });
      return { ok: true, items: items, sourceType: j.sourceType || "other", remaining: j.remaining,
        balance: j.balance, photos: j.photos, charged: j.charged || 0, cost: j.cost };
    } catch (e) {
      return e && e.name === "AbortError"
        ? failResult("TIMEOUT", "AI 인식 시간이 너무 오래 걸려 중단했습니다.")
        : failResult("NETWORK", "AI 서버에 연결하지 못했습니다.");
    } finally {
      clearTimeout(timer);
    }
  }

  async function aiQuota() {
    var base = endpoint();
    if (!base || !navigator.onLine) return null;
    try {
      var r = await fetch(base + "/quota?deviceId=" + encodeURIComponent(deviceId()));
      var j = await r.json();
      return j && j.ok ? j : null;
    } catch (e) { return null; }
  }

  // 쓰자팁 지갑: 잔액 조회(처음이면 서버가 환영 쓰자팁 지급) / 하루 출석
  /* ---------- 봇 차단(Cloudflare Turnstile): 처음 쓰자팁 지갑을 만들 때 한 번만 ---------- */
  var WALLET_OK = "sj-wallet-ok", tsLoading = null;
  function siteKey() { return (window.SJ_CONFIG || {}).turnstileSiteKey || ""; }
  function walletKnown() { try { return localStorage.getItem(WALLET_OK) === "1"; } catch (e) { return false; } }
  function markWallet() { try { localStorage.setItem(WALLET_OK, "1"); } catch (e) {} }
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (!tsLoading) tsLoading = new Promise(function (res, rej) {
      var sc = document.createElement("script");
      sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      sc.async = true; sc.onload = res; sc.onerror = function () { tsLoading = null; rej(new Error("ts-load")); };
      document.head.appendChild(sc);
    });
    return tsLoading;
  }
  // 사람 확인 토큰 받기(보통 화면에 아무것도 보이지 않음. 의심스러울 때만 체크 상자 표시)
  async function humanToken() {
    if (!siteKey()) return "";
    try { await loadTurnstile(); } catch (e) { return ""; }
    return new Promise(function (res) {
      var box = document.createElement("div");
      box.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:3000";
      document.body.appendChild(box);
      var done = function (t) { clearTimeout(timer); try { window.turnstile.remove(wid); } catch (e) {} box.remove(); res(t || ""); };
      var timer = setTimeout(function () { done(""); }, 20000);
      var wid = window.turnstile.render(box, {
        sitekey: siteKey(), appearance: "interaction-only", language: "ko",
        callback: function (t) { done(t); }, "error-callback": function () { done(""); }, "expired-callback": function () { done(""); }
      });
    });
  }
  // 처음 사용이면 토큰을 붙여 요청, '사람 확인 필요'가 오면 토큰을 새로 받아 한 번 다시 시도
  async function withHuman(send) {
    var ts = walletKnown() ? "" : await humanToken();
    var r = await send(ts), j = null;
    try { j = await r.json(); } catch (e) {}
    if (j && j.code === "HUMAN_CHECK") {
      ts = await humanToken();
      r = await send(ts);
      try { j = await r.json(); } catch (e) { j = null; }
    }
    if (j && (j.ok || typeof j.balance === "number")) markWallet();
    return { res: r, json: j };
  }

  async function wallet(withLog) {
    var base = endpoint();
    if (!base || !navigator.onLine) return null;
    try {
      var out = await withHuman(function (ts) {
        return fetch(base + "/wallet?deviceId=" + encodeURIComponent(deviceId()) + (withLog ? "&log=1" : "") + (ts ? "&ts=" + encodeURIComponent(ts) : ""));
      });
      return out.json && out.json.ok ? out.json : null;
    } catch (e) { return null; }
  }
  async function attend() {
    var base = endpoint();
    if (!base || !navigator.onLine) return null;
    try {
      var out = await withHuman(function (ts) {
        return fetch(base + "/attend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: deviceId(), ts: ts || undefined }) });
      });
      return out.json && out.json.ok ? out.json : null;
    } catch (e) { return null; }
  }
  // 백업·복원용: 쓰자팁 지갑은 기기 ID에 묶여 있어 복원 시 함께 옮깁니다
  function getDeviceId() { return deviceId(); }
  function setDeviceId(id) {
    if (!/^[A-Za-z0-9-]{16,64}$/.test(String(id || ""))) return false;
    try { localStorage.setItem(DEVICE_KEY, id); return true; } catch (e) { return false; }
  }

  window.SJ_AI = { recognizeProducts: recognizeProducts, quota: aiQuota, wallet: wallet, attend: attend,
    deviceId: getDeviceId, setDeviceId: setDeviceId, enabled: function () { return !!endpoint(); } };
})();
