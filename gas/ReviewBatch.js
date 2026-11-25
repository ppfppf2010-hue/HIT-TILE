/**
 * 판매확인중 · 구매확인중 「여러 건 쌓기」 (대표님 11/24 업그레이드 1번)
 *
 * 예전: 새로 올릴 때마다 확인중 시트를 통째로 지우고(clear) 다시 써서, 확정 전에 다른 건을 올리면
 *       앞의 건이 덮어써졌다(11/23 세기 구매가 노블 구매에 덮임).
 * 지금: 올릴 때마다 「묶음번호」(Y열)를 붙여 아래에 추가만 한다. 확정은 묶음 하나만 골라서 하고,
 *       그 묶음 줄만 시트에서 빼고 나머지 묶음은 그대로 둔다.
 *
 * 확정 때 묶음 고르기: body.batchId가 있으면 그 묶음. 없으면 묶음이 1개일 때만 그것,
 *                     2개 이상이면 확정하지 않고 묶음 목록을 오류로 돌려준다(엉뚱한 건 확정 방지).
 * 묶음번호가 없는 옛 줄(이 기능 전에 올라간 것)은 「이전」 묶음 하나로 본다.
 * 확인중 묶음 보기: action "review_batches" (kind: "sale" | "purchase").
 *
 * 주의: AB열(28)은 품목코드 드롭다운 목록 칸이라 줄을 지우면(deleteRows) 그 목록까지 밀린다.
 *       그래서 묶음을 뺄 때는 A~Y열만 다시 써서 당긴다.
 */

const REVIEW_BATCH_COL = 25; // Y열
const REVIEW_BATCH_HEADER = '묶음번호(자동,수정금지)';
const REVIEW_LEGACY_BATCH = '이전';

function newReviewBatchId_(kind) {
  return kind + '-' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'MMdd-HHmmss') + '-' + Math.floor(10 + Math.random() * 90);
}

// A~Y열 기준 마지막 데이터 줄(AB열 드롭다운 목록 때문에 getLastRow는 믿지 않는다)
function reviewLastDataRow_(sheet) {
  const last = sheet.getLastRow();
  if (last < 1) return 0;
  const vals = sheet.getRange(1, 1, last, REVIEW_BATCH_COL).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i].some(function (v) { return String(v).trim() !== ''; })) return i + 1;
  }
  return 0;
}

function ensureReviewHeader_(sheet, headers) {
  if (reviewLastDataRow_(sheet) === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.getRange(1, REVIEW_BATCH_COL).setValue(REVIEW_BATCH_HEADER);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#eef4ff');
  try { sheet.hideColumns(REVIEW_BATCH_COL); } catch (e) { /* ignore */ }
}

// 확인중 시트 아래에 한 묶음을 추가한다. rowValues = 각 줄의 A열부터 값 배열.
function appendReviewBatch_(sheet, headers, rowValues, kind) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureReviewHeader_(sheet, headers);
    const batchId = newReviewBatchId_(kind);
    const startRow = reviewLastDataRow_(sheet) + 1;
    if (rowValues.length) {
      const values = rowValues.map(function (v) {
        const a = v.slice(0, REVIEW_BATCH_COL - 1);
        while (a.length < REVIEW_BATCH_COL - 1) a.push('');
        a.push(batchId);
        return a;
      });
      sheet.getRange(startRow, 1, values.length, REVIEW_BATCH_COL).setValues(values);
    }
    SpreadsheetApp.flush();
    return { batchId: batchId, startRow: startRow, endRow: startRow + rowValues.length - 1 };
  } finally {
    lock.releaseLock();
  }
}

