// 타깃 줄 파서 자체검증: 유저스크립트와 패널이 같은 규칙으로 자르는지 확인한다.
// 실행: node scripts/selftest.mjs
import fs from "node:fs";
import assert from "node:assert/strict";

const us = fs.readFileSync("dist/supreme-cop.latest.user.js", "utf8");
const ph = fs.readFileSync("panel.src.html", "utf8");
const build = (src, re, name) => {
  const m = src.match(re);
  assert.ok(m, "함수 추출 실패: " + name);
  return new Function(m[0] + `\nreturn ${name};`)();
};
const parseUs = build(us, /\/\* target-parse \*\/[\s\S]*?\n  }\n/, "parseTargetLine");
const parsePh = build(ph, /const SIZE_RE[\s\S]*?function parseTgt\(line\)\{[\s\S]*?\n\}/, "parseTgt");




const cases = [
  ["nike|air force,10.5", ["nike", "air force"], ["10.5"]],
  ["nike,air force,10.5", ["nike", "air force"], ["10.5"]],   // 구형 형식
  ["nike air force", ["nike air force"], []],
  ["nike,air force", ["nike", "air force"], []],             // 구형, 사이즈 없음
  ["hoodie, L|XL", ["hoodie"], ["L", "XL"]],
  ["hoodie,X-Large|M", ["hoodie"], ["X-Large", "M"]],
  ["nike,airforce,10.5", ["nike", "airforce"], ["10.5"]],     // 구형, 한 단어 키워드
  ["box,One Size", ["box"], ["One Size"]],
  ["hoodie,s|m|l", ["hoodie"], ["s", "m", "l"]],
];

for (const [line, kw, sizes] of cases) {
  const a = parseUs(line);
  assert.deepEqual(a && { kw: a.kw, sizes: a.sizes }, { kw, sizes }, "us: " + line);
  const p = parsePh(line);
  assert.deepEqual(p && { kw: p.kw, sizes: p.sizes }, { kw, sizes }, "panel: " + line);
}
assert.equal(parseUs(""), null);
assert.equal(parseUs(",,"), null);
assert.equal(parseUs("nike|air force,10.5").anySize, false);
assert.equal(parseUs("nike air force").anySize, true);
assert.equal(parseUs("tee,xl").sizes[0], "xl");

// 핸들(색) 그룹: 세미콜론 3그룹 형식
const h1 = parseUs("nike|air force;ucf-bzl-ulzmtfi;10.5");
assert.deepEqual({ kw: h1.kw, h: h1.handles, s: h1.sizes }, { kw: ["nike", "air force"], h: ["ucf-bzl-ulzmtfi"], s: ["10.5"] });
const h2 = parseUs("box;h1|h2");
assert.deepEqual({ h: h2.handles, s: h2.sizes, any: h2.anySize }, { h: ["h1", "h2"], s: [], any: true });
assert.equal(h2.kw[0], "box");
assert.equal(parseUs(";;10.5"), null); // 그룹만 있고 키워드/핸들 없음

// 직렬화 왕복 (renderPanel 이 쓰는 형식)
for (const [line] of cases) {
  const t = parseUs(line);
  const again = parseUs(`${t.kw.join(",")},${t.sizes.join("|")}`);
  assert.deepEqual({ kw: again.kw, sizes: again.sizes }, { kw: t.kw, sizes: t.sizes }, "round-trip: " + line);
}
console.log(`selftest ok (${cases.length} lines x 2 copies, + round-trip)`);
