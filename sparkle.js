/*
 * 쓰자고 반짝이 효과(모든 화면 공통)
 *  - 하단 메뉴·수정 버튼을 누르면 별 모양 반짝이가 불꽃놀이처럼 퍼집니다.
 *    처음엔 빠르게 퍼지다 점점 느려지며 살짝 내려앉고, 천천히 사라집니다.
 *  - 페이지가 바뀌어도 다음 화면에서 이어서 재생해 잔상이 남습니다(sessionStorage 'sj-sparkle').
 *  - 터치 시 생기던 파란 음영(tap highlight)은 없앱니다.
 */
(function () {
  "use strict";
  var KEY = "sj-sparkle";
  var DUR = 1300;            // 한 개 반짝이 재생 시간(ms)
  var LIFE = DUR + 400;      // 다음 화면에서 이어 재생할 수 있는 최대 시간
  var COLORS = ["#A7B8FA", "#5B4885", "#C8C2ED", "#88AACA", "#EBD1DA", "#FDE7A3"];   // 지정 팔레트 안에서 진한 색을 섞어 잘 보이게
  var PATH = "M12 1.5L14.6 9.4L22.5 12L14.6 14.6L12 22.5L9.4 14.6L1.5 12L9.4 9.4Z";
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 파란 음영 제거 + 손가락 터치 후 남는 포커스 테두리 제거(키보드 포커스 표시는 유지)
  var css = document.createElement("style");
  css.textContent =
    "html,body,*{-webkit-tap-highlight-color:transparent}" +
    ".nav a:focus:not(:focus-visible),.nav button:focus:not(:focus-visible),.edit:focus:not(:focus-visible){outline:none}" +
    ".sjfx{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483000}" +
    ".sjfx svg{position:absolute;left:0;top:0;display:block;will-change:transform,opacity}";
  (document.head || document.documentElement).appendChild(css);

  // 같은 seed면 같은 모양 → 다음 화면에서 이어 재생해도 자연스럽게 연결
  function rng(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function layer() {
    var l = document.querySelector(".sjfx");
    if (!l) {
      l = document.createElement("div");
      l.className = "sjfx";
      l.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(l);
    }
    return l;
  }

  function burst(x, y, seed, elapsed) {
    if (reduced) return;
    var rand = rng(seed), l = layer();
    var n = 16;
    for (var i = 0; i < n; i++) {
      // 하단 메뉴에서 터지면 아래쪽은 화면 밖이라, 위쪽 부채꼴(약 220°)로 퍼지게 함. 화면 위쪽 버튼은 사방으로
      var up = y > window.innerHeight * 0.6;
      var ang = up ? (-Math.PI - 0.35) + ((Math.PI + 0.7) * i) / (n - 1) + (rand() - 0.5) * 0.25
                   : (Math.PI * 2 * i) / n + (rand() - 0.5) * 0.35;
      var dist = 85 + rand() * 65;                 // 퍼지는 거리(px)
      var size = 22 + rand() * 14;                 // 별 크기(px)
      var color = COLORS[i % COLORS.length];
      var delay = rand() * 70;
      var dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
      var drop = 14 + rand() * 12;                 // 끝으로 갈수록 살짝 내려앉음(불꽃놀이)
      var spin = (rand() - 0.5) * 70;
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", size);
      svg.setAttribute("height", size);
      svg.innerHTML = '<path d="' + PATH + '" fill="' + color + '"/>';
      l.appendChild(svg);
      var h = size / 2;
      var at = function (fx, fy, s, r) {
        return "translate(" + (x - h + fx) + "px," + (y - h + fy) + "px) scale(" + s + ") rotate(" + r + "deg)";
      };
      // 움직임: 처음 빠르고 점점 느려지며(감속) 끝에서 살짝 내려앉음
      var anim = svg.animate([
        { transform: at(0, 0, 0.3, 0) },
        { transform: at(dx * 0.82, dy * 0.82 + drop * 0.15, 1.15, spin * 0.6), offset: 0.45 },
        { transform: at(dx, dy + drop, 0.7, spin) }
      ], { duration: DUR, delay: delay, easing: "cubic-bezier(.05,.8,.3,1)", fill: "both" });
      // 투명도: 바로 나타나 한동안 보이다가 마지막에 천천히 사라짐(잔상)
      var fade = svg.animate([
        { opacity: 0 }, { opacity: 1, offset: 0.06 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }
      ], { duration: DUR, delay: delay, easing: "linear", fill: "both" });
      if (elapsed > 0) fade.currentTime = elapsed;
      if (elapsed > 0) anim.currentTime = elapsed;
      (function (el, a) {
        var gone = function () { if (el.parentNode) el.parentNode.removeChild(el); };
        a.onfinish = gone;
        setTimeout(gone, DUR + 200 - (elapsed || 0));
      })(svg, anim);
    }
  }

  function save(x, y, seed) {
    try { sessionStorage.setItem(KEY, JSON.stringify({ x: x, y: y, s: seed, t: Date.now() })); } catch (e) {}
  }

  // 이전 화면에서 누른 반짝이가 아직 재생 중이면 이어서 재생
  function resume() {
    var o = null;
    try { o = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) {}
    if (!o) return;
    var el = Date.now() - o.t;
    if (el >= 0 && el < LIFE) burst(o.x, o.y, o.s, el);
  }
  if (document.body) resume();
  else document.addEventListener("DOMContentLoaded", resume);
  window.addEventListener("pageshow", function (e) { if (e.persisted) resume(); });

  var SEL = ".nav a,.nav button,.edit,[data-sparkle]";
  document.addEventListener("pointerdown", function (e) {
    var t = e.target && e.target.closest && e.target.closest(SEL);
    if (!t) return;
    var r = t.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var seed = (Math.random() * 4294967296) >>> 0;
    save(x, y, seed);
    burst(x, y, seed, 0);
  }, { passive: true });

  window.SJ_SPARKLE = { burst: function (x, y) { burst(x, y, (Math.random() * 4294967296) >>> 0, 0); } };
})();
