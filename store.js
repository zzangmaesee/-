/*
 * 쓰자고 저장소 (IndexedDB) — 2단계 '저장 방식 강화'
 *
 * 왜: localStorage는 약 5MB라 제품 사진이 쌓이면 금방 가득 참. IndexedDB는 수백 MB까지 사용 가능.
 * 구조: DB 'sseujago' (스키마 1)
 *   - kv     : 'items'(제품 목록, 사진은 참조로 대체), 'locations'(보관 위치), 'meta'(스키마·이전 기록)
 *   - photos : 사진 원본(dataURL). 같은 사진은 한 번만 저장(내용 해시 키)
 * 앱 화면에는 기존과 똑같은 형식(제품의 photo/photos에 사진 dataURL)으로 돌려주므로 필드 의미는 그대로.
 *
 * 이전(마이그레이션): 처음 실행 시 localStorage의 기존 데이터를 옮긴 뒤 다시 읽어 개수·사진 수를 검증.
 *   - 검증 성공: 이후 IndexedDB만 사용. 기존 localStorage 원본은 안전을 위해 7일 보관 후 정리
 *   - 검증 실패 또는 IndexedDB 사용 불가(일부 개인정보 보호 모드): 기존 방식(localStorage) 그대로 사용
 *
 * 사용: await SJ_STORE.ready → SJ_STORE.items(), SJ_STORE.locations(), await SJ_STORE.save(items, locations)
 */
