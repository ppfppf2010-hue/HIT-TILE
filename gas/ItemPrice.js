/**
 * ===== 품목 단가(입고 · 출고) 수정 — 웹앱 action item_price_update =====
 *
 * 왜 따로 만들었나:
 *   - 이카운트 OAPI에는 품목 「수정」 API가 없다. 품목 저장(SaveBasicProduct)은 「등록」 전용이라 이미 있는 코드를 보내면
 *     「품목코드(이미 품목등록에 존재하는 코드입니다.)」 오류만 나고 이카운트 단가는 안 바뀐다(Code.js ecountSyncItemsByCode 주석, 2026-11-20 확인).
 *     사람이 시트를 고칠 때 도는 onMasterSheetEdit(ItemSync.js)도 같은 저장 API를 부르므로, 이미 있는 품목은 실제로 이카운트가 안 바뀐다.
 *   - 그래서 1시간마다 도는 대조(runItemSyncAll)가 시트 단가를 이카운트의 옛 단가로 되돌렸다.
 *
 * 어떻게 하나:
 *   1) 품목등록마스터의 E(입고단가) · K(출고단가)를 고친다. O열에 「✎ 웹앱 단가 수정 …」(✎로 시작 = 이카운트에 있는 품목 표시 유지).
 *   2) 스크립트 속성 ITEM_PRICE_HOLD에 {코드: {inPrice?, outPrice?, at}}를 남긴다(「단가 고정」).
 *      runItemSyncAll은 고정된 칸을 이카운트 값으로 덮지 않는다. 이카운트 단가가 고정값과 같아지면(누가 이카운트 화면에서 고치면) 고정을 스스로 푼다.
 *   3) 이카운트에는 보내지 않는다 — 실패할 게 뻔한 저장을 보내면 이카운트 시간당 연속 오류 30건 한도만 깎인다.
 *   판매등록 · 단가조회는 시트 단가(K열)를 쓰고, 판매 전표는 단가를 직접 실어 보내므로 웹앱 · 클라우드로 넣는 전표는 새 단가로 들어간다.
 *   이카운트 화면에서 직접 전표를 넣을 때 뜨는 기본 단가만 옛 값으로 남는다.
 *
 * body: { items: [{ code, inPrice?, outPrice?, release? }], dryRun(기본 true) }
 *   - inPrice · outPrice: 0 이상 숫자. 둘 다 없으면(release 아니면) 오류. 한 줄이라도 틀리면 아무것도 저장 안 함.
 *   - release: true → 시트는 그대로 두고 단가 고정만 푼다(다음 대조 때 이카운트 값으로 돌아감).
 * 응답: { ok, dryRun, changes: [{ code, name, spec, row, before:{inPrice,outPrice}, after:{…}, held, released }], ecountUpdated:false, note }
 * 고정 목록만 보기: action item_price_holds → { holds }
 */

const ITEM_PRICE_HOLD_PROP = 'ITEM_PRICE_HOLD';

function itemPriceHoldRead_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(ITEM_PRICE_HOLD_PROP);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

function itemPriceHoldWrite_(hold) {
  const props = PropertiesService.getScriptProperties();
  if (Object.keys(hold).length) props.setProperty(ITEM_PRICE_HOLD_PROP, JSON.stringify(hold));
  else props.deleteProperty(ITEM_PRICE_HOLD_PROP);
}

// 순수 함수(시험용): 단가 입력값 → 숫자 또는 undefined(안 바꿈). 틀리면 오류 문구.
function itemPriceParse_(v, label) {
  if (v === undefined || v === null || v === '') return { value: undefined };
  const n = Number(String(v).replace(/[,\s원]/g, ''));
  if (!isFinite(n) || n < 0) return { error: label + '가 숫자가 아니에요: ' + v };
  return { value: n };
}

// 순수 함수(시험용): 시트 행(2차원 배열, 머리줄 포함)과 요청 items → { changes, errors }
// 코드는 앞자리 0을 뗀 값으로도 찾는다(ItemSync.js normalizeNumericCode와 같은 기준).
function itemPricePlan_(data, items, hold) {
  const changes = [], errors = [];
  const seen = {};
  items.forEach(function (it, i) {
    const code = String((it && it.code) || '').trim();
    const where = (i + 1) + '번째 줄';
    if (!code) { errors.push(where + ': 품목코드(code)가 없어요.'); return; }
    if (seen[code]) { errors.push(where + ': 같은 코드가 두 번 있어요(' + code + ').'); return; }
    seen[code] = true;
    let idx = -1;
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0]).trim() === code) { idx = r; break; }
    }
    if (idx < 0 && /^\d+$/.test(code)) {
      const norm = normalizeNumericCode(code);
      for (let r = 1; r < data.length; r++) {
        if (normalizeNumericCode(data[r][0]) === norm) { idx = r; break; }
      }
    }
    if (idx < 0) { errors.push(where + ': 품목등록마스터에 없는 코드예요(' + code + ').'); return; }
    const row = data[idx];
    const before = { inPrice: row[4] === '' ? '' : Number(row[4]), outPrice: row[10] === '' ? '' : Number(row[10]) };
    if (it.release === true) {
      changes.push({ code: code, name: row[1], spec: row[3], row: idx + 1, before: before, after: before,
        held: false, released: !!(hold && hold[code]), fields: [] });
      return;
    }
    const pin = itemPriceParse_(it.inPrice, '입고단가');
    const pout = itemPriceParse_(it.outPrice, '출고단가');
    if (pin.error || pout.error) { errors.push(where + ': ' + (pin.error || pout.error)); return; }
    if (pin.value === undefined && pout.value === undefined) { errors.push(where + ': inPrice · outPrice 중 하나는 있어야 해요(' + code + ').'); return; }
    const after = {
      inPrice: pin.value !== undefined ? pin.value : before.inPrice,
      outPrice: pout.value !== undefined ? pout.value : before.outPrice
    };
    const fields = [];
    if (pin.value !== undefined) fields.push('inPrice');
    if (pout.value !== undefined) fields.push('outPrice');
    changes.push({ code: code, name: row[1], spec: row[3], row: idx + 1, before: before, after: after,
      held: true, released: false, fields: fields });
  });
  return { changes: changes, errors: errors };
}

