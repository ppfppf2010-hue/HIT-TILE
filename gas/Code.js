/**
 * * ===== 품목등록 자동화 백엔드 (Google Apps Script) v2.1 =====
 * 변경점(v2 -> v2.1): 거래처명 매칭을 완전일치에서 "완전일치 우선, 실패 시 정규화 비교"로 개선.
 *   -> PDF마다 Claude가 인식하는 거래처명 표기가 살짝 달라져도(공백, "(주)"/"㈜"/"주식회사" 표기 차이 등)
 *      같은 거래처로 인식해서 코드 번호가 1로 리셋되지 않도록 함.
 *
 * 사전 설정 (v1과 동일)
 * 1) Google Sheet에 아래 두 탭 준비
 *    탭1: 거래처코드관리   헤더: 거래처명 | 시작코드 | 마지막사용코드
 *    탭2: 품목등록마스터   헤더: 품목코드 | 품목명 | 규격구분 | 규격 | 입고단가 |
 *                        입고단가VAT포함여부 | 단위 | 품목구분 | 세트여부 | 재고수량관리 |
 *                        출고단가 | 출고단가VAT포함여부 | 거래처명 | 등록일시
 * 2) SPREADSHEET_ID 입력
 * 3) 스크립트 속성에 CLAUDE_API_KEY 등록
 * 4) 웹앱으로 배포 (액세스: 모든 사용자)
 *
 * 동작 방식
 * - action="extract" : 파일만 보내면 Claude가 거래처명+품목을 함께 인식.
 *     - 기존에 등록된 거래처면 바로 코드 채번 + 저장 + 결과 반환.
 *     - 처음 보는 거래처면 ok:false, needsStartCode:true 로 응답 (재분석 없이 이어갈 수 있도록 items도 함께 반환).
 * - action="finalize" : 신규 거래처일 때, 프론트에서 시작번호를 받아 최종 등록.
 */

 const SPREADSHEET_ID = '1XBzkR5oVC1kmRkT270FnbIm_IdRzzumpB48TGorKJSM';
 const VENDOR_SHEET = '거래처코드관리';
 const MASTER_SHEET = '품목등록마스터';
 const CLAUDE_MODEL = 'claude-sonnet-4-6';

 function doPost(e) {
 try {
 const body = JSON.parse(e.postData.contents);
 const action = body.action || 'extract';

 if (action === 'extract') return handleExtract(body);
 if (action === 'finalize') return handleFinalize(body);
 if (action === 'purchase_extract') return handlePurchaseExtract(body);
 if (action === 'create_order') return handleCreateOrder(body);
 if (action === 'save_invoice') return handleSaveInvoice(body);
 if (action === 'save_payment') return handleSavePayment(body);
 if (action === 'save_delivery') return handleSaveDelivery(body);
 if (action === 'save_return') return handleSaveReturn(body);
 if (action === 'save_balances') return handleSaveBalances(body);
 throw new Error('알 수 없는 action: ' + action);
 } catch (err) {
 return jsonOut({ ok: false, error: err.message });
 }
 }

 function jsonOut(obj) {
 return ContentService.createTextOutput(JSON.stringify(obj))
 .setMimeType(ContentService.MimeType.JSON);
 }

 // ---- 1) 최초 업로드: 거래처명 + 품목 동시 인식 ----
 function handleExtract(body) {
 const fileBase64 = body.fileBase64;
 const mimeType = body.mimeType || 'application/pdf';
 if (!fileBase64) throw new Error('파일이 없습니다.');

 const parsed = extractWithClaude(fileBase64, mimeType);
 if (!parsed.vendorName) throw new Error('문서에서 거래처명을 인식하지 못했습니다. 거래처명이 잘 보이는 페이지인지 확인해주세요.');
 if (!parsed.items || parsed.items.length === 0) throw new Error('문서에서 품목을 찾지 못했습니다.');

 const vendorInfo = findVendor(parsed.vendorName);

 if (vendorInfo) {
 const finalRows = assignCodesAndPrices(parsed.items, vendorInfo.lastUsed + 1);
 appendToMasterSheet(vendorInfo.storedName, finalRows);
 return jsonOut({ ok: true, vendorName: vendorInfo.storedName, items: finalRows });
 }

 return jsonOut({ ok: false, needsStartCode: true, vendorName: parsed.vendorName, items: parsed.items });
 }

 // ---- 2) 신규 거래처 확정: 시작번호 받아서 최종 등록 ----
 function handleFinalize(body) {
 const vendorName = (body.vendorName || '').trim();
 const startCode = Number(body.startCode);
 const items = body.items;

 if (!vendorName) throw new Error('거래처명이 없습니다.');
 if (!startCode) throw new Error('시작 코드번호를 입력해주세요.');
 if (!items || !items.length) throw new Error('품목 데이터가 없습니다.');

 const existing = findVendor(vendorName);
 let finalVendorName = vendorName;

 if (!existing) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 ss.getSheetByName(VENDOR_SHEET).appendRow([vendorName, startCode, startCode - 1]);
 } else {
 finalVendorName = existing.storedName;
 }

 const finalRows = assignCodesAndPrices(items, existing ? existing.lastUsed + 1 : startCode);
 appendToMasterSheet(finalVendorName, finalRows);
 return jsonOut({ ok: true, vendorName: finalVendorName, items: finalRows });
 }

 // ---- Claude API 호출: 거래처명 + 품목 함께 추출 ----
 function extractWithClaude(fileBase64, mimeType) {
 const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
 if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

 const systemPrompt = [
 '당신은 타일/욕실자재 매출처별 거래원장(거래명세서) PDF 또는 이미지에서 거래처명과 품목을 추출하는 도우미입니다.',
 '',
 '[거래처명 인식]',
 '- 문서 안에 보통 "거래처명 :", "공급처명 :" 같은 라벨과 함께 회사명이 적혀 있습니다.',
 '- 문서의 주인공(구매자), 즉 히트타일 쪽 거래상대방인 "공급처"/"거래처")의 상호명을 정확히 그대로 추출하세요. 예: 주식회사 베리굿타일앤스, 주식회사 대명세라믹스.',
 '- 여러 회사명이 등장하면(수신자/발신자 등) 실제 물건을 공급하는 회사(공급처명/공급자명)를 우선합니다.',
 '',
 '[품목 추출 규칙]',
 '1. 일 계, 일계, 월별집계, 월계, 합 계, 이월, 수입, 통장결제, 예금, DC처리, 계좌 안내 문구 등 소계/입금/안내 행은 무시하고 실제 품목 거래 행만 추출합니다.',
 '2. 품목명은 색상/모델 코드(#, 로트번호, 배치코드 등)는 제외한 핵심 품목명만 추출합니다.',
 '3. 같은 (품목명, 규격, 단위) 조합이 문서에 여러 번 나오면 하나로 합치되, 문서상 가장 나중 날짜(마지막 등장)의 값을 사용합니다.',
 '4. 단가는 부가세 별도(공급가액 기준)인지 부가세 포함(합계금액 기준)인지, 단가×수량 값을 확인해서 판단하세요.',
 '   부가세 포함 단가가 확인 가능하다면 그 부가세 포함 단가를 그대로 사용합니다.',
 '5. 최종 단가는 100원 단위로 반올림합니다.',
 '6. 반품/마이너스 수량 행도 같은 품목으로 취급합니다(별도 품목 아님).',
 '7. 아래 JSON 형식으로만 출력하세요. 다른 설명이나 코드블록 표시 없이 순수 JSON 객체 하나만 출력합니다.',
 '{"vendorName":"거래처 상호명","items":[{"name":"품목명","spec":"규격(없으면 빈 문자열)","unit":"단위(BOX/포/SET/EA/통/봉지 등 원문 그대로)","price":숫자}]}'
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
 { type: 'text', text: '이 문서에서 거래처명과 품목을 규칙대로 추출해서 JSON 객체만 출력해줘.' }
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
 return JSON.parse(jsonText);
 }

 // ---- 거래처명 정규화: 공백/괄호 표기 차이를 무시하고 비교하기 위한 헬퍼 ----
 function normalizeVendorName(name) {
 return String(name || '')
 .replace(/\s+/g, '')
 .replace(/\(주\)|㈜|주식회사|\(유\)/g, '')
 .toUpperCase();
 }

 // ---- 거래처 조회 (완전일치 우선, 실패 시 정규화 비교로 표기 차이 흡수) ----
 function findVendor(vendorName) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 const data = sheet.getDataRange().getValues();
 const target = normalizeVendorName(vendorName);

 for (let i = 1; i < data.length; i++) {
 const stored = String(data[i][0]);
 if (stored.trim() === String(vendorName).trim() || normalizeVendorName(stored) === target) {
 return { rowIndex: i + 1, storedName: stored.trim(), lastUsed: Number(data[i][2]) };
 }
 }
 return null;
 }

 // ---- 코드/출고단가 등 최종 필드 조립 ----
 function assignCodesAndPrices(items, startCode) {
 return items.map(function (it, i) {
 const inPrice = Math.round(Number(it.price) / 100) * 100;
 const outPrice = Math.round((inPrice * 1.5) / 100) * 100;
 return {
 code: startCode + i,
 name: it.name,
 specType: it.spec ? '사이즈' : '',
 spec: it.spec || '',
 inPrice: inPrice,
 inVat: 'Y',
 unit: it.unit,
 category: it.unit === 'SET' ? 'SET상품' : '자재',
 isSet: it.unit === 'SET' ? 'Y' : 'N',
 stockMgmt: 'Y',
 outPrice: outPrice,
 outVat: 'Y'
 };
 });
 }

 // ---- 마스터 시트 누적 저장 + 거래처 마지막코드 갱신 ----
 function appendToMasterSheet(vendorName, rows) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(MASTER_SHEET);
 const now = new Date();

 rows.forEach(function (r) {
 sheet.appendRow([
 r.code, r.name, r.specType, r.spec, r.inPrice, r.inVat,
 r.unit, r.category, r.isSet, r.stockMgmt, r.outPrice, r.outVat,
 vendorName, now
 ]);
 });

 const vendorSheet = ss.getSheetByName(VENDOR_SHEET);
 const data = vendorSheet.getDataRange().getValues();
 const lastCode = rows[rows.length - 1].code;
 const target = normalizeVendorName(vendorName);

 for (let i = 1; i < data.length; i++) {
 const stored = String(data[i][0]);
 if (stored.trim() === String(vendorName).trim() || normalizeVendorName(stored) === target) {
 vendorSheet.getRange(i + 1, 3).setValue(lastCode);
 break;
 }
 }
 }
 