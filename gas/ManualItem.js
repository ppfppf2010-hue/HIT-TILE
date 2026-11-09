/**
 * ===== 품목등록 "직접 입력" (서류 없이 품목 1개씩 등록) =====
 * 업무용 사이트 품목등록 페이지의 "직접 입력" 탭이 부르는 action="item_manual_add".
 *
 * 거래처를 정하고 품목명/규격/단위/단가만 넣으면, 그 거래처의 코드 접두어로 품목코드(예: VG00047)를
 * 자동 채번해서 품목등록마스터에 저장하고 이카운트에도 바로 등록한다.
 *
 * - 신규 거래처(거래처코드관리에 없음)면 needsPrefix를 돌려주고, 접두어 + 사업자등록번호를 받아 다시 호출하면
 *   거래처도 같이 만든다(이카운트 거래처 동기화는 사업자등록번호가 있을 때만).
 * - 같은 거래처에 같은 품명+규격이 이미 있으면 duplicate를 돌려주고 등록하지 않는다(force:true면 무시하고 등록).
 * - 출고단가는 직접 넣지 않으면 입고단가 x 마진으로 계산한다. margin을 안 보내면 품목명으로 자동 판별(classifyMargin).
 * - dryRun:true면 아무것도 저장하지 않고 "이 코드로 등록될 것"만 돌려준다.
 * - 코드 번호가 겹치지 않게 스크립트 락을 잡고 채번~저장을 한 번에 처리한다.
 */
// ===== 출고단가 마진 판별 (출고단가 = 입고단가 x 마진) =====
// 타일 1.5 / 브랜드 도기·악세사리 1.2 / 비브랜드 도기·악세사리 1.4.
// 품목명(+거래처명)의 키워드로 종류를 판별한다. 브랜드/키워드는 아래 목록에 추가하면 바로 적용된다.
const MARGIN_TILE = 1.5;
const MARGIN_BRAND = 1.2;
const MARGIN_NONBRAND = 1.4;
// 브랜드 도기·악세사리 업체 (이름이나 거래처명에 들어 있으면 브랜드로 본다)
const BRAND_KEYWORDS = ['아메리칸스탠다드', 'american standard', '스탠다드', '대림', '계림'];
// 도기·악세사리 품목 키워드 (욕실 위생도기/수전/부속/액세서리)
const CERAMIC_ACC_KEYWORDS = ['변기', '세면대', '세면기', '소변기', '비데', '욕조', '수전', '꼭지', '싱크', '부속', '샤워', '슬라이드바', '슬바', '유가', '세면', '청소건', '휴지걸이', '수건걸이', '수건장', '타올', '비누대', '컵대', '선반', '욕실장', '거울', '파티션', '환풍기', '배수', '트랩', '앵글밸브', '폽업', '도기', '악세사리', '액세서리', '악세서리'];
// 거래처별 고정 마진 — 거래처명(또는 품목명)에 들어 있으면 품목 종류와 상관없이 이 마진을 쓴다
const VENDOR_MARGINS = [
  { keyword: '히든', margin: MARGIN_NONBRAND, label: '히든바스 1.4' }
];
// 이 단어가 들어 있으면 위 키워드가 있어도 타일로 본다
const TILE_KEYWORDS = ['타일', '포셀린', '모자이크', '폴리싱', '데코타일'];

function classifyMargin(name, vendorName) {
  const n = String(name || '').toLowerCase();
  const v = String(vendorName || '').toLowerCase();
  const has = function (text, list) { return list.some(function (k) { return text.indexOf(k.toLowerCase()) !== -1; }); };
  const fixed = VENDOR_MARGINS.find(function (r) { return has(v + ' ' + n, [r.keyword]); });
  if (fixed) return { margin: fixed.margin, label: fixed.label };
  if (has(n, TILE_KEYWORDS)) return { margin: MARGIN_TILE, label: '타일' };
  // 이름에 브랜드가 직접 들어 있으면(예: '아메리칸 스탠다드 오슬로 무광') 종류 단어가 없어도 브랜드 도기·악세사리로 본다.
  if (has(n, BRAND_KEYWORDS)) return { margin: MARGIN_BRAND, label: '브랜드 도기·악세사리' };
  if (has(n, CERAMIC_ACC_KEYWORDS)) {
    return has(n + ' ' + v, BRAND_KEYWORDS)
      ? { margin: MARGIN_BRAND, label: '브랜드 도기·악세사리' }
      : { margin: MARGIN_NONBRAND, label: '비브랜드 도기·악세사리' };
  }
  return { margin: MARGIN_TILE, label: '타일' };
}

