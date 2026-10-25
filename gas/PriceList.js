/**
 * ===== 거래처(고객/실장님)용 출고단가 조회 - B2B 포털 방식 =====
 * 고객 공개 페이지(/price/)가 부르는 action="price_search".
 *
 * 거래처마다 각자 접속코드(링크)를 발급받아 접속하고, 본인 단가를 조회한다.
 * 발급/관리는 구글시트 "단가조회거래처" 탭에서 한다.
 *   A 거래처명 | B 접속코드 | C 단가조정(%) | D 사용여부 | E 마지막조회 | F 접속링크
 *   - 접속코드: 비워두고 fillPriceCodes()를 [Run]하면 자동으로 채워진다.
 *   - 단가조정(%): 비우면 기본 출고단가 그대로. -3 이면 3% 할인, 5 이면 5% 할증(100원 단위 반올림).
 *   - 사용여부: N 이면 그 거래처 접속을 막는다(비우면 사용).
 *
 * 공개 페이지라서 아래 원칙을 지킨다.
 * - 내보내는 값은 품명 / 규격 / 단위 / 출고단가(+VAT 포함 여부) 뿐이다.
 *   입고단가, 거래처명(=매입처), 품목코드(접두어로 매입처가 드러남)는 절대 응답에 넣지 않는다.
 * - 발급된(사용 중인) 접속코드를 아는 사람만 조회할 수 있다.
 * - 접속코드를 여러 번 틀리면 그 방문자(브라우저)만 잠시 잠근다. 한 거래처의 오입력이 다른 거래처를 막지 않도록
 *   방문자별로 센다. 전체 합산이 아주 많아지면(무작위 대입 의심) 전체를 잠시 잠그는 안전장치도 따로 둔다.
 * - 한 번에 최대 PRICE_SEARCH_LIMIT건만 내려준다(전체 목록을 통째로 가져가기 어렵게).
 *
 * 품목등록마스터 열: A코드 B품목명 C규격구분 D규격 E입고단가 F입고VAT G단위 H품목구분 I세트 J재고관리 K출고단가 L출고VAT M거래처명
 */
const PRICE_CUSTOMER_SHEET = '단가조회거래처';
const PRICE_PAGE_URL = 'https://ppfppf2010-hue.github.io/HIT-TILE/price/';
const PRICE_SEARCH_LIMIT = 50;
const PRICE_FAIL_PER_CLIENT = 10;   // 한 방문자가 10분 안에 이만큼 틀리면 그 방문자만 잠근다
const PRICE_FAIL_GLOBAL = 300;      // 전체 합산이 이만큼이면(무작위 대입 의심) 모두 잠시 잠근다
const PRICE_FAIL_WINDOW_SEC = 600;  // 10분

