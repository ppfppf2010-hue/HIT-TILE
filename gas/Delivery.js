const ORDER_SHEET = '배송일정';
const ORDER_ITEM_SHEET = '배송품목';
const BANK_INFO = '국민은행 676301-04-294382 (예금주 이용광)';

// ---- 배송일정/배송품목 탭 최초 1회 세팅 (Run 버튼으로 직접 실행) ----
function setupDeliverySheets() {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

let orderSheet = ss.getSheetByName(ORDER_SHEET);
if (!orderSheet) orderSheet = ss.insertSheet(ORDER_SHEET);
const orderHeader = ['주문ID', '날짜', '업체명', '연락처', '현장명', '전표등록여부', '합계금액', '미수금전잔', '미수금후잔', '입금상태', '입금메모', '배송상태', '반품여부', '등록시각'];
orderSheet.getRange(1, 1, 1, orderHeader.length).setValues([orderHeader]);
orderSheet.setFrozenRows(1);

let itemSheet = ss.getSheetByName(ORDER_ITEM_SHEET);
if (!itemSheet) itemSheet = ss.insertSheet(ORDER_ITEM_SHEET);
const itemHeader = ['주문ID', '품목명', '규격', '수량', '단가', '공급가액', '부가세', '배송여부', '반품수량', '배송수량'];
itemSheet.getRange(1, 1, 1, itemHeader.length).setValues([itemHeader]);
itemSheet.setFrozenRows(1);

return { ok: true, message: '배송일정/배송품목 탭 세팅 완료' };
}


// ---- 공통: 배송일정 시트에서 특정 주문ID의 행 번호 찾기 ----
function findOrderRowIndex(sheet, orderId) {
const data = sheet.getDataRange().getValues();
for (let i = 1; i < data.length; i++) {
if (String(data[i][0]) === String(orderId)) return i + 1;
}
return -1;
}

// ---- 날짜 비교용 정규화: 시트에서 Date 객체로 자동 변환된 값과 'yyyy-MM-dd' 문자열을 동일 포맷으로 맞춤 ----
function toDateStr(val) {
if (val instanceof Date) return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
return String(val || '').trim();
}

function orderRowToObj(row) {
return {
orderId: row[0], date: toDateStr(row[1]), vendorName: row[2], phone: row[3], siteName: row[4],
invoiceRegistered: row[5] === 'Y', totalAmount: Number(row[6]) || 0,
balanceBefore: Number(row[7]) || 0, balanceAfter: Number(row[8]) || 0,
paymentStatus: row[9] || '', paymentMemo: row[10] || '',
deliveryStatus: row[11] || '대기', returned: row[12] === 'Y', createdAt: row[13],
returnScheduleDate: toDateStr(row[14])
};
}

// ---- 반품일정 열이 아직 없으면 헤더 채워둠 ----
function ensureReturnScheduleHeader(orderSheet) {
if (orderSheet.getRange(1, 15).getValue() !== '반품일정') {
orderSheet.getRange(1, 15).setValue('반품일정');
}
}

// ---- 특정 날짜의 주문 목록 + 각 주문의 품목 조회 ----
function getDeliveryByDate(dateStr) {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const itemSheet = ss.getSheetByName(ORDER_ITEM_SHEET);
if (!orderSheet || !itemSheet) return { ok: false, error: '배송 시트를 찾을 수 없습니다.' };

const orderData = orderSheet.getDataRange().getValues();
const itemData = itemSheet.getDataRange().getValues();

const orders = [];
for (let i = 1; i < orderData.length; i++) {
const row = orderData[i];
if (toDateStr(row[1]) !== toDateStr(dateStr)) continue;
const order = orderRowToObj(row);
order.items = [];
for (let j = 1; j < itemData.length; j++) {
const ir = itemData[j];
if (String(ir[0]) === String(order.orderId)) {
order.items.push({
name: ir[1], spec: ir[2], qty: Number(ir[3]) || 0, price: Number(ir[4]) || 0,
supply: Number(ir[5]) || 0, vat: Number(ir[6]) || 0, deliveryStatus: ir[7] || '대기',
returnQty: Number(ir[8]) || 0,
deliveredQty: (ir[9] === '' || ir[9] === undefined || ir[9] === null) ? null : Number(ir[9])
});
}
}
orders.push(order);
}
return { ok: true, date: dateStr, orders: orders, bankInfo: BANK_INFO };
}

