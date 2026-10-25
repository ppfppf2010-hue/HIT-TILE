// 히트타일 - 이카운트 OAPI 검증(인증) 일괄 실행 스크립트
//
// 왜 필요한가: 이카운트는 API마다 "테스트 인증키로 한 번 성공 호출"을 해야 [API인증현황]에 검증 완료로
// 올라가고, 그 뒤에야 정식키(oapi)로 쓸 수 있다. 검증 안 된 API를 정식키로 부르면
// "인증되지 않은 API입니다(EXP00001)"가 나온다. (8월에 거래처등록/구매입력도 같은 방식으로 검증함)
//
// 실행 (중계서버에서, .env가 있는 이 폴더에서):
//   node verify-apis.js               -> 테스트 인증키를 물어본 뒤 아래 APIS를 순서대로 1번씩 호출
//   node verify-apis.js 품목조회 재고현황  -> 이름에 해당 글자가 들어간 것만 호출 (실패한 것만 다시 할 때)
//
// 테스트 인증키는 실행할 때 입력받기만 하고 어디에도 저장하지 않는다 (.env에도 넣지 말 것).
// 이카운트 테스트 서버는 조회 1회/10초 제한이 있어서 호출 사이에 11초씩 쉰다.
//
// 경로/필드는 이카운트 매뉴얼을 직접 열람하지 못한 채 기존 API 명명 규칙으로 추정한 것이 섞여 있다.
// "주소 틀림"으로 나온 API는 매뉴얼 해당 화면의 Test URL과 필수 항목을 보고 아래 APIS만 고치면 된다.

require('dotenv').config();
const readline = require('readline');

const { ECOUNT_COM_CODE, ECOUNT_USER_ID } = process.env;
// 판매등록 화면 기준 본사창고 코드. 다르면 실행 전에 VERIFY_WH_CD=... 로 바꾼다
const WH_CD = process.env.VERIFY_WH_CD || '100';
// 실제 등록된 품목코드 하나 (단건 조회 · 입력 검증용)
const PROD_CD = process.env.VERIFY_PROD_CD || 'HS00012';
// 8월 검증 때 만든 테스트 거래처. 입력 API의 테스트 전표가 실제 거래처에 붙지 않게 한다
const TEST_CUST = '1234567890';
const TEST_CUST_DES = '검증테스트거래처';
const TEST_REMARKS = 'API검증 테스트 - 삭제해도 됨';

const today = (() => {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간
  return d.toISOString().slice(0, 10).replace(/-/g, '');
})();
const monthAgo = (() => {
  const d = new Date(Date.now() + 9 * 3600 * 1000 - 30 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
})();

const line = extra => [{ Line: 1, BulkDatas: Object.assign({ UPLOAD_SER_NO: '1', IO_DATE: today }, extra) }];

// 조회 계열을 먼저(데이터를 만들지 않음), 입력 계열은 뒤에 둔다
const APIS = [
  { name: '품목조회(단건)', path: '/OAPI/V2/InventoryBasic/ViewBasicProduct', body: { PROD_CD } },
  { name: '품목조회', path: '/OAPI/V2/InventoryBasic/GetBasicProductsList', body: {} },
  { name: '재고현황(단건)', path: '/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatus', body: { BASE_DATE: today, PROD_CD } },
  { name: '재고현황', path: '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus', body: { BASE_DATE: today } },
  { name: '창고별재고현황(단건)', path: '/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatusByLocation', body: { BASE_DATE: today, PROD_CD } },
  { name: '창고별재고현황', path: '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation', body: { BASE_DATE: today } },
  { name: '발주서조회', path: '/OAPI/V2/Purchases/GetPurchasesOrderList',
    body: { PROD_CD: '', CUST_CD: '', ListParam: { BASE_DATE_FROM: monthAgo, BASE_DATE_TO: today, PAGE_CURRENT: 1, PAGE_SIZE: 10 } } },
  { name: '견적서입력', path: '/OAPI/V2/Quotation/SaveQuotation',
    body: { QuotationList: line({ CUST: TEST_CUST, CUST_DES: TEST_CUST_DES, WH_CD, PROD_CD, QTY: '1', REMARKS: TEST_REMARKS }) } },
  { name: '주문서입력', path: '/OAPI/V2/SaleOrder/SaveSaleOrder',
    body: { SaleOrderList: line({ CUST: TEST_CUST, CUST_DES: TEST_CUST_DES, WH_CD, PROD_CD, QTY: '1', REMARKS: TEST_REMARKS }) } },
  { name: '발주서입력', path: '/OAPI/V2/PurchasesOrder/SavePurchasesOrder',
    body: { PurchasesOrderList: line({ CUST: TEST_CUST, CUST_DES: TEST_CUST_DES, WH_CD, PROD_CD, QTY: '1', REMARKS: TEST_REMARKS }) } },
  // 창고이동은 보내는 창고와 받는 창고가 달라야 한다. 창고가 하나뿐이면 실패하는 게 정상
  { name: '창고이동입력', path: '/OAPI/V2/GoodsMovement/SaveGoodsMovement',
    body: { GoodsMovementList: line({ WH_CD_F: WH_CD, WH_CD_T: process.env.VERIFY_WH_CD_TO || WH_CD, PROD_CD, QTY: '1', REMARKS: TEST_REMARKS }) } }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { Status: String(res.status), raw: text.slice(0, 300) }; }
}

