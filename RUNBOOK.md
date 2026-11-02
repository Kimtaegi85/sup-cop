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
- 해제: `Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" AutoConfigURL`

## 드랍 절차 (매주 목요일)

- 드랍: 목요일 11:00 뉴욕 = **한국 금요일 01:00**
- 00:53~00:55 — 패널에서 감시 시작 또는 폰에서 원격 ARM
- 폴링은 200ms(드랍 15초 전부터 120ms). 3DS/앱 승인 팝업은 사용자 폰으로 처리

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
| 배송수단이 안 뜨고 결제버튼 잠김 | 주소 미확정(주/ZIP 불일치) | 주소·주·ZIP 재입력 |
| "PayPal 버튼 못 찾음" | 지갑 iframe 미생성 | 결제수단을 PayPal로 다시 선택 |
| "큐/차단" 반복 | Cloudflare/IP | 대기. 30분 지속 시 IP 교체 |
| 카드 필드 빈칸 | 결제 iframe 재생성 | 자동 재주입되나 계속 비면 수동 입력 |

## 로그

스토어 탭 우하단 패널 로그, 또는 콘솔 `[cop]` 라인.