// 확인중 시트의 묶음 목록(올린 순서). 품목명(K열)이 빈 줄은 뺀다(예전 확정과 같은 기준).
function listReviewBatches_(sheet) {
  const last = reviewLastDataRow_(sheet);
  if (last <= 1) return [];
  const vals = sheet.getRange(2, 1, last - 1, REVIEW_BATCH_COL).getValues();
  const order = [], map = {};
  vals.forEach(function (r, i) {
    if (String(r[10]).trim() === '') return;
    const id = String(r[REVIEW_BATCH_COL - 1] || '').trim() || REVIEW_LEGACY_BATCH;
    if (!map[id]) {
      map[id] = { batchId: id, vendorName: String(r[3] || '').trim(), site: String(r[20] || '').trim(), rows: [], rowNums: [] };
      order.push(id);
    }
    map[id].rows.push(r);
    map[id].rowNums.push(i + 2);
  });
  return order.map(function (id) { return map[id]; });
}

function describeReviewBatches_(batches) {
  return batches.map(function (b) {
    return b.batchId + ' (' + (b.vendorName || '거래처?') + (b.site ? ' · ' + b.site : '') + ' · ' + b.rows.length + '줄)';
  }).join(', ');
}

// 확정할 묶음 하나를 고른다. 못 고르면 확정하지 않고 오류.
function pickReviewBatch_(sheet, batchId, sheetLabel) {
  const batches = listReviewBatches_(sheet);
  if (!batches.length) throw new Error(sheetLabel + ' 시트에 저장할 품목이 없습니다. (다 지우신 건 아닌지 확인해주세요)');
  const want = String(batchId || '').trim();
  if (want) {
    const found = batches.filter(function (b) { return b.batchId === want; })[0];
    if (!found) throw new Error(sheetLabel + ' 시트에 묶음 ' + want + '이(가) 없어요(이미 확정됐을 수 있음). 지금 있는 묶음: ' + describeReviewBatches_(batches));
    return found;
  }
  if (batches.length === 1) return batches[0];
  throw new Error(sheetLabel + ' 시트에 확정 전 묶음이 ' + batches.length + '개 있어 어느 것을 확정할지 몰라 멈췄어요. batchId를 지정해주세요: ' + describeReviewBatches_(batches));
}

// 확정한 묶음 줄만 빼고 나머지를 위로 당겨 다시 쓴다(A~Y열만 — AB열 드롭다운 목록은 건드리지 않음).
function removeReviewBatch_(sheet, batch) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const last = reviewLastDataRow_(sheet);
    if (last <= 1) return;
    const range = sheet.getRange(2, 1, last - 1, REVIEW_BATCH_COL);
    const vals = range.getValues();
    const drop = {};
    batch.rowNums.forEach(function (n) { drop[n] = true; });
    // 같은 묶음의 빈 품목명 줄(사람이 품목명을 지운 줄)도 같이 뺀다
    const keep = vals.filter(function (r, i) {
      if (drop[i + 2]) return false;
      const id = String(r[REVIEW_BATCH_COL - 1] || '').trim() || REVIEW_LEGACY_BATCH;
      if (id === batch.batchId) return false;
      return r.some(function (v) { return String(v).trim() !== ''; });
    });
    range.clearContent();
    if (keep.length) sheet.getRange(2, 1, keep.length, REVIEW_BATCH_COL).setValues(keep);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ---- 확인중 묶음 보기 (클라우드 · 화면에서 확정 전에 무엇이 쌓였는지 확인) ----
function handleReviewBatches(body) {
  const kind = String((body && body.kind) || 'sale').trim();
  const name = kind === 'purchase' ? PURCHASE_REVIEW_SHEET : SALE_REVIEW_SHEET;
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  const batches = sheet ? listReviewBatches_(sheet) : [];
  return jsonOut({ ok: true, kind: kind, sheet: name, count: batches.length,
    batches: batches.map(function (b) {
      return { batchId: b.batchId, vendorName: b.vendorName, site: b.site, lines: b.rows.length,
        firstRow: b.rowNums[0], lastRow: b.rowNums[b.rowNums.length - 1] };
    }) });
}