// server.js의 ecountFailureMessage와 같은 판정 (Status/Errors/Error 중 하나라도 실패면 실패)
function failureMessage(data) {
  if (!data) return '응답 없음';
  if (data.Errors && data.Errors.length) return data.Errors.map(e => e.Message || e.Code).join(' / ');
  if (data.Error && (data.Error.Message || data.Error.Code)) return data.Error.Message || ('에러코드 ' + data.Error.Code);
  if (data.Status && String(data.Status) !== '200') return '응답 코드 ' + data.Status + (data.raw ? ' ' + data.raw : '');
  // 입력 계열은 본문 Data.FailCnt로 실패 건수를 알려준다
  const failCnt = data.Data && Number(data.Data.FailCnt);
  if (failCnt) return '저장 실패 ' + failCnt + '건: ' + JSON.stringify(data.Data.ResultDetails || data.Data).slice(0, 300);
  return null;
}

function hint(msg) {
  if (/No HTTP resource/i.test(msg)) return '주소 틀림 - 매뉴얼 해당 화면의 Test URL을 캡처해 주세요';
  if (/인증되지 않은/.test(msg)) return '테스트키로도 거절 - 테스트키가 맞는지 확인';
  return '필수 항목/값 문제일 수 있음 - 매뉴얼 해당 화면의 필수 항목을 캡처해 주세요';
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

(async () => {
  if (!ECOUNT_COM_CODE || !ECOUNT_USER_ID) {
    console.error('.env에 ECOUNT_COM_CODE, ECOUNT_USER_ID가 필요합니다. ecount-relay 폴더에서 실행하세요.');
    process.exit(1);
  }
  const filters = process.argv.slice(2);
  const targets = filters.length ? APIS.filter(a => filters.some(f => a.name.includes(f))) : APIS;
  if (!targets.length) { console.error('해당하는 API가 없습니다: ' + filters.join(', ')); process.exit(1); }

  const testKey = process.env.VERIFY_TEST_KEY || await ask('이카운트 테스트 인증키: ');
  if (!testKey) { console.error('테스트 인증키가 없습니다.'); process.exit(1); }

  const zoneData = await post('https://sboapi.ecount.com/OAPI/V2/Zone', { COM_CODE: ECOUNT_COM_CODE });
  const zone = zoneData && zoneData.Data && zoneData.Data.ZONE;
  if (!zone) { console.error('Zone 조회 실패:', JSON.stringify(zoneData)); process.exit(1); }

  const loginData = await post(`https://sboapi${zone}.ecount.com/OAPI/V2/OAPILogin`, {
    COM_CODE: ECOUNT_COM_CODE, USER_ID: ECOUNT_USER_ID, API_CERT_KEY: testKey, LAN_TYPE: 'ko-KR', ZONE: zone
  });
  const sessionId = loginData && loginData.Data && loginData.Data.Datas && loginData.Data.Datas.SESSION_ID;
  if (!sessionId) { console.error('테스트키 로그인 실패:', JSON.stringify(loginData)); process.exit(1); }
  console.log(`테스트 서버 로그인 성공 (zone ${zone}). ${targets.length}개 API를 11초 간격으로 호출합니다.\n`);

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const api = targets[i];
    if (i) await sleep(11000);
    let msg;
    try {
      const data = await post(`https://sboapi${zone}.ecount.com${api.path}?SESSION_ID=${encodeURIComponent(sessionId)}`, api.body);
      msg = failureMessage(data);
      if (process.env.VERIFY_DEBUG) console.log(JSON.stringify(data).slice(0, 1500));
    } catch (err) {
      msg = '호출 오류: ' + err.message;
    }
    results.push({ name: api.name, ok: !msg, msg });
    console.log(msg ? `❌ ${api.name}: ${msg}\n   → ${hint(msg)}` : `✅ ${api.name}`);
  }

  const okCount = results.filter(r => r.ok).length;
  console.log(`\n성공 ${okCount} / ${results.length}`);
  console.log('이카운트 [API인증키발급 > API인증현황]에서 검증 여부를 확인하세요.');
  if (results.some(r => r.ok && /입력/.test(r.name))) {
    console.log(`입력 API 검증으로 만든 전표는 적요가 "${TEST_REMARKS}"입니다. 실제 장부에 보이면 지워 주세요.`);
  }
})();
