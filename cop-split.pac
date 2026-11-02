// sup-cop split routing (US only -> proxy, rest direct)
function FindProxyForURL(url, host) {
  if (host === "us.supreme.com" || dnsDomainIs(host, ".us.supreme.com")) {
    return "PROXY 130.127.204.197:8080; PROXY 34.43.46.91:443; PROXY 34.43.46.91:80; DIRECT";
  }
  if (host === "us-production.myshopify.com") {
    return "PROXY 130.127.204.197:8080; DIRECT";
  }
  return "DIRECT";
}
