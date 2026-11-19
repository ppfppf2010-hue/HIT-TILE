/**
 * ===== 거래처코드관리(매입처) 시트를 이카운트 기준으로 고치기 =====
 *
 * 대표님 방침(2026-11-19): 매입처 정보는 무조건 이카운트 기준, 불필요 자료는 삭제.
 * 이카운트 거래처 엑셀(hittile-inbox 자료/이카운트_거래처_261119.xlsx)과 대조한 결과를 클라우드 세션이 넘긴다.
 *
 * action: 'vendor_sheet_fix'
 * body: {
 *   dryRun: true|false            // 기본 true(미리보기). false일 때만 실제로 고친다
 *   deletes:  [{ name, prefix }]  // 거래처코드관리에서 지울 줄 (이름 + 접두어가 둘 다 같을 때만)
 *   renames:  [{ from, to }]      // 거래처명 바꾸기: 거래처코드관리 A열 + 품목등록마스터 M열(거래처명) + 교정사전(from -> to)
 *   codes:    [{ name, ecountCode, businessNo? }]  // E열(이카운트거래처코드) · D열(사업자번호). 글자로 저장(앞자리 0 유지)
 * }
 * 순서: deletes -> renames -> codes. 이름은 trim 후 정확히 같을 때만 고친다(비슷한 이름은 건드리지 않음).
 *
 * 왜 글자로 저장하나: E열이 숫자로 저장돼 00122가 122로 바뀌어 있었다.
 * 구매전표(Purchase.js)는 E열을 그대로 CUST_CD로 보내므로 앞자리 0이 빠지면 이카운트가 거래처를 못 찾는다.
 */
function handleVendorSheetFix(body) {
  const dryRun = body.dryRun !== false;
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  const renames = Array.isArray(body.renames) ? body.renames : [];
  const codes = Array.isArray(body.codes) ? body.codes : [];

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 작업이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const vSheet = ss.getSheetByName(VENDOR_SHEET);
    const mSheet = ss.getSheetByName(MASTER_SHEET);
    if (!vSheet || !mSheet) throw new Error('거래처코드관리 또는 품목등록마스터 시트를 찾을 수 없습니다.');
    const changes = [];
    const notFound = [];
    const t = function (v) { return String(v == null ? '' : v).trim(); };

    // 1) 지우기 — 아래 줄부터 지워야 줄 번호가 안 밀린다
    let vData = vSheet.getDataRange().getValues();
    const delRows = [];
    deletes.forEach(function (d) {
      let hit = false;
      for (let i = 1; i < vData.length; i++) {
        if (t(vData[i][0]) === t(d.name) && t(vData[i][1]) === t(d.prefix)) {
          delRows.push(i + 1); hit = true;
          changes.push({ type: '삭제', sheet: VENDOR_SHEET, row: i + 1, before: vData[i].slice(0, 5) });
        }
      }
      if (!hit) notFound.push('삭제 대상 없음: ' + d.name + ' / ' + d.prefix);
    });
    if (!dryRun) delRows.sort(function (a, b) { return b - a; }).forEach(function (r) { vSheet.deleteRow(r); });

    // 2) 이름 바꾸기
    vData = vSheet.getDataRange().getValues();
    const mData = mSheet.getDataRange().getValues();
    const corrections = [];
    renames.forEach(function (rn) {
      const from = t(rn.from), to = t(rn.to);
      if (!from || !to) return;
      let vHit = 0, mHit = 0;
      for (let i = 1; i < vData.length; i++) {
        if (t(vData[i][0]) === from) {
          vHit++;
          changes.push({ type: '이름', sheet: VENDOR_SHEET, row: i + 1, before: from, after: to });
          if (!dryRun) vSheet.getRange(i + 1, 1).setValue(to);
          vData[i][0] = to;
        }
      }
      for (let i = 1; i < mData.length; i++) {
        if (t(mData[i][12]) === from) {
          mHit++;
          if (!dryRun) mSheet.getRange(i + 1, 13).setValue(to);
        }
      }
      if (mHit) changes.push({ type: '이름', sheet: MASTER_SHEET, count: mHit, before: from, after: to });
      if (!vHit && !mHit) notFound.push('이름 바꿀 대상 없음: ' + from);
      corrections.push([from, to]);
    });
    if (!dryRun && corrections.length) saveCorrections(corrections);

    // 3) 이카운트 코드 · 사업자번호 (글자로 저장)
    codes.forEach(function (c) {
      const name = t(c.name);
      let hit = false;
      for (let i = 1; i < vData.length; i++) {
        if (t(vData[i][0]) !== name) continue;
        hit = true;
        const beforeE = t(vData[i][4]), beforeD = t(vData[i][3]);
        const newE = t(c.ecountCode), newD = t(c.businessNo);
        if (newE && newE !== beforeE) {
          changes.push({ type: '이카운트코드', sheet: VENDOR_SHEET, row: i + 1, name: name, before: beforeE, after: newE });
          if (!dryRun) vSheet.getRange(i + 1, 5).setNumberFormat('@').setValue(newE);
        }
        if (newD && newD !== beforeD) {
          changes.push({ type: '사업자번호', sheet: VENDOR_SHEET, row: i + 1, name: name, before: beforeD, after: newD });
          if (!dryRun) vSheet.getRange(i + 1, 4).setNumberFormat('@').setValue(newD);
        }
      }
      if (!hit) notFound.push('코드 고칠 대상 없음: ' + name);
    });

    if (!dryRun) SpreadsheetApp.flush();
    return jsonOut({ ok: true, dryRun: dryRun, changes: changes, notFound: notFound });
  } finally {
    lock.releaseLock();
  }
}
