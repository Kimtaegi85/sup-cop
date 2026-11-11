// matchTarget 자체검증: 핸들 타깃이 제목과 무관하게 그 상품만 잡는지, 순서 우선이 지켜지는지.
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync("dist/supreme-cop.latest.user.js", "utf8");
const body = src.match(/\/\* target-parse \*\/[\s\S]*?\n  \}\n/)[0] +
  src.match(/  function matchTarget\(title, handle\) \{[\s\S]*?\n  \}\n/)[0];
const mk = (CFG) => new Function("CFG", body + "\nreturn { parseTargetLine, matchTarget };")(CFG);

const CFG = { targets: [
  { kw: ["box", "logo"], handles: ["h-black"], sizes: ["L"], exclude: [], anySize: false },
  { kw: ["beanie"], handles: [], sizes: [], exclude: [], anySize: true },
]};
const { matchTarget } = mk(CFG);

// 핸들 타깃: 제목이 같아도 다른 색(handle)은 안 잡힌다
assert.equal(matchTarget("Supreme Box Logo Hoodie", "h-black"), CFG.targets[0]);
assert.equal(matchTarget("Supreme Box Logo Hoodie", "h-white"), null);
// 키워드 타깃은 제목으로
assert.equal(matchTarget("Supreme Beanie", "zzz"), CFG.targets[1]);
assert.equal(matchTarget("Supreme Tee", "zzz"), null);
// 우선순위: 앞 타깃이 먼저
CFG.targets.unshift({ kw: ["beanie"], handles: [], sizes: [], exclude: [], anySize: true });
assert.equal(matchTarget("Supreme Beanie", "zzz"), CFG.targets[0]);
console.log("matchTarget ok");
