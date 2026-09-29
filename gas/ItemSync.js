/**
 * ===== 이카운트 <-> 품목등록마스터 양방향 연동 =====
 *
 * 1) 이카운트 -> 시트 (주기 대조, runItemSyncAll)
 *    이카운트에는 변경 알림(웹훅)이 없어서, 트리거로 주기적으로 이카운트 품목 목록
 *    (ecount-relay의 /list-items, GetBasicProductsList)을 가져와 품목등록마스터를 이카운트 기준으로 맞춘다.
 *    거래처 대조(syncVendorSheetWithEcount)와 같은 원칙 - 충돌 시 이카운트가 항상 이긴다.
 *    - 품목코드가 같은 행: 품목명/규격/단위/입고단가/입고VAT/출고단가/출고VAT를 이카운트 값으로 덮어쓴다.
 *      (이카운트 쪽 값이 비어있는 칸은 건드리지 않는다 - 응답 필드명이 예상과 달라 전부 빈 값으로
 *      오는 경우에 시트가 통째로 지워지는 사고를 막기 위함)
 *    - 이카운트에만 있는 품목: 새 행으로 추가한다. 거래처명은 코드 접두어로 거래처코드관리에서 찾아 채운다.
 *    - 시트에만 있는 품목: 지우지 않고 O열(이카운트대조상태)에 표시만 한다.
 *    - 새로 추가된 코드의 번호가 거래처코드관리의 마지막사용번호보다 크면 같이 올려서,
 *      다음 자동채번 때 코드가 겹치지 않게 한다.
 *
 * 2) 시트 -> 이카운트 (수정 즉시 반영, onMasterSheetEdit)
 *    품목등록마스터에서 사람이 직접 칸을 고치면 설치형 onEdit 트리거가 그 행을 이카운트로 다시 보낸다
 *    (/register-item, SaveBasicProduct). 스크립트가 쓴 값은 onEdit를 발생시키지 않으므로
 *    1)의 대조 결과가 다시 이카운트로 되돌아가는 무한루프는 생기지 않는다.
 *    반영에 실패하면 O열에 에러를 남긴다 - 이 경우 다음 주기 대조 때 이카운트 값으로 되돌아간다.
 *
 * 최초 1회: Apps Script 편집기에서 setupItemSyncTriggers()를 선택하고 [Run].
 * 즉시 실행: 웹에서 action="sync_items_now", 이카운트 원본 응답 확인은 action="debug_ecount_items".
 *
 * 품목등록마스터 열: A품목코드 B품목명 C규격구분 D규격 E입고단가 F입고단가VAT포함여부 G단위 H품목구분
 *                    I세트여부 J재고수량관리 K출고단가 L출고단가VAT포함여부 M거래처명 N등록일시 O이카운트대조상태
 */

const MASTER_COLS = 14;
const ITEM_STATUS_COL = 15; // O열
// onEdit 시 이카운트로 다시 보낼 가치가 있는 열(1-based): 품목명, 규격, 입고단가, 입고VAT, 단위, 출고단가, 출고VAT
const ITEM_PUSH_COLS = [2, 4, 5, 6, 7, 11, 12];
const ITEM_PUSH_MAX_ROWS = 30; // 한 번에 대량 붙여넣기 시 GAS 실행시간 초과 방지

function ecountFetchItems() {
  const result = ecountRelayCall('/list-items', {});
  if (!result.ok) throw new Error('이카운트 품목 목록 조회 실패: ' + (result.error || '알 수 없는 오류'));
  return result.items || [];
}

// 이카운트 VAT포함여부('Y'/'N', '1'/'0' 등)를 시트 표기(1/0)로 통일. 알 수 없으면 null.
function normalizeVatFlag(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^(1|Y|true)$/i.test(s)) return 1;
  if (/^(0|N|false)$/i.test(s)) return 0;
  return null;
}

function nowLabel() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM/dd HH:mm');
}

// 코드 접두어 -> 거래처명 (거래처코드관리 B열 기준, 같은 접두어가 여러 행이면 첫 행)
function buildPrefixVendorMap() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const data = ss.getSheetByName(VENDOR_SHEET).getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const prefix = String(data[i][1] || '').trim().toUpperCase();
    const name = String(data[i][0] || '').trim();
    if (prefix && name && !map[prefix]) map[prefix] = name;
  }
  return map;
}

function runItemSyncAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: '다른 품목 동기화가 실행 중입니다.' };
  try {
    const ecItems = ecountFetchItems();
    // 이카운트가 0건을 돌려주면 응답 파싱 문제일 가능성이 커서, 시트 전체를 "못 찾음"으로 표시하지 않고 중단한다.
    if (!ecItems.length) throw new Error('이카운트에서 품목을 0건 받았습니다. debug_ecount_items로 원본 응답을 확인해주세요.');

    const byCode = {};
    ecItems.forEach(function (p) { byCode[p.prodCd] = p; });

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(MASTER_SHEET);
    if (!sheet) throw new Error(MASTER_SHEET + ' 시트를 찾을 수 없습니다.');
    if (!String(sheet.getRange(1, ITEM_STATUS_COL).getValue() || '').trim()) {
      sheet.getRange(1, ITEM_STATUS_COL).setValue('이카운트대조상태');
    }

    const lastRow = sheet.getLastRow();
    const data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, ITEM_STATUS_COL).getValues() : [];
    const label = nowLabel();
    const seenCodes = {};
    let updated = 0, unchanged = 0, flagged = 0;

    data.forEach(function (row) {
      const code = String(row[0] || '').trim();
      if (!code) return;
      seenCodes[code] = true;
      const p = byCode[code];
      if (!p) {
        row[ITEM_STATUS_COL - 1] = '⚠ 이카운트에 없음 - 직접 확인 필요 (' + label + ')';
        flagged++;
        return;
      }

      const changes = [];
      function setStr(idx, value, fieldName) {
        const v = String(value || '').trim();
        if (v && v !== String(row[idx] || '').trim()) { row[idx] = v; changes.push(fieldName); }
      }
      function setNum(idx, value, fieldName) {
        if (value === null || value === undefined) return;
        if (Number(value) !== Number(row[idx])) { row[idx] = Number(value); changes.push(fieldName); }
      }
      setStr(1, p.prodDes, '품목명');
      setStr(3, p.spec, '규격');
      if (String(row[3] || '').trim() && !String(row[2] || '').trim()) row[2] = '사이즈';
      setStr(6, p.unit, '단위');
      setNum(4, p.inPrice, '입고단가');
      setNum(5, normalizeVatFlag(p.inPriceVat), '입고VAT');
      setNum(10, p.outPrice, '출고단가');
      setNum(11, normalizeVatFlag(p.outPriceVat), '출고VAT');

      if (changes.length) {
        row[ITEM_STATUS_COL - 1] = '✎ 이카운트 기준으로 수정: ' + changes.join(', ') + ' (' + label + ')';
        updated++;
      } else {
        row[ITEM_STATUS_COL - 1] = '✓ 이카운트 일치 (' + label + ')';
        unchanged++;
      }
    });

    // 기존 행은 한 번에 되써서(셀 단위 setValue 반복 대비) 실행시간을 줄인다.
    if (data.length) sheet.getRange(2, 1, data.length, ITEM_STATUS_COL).setValues(data);

    // 이카운트에만 있는 품목 추가
    const prefixVendor = buildPrefixVendorMap();
    const now = new Date();
    const newRows = [];
    ecItems.forEach(function (p) {
      if (seenCodes[p.prodCd]) return;
      seenCodes[p.prodCd] = true;
      const m = p.prodCd.match(/^([A-Za-z]+)\d+$/);
      const vendor = m ? (prefixVendor[m[1].toUpperCase()] || '') : '';
      const inVat = normalizeVatFlag(p.inPriceVat);
      const outVat = normalizeVatFlag(p.outPriceVat);
      newRows.push([
        p.prodCd, p.prodDes, p.spec ? '사이즈' : '', p.spec,
        p.inPrice != null ? p.inPrice : '', inVat != null ? inVat : 1, p.unit || 'EA',
        1, 1, 1,
        p.outPrice != null ? p.outPrice : '', outVat != null ? outVat : 1,
        vendor, now, '✓ 이카운트에서 신규 발견 (자동추가, ' + label + ')'
      ]);
    });
    if (newRows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, ITEM_STATUS_COL).setValues(newRows);
    }

    // 이카운트에서 직접 만든 코드(예: VG00050)가 마지막사용번호를 앞지르면 따라 올려서 자동채번 충돌을 막는다.
    const maxByPrefix = {};
    Object.keys(seenCodes).forEach(function (code) {
      const m = code.match(/^([A-Za-z]+)(\d+)$/);
      if (!m) return;
      const prefix = m[1].toUpperCase();
      const n = parseInt(m[2], 10);
      if (!(prefix in maxByPrefix) || n > maxByPrefix[prefix]) maxByPrefix[prefix] = n;
    });
    const bumpedPrefixes = [];
    Object.keys(maxByPrefix).forEach(function (prefix) {
      if (!prefixVendor[prefix]) return; // 거래처코드관리에 없는 접두어는 건드리지 않는다
      if (maxByPrefix[prefix] > getMaxLastUsedForPrefix(prefix)) {
        saveLastUsedByPrefix(prefix, maxByPrefix[prefix]);
        bumpedPrefixes.push(prefix + '=' + maxByPrefix[prefix]);
      }
    });

    const result = {
      ok: true, ecountItemCount: ecItems.length, updated: updated, unchanged: unchanged,
      flagged: flagged, added: newRows.length, bumpedPrefixes: bumpedPrefixes
    };
    Logger.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ---- 설치형 onEdit 트리거: 품목등록마스터를 사람이 직접 고치면 그 행을 이카운트로 반영 ----
function onMasterSheetEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== MASTER_SHEET) return;

  const firstCol = e.range.getColumn();
  const lastCol = firstCol + e.range.getNumColumns() - 1;
  const touchesPushCol = ITEM_PUSH_COLS.some(function (c) { return c >= firstCol && c <= lastCol; });
  if (!touchesPushCol) return;

  const firstRow = Math.max(2, e.range.getRow());
  const lastRow = Math.min(e.range.getRow() + e.range.getNumRows() - 1, firstRow + ITEM_PUSH_MAX_ROWS - 1);
  if (lastRow < firstRow) return;

  const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, MASTER_COLS).getValues();
  const label = nowLabel();
  const statuses = rows.map(function (r) {
    const code = String(r[0] || '').trim();
    if (!code || !String(r[1] || '').trim()) return [''];
    const res = ecountSyncItem({
      code: code, name: r[1], spec: r[3], unit: r[6],
      inPrice: r[4], inVat: r[5], outPrice: r[10], outVat: r[11]
    });
    return [res && res.ok
      ? '↑ 시트 수정 이카운트 반영 (' + label + ')'
      : '⚠ 이카운트 반영 실패: ' + ((res && res.error) || '알 수 없는 오류') + ' - 다음 대조 때 이카운트 값으로 되돌아갈 수 있음'];
  });
  sheet.getRange(firstRow, ITEM_STATUS_COL, statuses.length, 1).setValues(statuses);
}

// ---- 최초 1회 실행: 1시간마다 이카운트->시트 대조 + 시트 수정 시 이카운트 반영 트리거 등록 ----
// 이미 등록된 트리거는 중복 등록하지 않는다. 주기를 바꾸려면 everyHours(1) 부분만 고치면 된다
// (이카운트 조회 API 호출 제한이 있으므로 너무 짧게 잡지 말 것).
function setupItemSyncTriggers() {
  const handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  const messages = [];
  if (handlers.indexOf('runItemSyncAll') === -1) {
    ScriptApp.newTrigger('runItemSyncAll').timeBased().everyHours(1).create();
    messages.push('1시간마다 이카운트->품목등록마스터 대조 트리거 등록');
  }
  if (handlers.indexOf('onMasterSheetEdit') === -1) {
    ScriptApp.newTrigger('onMasterSheetEdit').forSpreadsheet(SPREADSHEET_ID).onEdit().create();
    messages.push('품목등록마스터 수정 시 이카운트 반영 트리거 등록');
  }
  const result = { ok: true, message: messages.length ? messages.join(' / ') : '이미 모두 등록되어 있습니다.' };
  Logger.log(result.message);
  return result;
}

// ---- 웹에서 즉시 대조 실행 ----
function handleSyncItemsNow() {
  return jsonOut({ ok: true, result: runItemSyncAll() });
}

// ---- 이카운트 품목 목록 API 원본 응답 확인용 (필드명이 예상과 다르면 ecount-relay의 /list-items 파싱을 맞춘다) ----
function handleDebugEcountItems() {
  const result = ecountRelayCall('/list-items', { debug: true });
  Logger.log(JSON.stringify(result, null, 2));
  return jsonOut(result);
}
