/*
 * 쓰자고 서비스워커 — 화면 전환을 즉시 하기 위해 '저장본 먼저 보여주고, 뒤에서 최신본으로 갱신' 방식
 *  - 같은 주소의 화면·파일: 저장본이 있으면 즉시 응답 → 동시에 네트워크로 새 버전을 받아 저장본 교체
 *  - 저장본이 없으면 네트워크 → 받으면 저장
 *  - 오프라인: 저장본, 화면이 없으면 재고 화면
 *  - 다른 주소(AI 서버, 글꼴 CDN 등)는 관여하지 않음
 * 새 버전 배포 시 CACHE 이름을 올리면, 새 서비스워커가 설치되면서 전체 파일을 새로 받아 둡니다.
 */
const CACHE = 'sseujago-v51';
const ASSETS = ['./', './index.html', './photo-import.html', './dashboard.html', './guide.html', './privacy.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-48.png', './intro.css', './intro.js', './config.js',
  './ai-recognize.js', './nav.js', './back-nav.js', './sparkle.js', './sj-dialog.js', './store.js', './intro-art.png',
  './icon-maskable-192.png', './icon-maskable-512.png'];

// Cloudflare Pages는 /x.html 을 /x 로 리디렉트함. 리디렉트를 거친 응답을 화면 이동에 그대로 쓰면
// 브라우저가 '사이트에 연결할 수 없음' 오류를 내므로, 내용만 담은 새 응답으로 바꿔서 저장·사용
function clean(r) {
  if (!r || !r.redirected) return r;
  return r.blob().then(b => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers }));
}

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(ASSETS.map(u => fetch(new Request(u, { cache: 'reload' }))
      .then(r => r.ok ? Promise.resolve(clean(r)).then(x => c.put(u, x)) : null).catch(() => null)))
  ));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 화면 이동은 주소 뒤 ?add=1 같은 값과 관계없이 같은 화면 저장본 사용
    const nav = req.mode === 'navigate';
    const cached = await cache.match(req, { ignoreSearch: true });
    // 화면 이동 요청은 리디렉트를 따라가서 받은 뒤 깨끗한 응답으로 바꿈
    const network = (nav ? fetch(req.url, { credentials: 'same-origin' }) : fetch(req))
      .then(clean)
      .then(r => {
        if (r && r.ok && (r.type === 'basic' || r.type === 'default')) {
          cache.put(nav ? url.origin + url.pathname : req, r.clone()).catch(() => {});
        }
        return r;
      }).catch(() => null);
    if (cached) { e.waitUntil(network); return clean(cached); }
    const r = await network;
    if (r) return r;
    return (await cache.match('./index.html')) || Response.error();
  })());
});
