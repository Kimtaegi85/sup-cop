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
const parsePh = build(ph, /const SIZE_RE = [^\n]*\nfunction targetsParsed\(\)\{[\s\S]*?\n\}/, "targetsParsed");
const outPh = (line) => {
  // 패널 함수는 textarea DOM 을 읽으므로 최소 스텁을 준다
  return parsePh.call({});
};

// 패널 버전은 document.getElementById("targets").value 를 읽는다
const withDoc = (fn, line) => {
  globalThis.document = { getElementById: () => ({ value: line }) };
  return fn();
};

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
  const p = withDoc(parsePh, line)[0];
  assert.deepEqual(p && { kw: p.kw, sizes: p.sizes }, { kw, sizes }, "panel: " + line);
}
assert.equal(parseUs(""), null);
assert.equal(parseUs(",,"), null);
assert.equal(parseUs("nike|air force,10.5").anySize, false);
assert.equal(parseUs("nike air force").anySize, true);
assert.equal(parseUs("tee,xl").sizes[0], "xl");

// 직렬화 왕복 (renderPanel 이 쓰는 형식)
for (const [line] of cases) {
  const t = parseUs(line);
  const again = parseUs(`${t.kw.join(",")},${t.sizes.join("|")}`);
  assert.deepEqual({ kw: again.kw, sizes: again.sizes }, { kw: t.kw, sizes: t.sizes }, "round-trip: " + line);
}
console.log(`selftest ok (${cases.length} lines x 2 copies, + round-trip)`);