// 순수 함수(시험용): 대조 때 한 칸을 이카운트 값으로 덮을지. hold: 고정 목록(고치면 그 자리에서 바뀜)
//   → 'sync'(평소대로 덮음) | 'keep'(고정 — 덮지 않음) | 'caught'(이카운트가 고정값과 같아짐 — 고정 풀고 평소대로)
function itemPriceHoldDecide_(hold, code, field, ecountValue) {
  const h = hold && hold[code];
  if (!h || h[field] === undefined || h[field] === null) return 'sync';
  if (ecountValue !== null && ecountValue !== undefined && ecountValue !== '' && Number(ecountValue) === Number(h[field])) {
    delete h[field];
    if (h.inPrice === undefined && h.outPrice === undefined) delete hold[code];
    return 'caught';
  }
  return 'keep';
}

function handleItemPriceUpdate(body) {
  const list = Array.isArray(body.items) ? body.items : (body.item ? [body.item] : []);
  if (!list.length) throw new Error('바꿀 품목(items)이 없어요.');
  const dryRun = body.dryRun !== false; // 기본은 미리보기
  const lock = LockService.getScriptLock(); // 1시간 대조(runItemSyncAll)와 같은 잠금 — 대조 중에는 기다린다
  if (!lock.tryLock(30000)) throw new Error('다른 품목 작업(대조 등)이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(MASTER_SHEET);
    if (!sheet) throw new Error(MASTER_SHEET + ' 시트를 찾을 수 없습니다.');
    const lastRow = sheet.getLastRow();
    const data = lastRow >= 1 ? sheet.getRange(1, 1, lastRow, ITEM_STATUS_COL).getValues() : [];
    const hold = itemPriceHoldRead_();
    const plan = itemPricePlan_(data, list, hold);
    if (plan.errors.length) return jsonOut({ ok: false, error: plan.errors.join(' / '), errors: plan.errors });
    const note = '이카운트 OAPI에 품목 수정 API가 없어 이카운트 품목 단가는 그대로예요. 시트 단가를 고정해서 1시간 대조가 되돌리지 않고, ' +
      '웹앱 · 클라우드 판매 전표는 새 단가로 들어갑니다(이카운트 화면에서 직접 넣는 전표의 기본 단가만 옛 값).';
    const out = plan.changes.map(function (c) {
      return { code: c.code, name: c.name, spec: c.spec, row: c.row, before: c.before, after: c.after, held: c.held, released: c.released };
    });
    if (dryRun) return jsonOut({ ok: true, dryRun: true, changes: out, ecountUpdated: false, note: note });

    const label = nowLabel();
    const at = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
    plan.changes.forEach(function (c) {
      if (c.released) { delete hold[c.code]; return; }
      if (!c.held) return;
      const h = hold[c.code] || {};
      const parts = [];
      if (c.fields.indexOf('inPrice') >= 0) {
        sheet.getRange(c.row, 5).setValue(c.after.inPrice);
        h.inPrice = c.after.inPrice;
        parts.push('입고 ' + c.before.inPrice + '→' + c.after.inPrice);
      }
      if (c.fields.indexOf('outPrice') >= 0) {
        sheet.getRange(c.row, 11).setValue(c.after.outPrice);
        h.outPrice = c.after.outPrice;
        parts.push('출고 ' + c.before.outPrice + '→' + c.after.outPrice);
      }
      h.at = at;
      hold[c.code] = h;
      sheet.getRange(c.row, ITEM_STATUS_COL).setValue('✎ 웹앱 단가 수정: ' + parts.join(', ') + ' · 이카운트 품목 단가는 그대로(단가 고정) (' + label + ')');
    });
    itemPriceHoldWrite_(hold);
    return jsonOut({ ok: true, dryRun: false, saved: out.length, changes: out, ecountUpdated: false, note: note });
  } finally {
    lock.releaseLock();
  }
}

function handleItemPriceHolds() {
  return jsonOut({ ok: true, holds: itemPriceHoldRead_() });
}
