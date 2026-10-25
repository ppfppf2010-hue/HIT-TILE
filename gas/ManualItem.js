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
// 이 단어가 들어 있으면 위 키워드가 있어도 타일로 본다
const TILE_KEYWORDS = ['타일', '포셀린', '모자이크', '폴리싱', '데코타일'];

function classifyMargin(name, vendorName) {
  const n = String(name || '').toLowerCase();
  const v = String(vendorName || '').toLowerCase();
  const has = function (text, list) { return list.some(function (k) { return text.indexOf(k.toLowerCase()) !== -1; }); };
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

function handleItemManualAdd(body) {
  const vendorName = String(body.vendorName || '').trim();
  const name = String(body.name || '').trim();
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
      if (!/^[A-Z]{2,4}$/.test(prefixInput)) throw new Error('코드 접두어는 영문 2~4자로 입력해주세요.');
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
    saveLastUsedByPrefix(prefix, startNumber);
    const ecountItemResult = ecountSyncItem(row);

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
