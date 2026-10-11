/**
 * 쓰자고 AI 사진 인식 '찍자고' 프록시 + 쓰자팁 지갑 (Cloudflare Worker)
 *
 * 흐름: 앱(브라우저) → 이 Worker → Gemini API
 *  - API 키는 Cloudflare Secret(GEMINI_API_KEY)에만 있습니다. 이 파일에는 비밀값이 없습니다.
 *  - 사진·인식 원문은 저장하거나 로그에 남기지 않습니다.
 *  - KV에는 기기 ID별 쓰자팁 잔액·최근 내역, 출석 여부, 사용량/추정 비용 숫자만 저장합니다.
 *
 * 쓰자팁(앱 안 AI 인식 전용 포인트, 현금 교환 불가)
 *  - 처음 사용: 50 쓰자팁(같은 인터넷 주소에서 하루 NEW_PER_IP_DAY대까지만 지급)
 *  - 출석(앱 접속): 하루 1회 1 쓰자팁, 일요일에 월~일 7일 연속이면 10 쓰자팁(한국 시간 자정 기준)
 *  - 찍자고 사진 1장: 10 쓰자팁 — 인식 성공 + 제품 1개 이상일 때만 차감(실패·0개는 차감 없음)
 *  - 유효기간: 적립일로부터 1년. 먼저 적립된 쓰자팁부터 사용, 1년 지난 쓰자팁은 다음 조회 때 소멸(내역에 기록)
 *  - (예정) 플레이 앱 보상형 광고 시청 완료: 10 쓰자팁 — 광고 서버 검증(SSV) 연결 후
 *
 * 필요한 Cloudflare 설정
 *  - Secret  GEMINI_API_KEY : Google AI Studio 키
 *  - Secret  TURNSTILE_SECRET : Cloudflare Turnstile 비밀 키(봇 차단, 새 지갑 만들 때만 확인)
 *  - KV 바인딩 USAGE         : 저장소(SJ_USAGE)
 *  - (선택) 일반 변수 — 없으면 아래 DEFAULTS 사용
 *
 * 엔드포인트
 *  - GET  /health[?check=1]        : 상태 확인(키 값은 노출 안 함)
 *  - GET  /wallet?deviceId=…        : 잔액 조회(처음이면 지갑 생성 + 환영 쓰자팁)
 *  - POST /attend {deviceId}        : 오늘 출석 적립
 *  - POST /recognize {deviceId, image, mime, categories?} : 찍자고 사진 인식
 *  - GET  /quota?deviceId=…         : (구버전 앱 호환) 지금 가능한 사진 장수
 */

const VERSION = "2.3.0";

const DEFAULTS = {
  MODEL: "gemini-3.1-flash-lite",
  WELCOME_TIPS: 50,            // 처음 사용 시 지급
  ATTEND_TIPS: 1,              // 하루 접속(출석)
  STREAK_TIPS: 10,             // 일요일: 월~일 7일 연속 접속 시(빠진 날이 있으면 ATTEND_TIPS)
  COST_TIPS: 10,               // 찍자고 사진 1장
  NEW_PER_IP_DAY: 5,           // 같은 인터넷 주소에서 하루 환영 쓰자팁 지급 최대 기기 수
  MONTHLY_KRW_CAP: 10000,      // 월 추정 비용 상한(원) — 도달 시 자동 중지
  GLOBAL_DAILY_CAP: 300,       // 전체 하루 호출 상한(무료 등급 보호·폭주 방지)
  PRICE_IN_USD_PER_M: 0.25,    // 입력 100만 토큰당 달러(연결 시점 공식 가격표로 재확인)
  PRICE_OUT_USD_PER_M: 1.5,    // 출력(생각 포함) 100만 토큰당 달러
  USD_KRW: 1450,               // 환율(보수적으로 높게)
  THINKING_LEVEL: "low",       // 빈칸이면 설정 안 함
  // 쉼표로 구분. 3단계 링크 배포 때 실제 주소만 남기도록 좁힙니다.
  ALLOWED_ORIGINS: "https://sseujago.pages.dev"
};

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;   // 디코딩 후 1.5MB (앱이 긴 변 1024px로 줄여서 보냄)
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const GEMINI_TIMEOUT_MS = 25000;
const MAX_ITEMS = 30;
const LOG_MAX = 50;

