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
 * - dryRun:true면 아무것도 저장하지 않고 "이 코드로 등록될 것"만 돌려준다.
 * - 코드 번호가 겹치지 않게 스크립트 락을 잡고 채번~저장을 한 번에 처리한다.
 */
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

    const sharedMax = getMaxLastUsedForPrefix(prefix);
    const startNumber = Math.max(vendorInfo ? vendorInfo.lastUsed : 0, sharedMax) + 1;
    const row = assignCodesAndPrices([{ name: name, spec: spec, unit: unit, price: price }], prefix, startNumber, storedVendorName)[0];
    // 직접 입력한 단가는 100원 단위로 반올림하지 않고 그대로 쓴다(서류 인식값만 반올림하는 기존 규칙).
    row.inPrice = Math.round(price);
    if (hasOutPrice) row.outPrice = Math.round(outPriceInput);

    if (dryRun) {
      return jsonOut({ ok: true, dryRun: true, code: row.code, willCreateVendor: !vendorInfo, vendorName: storedVendorName, row: row });
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
      inPrice: row.inPrice, outPrice: row.outPrice, vendorName: storedVendorName,
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
