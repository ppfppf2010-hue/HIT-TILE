/**
 * ===== 거래처(고객/실장님)용 출고단가 조회 =====
 * 고객 공개 페이지(/price/)가 부르는 action="price_search".
 *
 * 공개 페이지라서 아래 원칙을 지킨다.
 * - 내보내는 값은 품명 / 규격 / 단위 / 출고단가(+VAT 포함 여부) 뿐이다.
 *   입고단가, 거래처명(=매입처), 품목코드(접두어로 매입처가 드러남)는 절대 응답에 넣지 않는다.
 * - 스크립트 속성 PRICE_PAGE_CODE(접속코드)를 아는 사람만 조회할 수 있다. 속성이 비어 있으면 아무에게도 응답하지 않는다.
 * - 접속코드 오입력이 짧은 시간에 많이 쌓이면 잠시 잠근다(무작위 대입 방지).
 * - 한 번에 최대 PRICE_SEARCH_LIMIT건만 내려준다(전체 목록을 통째로 가져가기 어렵게).
 *
 * 품목등록마스터 열: A코드 B품목명 C규격구분 D규격 E입고단가 F입고VAT G단위 H품목구분 I세트 J재고관리 K출고단가 L출고VAT M거래처명
 */
const PRICE_SEARCH_LIMIT = 50;
const PRICE_FAIL_LIMIT = 30;       // 이 횟수만큼 틀리면
const PRICE_FAIL_WINDOW_SEC = 600; // 10분 동안 잠근다

function handlePriceSearch(body) {
  const need = String(PropertiesService.getScriptProperties().getProperty('PRICE_PAGE_CODE') || '').trim();
  if (!need) throw new Error('가격표가 아직 열려 있지 않아요. 히트타일로 문의해주세요.');

  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('price_fail') || 0);
  if (fails >= PRICE_FAIL_LIMIT) throw new Error('접속코드를 여러 번 잘못 입력해서 잠시 막혔어요. 10분 뒤에 다시 시도해주세요.');

  if (String(body.code || '').trim() !== need) {
    cache.put('price_fail', String(fails + 1), PRICE_FAIL_WINDOW_SEC);
    throw new Error('접속코드가 맞지 않아요.');
  }

  const q = String(body.q || '').trim().toLowerCase();
  if (!q) return jsonOut({ ok: true, items: [], total: 0 });
  const tokens = q.split(/\s+/).filter(function (t) { return t; }).slice(0, 5);

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(MASTER_SHEET);
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (lastRow < 2) return jsonOut({ ok: true, items: [], total: 0 });
  const data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

  const matches = [];
  const seen = {};
  data.forEach(function (r) {
    const name = String(r[1] || '').trim();
    const price = Number(r[10]) || 0;
    if (!name || price <= 0) return; // 출고단가가 없는 품목(운임/할인 등)은 보여주지 않는다
    const spec = String(r[3] || '').trim();
    const hay = (name + ' ' + spec).toLowerCase();
    if (!tokens.every(function (t) { return hay.indexOf(t) !== -1; })) return;
    const key = name + '|||' + spec + '|||' + price;
    if (seen[key]) return;
    seen[key] = true;
    matches.push({
      name: name,
      spec: spec,
      unit: String(r[6] || '').trim(),
      price: Math.round(price),
      vat: (r[11] !== '' && Number(r[11]) === 0) ? '별도' : '포함'
    });
  });

  matches.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return jsonOut({ ok: true, total: matches.length, items: matches.slice(0, PRICE_SEARCH_LIMIT) });
}
