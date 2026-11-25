/**
 * ===== AI 사무실 (업무 사이트 /office/) — 2026-11-25 =====
 * 직원(클라우드 세션 · .claude/agents)이 일을 시작 · 끝낼 때 한 줄을 시트 「활동기록」 탭에 남기고,
 * 화면이 직원별 가장 최근 기록을 읽어 「일하는 중 / 방금 끝냄 / 대기」를 보여 준다.
 *
 * action
 * - office_log_add    { staff, state, text }  → 한 줄 남기기(시각은 서버가 한국 시간으로)
 * - office_log_recent { limit? }              → 직원별 가장 최근 기록 + 최근 N줄 + 오늘 확정한 전표 수
 *
 * 공개 화면에 그대로 나오는 글이다. 거래처 이름 · 금액 · 주소 · 비번은 쓰지 않는다(일의 종류만).
 * 서버도 한 번 더 막는다: 줄바꿈 제거 · 40자 제한 · 숫자가 4자리 넘게 이어진 곳(금액 · 전화 · 비번 모양) 가리기 ·
 * 시트(판매거래처 · 거래처코드관리)에 있는 거래처 이름 가리기. 완벽하지 않다(시트에 없는 이름 · 주소 글자는 못 가린다).
 *
 * 오늘 확정한 전표 수: 판매입력 · 구매입력 시트에는 「확정한 시각」 칸이 없어 시트로는 셀 수 없다.
 * 그래서 doPost가 sale_confirm · purchase_confirm이 성공할 때마다 스크립트 속성 OFFICE_SLIP_COUNT에 날짜별로 1씩 더한다.
 * 세는 것은 「업무 사이트 · 클라우드가 확정한 횟수」뿐이다(이카운트 화면에서 직접 넣은 전표는 안 들어간다).
 */

const OFFICE_LOG_SHEET = '활동기록';
const OFFICE_LOG_HEADERS = ['시각', '직원', '상태', '내용'];
const OFFICE_STAFF_IDS = ['cloud', 'sales', 'item', 'delivery', 'accounting', 'consult', 'system', 'strategy'];
const OFFICE_STATES = ['시작', '끝', '대기'];
const OFFICE_TEXT_MAX = 40;        // 한 줄 길이 제한(글자 수)
const OFFICE_LOG_KEEP = 500;       // 시트에 남길 줄 수
const OFFICE_LOG_TRIM_AT = 550;    // 이 줄 수를 넘으면 OFFICE_LOG_KEEP까지 줄인다(매번 지우지 않게 여유)
const OFFICE_RECENT_DEFAULT = 40;
const OFFICE_RECENT_MAX = 100;
const OFFICE_MASK = '○○';
const OFFICE_SLIP_PROP = 'OFFICE_SLIP_COUNT';   // {"date":"yyyy-MM-dd","sale":n,"purchase":n}
const OFFICE_SLIP_SINCE_PROP = 'OFFICE_SLIP_SINCE'; // 세기 시작한 시각(yyyy-MM-dd HH:mm:ss) — 그날은 중간부터라 화면이 숫자를 안 보여 준다

function officeNow_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function officeText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  return String(v == null ? '' : v);
}

// 순수 함수(시험용): 한 줄로 만들고, 거래처 이름 · 긴 숫자를 가리고, 길이를 자른다.
//   names: 가릴 이름 목록(거래처명). 2글자 미만은 무시(아무 글자나 가려지지 않게).
function officeCleanText_(raw, names) {
  let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
  s = s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ');
  const list = (names || []).map(function (n) { return String(n == null ? '' : n).trim(); })
    .filter(function (n) { return n.length >= 2; })
    .sort(function (a, b) { return b.length - a.length; });
  list.forEach(function (n) {
    s = s.split(n).join(OFFICE_MASK);
    const tight = n.replace(/\s+/g, '');
    if (tight.length >= 2 && tight !== n) s = s.split(tight).join(OFFICE_MASK);
  });
  // 숫자가 4자리 이상 이어진 곳(사이의 쉼표 · 점 · 하이픈 · 공백 포함): 금액 · 전화번호 · 비번 · 사업자번호 모양
  s = s.replace(/\d[\d,.\-\s]*\d/g, function (m) {
    return m.replace(/\D/g, '').length >= 4 ? OFFICE_MASK : m;
  });
  // 「13만」 「250만원」 「3천원」처럼 짧은 금액 모양
  s = s.replace(/\d+\s*(억|천만|백만|만|천)\s*원?/g, OFFICE_MASK).replace(/\d+\s*원/g, OFFICE_MASK);
  s = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length > OFFICE_TEXT_MAX) s = chars.slice(0, OFFICE_TEXT_MAX - 1).join('') + '…';
  return s;
}

// 탭이 없으면 만든다. 모든 칸을 글자 형식으로 둬서 시각이 자동 변환되지 않게 한다.
function officeLogSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(OFFICE_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(OFFICE_LOG_SHEET);
    sheet.getRange(1, 1, 1, OFFICE_LOG_HEADERS.length).setValues([OFFICE_LOG_HEADERS]).setFontWeight('bold');
    sheet.getRange(1, 1, sheet.getMaxRows(), OFFICE_LOG_HEADERS.length).setNumberFormat('@');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 가릴 거래처 이름: 판매거래처 · 거래처코드관리 시트의 첫 칸. 못 읽어도 기록은 남긴다(다른 가리기는 그대로).
function officeVendorNames_() {
  const names = [];
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    [SALE_VENDOR_SHEET, VENDOR_SHEET].forEach(function (name) {
      const sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() < 2) return;
      sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
        const n = String(r[0] == null ? '' : r[0]).trim();
        if (n) names.push(n);
      });
    });
  } catch (e) { /* 이름 목록 없이 진행 */ }
  return names;
}