// ---- 특정 월의 날짜별 주문 건수 (달력 뱃지용) ----
function getDeliveryMonthCounts(monthStr) {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
if (!orderSheet) return { ok: false, error: '배송 시트를 찾을 수 없습니다.' };
const data = orderSheet.getDataRange().getValues();
const counts = {};
for (let i = 1; i < data.length; i++) {
const d = toDateStr(data[i][1]);
if (!d.startsWith(monthStr)) continue;
counts[d] = (counts[d] || 0) + 1;
}
return { ok: true, month: monthStr, counts: counts };
}

// ---- 신규 배송 건 생성 (업체명/현장명/날짜) ----
function handleCreateOrder(body) {
const date = String(body.date || '').trim();
const vendorName = String(body.vendorName || '').trim();
const siteName = String(body.siteName || '').trim();
const phone = String(body.phone || '').trim();
if (!date || !vendorName) throw new Error('날짜와 업체명은 필수입니다.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const data = orderSheet.getDataRange().getValues();
let countToday = 0;
for (let i = 1; i < data.length; i++) {
if (toDateStr(data[i][1]) === date) countToday++;
}
const orderId = date.replace(/-/g, '') + '-' + (countToday + 1);

orderSheet.appendRow([orderId, date, vendorName, phone, siteName, 'N', 0, 0, 0, '', '', '대기', 'N', new Date()]);
return jsonOut({ ok: true, orderId: orderId });
}

// ---- 전표 사진 업로드 -> Claude로 품목(품목명/규격/수량/단가) 추출 ----
function handleDeliveryExtract(body) {
const fileBase64 = body.fileBase64;
const mimeType = body.mimeType || 'image/jpeg';
const orderId = body.orderId || '';
if (!fileBase64) throw new Error('파일이 없습니다.');

const parsed = extractDeliveryItemsWithClaude(fileBase64, mimeType);
if (!parsed.items || !parsed.items.length) throw new Error('사진에서 품목을 찾지 못했어요. 다시 촬영하거나 수기로 입력해주세요.');

if (orderId) {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const rowIdx = findOrderRowIndex(orderSheet, orderId);
if (rowIdx !== -1) {
const vendorName = orderSheet.getRange(rowIdx, 3).getValue();
applyMasterCatalogMatch(parsed.items, vendorName);
}
}

return jsonOut({ ok: true, items: parsed.items });
}

// ---- Claude API 호출: 배송 전표 사진에서 품목만 추출 ----
function extractDeliveryItemsWithClaude(fileBase64, mimeType) {
const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

const correctionText = getCorrectionListText();
const correctionBlock = correctionText
? ['', '[과거 교정 이력 - 우선 참고]',
   '아래는 과거에 사람이 직접 오타를 고친 이력입니다. 사진에서 이와 비슷하게 애매하게 보이는 품목명이 나오면, 아래 정정표현을 우선적으로 사용하세요.',
   correctionText, '']
: [''];

const systemPrompt = [
'당신은 타일/욕실자재 배송 전표(거래명세서, 납품서, 현장 메모 사진 등)에서 배송 품목을 추출하는 도우미입니다.',
''
].concat(correctionBlock).concat([
'[품목 추출 규칙]',
'1. 품목명과 수량이 적힌 행만 실제 배송 품목으로 추출합니다. 규격(사이즈)이나 단가는 보이면 함께 추출하고, 안 보이면 비워둡니다.',
'2. 합계, 소계, 부가세, 이월, 배송비, 메모성 문구 등은 품목이 아니므로 제외합니다.',
'3. 같은 품목이 여러 번 적혀 있으면 하나로 합쳐서 수량을 더합니다.',
'4. 아래 JSON 형식으로만 출력하세요. 다른 설명이나 코드블록 표시 없이 순수 JSON 객체 하나만 출력합니다.',
'{"items":[{"name":"품목명","spec":"규격(없으면 빈 문자열)","qty":숫자,"price":단가숫자(모르면 0)}]}'
]).join('\n');

const contentBlock = mimeType === 'application/pdf'
? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
: { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBase64 } };

const payload = {
model: CLAUDE_MODEL,
max_tokens: 4000,
// 모델이 max_tokens를 보이지 않는 thinking에 다 써버려서 실제 출력이
// 하나도 안 나오는 경우가 있어(다른 추출 API에서 발견) thinking을 끈다.
thinking: { type: 'disabled' },
system: systemPrompt,
messages: [{
role: 'user',
content: [
contentBlock,
{ type: 'text', text: '이 배송 전표 사진에서 품목을 규칙대로 추출해서 JSON 객체만 출력해줘.' }
]
}]
};

const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
method: 'post',
contentType: 'application/json',
headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
payload: JSON.stringify(payload),
muteHttpExceptions: true
});