const DEFAULT_CATEGORIES = [
  "마스크/팩", "토너/토너패드", "세럼/앰플", "크림/보습", "선케어", "메이크업/베이스",
  "아이메이크업", "립메이크업", "헤어케어", "클렌징/세안", "핸드케어", "바디케어/샤워", "기타"
];

export default {
  async fetch(request, env) {
    const cfg = readConfig(env);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, cfg);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") return await health(url, env, cfg, cors);
      if (origin && !originAllowed(origin, cfg)) return fail(403, "ORIGIN_NOT_ALLOWED", "허용되지 않은 주소에서 온 요청입니다.", cors);
      if (!env.USAGE) return fail(503, "NOT_READY", "서버 준비 중입니다.", cors);
      if (url.pathname === "/wallet" && request.method === "GET") return await walletInfo(request, url, env, cfg, cors);
      if (url.pathname === "/attend" && request.method === "POST") return await attend(request, env, cfg, cors);
      if (url.pathname === "/quota" && request.method === "GET") return await quota(request, url, env, cfg, cors);
      if (url.pathname === "/recognize" && request.method === "POST") return await recognize(request, env, cfg, cors);
      return fail(404, "NOT_FOUND", "없는 주소입니다.", cors);
    } catch (e) {
      if (e instanceof NeedHuman) return fail(403, "HUMAN_CHECK", "처음 사용 확인에 실패했어요. 앱을 다시 열어 주세요.", cors);
      // 사진·응답 원문은 남기지 않고 오류 종류만 기록
      console.error("unhandled", e && e.name);
      return fail(500, "SERVER_ERROR", "잠시 후 다시 시도해 주세요.", cors);
    }
  }
};

/* ---------------- 설정 ---------------- */