function handleOfficeLogAdd(body) {
  const staff = String((body && body.staff) || '').trim();
  if (OFFICE_STAFF_IDS.indexOf(staff) < 0) {
    throw new Error('직원(staff)은 ' + OFFICE_STAFF_IDS.join(' · ') + ' 중 하나로 써주세요: ' + staff);
  }
  const state = String((body && body.state) || '').trim();
  if (OFFICE_STATES.indexOf(state) < 0) {
    throw new Error('상태(state)는 ' + OFFICE_STATES.join(' · ') + ' 중 하나로 써주세요: ' + state);
  }
  const text = officeCleanText_(body.text, officeVendorNames_());
  if (!text && state === '시작') throw new Error('내용(text)이 비어 있어요. 일의 종류를 한 줄로 써주세요.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('다른 저장이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    const sheet = officeLogSheet_();
    const at = officeNow_();
    const r = sheet.getLastRow() + 1;
    sheet.getRange(r, 1, 1, OFFICE_LOG_HEADERS.length).setNumberFormat('@').setValues([[at, staff, state, text]]);
    const dataRows = r - 1;
    let trimmed = 0;
    if (dataRows > OFFICE_LOG_TRIM_AT) {
      trimmed = dataRows - OFFICE_LOG_KEEP;
      sheet.deleteRows(2, trimmed);   // 오래된 줄(위쪽)부터
    }
    return jsonOut({ ok: true, saved: { at: at, staff: staff, state: state, text: text }, trimmed: trimmed });
  } finally {
    lock.releaseLock();
  }
}

function handleOfficeLogRecent(body) {
  let limit = Number(body && body.limit) || OFFICE_RECENT_DEFAULT;
  limit = Math.max(1, Math.min(OFFICE_RECENT_MAX, Math.floor(limit)));
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(OFFICE_LOG_SHEET);   // 읽기는 탭을 만들지 않는다
  const rows = [];
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, OFFICE_LOG_HEADERS.length).getValues().forEach(function (r) {
      const staff = officeText_(r[1]).trim();
      const state = officeText_(r[2]).trim();
      if (OFFICE_STAFF_IDS.indexOf(staff) < 0 || OFFICE_STATES.indexOf(state) < 0) return;   // 손으로 넣은 엉뚱한 줄은 건너뜀
      rows.push({ at: officeText_(r[0]).trim(), staff: staff, state: state, text: officeText_(r[3]) });
    });
  }
  const latest = {};
  rows.forEach(function (it) { latest[it.staff] = { at: it.at, state: it.state, text: it.text }; });   // 아래 줄이 더 최근
  return jsonOut({
    ok: true, now: officeNow_(), staffIds: OFFICE_STAFF_IDS,
    latest: latest, recent: rows.slice(-limit).reverse(), slips: officeSlipToday_()
  });
}

// ---- 오늘 확정한 전표 수 ----
// 순수 함수(시험용): 저장된 값(JSON 글자)에 kind('sale'|'purchase')를 1 더한 새 값. 날짜가 바뀌었으면 0부터.
function officeSlipBump_(stored, today, kind) {
  let cur = null;
  try { cur = JSON.parse(stored || ''); } catch (e) { cur = null; }
  if (!cur || typeof cur !== 'object' || cur.date !== today) cur = { date: today, sale: 0, purchase: 0 };
  const out = { date: today, sale: Number(cur.sale) || 0, purchase: Number(cur.purchase) || 0 };
  if (kind === 'sale' || kind === 'purchase') out[kind] += 1;
  return out;
}

// doPost가 sale_confirm · purchase_confirm 결과를 이 함수로 감싼다. 처리 함수가 오류 없이 끝났을 때만 여기까지 온다
// (실패는 throw라서 안 온다). 세는 데 실패해도 확정 결과는 그대로 돌려준다.
function officeSlipCounted_(kind, output) {
  try {
    // 확정이 실패 응답(ok:false)으로 끝났으면 세지 않는다.
    try { const o = JSON.parse(output.getContent()); if (o && o.ok === false) return output; } catch (e2) { /* 읽을 수 없으면 그대로 센다 */ }
    const lock = LockService.getScriptLock();
    if (lock.tryLock(5000)) {
      try {
        const props = PropertiesService.getScriptProperties();
        const now = officeNow_();
        if (!props.getProperty(OFFICE_SLIP_SINCE_PROP)) props.setProperty(OFFICE_SLIP_SINCE_PROP, now);
        const next = officeSlipBump_(props.getProperty(OFFICE_SLIP_PROP), now.slice(0, 10), kind);
        props.setProperty(OFFICE_SLIP_PROP, JSON.stringify(next));
      } finally {
        lock.releaseLock();
      }
    }
  } catch (e) { /* 숫자 세기는 덤이다 — 확정 흐름을 막지 않는다 */ }
  return output;
}

// 오늘 숫자. ready가 false면 화면은 「준비 중」으로 보여 준다(세기 시작한 날은 하루 중간부터라 틀린 숫자가 됨).
function officeSlipToday_() {
  const props = PropertiesService.getScriptProperties();
  const now = officeNow_();
  const today = now.slice(0, 10);
  let since = props.getProperty(OFFICE_SLIP_SINCE_PROP) || '';
  if (!since) {
    try { props.setProperty(OFFICE_SLIP_SINCE_PROP, now); } catch (e) { /* 다음에 다시 */ }
    since = now;
  }
  const cur = officeSlipBump_(props.getProperty(OFFICE_SLIP_PROP), today, '');
  return { date: today, sale: cur.sale, purchase: cur.purchase, since: since, ready: since.slice(0, 10) < today };
}