(function () {
  "use strict";
  var KEY = "cosmetics-inventory-v2", LK = "cosmetics-locations-v1";
  var FLAG = "sj-storage", KEEP_UNTIL = "sj-ls-keep-until";
  var DB = "sseujago", VER = 1, SCHEMA = 1, REF = "idbph:";
  var db = null, mode = "local", items = [], locs = [], queue = Promise.resolve();

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }

  // 사진 내용 해시(같은 사진은 같은 키) — FNV-1a + djb2 결합
  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 5381;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = ((h2 << 5) + h2 + c) >>> 0;
    }
    return h1.toString(36) + h2.toString(36) + s.length.toString(36);
  }
  function isPic(v) { return typeof v === "string" && v.indexOf("data:image/") === 0; }

  function openDB() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error("no-idb"));
      var r;
      try { r = indexedDB.open(DB, VER); } catch (e) { return rej(e); }
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
        if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos");
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.onblocked = function () { rej(new Error("blocked")); };
    });
  }
  function tx(stores, modeRW, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(stores, modeRW), out;
      t.oncomplete = function () { res(out); };
      t.onerror = t.onabort = function () { rej(t.error || new Error("tx")); };
      out = fn(t);
    });
  }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  // 저장용: 사진 dataURL → 참조, 사진 목록 수집
  function split(list) {
    var pics = {};
    var out = (list || []).map(function (x) {
      if (!x || typeof x !== "object") return x;
      var y = Object.assign({}, x);
      if (isPic(y.photo)) { var k = hash(y.photo); pics[k] = y.photo; y.photo = REF + k; }
      if (Array.isArray(y.photos)) y.photos = y.photos.map(function (p) {
        if (isPic(p)) { var k2 = hash(p); pics[k2] = p; return REF + k2; }
        return p;
      });
      return y;
    });
    return { items: out, pics: pics };
  }
  // 읽기용: 참조 → 사진 dataURL
  function join(list, picMap) {
    var fix = function (v) { return typeof v === "string" && v.indexOf(REF) === 0 ? (picMap[v.slice(REF.length)] || "") : v; };
    return (list || []).map(function (x) {
      if (!x || typeof x !== "object") return x;
      var y = Object.assign({}, x);
      if (typeof y.photo === "string") y.photo = fix(y.photo);
      if (Array.isArray(y.photos)) y.photos = y.photos.map(fix).filter(function (p) { return p !== ""; });
      return y;
    });
  }
  function countPics(list) {
    var n = 0;
    (list || []).forEach(function (x) {
      if (!x) return;
      if (isPic(x.photo)) n++;
      if (Array.isArray(x.photos)) x.photos.forEach(function (p) { if (isPic(p)) n++; });
    });
    return n;
  }

  async function writeIDB(list, locations) {
    var s = split(list);
    var keep = Object.keys(s.pics);
    await tx(["kv", "photos"], "readwrite", function (t) {
      var ps = t.objectStore("photos");
      keep.forEach(function (k) { ps.put(s.pics[k], k); });
      t.objectStore("kv").put(s.items, "items");
      t.objectStore("kv").put(locations || [], "locations");
    });
    // 더 이상 쓰지 않는 사진 정리
    var all = await tx(["photos"], "readonly", function (t) { return req(t.objectStore("photos").getAllKeys()); });
    all = await all;
    var gone = all.filter(function (k) { return keep.indexOf(k) < 0; });
    if (gone.length) await tx(["photos"], "readwrite", function (t) { var ps = t.objectStore("photos"); gone.forEach(function (k) { ps.delete(k); }); });
  }

  async function readIDB() {
    var got = await tx(["kv", "photos"], "readonly", function (t) {
      var kv = t.objectStore("kv"), ps = t.objectStore("photos");
      return Promise.all([req(kv.get("items")), req(kv.get("locations")), req(kv.get("meta")), req(ps.getAllKeys()), req(ps.getAll())]);
    });
    got = await got;
    var map = {};
    got[3].forEach(function (k, i) { map[k] = got[4][i]; });
    return { items: join(got[0] || [], map), locations: got[1] || [], meta: got[2] || null };
  }

  async function migrate() {
    var src = lsGet(KEY) || [], srcL = lsGet(LK) || [];
    await writeIDB(src, srcL);
    var back = await readIDB();
    var ok = back.items.length === src.length && countPics(back.items) === countPics(src) && back.locations.length === srcL.length;
    if (!ok) {
      // 검증 실패: 옮긴 것을 지우고 기존 방식 유지(원본은 손대지 않음)
      await tx(["kv", "photos"], "readwrite", function (t) { t.objectStore("kv").clear(); t.objectStore("photos").clear(); });
      throw new Error("verify-failed");
    }
    var meta = { schema: SCHEMA, migratedAt: new Date().toISOString(), from: "localStorage", items: src.length, photos: countPics(src) };
    await tx(["kv"], "readwrite", function (t) { t.objectStore("kv").put(meta, "meta"); });
    try {
      localStorage.setItem(FLAG, "idb");
      localStorage.setItem(KEEP_UNTIL, String(Date.now() + 7 * 86400000));
    } catch (e) {}
    back.meta = meta;
    return back;
  }

  // 7일 보관 기간이 지나면 localStorage 원본 정리(공간 확보)
  function cleanupLS() {
    try {
      var until = Number(localStorage.getItem(KEEP_UNTIL)) || 0;
      if (until && Date.now() > until) {
        localStorage.removeItem(KEY); localStorage.removeItem(LK); localStorage.removeItem(KEEP_UNTIL);
      }
    } catch (e) {}
  }

  async function init() {
    try {
      db = await openDB();
      var cur = await readIDB();
      if (!cur.meta) cur = await migrate();
      items = cur.items; locs = cur.locations; mode = "idb";
      cleanupLS();
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    } catch (e) {
      // IndexedDB를 쓸 수 없으면 기존 방식
      mode = "local"; db = null;
      items = lsGet(KEY) || []; locs = lsGet(LK) || [];
    }
  }

  function saveLocal(list, locations) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      localStorage.setItem(LK, JSON.stringify(locations));
      return true;
    } catch (e) { return false; }
  }

  var ready = init();
  queue = ready.catch(function () {});   // 저장은 준비(이전 포함)가 끝난 뒤에만

  window.SJ_STORE = {
    ready: ready,
    mode: function () { return mode; },
    items: function () { return items.slice(); },
    locations: function () { return locs.slice(); },
    // 저장: 성공 true / 실패 false. 저장은 순서대로 처리
    save: function (list, locations) {
      var snapI = list.slice(), snapL = (locations === undefined ? null : locations.slice());
      var p = queue.then(function () {
        if (!snapL) snapL = locs.slice();
        items = snapI.slice(); locs = snapL.slice();
        if (mode !== "idb") return saveLocal(snapI, snapL);
        return writeIDB(snapI, snapL).then(function () { return true; }, function () { return false; });
      });
      queue = p.catch(function () {});
      return p;
    },
    info: async function () {
      var est = null;
      try { if (navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate(); } catch (e) {}
      return { mode: mode, items: items.length, photos: countPics(items), usage: est && est.usage, quota: est && est.quota };
    }
  };
})();
