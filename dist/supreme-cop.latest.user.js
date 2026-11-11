// ==UserScript==
// @name         Supreme Drop Cop (KR/US)
// @namespace    aside.supreme.cop
// @version      4.5.1
// @description  슈프림 드랍 감지 -> 사이즈 선택 -> 카트 담기 -> 체크아웃 자동입력 (KR Global-e / US Shopify)
// @match        https://shop.supreme.com/*
// @match        https://us.supreme.com/*
// @match        https://us-production.myshopify.com/*
// @match        https://checkout.pci.shopifyinc.com/*
// @match        https://checkout.shopify.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  ============================================================
  동작 원리 (2026-11 실측 기준, shop.supreme.com)
  ------------------------------------------------------------
  1. 드랍 감지 : /pages/shop 응답을 스트리밍으로 읽어 초반부의
     "products":[ ... ] 배열에서 상품 핸들만 뽑아 기존 목록과 diff.
     (전체 1MB를 다 받지 않고 앞부분만 읽고 연결을 끊는다)
  2. 상품 확인 : 새 핸들의 상품 페이지 HTML에서 variants 배열
     (id / title / available)을 파싱. DOM 렌더링을 기다리지 않는다.
  3. 담기      : POST /cart/add.js (같은 오리진 + 쿠키 = 실제 세션 카트)
  4. 이동      : /checkout  (Global-e 체크아웃으로 리다이렉트됨)
  5. 입력      : 배송지/연락처/생년월일/PIN앞2자리/통관부호/동의,
                 카드는 checkout.pci.shopifyinc.com 프레임에 postMessage로 주입
  6. 결제      : autoSubmit 이면 "process payment" 클릭
                 (KR 카드는 이후 3DS/KCP 승인이 필요할 수 있음)

  큐(대기열) : 별도 우회 알고리즘이 있는 게 아니라,
  - 페이지 렌더링을 건너뛰고 JSON/HTML fetch 만으로 진행하고
  - 큐 응답(429/503/"you have been added to the queue")을 감지하면
    백오프로 재시도하며 세션을 유지하는 방식으로 통과 시간을 줄인다.
  - /cart/add.js 가 큐에 막히면 UCP MCP 카트 생성으로 우회한다.
  ============================================================
*/