function readConfig(env) {
  const num = (k) => {
    const v = Number(env[k]);
    return env[k] !== undefined && Number.isFinite(v) && v >= 0 ? v : DEFAULTS[k];
  };
  const str = (k) => (typeof env[k] === "string" ? env[k].trim() : DEFAULTS[k]);
  return {
    model: str("MODEL"),
    welcome: num("WELCOME_TIPS"),
    attendTips: num("ATTEND_TIPS"),
    streakTips: num("STREAK_TIPS"),
    cost: Math.max(1, num("COST_TIPS")),
    newPerIp: num("NEW_PER_IP_DAY"),
    monthlyKrwCap: num("MONTHLY_KRW_CAP"),
    globalDailyCap: num("GLOBAL_DAILY_CAP"),
    priceIn: num("PRICE_IN_USD_PER_M"),
    priceOut: num("PRICE_OUT_USD_PER_M"),
    usdKrw: num("USD_KRW"),
    thinkingLevel: str("THINKING_LEVEL"),
    origins: str("ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean)
  };
}

function originAllowed(origin, cfg) {
  return cfg.origins.some((o) => origin === o || origin.startsWith(o + ":"));
}

function corsHeaders(origin, cfg) {
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && originAllowed(origin, cfg)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

/* ---------------- 날짜 키(한국 시간) ---------------- */

function kstParts() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = d.toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/* ---------------- 쓰자팁 지갑 ---------------- */
// w:<기기ID> = {b: 잔액, c: 생성시각, lots: [{a: 남은 양, t: 적립 시각}]}, l:<기기ID> = 최근 내역 [{t, d, r, b}]
// 유효기간: 적립일로부터 1년(TIP_VALID_DAYS). 사용할 때는 먼저 적립된 것부터 차감(선입선출)
const TIP_VALID_MS = 365 * 86400000;

function normLots(w) {
  if (!Array.isArray(w.lots)) w.lots = w.b > 0 ? [{ a: w.b, t: w.c || Date.now() }] : [];
  w.lots = w.lots.filter((l) => l && l.a > 0);
  w.b = w.lots.reduce((s, l) => s + l.a, 0);
  return w;
}
function earn(w, amt) { normLots(w); if (amt > 0) w.lots.push({ a: amt, t: Date.now() }); w.b += amt; }
function spend(w, amt) {
  normLots(w);
  let left = amt;
  for (const l of w.lots) { if (!left) break; const u = Math.min(l.a, left); l.a -= u; left -= u; }
  w.lots = w.lots.filter((l) => l.a > 0);
  w.b = w.lots.reduce((s, l) => s + l.a, 0);
}
// 1년 지난 쓰자팁 소멸. 소멸량 반환
function expireLots(w) {
  normLots(w);
  const cut = Date.now() - TIP_VALID_MS;
  let gone = 0;
  w.lots = w.lots.filter((l) => { if (l.t < cut) { gone += l.a; return false; } return true; });
  w.b -= gone;
  return gone;
}
// 가장 먼저 소멸될 쓰자팁(같은 날짜끼리 합산)
function nextExpiry(w) {
  normLots(w);
  if (!w.lots.length) return null;
  const kst = (t) => new Date(t + TIP_VALID_MS + 9 * 3600000).toISOString().slice(0, 10);
  const first = kst(Math.min(...w.lots.map((l) => l.t)));
  const amount = w.lots.filter((l) => kst(l.t) === first).reduce((s, l) => s + l.a, 0);
  const days = Math.ceil((Math.min(...w.lots.map((l) => l.t)) + TIP_VALID_MS - Date.now()) / 86400000);
  return { date: first, amount, days };
}



async function loadWallet(env, id) {
  try { return JSON.parse(await env.USAGE.get("w:" + id)) || null; } catch { return null; }
}

async function saveWallet(env, id, w, delta, reason) {
  w.b = Math.max(0, Math.round(w.b));
  let log = [];
  try { log = JSON.parse(await env.USAGE.get("l:" + id)) || []; } catch {}
  log.unshift({ t: Date.now(), d: delta, r: reason, b: w.b });
  await Promise.all([
    env.USAGE.put("w:" + id, JSON.stringify(w)),
    env.USAGE.put("l:" + id, JSON.stringify(log.slice(0, LOG_MAX)))
  ]);
}

// 지갑이 없으면 만들고 환영 쓰자팁 지급(같은 인터넷 주소 하루 지급 수 제한)
class NeedHuman extends Error {}

// 봇 차단: 새 지갑(환영 쓰자팁)을 만들 때만 Cloudflare Turnstile 토큰 확인
// TURNSTILE_SECRET(Secret)이 없으면 확인하지 않음(설정 전 호환)
async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token || typeof token !== "string" || token.length > 4096) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  try {
    const r = await fetchWithTimeout("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form }, 8000);
    const j = await r.json();
    return !!(j && j.success);
  } catch { return false; }
}

async function ensureWallet(request, env, cfg, id, token) {
  let w = await loadWallet(env, id);
  if (w) {
    const gone = expireLots(w);
    if (gone > 0) await saveWallet(env, id, w, -gone, "유효기간 만료(적립 후 1년)");
    return { w, welcome: 0, limited: false };
  }
  if (!(await verifyTurnstile(request, env, token))) throw new NeedHuman();
  const { day } = kstParts();
  // 인터넷 주소(IP)는 그대로 저장하지 않고 날짜를 섞은 해시(앞 16자)로만 사용 — 2일 뒤 자동 삭제
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = `ipnew:${day}:${await sha16(day + "|" + ip)}`;
  const ipCount = Number(await env.USAGE.get(ipKey)) || 0;
  const limited = ipCount >= cfg.newPerIp;
  const welcome = limited ? 0 : cfg.welcome;
  w = { b: 0, c: Date.now(), lots: [] };
  earn(w, welcome);
  await env.USAGE.put(ipKey, String(ipCount + 1), { expirationTtl: 172800 });
  await saveWallet(env, id, w, welcome, limited ? "처음 사용(환영 지급 한도 초과)" : "처음 사용 환영 선물");
  return { w, welcome, limited };
}

// 이번 주(월~일, 한국 시간) 날짜 목록과 오늘 위치
function weekDays() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const dow = (now.getUTCDay() + 6) % 7;          // 월=0 … 일=6
  const days = [];
  for (let k = 0; k < 7; k++) {
    const d = new Date(now.getTime() + (k - dow) * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  return { days, todayIdx: dow };
}

// 이번 주 출석 현황: [{date, amount(적립액, 미출석 0), attended}]
async function weekStatus(env, id) {
  const { days, todayIdx } = weekDays();
  const vals = await Promise.all(days.map((d, k) => (k <= todayIdx ? env.USAGE.get(`att:${d}:${id}`) : null)));
  return {
    todayIdx,
    week: days.map((d, k) => ({ date: d, attended: !!vals[k], amount: vals[k] ? Number(vals[k]) || 1 : 0 }))
  };
}

async function walletInfo(request, url, env, cfg, cors) {
  const id = url.searchParams.get("deviceId") || "";
  if (!validDeviceId(id)) return fail(400, "BAD_DEVICE", "기기 정보가 올바르지 않습니다.", cors);
  const { w, welcome, limited } = await ensureWallet(request, env, cfg, id, url.searchParams.get("ts"));
  const ws = await weekStatus(env, id);
  let log = [];
  if (url.searchParams.get("log") === "1") {
    try { log = JSON.parse(await env.USAGE.get("l:" + id)) || []; } catch {}
  }
  return json({ ok: true, balance: w.b, cost: cfg.cost, attendTips: cfg.attendTips, streakTips: cfg.streakTips,
    attendedToday: ws.week[ws.todayIdx].attended, week: ws.week, todayIdx: ws.todayIdx,
    welcome, welcomeLimited: limited, photos: Math.floor(w.b / cfg.cost), nextExpiry: nextExpiry(w), log }, 200, cors);
}

// 출석: 매일 +ATTEND_TIPS, 일요일에 월~토를 모두 출석했으면 +STREAK_TIPS(그 외 일요일은 +ATTEND_TIPS)
async function attend(request, env, cfg, cors) {
  let body;
  try { body = await request.json(); } catch { return fail(400, "BAD_JSON", "요청 형식이 올바르지 않습니다.", cors); }
  const id = String((body && body.deviceId) || "");
  if (!validDeviceId(id)) return fail(400, "BAD_DEVICE", "기기 정보가 올바르지 않습니다.", cors);
  const { w, welcome, limited } = await ensureWallet(request, env, cfg, id, body && body.ts);
  let ws = await weekStatus(env, id);
  const base = { ok: true, cost: cfg.cost, welcome, welcomeLimited: limited, attendTips: cfg.attendTips, streakTips: cfg.streakTips, nextExpiry: nextExpiry(w) };
  if (ws.week[ws.todayIdx].attended) {
    return json({ ...base, already: true, added: 0, streak: false, balance: w.b, photos: Math.floor(w.b / cfg.cost), week: ws.week, todayIdx: ws.todayIdx }, 200, cors);
  }
  const streak = ws.todayIdx === 6 && ws.week.slice(0, 6).every((x) => x.attended);
  const add = streak ? cfg.streakTips : cfg.attendTips;
  // 출석 기록은 9일 보관(주간 현황·연속 판정용)
  await env.USAGE.put(`att:${ws.week[ws.todayIdx].date}:${id}`, String(add), { expirationTtl: 9 * 86400 });
  earn(w, add);
  await saveWallet(env, id, w, add, streak ? "7일 연속 출석 보너스" : "오늘 접속 보상");
  ws.week[ws.todayIdx] = { date: ws.week[ws.todayIdx].date, attended: true, amount: add };
  return json({ ...base, already: false, added: add, streak, balance: w.b, photos: Math.floor(w.b / cfg.cost), week: ws.week, todayIdx: ws.todayIdx }, 200, cors);
}

/* ---------------- /health ---------------- */

async function health(url, env, cfg, cors) {
  const out = {
    ok: true,
    version: VERSION,
    model: cfg.model,
    keySet: typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 10,
    botCheck: !!env.TURNSTILE_SECRET,
    kvBound: !!env.USAGE,
    tips: { welcome: cfg.welcome, attend: cfg.attendTips, streak: cfg.streakTips, cost: cfg.cost },
    monthlyKrwCap: cfg.monthlyKrwCap
  };
  if (env.USAGE) {
    const { month } = kstParts();
    out.monthKrwUsed = Math.round(Number(await env.USAGE.get("cost:" + month)) || 0);
  }
  if (url.searchParams.get("check") === "1" && out.keySet) {
    // 모델 정보 조회: 토큰을 쓰지 않으므로 비용 없음. 키 형식(AIza/AQ.) 모두 헤더 방식으로 확인
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}`,
      { headers: { "x-goog-api-key": env.GEMINI_API_KEY } },
      10000
    ).catch(() => null);
    out.gemini = !r ? "NETWORK_ERROR" : r.ok ? "OK" : `HTTP_${r.status}`;
    if (r && !r.ok) {
      const t = await r.text().catch(() => "");
      const m = t.match(/"status":\s*"([A-Z_]+)"/);
      out.geminiReason = m ? m[1] : undefined;   // 키 값은 응답에 포함되지 않음
    }
    out.ok = out.gemini === "OK" && out.kvBound;
  } else {
    out.ok = out.keySet && out.kvBound;
  }
  return json(out, out.ok ? 200 : 503, cors);
}

/* ---------------- /quota (구버전 앱 호환) ---------------- */

async function quota(request, url, env, cfg, cors) {
  const id = url.searchParams.get("deviceId") || "";
  if (!validDeviceId(id)) return fail(400, "BAD_DEVICE", "기기 정보가 올바르지 않습니다.", cors);
  const { w } = await ensureWallet(request, env, cfg, id, url.searchParams.get("ts"));
  const photos = Math.floor(w.b / cfg.cost);
  return json({ ok: true, remaining: photos, limit: photos, balance: w.b }, 200, cors);
}

/* ---------------- /recognize (찍자고) ---------------- */

async function recognize(request, env, cfg, cors) {
  if (!env.GEMINI_API_KEY) return fail(503, "NOT_READY", "서버 준비 중입니다.", cors);

  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_IMAGE_BYTES * 1.4 + 20000) return fail(413, "TOO_LARGE", "사진이 너무 큽니다.", cors);
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
    return fail(415, "BAD_TYPE", "요청 형식이 올바르지 않습니다.", cors);
  }

  let body;
  try { body = await request.json(); } catch { return fail(400, "BAD_JSON", "요청 형식이 올바르지 않습니다.", cors); }

  const deviceId = String(body.deviceId || "");
  const mime = String(body.mime || "");
  const image = String(body.image || "").replace(/^data:[^,]+,/, "");
  if (!validDeviceId(deviceId)) return fail(400, "BAD_DEVICE", "기기 정보가 올바르지 않습니다.", cors);
  if (!ALLOWED_MIME.includes(mime)) return fail(415, "BAD_IMAGE_TYPE", "JPG, PNG, WEBP 사진만 인식할 수 있습니다.", cors);
  if (!/^[A-Za-z0-9+/=]+$/.test(image)) return fail(400, "BAD_IMAGE", "사진 데이터가 올바르지 않습니다.", cors);
  const bytes = Math.floor(image.length * 3 / 4);
  if (bytes < 1000) return fail(400, "BAD_IMAGE", "사진 데이터가 올바르지 않습니다.", cors);
  if (bytes > MAX_IMAGE_BYTES) return fail(413, "TOO_LARGE", "사진이 너무 큽니다.", cors);
  if (!magicOk(image, mime)) return fail(400, "BAD_IMAGE", "사진 파일이 아닙니다.", cors);

  const categories = Array.isArray(body.categories)
    ? body.categories.filter((c) => typeof c === "string" && c.length <= 30).slice(0, 40)
    : DEFAULT_CATEGORIES;

  // 한도·잔액 확인
  const { day, month } = kstParts();
  const allKey = `all:${day}`;
  const costKey = `cost:${month}`;
  const [allUsed, costUsed] = await Promise.all([env.USAGE.get(allKey), env.USAGE.get(costKey)]).then((a) => a.map((v) => Number(v) || 0));
  if (costUsed >= cfg.monthlyKrwCap) return fail(429, "MONTHLY_CAP", "이번 달 찍자고 사용량이 모두 소진되어 잠시 중지되었습니다. 적자고(직접 입력)를 이용해 주세요.", cors);
  if (allUsed >= cfg.globalDailyCap) return fail(429, "GLOBAL_CAP", "오늘은 찍자고 요청이 많아 잠시 중지되었습니다. 적자고(직접 입력)를 이용해 주세요.", cors);

  const { w } = await ensureWallet(request, env, cfg, deviceId, body.ts);
  if (w.b < cfg.cost) {
    return fail(402, "NO_TIPS", `쓰자팁이 부족해요. 찍자고 사진 1장에 ${cfg.cost} 쓰자팁이 필요해요.`, cors, { balance: w.b, cost: cfg.cost, photos: 0, remaining: 0 });
  }

  // Gemini 호출(일시 오류 시 1회 재시도)
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await callGemini(env.GEMINI_API_KEY, cfg, image, mime, categories);
    if (result.ok || !result.retryable) break;
    await sleep(800);
  }
  if (!result.ok) {
    console.error("gemini_fail", result.code);
    const msg = result.code === "BUSY"
      ? "찍자고가 지금 붐빕니다. 잠시 후 다시 시도해 주세요. 쓰자팁은 차감되지 않았어요."
      : "찍자고 인식에 실패했습니다. 쓰자팁은 차감되지 않았어요.";
    return fail(502, result.code, msg, cors, { balance: w.b, cost: cfg.cost, photos: Math.floor(w.b / cfg.cost) });
  }

  // 비용 기록(호출이 성공했으면 실제 비용이 발생하므로 기록). 날짜 키 2일, 월 키 40일 뒤 자동 삭제
  const krw = estimateKrw(result.usage, cfg);
  const writes = [
    env.USAGE.put(allKey, String(allUsed + 1), { expirationTtl: 172800 }),
    env.USAGE.put(costKey, String(costUsed + krw), { expirationTtl: 3456000 })
  ];
  // 제품을 1개 이상 찾은 경우에만 쓰자팁 차감
  const charged = result.data.items.length > 0 ? cfg.cost : 0;
  if (charged) {
    spend(w, charged);
    writes.push(saveWallet(env, deviceId, w, -charged, `찍자고 제품 인식 (사진 1장 · 제품 ${result.data.items.length}개)`));
  }
  await Promise.all(writes);

  return json({
    ok: true,
    sourceType: result.data.sourceType,
    items: result.data.items,
    charged,
    balance: w.b,
    cost: cfg.cost,
    photos: Math.floor(w.b / cfg.cost),
    remaining: Math.floor(w.b / cfg.cost),
    model: cfg.model
  }, 200, cors);
}

/* ---------------- Gemini ---------------- */

function buildPrompt(categories) {
  return [
    "당신은 생활용품 재고 앱의 사진 인식 도우미입니다.",
    "사진은 ①제품 사진(여러 개 가능) ②구매 영수증 ③온라인 주문내역 캡처 중 하나입니다.",
    "사진 속에서 사용자가 구매했거나 보유한 '제품'만 골라 JSON으로 돌려주세요.",
    "",
    "규칙:",
    "- 가격, 할인, 배송비, 합계, 주소, 이름, 전화번호, 주문번호, 결제수단, 광고, 추천상품, 매장 정보는 절대 포함하지 마세요.",
    "- 보이지 않거나 확실하지 않은 값은 추측하지 말고 null로 두세요.",
    "- name: 제품명(브랜드명 제외, 사진에 보이는 그대로, 한국어 표기 우선).",
    "- brand: 브랜드명. 모르면 null.",
    "- size: 용량·규격(예: 500ml, 30g, 10매). 모르면 null.",
    `- category: 다음 중 하나 또는 null → ${categories.join(", ")}`,
    "- quantity: 구매/보유 개수(정수). 영수증·주문내역의 수량을 따르고, 사진이면 보이는 개수. 모르면 1.",
    "- confidence: 이 항목 인식에 대한 확신(0~1).",
    "- evidence: 근거가 된 사진 속 짧은 원문(40자 이내). 개인정보·가격은 넣지 마세요.",
    "- 같은 제품이 여러 줄이면 수량을 합쳐 한 항목으로.",
    "- 제품이 없으면 items를 빈 배열로.",
    "- sourceType: product_photo | receipt | order_screenshot | other"
  ].join("\n");
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    sourceType: { type: "STRING", enum: ["product_photo", "receipt", "order_screenshot", "other"] },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", nullable: true },
          brand: { type: "STRING", nullable: true },
          size: { type: "STRING", nullable: true },
          category: { type: "STRING", nullable: true },
          quantity: { type: "INTEGER" },
          confidence: { type: "NUMBER" },
          evidence: { type: "STRING", nullable: true }
        },
        required: ["name", "quantity", "confidence"]
      }
    }
  },
  required: ["sourceType", "items"]
};

async function callGemini(key, cfg, image, mime, categories) {
  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 4096,
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA
  };
  if (cfg.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: cfg.thinkingLevel };

  const payload = {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: image } }, { text: buildPrompt(categories) }] }],
    generationConfig
  };

  let r;
  try {
    r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
      { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(payload) },
      GEMINI_TIMEOUT_MS
    );
  } catch (e) {
    return { ok: false, code: e && e.name === "AbortError" ? "TIMEOUT" : "NETWORK", retryable: true };
  }
  if (r.status === 429) return { ok: false, code: "BUSY", retryable: false };
  if (r.status >= 500) return { ok: false, code: "UPSTREAM_" + r.status, retryable: true };
  if (r.status === 401 || r.status === 403) return { ok: false, code: "AUTH", retryable: false };
  if (!r.ok) return { ok: false, code: "UPSTREAM_" + r.status, retryable: false };

  let j;
  try { j = await r.json(); } catch { return { ok: false, code: "BAD_UPSTREAM", retryable: true }; }
  const usage = j.usageMetadata || {};
  const text = (((j.candidates || [])[0] || {}).content || {}).parts?.filter((p) => !p.thought).map((p) => p.text || "").join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, code: "BAD_OUTPUT", retryable: true, usage }; }
  return { ok: true, data: sanitize(parsed, categories), usage };
}

/* ---------------- 출력 검증 ---------------- */

function cleanStr(v, max) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function sanitize(p, categories) {
  const types = ["product_photo", "receipt", "order_screenshot", "other"];
  const sourceType = types.includes(p && p.sourceType) ? p.sourceType : "other";
  const items = (Array.isArray(p && p.items) ? p.items : [])
    .map((it) => {
      const name = cleanStr(it && it.name, 80);
      if (!name) return null;
      const cat = cleanStr(it.category, 30);
      let q = Math.round(Number(it.quantity));
      if (!Number.isFinite(q) || q < 1) q = 1;
      if (q > 99) q = 99;
      let c = Number(it.confidence);
      if (!Number.isFinite(c)) c = 0.5;
      c = Math.min(1, Math.max(0, c));
      return {
        name,
        brand: cleanStr(it.brand, 40),
        size: cleanStr(it.size, 30),
        category: cat && categories.includes(cat) ? cat : null,
        quantity: q,
        confidence: Math.round(c * 100) / 100,
        evidence: cleanStr(it.evidence, 40)
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
  return { sourceType, items };
}

/* ---------------- 비용 추정 ---------------- */

function estimateKrw(u, cfg) {
  const inTok = Number(u && u.promptTokenCount) || 1500;
  const outTok = (Number(u && u.candidatesTokenCount) || 800) + (Number(u && u.thoughtsTokenCount) || 0);
  const usd = (inTok * cfg.priceIn + outTok * cfg.priceOut) / 1e6;
  return Math.round(usd * cfg.usdKrw * 100) / 100;   // 원 단위(소수 둘째 자리)
}

/* ---------------- 공통 ---------------- */

async function sha16(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validDeviceId(id) {
  return /^[A-Za-z0-9-]{16,64}$/.test(id);
}

function magicOk(b64, mime) {
  const head = b64.slice(0, 16);
  if (mime === "image/jpeg") return head.startsWith("/9j/");
  if (mime === "image/png") return head.startsWith("iVBORw0KGgo");
  if (mime === "image/webp") return head.startsWith("UklGR");
  return false;
}

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors }
  });
}

function fail(status, code, message, cors, extra) {
  return json({ ok: false, code, message, ...(extra || {}) }, status, cors);
}
