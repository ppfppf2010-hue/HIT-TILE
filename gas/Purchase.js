/**
 * * ===== 구매등록 자동화 (Google Apps Script) v2 =====
 * 매입 거래명세서/세금계산서 PDF 또는 이미지를 업로드하면
 * Claude가 거래처명 + 품목(수량/단가/단위)을 추출하고,
 * 기존 거래처코드관리/품목등록마스터 시트에서 코드를 매칭해
 * '구매입력' 탭에 Ecount 매입 일괄등록 양식 그대로 누적 저장한다.
 *
 * v2 변경점: 품목등록마스터에 없는 품목은 해당 거래처의 기존 코드 접두어로
 * 자동 채번해서 품목등록마스터에도 함께 등록한다(거래처가 이미 등록되어 있을 때만).
 *
 * 주의: 거래처코드(Ecount 자체 코드)/담당자/입고창고/거래유형은
 * 이 시스템에 매핑 정보가 없어 빈 칸으로 남긴다. 업로드 전 확인 필요.
 *
 * doPost action="purchase_extract" 로 Code.gs의 doPost에서 라우팅됨.
 */

 const PURCHASE_SHEET = '구매입력';

 // ---- 매입 문서 업로드 -> 거래처+품목 인식 + 구매입력/품목등록마스터에 자동 등록 ----
 function handlePurchaseExtract(body) {
 const fileBase64 = body.fileBase64;
 const mimeType = body.mimeType || 'application/pdf';
 const targetMonth = String(body.targetMonth || '').trim(); // 'YYYY-MM', 선택 시 그 달 품목만 등록
 if (!fileBase64) throw new Error('파일이 없습니다.');

 const parsed = extractPurchaseWithClaude(fileBase64, mimeType);
 if (!parsed.vendorName) throw new Error('문서에서 거래처명을 인식하지 못했습니다.');
 if (!parsed.items || parsed.items.length === 0) throw new Error('문서에서 품목을 찾지 못했습니다.');

 const totalExtracted = parsed.items.length;
 if (targetMonth) {
 parsed.items = parsed.items.filter(function (it) {
 const d = String(it.date || parsed.docDate || '');
 return d.indexOf(targetMonth) === 0;
 });
 if (!parsed.items.length) {
 throw new Error('선택한 월(' + targetMonth + ')에 해당하는 품목을 찾지 못했어요. 문서의 날짜를 확인해주세요.');
 }
 }

 const vendorInfo = findVendor(parsed.vendorName);
 const finalVendorName = vendorInfo ? vendorInfo.storedName : parsed.vendorName;

 const rows = buildPurchaseRows(parsed, finalVendorName, vendorInfo);
 appendToPurchaseSheet(rows);

 return jsonOut({
 ok: true,
 vendorName: finalVendorName,
 vendorMatched: !!vendorInfo,
 rows: rows,
 totalExtracted: totalExtracted,
 filteredByMonth: !!targetMonth
 });
 }

 // ---- 품목코드 매칭 + 미매칭 품목 자동 채번/등록 + 공급가액/부가세 계산해서 행 조립 ----
 function buildPurchaseRows(parsed, vendorName, vendorInfo) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 const masterData = masterSheet.getDataRange().getValues();
 const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
 const docDate = parsed.docDate || today;

 const codeMap = {};
 const missingNames = [];

 parsed.items.forEach(function (it) {
 const key = String(it.name || '').trim();
 if (codeMap[key] !== undefined) return;
 const match = findItemCode(masterData, vendorName, it.name);
 if (match) {
 codeMap[key] = match.code;
 } else if (missingNames.indexOf(key) === -1) {
 missingNames.push(key);
 }
 });

 if (vendorInfo && missingNames.length) {
 const toRegister = missingNames.map(function (name) {
 const src = parsed.items.filter(function (it) { return String(it.name || '').trim() === name; })[0];
 return {
 name: name,
 spec: src.spec || '',
 price: src.price,
 unit: src.unit || 'EA'
 };
 });
 const newRows = assignCodesAndPrices(toRegister, vendorInfo.lastUsed + 1);
 appendToMasterSheet(vendorName, newRows);
 newRows.forEach(function (r) { codeMap[r.name] = r.code; });
 }

 return parsed.items.map(function (it, i) {
 const key = String(it.name || '').trim();
 const code = codeMap[key] || '';
 const autoRegistered = !!(vendorInfo && missingNames.indexOf(key) !== -1);
 const unitPrice = Math.round(Number(it.price) || 0);
 const qty = Number(it.qty) || 0;
 const supply = Math.round((unitPrice * qty) / 1.1);
 const vat = Math.round(unitPrice * qty) - supply;

 return {
 date: (it.date || docDate),
 seq: i + 1,
 vendorCode: '',
 vendorName: vendorName,
 manager: '',
 warehouse: '',
 dealType: '',
 currency: 'KRW',
 rate: 1,
 itemCode: code,
 itemName: it.name,
 spec: it.spec || '',
 qty: qty,
 unitPrice: unitPrice,
 foreignAmount: '',
 supply: supply,
 vat: vat,
 note: code ? (autoRegistered ? '신규 품목 자동등록됨' : '') : '품목코드 미매칭 - 거래처 미등록으로 자동등록 불가'
 };
 });
 }

 // ---- 품목등록마스터에서 거래처명+품목명 일치하는 품목코드 찾기 ----
 function findItemCode(masterData, vendorName, itemName) {
 const targetVendor = normalizeVendorName(vendorName);
 const targetName = String(itemName || '').trim();

 for (let i = 0; i < masterData.length; i++) {
 const row = masterData[i];
 const rowVendor = normalizeVendorName(String(row[12] || ''));
 const rowName = String(row[1] || '').trim();
 if (rowVendor === targetVendor && rowName === targetName) {
 return { code: row[0] };
 }
 }
 for (let i = 0; i < masterData.length; i++) {
 const row = masterData[i];
 const rowName = String(row[1] || '').trim();
 if (rowName === targetName) {
 return { code: row[0] };
 }
 }
 return null;
 }

 // ---- 구매입력 시트에 누적 저장 (Ecount 양식 컬럼 순서 그대로) ----
 function appendToPurchaseSheet(rows) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(PURCHASE_SHEET);
 rows.forEach(function (r) {
 sheet.appendRow([
 r.date, r.seq, r.vendorCode, r.vendorName, r.manager, r.warehouse,
 r.dealType, r.currency, r.rate, r.itemCode, r.itemName, r.spec,
 r.qty, r.unitPrice, r.foreignAmount, r.supply, r.vat, r.note
 ]);
 });
 }

 // ---- 구매입력 탭 헤더 최초 1회 세팅 (Run 버튼으로 직접 실행) ----
 function setupPurchaseSheet() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(PURCHASE_SHEET);
 const header = ['일자', '순번', '거래처코드', '거래처명', '담당자', '입고창고', '거래유형', '통화', '환율', '품목코드', '품목명', '규격명', '수량', '단가(vat포함)', '외화금액', '공급가액', '부가세', '적요'];
 sheet.getRange(1, 1, 1, header.length).setValues([header]);
 sheet.setFrozenRows(1);
 }

 // ---- Claude API 호출: 매입 거래명세서에서 거래처+품목 추출 ----
 function extractPurchaseWithClaude(fileBase64, mimeType) {
 const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
 if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

 const systemPrompt = [
 '당신은 매입 거래명세서(세금계산서, 거래처원장 포함) PDF 또는 이미지에서 거래처명과 매입 품목을 추출하는 도우미입니다.',
 '',
 '[거래처명 인식]',
 '- 문서 안에 보통 "공급자:" 또는 "공급하는자:" 같은 라벨과 함께 회사명이 적혀 있습니다.',
 '- "거래처원장" 형식이면 문서 상단에 공급자(물건을 판 쪽) 상호명이 적혀 있고, 그 아래 표는 그 공급자가 히트타일에게 판매한 내역입니다.',
 '- 히트타일이 매입하는 입장이므로, 공급자(물건을 판 쪽) 상호명을 정확히 그대로 추출하세요.',
 '',
 '[품목 추출 규칙]',
 '1. 일자, 품명, 규격, 단위, 수량, 단가, 공급가액, 세액 컬럼이 있는 표에서 실제 품목 거래행만 추출합니다.',
 '2. 소계/합계/부가세 합계 등 요약행은 무시하고 실제 품목행만 추출합니다.',
 '3. 단가는 부가세 포함 단가(vat포함) 기준으로 추출합니다. 문서에 공급가액과 세액이 따로 있으면 (공급가액+세액)/수량으로 계산해서 단가를 구하세요.',
 '4. 단위는 문서에 적힌 그대로(BOX, 포, SET, 통, EA, 봉지 등) 추출하세요. 단위가 없으면 "EA"로 둡니다.',
 '5. 문서에 날짜가 하나만 있으면 그 날짜를 docDate에 YYYY-MM-DD 형식으로 넣으세요. 거래처원장처럼 품목 행마다 날짜가 다르면(예 26.07.06, 26.07.13 등 여러 날짜가 섞여 있으면), 각 품목의 실제 거래일자를 그 품목 항목의 date 필드에 YYYY-MM-DD 형식으로 각각 넣으세요. 이 경우 docDate는 문서에 적힌 기준일자나 가장 이른 날짜로 채워도 됩니다.',
'6. 이 문서가 매출/입금 방식(공급자 입장에서 매출로 기록된 방식)이거나 컬럼 구성이 다르더라도, 히트타일이 지불하는 금액에 해당하는 단가 컬럼을 찾아 최대한 추출을 시도하세요. 설명이 필요해 보여도 거절하지 말고 best-effort로 JSON을 출력하세요.','7. 전기이월, 대체, 대입, 입금, 카드, 통장결제, 계좌변경 안내 같은 결제/이월 행은 실제 매입 품목이 아니므로 items에서 제외하세요.',
 '8. 아래 JSON 형식으로만 출력하세요. 다른 설명이나 코드블록 표시 없이 순수 JSON 객체 하나만 출력합니다.',
 '{"vendorName":"거래처 상호명","docDate":"YYYY-MM-DD","items":[{"name":"품목명","spec":"규격(없으면 빈 문자열)","unit":"단위","qty":숫자,"price":단가숫,"date":"YYYY-MM-DD(해당 품목 행의 실제 날짜, 문서 전체가 한 날짜뿐이면 생략 가능)"자}]}'
 ].join('\n');

 const contentBlock = mimeType === 'application/pdf'
 ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
 : { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBase64 } };

 const payload = {
 model: CLAUDE_MODEL,
 max_tokens: 8000,
 system: systemPrompt,
 messages: [{
 role: 'user',
 content: [
 contentBlock,
 { type: 'text', text: '이 매입 거래명세서에서 거래처와 품목을 규칙대로 추출해서 JSON 객체만 출력해줘.' }
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
 return JSON.parse(jsonText);
 } catch (e) {
 throw new Error('Claude가 이 문서에서 매입 정보를 추출하지 못했습니다: ' + jsonText.slice(0, 300));
 }
 }
 