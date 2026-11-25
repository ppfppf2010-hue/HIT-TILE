/**
 * ===== 가창 재고 (가창 창고: 반품 회수 자재 · 남은 자재) — 2026-11-25 =====
 * 주문 처리 3단계 「재고 확인 — 가창 반품 재고 먼저」를 클라우드가 웹앱으로 바로 보게 한다.
 * 시트 탭 「가창재고」(현재 수량)와 「가창재고기록」(바뀐 이력 · 이유)은 처음 부를 때 자동 생성된다.
 *
 * action
 * - stock_list   { q?, includeZero? }  → 재고 목록(기본: 수량 0인 줄은 빼고). q는 품목코드 · 품목명 · 규격 · 출처 · 메모에서 찾기
 * - stock_adjust { items: [{ code?, name, spec?, qty, unit?, source?, memo?, inDate?, reason? }], reason?, dryRun? }
 *     qty = 늘리거나(+) 줄일(−) 수량. 이유(reason)는 줄마다 또는 맨 위에 한 번 — 없으면 멈춤.
 *     같은 품목 찾기: 품목코드가 있으면 코드로, 없으면 품목명 + 규격(띄어쓰기 · 대소문자 · ×/* 무시)으로.
 *     없는 품목을 −하면 멈춤. 모자라면 줄을 지우지 않고 수량 0 + 응답에 short(모자란 수량) 표시.
 *     dryRun: true면 시트는 안 바꾸고 바뀔 내용(전 → 후)만 돌려준다. 한 줄이라도 틀리면 아무것도 저장하지 않는다.
 * 웹앱 열쇠 검사는 doPost(Code.js)가 action 분기 전에 한다(AppKey.js).
 */

const STOCK_SHEET = '가창재고';
const STOCK_LOG_SHEET = '가창재고기록';
const STOCK_HEADERS = ['품목코드', '품목명', '규격', '수량', '단위', '들어온 날', '출처', '메모', '최근 수정'];
const STOCK_LOG_HEADERS = ['시각', '품목코드', '품목명', '규격', '바뀐 수량', '전', '후', '이유', '출처'];

function stockNow_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function stockText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim();
}

// 순수 함수(시험용): 같은 품목인지 비교할 열쇠. 300×600 · 300*600 · 300X600을 같게 본다.
function stockNorm_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[×x*]/g, 'x').replace(/\s+/g, '');
}

function stockMatchKey_(code, name, spec) {
  const c = String(code == null ? '' : code).trim();
  if (c) return 'C:' + c.toUpperCase();
  return 'N:' + stockNorm_(name) + '|' + stockNorm_(spec);
}

// 탭이 없으면 만든다. 수량 칸만 숫자, 나머지는 글자 형식(날짜 · 코드 자동 변환 방지).
function stockSheetGet_(name, headers) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
    if (name === STOCK_SHEET) sheet.getRange(2, 4, sheet.getMaxRows() - 1, 1).setNumberFormat('0.##');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function stockReadAll_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, STOCK_HEADERS.length).getValues();
  const rows = [];
  values.forEach(function (r, i) {
    const name = stockText_(r[1]);
    const code = stockText_(r[0]);
    if (!name && !code) return;
    rows.push({
      row: i + 2, code: code, name: name, spec: stockText_(r[2]), qty: Number(r[3]) || 0, unit: stockText_(r[4]),
      inDate: stockText_(r[5]), source: stockText_(r[6]), memo: stockText_(r[7]), updatedAt: stockText_(r[8])
    });
  });
  return rows;
}

function stockRowValues_(it) {
  return [it.code, it.name, it.spec, it.qty, it.unit, it.inDate, it.source, it.memo, it.updatedAt];
}

function stockPublic_(it) {
  const o = {};
  Object.keys(it).forEach(function (k) { if (k !== 'row') o[k] = it[k]; });
  return o;
}

function handleStockList(body) {
  const q = stockNorm_(body && body.q);
  const includeZero = !!(body && body.includeZero);
  const rows = stockReadAll_(stockSheetGet_(STOCK_SHEET, STOCK_HEADERS)).filter(function (it) {
    if (!includeZero && !(it.qty > 0)) return false;
    if (!q) return true;
    return stockNorm_([it.code, it.name, it.spec, it.source, it.memo].join(' ')).indexOf(q) >= 0;
  });
  return jsonOut({ ok: true, count: rows.length, items: rows.map(stockPublic_), now: stockNow_() });
}

