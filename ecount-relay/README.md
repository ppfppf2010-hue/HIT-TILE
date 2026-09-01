# 이카운트 연동 중계서버

## 왜 필요한가
Google Apps Script(UrlFetchApp)는 요청마다 구글 클라우드의 서로 다른 IP로 나간다(테스트해보니 34.x.x.x, 35.x.x.x, 107.x.x.x 등 매번 랜덤). 이카운트 OAPI는 IP를 미리 등록해야만 접속을 허용하는데, GAS는 IP가 고정이 아니라서 직접 호출이 불가능하다.

그래서 고정 IP를 가진 이 작은 서버를 하나 두고, `GAS → 이 서버 → 이카운트` 순서로 우회한다. 이 서버의 IP 하나만 이카운트에 등록해두면 된다.

## 준비물
- 고정 IP를 주는 저가 VPS 하나 (월 5천~1만원선). Vultr, DigitalOcean, 네이버클라우드 등 아무 곳이나 무방 — Node.js 18+ 만 돌아가면 됨.
- 이카운트 API인증키발급 화면에서 발급받은 인증키, 회사코드, USER_ID.

## 배포 순서
1. VPS 가입 후 Node.js 설치 (`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`, 우분투 기준)
2. 이 폴더(`ecount-relay/`)를 VPS로 복사하거나 `git clone`
3. `npm install`
4. `.env.example`을 `.env`로 복사하고 실제 값 채우기:
   - `ECOUNT_COM_CODE`, `ECOUNT_USER_ID`, `ECOUNT_API_CERT_KEY` — 이카운트 API인증키발급 화면 값
   - `ECOUNT_DOMAIN` — 테스트키면 `sboapi`, 정식키로 바꾸면 `oapi`
   - `RELAY_SECRET` — 아무 긴 랜덤 문자열 (GAS가 이 서버를 호출할 때 같이 보내는 비밀키, 남이 못 쓰게 막는 용도)
5. VPS가 재부팅돼도 계속 떠있게 `pm2` 같은 프로세스 매니저로 실행:
   ```bash
   npm install -g pm2
   pm2 start server.js --name ecount-relay
   pm2 save
   pm2 startup   # 안내되는 명령어 한 줄 그대로 실행하면 재부팅 시 자동시작
   ```
6. 방화벽에서 PORT(기본 3000)를 열어두거나, nginx로 80/443에 리버스프록시 걸기(권장 — https 적용됨)
7. **이 서버의 고정 IP를 이카운트 [Self-Customizing > API인증키발급 > IP등록]에 등록**
8. `curl https://<서버주소>/health -H "X-Relay-Secret: <RELAY_SECRET>"` 로 `{"ok":true}` 확인

## API
모든 요청은 헤더 `X-Relay-Secret: <RELAY_SECRET>` 필요.

- `POST /register-vendor` — `{businessNo, custName}` → 이카운트 거래처 등록/동기화 (SaveBasicCust)
- `POST /register-item` — `{prodCd, prodDes, spec?, unit?, inPrice?, inPriceVat?, outPrice?, outPriceVat?}` → 이카운트 품목 등록/동기화 (SaveBasicProduct)
- `POST /push-purchase` — `{rows: [{date, custCd?, custDes, whCd, prodCd, prodDes, qty, unitPriceVat, supply, vat, remarks}]}` → 매입전표 저장 (SavePurchases). 한 번의 호출에 담긴 rows는 전부 한 장의 전표로 묶인다. `custCd`(=사업자등록번호, 숫자만)가 있으면 `CUST_CD`로 같이 보내서 정확히 그 거래처에 붙인다.

## 알아둘 점
- 이카운트 거래처코드는 **사업자등록번호**다(우리가 정하는 코드가 아님). 원래는 이미 등록된 거래처면 거래처명(CUST_DES)만 보내도 이름으로 자동매칭될 거라 예상했는데, 실제로는 공백/"(주)" 위치 같은 표기 차이만 있어도 매칭에 실패해서 다른/새 거래처로 잡히는 문제가 있었다. 그래서 `/push-purchase`는 이제 사업자등록번호를 알고 있으면 `CUST_CD`로 명시해서 보낸다 — 이름 표기와 무관하게 정확한 거래처에 붙는다. 사업자번호가 없는(진짜 신규) 거래처만 여전히 이름 기반 매칭에 의존한다.
- 이카운트 품목코드(PROD_CD)는 우리가 자유롭게 정하는 코드라서, 우리 시스템에서 쓰는 코드를 그대로 등록하면 된다.
- SaveX 계열 API(SaveBasicCust/SaveBasicProduct/SavePurchases) 요청 바디는 전부 `{ XxxList: [ { Line: 1, BulkDatas: {...} } ] }` 형태다 — `BulkDatas`가 배열 안에 있는 게 아니라, `Line`+`BulkDatas`를 가진 객체들의 배열이라는 점이 헷갈리기 쉽다(문서 표만 보면 반대로 오해하기 쉬움, 직접 테스트해서 확인함).
- 이카운트 API는 **시간당 연속 오류 30건** 제한이 있다. 재시도 로직에서 무한 반복하지 않도록 주의.
- 테스트 인증키는 `sboapi` 도메인, 정식 인증키는 `oapi` 도메인을 쓴다. 정식키로 전환 시 `.env`의 `ECOUNT_DOMAIN`만 바꾸면 됨.
