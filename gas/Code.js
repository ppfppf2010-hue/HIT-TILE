/**
 * * ===== 히트타일 업무자동화 백엔드 (Google Apps Script) =====
 * doPost의 action으로 여러 기능을 라우팅한다. 공용 상수/헬퍼(findVendor, normalizeVendorName,
 * assignCodesAndPrices, appendToMasterSheet 등)는 이 파일에 정의되어 Balance.js/Purchase.js/
 * Delivery.js에서도 그대로 쓴다(Apps Script는 모든 .js 파일이 하나의 전역 스코프로 합쳐짐).
 *
 * ===== 품목등록 자동화 v3 (2026-08-14 업데이트) =====
 * 변경점: 즉시 등록 방식에서 "검토중" 시트에 먼저 써놓고 사람이 확인 후 확정(confirm)하는
 * 방식으로 변경. 품목코드도 순수 숫자에서 접두어+숫자(예: VG00046) 방식으로 바꿔서,
 * 어떤 거래처 품목인지 코드만 보고도 구분할 수 있게 함.
 *
 * 사전 설정 - 시트 탭 3개 필요
 *   탭1: 거래처코드관리   헤더: 거래처명 | 코드접두어 | 마지막사용번호
 *   탭2: 품목등록마스터   헤더: 품목코드 | 품목명 | 규격구분 | 규격 | 입고단가 |
 *                          입고단가VAT포함여부 | 단위 | 품목구분 | 세트여부 | 재고수량관리 |
 *                          출고단가 | 출고단가VAT포함여부 | 거래처명 | 등록일시
 *   탭3: 검토중           (자동 생성됨, 미리 안 만들어도 됨)
 *
 * 동작 방식
 * - action="extract"    : 파일 분석 후, 기존 거래처면 코드까지 계산해서 '검토중' 탭에 씀. 구글시트 링크 반환.
 * - action="previewNew" : 신규 거래처 접두어 확정 시, 코드 계산해서 '검토중' 탭에 씀. 구글시트 링크 반환.
 * - action="confirm"    : 사람이 '검토중' 탭에서 수정 끝낸 뒤, 그 내용을 그대로 읽어와 마스터에 저장 + 다운로드용 데이터 반환.
 *
 * ⚠️ 마이그레이션 필요: 거래처코드관리 시트의 기존 데이터는 코드접두어 칸이 비어있음(예전엔 숫자 시작코드였음).
 * Apps Script 편집기에서 migrateVendorSheetToPrefixCodes()를 한 번 [Run]으로 실행해서
 * 기존 거래처마다 접두어를 자동 생성/기록해야 이 버전이 정상 동작한다.
 */

 const SPREADSHEET_ID = '1XBzkR5oVC1kmRkT270FnbIm_IdRzzumpB48TGorKJSM';
 const VENDOR_SHEET = '거래처코드관리';
 const MASTER_SHEET = '품목등록마스터';
 const REVIEW_SHEET = '검토중';
 const CORRECTION_SHEET = '교정사전';
 const CLAUDE_MODEL = 'claude-sonnet-5';
 const CODE_DIGITS = 5;

 const REVIEW_HEADERS = ['품목코드', '품목명', '규격구분', '규격', '입고단가', '입고단가VAT포함여부',
   '단위', '품목구분', '세트여부', '재고수량관리', '출고단가', '출고단가VAT포함여부', '거래처명',
   '원본품목명(자동,수정금지)', '원본규격(자동,수정금지)'];

 const VENDOR_PREFIX_MAP = [
   { keyword: '베리굿', prefix: 'VG' },
   { keyword: '대명세라믹', prefix: 'DM' },
   { keyword: '에스지세라', prefix: 'SG' },
   { keyword: '포트타일', prefix: 'PT' },
   { keyword: '코토세라믹', prefix: 'CT' },
   { keyword: '탑세라믹', prefix: 'TOP' }
 ];

 function doPost(e) {
 try {
 const body = JSON.parse(e.postData.contents);
 const action = body.action || 'extract';

 if (action === 'extract') return handleExtract(body);
 if (action === 'previewNew') return handlePreviewNew(body);
 if (action === 'confirm') return handleConfirm(body);
 if (action === 'purchase_extract') return handlePurchaseExtract(body);
 if (action === 'create_order') return handleCreateOrder(body);
 if (action === 'delivery_extract') return handleDeliveryExtract(body);
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

 // ---- 1) 파일 분석 ----
 function handleExtract(body) {
 const fileBase64 = body.fileBase64;
 const mimeType = body.mimeType || 'application/pdf';
 if (!fileBase64) throw new Error('파일이 없습니다.');

 const parsed = extractWithClaude(fileBase64, mimeType);
 if (!parsed.vendorName) throw new Error('문서에서 거래처명을 인식하지 못했습니다.');
 if (parsed.vendorName.indexOf('히트타일') !== -1) {
 throw new Error('공급업체명이 아니라 구매자(히트타일)로 잘못 인식되었습니다. 문서에 "공급처명" 표기가 잘 보이는지 확인해주세요.');
 }
 if (!parsed.items || parsed.items.length === 0) throw new Error('문서에서 품목을 찾지 못했습니다.');

 const vendorInfo = findVendor(parsed.vendorName);

 if (vendorInfo) {
 // 같은 접두어를 쓰는 다른 거래처명 행(예: 같은 회사의 다른 사업자)이 더 앞서있을 수 있으므로
 // 그 접두어 전체의 최대번호와 비교해서 더 큰 쪽을 시작번호로 사용한다.
 const sharedMax = getMaxLastUsedForPrefix(vendorInfo.prefix);
 const startNumber = Math.max(vendorInfo.lastUsed, sharedMax) + 1;
 // 시트에 저장된 원래 표기(storedName)를 사용해서 이후 저장되는 거래처명 표기를 통일시킨다.
 const previewRows = assignCodesAndPrices(parsed.items, vendorInfo.prefix, startNumber);
 const reviewUrl = stageForReview(vendorInfo.storedName, previewRows);
 return jsonOut({ ok: true, isNewVendor: false, vendorName: vendorInfo.storedName, reviewUrl: reviewUrl, count: previewRows.length });
 }

 const suggestedPrefix = matchPrefix(parsed.vendorName);
 return jsonOut({
 ok: true,
 needsPrefix: true,
 vendorName: parsed.vendorName,
 suggestedPrefix: suggestedPrefix || '',
 rawItems: parsed.items
 });
 }

 // ---- 2) 신규 거래처: 접두어 확정 -> 검토중 시트에 씀 ----
 function handlePreviewNew(body) {
 const vendorName = (body.vendorName || '').trim();
 const prefix = (body.prefix || '').trim().toUpperCase();
 const rawItems = body.rawItems;
 if (!vendorName) throw new Error('거래처명이 없습니다.');
 if (!prefix) throw new Error('코드 접두어를 입력해주세요.');
 if (!rawItems || !rawItems.length) throw new Error('품목 데이터가 없습니다.');

 // 혹시 이미 등록된(표기만 다른) 거래처라면 새로 만들지 않고 기존 번호를 이어서 쓴다.
 const existing = findVendor(vendorName);
 const finalVendorName = existing ? existing.storedName : vendorName;
 const finalPrefix = existing ? existing.prefix : prefix;

 // 거래처명은 처음 보더라도, 같은 코드 접두어(예: HIK)를 이미 다른 거래처명(다른 사업자)이
 // 쓰고 있다면 그 접두어의 최대번호 다음부터 이어간다. (한 회사가 사업자 2개로 나뉜 경우 대응)
 const sharedMax = getMaxLastUsedForPrefix(finalPrefix);
 const startNumber = Math.max(existing ? existing.lastUsed : 0, sharedMax) + 1;

 const previewRows = assignCodesAndPrices(rawItems, finalPrefix, startNumber);
 const reviewUrl = stageForReview(finalVendorName, previewRows);
 return jsonOut({ ok: true, count: previewRows.length, reviewUrl: reviewUrl });
 }

 // ---- '검토중' 탭에 미리보기 기록 ----
 function stageForReview(vendorName, rows) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(REVIEW_SHEET);
 if (!sheet) sheet = ss.insertSheet(REVIEW_SHEET);
 sheet.clear();

 sheet.appendRow(REVIEW_HEADERS);
 rows.forEach(function (r) {
 sheet.appendRow([r.code, r.name, r.specType, r.spec, r.inPrice, r.inVat,
 r.unit, r.category, r.isSet, r.stockMgmt, r.outPrice, r.outVat, vendorName,
 r.name, r.spec]); // 마지막 2개는 원본값 (수정 여부 비교용, 숨김열)
 });

 sheet.setFrozenRows(1);
 try { sheet.autoResizeColumns(1, 13); } catch (e) { /* ignore */ }
 try { sheet.hideColumns(14, 2); } catch (e) { /* ignore */ }
 const headerRange = sheet.getRange(1, 1, 1, REVIEW_HEADERS.length);
 headerRange.setFontWeight('bold').setBackground('#eef4ff');

 SpreadsheetApp.flush();
 return ss.getUrl() + '#gid=' + sheet.getSheetId();
 }

 // ---- 3) 검토중 시트 내용을 그대로 읽어와서 마스터에 저장 ----
 function handleConfirm(body) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(REVIEW_SHEET);
 if (!sheet) throw new Error('검토중 시트를 찾을 수 없습니다.');

 const data = sheet.getDataRange().getValues();
 if (data.length <= 1) throw new Error('검토중 시트에 저장할 품목이 없습니다. (다 지우신 건 아닌지 확인해주세요)');

 const rows = data.slice(1).filter(function (r) { return String(r[0]).trim() !== ''; });
 if (!rows.length) throw new Error('검토중 시트에 저장할 품목이 없습니다.');

 const items = rows.map(function (r) {
 return {
 code: String(r[0]).trim(), name: r[1], specType: r[2], spec: r[3],
 inPrice: r[4], inVat: r[5], unit: r[6], category: r[7],
 isSet: r[8], stockMgmt: r[9], outPrice: r[10], outVat: r[11]
 };
 });
 let vendorName = String(rows[0][12] || '').trim();
 if (!vendorName) throw new Error('거래처명(13번째 열)이 비어있는 행이 있습니다. 확인해주세요.');

 // 이미 등록된 거래처라면(표기가 살짝 달라도) 시트에 저장된 원래 표기로 통일해서 저장한다.
 const existingForSave = findVendor(vendorName);
 if (existingForSave) vendorName = existingForSave.storedName;

 // 원본(자동인식값) vs 수정본 비교 -> 교정사전에 자동 기록
 const corrections = [];
 rows.forEach(function (r) {
 const editedName = String(r[1] || '').trim();
 const originalName = String(r[13] || '').trim();
 if (originalName && editedName && originalName !== editedName) {
 corrections.push([originalName, editedName]);
 }
 const editedSpec = String(r[3] || '').trim();
 const originalSpec = String(r[14] || '').trim();
 if (originalSpec && editedSpec && originalSpec !== editedSpec) {
 corrections.push([originalSpec, editedSpec]);
 }
 });
 if (corrections.length) saveCorrections(corrections);

 appendToMasterSheet(vendorName, items);

 // 거래처 코드 마지막번호 갱신 (코드 문자열에서 접두어/숫자 파싱)
 let maxNumber = 0, prefix = '';
 items.forEach(function (it) {
 const m = String(it.code).match(/^([A-Za-z]+)(\d+)$/);
 if (m) {
 prefix = m[1];
 const n = parseInt(m[2], 10);
 if (n > maxNumber) maxNumber = n;
 }
 });
 const vendorInfo = findVendor(vendorName);
 if (vendorInfo) {
 const newMax = Math.max(maxNumber, vendorInfo.lastUsed, getMaxLastUsedForPrefix(vendorInfo.prefix));
 saveLastUsedByPrefix(vendorInfo.prefix, newMax);
 } else if (prefix) {
 const newMax = Math.max(maxNumber, getMaxLastUsedForPrefix(prefix));
 ss.getSheetByName(VENDOR_SHEET).appendRow([vendorName, prefix, newMax]);
 saveLastUsedByPrefix(prefix, newMax);
 }

 // 검토중 시트는 헤더만 남기고 비움
 sheet.clear();
 sheet.appendRow(REVIEW_HEADERS);
 sheet.setFrozenRows(1);

 return jsonOut({ ok: true, vendorName: vendorName, items: items, savedCount: items.length });
 }

 function saveCorrections(pairs) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(CORRECTION_SHEET);
 if (!sheet) {
 sheet = ss.insertSheet(CORRECTION_SHEET);
 sheet.appendRow(['오인식표현', '정정표현', '등록일시']);
 }
 const existing = sheet.getDataRange().getValues();
 const existingSet = {};
 for (let i = 1; i < existing.length; i++) {
 existingSet[String(existing[i][0]).trim() + '|||' + String(existing[i][1]).trim()] = true;
 }
 const now = new Date();
 pairs.forEach(function (p) {
 const key = p[0] + '|||' + p[1];
 if (!existingSet[key]) {
 sheet.appendRow([p[0], p[1], now]);
 existingSet[key] = true;
 }
 });
 }

 function getCorrectionListText() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(CORRECTION_SHEET);
 if (!sheet) return '';
 const data = sheet.getDataRange().getValues();
 if (data.length <= 1) return '';
 const lines = [];
 for (let i = 1; i < data.length; i++) {
 const wrong = String(data[i][0]).trim();
 const right = String(data[i][1]).trim();
 if (wrong && right) lines.push('- "' + wrong + '" -> "' + right + '"');
 }
 return lines.join('\n');
 }

 // ==== 관리자용: 테스트로 쌓인 중복 품목 정리 ====
 // 기준: 품목코드가 아니라 (품목명 + 규격 + 단위 + 거래처명)이 같으면 중복으로 간주.
 // Apps Script 편집기에서 이 함수를 선택하고 [Run] 버튼으로 한 번 실행하면 됩니다.
 function dedupeMasterSheet() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(MASTER_SHEET);
 const data = sheet.getDataRange().getValues();
 if (data.length <= 1) { Logger.log('데이터 없음'); return; }

 const header = data[0];
 const rows = data.slice(1);

 // 열 순서: 0품목코드 1품목명 2규격구분 3규격 4입고단가 5입고VAT 6단위 7품목구분 8세트여부 9재고관리 10출고단가 11출고VAT 12거래처명 13등록일시
 const seen = {};
 const order = [];
 rows.forEach(function (r) {
 const name = String(r[1]).trim();
 if (!name) return;
 const key = name + '|||' + String(r[3]).trim() + '|||' + String(r[6]).trim() + '|||' + String(r[12]).trim();
 if (!(key in seen)) order.push(key);
 seen[key] = r; // 나중에 나오는(가장 최근) 행으로 덮어씀 -> 마지막 값만 남음
 });

 // 코드 기준으로 보기 좋게 정렬
 const dedupedRows = order.map(function (k) { return seen[k]; })
 .sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });

 sheet.clearContents();
 sheet.appendRow(header);
 dedupedRows.forEach(function (r) { sheet.appendRow(r); });

 // 거래처별 마지막사용번호를 살아남은 데이터 기준으로 재계산
 const vendorSheet = ss.getSheetByName(VENDOR_SHEET);
 const vendorData = vendorSheet.getDataRange().getValues();
 const maxByPrefix = {};
 dedupedRows.forEach(function (r) {
 const m = String(r[0]).trim().match(/^([A-Za-z]+)(\d+)$/);
 if (m) {
 const p = m[1];
 const n = parseInt(m[2], 10);
 if (maxByPrefix[p] === undefined || n > maxByPrefix[p]) maxByPrefix[p] = n;
 }
 });
 for (let i = 1; i < vendorData.length; i++) {
 const prefix = String(vendorData[i][1]).trim();
 if (maxByPrefix[prefix] !== undefined) {
 vendorSheet.getRange(i + 1, 3).setValue(maxByPrefix[prefix]);
 }
 }

 Logger.log('정리 완료: ' + rows.length + '개 -> ' + dedupedRows.length + '개 (중복 ' + (rows.length - dedupedRows.length) + '개 제거)');
 }

 // ==== 관리자용 1회성 마이그레이션: 거래처코드관리 시트를 "숫자 시작코드" -> "코드접두어" 방식으로 전환 ====
 // 기존 헤더: 거래처명 | 시작코드 | 마지막사용코드 (B열이 숫자)
 // 새 헤더:   거래처명 | 코드접두어 | 마지막사용번호 (B열이 문자 접두어)
 // Claude에게 거래처명 목록을 한번에 보내서 짧고 겹치지 않는 영문 접두어를 받아 B열에 채워 넣는다.
 // C열(마지막사용코드/번호)은 그대로 유지 - 번호 이어쓰기는 그대로, 표기만 접두어가 붙는 것.
 // Apps Script 편집기에서 이 함수를 선택하고 [Run] 버튼으로 한 번만 실행하면 됩니다.
 function migrateVendorSheetToPrefixCodes() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 const data = sheet.getDataRange().getValues();
 if (data.length <= 1) { Logger.log('거래처코드관리에 데이터가 없습니다.'); return; }

 const rows = data.slice(1);
 const alreadyPrefixed = [];
 const needsPrefix = [];
 rows.forEach(function (r, i) {
 const name = String(r[0] || '').trim();
 if (!name) return;
 const col2 = String(r[1] || '').trim();
 if (/^[A-Za-z]+$/.test(col2)) {
 alreadyPrefixed.push(col2.toUpperCase());
 } else {
 needsPrefix.push({ rowIndex: i + 2, name: name });
 }
 });

 if (!needsPrefix.length) { Logger.log('이미 전부 접두어가 있습니다. 마이그레이션 필요 없음.'); return; }

 const prefixMap = generatePrefixesWithClaude(needsPrefix.map(function (r) { return r.name; }), alreadyPrefixed);

 sheet.getRange(1, 2).setValue('코드접두어');
 sheet.getRange(1, 3).setValue('마지막사용번호');

 needsPrefix.forEach(function (r) {
 const prefix = prefixMap[r.name] || matchPrefix(r.name) || 'ETC';
 sheet.getRange(r.rowIndex, 2).setValue(prefix);
 });

 Logger.log('마이그레이션 완료: ' + needsPrefix.length + '개 거래처에 접두어 부여');
 }

 // ---- Claude에게 거래처명 목록 -> 짧고 겹치지 않는 영문 접두어 매핑 요청 ----
 function generatePrefixesWithClaude(vendorNames, existingPrefixes) {
 const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
 if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

 const prompt = [
 '아래는 타일/욕실자재 도매 거래처명 목록입니다. 각 거래처마다 품목코드 접두어로 쓸',
 '2~4자리 영문 대문자 약어를 만들어주세요.',
 '',
 '규칙:',
 '- 회사명에서 의미를 알아볼 수 있는 약어로 만드세요 (예: 베리굿타일앤스톤 -> VG, 대명세라믹스 -> DM).',
 '- 목록 안에서 서로 절대 겹치면 안 됩니다.',
 '- 이미 다른 곳에서 쓰고 있는 접두어와도 겹치면 안 됩니다: ' + (existingPrefixes.join(', ') || '(없음)'),
 '- 아래 JSON 객체 하나만 출력하세요. 다른 설명 없이 {"거래처명":"접두어", ...} 형식으로만.',
 '',
 JSON.stringify(vendorNames)
 ].join('\n');

 const payload = {
 model: CLAUDE_MODEL,
 max_tokens: 4000,
 messages: [{ role: 'user', content: prompt }]
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
 const firstBrace = jsonText.indexOf('{');
 const lastBrace = jsonText.lastIndexOf('}');
 if (firstBrace === -1 || lastBrace === -1) return {};
 jsonText = jsonText.substring(firstBrace, lastBrace + 1);

 try {
 const map = JSON.parse(jsonText);
 const upper = {};
 Object.keys(map).forEach(function (k) { upper[k] = String(map[k]).toUpperCase().replace(/[^A-Z]/g, ''); });
 return upper;
 } catch (e) {
 Logger.log('접두어 생성 응답 파싱 실패: ' + jsonText);
 return {};
 }
 }

 function matchPrefix(vendorName) {
 for (let i = 0; i < VENDOR_PREFIX_MAP.length; i++) {
 if (vendorName.indexOf(VENDOR_PREFIX_MAP[i].keyword) !== -1) return VENDOR_PREFIX_MAP[i].prefix;
 }
 return null;
 }

 function extractWithClaude(fileBase64, mimeType, isRetry) {
 const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
 if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

 const correctionText = getCorrectionListText();
 const correctionBlock = correctionText
 ? ['', '[과거 교정 이력 - 우선 참고]',
 '아래는 과거에 사람이 직접 오타를 고친 이력입니다. 문서에서 이와 비슷하게 애매하게 보이는 표현이 나오면, 아래 정정표현을 우선적으로 사용하세요.',
 correctionText, '']
 : [''];

 const systemPrompt = [
 '당신은 타일/욕실자재 매출처별 거래원장(거래명세서) PDF 또는 이미지에서 거래처명과 품목을 추출하는 도우미입니다.',
 ''
 ].concat(correctionBlock).concat([
 '[거래처명 인식 - 매우 중요]',
 '- "거래처명:" 라벨 옆에는 대부분 구매자 쪽 회사인 "히트타일", "히트타일(대구)" 등이 적혀 있습니다. 이것은 절대 vendorName으로 쓰지 마세요.',
 '- 실제로 추출해야 할 거래처명은 "공급처명:" 또는 "공급자명:" 라벨 옆에 적힌 회사입니다.',
 '',
 '[품목명 정확도 - 매우 중요]',
 '- 화질이 흐리거나 손글씨라서 애매하면, 욕실자재/타일업계 표준 용어(양변기, 세면대, 수전, 수건걸이, 휴지걸이, 욕조, 욕실장, 파티션, 환풍기, 투피스, 원피스 등)와 비교해서 가장 자연스러운 실제 단어로 교정하세요.',
 '- 이미지를 억지로 음차하지 말고 실제 존재하는 제품명/업계 용어로 정정하세요.',
 '',
 '[품목 추출 규칙]',
 '1. "일 계", "일계", "월별집계", "월계", "합 계", "이월", "수입", "입금", "출금", "통장결제", "예금", "DC처리", 잔액, 계좌 안내 문구 등 소계/입출금/안내 행은 무시하고 실제 품목 거래 행만 추출합니다. 금액이 0원이거나 품목명이 결제/입금 관련 단어인 행은 절대 품목으로 넣지 마세요.',
 '2. 품목명은 색상/모델 코드(#, 로트번호, 배치코드 등)는 제외한 핵심 품목명만 추출합니다.',
 '3. 같은 (품목명, 규격, 단위) 조합이 여러 번 나오면 하나로 합치되, 가장 나중 날짜의 단가를 사용합니다.',
 '4. 단가×수량 값을 "공급가액"·"합계금액"과 비교해서 부가세 포함/별도 여부를 판단하고, 부가세 포함 단가만 확인 가능하면 그 값을 사용합니다.',
 '5. 최종 단가는 100원 단위로 반올림합니다.',
 '6. 반품/마이너스 수량 행도 같은 품목이면 동일 품목으로 취급합니다.',
 '7. 문서가 여러 페이지여도 전체를 끝까지 분석해서 모든 품목을 빠짐없이 추출하세요.',
 '8. 응답은 반드시 아래 JSON 형식 단 하나만 출력합니다. 다른 텍스트는 한 글자도 포함하지 마세요.',
 '9. 매우 중요 - JSON 문법 준수: 품목명이나 규격 안에 큰따옴표(")가 들어가야 하는 경우(예: 인치 표시 24", 6" 등), 반드시 백슬래시로 이스케이프해서 \\" 로 표기하세요. 절대 이스케이프 없이 " 를 문자열 중간에 그냥 넣지 마세요. 가능하면 인치(")보다는 숫자와 mm/cm 단위로 표기해서 큰따옴표 자체를 피하는 것을 권장합니다.',
 '{"vendorName":"거래처 상호명","items":[{"name":"품목명","spec":"규격(없으면 빈 문자열)","unit":"단위","price":숫자}]}'
 ]).join('\n');

 const contentBlock = mimeType === 'application/pdf'
 ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
 : { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBase64 } };

 const payload = {
 model: CLAUDE_MODEL,
 max_tokens: 16000,
 system: systemPrompt,
 messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: '이 문서에서 거래처명과 품목을 규칙대로 추출해서 JSON 객체만 출력해줘.' }] }]
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

 const textBlock = (data.content || []).find(function (c) { return c.type === 'text'; });
 let jsonText = textBlock ? textBlock.text : '{}';
 jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();

 const firstBrace = jsonText.indexOf('{');
 const lastBrace = jsonText.lastIndexOf('}');
 if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
 throw new Error('Claude 응답에서 JSON을 찾지 못했습니다: ' + jsonText.substring(0, 300));
 }
 jsonText = jsonText.substring(firstBrace, lastBrace + 1);

 try {
 return JSON.parse(jsonText);
 } catch (e) {
 if (!isRetry) {
 // JSON이 깨졌을 때 한 번만 자동으로 다시 시도
 return extractWithClaude(fileBase64, mimeType, true);
 }
 throw new Error('JSON 파싱 실패 (재시도 후에도 실패): ' + e.message);
 }
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
 return { rowIndex: i + 1, storedName: stored.trim(), prefix: String(data[i][1]).trim(), lastUsed: Number(data[i][2]) || 0 };
 }
 }
 return null;
 }

 // ---- 같은 코드 접두어(예: HIK)를 쓰는 모든 거래처명 행 중 최대번호 조회 ----
 // (한 회사가 사업자 2개로 나뉘어 전표가 오는 경우, 접두어만 같으면 번호를 공유하기 위함)
 function getMaxLastUsedForPrefix(prefix) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 const data = sheet.getDataRange().getValues();
 const target = String(prefix).trim().toUpperCase();
 let max = 0;
 for (let i = 1; i < data.length; i++) {
 if (String(data[i][1]).trim().toUpperCase() === target) {
 const n = Number(data[i][2]) || 0;
 if (n > max) max = n;
 }
 }
 return max;
 }

 // ---- 같은 접두어를 쓰는 모든 행을 동일한 마지막번호로 동기화 ----
 function saveLastUsedByPrefix(prefix, lastNumber) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 const data = sheet.getDataRange().getValues();
 const target = String(prefix).trim().toUpperCase();
 for (let i = 1; i < data.length; i++) {
 if (String(data[i][1]).trim().toUpperCase() === target) {
 sheet.getRange(i + 1, 3).setValue(lastNumber);
 }
 }
 }

 function assignCodesAndPrices(items, prefix, startNumber) {
 return items.map(function (it, i) {
 const numberPart = startNumber + i;
 const code = prefix + String(numberPart).padStart(CODE_DIGITS, '0');
 const inPrice = Math.round(Number(it.price) / 100) * 100;
 const outPrice = Math.round((inPrice * 1.5) / 100) * 100;
 return {
 code: code, name: it.name, specType: it.spec ? '사이즈' : '', spec: it.spec || '',
 inPrice: inPrice, inVat: 'Y', unit: it.unit,
 category: it.unit === 'SET' ? 'SET상품' : '자재',
 isSet: it.unit === 'SET' ? 'Y' : 'N', stockMgmt: 'Y',
 outPrice: outPrice, outVat: 'Y'
 };
 });
 }

 function appendToMasterSheet(vendorName, rows) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(MASTER_SHEET);
 const now = new Date();
 rows.forEach(function (r) {
 sheet.appendRow([
 r.code, r.name, r.specType, r.spec, r.inPrice, r.inVat,
 r.unit, r.category, r.isSet, r.stockMgmt, r.outPrice, r.outVat, vendorName, now
 ]);
 });
 }