// 접속코드로 사용 중인 거래처 행을 찾는다. 없으면 null.
function findPriceCustomer(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return null;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(PRICE_CUSTOMER_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  for (let i = 0; i < data.length; i++) {
    const name = String(data[i][0] || '').trim();
    const rowCode = String(data[i][1] || '').trim().toLowerCase();
    const enabled = String(data[i][3] || '').trim().toUpperCase() !== 'N';
    if (name && rowCode && rowCode === c && enabled) {
      const adj = Number(data[i][2]);
      return { row: i + 2, name: name, adjust: isNaN(adj) ? 0 : adj };
    }
  }
  return null;
}

function handlePriceSearch(body) {
  const cache = CacheService.getScriptCache();
  const cid = String(body.cid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'anon';
  const clientKey = 'price_fail_c_' + cid;
  const clientFails = Number(cache.get(clientKey) || 0);
  const globalFails = Number(cache.get('price_fail_all') || 0);
  if (clientFails >= PRICE_FAIL_PER_CLIENT) throw new Error('접속코드를 여러 번 잘못 입력해서 잠시 막혔어요. 10분 뒤에 다시 시도해주세요.');
  if (globalFails >= PRICE_FAIL_GLOBAL) throw new Error('지금 접속이 몰려 잠시 막혀 있어요. 잠시 후 다시 시도해주세요.');

  const customer = findPriceCustomer(body.code);
  if (!customer) {
    cache.put(clientKey, String(clientFails + 1), PRICE_FAIL_WINDOW_SEC);
    cache.put('price_fail_all', String(globalFails + 1), PRICE_FAIL_WINDOW_SEC);
    throw new Error('접속코드가 맞지 않아요. 히트타일에서 안내드린 코드(또는 링크)를 확인해주세요.');
  }

  const q = String(body.q || '').trim().toLowerCase();
  if (!q) {
    // 접속 확인(검색어 없음)일 때만 마지막조회 시각을 남긴다.
    try {
      SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PRICE_CUSTOMER_SHEET).getRange(customer.row, 5).setValue(new Date());
    } catch (e) { /* 기록 실패는 조회에 영향 없음 */ }
    return jsonOut({ ok: true, customer: customer.name, items: [], total: 0 });
  }
  const tokens = q.split(/\s+/).filter(function (t) { return t; }).slice(0, 5);

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(MASTER_SHEET);
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (lastRow < 2) return jsonOut({ ok: true, customer: customer.name, items: [], total: 0 });
  const data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

  const factor = 1 + customer.adjust / 100;
  const matches = [];
  const seen = {};
  data.forEach(function (r) {
    const name = String(r[1] || '').trim();
    const base = Number(r[10]) || 0;
    if (!name || base <= 0) return; // 출고단가가 없는 품목(운임/할인 등)은 보여주지 않는다
    const spec = String(r[3] || '').trim();
    const hay = (name + ' ' + spec).toLowerCase();
    if (!tokens.every(function (t) { return hay.indexOf(t) !== -1; })) return;
    const price = customer.adjust ? Math.round((base * factor) / 100) * 100 : Math.round(base);
    const key = name + '|||' + spec + '|||' + price;
    if (seen[key]) return;
    seen[key] = true;
    matches.push({
      name: name,
      spec: spec,
      unit: String(r[6] || '').trim(),
      price: price,
      vat: (r[11] !== '' && Number(r[11]) === 0) ? '별도' : '포함'
    });
  });

  matches.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return jsonOut({ ok: true, customer: customer.name, total: matches.length, items: matches.slice(0, PRICE_SEARCH_LIMIT) });
}

// ==== 관리자용: "단가조회거래처" 탭 만들기 (1회) ====
// Apps Script 편집기에서 이 함수를 선택하고 [Run]. 이미 있으면 헤더만 확인한다.
function setupPriceCustomerSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(PRICE_CUSTOMER_SHEET);
  if (!sheet) sheet = ss.insertSheet(PRICE_CUSTOMER_SHEET);
  sheet.getRange(1, 1, 1, 6).setValues([['거래처명', '접속코드', '단가조정(%)', '사용여부', '마지막조회', '접속링크']])
    .setFontWeight('bold').setBackground('#eef4ff');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(6, 420);
  Logger.log('"' + PRICE_CUSTOMER_SHEET + '" 탭 준비 완료. A열에 거래처명을 적고 fillPriceCodes()를 [Run]하세요.');
}

// ==== 관리자용: A열에 거래처명만 적어두고 [Run]하면 접속코드(B열)와 접속링크(F열)를 채워준다 ====
// 이미 코드가 있는 행은 건드리지 않는다. 코드를 바꾸고 싶으면 B열 칸을 비우고 다시 [Run].
function fillPriceCodes() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(PRICE_CUSTOMER_SHEET);
  if (!sheet) { Logger.log('먼저 setupPriceCustomerSheet()를 [Run]해주세요.'); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('A열에 거래처명을 먼저 적어주세요.'); return; }
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const used = {};
  data.forEach(function (r) { const c = String(r[1] || '').trim().toLowerCase(); if (c) used[c] = true; });
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // 헷갈리는 글자(i,l,o,0,1) 제외
  let filled = 0;
  data.forEach(function (r, i) {
    const name = String(r[0] || '').trim();
    if (!name) return;
    let code = String(r[1] || '').trim();
    if (!code) {
      do {
        code = '';
        for (let k = 0; k < 6; k++) code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
      } while (used[code]);
      used[code] = true;
      sheet.getRange(i + 2, 2).setValue(code);
      filled++;
    }
    sheet.getRange(i + 2, 6).setFormula('="' + PRICE_PAGE_URL + '?c="&B' + (i + 2));
  });
  Logger.log('접속코드 ' + filled + '개 새로 발급, 접속링크(F열) 갱신 완료.');
}