(function () {
  "use strict";

  const HOST = location.hostname;
  const IS_FRAME = HOST === "checkout.pci.shopifyinc.com";
  // 마켓 판정: us.supreme.com 계열은 US 스토어(별도 Shopify, Global-e 없음)
  const MARKET = (HOST === "us.supreme.com" || HOST.endsWith(".us.supreme.com") ||
                  HOST === "us-production.myshopify.com") ? "US" : "KR";
  const MCP_HOST = MARKET === "US"
    ? "https://us-production.myshopify.com/api/ucp/mcp"
    : "https://hk-production-website.myshopify.com/api/ucp/mcp";

  /* ---------------- 설정 ---------------- */

  const DEFAULT_CFG = {
    targets: [
      // kw: 상품명에 모두 포함되어야 하는 단어(소문자), exclude: 제외 단어
      // sizes: 우선순위대로. anySize:true 면 사이즈 무시하고 첫 재고
      { kw: ["nike", "air force"], exclude: [], sizes: ["10.5", "10", "11", "9.5"], qty: 1, anySize: false },
    ],
    profile: {
      email: "",
      firstName: "",
      lastName: "",
      postalCode: "",
      zone: "KR-11", // KR-11 서울, KR-41 경기 ... (체크아웃 select value)
      city: "",
      address1: "",
      address2: "",
      phone: "",
    },
    payment: {
      number: "",
      exp: "",          // MM/YY
      cvv: "",
      nameOnCard: "",
      dob: "",          // YYYY-MM-DD
      pin2: "",         // 카드 비밀번호 앞 2자리
      customsCode: "",  // 통관고유부호 P + 12자리
    },
    autoSubmit: false,
    clearCartOnArm: true,
    pollMs: 200,
    pollFastMs: 120,
    autoArm: false,
    leadMs: 90000,
    atcDelayMs: 2500,
    checkoutDelayMs: 2500,
    preload: true,        // 담기 전에 상품 페이지를 숨은 iframe 으로 먼저 열어 픽셀/쿠키를 태운다 (Safe Preload 흉내)
    preloadMs: 700,
    standby: false,       // ARM 없이 트리거만 대기
    remote: false,        // 휴대폰 트리거 감시
    remoteUrl: "https://kimtaegi85.github.io/sup-cop/state.json",
    ghToken: "",
    statePath: "https://api.github.com/repos/Kimtaegi85/sup-cop/contents/state.json",
    rampAtMs: 0,          // 이 시각 이후에는 빠른 지연으로 전환
    atcDelayFastMs: 0,
    checkoutDelayFastMs: 0,
    jitter: 0.25,
    mcpFallback: true,
  };

  const LS = "supremeCopCfg.v2." + MARKET;
  let CFG = loadCfg();

  function loadCfg() {
    try {
      return Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(LS) || "{}"));
    } catch (e) {
      return Object.assign({}, DEFAULT_CFG);
    }
  }
  function saveCfg() {
    try { localStorage.setItem(LS, JSON.stringify(CFG)); } catch (e) {}
  }

  const STATE = {
    armed: false,
    busy: false,
    baseline: new Set(),
    seen: new Set(),
    queue: 0,
    queueUntil: 0,
    calibrated: false,
    pollTimer: null,
    logLines: [],
  };

  /* ---------------- 유틸 ---------------- */

  function log(msg, cls) {
    const line = `[${new Date().toLocaleTimeString("ko-KR")}] ${msg}`;
    STATE.logLines.push(line);
    if (STATE.logLines.length > 200) STATE.logLines.shift();
    console.log("[cop]", msg);
    const box = document.getElementById("cop-log");
    if (box) {
      const d = document.createElement("div");
      d.textContent = line;
      if (cls) d.className = cls;
      box.appendChild(d);
      box.scrollTop = box.scrollHeight;
    }
  }

  function beep(times) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < (times || 1); i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = 880 + i * 220;
        g.gain.value = 0.08;
        o.start(ctx.currentTime + i * 0.18);
        o.stop(ctx.currentTime + i * 0.12 + i * 0.18);
      }
    } catch (e) {}
  }

  function flashTitle(text) {
    document.title = text + " — " + document.title;
  }

  function looksQueued(status, text) {
    if (status === 429 || status === 503 || status === 403) return true;
    if (!text) return false;
    const t = text.slice(0, 6000).toLowerCase();
    return /added to the ?queue|in the queue|high traffic|waiting room|you are in line|please wait/.test(t);
  }

  /* ---------------- 1. 드랍 감지 ---------------- */

  function parseRetryAfter(res) {
    const v = res.headers.get("retry-after");
    if (!v) return 0;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const d = Date.parse(v);
    return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
  }

  // /pages/shop 앞부분만 스트리밍으로 읽고 products 배열의 핸들만 수집
  async function readHandles(want) {
    const ctrl = new AbortController();
    let res;
    try {
      res = await fetch("/pages/shop", { cache: "no-store", signal: ctrl.signal });
    } catch (e) {
      return { handles: [], queued: false, error: String(e) };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { handles: [], queued: looksQueued(res.status, t), status: res.status, retryAfter: parseRetryAfter(res) };
    }
    if (!res.body) {
      const t = await res.text();
      return { handles: extractHandles(t), queued: looksQueued(res.status, t) };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let bytes = 0;
    let queued = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        buf += dec.decode(value, { stream: true });
        if (bytes < 4000 && /queue|high traffic|waiting room/i.test(buf)) {
          queued = true;
        }
        const idx = buf.indexOf('"products":[');
        if (idx > -1) {
          const hs = extractHandles(buf.slice(idx));
          if (hs.length >= (want || 6)) {
            ctrl.abort();
            return { handles: hs, queued: false };
          }
        }
        if (bytes > 400000) { ctrl.abort(); break; }
      }
    } catch (e) {
      /* abort 정상 */
    }
    return { handles: extractHandles(buf), queued: queued };
  }

  function extractHandles(text) {
    const out = [];
    const re = /"handle":"([a-z0-9_-]+)"/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  }

  async function pollOnce() {
    if (!STATE.armed || STATE.busy) return;
    if (Date.now() < STATE.queueUntil) return;

    const r = await readHandles(8);
    if (r.queued) {
      STATE.queue += 1;
      const back = Math.min(4000, 400 * Math.pow(1.7, STATE.queue));
      const ra = Math.min(15000, r.retryAfter || 0);
      if (ra > back) log(`retry-after ${Math.round(ra / 1000)}s 준수`, "q");
      STATE.queueUntil = Date.now() + Math.max(back, ra);
      log(`큐 감지 (${r.status || "html"}) → ${Math.round(back)}ms 대기`, "q");
      return;
    }
    STATE.queue = 0;

    if (!STATE.calibrated) {
      r.handles.forEach((h) => STATE.seen.add(h));
      if (r.handles.length) { STATE.calibrated = true; log(`기준선 보정 ${r.handles.length}개`); }
      return;
    }

    const fresh = r.handles.filter((h) => !STATE.seen.has(h));
    if (fresh.length) {
      log(`신규 상품 ${fresh.length}개 감지`, "ok");
      beep(2);
      STATE.busy = true;
      try {
        await handleNew(fresh);
      } finally {
        STATE.busy = false;
      }
    }
    for (const h of r.handles) STATE.seen.add(h);
  }

  function startPolling() {
    stopPolling();
    const tick = async () => {
      if (!STATE.armed) return;
      const fast = CFG.rampAtMs && Date.now() >= CFG.rampAtMs;
      await pollOnce().catch((e) => log("폴링 오류: " + e.message, "err"));
      if (STATE.armed) STATE.pollTimer = setTimeout(tick, fast ? (CFG.pollFastMs || 120) : (CFG.pollMs || 200));
    };
    STATE.pollTimer = setTimeout(tick, 80);
  }
  function stopPolling() {
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    STATE.pollTimer = null;
  }

  /* ---------------- 2~4. 매칭 / 담기 / 이동 ---------------- */

  function matchTarget(title) {
    const t = (title || "").toLowerCase();
    for (const tg of CFG.targets) {
      if (!tg.kw || !tg.kw.length) continue;
      if (!tg.kw.every((k) => t.includes(k.toLowerCase()))) continue;
      if (tg.exclude && tg.exclude.some((k) => t.includes(k.toLowerCase()))) continue;
      return tg;
    }
    return null;
  }

  /* target-parse */
  // 줄 형식: "키워드1|키워드2,사이즈1|사이즈2". 사이즈는 뒤에서부터 "사이즈처럼 생긴" 필드만 떼어낸다.
  // 그래서 구형 "키워드1,키워드2,사이즈" 나 사이즈 생략 줄도 같은 결과가 된다.
  const SIZE_RE = /^(?:\d{1,2}(?:\.\d)?|x{0,3}[sml]|os|one ?size|small|medium|large|x-?small|x-?large)$/i;
  function parseTargetLine(line) {
    const vals = String(line).split(",").map((s) => s.trim()).filter(Boolean);
    const sizes = [];
    while (vals.length > 1) {
      const parts = vals[vals.length - 1].split("|").map((s) => s.trim()).filter(Boolean);
      if (!parts.length || !parts.every((s) => SIZE_RE.test(s))) break;
      sizes.unshift(...parts);
      vals.pop();
    }
    const kw = vals.join("|").split("|").map((s) => s.trim()).filter(Boolean);
    if (!kw.length) return null;
    return { kw, exclude: [], sizes, qty: 1, anySize: !sizes.length };
  }

  function normSize(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, "").replace("xlarge", "xl")
      .replace("xxlarge", "xxl").replace("small", "s").replace("medium", "m")
      .replace("large", "l");
  }

  function parseVariants(html) {
    // 상품 페이지에는 "variants":[ 배열이 여러 개 있다.
    // (목록용 / 분석용 / 실제 재고 포함 배열) 뒤에서부터 훑어 "available" 을 가진 배열만 채택한다.
    let cursor = html.length;
    for (let n = 0; n < 8; n++) {
      const i = html.lastIndexOf('"variants":[', cursor);
      if (i < 0) break;
      const parsed = tryVariantsAt(html, i);
      if (parsed.length && parsed.some((v) => v.hasAvail)) return parsed;
      cursor = i - 1;
    }
    return [];
  }

  function tryVariantsAt(html, i) {
    const tail = html.slice(i + '"variants":['.length);
    let depth = 1, end = -1, inStr = false, esc = false;
    for (let k = 0; k < tail.length && k < 200000; k++) {
      const ch = tail[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) return [];
    return tail.slice(0, end).split('{"id":').slice(1).map((chunk) => {
      const id = (chunk.match(/^"?(\d+)/) || [])[1];
      const title = (chunk.match(/"title":"([^"]*)"/) || chunk.match(/"public_title":"([^"]*)"/) || [])[1] || "";
      const hasAvail = /"available":(true|false)/.test(chunk);
      const available = /"available":true/.test(chunk);
      return { id, title, available, hasAvail };
    }).filter((v) => v.id);
  }

  function chooseVariant(variants, tg) {
    const avail = variants.filter((v) => v.available);
    if (!avail.length) return null;
    if (tg.anySize) return avail[0];
    for (const want of tg.sizes || []) {
      const hit = avail.find((v) => normSize(v.title) === normSize(want));
      if (hit) return hit;
    }
    return null;
  }

  async function handleNew(handles) {
    const queue = handles.slice(0, 24);
    const tgHits = [];
    let i = 0;
    const worker = async () => {
      while (i < queue.length) {
        const h = queue[i++];
        try {
          const res = await fetch(`/products/${h}`, { cache: "no-store" });
          if (!res.ok) continue;
          const html = await res.text();
          if (looksQueued(res.status, html)) { log("상품페이지 큐 응답, 재시도 대기", "q"); await sleep(600); continue; }
          const title = (html.match(/<title>([^<]*?) - Shop/i) || [])[1] || "";
          const tg = matchTarget(title);
          if (!tg) continue;
          const variants = parseVariants(html);
          const pick = chooseVariant(variants, tg);
          if (!pick) { log(`${title} : 원하는 사이즈 재고 없음`, "warn"); continue; }
          log(`매칭 ${title} / ${pick.title}`, "ok");
          tgHits.push({ h, title, pick, tg });
          return;
        } catch (e) {}
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);

    if (!tgHits.length) { log("매칭 결과 없음", "warn"); return; }
    const win = tgHits[0];
    if (CFG.preload) { preloadPage(win.h); await sleep(jit(CFG.preloadMs || 700)); }
    { const d = delayFor("atc"); if (d) await sleep(jit(d)); }
    const ok = await addToCart(win.pick.id, win.tg.qty || 1, win.h);
    if (ok !== true) { if (ok) log("MCP 체크아웃으로 이동 — 폴링 종료", "q"); return; }
    if (!STATE.armed) { log("STOP됨 — 결제로 넘어가지 않음", "warn"); return; }
    goCheckout();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jit = (ms) => Math.round(ms * (1 + (Math.random() * 2 - 1) * (CFG.jitter || 0)));
  // 대기열 있는 예약 드랍: 시작은 느리게(10s), 드랍 임박하면 빠르게(2.5s)
  const delayFor = (kind) => {
    const fast = CFG.rampAtMs && Date.now() >= CFG.rampAtMs;
    if (kind === "atc") return fast ? (CFG.atcDelayFastMs || CFG.atcDelayMs) : CFG.atcDelayMs;
    return fast ? (CFG.checkoutDelayFastMs || CFG.checkoutDelayMs) : CFG.checkoutDelayMs;
  };

  // Safe Preload 흉내: 상품 페이지를 실제로 렌더링해 Forter/픽셀 쿠키를 먼저 태운다
  function preloadPage(handle) {
    try {
      const old = document.getElementById("cop-preload");
      if (old) old.remove();
      const f = document.createElement("iframe");
      f.id = "cop-preload";
      f.src = "/products/" + handle;
      f.style.cssText = "position:fixed;width:1px;height:1px;left:-9999px;top:0;border:0;opacity:0.01";
      document.body.appendChild(f);
    } catch (e) {}
  }

  async function addToCart(variantId, qty, handle) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch("/cart/add.js", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ id: Number(variantId), quantity: qty }] }),
        });
        const txt = await res.text();
        if (res.ok) { log("담기 성공", "ok"); beep(2); flashTitle("ADDED"); return true; }

        if (/sold out/i.test(txt)) { log("담기 실패: 이미 솔드아웃", "err"); return false; }
        if (looksQueued(res.status, txt)) {
          log(`담기 큐 응답 (${res.status}), 백오프`, "q");
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        log(`담기 실패 HTTP ${res.status}`, "err");
        await sleep(400);
      } catch (e) {
        log("담기 예외: " + e.message, "err");
        await sleep(400);
      }
    }
    if (CFG.mcpFallback) return await mcpAdd(variantId, qty);
    return false;
  }

  // /cart/add.js 가 막힐 때: UCP MCP로 익명 카트 생성 후 체크아웃 핸드오프
  const MCP = MCP_HOST;
  const PROFILE = "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/cart-and-checkout.json";

  async function mcpAdd(variantId, qty) {
    try {
      log("MCP 우회 시도", "q");
      const r = await fetch(MCP, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: {
            name: "create_cart",
            arguments: {
              meta: { "ucp-agent": { profile: PROFILE } },
              cart: { line_items: [{ item: { id: `gid://shopify/ProductVariant/${variantId}` }, quantity: qty }] },
            },
          },
        }),
      });
      const j = await r.json();
      const body = JSON.parse(j.result.content[0].text);
      if (body.ucp && body.ucp.status === "success" && body.id) {
        const m = body.id.match(/Cart\/([^?]+)\?key=([^&]+)/);
        if (m) {
          log("MCP 카트 생성 성공", "ok");
          beep(2);
          const krHost = HOST === "shop.supreme.com";
          location.assign(MARKET === "US" && krHost
            ? `https://us-production.myshopify.com/checkouts/cn/${m[1]}?key=${m[2]}`
            : `/checkouts/cn/${m[1]}?key=${m[2]}`);
          return "nav"; // 이미 이동했으니 goCheckout 이 덮어쓰지 않게
        }
      }
      log("MCP 실패: " + JSON.stringify(body.messages || {}).slice(0, 120), "err");
    } catch (e) {
      log("MCP 예외: " + e.message, "err");
    }
    return false;
  }

  async function goCheckout() {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch("/checkout", { redirect: "manual" });
        if (r.status === 0) break; // opaqueredirect = 정상
        const t = await r.text();
        if (!looksQueued(r.status, t)) break;
        log("체크아웃 큐 응답, 재시도", "q");
      } catch (e) {}
      await sleep(700 * (attempt + 1));
    }
    { const d = delayFor("checkout"); if (d) await sleep(jit(d)); }
    if (MARKET === "US" && HOST === "shop.supreme.com") {
      location.assign("https://us-production.myshopify.com/checkout");
      return;
    }
    location.assign("/checkout");
  }

  /* ---------------- 부팅 ---------------- */

  function configFromHash() {
    const m = location.hash.match(/cop=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    try {
      const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const cfg = JSON.parse(new TextDecoder().decode(bytes));
      if (cfg.profile) CFG.profile = Object.assign(CFG.profile, cfg.profile);
      if (cfg.payment) CFG.payment = Object.assign(CFG.payment, cfg.payment);
      if (cfg.targets) CFG.targets = cfg.targets;
      if (typeof cfg.autoSubmit === "boolean") CFG.autoSubmit = cfg.autoSubmit;
      if (typeof cfg.atcDelayMs === "number") CFG.atcDelayMs = cfg.atcDelayMs;
      if (typeof cfg.checkoutDelayMs === "number") CFG.checkoutDelayMs = cfg.checkoutDelayMs;
      if (typeof cfg.rampAtMs === "number") CFG.rampAtMs = cfg.rampAtMs;
      if (typeof cfg.preload === "boolean") CFG.preload = cfg.preload;
      if (typeof cfg.preloadMs === "number") CFG.preloadMs = cfg.preloadMs;
      if (typeof cfg.remote === "boolean") CFG.remote = cfg.remote;
      if (typeof cfg.standby === "boolean") CFG.standby = cfg.standby;
      if (cfg.remoteUrl) CFG.remoteUrl = cfg.remoteUrl;
      if (cfg.ghToken) CFG.ghToken = cfg.ghToken;
      if (typeof cfg.atcDelayFastMs === "number") CFG.atcDelayFastMs = cfg.atcDelayFastMs;
      if (typeof cfg.checkoutDelayFastMs === "number") CFG.checkoutDelayFastMs = cfg.checkoutDelayFastMs;
      if (typeof cfg.jitter === "number") CFG.jitter = cfg.jitter;
      saveCfg();
      history.replaceState(null, "", location.pathname + location.search);
      log("패널 설정 수신");
      return true;
    } catch (e) {
      log("해시 설정 파싱 실패: " + e.message, "err");
      return false;
    }
  }

  function syncArmBtn() {
    const b = document.getElementById("cop-arm");
    if (!b) return;
    b.textContent = STATE.armed ? "STOP" : "ARM";
    b.className = STATE.armed ? "warn" : "";
  }

  async function arm() {
    if (STATE.armed) return;
    STATE.armed = true;
    log("ARM — 감시 시작");
    beep(1);
    if (CFG.clearCartOnArm) {
      try { await fetch("/cart/clear.js", { method: "POST" }); } catch (e) {}
    }
    STATE.baseline = new Set();
    const r = await readHandles(9999); // 전체 목록을 기준선으로 (일부만 잡으면 기존 재고를 드랍으로 오인한다)
    r.handles.forEach((h) => STATE.baseline.add(h));
    STATE.seen = new Set(STATE.baseline);
    STATE.calibrated = r.handles.length >= 50;
    log(`기준 상품 ${STATE.baseline.size}개 기록` + (STATE.calibrated ? "" : " — 부족, 다음 정상 응답에서 보정"));
    startPolling();
    syncArmBtn();
  }

  function disarm() {
    STATE.armed = false;
    stopPolling();
    log("DISARM");
    syncArmBtn();
  }

  function autoArmLoop() {
    if (!CFG.autoArm) return;
    const next = nextDropUtc();
    const at = next - CFG.leadMs;
    const ms = at - Date.now();
    if (ms <= 0 && ms > -3600e3) { log("드랍 시각 안 — 즉시 ARM"); arm(); return; }
    if (ms > 0 && ms < 25 * 3600e3) {
      log(`자동 ARM 예약: ${new Date(at).toLocaleString("ko-KR")}`);
      setTimeout(() => { if (CFG.autoArm) arm(); }, ms);
    }
  }

  // 다음 목요일 11:00 America/New_York
  function nextDropUtc() {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    let t = Date.now();
    for (let i = 0; i < 60 * 24 * 9; i++) {
      const p = {};
      for (const part of fmt.formatToParts(new Date(t))) p[part.type] = part.value;
      if (p.weekday === "Thu" && p.hour === "11" && p.minute === "00") return t;
      t += 60e3;
    }
    return 0;
  }

  /* ---------------- 휴대폰 원격 트리거 ---------------- */

  let remoteTs = 0;

  async function readState() {
    if (CFG.ghToken) {
      const r = await fetch(CFG.statePath + "?t=" + Date.now(), {
        cache: "no-store", headers: { authorization: "Bearer " + CFG.ghToken, accept: "application/vnd.github+json" } });
      if (!r.ok) return null;
      const j = await r.json();
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((j.content || "").replace(/\n/g, "")), c => c.charCodeAt(0))));
    }
    const r = await fetch(CFG.remoteUrl + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  }

  // state.json 은 마켓별 슬롯(byMarket)을 우선 읽고, 없으면 구형 단일 슬롯을 따른다.
  function myState(st) {
    if (!st) return null;
    const bm = st.byMarket && st.byMarket[MARKET];
    if (bm && typeof bm.ts === "number") return bm;
    if (st.byMarket) return null; // 마켓별 파일인데 내 슬롯이 없음
    return st.market && st.market !== MARKET ? null : st;
  }

  function startRemoteWatch() {
    let primed = false;
    setInterval(async () => {
      try {
        const st = myState(await readState());
        if (!st || typeof st.ts !== "number" || st.ts <= remoteTs) return;
        remoteTs = st.ts;
        if (!primed) {
          primed = true;
          // 첫 읽기가 낡은 ARM 이면 기준점만 잡고 대기 유지 (상주 탭이 며칠 전 ARM 으로 켜지는 것 방지)
          if (CFG.standby && !STATE.armed && Date.now() - st.ts > 90000) {
            log("기존 ARM 은 낡음 → 대기 유지");
            return;
          }
        }
        if (st.arm && !STATE.armed) {
          if (Array.isArray(st.targets) && st.targets.length) {
            CFG.targets = st.targets.map(parseTargetLine).filter(Boolean);
            saveCfg();
            const ta = document.getElementById("cop-targets");
            if (ta) ta.value = CFG.targets.map((t) => t.kw.join(",") + "," + t.sizes.join("|")).join("\n");
            log("휴대폰 타깃 " + CFG.targets.length + "개 적용", "q");
          }
          log("휴대폰 트리거 수신 → ARM", "q");
          arm();
        }
        if (!st.arm && STATE.armed) { log("휴대폰 정지 수신 → DISARM", "q"); disarm(); }
      } catch (e) {}
    }, 6000);
  }

  /* ---------------- 패널 ---------------- */

  function renderPanel() {
    if (document.getElementById("cop-panel")) return;
    const css = document.createElement("style");
    css.textContent = `
      #cop-panel{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:268px;
        font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        background:#111;color:#eee;border:1px solid #333;border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden}
      #cop-panel .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#1b1b1b;cursor:move}
      #cop-panel .hd b{flex:1;font-size:12px;letter-spacing:.04em}
      #cop-panel .bd{padding:8px 10px;max-height:60vh;overflow:auto}
      #cop-panel label{display:block;margin:6px 0 2px;color:#9a9a9a;font-size:11px}
      #cop-panel input[type=text],#cop-panel input[type=password],#cop-panel textarea{
        width:100%;box-sizing:border-box;background:#000;color:#eee;border:1px solid #333;
        border-radius:6px;padding:4px 6px;font:11px/1.4 monospace}
      #cop-panel button{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:6px;
        padding:5px 9px;font-size:11px;cursor:pointer}
      #cop-panel button.on{background:#0a7c3f;border-color:#0a7c3f}
      #cop-panel button.warn{background:#7c2a0a;border-color:#7c2a0a}
      #cop-log{height:110px;overflow:auto;background:#000;border:1px solid #222;border-radius:6px;
        padding:5px;font:10px/1.5 monospace;color:#8fd}
      #cop-log .err{color:#f88}#cop-log .warn{color:#fc8}#cop-log .q{color:#8cf}#cop-log .ok{color:#7f7}
      .row{display:flex;gap:6px;margin-top:8px}
    `;
    document.head.appendChild(css);

    const el = document.createElement("div");
    el.id = "cop-panel";
    el.innerHTML = `
      <div class="hd"><b>SUPREME COP</b><span id="cop-market" style="font-size:10px;padding:1px 5px;border-radius:4px;background:#333">—</span><button id="cop-min">–</button></div>
      <div class="bd">
        <label>타깃 (한 줄에 하나 · "키워드1,키워드2,사이즈1|사이즈2")</label>
        <textarea id="cop-targets" rows="3"></textarea>
        <label>이메일</label><input id="cop-email" type="text">
        <label>성 / 이름</label><input id="cop-name" type="text" placeholder="Kim Taeki">
        <label>우편번호 / 주소</label><input id="cop-zip" type="text"><input id="cop-addr" type="text" style="margin-top:3px">
        <label>도시 / 주 코드(US: DE · KR: KR-11)</label><input id="cop-city" type="text"><input id="cop-zone" type="text" style="margin-top:3px">
        <label>전화</label><input id="cop-phone" type="text">
        <label>카드번호 / MM/YY / CVV</label>
        <input id="cop-card" type="text"><input id="cop-exp" type="text" style="margin-top:3px">
        <input id="cop-cvv" type="text" style="margin-top:3px">
        <label>카드명의</label><input id="cop-cname" type="text">
        <div id="cop-kr-only">
          <label>생년월일 / PIN2 / 통관부호 (KR 전용)</label>
          <input id="cop-dob" type="text" placeholder="YYYY-MM-DD">
          <input id="cop-pin" type="text" style="margin-top:3px">
          <input id="cop-pcc" type="text" style="margin-top:3px">
        </div>
        <div class="row">
          <button id="cop-arm">ARM</button>
          <button id="cop-save">저장</button>
          <button id="cop-test">리허설</button>
        </div>
        <div class="row">
          <button id="cop-auto">자동제출 OFF</button>
          <button id="cop-autoarm">예약 OFF</button>
        </div>
        <div id="cop-log"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelectorAll("input").forEach((i) => { if (!i.placeholder) i.placeholder = "미정"; });
    { const tgEl = el.querySelector("#cop-targets"); if (tgEl) tgEl.placeholder = "미정"; }

    const badge = el.querySelector("#cop-market");
    badge.textContent = MARKET;
    badge.style.background = MARKET === "US" ? "#1d4ed8" : "#0a7c3f";
    if (MARKET === "US") {
      const krOnly = el.querySelector("#cop-kr-only");
      if (krOnly) krOnly.style.display = "none";
      const z = el.querySelector("#cop-zone");
      if (z && !z.value) z.value = "";
    }
    const tg = CFG.targets.map((t) => `${t.kw.join(",")},${(t.sizes || []).join("|")}`).join("\n");
    el.querySelector("#cop-targets").value = tg;
    el.querySelector("#cop-email").value = CFG.profile.email;
    el.querySelector("#cop-name").value = [CFG.profile.lastName, CFG.profile.firstName].filter(Boolean).join(" ");
    el.querySelector("#cop-zip").value = CFG.profile.postalCode;
    el.querySelector("#cop-addr").value = CFG.profile.address1;
    el.querySelector("#cop-city").value = CFG.profile.city;
    el.querySelector("#cop-zone").value = CFG.profile.zone;
    el.querySelector("#cop-phone").value = CFG.profile.phone;
    el.querySelector("#cop-card").value = CFG.payment.number;
    el.querySelector("#cop-exp").value = CFG.payment.exp;
    el.querySelector("#cop-cvv").value = CFG.payment.cvv;
    el.querySelector("#cop-cname").value = CFG.payment.nameOnCard;
    el.querySelector("#cop-dob").value = CFG.payment.dob;
    el.querySelector("#cop-pin").value = CFG.payment.pin2;
    el.querySelector("#cop-pcc").value = CFG.payment.customsCode;

    const autoBtn = el.querySelector("#cop-auto");
    autoBtn.textContent = "자동제출 " + (CFG.autoSubmit ? "ON" : "OFF");
    autoBtn.classList.toggle("on", CFG.autoSubmit);
    const armBtn2 = el.querySelector("#cop-autoarm");
    armBtn2.textContent = "예약 " + (CFG.autoArm ? "ON" : "OFF");
    armBtn2.classList.toggle("on", CFG.autoArm);

    el.querySelector("#cop-save").onclick = () => {
      CFG.targets = el.querySelector("#cop-targets").value.split("\n").map(parseTargetLine).filter(Boolean);
      const nm = el.querySelector("#cop-name").value.trim().split(/\s+/);
      CFG.profile = {
        email: el.querySelector("#cop-email").value.trim(),
        firstName: (nm[1] || "").trim(),
        lastName: (nm[0] || "").trim(),
        postalCode: el.querySelector("#cop-zip").value.trim(),
        address1: el.querySelector("#cop-addr").value.trim(),
        city: el.querySelector("#cop-city").value.trim(),
        zone: el.querySelector("#cop-zone").value.trim() || "KR-11",
        address2: "",
        phone: el.querySelector("#cop-phone").value.trim(),
      };
      CFG.payment = {
        number: el.querySelector("#cop-card").value.replace(/\s/g, ""),
        exp: el.querySelector("#cop-exp").value.trim(),
        cvv: el.querySelector("#cop-cvv").value.trim(),
        nameOnCard: el.querySelector("#cop-cname").value.trim(),
        dob: el.querySelector("#cop-dob").value.trim(),
        pin2: el.querySelector("#cop-pin").value.trim(),
        customsCode: el.querySelector("#cop-pcc").value.trim(),
      };
      saveCfg();
      log("설정 저장됨");
      renderPanel();
    };
    el.querySelector("#cop-arm").onclick = () => (STATE.armed ? disarm() : arm());
    syncArmBtn();
    el.querySelector("#cop-auto").onclick = () => {
      CFG.autoSubmit = !CFG.autoSubmit; saveCfg();
      autoBtn.textContent = "자동제출 " + (CFG.autoSubmit ? "ON" : "OFF");
      autoBtn.classList.toggle("on", CFG.autoSubmit);
    };
    el.querySelector("#cop-autoarm").onclick = () => {
      CFG.autoArm = !CFG.autoArm; saveCfg();
      armBtn2.textContent = "예약 " + (CFG.autoArm ? "ON" : "OFF");
      armBtn2.classList.toggle("on", CFG.autoArm);
      if (CFG.autoArm) autoArmLoop();
    };
    el.querySelector("#cop-test").onclick = () => rehearsal();
    el.querySelector("#cop-min").onclick = () => {
      const bd = el.querySelector(".bd");
      bd.style.display = bd.style.display === "none" ? "block" : "none";
    };

    STATE.logLines.forEach((line) => {
      const d = document.createElement("div");
      d.textContent = line;
      document.getElementById("cop-log").appendChild(d);
    });
  }

  // 리허설: 지금 재고 있는 아무 상품으로 감지→담기→체크아웃 전 구간 확인
  async function rehearsal() {
    log("=== 리허설 시작 ===");
    const r = await readHandles(40);
    if (!r.handles.length) { log("상품 목록 실패", "err"); return; }
    for (const h of r.handles.slice(0, 30)) {
      const res = await fetch(`/products/${h}`);
      if (!res.ok) continue;
      const html = await res.text();
      const title = (html.match(/<title>([^<]*?) - Shop/i) || [])[1] || "";
      const variants = parseVariants(html);
      const pick = variants.find((v) => v.available);
      if (!pick) { log(`건너뜀 ${title || h} (품절)`, "warn"); continue; }
      log(`리허설 대상: ${title} / ${pick.title}`);
      const ok = await addToCart(pick.id, 1, h);
      if (ok) { await sleep(300); location.assign("/checkout"); }
      return;
    }
    log("재고 있는 상품을 못 찾음", "err");
  }

  /* ---------------- 5. 체크아웃 자동 입력 ---------------- */

  const setNative = (el, v) => {
    if (!el) return;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus();
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  };

  function waitFor(sel, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
        if (Date.now() - t0 > (ms || 15000)) return resolve(null);
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  async function fillCardFrame(rounds) {
    const n = rounds || 1;
    const frames = [...document.querySelectorAll('iframe[src*="checkout.pci.shopifyinc.com"]')];
    if (!frames.length) { log("카드 iframe 없음", "warn"); return; }
    for (let r = 0; r < n; r++) {
      for (const f of frames) {
        const src = f.src || "";
        let val = null;
        if (src.includes("number-ltr")) val = CFG.payment.number;
        else if (src.includes("expiry-ltr")) val = CFG.payment.exp;
        else if (src.includes("verification_value-ltr")) val = CFG.payment.cvv;
        else if (src.includes("name-ltr")) val = CFG.payment.nameOnCard;
        if (!val) continue;
        try { f.contentWindow.postMessage({ __cop: true, value: val }, "*"); } catch (e) {}
      }
      if (r < n - 1) await sleep(600);
    }
    if (rounds) log("카드 정보 주입 x" + n);
    else log("카드 정보 주입");
  }

  async function pickShipping() {
    const box = await waitFor('[id^="shipping_methods"], #shipping_methods, [data-shipping-method]', 20000);
    if (!box) { log("배송 옵션 미표시 — 주소를 확인하세요", "warn"); return false; }
    for (let tryN = 0; tryN < 6; tryN++) {
      const row = [...box.querySelectorAll("div[class]")].find((d) => d.offsetParent && /standard|ground|business days|economy/i.test(d.textContent || ""));
      if (row) {
        row.click();
        await sleep(900);
        if (box.querySelector('[aria-checked="true"], input:checked')) break;
      } else {
        await sleep(700);
      }
    }
    await sleep(500);
    return true;
  }

  async function tickConsents() {
    for (let round = 0; round < 5; round++) {
      const boxes = document.querySelectorAll('input[type="checkbox"][id^="custom-checkbox-"], #accept-tos');
      for (const c of boxes) { if (!c.checked) { c.click(); await sleep(50); } }
      await sleep(250);
      const left = [...document.querySelectorAll('input[type="checkbox"][id^="custom-checkbox-"], #accept-tos')].filter((c) => !c.checked).length;
      if (!left) return;
    }
  }

  async function clickPaypalViaFrame() {
    let clicked = false;
    const onMsg = (ev) => { const d = ev.data; if (d && d.__cop === "paypal-clicked") clicked = true; };
    window.addEventListener("message", onMsg);
    try {
      for (let i = 0; i < 10 && !clicked; i++) {
        const frames = [...document.querySelectorAll('iframe[name*="PAYPAL"], iframe[src*="sandboxes/wallets"]')];
        for (const f of frames) { try { f.contentWindow.postMessage({ __cop: "paypal" }, "*"); } catch (e) {} }
        if (frames.length && i === 0) log("PayPal 버튼 클릭 요청", "q");
        await sleep(1000);
      }
    } finally {
      window.removeEventListener("message", onMsg);
    }
    return clicked;
  }

  async function selectPayment() {
    if (MARKET === "US") {
      let pp = null;
      for (let i = 0; i < 20 && !pp; i++) {
        pp = document.querySelector('[id="payment-tiles-PAYPAL_EXPRESS"]');
        if (!pp) await sleep(500);
      }
      if (pp && !pp.checked) { pp.click(); await sleep(500); }
      log(pp ? "결제수단: paypal" : "PayPal 타일 못 찾음", pp ? "q" : "err");
      return;
    }
    const want = "kakao";
    const more = await waitFor('[id="payment-tiles-More Payment Options"]', 8000);
    if (!more) return;
    if (!more.checked) { more.click(); await sleep(600); }
    await waitFor('input[name="alternative-payment-method"]', 6000);
    const find = () => [...document.querySelectorAll('input[name="alternative-payment-method"]')]
      .find((r) => {
        let b = r;
        for (let i = 0; i < 7 && b; i++) {
          b = b.parentElement;
          if (b && b.innerText && b.innerText.trim().toLowerCase() === want) return true;
        }
        return false;
      });
    for (let i = 0; i < 8; i++) {
      const r = find();
      if (r) { if (!r.checked) r.click(); break; }
      await sleep(400);
    }
    await sleep(600);
    log("결제수단: " + want, "q");
  }

  const SUBMIT_RE = /submit|process payment|pay now|paypal|pay with|complete order|결제|주문/i;

  async function runCheckoutFill() {
    log("체크아웃 자동입력 시작 (" + MARKET + ")");
    const payP = selectPayment();
    const p = CFG.profile;

    // 값이 리렌더로 지워지는 경우가 있어 "설정 -> 확인 -> 재설정" 으로 밀어붙인다
    const stick = async (sel, v, tries) => {
      if (!v) return;
      const el = await waitFor(sel, 3000);
      if (!el) return;
      for (let i = 0; i < (tries || 3); i++) {
        if (el.value === v) return;
        setNative(el, v);
        await sleep(60);
        if (document.contains(el) && el.value === v) return;
      }
    };

    await stick('input[name="email"]', p.email);
    await stick('input[name="lastName"]', p.lastName);
    await stick('input[name="firstName"]', p.firstName);

    if (MARKET === "US") {
      const cc = await waitFor('select[name="countryCode"]', 8000);
      if (cc && cc.value !== "US") {
        cc.value = "US";
        cc.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(600);
      }
    }

    // 주소: 우편번호->도시->주->상세주소 순으로 넣고, 배송료 계산을 기다린다
    {
      const fillAddr = async () => {
        await stick('input[name="postalCode"]', p.postalCode);
        await stick('input[name="city"]', p.city);
        const z = await waitFor('select[name="zone"]', 4000);
        if (z && p.zone) { z.value = p.zone; z.dispatchEvent(new Event("change", { bubbles: true })); await sleep(200); }
        const a1 = await waitFor('input[name="address1"]', 4000);
        if (a1 && p.address1) {
          for (let i = 0; i < 4; i++) { setNative(a1, p.address1); await sleep(350); if (a1.value === p.address1) break; }
          a1.blur();
        }
      };
      await fillAddr();
      for (let i = 0; i < 3; i++) {
        const det = document.querySelector('[id$="-details"]');
        if (det && det.children.length) break;
        await sleep(1500);
        if (i === 1) await fillAddr();
      }
    }
    await stick('input[name="address2"]', p.address2);

    await stick('input[name="postalCode"]', p.postalCode);
    const zoneEl = await waitFor('select[name="zone"]', 8000);
    if (zoneEl && p.zone) {
      zoneEl.value = p.zone;
      zoneEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await stick('input[name="city"]', p.city);
    await stick('input[name="phone"]', MARKET === "US" ? p.phone : p.phone.replace(/^0/, ""));

    // 배송 조회(서버 왕복) 동안 결제수단/카드/부가정보/동의를 병렬로 밀어넣는다
    await payP;
    if (MARKET === "US" && !document.getElementById("payment-tiles-PAYPAL_EXPRESS")) {
      const ccTile = await waitFor("#payment-tiles-creditCards", 4000);
      if (ccTile && !ccTile.checked) { ccTile.click(); await sleep(600); log("PayPal 타일 없음 — 카드로 진행", "warn"); }
    }
    if (!document.getElementById("payment-tiles-creditCards")?.checked && !document.getElementById("payment-tiles-More Payment Options")?.checked) await selectPayment();
    const hasCard = !!document.getElementById("payment-tiles-creditCards")?.checked;
    const cardP = hasCard ? fillCardFrame(4) : Promise.resolve();
    const extraP = (async () => {
      if (MARKET !== "KR") return;
      await stick('input[placeholder="Personal Customs Code"]', CFG.payment.customsCode, 3);
    })();
    const consentP = tickConsents();
    const shipP = pickShipping();
    await Promise.all([cardP, extraP, consentP, shipP]);

    if (MARKET === "KR" && hasCard) {
      await stick('#PaymentAdditionalField-Cards-PersonalCardDateOfBirth', CFG.payment.dob, 4);
      await stick('#PaymentAdditionalField-Cards-PersonalCardPinCodeFirstTwoDigits', CFG.payment.pin2, 4);
    }
    await tickConsents();

    log("입력 완료", "ok");
    beep(1);

    if (CFG.autoSubmit) await selectPayment();
    if (CFG.autoSubmit && MARKET === "US") {
      const okPaypal = await clickPaypalViaFrame();
      log(okPaypal ? "PayPal 결제창 열림" : "PayPal 버튼 못 찾음", okPaypal ? "q" : "err");
      if (okPaypal) { beep(3); return; }
    }
    if (!CFG.autoSubmit) return;
    await sleep(400);
    await fillCardFrame(2);
    let enabledBtn = null;
    for (let i = 0; i < 20; i++) {
      enabledBtn = [...document.querySelectorAll("button")]
        .filter((b) => !b.disabled && b.offsetParent && SUBMIT_RE.test(b.textContent))
        .find((b) => getComputedStyle(b).pointerEvents !== "none");
      if (enabledBtn) break;
      await sleep(500);
    }
    const cands = [...document.querySelectorAll("button")]
      .filter((b) => !b.disabled && b.offsetParent && SUBMIT_RE.test(b.textContent))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    if (enabledBtn && !cands.includes(enabledBtn)) cands.unshift(enabledBtn);
    if (!cands.length) { log("결제 버튼 못 찾음", "err"); return; }
    for (const b of cands) {
      b.click();
      log("결제 클릭: " + b.textContent.trim().slice(0, 20), "q");
      beep(3);
      await sleep(1500);
      if (!location.pathname.startsWith("/checkouts/")) return;
      const errEl = [...document.querySelectorAll('[role="alert"],[aria-live="assertive"]')].find((e) => e.offsetParent && e.textContent.trim());
      if (errEl) { log("결제 오류: " + errEl.textContent.trim().slice(0, 120), "err"); beep(3); }
    }
  }

  /* ---------------- 텔레그램 원격 (선택) ---------------- */
  const tgCfg = () => { try { return JSON.parse(localStorage.getItem("cop.tg") || "{}"); } catch (e) { return {}; } };
  let tgTimer = null;
  async function tgSend(text) {
    const t = tgCfg();
    if (!t.token || !t.chat) return;
    try {
      await fetch("https://api.telegram.org/bot" + t.token + "/sendMessage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: t.chat, text }),
      });
    } catch (e) {}
  }
  function startTg() {
    const t0 = tgCfg();
    if (!t0.token || !t0.chat || tgTimer) return;
    log("텔레그램 명령 대기 (/arm /stop /status)", "q");
    let offset = t0.offset || 0;
    tgTimer = setInterval(async () => {
      const cur = tgCfg();
      if (!cur.token || !cur.chat) return;
      try {
        const r = await fetch("https://api.telegram.org/bot" + cur.token + "/getUpdates?timeout=0&offset=" + (offset + 1), { cache: "no-store" });
        const j = await r.json();
        if (!j.ok) return;
        for (const u of j.result || []) {
          offset = Math.max(offset, u.update_id);
          const m = u.message;
          if (!m || String(m.chat.id) !== String(cur.chat)) continue;
          const c = (m.text || "").trim().toLowerCase();
          if (c === "/arm") { arm(); tgSend("ARM — 감시 시작"); }
          else if (c === "/stop") { disarm(); tgSend("STOP"); }
          else if (c === "/status") tgSend(STATE.armed ? "ARMED" : "IDLE");
        }
        cur.offset = offset;
        localStorage.setItem("cop.tg", JSON.stringify(cur));
      } catch (e) {}
    }, 3000);
  }

  /* ---------------- 실행 ---------------- */

  if (HOST === "checkout.shopify.com") {
    window.addEventListener("message", (ev) => {
      const d = ev.data;
      if (!d || d.__cop !== "paypal") return;
      const b = document.querySelector("paypal-button") || document.querySelector("#paypal-button-container button");
      if (b) { b.click(); try { parent.postMessage({ __cop: "paypal-clicked" }, "*"); } catch (e) {} }
    });
    return;
  }

  if (IS_FRAME) {
    // 카드 입력 프레임
    window.addEventListener("message", (ev) => {
      const d = ev.data;
      if (!d || !d.__cop) return;
      const map = { "number-ltr": "number", "expiry-ltr": "expiry", "verification_value-ltr": "verification_value", "name-ltr": "name" };
      const url = location.href;
      const key = Object.keys(map).find((k) => url.includes(k));
      const id = key ? map[key] : null;
      if (!id) return;

      const put = () => {
        const el = document.getElementById(id);
        if (!el) return false;
        try {
          window.postMessage(
            "cardfields:" + JSON.stringify({ action: "set_value", value: d.value, emitChange: true }),
            "*"
          );
          return true;
        } catch (e) {
          setNative(el, d.value);
          return true;
        }
      };

      // 프레임이 아직 부트 중일 수 있으니 값이 실제로 들어갈 때까지 반복 주입
      let n = 0;
      const kick = () => {
        const el = document.getElementById(id);
        if (el && el.value) return;
        put();
        if (n++ < 25) setTimeout(kick, 150);
      };
      kick();
    });
    return;
  }

  if (location.pathname.startsWith("/checkouts/")) {
    const boot2 = () => {
      renderPanel();
      CFG.clearCartOnArm = false;
      log("체크아웃 페이지 감지 — ARM 가능");
      startTg();
      runCheckoutFill();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot2);
    else boot2();
    return;
  }

  // 스토어프론트
  const boot = () => {
    if (/^\/(cart|checkouts)\//.test(location.pathname)) CFG.clearCartOnArm = false;
    renderPanel();
    const fromPanel = configFromHash();
    log("준비 완료 — 타깃/정보 입력 후 저장, ARM 으로 감시 시작");
    if (location.pathname.startsWith("/cart/")) log("체크아웃 팝업 — 카트 유지", "q");
    autoArmLoop();
    // 페이지 자체가 큐 화면이면 감지
    if (looksQueued(200, document.body ? document.body.innerText.slice(0, 3000) : "")) {
      log("현재 큐 화면 — 통과 후 자동 진행", "q");
    }
    if (fromPanel && CFG.standby) log("상주 대기 모드 — 트리거를 기다립니다");
    else if (fromPanel) { log("패널에서 실행됨 → 자동 ARM"); arm(); }
    if (CFG.remote) { log("휴대폰 트리거 대기 시작"); startRemoteWatch(); }
    startTg();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
