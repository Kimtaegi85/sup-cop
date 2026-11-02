// sup-cop split routing (US only -> proxy, rest direct)
// 후보는 2026-11-02 실측: us.supreme.com/meta.json 이 country:US 로 200 이면 살아있는 것.
// shared 프록시 IP 는 /pages/shop 에서 local_rate_limited(retry-after 60) 를 자주 맞으니
// 두 개 이상 살아있는 후보를 확보해 두고, 죽으면 즉시 교체한다.
function FindProxyForURL(url, host) {
  if (host === "us.supreme.com" || dnsDomainIs(host, ".us.supreme.com")) {
    return "PROXY 130.127.204.197:8080; DIRECT";
  }
  if (host === "us-production.myshopify.com") {
    return "PROXY 130.127.204.197:8080; DIRECT";
  }
  return "DIRECT";
}
