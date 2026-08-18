// 히트타일 - 이카운트(Ecount) 연동 중계서버
//
// 왜 필요한가: Google Apps Script(UrlFetchApp)는 요청마다 구글 클라우드의 서로 다른 IP로 나가서
// (34.x.x.x, 35.x.x.x, 107.x.x.x 등 매번 랜덤) 이카운트의 IP허용 방식과 근본적으로 안 맞는다.
// 그래서 고정 IP를 가진 이 작은 서버를 하나 두고, GAS -> 이 서버 -> 이카운트 순서로 우회한다.
// 이 서버의 IP 하나만 이카운트 [API인증키발급 > IP등록]에 등록해두면 된다.
//
// 이 서버는 GAS로부터만 호출된다고 가정하고, RELAY_SECRET 공유 비밀키로 간단히 인증한다.

require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));

const {
  ECOUNT_COM_CODE,
  ECOUNT_USER_ID,
  ECOUNT_API_CERT_KEY,
  ECOUNT_DOMAIN = 'sboapi', // 테스트키='sboapi', 정식키='oapi'
  RELAY_SECRET,
  PORT = 3000
} = process.env;

if (!ECOUNT_COM_CODE || !ECOUNT_USER_ID || !ECOUNT_API_CERT_KEY || !RELAY_SECRET) {
  console.error('환경변수 누락: ECOUNT_COM_CODE, ECOUNT_USER_ID, ECOUNT_API_CERT_KEY, RELAY_SECRET 모두 필요합니다.');
  process.exit(1);
}

// ---- 인증: GAS만 호출할 수 있도록 공유 비밀키 검사 ----
app.use((req, res, next) => {
  if (req.get('X-Relay-Secret') !== RELAY_SECRET) {
    return res.status(401).json({ ok: false, error: '인증 실패' });
  }
  next();
});

// ---- 이카운트 Zone/세션 캐시 (매 요청마다 새로 로그인하지 않도록) ----
let zoneCache = null; // { zone }
let sessionCache = null; // { sessionId, loggedInAt }

async function fetchZone() {
  if (zoneCache) return zoneCache.zone;
  const res = await fetch('https://sboapi.ecount.com/OAPI/V2/Zone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ COM_CODE: ECOUNT_COM_CODE })
  });
  const data = await res.json();
  const zone = data && data.Data && data.Data.ZONE;
  if (!zone) throw new Error('이카운트 Zone 조회 실패: ' + JSON.stringify(data));
  zoneCache = { zone };
  return zone;
}

async function ecountLogin(forceRelogin) {
  if (sessionCache && !forceRelogin) return sessionCache.sessionId;
  const zone = await fetchZone();
  const res = await fetch(`https://${ECOUNT_DOMAIN}${zone}.ecount.com/OAPI/V2/OAPILogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      COM_CODE: ECOUNT_COM_CODE,
      USER_ID: ECOUNT_USER_ID,
      API_CERT_KEY: ECOUNT_API_CERT_KEY,
      LAN_TYPE: 'ko-KR',
      ZONE: zone
    })
  });
  const data = await res.json();
  const sessionId = data && data.Data && data.Data.Datas && data.Data.Datas.SESSION_ID;
  if (!sessionId) throw new Error('이카운트 로그인 실패: ' + JSON.stringify(data));
  sessionCache = { sessionId, loggedInAt: Date.now() };
  return sessionId;
}

// ---- 이카운트 OAPI 호출 공통 헬퍼: 세션 만료 시 한 번 재로그인 후 재시도 ----
async function ecountCall(apiPath, body, retried) {
  const zone = await fetchZone();
  const sessionId = await ecountLogin(false);
  const url = `https://${ECOUNT_DOMAIN}${zone}.ecount.com${apiPath}?SESSION_ID=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();

  // 세션 만료/무효로 보이는 에러면 한 번만 재로그인 후 재시도
  const looksLikeSessionError = data && (data.Status === '401' || (data.Error && /session|세션/i.test(JSON.stringify(data.Error))));
  if (looksLikeSessionError && !retried) {
    await ecountLogin(true);
    return ecountCall(apiPath, body, true);
  }
  return data;
}

// ---- 거래처 등록/동기화 (SaveBasicCust) ----
// businessNo(사업자등록번호)가 이카운트의 실제 거래처코드다. 하이픈은 제거해서 보낸다.
app.post('/register-vendor', async (req, res) => {
  try {
    const { businessNo, custName } = req.body;
    if (!custName) throw new Error('custName 필요');

    const bulkDatas = { CUST_NAME: custName };
    if (businessNo) bulkDatas.BUSINESS_NO = String(businessNo).replace(/\D/g, '');

    const data = await ecountCall('/OAPI/V2/AccountBasic/SaveBasicCust', {
      CustList: [{ Line: 1, BulkDatas: bulkDatas }]
    });
    res.json({ ok: true, ecount: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- 품목 등록/동기화 (SaveBasicProduct) ----
// prodCd는 우리 시스템에서 이미 채번한 코드를 그대로 쓴다(이카운트 PROD_CD는 자유 코드).
app.post('/register-item', async (req, res) => {
  try {
    const { prodCd, prodDes, spec, unit, inPrice, inPriceVat, outPrice, outPriceVat } = req.body;
    if (!prodCd || !prodDes) throw new Error('prodCd, prodDes 필요');

    const data = await ecountCall('/OAPI/V2/InventoryBasic/SaveBasicProduct', {
      ProductList: [{
        Line: 1,
        BulkDatas: {
          PROD_CD: prodCd,
          PROD_DES: prodDes,
          SIZE_FLAG: spec ? '1' : undefined,
          SIZE_DES: spec || undefined,
          UNIT: unit || 'EA',
          IN_PRICE: inPrice != null ? String(inPrice) : undefined,
          IN_PRICE_VAT: inPriceVat ? '1' : '0',
          OUT_PRICE: outPrice != null ? String(outPrice) : undefined,
          OUT_PRICE_VAT: outPriceVat ? '1' : '0'
        }
      }]
    });
    res.json({ ok: true, ecount: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- 매입전표 저장 (SavePurchases) ----
// rows: [{ date(YYYYMMDD), custDes, whCd, prodCd, prodDes, qty, unitPriceVat, supply, vat, remarks }]
// 한 번의 호출에 들어온 rows는 전부 같은 순번(UPLOAD_SER_NO)을 줘서 하나의 전표로 묶는다
// (한 번의 구매확정 = 거래명세서 한 장 = 전표 한 장이라는 전제).
app.post('/push-purchase', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows || !rows.length) throw new Error('rows 필요');

    const PurchasesList = rows.map((r, i) => ({
      Line: i + 1,
      BulkDatas: {
        UPLOAD_SER_NO: '1',
        IO_DATE: r.date,
        CUST_DES: r.custDes,
        WH_CD: r.whCd,
        PROD_CD: r.prodCd,
        PROD_DES: r.prodDes,
        QTY: String(r.qty),
        USER_PRICE_VAT: String(r.unitPriceVat),
        SUPPLY_AMT: String(r.supply),
        VAT_AMT: String(r.vat),
        REMARKS: r.remarks || ''
      }
    }));

    const data = await ecountCall('/OAPI/V2/Purchases/SavePurchases', { PurchasesList });
    res.json({ ok: true, ecount: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log('ecount relay listening on ' + PORT));
