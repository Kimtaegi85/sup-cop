// ==UserScript==
// @name         Sup-Cop panel: checkout as popup + 미정 + 새로고침 보존
// @namespace    aside.supreme.cop
// @version      2.5.0
// @description  체크아웃 버튼을 팝업으로, 빈 칸은 미정으로, 새로고침 시 저장값 유지
// @match        https://kimtaegi85.github.io/sup-cop/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  /* 1) 체크아웃 버튼 -> 팝업 */
  const origOpen = window.open;
  window.open = function (url, name, feat) {
    try {
      if (typeof url === "string" && url.indexOf("/cart/") !== -1) {
        return origOpen.call(window, url, "copcheckout", "popup,width=1020,height=960,left=140,top=40");
      }
    } catch (e) {}
    return origOpen.apply(window, arguments);
  };

  /* 2) 초기 로드 때 readForm() 이 빈 폼을 읽어 저장값을 덮어쓰는 문제 방지 */
  const LSKEY = "cop.app.v1";
  const rawGet = Storage.prototype.getItem;
  const rawSet = Storage.prototype.setItem;
  let initPhase = true;
  setTimeout(() => { initPhase = false; }, 5000);

  Storage.prototype.setItem = function (k, v) {
    if (k === LSKEY && initPhase) {
      try {
        const prev = JSON.parse(rawGet.call(this, k) || "{}");
        const next = JSON.parse(v);
        for (const sect of ["m", "p", "targets"]) {
          next[sect] = next[sect] || {};
          for (const mk of ["KR", "US"]) {
            const before = prev[sect] && prev[sect][mk];
            if (!before) continue;
            if (typeof before === "string") {
              if (!next[sect][mk]) next[sect][mk] = before;
            } else {
              next[sect][mk] = next[sect][mk] || {};
              for (const f of Object.keys(before)) {
                if (!next[sect][mk][f]) next[sect][mk][f] = before[f];
              }
            }
          }
        }
        v = JSON.stringify(next);
      } catch (e) {}
    }
    return rawSet.call(this, k, v);
  };

  /* 3) 새로고침 후 저장값을 폼에 복원 */
  const hydrate = () => {
    try {
      const j = JSON.parse(rawGet.call(localStorage, LSKEY) || "{}");
      const map = Object.assign({}, j.m && j.m.KR, j.p && j.p.KR);
      for (const k of Object.keys(map)) {
        const el = document.getElementById(k);
        if (el && !el.value && map[k]) el.value = map[k];
      }
      const tEl = document.getElementById("targets");
      const tg = j.targets && j.targets.KR;
      if (tEl && !tEl.value && tg) tEl.value = tg;
    } catch (e) {}
  };
  (() => {
    let n = 0;
    const iv = setInterval(() => {
      if (++n > 60) return clearInterval(iv);
      if (!document.getElementById("email")) return;
      clearInterval(iv);
      hydrate();
      [1200, 3000].forEach((d) => setTimeout(hydrate, d));
    }, 300);
  })();

  /* 3.5) 비밀번호 자동 입력 */
  (() => {
    let n = 0;
    const iv = setInterval(() => {
      if (++n > 40) return clearInterval(iv);
      const pw = document.getElementById("pw");
      if (!pw) return clearInterval(iv);
      const saved = localStorage.getItem("cop.pw");
      if (!saved) return clearInterval(iv);
      pw.value = saved;
      document.getElementById("go")?.click();
      clearInterval(iv);
    }, 250);
    document.addEventListener("submit", () => {
      const pw = document.getElementById("pw");
      if (pw && pw.value) localStorage.setItem("cop.pw", pw.value);
    }, true);
  })();

  /* 4) 딥링크: #add=상품~상품&size=L|XL&arm=1 */
  (() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const adds = (h.get("add") || "").split("~").filter(Boolean);
    if (!adds.length) return;
    const sz = h.get("size") || "";
    let tries = 0;
    const iv = setInterval(() => {
      if (++tries > 300) return clearInterval(iv);
      if (typeof window.addTargetFromName !== "function") return;
      const ds = document.getElementById("dropSize");
      if (ds) ds.value = sz;
      let added = 0;
      for (const q of adds) {
        const el = [...document.querySelectorAll("#items .t")].find((x) => x.textContent.includes(q));
        if (el) { window.addTargetFromName(el.textContent); added++; }
      }
      if (!added) return;
      clearInterval(iv);
      if (h.get("arm") === "1") {
        let n2 = 0;
        const go = () => {
          const lg = document.getElementById("log")?.innerText || "";
          if (lg.includes("스토어 탭 열고")) return;
          if (typeof window.armWithScript === "function") window.armWithScript();
          else document.getElementById("btnArm")?.click();
          if (++n2 < 3) setTimeout(go, 1600);
        };
        setTimeout(go, 600);
      }
    }, 400);
  })();

  /* 5) 드랍 목록 위에 ARM 버튼 */
  (() => {
    let tries = 0;
    const iv = setInterval(() => {
      if (++tries > 60) return clearInterval(iv);
      const sec = document.getElementById("secDrop");
      if (!sec || document.getElementById("cop-arm-top")) return;
      clearInterval(iv);
      const b = document.createElement("button");
      b.id = "cop-arm-top";
      b.className = "primary";
      b.textContent = "ARM — 선택한 타깃으로 시작";
      b.style.cssText = "width:100%;margin:0 0 10px;padding:10px;font-weight:700";
      b.onclick = () => document.getElementById("btnArm")?.click();
      sec.insertBefore(b, sec.querySelector("#items"));
    }, 300);
  })();

  /* 6) 휴대폰에서는 ARM 을 원격(state.json)으로 */
  (() => {
    const isPhone = matchMedia("(max-width: 820px)").matches || /iPhone|Android.+Mobile/i.test(navigator.userAgent);
    if (!isPhone) return;
    let n = 0;
    const iv = setInterval(() => {
      if (++n > 40) return clearInterval(iv);
      const b = document.getElementById("btnArm");
      if (!b) return;
      clearInterval(iv);
      b.textContent = "ARM — 이 PC에서 실행";
      b.onclick = () => window.ghWriteState && window.ghWriteState(true);
    }, 400);
  })();

  /* 8) 빈 칸은 미정 */
  const skip = new Set(["zone", "dropSize", "filter", "manualVar", "atcDelay", "chkDelay", "jitter", "rampStart"]);
  const mark = () => {
    document.querySelectorAll("input").forEach((el) => {
      if (el.type === "password" || skip.has(el.id)) return;
      if (!el.value && el.placeholder !== "미정") el.placeholder = "미정";
    });
    const tg = document.getElementById("targets");
    if (tg && !tg.value && tg.placeholder !== "미정") tg.placeholder = "미정";
  };
  let n = 0;
  const iv = setInterval(() => { mark(); if (++n > 40) clearInterval(iv); }, 250);
})();