const data = JSON.parse(res.getContentText());
if (data.error) throw new Error('Claude API 오류: ' + data.error.message);

const textBlock = (data.content || []).filter(function (c) { return c.type === 'text'; })[0];
let jsonText = textBlock ? textBlock.text : '{}';
jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();

try {
const parsed = JSON.parse(jsonText);
applyCorrectionDictionary(parsed.items);
return parsed;
} catch (e) {
throw new Error('Claude가 이 사진에서 품목을 추출하지 못했습니다: ' + jsonText.slice(0, 300));
}
}

// ---- 전표(거래명세서) 등록: 품목 입력 -> 합계 계산 -> 거래처잔액 반영 ----
function handleSaveInvoice(body) {
const orderId = body.orderId;
const items = body.items;
const originalItems = body.originalItems || [];
if (!orderId) throw new Error('orderId가 없습니다.');
if (!items || !items.length) throw new Error('품목이 없습니다.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const itemSheet = ss.getSheetByName(ORDER_ITEM_SHEET);

const rowIdx = findOrderRowIndex(orderSheet, orderId);
if (rowIdx === -1) throw new Error('해당 주문을 찾을 수 없습니다.');
const vendorName = orderSheet.getRange(rowIdx, 3).getValue();

// 사진 인식 결과(originalItems) vs 저장 직전 사람이 고친 값(items) 비교 -> 교정사전에 자동 기록.
// 저장 중간에 품목을 추가/삭제해서 줄 수가 달라지면 자리 비교가 무의미해지므로, 개수가 같을 때만 비교한다.
if (originalItems.length && originalItems.length === items.length) {
const corrections = [];
items.forEach(function (it, i) {
const orig = originalItems[i];
if (!orig) return;
const editedName = String(it.name || '').trim();
const originalName = String(orig.name || '').trim();
if (originalName && editedName && originalName !== editedName) corrections.push([originalName, editedName]);
const editedSpec = String(it.spec || '').trim();
const originalSpec = String(orig.spec || '').trim();
if (originalSpec && editedSpec && originalSpec !== editedSpec) corrections.push([originalSpec, editedSpec]);
});
if (corrections.length) saveCorrections(corrections);
}

// 기존에 등록된 품목 있으면 삭제 후 재등록
const itemData = itemSheet.getDataRange().getValues();
const rowsToDelete = [];
for (let i = itemData.length - 1; i >= 1; i--) {
if (String(itemData[i][0]) === String(orderId)) rowsToDelete.push(i + 1);
}
rowsToDelete.forEach(function (r) { itemSheet.deleteRow(r); });

let total = 0;
const newRows = items.map(function (it) {
const qty = Number(it.qty) || 0;
const price = Number(it.price) || 0;
const lineTotal = Math.round(qty * price);
const supply = Math.round(lineTotal / 1.1);
const vat = lineTotal - supply;
total += lineTotal;
return [orderId, it.name || '', it.spec || '', qty, price, supply, vat, '대기', 0];
});
if (newRows.length) {
itemSheet.getRange(itemSheet.getLastRow() + 1, 1, newRows.length, 9).setValues(newRows);
}

// 거래처잔액 반영: 전잔 조회 -> 후잔 계산 -> 거래처잔액 시트 갱신
const balanceInfo = getBalances();
let before = 0;
let matchedName = vendorName;
if (balanceInfo.ok) {
const vi = findVendor(vendorName);
const target = vi ? vi.storedName : vendorName;
matchedName = target;
const found = balanceInfo.rows.find(function (r) { return r.name === target; });
if (found) before = Number(found.balance) || 0;
}
const after = before + total;
upsertBalance(matchedName, after);

orderSheet.getRange(rowIdx, 6, 1, 4).setValues([['Y', total, before, after]]);

return jsonOut({ ok: true, orderId: orderId, total: total, balanceBefore: before, balanceAfter: after });
}

// ---- 거래처잔액 시트에 특정 거래처의 잔액을 반영(있으면 갱신, 없으면 추가) ----
function upsertBalance(vendorName, newBalance) {
const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
let sheet = ss.getSheetByName(BALANCE_SHEET);
if (!sheet) sheet = ss.insertSheet(BALANCE_SHEET);
const data = sheet.getDataRange().getValues();
for (let i = 1; i < data.length; i++) {
if (String(data[i][0]).trim() === String(vendorName).trim()) {
sheet.getRange(i + 1, 2).setValue(newBalance);
return;
}
}
sheet.appendRow([vendorName, newBalance]);
}

// ---- 입금 처리: 완납 또는 추후입금(메모) -> 배송 단계 잠금 해제 ----
function handleSavePayment(body) {
const orderId = body.orderId;
const status = String(body.status || '').trim();
const memo = String(body.memo || '').trim();
if (!orderId) throw new Error('orderId가 없습니다.');
if (!status) throw new Error('입금 상태를 선택해주세요.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const rowIdx = findOrderRowIndex(orderSheet, orderId);
if (rowIdx === -1) throw new Error('해당 주문을 찾을 수 없습니다.');

orderSheet.getRange(rowIdx, 10, 1, 2).setValues([[status, memo]]);
return jsonOut({ ok: true, orderId: orderId, status: status });
}

// ---- 배송 처리: 품목별 실제 배송수량 기록, 주문수량 대비 부족하면 부분누락/누락 처리 ----
function ensureDeliveredQtyHeader(itemSheet) {
if (itemSheet.getRange(1, 10).getValue() !== '배송수량') {
itemSheet.getRange(1, 10).setValue('배송수량');
}
}

function handleSaveDelivery(body) {
const orderId = body.orderId;
const deliveries = body.deliveries || []; // [{name, qty}] 실제 배송한 수량
const finalize = !!body.finalize;
if (!orderId) throw new Error('orderId가 없습니다.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const itemSheet = ss.getSheetByName(ORDER_ITEM_SHEET);
ensureDeliveredQtyHeader(itemSheet);
const itemData = itemSheet.getDataRange().getValues();

const deliveredMap = {};
deliveries.forEach(function (d) { deliveredMap[d.name] = Number(d.qty) || 0; });

let hasMissing = false;
for (let i = 1; i < itemData.length; i++) {
if (String(itemData[i][0]) !== String(orderId)) continue;
const name = itemData[i][1];
if (!Object.prototype.hasOwnProperty.call(deliveredMap, name)) continue;
const orderedQty = Number(itemData[i][3]) || 0;
const deliveredQty = deliveredMap[name];

let status;
if (deliveredQty >= orderedQty) status = '완료';
else if (deliveredQty > 0) status = '부분누락';
else status = finalize ? '누락' : '대기';

if (status !== '완료') hasMissing = true;

itemSheet.getRange(i + 1, 8).setValue(status);
itemSheet.getRange(i + 1, 10).setValue(deliveredQty);
}

const rowIdx = findOrderRowIndex(orderSheet, orderId);
if (rowIdx !== -1 && finalize) {
orderSheet.getRange(rowIdx, 12).setValue(hasMissing ? '일부누락' : '완료');
} else if (rowIdx !== -1) {
orderSheet.getRange(rowIdx, 12).setValue('진행중');
}

return jsonOut({ ok: true, orderId: orderId, hasMissing: hasMissing });
}

// ---- 배송 건(전표) 삭제: 배송일정/배송품목에서 해당 주문 행 제거, 전표가 등록돼 있었으면 거래처잔액도 되돌림 ----
function handleDeleteOrder(body) {
const orderId = body.orderId;
if (!orderId) throw new Error('orderId가 없습니다.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const itemSheet = ss.getSheetByName(ORDER_ITEM_SHEET);
const rowIdx = findOrderRowIndex(orderSheet, orderId);
if (rowIdx === -1) throw new Error('해당 주문을 찾을 수 없습니다.');

const orderRow = orderSheet.getRange(rowIdx, 1, 1, 14).getValues()[0];
const order = orderRowToObj(orderRow);

if (order.invoiceRegistered && order.totalAmount) {
const balanceInfo = getBalances();
if (balanceInfo.ok) {
const vi = findVendor(order.vendorName);
const target = vi ? vi.storedName : order.vendorName;
const found = balanceInfo.rows.find(function (r) { return r.name === target; });
if (found) upsertBalance(target, (Number(found.balance) || 0) - order.totalAmount);
}
}

const itemData = itemSheet.getDataRange().getValues();
for (let i = itemData.length - 1; i >= 1; i--) {
if (String(itemData[i][0]) === String(orderId)) itemSheet.deleteRow(i + 1);
}

orderSheet.deleteRow(rowIdx);

return jsonOut({ ok: true, orderId: orderId });
}

// ---- 반품일정 설정: 배송완료된 건에 반품 예정일을 올려두면 배송기사 앱에서 반품 체크가 열림 ----
function handleSaveReturnSchedule(body) {
const orderId = body.orderId;
const date = String(body.date || '').trim();
if (!orderId) throw new Error('orderId가 없습니다.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
ensureReturnScheduleHeader(orderSheet);
const rowIdx = findOrderRowIndex(orderSheet, orderId);
if (rowIdx === -1) throw new Error('해당 주문을 찾을 수 없습니다.');

orderSheet.getRange(rowIdx, 15).setValue(date);
return jsonOut({ ok: true, orderId: orderId, returnScheduleDate: date });
}

// ---- 반품 처리: 배송된 품목 중 선택 + 수량 -> 반품수량 기록 ----
function handleSaveReturn(body) {
const orderId = body.orderId;
const returns = body.returns || [];
if (!orderId) throw new Error('orderId가 없습니다.');

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
const orderSheet = ss.getSheetByName(ORDER_SHEET);
const itemSheet = ss.getSheetByName(ORDER_ITEM_SHEET);
const itemData = itemSheet.getDataRange().getValues();

returns.forEach(function (ret) {
for (let i = 1; i < itemData.length; i++) {
if (String(itemData[i][0]) === String(orderId) && String(itemData[i][1]) === String(ret.name)) {
itemSheet.getRange(i + 1, 9).setValue(Number(ret.qty) || 0);
break;
}
}
});

const rowIdx = findOrderRowIndex(orderSheet, orderId);
if (rowIdx !== -1) {
const anyReturn = returns.some(function (r) { return (Number(r.qty) || 0) > 0; });
orderSheet.getRange(rowIdx, 13).setValue(anyReturn ? 'Y' : 'N');
}

return jsonOut({ ok: true, orderId: orderId });
}