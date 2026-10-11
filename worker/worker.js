/**
 * 쓰자고 AI 사진 인식 프록시 (Cloudflare Worker)
 *
 * 흐름: 앱(브라우저) → 이 Worker → Gemini API
 *  - API 키는 Cloudflare Secret(GEMINI_API_KEY)에만 있습니다. 이 파일에는 비밀값이 없습니다.
 *  - 사진·인식 원문은 저장하거나 로그에 남기지 않습니다. KV에는 사용 횟수/추정 비용 숫자만 저장합니다.
 *
 * 필요한 Cloudflare 설정
 *  - Secret  GEMINI_API_KEY : Google AI Studio 키
 *  - KV 바인딩 USAGE         : 횟수 기록 저장소(SJ_USAGE)
 *  - (선택) 일반 변수 — 없으면 아래 DEFAULTS 사용
 *      MODEL, DAILY_LIMIT, MONTHLY_KRW_CAP, GLOBAL_DAILY_CAP, ALLOWED_ORIGINS,
 *      PRICE_IN_USD_PER_M, PRICE_OUT_USD_PER_M, USD_KRW, THINKING_LEVEL
 *
 * 엔드포인트
 *  - GET  /health            : Worker 상태(키/KV 연결 여부만, 값은 노출 안 함)
 *  - GET  /health?check=1    : Gemini 키·모델이 실제로 작동하는지 확인(토큰 비용 없음)
 *  - POST /recognize         : 사진 인식 {deviceId, image(base64), mime, categories?}
 *  - GET  /quota?deviceId=…  : 오늘 남은 횟수
 */

const VERSION = "1.0.0";

const DEFAULTS = {
  MODEL: "gemini-3.1-flash-lite",
  DAILY_LIMIT: 3,              // 기기당 하루 무료 횟수
  MONTHLY_KRW_CAP: 10000,      // 월 추정 비용 상한(원) — 도달 시 자동 중지
  GLOBAL_DAILY_CAP: 300,       // 전체 하루 호출 상한(무료 등급 보호·폭주 방지)
  PRICE_IN_USD_PER_M: 0.25,    // 입력 100만 토큰당 달러(연결 시점 공식 가격표로 재확인)
  PRICE_OUT_USD_PER_M: 1.5,    // 출력(생각 포함) 100만 토큰당 달러
  USD_KRW: 1450,               // 환율(보수적으로 높게)
  THINKING_LEVEL: "low",       // 빈칸이면 설정 안 함
  // 쉼표로 구분. 3단계 링크 배포 때 실제 주소만 남기도록 좁힙니다.
  ALLOWED_ORIGINS: "http://localhost,http://127.0.0.1,https://sseujago.pages.dev"
};

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;   // 디코딩 후 1.5MB (앱이 긴 변 1024px로 줄여서 보냄)
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const GEMINI_TIMEOUT_MS = 25000;
const MAX_ITEMS = 30;

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
      if (url.pathname === "/quota" && request.method === "GET") return await quota(url, env, cfg, cors);
      if (url.pathname === "/recognize" && request.method === "POST") {
        if (origin && !originAllowed(origin, cfg)) return fail(403, "ORIGIN_NOT_ALLOWED", "허용되지 않은 주소에서 온 요청입니다.", cors);
        return await recognize(request, env, cfg, cors);
      }
      return fail(404, "NOT_FOUND", "없는 주소입니다.", cors);
    } catch (e) {
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
    return Number.isFinite(v) && v >= 0 ? v : DEFAULTS[k];
  };
  const str = (k) => (typeof env[k] === "string" ? env[k].trim() : DEFAULTS[k]);
  return {
    model: str("MODEL"),
    dailyLimit: num("DAILY_LIMIT"),
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

/* ---------------- /health ---------------- */

async function health(url, env, cfg, cors) {
  const out = {
    ok: true,
    version: VERSION,
    model: cfg.model,
    keySet: typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 10,
    kvBound: !!env.USAGE,
    dailyLimit: cfg.dailyLimit,
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

/* ---------------- /quota ---------------- */

async function quota(url, env, cfg, cors) {
  const deviceId = url.searchParams.get("deviceId") || "";
  if (!validDeviceId(deviceId)) return fail(400, "BAD_DEVICE", "기기 정보가 올바르지 않습니다.", cors);
  if (!env.USAGE) return fail(503, "NOT_READY", "서버 준비 중입니다.", cors);
  const { day } = kstParts();
  const used = Number(await env.USAGE.get(`dev:${day}:${deviceId}`)) || 0;
  return json({ ok: true, used, limit: cfg.dailyLimit, remaining: Math.max(0, cfg.dailyLimit - used) }, 200, cors);
}

/* ---------------- /recognize ---------------- */

async function recognize(request, env, cfg, cors) {
  if (!env.GEMINI_API_KEY || !env.USAGE) return fail(503, "NOT_READY", "서버 준비 중입니다.", cors);

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

  // 한도 확인
  const { day, month } = kstParts();
  const devKey = `dev:${day}:${deviceId}`;
  const allKey = `all:${day}`;
  const costKey = `cost:${month}`;
  const [devUsed, allUsed, costUsed] = await Promise.all([
    env.USAGE.get(devKey), env.USAGE.get(allKey), env.USAGE.get(costKey)
  ]).then((a) => a.map((v) => Number(v) || 0));

  if (costUsed >= cfg.monthlyKrwCap) return fail(429, "MONTHLY_CAP", "이번 달 AI 인식 사용량이 모두 소진되어 잠시 중지되었습니다. 직접입력을 이용해 주세요.", cors);
  if (allUsed >= cfg.globalDailyCap) return fail(429, "GLOBAL_CAP", "오늘은 AI 인식 요청이 많아 잠시 중지되었습니다. 직접입력을 이용해 주세요.", cors);
  if (devUsed >= cfg.dailyLimit) return fail(429, "DAILY_LIMIT", `오늘 AI 인식 ${cfg.dailyLimit}회를 모두 사용했습니다. 내일 다시 이용하거나 직접입력을 이용해 주세요.`, cors, { remaining: 0 });

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
      ? "AI 인식이 지금 붐빕니다. 잠시 후 다시 시도하거나 직접입력을 이용해 주세요."
      : "AI 인식에 실패했습니다. 직접입력을 이용해 주세요.";
    return fail(502, result.code, msg, cors);   // 실패는 횟수에서 차감하지 않음
  }

  // 사용량 기록(성공한 경우만). 날짜 키는 2일 뒤, 월 키는 40일 뒤 자동 삭제
  const krw = estimateKrw(result.usage, cfg);
  await Promise.all([
    env.USAGE.put(devKey, String(devUsed + 1), { expirationTtl: 172800 }),
    env.USAGE.put(allKey, String(allUsed + 1), { expirationTtl: 172800 }),
    env.USAGE.put(costKey, String(costUsed + krw), { expirationTtl: 3456000 })
  ]);

  return json({
    ok: true,
    sourceType: result.data.sourceType,
    items: result.data.items,
    remaining: Math.max(0, cfg.dailyLimit - devUsed - 1),
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
