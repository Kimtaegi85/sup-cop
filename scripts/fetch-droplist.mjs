// drops.gg 에서 다음/최근 주차 드랍리스트를 긁어 droplist.json 으로 저장한다.
// GitHub Actions(미국 러너)에서 도니 CORS/지역 문제가 없다.
import fs from "node:fs/promises";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const SEASON = "fw26";

async function get(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
  if (!r.ok) return null;
  return await r.text();
}

function parseItems(html) {
  if (!html) return [];
  const out = [];
  const re = /<a class="item-card-img-wrap" href="([^"]+)"[\s\S]{0,4000}?alt="([^"]*)"[\s\S]{0,4000}?src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const name = m[2].trim();
    if (!name) continue;
    out.push({ name, href: m[1], img: m[3] });
  }
  return out;
}

const index = await get(`https://drops.gg/droplist`);
const weeks = index
  ? [...new Set([...index.matchAll(new RegExp(`/${SEASON}/week-(\\d+)`, "g"))].map(m => +m[1]))].sort((a, b) => b - a)
  : [];
const top = weeks.length ? weeks[0] + 1 : 12;

let chosen = null;
for (const w of [top, top - 1, top - 2]) {
  if (w < 1) continue;
  const html = await get(`https://drops.gg/${SEASON}/week-${w}`);
  const items = parseItems(html);
  if (items.length) { chosen = { week: w, items }; break; }
}

const prev = JSON.parse(await fs.readFile("droplist.json", "utf8").catch(() => "null"));
const now = {
  season: SEASON,
  week: chosen ? chosen.week : (prev?.week ?? 0),
  upcoming: !!(chosen && weeks.length && chosen.week === top),
  updated: new Date().toISOString(),
  source: "drops.gg",
  items: chosen ? chosen.items : (prev?.items ?? []),
};

if (prev && JSON.stringify(prev.items) === JSON.stringify(now.items) && prev.week === now.week) {
  now.updated = prev.updated;
}
await fs.writeFile("droplist.json", JSON.stringify(now, null, 1));
console.log(`${now.week}주차 / ${now.items.length}개 / upcoming=${now.upcoming}`);
