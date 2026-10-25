// 일회용: 이카운트 품목조회 API(GetBasicProductsList) 검증 스크립트.
// (거래처조회로 쓰던 GetBasicCustList는 이카운트에 없는 주소로 확인돼 뺐다.)
// 이카운트는 API마다 테스트 인증키(sboapi)로 한 번 호출해야 [API인증현황]에 검증 완료로 올라가고,
// 그 뒤에야 정식키(oapi)로 쓸 수 있다. 테스트 서버도 IP 등록이 필요하므로 IP가 등록된 이 VPS에서 실행한다.
//
// 사용법 (ecount-relay 폴더에서):  node verify-lookup.js
//   테스트 인증키를 물어보면 붙여넣는다. 키는 화면에만 입력되고 파일·로그에 남지 않는다.
//   회사코드·사용자ID는 .env(ECOUNT_COM_CODE, ECOUNT_USER_ID)를 쓴다.
// 서버(server.js)는 건드리지 않으므로 재시작할 필요가 없다. 검증이 끝나면 이 파일은 지운다.
require('dotenv').config();
const readline = require('readline');

const { ECOUNT_COM_CODE, ECOUNT_USER_ID } = process.env;

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { raw: text.slice(0, 300) }; }
}

function brief(d) {
  const list = d && d.Data && (d.Data.Result || d.Data.Datas);
  return {
    status: d && d.Status,
    error: d && ((d.Errors && d.Errors[0] && d.Errors[0].Message) || (d.Error && d.Error.Message)) || null,
    count: Array.isArray(list) ? list.length : null,
    raw: d && d.raw
  };
}

async function main(testKey) {
  if (!ECOUNT_COM_CODE || !ECOUNT_USER_ID) throw new Error('.env에 ECOUNT_COM_CODE, ECOUNT_USER_ID가 필요합니다.');
  const zoneData = await post('https://sboapi.ecount.com/OAPI/V2/Zone', { COM_CODE: ECOUNT_COM_CODE });
  const zone = zoneData && zoneData.Data && zoneData.Data.ZONE;
  if (!zone) return console.log('ZONE 조회 실패', brief(zoneData));

  const login = await post(`https://sboapi${zone}.ecount.com/OAPI/V2/OAPILogin`, {
    COM_CODE: ECOUNT_COM_CODE, USER_ID: ECOUNT_USER_ID, API_CERT_KEY: testKey, LAN_TYPE: 'ko-KR', ZONE: zone
  });
  const sessionId = login && login.Data && login.Data.Datas && login.Data.Datas.SESSION_ID;
  if (!sessionId) return console.log('테스트키 로그인 실패:', (login && login.Data && login.Data.Message) || brief(login));

  const base = `https://sboapi${zone}.ecount.com/OAPI/V2`;
  const q = `?SESSION_ID=${encodeURIComponent(sessionId)}`;
  console.log('품목조회(GetBasicProductsList):', brief(await post(`${base}/InventoryBasic/GetBasicProductsList${q}`, { COMMA_FLAG: 'N' })));
  console.log('끝. 이카운트 [API인증현황]에서 품목조회가 검증 완료로 보이는지 확인하세요.');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('이카운트 테스트 인증키: ', key => {
  rl.close();
  main(key.trim()).catch(err => console.error('오류:', err.message));
});