// ===== 등록할 때 한글명 병기 =====
// 이카운트 품목 저장 API(SaveBasicProduct)는 이미 있는 코드를 고치지 못해서(“이미 품목등록에 존재하는 코드”),
// 등록한 뒤에 한글명을 붙이면 시트에만 붙었다가 매시간 대조 때 되돌아간다. 그래서 처음 등록할 때 붙인다.
// 대상: 앞의 "타일"을 뺀 나머지가 영문뿐(3글자 이상 영단어)이고 한글 병기가 아직 없는 이름 — 예: "타일HOLY BEIGE 80*80".
// 이미 한글이 섞인 이름(예: "Mega G2 브라운", "[힘펠] 201M")은 건드리지 않는다.
function needsKoreanName_(name) {
  const n = String(name || '').trim();
  if (!n || KO_SUFFIX_RE.test(n)) return false;
  const rest = n.replace(/^타일/, '');
  return /[A-Za-z]{3,}/.test(rest) && !HANGUL_RE.test(rest);
}

// items: [{name, spec, ...}] — 대상 품목의 name을 "영문 (한글)"로 바꾼다(제자리 수정). Claude 오류 시 그대로 둔다.
function addKoreanNames_(items) {
  const todo = (items || []).map(function (it, i) { return { it: it, key: 'K' + i }; })
    .filter(function (x) { return needsKoreanName_(x.it.name); });
  if (!todo.length) return items;
  try {
    const ko = translateNamesWithClaude_(todo.map(function (x) { return { code: x.key, name: String(x.it.name).trim(), spec: String(x.it.spec || '').trim() }; }));
    todo.forEach(function (x) {
      const k = String(ko[x.key] || '').trim();
      if (k && HANGUL_RE.test(k)) x.it.name = String(x.it.name).trim() + ' (' + k + ')';
    });
  } catch (e) {
    Logger.log('한글명 병기 실패(영문 그대로 등록): ' + e.message);
  }
  return items;
}

