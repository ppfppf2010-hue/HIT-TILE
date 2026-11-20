const BALANCE_SHEET = '거래처잔액';

// ---- GET 요청: 거래처 잔액(미수금) 목록 조회 ----
function doGet(e) {
try {
const action = (e && e.parameter && e.parameter.action) || '';
if (action === 'balances') return jsonOut(getBalances());
if (action === 'delivery_by_date') return jsonOut(getDeliveryByDate(e.parameter.date || ''));
if (action === 'delivery_month') return jsonOut(getDeliveryMonthCounts(e.parameter.month || ''));
if (action === 'calendar_schedule') return jsonOut(getCalendarSchedule(e.parameter.from || '', e.parameter.to || ''));
if (action === 'vendor_names') return jsonOut(getVendorNames());
if (action === 'delivery_vendor_contacts') return jsonOut(getDeliveryVendorContacts());
return jsonOut({ ok: false, error: '알 수 없는 요청입니다: ' + action });
} catch (err) {
return jsonOut({ ok: false, error: err.message });
}
}

function getBalances() {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const sheet = ss.getSheetByName(BALANCE_SHEET);
if (!sheet) return { ok: false, error: '거래처잔액 시트를 찾을 수 없습니다.' };
const data = sheet.getDataRange().getValues();
const rows = [];
for (let i = 1; i < data.length; i++) {
const name = String(data[i][0] || '').trim();
if (!name) continue;
const balance = Number(data[i][1]) || 0;
rows.push({ name: name, balance: balance });
}
return { ok: true, rows: rows, updatedAt: new Date().toISOString() };
}

// ---- 거래처코드관리 시트에서 등록된 거래처명 목록 (자동완성용) ----
function getVendorNames() {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const sheet = ss.getSheetByName(VENDOR_SHEET);
if (!sheet) return { ok: true, names: [] };
const data = sheet.getDataRange().getValues();
const names = [];
for (let i = 1; i < data.length; i++) {
const name = String(data[i][0] || '').trim();
if (name) names.push(name);
}
return { ok: true, names: names };
}

// ---- 거래처잔액 탭 최초 1회 세팅 (Run 버튼으로 직접 실행) ----
function setupBalanceSheet() {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
let sheet = ss.getSheetByName(BALANCE_SHEET);
if (!sheet) sheet = ss.insertSheet(BALANCE_SHEET);
sheet.getRange(1, 1, 1, 2).setValues([['거래처명', '미수금']]);
sheet.setFrozenRows(1);
}

// ---- POST 요청: 거래처잔액 전체 목록 저장(덮어쓰기) ----
function handleSaveBalances(body) {
const rows = body.rows;
if (!rows || !Array.isArray(rows)) throw new Error('rows 데이터가 없습니다.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
let sheet = ss.getSheetByName(BALANCE_SHEET);
if (!sheet) sheet = ss.insertSheet(BALANCE_SHEET);

const lastRow = sheet.getLastRow();
if (lastRow > 1) {
sheet.getRange(2, 1, lastRow - 1, 2).clearContent();
}

const clean = rows
.map(function (r) { var nm = String(r.name || '').trim(); var vi = findVendor(nm); if (vi) nm = vi.storedName; return [nm, Number(r.balance) || 0]; })
.filter(function (r) { return r[0]; });

if (clean.length > 0) {
sheet.getRange(2, 1, clean.length, 2).setValues(clean);
}

return jsonOut({ ok: true, count: clean.length, updatedAt: new Date().toISOString() });
}

// ---- 배송 · 반품 일정 조회 (읽기만, 11/20 — 카톡 담당이 크롬 화면 없이 「이번주 배송일정」에 바로 답하려고) ----
// GET ?action=calendar_schedule&from=2026-11-20&to=2026-11-30 → 「히트타일 배송일정」·「히트타일 반품일정」 일정
// 캘린더가 없으면 만들지 않고 빈 목록. 설명은 앞 300자만.
function getCalendarSchedule(fromStr, toStr) {
  const tz = 'Asia/Seoul';
  const parse = function (s, def) {
    const m = String(s || '').match(/(\d{4})-?(\d{1,2})-?(\d{1,2})/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : def;
  };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = parse(fromStr, today);
  let to = parse(toStr, new Date(from.getTime() + 14 * 86400000));
  if (to.getTime() - from.getTime() > 62 * 86400000) to = new Date(from.getTime() + 62 * 86400000); // 최대 두 달
  const end = new Date(to.getTime() + 86400000); // to 날짜 포함
  const out = [];
  ['히트타일 배송일정', '히트타일 반품일정'].forEach(function (name) {
    const cals = CalendarApp.getCalendarsByName(name);
    if (!cals || !cals.length) return;
    cals[0].getEvents(from, end).forEach(function (ev) {
      const s = ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
      out.push({
        calendar: name.replace('히트타일 ', ''),
        date: Utilities.formatDate(s, tz, 'yyyy-MM-dd'),
        weekday: ['일', '월', '화', '수', '목', '금', '토'][Number(Utilities.formatDate(s, tz, 'u')) % 7],
        allDay: ev.isAllDayEvent(),
        time: ev.isAllDayEvent() ? '' : Utilities.formatDate(s, tz, 'HH:mm'),
        title: ev.getTitle(),
        location: ev.getLocation(),
        description: String(ev.getDescription() || '').slice(0, 300)
      });
    });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.calendar < b.calendar ? -1 : 1); });
  return { ok: true, from: Utilities.formatDate(from, tz, 'yyyy-MM-dd'), to: Utilities.formatDate(to, tz, 'yyyy-MM-dd'), events: out };
}
