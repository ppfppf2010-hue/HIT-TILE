const BALANCE_SHEET = '거래처잔액';

// ---- GET 요청: 거래처 잔액(미수금) 목록 조회 ----
function doGet(e) {
try {
const action = (e && e.parameter && e.parameter.action) || '';
if (action === 'balances') return jsonOut(getBalances());
if (action === 'delivery_by_date') return jsonOut(getDeliveryByDate(e.parameter.date || ''));
if (action === 'delivery_month') return jsonOut(getDeliveryMonthCounts(e.parameter.month || ''));
if (action === 'vendor_names') return jsonOut(getVendorNames());
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