function handleItemManualAdd(body) {
  const vendorName = String(body.vendorName || '').trim();
  // koreanName을 주면 그대로 병기, noKorean:true면 병기하지 않는다. 둘 다 없으면 영문 이름에 자동 병기.
  let name = String(body.name || '').trim();
  if (body.koreanName) name = name + ' (' + String(body.koreanName).trim() + ')';
  else if (!body.noKorean) name = addKoreanNames_([{ name: name, spec: body.spec }])[0].name;
  const spec = String(body.spec || '').trim();
  const unit = String(body.unit || '').trim().toUpperCase() || 'EA';
  const prefixInput = String(body.prefix || '').trim().toUpperCase();
  const businessNo = String(body.businessNo || '').trim();
  const price = Number(body.price);
  const hasOutPrice = body.outPrice !== '' && body.outPrice != null && !isNaN(Number(body.outPrice));
  const outPriceInput = hasOutPrice ? Number(body.outPrice) : null;
  // 마진(출고단가 = 입고단가 x 마진): 타일 1.5 / 브랜드 도기·악세사리 1.2 / 비브랜드 도기·악세사리 1.4. 그 외 값은 1.5로 본다.
  const manualMargin = [1.5, 1.2, 1.4].indexOf(Number(body.margin)) !== -1 ? Number(body.margin) : null; // null = 품목명으로 자동 판별
  const force = !!body.force;
  const dryRun = !!body.dryRun;

  if (!vendorName) throw new Error('거래처명을 입력해주세요.');
  if (!name) throw new Error('품목명을 입력해주세요.');
  if (body.price === '' || body.price == null || isNaN(price) || price < 0) throw new Error('입고단가(VAT포함)를 숫자로 입력해주세요.');
  if (hasOutPrice && outPriceInput < 0) throw new Error('출고단가는 0 이상으로 입력해주세요.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 품목 등록이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    let vendorInfo = findVendor(vendorName);
    const isNewVendor = !vendorInfo;
    let prefix;
    if (vendorInfo) {
      prefix = vendorInfo.prefix;
    } else {
      if (!prefixInput) {
        return jsonOut({ ok: true, needsPrefix: true, vendorName: vendorName, suggestedPrefix: matchPrefix(vendorName) || '' });
      }
      // 영문(VG) 또는 한글(새손, 블루밍) 접두어 — 이카운트·ItemSync가 이미 한글 접두어 코드를 쓰고 있다
      if (!/^([A-Z]{2,4}|[가-힣]{1,4})$/.test(prefixInput)) throw new Error('코드 접두어는 영문 2~4자 또는 한글 1~4자로 입력해주세요.');
      prefix = prefixInput;
    }
    const storedVendorName = vendorInfo ? vendorInfo.storedName : vendorName;

    // 이미 같은 거래처에 같은(또는 오타 수준으로 비슷한) 품명+규격이 있으면 막는다.
    if (!force) {
      const dedup = dedupeAgainstMaster([{ name: name, spec: spec, price: price }], storedVendorName);
      if (dedup.skipped.length) {
        const s = dedup.skipped[0];
        return jsonOut({ ok: true, duplicate: true, matchedCode: s.matchedCode, matchedName: s.matchedName });
      }
    }

    const auto = classifyMargin(name, storedVendorName);
    const margin = manualMargin || auto.margin;
    const marginLabel = manualMargin ? '직접 선택' : '자동 판별: ' + auto.label;
    const sharedMax = getMaxLastUsedForPrefix(prefix);
    const startNumber = Math.max(vendorInfo ? vendorInfo.lastUsed : 0, sharedMax) + 1;
    const row = assignCodesAndPrices([{ name: name, spec: spec, unit: unit, price: price }], prefix, startNumber, storedVendorName)[0];
    // 직접 입력한 단가는 100원 단위로 반올림하지 않고 그대로 쓴다(서류 인식값만 반올림하는 기존 규칙).
    row.inPrice = Math.round(price);
    row.outPrice = hasOutPrice ? Math.round(outPriceInput) : Math.round((row.inPrice * margin) / 100) * 100;

    if (dryRun) {
      return jsonOut({ ok: true, dryRun: true, margin: margin, marginLabel: marginLabel, code: row.code, willCreateVendor: !vendorInfo, vendorName: storedVendorName, row: row });
    }

    let ecountVendorResult = null;
    if (!vendorInfo) {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      ss.getSheetByName(VENDOR_SHEET).appendRow([vendorName, prefix, sharedMax, businessNo]);
      vendorInfo = { storedName: vendorName, prefix: prefix, lastUsed: sharedMax, businessNo: businessNo };
      ecountVendorResult = ecountSyncVendor(vendorName, businessNo);
    }

    appendToMasterSheet(storedVendorName, [row]);
    // 사용중단 코드와 겹치는 번호는 건너뛰므로 startNumber가 아니라 실제로 받은 번호를 기록한다.
    saveLastUsedByPrefix(prefix, Number(row.code.slice(prefix.length)));
    const ecountItemResult = ecountSyncItem(row, storedVendorName);

    return jsonOut({
      ok: true, code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      inPrice: row.inPrice, outPrice: row.outPrice, margin: margin, marginLabel: marginLabel, vendorName: storedVendorName,
      newVendor: isNewVendor,
      ecount: {
        vendor: ecountVendorResult ? summarizeEcountResult_(ecountVendorResult) : null,
        item: summarizeEcountResult_(ecountItemResult)
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// 중계서버 응답({ok, ecount:{Status, Data:{SuccessCnt, FailCnt, ...}}})을 화면에 보여줄 {ok, message}로 줄인다.
// 중계서버는 이카운트가 거절해도 ok:true로 돌려주므로(요청 자체는 전달됐으니), 이카운트 쪽 Status/FailCnt도 같이 본다.
function summarizeEcountResult_(r) {
  if (!r || !r.ok) return { ok: false, message: (r && r.error) || '중계서버 호출 실패' };
  const ec = r.ecount || {};
  const data = ec.Data || {};
  const failed = (data.FailCnt && Number(data.FailCnt) > 0) || (ec.Status && String(ec.Status) !== '200');
  if (!failed) return { ok: true, message: '' };
  let detail = '';
  try {
    const d0 = (data.ResultDetails || [])[0];
    detail = d0 ? (d0.TotalError || JSON.stringify(d0.Errors || d0)) : (ec.Error && ec.Error.Message) || '';
  } catch (e) { /* ignore */ }
  return { ok: false, message: String(detail || '이카운트가 등록을 거절했어요').slice(0, 300) };
}

// ===== 품목 재발급 (action="item_reissue") =====
// 이미 등록된 품목의 이름·한글명·구매처·규격·단위·단가를 바꿔야 할 때, 이카운트가 기존 코드 수정을 막으므로
// 기존 코드는 그대로 두고 새 코드로 다시 등록한 뒤 기존 코드를 사용중단한다(시트 P열 + "이카운트사용중단대기" 탭).
// body: {code, name?, koreanName?, spec?, unit?, inPrice?, outPrice?, vendorName?, reason?, dryRun?}
//  - 안 보낸 값은 기존 품목 그대로 복사한다. name을 안 보내면 기존 이름에 한글명을 자동 병기한다(영문 이름일 때).
//  - vendorName을 보내면 그 거래처(거래처코드관리에 있어야 함)의 접두어로 새 코드를 받는다.
function handleItemReissue(body) {
  const oldCode = String(body.code || '').trim();
  if (!oldCode) throw new Error('재발급할 기존 품목코드(code)를 보내주세요.');
  const has = function (k) { return body[k] !== undefined && body[k] !== null && body[k] !== ''; };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 품목 등록이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    const master = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(MASTER_SHEET);
    const data = master.getRange(2, 1, master.getLastRow() - 1, ITEM_DISCONTINUED_COL).getValues();
    const old = data.find(function (r) { return String(r[0]).trim().toUpperCase() === oldCode.toUpperCase(); });
    if (!old) throw new Error('품목등록마스터에 없는 코드예요: ' + oldCode);

    const vendorName = has('vendorName') ? String(body.vendorName).trim() : String(old[12] || '').trim();
    const vendorInfo = vendorName ? findVendor(vendorName) : null;
    if (!vendorInfo) throw new Error('새 코드를 받을 거래처를 찾을 수 없어요(거래처코드관리에 있어야 함): ' + (vendorName || '(기존 품목에 거래처 없음 — vendorName을 보내주세요)'));

    let name = has('name') ? String(body.name).trim() : String(old[1]).trim();
    if (has('koreanName')) name = name.replace(KO_SUFFIX_RE, '').trim() + ' (' + String(body.koreanName).trim() + ')';
    else if (!has('name')) name = addKoreanNames_([{ name: name, spec: old[3] }])[0].name;
    const spec = has('spec') ? String(body.spec).trim() : String(old[3] || '').trim();
    const unit = has('unit') ? String(body.unit).trim().toUpperCase() : (String(old[6] || '').trim() || 'EA');
    const inPrice = Math.round(has('inPrice') ? Number(body.inPrice) : Number(old[4]) || 0);
    const outPrice = Math.round(has('outPrice') ? Number(body.outPrice) : Number(old[10]) || 0);

    const prefix = vendorInfo.prefix;
    const sharedMax = getMaxLastUsedForPrefix(prefix);
    const startNumber = Math.max(vendorInfo.lastUsed, sharedMax) + 1;
    const row = assignCodesAndPrices([{ name: name, spec: spec, unit: unit, price: inPrice }], prefix, startNumber, vendorInfo.storedName)[0];
    row.inPrice = inPrice;
    row.outPrice = outPrice;
    row.inVat = old[5] === '' ? 1 : Number(old[5]);
    row.outVat = old[11] === '' ? 1 : Number(old[11]);

    if (body.dryRun) return jsonOut({ ok: true, dryRun: true, oldCode: oldCode, row: row, vendorName: vendorInfo.storedName });

    appendToMasterSheet(vendorInfo.storedName, [row]);
    saveLastUsedByPrefix(prefix, Number(row.code.slice(prefix.length)));
    const ecountItemResult = ecountSyncItem(row, vendorInfo.storedName);
    markItemsDiscontinued_([oldCode], false);
    appendDiscontinueQueue_([{ oldCode: oldCode, oldName: String(old[1]).trim(), newCode: row.code, newName: row.name, reason: String(body.reason || '') }]);

    return jsonOut({
      ok: true, oldCode: oldCode, code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      inPrice: row.inPrice, outPrice: row.outPrice, vendorName: vendorInfo.storedName,
      ecount: { item: summarizeEcountResult_(ecountItemResult) }
    });
  } finally {
    lock.releaseLock();
  }
}
