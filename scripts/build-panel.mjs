// panel.src.html + dist 유저스크립트 -> index.html (AES-256-GCM, 매번 새 salt/IV)
// 실행: COP_PW='...' node scripts/build-panel.mjs   (COP_PW 없으면 기본 비밀번호)
import fs from "node:fs";
import { webcrypto as C } from "node:crypto";

const PW = process.env.COP_PW || "Rlaxorl980805@";
const html = fs.readFileSync("panel.src.html", "utf8");
const code = fs.readFileSync("dist/supreme-cop.latest.user.js", "utf8");
let out = fs.readFileSync("index.html", "utf8");

const b64 = (u8) => Buffer.from(u8).toString("base64");
const salt = C.getRandomValues(new Uint8Array(16));
const iv = C.getRandomValues(new Uint8Array(12));
const base = await C.subtle.importKey("raw", new TextEncoder().encode(PW), "PBKDF2", false, ["deriveKey"]);
const key = await C.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base,
  { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const ct = new Uint8Array(await C.subtle.encrypt({ name: "AES-GCM", iv }, key,
  new TextEncoder().encode(JSON.stringify({ html, code }))));

const put = (name, value) => {
  const re = new RegExp(`const ${name}=Uint8Array.from\\(atob\\("[^"]*"\\)`);
  if (!re.test(out)) throw new Error("템플릿에 " + name + " 없음");
  out = out.replace(re, `const ${name}=Uint8Array.from(atob("${value}")`);
};
put("SALT", b64(salt));
put("IV", b64(iv));
put("DATA", b64(ct));
fs.writeFileSync("index.html", out);
console.log(`index.html ${out.length}B (data ${ct.length}B)`);