// 순수 함수(시험용): 현재 줄 목록 + 요청 → 바뀔 내용. 틀리면 throw(아무것도 안 바꿈).
//   rows: stockReadAll_ 결과(복사본을 고쳐서 돌려줌), list: 요청 items, topReason: 맨 위 reason, today: 'yyyy-MM-dd'
function stockPlan_(rows, list, topReason, today) {
  const byKey = {};
  const work = rows.map(function (r) { const c = {}; Object.keys(r).forEach(function (k) { c[k] = r[k]; }); return c; });
  work.forEach(function (it) {
    byKey[stockMatchKey_(it.code, it.name, it.spec)] = it;
    if (it.code) byKey[stockMatchKey_('', it.name, it.spec)] = byKey[stockMatchKey_('', it.name, it.spec)] || it;
  });
  const changes = [];
  list.forEach(function (src, i) {
    const n = i + 1;
    if (!src || typeof src !== 'object') throw new Error(n + '번째 줄이 비었어요.');
    const qty = Number(src.qty);
    if (!isFinite(qty) || qty === 0) throw new Error(n + '번째 줄: 바꿀 수량(qty, + 또는 −)이 없어요.');
    const reason = String(src.reason || topReason || '').trim();
    if (!reason) throw new Error(n + '번째 줄: 이유(reason)가 없어요. 예: 「11/25 뉴타운 은성빌라 회수」 · 「11/26 예담 출고」');
    const code = String(src.code || '').trim();
    const name = String(src.name || '').trim();
    const spec = String(src.spec || '').trim();
    if (!code && !name) throw new Error(n + '번째 줄: 품목코드나 품목명이 없어요.');
    let it = byKey[stockMatchKey_(code, name, spec)];
    if (!it && code && name) it = byKey[stockMatchKey_('', name, spec)];
    const created = !it;
    if (!it) {
      if (qty < 0) throw new Error(n + '번째 줄: 가창 재고에 없는 품목은 뺄 수 없어요: ' + (name || code) + (spec ? ' ' + spec : ''));
      it = { row: 0, code: code, name: name || code, spec: spec, qty: 0, unit: String(src.unit || '').trim(),
        inDate: String(src.inDate || today), source: '', memo: '', updatedAt: '' };
      work.push(it);
      byKey[stockMatchKey_(code, it.name, spec)] = it;
      if (code) byKey[stockMatchKey_('', it.name, spec)] = it;
    }
    const before = it.qty;
    let after = before + qty;
    let short = 0;
    if (after < 0) { short = -after; after = 0; }   // 줄은 지우지 않고 0으로 둔다
    it.qty = after;
    if (code && !it.code) it.code = code;
    if (src.unit && !it.unit) it.unit = String(src.unit).trim();
    const source = String(src.source || '').trim();
    if (qty > 0 && source && it.source.indexOf(source) < 0) it.source = it.source ? it.source + ' / ' + source : source;
    if (qty > 0 && before <= 0 && !created) it.inDate = String(src.inDate || today);   // 다 썼다가 다시 들어온 날
    if (src.memo != null && String(src.memo).trim()) it.memo = String(src.memo).trim();
    changes.push({ code: it.code, name: it.name, spec: it.spec, unit: it.unit, delta: qty, before: before, after: after,
      short: short, created: created, reason: reason, source: source, item: it });
  });
  return { rows: work, changes: changes };
}

function handleStockAdjust(body) {
  const list = Array.isArray(body.items) ? body.items : (body.item ? [body.item] : []);
  if (!list.length) throw new Error('바꿀 품목(items)이 없어요.');
  const dryRun = !!body.dryRun;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('다른 저장이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    const sheet = stockSheetGet_(STOCK_SHEET, STOCK_HEADERS);
    const now = stockNow_();
    const plan = stockPlan_(stockReadAll_(sheet), list, body.reason, now.slice(0, 10));
    const out = plan.changes.map(function (c) {
      return { code: c.code, name: c.name, spec: c.spec, unit: c.unit, delta: c.delta, before: c.before, after: c.after,
        short: c.short, created: c.created, reason: c.reason };
    });
    if (dryRun) return jsonOut({ ok: true, dryRun: true, changes: out });

    const logSheet = stockSheetGet_(STOCK_LOG_SHEET, STOCK_LOG_HEADERS);
    const touched = [];
    plan.changes.forEach(function (c) { if (touched.indexOf(c.item) < 0) touched.push(c.item); });
    touched.forEach(function (it) {
      it.updatedAt = now;
      if (!it.row) {
        it.row = sheet.getLastRow() + 1;
        sheet.getRange(it.row, 1, 1, STOCK_HEADERS.length).setNumberFormat('@');
        sheet.getRange(it.row, 4).setNumberFormat('0.##');
      }
      sheet.getRange(it.row, 1, 1, STOCK_HEADERS.length).setValues([stockRowValues_(it)]);
    });
    const logRows = plan.changes.map(function (c) {
      return [now, c.code, c.name, c.spec, String(c.delta), String(c.before), String(c.after) + (c.short ? ' (모자람 ' + c.short + ')' : ''),
        c.reason, c.source];
    });
    const lr = logSheet.getLastRow() + 1;
    logSheet.getRange(lr, 1, logRows.length, STOCK_LOG_HEADERS.length).setNumberFormat('@').setValues(logRows);
    return jsonOut({ ok: true, saved: out.length, changes: out });
  } finally {
    lock.releaseLock();
  }
}