// ================= 업그레이드 2번: 확정 결과를 그대로 보고 =================
// 중계서버는 이카운트가 줄 일부를 거절해도(FailCnt > 0) ok:true로 돌려준다 → 11/21 신당동처럼
// 「저장 완료」인데 이카운트에 없는 일이 생겼다. 그래서 이카운트 응답(SuccessCnt · FailCnt · SlipNos ·
// ResultDetails)을 직접 읽어 성공 여부를 다시 판단하고, 보고용 한 줄(report)을 만든다.
function ecountSlipReport_(r, lineCount) {
  if (!r) return { ok: false, successCnt: 0, failCnt: lineCount, slipNos: [], error: '이카운트 응답 없음' };
  if (!r.ok) return { ok: false, successCnt: 0, failCnt: lineCount, slipNos: [], error: r.error || '중계서버 호출 실패', raw: r };
  const ec = r.ecount || {};
  const d = ec.Data || {};
  const successCnt = d.SuccessCnt != null && d.SuccessCnt !== '' ? Number(d.SuccessCnt) : null;
  const failCnt = Number(d.FailCnt) || 0;
  let slipNos = d.SlipNos || d.SLIP_NOS || [];
  if (!Array.isArray(slipNos)) slipNos = String(slipNos).split(',').map(function (s) { return s.trim(); }).filter(String);
  const errs = [];
  (d.ResultDetails || []).forEach(function (x) {
    const bad = x && (x.IsSuccess === false || String(x.IsSuccess).toLowerCase() === 'false' || String(x.TotalError || '').trim());
    if (!bad) return;
    let msg = String(x.TotalError || '').trim();
    if (!msg && Array.isArray(x.Errors)) msg = x.Errors.map(function (e) { return (e.ColCd ? e.ColCd + ': ' : '') + (e.Message || ''); }).join(' / ');
    errs.push((x.Line != null ? x.Line + '줄 ' : '') + (msg || '거절'));
  });
  const statusBad = ec.Status && String(ec.Status) !== '200';
  const failed = failCnt > 0 || statusBad || errs.length > 0 || (successCnt !== null && successCnt < lineCount);
  let error = '';
  if (failed) {
    error = errs.join(' | ') || (statusBad ? '이카운트 응답 코드 ' + ec.Status : '') ||
      (successCnt !== null ? '성공 ' + successCnt + '/' + lineCount + '줄' : '이카운트가 일부를 거절함');
  }
  return { ok: !failed, successCnt: successCnt, failCnt: failCnt, slipNos: slipNos, error: String(error).slice(0, 500), ecount: ec };
}

// 확정 응답 맨 앞에 둘 보고 한 줄. kindLabel = '판매' | '매입'
function buildConfirmReport_(kindLabel, vendorName, site, lineCount, slip, vendorResult, itemResults) {
  const parts = [];
  if (slip.ok) {
    parts.push('✓ 이카운트 ' + kindLabel + '전표 저장 ' + (slip.successCnt !== null ? slip.successCnt : lineCount) + '/' + lineCount + '줄'
      + ' · 전표번호 ' + (slip.slipNos.length ? slip.slipNos.join(', ') : '(응답에 없음 — 이카운트에서 확인)'));
  } else {
    parts.push('✗ 이카운트 ' + kindLabel + '전표 실패'
      + (slip.successCnt !== null ? ' (성공 ' + slip.successCnt + '/' + lineCount + '줄)' : '')
      + ' — ' + (slip.error || '알 수 없는 오류')
      + ' · 구글 시트에는 이미 저장됨 → 그대로 다시 확정하지 말 것(시트 중복)');
  }
  parts.push('거래처 ' + vendorName + (site ? ' · 현장 ' + site : ''));
  if (vendorResult && vendorResult.ok === false) parts.push('⚠ 거래처 동기화 실패: ' + String(vendorResult.error || '').slice(0, 120));
  const badItems = (itemResults || []).filter(function (x) { return x && x.result && x.result.ok === false; });
  if (badItems.length) parts.push('⚠ 품목 동기화 실패 ' + badItems.length + '건: ' + badItems.map(function (x) { return x.code; }).join(', '));
  return parts.join(' · ');
}
