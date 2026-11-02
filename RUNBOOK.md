# RUNBOOK — 윈도우 상주 실행

평문 문서다. 이 PC에서 작업하는 사람/AI는 이 파일만 읽으면 된다.
(비밀번호 걸린 컨트롤 패널은 https://kimtaegi85.github.io/sup-cop/ — 비밀번호는 사용자에게 물어볼 것)

## 구조

- 패널(깃헙 페이지) = 설정·목록·원격 트리거만 담당. 페이로드는 AES-GCM 암호문
- 유저스크립트 = 실제 동작. 배포본은 `dist/supreme-cop.latest.user.js` (Tampermonkey에 URL 설치)
- 판넬 도우미 스크립트 = `dist/panel-helper.user.js` (팝업·미정 표시·새로고침 보존·휴대폰 원격 ARM)
- 이 PC = 크롬을 켜두는 실행기

## 최초 세팅 (1회)

1. Chrome 설치, Tampermonkey 설치, `chrome://extensions` → Tampermonkey "Allow User Scripts" 켜기 (Chrome 138+ 필수)
2. 유저스크립트 설치:
   `https://raw.githubusercontent.com/Kimtaegi85/sup-cop/main/dist/supreme-cop.latest.user.js`
   `@match` 4줄(shop.supreme.com / us.supreme.com / us-production.myshopify.com / checkout.pci.shopifyinc.com) + `checkout.shopify.com` 확인
3. 도우미 설치: `https://raw.githubusercontent.com/Kimtaegi85/sup-cop/main/dist/panel-helper.user.js`
4. 크롬 바로가기 대상에 플래그:
   `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
5. 전원 옵션: 절전/화면 끄기 사용 안 함. 자동 로그인 ON
6. 패널에서 배송지·카드 저장, 휴대폰 트리거 토큰 입력·저장

## 미국 스토어 (분할 라우팅)

KR과 US를 동시에 켜두려면 PAC을 쓴다. **VPN은 끈다**(PAC이 우선이라 같이 켜면 무의미).

```powershell
$k="HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
Set-ItemProperty $k AutoConfigURL "https://raw.githubusercontent.com/Kimtaegi85/sup-cop/main/cop-split.pac"
Set-ItemProperty $k ProxyEnable 0
```

- `cop-split.pac`은 `us.supreme.com`만 프록시로 보내고 나머지는 직결. 프록시 후보는 파일 안에서 관리
- 프록시가 죽으면 US 탭이 KR로 리다이렉트된다 → 후보를 갱신하고 PAC을 다시 올린다
- 후보 생존 판정(2026-11-02 실측 기준): `us.supreme.com/meta.json`이 `"country":"US"` 로 200이면 살아있음.
  `34.43.46.91:443` 은 죽어 있어 PAC에서 뺐다
- /pages/shop 은 같은 IP에 shared 프록시를 여러 명이 쓰면 `local_rate_limited` + `retry-after: 60` 을 띄운다.
  스크립트는 retry-after를 최대 15초까지 존중하지만, 60초가 걸리면 드랍 중 감지가 밀리므로
  **살아있는 후보 2개 이상 + 하나는 드랍 전용**으로 두는 게 안전하다
- 해제: `Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" AutoConfigURL`

## 드랍 절차 (매주 목요일)

- 드랍: 목요일 11:00 뉴욕 = **한국 금요일 01:00**
- 00:53~00:55 — 패널에서 감시 시작 또는 폰에서 원격 ARM
- 폴링은 200ms(드랍 15초 전부터 120ms). 3DS/앱 승인 팝업은 사용자 폰으로 처리
- KR/US 를 같이 돌릴 때: `state.json` 은 `byMarket.KR` / `byMarket.US` 로 분리되어 있어 서로 덮어쓰지 않는다.
  패널의 시장 선택이 그대로 슬롯이 되므로, US를 켜려면 패널에서 북미를 고른 뒤 ARM
- 상주 대기 탭은 로드 직후 낡은 `arm:true` 를 무시한다(90초 지난 ts). 새 트리거는 그대로 먹는다
- 드랍 전 점검: 두 탭(또는 실행할 탭)에서 패널 로그에 `휴대폰 트리거 대기 시작` 이 뜨는지,
  폰 ARM 후 6초 안에 `휴대폰 트리거 수신 → ARM` 이 뜨는지 확인. 안 뜨면 토큰/시장 슬롯부터 본다

## 드랍 목록 수집

- 패널의 **목록 직접 갱신** 버튼이 drops.gg 를 r.jina.ai 경유로 읽어 온다 (CORS 우회, 토큰 불필요)
- 결과는 브라우저 localStorage 에 캐시되고 6시간은 그대로, 24시간 넘으면 자동으로 다시 받는다
- `droplist.json` 은 GitHub Actions 백업 경로. 이 리포에서 스케줄러가 하루 넘게 안 붙는 일이 있어서
  20분 크론을 1시간으로 낮추고, 안 뜨면 Actions → droplist → Run workflow 로 수동 실행한다
- 목록은 표시·알림용이다. 감지는 스크립트가 `/pages/shop` 을 직접 폴링하므로 목록이 낡아도 드랍 자체는 돈다

## 결제수단

- **KR = 카카오페이**: `#payment-tiles-More Payment Options` → kakao 타일 자동 선택. 카드 정보는 채우지 않음
- **US = PayPal**: PayPal은 메인 CTA가 잠기고 지갑 iframe의 `paypal-button`을 눌러야 열린다.
  스크립트가 iframe에 postMessage로 클릭을 지시하고 확인 신호를 받으면 종료한다.
  마지막 "Pay"는 PayPal 화면에서 사람이 누른다
- US 주소는 주(2자리)·ZIP(5자리)가 맞아야 하고, 주소가 KR이면 배송수단이 안 뜬다

## 하면 안 되는 것

- 스토어 탭을 닫거나 백그라운드로 숨기기
- 드랍 중 크롬 재시작, 확장 업데이트
- 카트를 손으로 비우기 (ARM 때 자동으로 비운다)

## 증상별 조치

| 증상 | 원인 | 조치 |
|---|---|---|
| US 탭이 shop.supreme.com으로 튐 | PAC 미적용 또는 프록시 사망 | PAC 등록 확인, 후보 교체 |
| 로그에 retry-after 60s | shared 프록시 IP 과다 사용 | 후보 교체. 드랍 1시간 전부터 그 IP는 예비로 |
| 배송수단이 안 뜨고 결제버튼 잠김 | 주소 미확정(주/ZIP 불일치) | 주소·주·ZIP 재입력 |
| "PayPal 버튼 못 찾음" | 지갑 iframe 미생성 | 결제수단을 PayPal로 다시 선택 |
| "큐/차단" 반복 | Cloudflare/IP | 대기. 30분 지속 시 IP 교체 |
| 카드 필드 빈칸 | 결제 iframe 재생성 | 자동 재주입되나 계속 비면 수동 입력 |

## 로그

스토어 탭 우하단 패널 로그, 또는 콘솔 `[cop]` 라인.
