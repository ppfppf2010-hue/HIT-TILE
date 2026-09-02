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
   '원본품목명(자동,수정금지)', '원본규격(자동,수정금지)', '사업자번호(자동,수정금지)'];

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
 if (action === 'purchase_register_vendor') return handlePurchaseRegisterVendor(body);
 if (action === 'purchase_confirm') return handlePurchaseConfirm();
 if (action === 'purchase_retry_ecount') return handlePurchaseRetryEcount(body);
 if (action === 'create_order') return handleCreateOrder(body);
 if (action === 'delivery_extract') return handleDeliveryExtract(body);
 if (action === 'save_invoice') return handleSaveInvoice(body);
 if (action === 'save_payment') return handleSavePayment(body);
 if (action === 'save_delivery') return handleSaveDelivery(body);
 if (action === 'save_return') return handleSaveReturn(body);
 if (action === 'save_return_schedule') return handleSaveReturnSchedule(body);
 if (action === 'save_password') return handleSavePassword(body);
 if (action === 'save_delivery_photo') return handleSaveDeliveryPhoto(body);
 if (action === 'sync_calendar_deliveries') return handleSyncCalendarDeliveries();
 if (action === 'delete_order') return handleDeleteOrder(body);
 if (action === 'save_balances') return handleSaveBalances(body);
 if (action === 'add_correction') return handleAddCorrection(body);
 if (action === 'list_vendor_names') return handleListVendorNames();
 if (action === 'list_item_master') return handleListItemMaster();
 if (action === 'check_vendor') return handleCheckVendor(body);
 if (action === 'sale_register_vendor') return handleSaleRegisterVendor(body);
 if (action === 'sale_manual_entry') return handleSaleManualEntry(body);
 if (action === 'sale_confirm') return handleSaleConfirm();
 if (action === 'list_sale_vendor_names') return handleListSaleVendorNames();
 if (action === 'list_sale_vendor_contacts') return handleListSaleVendorContacts();
 if (action === 'sale_check_vendor') return handleCheckSaleVendor(body);
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
 if (/히트\s*타일|HIT\s*타일/i.test(parsed.vendorName)) {
 throw new Error('공급업체명이 아니라 구매자(히트타일)로 잘못 인식되었습니다. 문서에 "공급처명" 표기가 잘 보이는지 확인해주세요.');
 }
 if (!parsed.items || parsed.items.length === 0) throw new Error('문서에서 품목을 찾지 못했습니다.');

 const vendorInfo = findVendor(parsed.vendorName);

 if (vendorInfo) {
 // 이미 마스터에 있는 품목(이름/규격이 같거나 오타 수준으로 비슷한 것 포함)은 다시 등록하지 않고 걸러낸다.
 const dedup = dedupeAgainstMaster(parsed.items, vendorInfo.storedName);
 if (!dedup.newItems.length) {
 return jsonOut({ ok: true, isNewVendor: false, vendorName: vendorInfo.storedName, count: 0, allExisting: true, skippedCount: dedup.skipped.length, skipped: dedup.skipped });
 }
 // 같은 접두어를 쓰는 다른 거래처명 행(예: 같은 회사의 다른 사업자)이 더 앞서있을 수 있으므로
 // 그 접두어 전체의 최대번호와 비교해서 더 큰 쪽을 시작번호로 사용한다.
 const sharedMax = getMaxLastUsedForPrefix(vendorInfo.prefix);
 const startNumber = Math.max(vendorInfo.lastUsed, sharedMax) + 1;
 // 시트에 저장된 원래 표기(storedName)를 사용해서 이후 저장되는 거래처명 표기를 통일시킨다.
 const previewRows = assignCodesAndPrices(dedup.newItems, vendorInfo.prefix, startNumber, vendorInfo.storedName);
 const reviewUrl = stageForReview(vendorInfo.storedName, previewRows, vendorInfo.businessNo || '');
 return jsonOut({ ok: true, isNewVendor: false, vendorName: vendorInfo.storedName, reviewUrl: reviewUrl, count: previewRows.length, skippedCount: dedup.skipped.length, skipped: dedup.skipped });
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

 // ---- 추출된 품목 중 이미 마스터에 등록된 것과, 같은 문서 안에서 중복 언급된 것을 걸러낸다 ----
 function dedupeAgainstMaster(items, vendorName) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 const masterData = masterSheet ? masterSheet.getDataRange().getValues() : [];
 const newItems = [];
 const skipped = [];
 const seenInBatch = {};
 items.forEach(function (it) {
 const match = findMasterItem(masterData, vendorName, it.name, it.price, it.spec);
 if (match) {
 skipped.push({ name: it.name, matchedCode: match.code, matchedName: match.name, reason: '이미 등록됨' });
 return;
 }
 const batchKey = normalizeItemName(tileCoreName(it.name)) + '|||' + normalizeItemName(it.spec || '');
 if (seenInBatch[batchKey]) {
 skipped.push({ name: it.name, matchedCode: '', matchedName: it.name, reason: '같은 문서 내 중복' });
 return;
 }
 seenInBatch[batchKey] = true;
 newItems.push(it);
 });
 return { newItems: newItems, skipped: skipped };
 }

 // ---- 2) 신규 거래처: 접두어 확정 -> 검토중 시트에 씀 ----
 function handlePreviewNew(body) {
 const vendorName = (body.vendorName || '').trim();
 const prefix = (body.prefix || '').trim().toUpperCase();
 const businessNo = (body.businessNo || '').trim();
 const rawItems = body.rawItems;
 if (!vendorName) throw new Error('거래처명이 없습니다.');
 if (!prefix) throw new Error('코드 접두어를 입력해주세요.');
 if (!rawItems || !rawItems.length) throw new Error('품목 데이터가 없습니다.');

 // 혹시 이미 등록된(표기만 다른) 거래처라면 새로 만들지 않고 기존 번호를 이어서 쓴다.
 const existing = findVendor(vendorName);
 const finalVendorName = existing ? existing.storedName : vendorName;
 const finalPrefix = existing ? existing.prefix : prefix;
 const finalBusinessNo = existing ? (existing.businessNo || businessNo) : businessNo;

 const dedup = dedupeAgainstMaster(rawItems, finalVendorName);
 if (!dedup.newItems.length) {
 return jsonOut({ ok: true, count: 0, allExisting: true, skippedCount: dedup.skipped.length, skipped: dedup.skipped });
 }

 // 거래처명은 처음 보더라도, 같은 코드 접두어(예: HIK)를 이미 다른 거래처명(다른 사업자)이
 // 쓰고 있다면 그 접두어의 최대번호 다음부터 이어간다. (한 회사가 사업자 2개로 나뉜 경우 대응)
 const sharedMax = getMaxLastUsedForPrefix(finalPrefix);
 const startNumber = Math.max(existing ? existing.lastUsed : 0, sharedMax) + 1;

 const previewRows = assignCodesAndPrices(dedup.newItems, finalPrefix, startNumber, finalVendorName);
 const reviewUrl = stageForReview(finalVendorName, previewRows, finalBusinessNo);
 return jsonOut({ ok: true, count: previewRows.length, reviewUrl: reviewUrl, skippedCount: dedup.skipped.length, skipped: dedup.skipped });
 }

 // ---- '검토중' 탭에 미리보기 기록 ----
 // businessNo(사업자등록번호)는 신규 거래처일 때만 의미가 있고, 화면엔 안 보이는 숨김열에 실어뒀다가
 // handleConfirm에서 거래처를 실제로 등록할 때 함께 저장하고 이카운트 동기화에도 사용한다.
 function stageForReview(vendorName, rows, businessNo) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(REVIEW_SHEET);
 if (!sheet) sheet = ss.insertSheet(REVIEW_SHEET);
 sheet.clear();

 sheet.appendRow(REVIEW_HEADERS);
 rows.forEach(function (r) {
 sheet.appendRow([r.code, r.name, r.specType, r.spec, r.inPrice, r.inVat,
 r.unit, r.category, r.isSet, r.stockMgmt, r.outPrice, r.outVat, vendorName,
 r.name, r.spec, businessNo || '']); // 마지막 3개는 숨김열 (원본값 2개 + 사업자번호)
 });

 sheet.setFrozenRows(1);
 try { sheet.autoResizeColumns(1, 13); } catch (e) { /* ignore */ }
 try { sheet.hideColumns(14, 3); } catch (e) { /* ignore */ }
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
 const reviewBusinessNo = String(rows[0][15] || '').trim();

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
 let vendorInfo = findVendor(vendorName);
 if (vendorInfo) {
 const newMax = Math.max(maxNumber, vendorInfo.lastUsed, getMaxLastUsedForPrefix(vendorInfo.prefix));
 saveLastUsedByPrefix(vendorInfo.prefix, newMax);
 } else if (prefix) {
 const newMax = Math.max(maxNumber, getMaxLastUsedForPrefix(prefix));
 ss.getSheetByName(VENDOR_SHEET).appendRow([vendorName, prefix, newMax, reviewBusinessNo]);
 saveLastUsedByPrefix(prefix, newMax);
 vendorInfo = { storedName: vendorName, prefix: prefix, lastUsed: newMax, businessNo: reviewBusinessNo };
 }

 // 검토중 시트는 헤더만 남기고 비움
 sheet.clear();
 sheet.appendRow(REVIEW_HEADERS);
 sheet.setFrozenRows(1);

 // ---- 이카운트 중계서버로 거래처/품목 동기화 (실패해도 시트 저장은 이미 끝났으므로 결과만 담아 돌려준다) ----
 const ecountVendorResult = ecountSyncVendor(vendorName, vendorInfo ? vendorInfo.businessNo : reviewBusinessNo);
 const ecountItemResults = items.map(function (it) {
 return { code: it.code, result: ecountSyncItem(it) };
 });

 return jsonOut({ ok: true, vendorName: vendorName, items: items, savedCount: items.length,
 ecount: { vendor: ecountVendorResult, items: ecountItemResults } });
 }

 // ---- 교정사전에 한 쌍 수동 등록 (예: 거래처 별칭 -> 등록된 정식 거래처명) ----
 function handleAddCorrection(body) {
 const wrong = String(body.wrong || '').trim();
 const right = String(body.right || '').trim();
 if (!wrong || !right) throw new Error('wrong/right 값이 모두 필요합니다.');
 saveCorrections([[wrong, right]]);
 return jsonOut({ ok: true });
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

 // ---- 교정사전을 {오인식표현: 정정표현} 맵으로 반환 (품목등록/구매등록/배송관리 공용) ----
 function getCorrectionMap() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(CORRECTION_SHEET);
 const map = {};
 if (!sheet) return map;
 const data = sheet.getDataRange().getValues();
 for (let i = 1; i < data.length; i++) {
 const wrong = String(data[i][0] || '').trim();
 const right = String(data[i][1] || '').trim();
 if (wrong && right) map[wrong] = right;
 }
 return map;
 }

 // ---- Claude가 추출한 품목명/규격에 교정사전을 결정적으로 적용 ----
 // 프롬프트에 교정 이력을 알려줘도 Claude가 항상 그대로 따르진 않으므로,
 // 정확히 일치하는 과거 오인식 표현은 이 단계에서 무조건 치환해 신뢰도를 보장한다.
 function applyCorrectionDictionary(items) {
 if (!items || !items.length) return items;
 const map = getCorrectionMap();
 if (!Object.keys(map).length) return items;
 items.forEach(function (it) {
 if (it.name) {
 const key = String(it.name).trim();
 if (map[key]) it.name = map[key];
 }
 if (it.spec) {
 const key = String(it.spec).trim();
 if (map[key]) it.spec = map[key];
 }
 });
 return items;
 }

 // ---- 품목명 정규화: 공백/구분기호/대소문자 차이를 무시하고 비교하기 위한 헬퍼 ----
 function normalizeItemName(name) {
 return String(name || '')
 .replace(/\s+/g, '')
 .replace(/[\/\-_.]/g, '')
 .toUpperCase();
 }

 // ---- 타일 품목명 앞에 붙은 규격 접두어를 규격/이름으로 분리 ----
 // 1) "60*60포셀린_LC LC GH 힐릭스 샌드-600" -> {spec:"60*60포셀린_LC", name:"LC GH 힐릭스 샌드-600"} (포셀린 표기는 그대로 규격에 둠)
 // 2) "30*60CH(FG) HS 비비드 아이보리" -> {spec:"300*600", name:"HS 비비드 아이보리"} (CH(FG)/바닥/CTM/폴리/MULIA 같은 접두어는 떼어내고, cm 표기(30*60)를 mm(300*600)로 환산)
 // 사이즈 표기가 붙은 품목명은 전부 타일이고, 규격을 이름에서 떼어 spec에 두는 게 정식 표기다.
 const TILE_SIZE_PREFIX_RE = /^(\d+\s*[*×xX]\s*\d+\s*포셀린(?:\([^)]*\))?[A-Za-z0-9_]*)\s+(.+)$/;
 const TILE_TYPE_SUFFIX_RE = /^(\d{2,3})\s*[*×xX]\s*(\d{2,3})\s*[A-Za-z가-힣()]*\s+(.+)$/;
 function splitTileSizePrefix(name) {
 const s = String(name || '');
 const m1 = s.match(TILE_SIZE_PREFIX_RE);
 if (m1) return { spec: m1[1].trim(), name: m1[2].trim() };

 // cm 단위 타일 사이즈만 인정(15~130) - 46파이 유가/트랩 같은 mm 단위 부속품(600*70 등)을 오인하지 않도록 범위를 제한
 const m2 = s.match(TILE_TYPE_SUFFIX_RE);
 if (m2) {
 const w = parseInt(m2[1], 10), h = parseInt(m2[2], 10);
 if (w >= 15 && w <= 130 && h >= 15 && h <= 130 && m2[3].trim()) {
 return { spec: (w * 10) + '*' + (h * 10), name: m2[3].trim() };
 }
 }
 return null;
 }

 // ---- 비교/저장용: 타일이면 사이즈 접두어를 뗀 핵심 이름만 반환 (구식/신식 표기를 같은 값으로 취급) ----
 function tileCoreName(name) {
 const split = splitTileSizePrefix(name);
 return split ? split.name : String(name || '').trim();
 }

 // ---- 마스터에서 찾은 매칭 결과를 정식 표기(규격 분리)로 정리해서 반환 ----
 function normalizeMasterMatch(row) {
 let name = row[1], spec = row[3];
 if (!spec) {
 const split = splitTileSizePrefix(name);
 if (split) { name = split.name; spec = split.spec; }
 }
 return { code: row[0], name: name, spec: spec, inPrice: Number(row[4]) || 0, outPrice: Number(row[10]) || 0 };
 }

 // ---- 편집거리(Levenshtein distance): 오타 몇 글자 차이 정도를 재기 위한 헬퍼 ----
 function levenshteinDistance(a, b) {
 a = String(a || ''); b = String(b || '');
 const m = a.length, n = b.length;
 if (m === 0) return n;
 if (n === 0) return m;
 let prevRow = [];
 for (let j = 0; j <= n; j++) prevRow[j] = j;
 for (let i = 1; i <= m; i++) {
 const currRow = [i];
 for (let j = 1; j <= n; j++) {
 const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
 currRow[j] = Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost);
 }
 prevRow = currRow;
 }
 return prevRow[n];
 }

 // ---- 같은 품목명이라도 규격이 서로 다르면 다른 품목으로 본다 ----
 // 둘 중 하나라도 규격이 비어있으면(규격 구분이 없는 품목) 판단 보류하고 이름만으로 매칭을 허용한다.
 function specsCompatible(targetSpec, rowSpec) {
 const a = normalizeItemName(targetSpec);
 const b = normalizeItemName(rowSpec);
 if (!a || !b) return true;
 return a === b;
 }

 // ---- 품목등록마스터에서 거래처+품목명(+규격) 매칭 ----
 // 순서: 완전일치 -> 같은 거래처 정규화(공백/구두점)일치 -> 같은 거래처 오타수준(편집거리) 유사매칭 -> 거래처무관 완전일치
 // 교정사전은 "예전에 정확히 이 오타를 본 적 있을 때"만 잡지만, 이건 마스터에 이미 등록된 진짜 품목명과
 // 한두 글자만 다른(예: "천정제(MS)평" vs "천정제(MS)병") 처음 보는 오인식도 그 자리에서 바로 잡아준다.
 // price가 주어지면, 편집거리가 같은 후보가 여럿일 때 가격이 더 가까운 쪽을 우선한다.
 // spec이 주어지면, 이름이 같아도 규격이 서로 다르면(둘 다 값이 있을 때) 다른 품목으로 취급해서
 // 같은 품명·다른 규격 품목이 같은 코드로 잘못 합쳐지는 걸 막는다.
 // ---- 후보 행 집합(rows) 안에서 이름/규격 기준으로 품목을 찾는 공통 매칭 로직 (거래처 범위는 호출자가 결정) ----
 function matchItemInRows(rows, itemName, price, spec) {
 const targetExact = String(itemName || '').trim();
 const targetCore = tileCoreName(itemName);
 const targetNorm = normalizeItemName(targetCore);
 if (!targetExact) return null;

 for (let i = 0; i < rows.length; i++) {
 const row = rows[i];
 if (String(row[1] || '').trim() === targetExact && specsCompatible(spec, row[3])) return normalizeMasterMatch(row);
 }
 // 정규화일치: 공백/구두점 차이는 물론, 타일 사이즈 접두어가 이름/규격 중 어디 붙어있든(구식/신식 표기) 같은 값으로 본다.
 for (let i = 0; i < rows.length; i++) {
 const row = rows[i];
 if (normalizeItemName(tileCoreName(row[1])) === targetNorm && specsCompatible(spec, row[3])) return normalizeMasterMatch(row);
 }

 // 이름 끝에 "(...)"로 규격/옵션이 붙어있는 경우(예: "EK-3001NBM 주방수전(4WAY)") - 괄호를 뗀 나머지가
 // 기존 품목명과 완전히 같고, 괄호 안 내용이 그 품목의 기존 규격과 같거나 비슷하면 같은 품목으로 본다.
 // (완전히 다른 옵션/색상 괄호까지 잘못 합치지 않도록, 나머지 이름은 정확히 일치해야만 후보로 인정)
 const parenMatch = targetExact.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
 if (parenMatch) {
 const baseNorm = normalizeItemName(parenMatch[1].trim());
 const parenNorm = normalizeItemName(parenMatch[2].trim());
 for (let i = 0; i < rows.length; i++) {
 const row = rows[i];
 if (normalizeItemName(tileCoreName(row[1])) !== baseNorm) continue;
 const rowSpecNorm = normalizeItemName(row[3]);
 if (!rowSpecNorm || rowSpecNorm === parenNorm || levenshteinDistance(rowSpecNorm, parenNorm) <= 2) {
 return normalizeMasterMatch(row);
 }
 }
 }

 // 이름 길이의 20%(최소 1, 최대 4글자)까지만 차이를 허용 -> 진짜 다른 품목(예: "일체형변기" vs "일체형세면기")까지
 // 잘못 합쳐지는 걸 막는다. 여러 후보가 남으면 편집거리가 가장 가깝고, 같으면 가격이 가장 가까운 쪽을 고른다.
 const maxDist = Math.max(1, Math.min(4, Math.ceil(targetNorm.length * 0.2)));
 let best = null, bestDist = Infinity, bestPriceDiff = Infinity;
 for (let i = 0; i < rows.length; i++) {
 const row = rows[i];
 const rowNorm = normalizeItemName(tileCoreName(row[1]));
 if (!rowNorm) continue;
 if (!specsCompatible(spec, row[3])) continue;
 const dist = levenshteinDistance(targetNorm, rowNorm);
 if (dist > maxDist) continue;
 const priceDiff = price ? Math.abs((Number(row[4]) || 0) - Number(price)) : 0;
 if (dist < bestDist || (dist === bestDist && priceDiff < bestPriceDiff)) {
 best = row; bestDist = dist; bestPriceDiff = priceDiff;
 }
 }
 return best ? normalizeMasterMatch(best) : null;
 }

 function findMasterItem(masterData, vendorName, itemName, price, spec) {
 const targetVendor = normalizeVendorName(vendorName);
 const sameVendorRows = [];
 for (let i = 0; i < masterData.length; i++) {
 const row = masterData[i];
 if (normalizeVendorName(String(row[12] || '')) === targetVendor) sameVendorRows.push(row);
 }

 const scoped = matchItemInRows(sameVendorRows, itemName, price, spec);
 if (scoped) return scoped;

 // 거래처 무관 완전일치(최후 수단)
 const targetExact = String(itemName || '').trim();
 if (!targetExact) return null;
 for (let i = 0; i < masterData.length; i++) {
 const row = masterData[i];
 if (String(row[1] || '').trim() === targetExact && specsCompatible(spec, row[3])) {
 return normalizeMasterMatch(row);
 }
 }
 return null;
 }

 // ---- 배송용: 배송일정의 "업체명"은 배송받는 고객사일 뿐 품목등록마스터의 거래처명(매입처)과는
 // 무관한 값이라, 거래처로 좁히지 않고 마스터 전체에서 findMasterItem과 같은 유사매칭을 적용한다. ----
 function findMasterItemAnyVendor(masterData, itemName, price, spec) {
 return matchItemInRows(masterData, itemName, price, spec);
 }

 // ---- 판매용: matchItemInRows가 편집거리 한도를 넘겨서 후보를 못 찾았어도, 마스터 전체에서
 // 편집거리가 가장 가까운 하나를 무조건 골라준다 (판매는 신규 품목 등록이 없어 항상 기존 품목
 // 코드가 필요하기 때문 - 정확도가 떨어지는 경우엔 검토 화면에서 사람이 확인/수정한다). ----
 function findClosestMasterItemAnyVendor(masterData, itemName, spec) {
 const targetNorm = normalizeItemName(tileCoreName(itemName));
 if (!targetNorm) return null;
 let best = null, bestDist = Infinity;
 for (let i = 0; i < masterData.length; i++) {
 const row = masterData[i];
 const rowNorm = normalizeItemName(tileCoreName(row[1]));
 if (!rowNorm) continue;
 const dist = levenshteinDistance(targetNorm, rowNorm);
 if (dist < bestDist) { best = row; bestDist = dist; }
 }
 return best ? normalizeMasterMatch(best) : null;
 }

 // ---- 배송용: 추출된 품목명/규격을 마스터 등록 품목과 대조해서 이미 알려진 표기로 자동 보정 ----
 // 배송일정의 "업체명"은 배송받는 고객사일 뿐 매입 거래처와는 무관해서 거래처로 좁히지 않는다.
 // 매칭 여부(matched)와 품목코드(code)도 함께 표시해서, 화면에서 품목등록마스터 시트와 대조 확인할 수 있게 한다.
 function applyMasterCatalogMatchAnyVendor(items) {
 if (!items || !items.length) return items;
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 if (!masterSheet) return items;
 const masterData = masterSheet.getDataRange().getValues();
 items.forEach(function (it) {
 if (!it.name) { it.matched = false; it.code = ''; return; }
 const match = findMasterItemAnyVendor(masterData, it.name, it.price, it.spec);
 if (match) {
 it.name = match.name;
 if (match.spec) it.spec = match.spec;
 it.matched = true;
 it.code = match.code;
 } else {
 it.matched = false;
 it.code = '';
 }
 });
 return items;
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

 // ==== 관리자용 1회성 마이그레이션: 거래처코드관리 시트에 사업자등록번호 헤더 추가 ====
 // 이카운트 연동(register-vendor)에 businessNo가 필요해져서 D열을 새로 씀. 기존 행의 D열은 비워둬도
 // 동작에는 문제없고(그 거래처는 이카운트 동기화만 건너뜀), 새로 등록되는 거래처부터 자동으로 채워진다.
 // Apps Script 편집기에서 이 함수를 선택하고 [Run] 버튼으로 한 번만 실행하면 됩니다.
 function addVendorBusinessNoHeader() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 if (!sheet) { Logger.log('거래처코드관리 시트를 찾을 수 없습니다.'); return; }
 sheet.getRange(1, 4).setValue('사업자등록번호');
 Logger.log('완료: D1에 "사업자등록번호" 헤더를 추가했습니다.');
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
 '- 이런 라벨이 아예 안 보이는 문서도 있습니다("거래처별 원장" 형식 등). 이 경우 문서 하단의 계좌 안내문(예: "OOO 당사는 이 계좌 외 입금은 받지않습니다")에 적힌 회사명이 실제 공급자이니, 그 이름을 vendorName으로 쓰세요.',
 '- 또는 각 페이지 맨 아래에 "(회사명), TEL) 000-000-0000 FAX) 000-000-0000" 형태의 꼬리말이 반복해서 찍혀 있는 문서도 있습니다("매출처원장" 등). 이런 경우 그 꼬리말에 적힌 회사명이 이 문서를 발행한 공급자이니, 그 이름을 vendorName으로 쓰세요.',
 '',
 '[품목명 정확도 - 매우 중요]',
 '- 화질이 흐리거나 손글씨라서 애매하면, 욕실자재/타일업계 표준 용어(양변기, 세면대, 수전, 수건걸이, 휴지걸이, 욕조, 욕실장, 파티션, 환풍기, 투피스, 원피스 등)와 비교해서 가장 자연스러운 실제 단어로 교정하세요.',
 '- 이미지를 억지로 음차하지 말고 실제 존재하는 제품명/업계 용어로 정정하세요.',
 '',
 '[품목 추출 규칙]',
 '1. "일 계", "일계", "월별집계", "월계", "합 계", "이월", "수입", "입금", "출금", "통장결제", "예금", "DC처리", 잔액, 계좌 안내 문구 등 소계/입출금/안내 행은 무시하고 실제 품목 거래 행만 추출합니다. 금액이 0원이거나 품목명이 결제/입금 관련 단어인 행은 절대 품목으로 넣지 마세요.',
 '2. 품목명 끝에 따로 붙는 색상/모델 코드(#, 로트번호, 배치코드 등)는 제외한 핵심 품목명만 추출합니다. 단, "에트나]댐퍼슬라이드장1300*800", "세원]SUS 휴지걸이"처럼 품목명 맨 앞에 "브랜드명]" 형태로 붙은 제조사/브랜드 표기는 코드가 아니라 품목명의 일부이므로 절대 빼지 말고 대괄호(])까지 통째로 그대로 포함해서 추출하세요.',
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
 // thinking을 끄고 32000이면 큰 문서(24페이지급)도 한 번에 끝까지 추출됨(Purchase.js에서 실측 확인).
 max_tokens: 32000,
 thinking: { type: 'disabled' },
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
 const parsed = JSON.parse(jsonText);
 applyCorrectionDictionary(parsed.items);
 return parsed;
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
 // 교정사전에 등록된 별칭(예: 문서엔 "화신세라믹"인데 실제 등록은 "(주) H.S 세라믹")도 여기서 함께 흡수한다.
 function findVendor(vendorName) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 const data = sheet.getDataRange().getValues();
 const correctionMap = getCorrectionMap();
 const rawKey = String(vendorName || '').trim();
 let correctedName = correctionMap[rawKey];
 if (!correctedName) {
 // Claude가 매번 표기를 살짝 다르게 뽑을 수 있어(공백/(주) 위치 등), 정규화 비교로도 교정사전을 확인한다.
 const normKey = normalizeVendorName(vendorName);
 for (const wrong in correctionMap) {
 if (normalizeVendorName(wrong) === normKey) { correctedName = correctionMap[wrong]; break; }
 }
 }
 correctedName = correctedName || vendorName;
 const target = normalizeVendorName(correctedName);

 for (let i = 1; i < data.length; i++) {
 const stored = String(data[i][0]);
 if (stored.trim() === String(correctedName).trim() || normalizeVendorName(stored) === target) {
 return {
 rowIndex: i + 1, storedName: stored.trim(), prefix: String(data[i][1]).trim(), lastUsed: Number(data[i][2]) || 0,
 businessNo: String(data[i][3] || '').trim(),
 // 이카운트 실제 거래처코드(사업자번호가 아닌 내부 코드인 경우가 많음) - E열. 채워져 있으면
 // 이 값이 사업자번호보다 우선하는 진짜 CUST_CD다 (importPurchaseVendorEcountCodes 참고).
 ecountCode: String(data[i][4] || '').trim()
 };
 }
 }
 return null;
 }

 // ---- 이카운트 "거래처등록" 내보내기 목록으로 거래처코드관리 시트의 이카운트거래처코드(E열)를
 //      일괄로 채워 넣는다 (한 번만 실행). ----
 // 이카운트 거래처코드는 사업자등록번호가 아닌 내부 코드인 경우가 많아서(예: 신양상사=00122),
 // 매입전표를 보낼 때 이름만으로 매칭에 기대면 표기 차이로 엉뚱한 거래처에 붙을 수 있다.
 // 이미 거래처코드관리에 등록된 거래처만 대상으로 하고(새 거래처를 만들지 않음), 이름이
 // normalizeVendorName 기준으로 정확히 일치하는 경우에만 채운다 - 애매하면 그냥 건너뛴다.
 // 사업자등록번호(D열)는 비어있고 export의 코드가 "XXX-XX-XXXXX" 형식일 때만 같이 채운다.
 // 실행 후 "이카운트코드_확인필요" 시트에 매칭 못 한 우리 쪽 거래처명을 남겨두니,
 // 그 목록을 보고 이카운트 쪽 실제 표기와 대조해서 수동으로 채워주면 된다.
 // 사용법: Apps Script 편집기에서 이 함수를 선택하고 [Run] 버튼으로 한 번 실행하면 됩니다.
 function importPurchaseVendorEcountCodes() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 if (!sheet) throw new Error(VENDOR_SHEET + ' 시트를 찾을 수 없습니다.');

 if (String(sheet.getRange(1, 5).getValue() || '').trim() !== '이카운트거래처코드') {
 sheet.getRange(1, 5).setValue('이카운트거래처코드');
 }

 const data = sheet.getDataRange().getValues();
 const byNorm = {};
 for (let i = 1; i < data.length; i++) {
 const name = String(data[i][0] || '').trim();
 if (!name) continue;
 byNorm[normalizeVendorName(name)] = { rowIndex: i + 1, businessNo: String(data[i][3] || '').trim(), ecountCode: String(data[i][4] || '').trim() };
 }

 const exportRows =
[['00122','(유)신양상사 대구영업소','',''],
 ['502-81-88501','(주) 에스지세라 / SG','이상길',''],
 ['504-86-00961','(주) 제이씨세라믹 / JC','',''],
 ['504-81-28829','(주)대영셀콤','오석환',''],
 ['7478600156','(주)도무스메탈','',''],
 ['5028189529','(주)디자인디오스','정수표',''],
 ['00130','(주)무진타일','',''],
 ['5038179062','(주)아인','안수경',''],
 ['4048702477','(주)하이홈','정성미',''],
 ['00181','CREER DESIGN','','010-2531-0900'],
 ['3932001345','LX지인 달서점 스타일하우스','이정희',''],
 ['502-24-16867','가가인테리어','이광섭','010-2533-0802'],
 ['463-30-00509','가람인테리어','임태원','053-742-0431'],
 ['00066','가온바스','',''],
 ['8040103158','개성인테리어','유영환','01020515150'],
 ['00031','개인','',''],
 ['00145','개인 (레이백)','',''],
 ['00184','개인 010 4033 8392','',''],
 ['00118','개인 010-','',''],
 ['00136','개인 010-2787-3442','',''],
 ['00154','개인 010-3165-7868','',''],
 ['00113','개인 010-3188-6978 (청송 신축)','',''],
 ['00147','개인 010-3437-5357 (풍림하이원)','',''],
 ['00151','개인 010-3545-7064','',''],
 ['00168','개인 010-3577-1620','',''],
 ['00156','개인 010-3938-1354','',''],
 ['00157','개인 010-3938-1354','',''],
 ['00185','개인 010-4849-4859','',''],
 ['00114','개인 010-7414-1097','',''],
 ['00175ㄴㅇㅁㅇㅁ','개인 010-7511-6175','',''],
 ['00149','개인 010-8595-1400 (동일하이빌상가)','',''],
 ['00190','개인 010-8598-4864','',''],
 ['00119','개인 010-8825-2788','',''],
 ['00123','개인 010-8825-2788','',''],
 ['00175','개인 010-8925-5860','',''],
 ['00064','개인 01097119201 화성파크드림','김화림',''],
 ['00164','개인 김경용 010-2504-5850','',''],
 ['00128','개인 김동현 010-3619-9510','',''],
 ['00125','개인 김문식 010-5024-4222','',''],
 ['00115','개인 김형욱 010-2222-9762','',''],
 ['00121','개인 김형욱 010-2222-9762','',''],
 ['00117','개인 박병희 010-7100-3445','',''],
 ['00142','개인 산격대우','',''],
 ['00170','개인 산호맨션 (010-8543-6302)','',''],
 ['00143','개인 소개','',''],
 ['00140','개인 워킹','',''],
 ['00120','개인 워킹 정보없음','',''],
 ['00173','개인 장원맨션 010-5117-5252','',''],
 ['00139','개인 정건희','',''],
 ['00134','개인 제갈환','',''],
 ['00131','개인 하영희 010-8565-2720','',''],
 ['00169','개인 허남영 (스튜디오기와) 010-4619-5083','','010-4619-5083'],
 ['00152','개인(010-4619-5083)','',''],
 ['00153','개인(010-5034-6313)','',''],
 ['00126','개인(대표님)','',''],
 ['00038','개인(만촌한화꿈에그린)','',''],
 ['00127','개인010-8908-9809','',''],
 ['00144','개인고객 연경예미지','',''],
 ['00037','개인구미현장(구.앤디자인)','',''],
 ['00039','개인김민준','',''],
 ['00048','개인김철완','','01044145222'],
 ['00180','개인도보','',''],
 ['00052','개인정기준','',''],
 ['00070','개인진천태왕01051500663','',''],
 ['00036','개인최용우','최용우','01052779163'],
 ['00063','건국도기','',''],
 ['1234567890','검증테스트거래처','',''],
 ['00059','경기도 풍경마을래미안 개인고객','',''],
 ['00062','고령예가인테리어','',''],
 ['5052120898','고운디자인','손성원',''],
 ['5571301640','공간플랜','정상훈','01088817593'],
 ['00049','광장개발','',''],
 ['409-36-01016','권패밀리','KWON SELVA','010-7455-9770'],
 ['339-11-02765','글로벌하우징','이기욱','010-38224745'],
 ['2112822928','글로우마이너','신재욱',''],
 ['00100','김동현 팀장 / 010-3619-9510','',''],
 ['00187','김동훈','',''],
 ['5052141699','꿈끝디자인인','허지연',''],
 ['7862001080','나멜','안지열','01040794868'],
 ['00179','뉴세라믹 (노블)','',''],
 ['4140794711','뉴타운인테리어','박준영',''],
 ['00065','다온','',''],
 ['00189','다원 인테리어','',''],
 ['1213792249','다희 디자인','박치현','010-6559-2636'],
 ['00020','대경목간통','',''],
 ['00041','대림바스 동국타일','',''],
 ['00046','대명','',''],
 ['00029','대왕세라믹','','0537412934'],
 ['00146','대화시멘트','','053-622-0077'],
 ['00027','더 그리다','김경진','010-4130-1993'],
 ['00061','더골드','',''],
 ['109-45-09745','더로하','한현지',''],
 ['783-29-01895','더봄디자인','배연한','010-4533-7247'],
 ['8994300881','더블유오에이 스튜디오','이상철','01099355560'],
 ['5784401001','더윈썸디자인','이창원',''],
 ['00162','더존인터내셔널 (필로토)','',''],
 ['508-81-12407','덕보건설주식회사','김정식',''],
 ['00150','덕원상사','',''],
 ['598-28-01010','데일리디자인','김건하','010-5322-9048'],
 ['836-09-02604','도도디자인','장순필','010-5820-1249'],
 ['747-86-00156','도무스메탈','김종천','031-726-9336'],
 ['225-07-96079','도빌 디자인','박태웅','010-2220-9733'],
 ['328-05-02745','도준승','백선혜','01044711000'],
 ['504-23-88604','동진종합상사','이수규','010-3529-4505'],
 ['514-13-69492','두꺼비집(지인)','강상범','010-2526-8204'],
 ['4408800754','두손종합건설','조정옥',''],
 ['102-26-67587','디어유니버스디자인','김주언','010-8940-0481'],
 ['00171','디와이하우징','',''],
 ['381-05-03046','디자인 비버','곽동훈',''],
 ['783-21-00129','디자인 우리','김성민','010-2651-4117'],
 ['3230400589','디자인 지안','박신후','01055789975'],
 ['342-14-02762','디자인80','정원우','010-3734-6676'],
 ['00030','디자인윤즈','권오주',''],
 ['268-35-00461','디자인잇 (파운데스트 디자인)','백유준',''],
 ['603-17-52718','레이백','이상민','01049407227'],
 ['4071300313','로뎀인테리어','하민철','01054440410'],
 ['207-52-00973','리바스타일&줄눈(최현우)','김지인','010-7229-3665'],
 ['502-28-90981','리바트 리첸 범어점*퀵비선불','김준현','0537591200'],
 ['8643301094','맥스터 인테리어(maxtor)','김광석','010-9576-0916'],
 ['1621502391','무돌 리하우스','김형준',''],
 ['198-48-01045','미자네 인테리어 조명','이호섭','010-4611-5044'],
 ['6624001569','미품디자인','허효섭',''],
 ['1732203104','바로 집수리','정영숙',''],
 ['765-22-01923','바로집수리 (제갈동균)','제갈동균','010-8933-8254'],
 ['1254800771','바른 타일','박재형','01087188747'],
 ['345-12-02490','바스 스미스','박영훈','010-4691-1995'],
 ['7180303171','반허제','최병길',''],
 ['00172','보성스톤','',''],
 ['00018','부강','',''],
 ['5018115418','부강상사','',''],
 ['00075','부광','',''],
 ['00135','브랜드타일','',''],
 ['6132582626','블루밍','최준우','01054086971'],
 ['3303101850','블리스퍼니처','류태환',''],
 ['00178','비버건축','',''],
 ['7788600451','삼덕본타일','서향숙,조원준',''],
 ['5140581322','삼성장식','최진환','01093616818'],
 ['00129','삼성하우징 (까사세라믹)','','010-3581-3505'],
 ['7881401940','삼현종합인테리어','이현호','01036962210'],
 ['00166','새손전기 (힘펠)','',''],
 ['3113011651','서강부동산중개','남정원',''],
 ['00005','서림상사','',''],
 ['468-54-00460','석건축디자인(욜로)','김석한','010-2808-5959'],
 ['1193071830','설렘디자인하우스','설원형','01085635582'],
 ['00132','성광종합상사','','053-767-1663'],
 ['00137','성당더샵','',''],
 ['1224003147','성심 인테리어','장윤혁','01029342727'],
 ['7570601918','성운종합인테리어','최선규','01045126104'],
 ['00014','세현','',''],
 ['00073','소년원 읍내중고등학교','',''],
 ['00028','소담인테리어','','010-9583-8670'],
 ['1804700581','수엘','김재술','010-6686-0781'],
 ['00033','순일','',''],
 ['00174','스탠다드 인터내셔날 주식회사','',''],
 ['6594900780','스토리 스튜디오','장성재',''],
 ['00163','스튜디오 기와','',''],
 ['505-17-69292','스페이스원','원석주','010-7159-8926'],
 ['00183','시멘트상회','',''],
 ['00032','신규','',''],
 ['590-09-03084','신림디자인','김원민',''],
 ['504-11-95612','신우데코','이수복',''],
 ['00034','쌍곰','',''],
 ['00167','씨케이세라믹','',''],
 ['490-33-00540','아이닷','진주','010-6592-1582'],
 ['705-04-03212','아이엠건설','이현찬','010-6528-2329'],
 ['5043141074','아이원인테리어','임용택','010-2640-7722'],
 ['1304769606','아하(AHA)','노재영',''],
 ['774-29-01611','알토','강부곤','010-4079-8366'],
 ['00177','에스씨세라믹','','053-985-8907'],
 ['432-86-00254','에스엔알','차경욱',''],
 ['609-44-03472','에스엠 E.N.G','홍성민','010-7643-5555'],
 ['7282501468','에스타일','최원석',''],
 ['233-06-00989','에이스 싱크','박중한','010-3188-1929'],
 ['00057','에이스티씨','',''],
 ['588-63-00524','에이치엠 건축','김원호','010-8589-0581'],
 ['00054','에피소드','',''],
 ['00053','엘엑스','',''],
 ['00193','엠케이','',''],
 ['00161','영남스톤','',''],
 ['00006','영남타일','',''],
 ['00011','영신산업(대상)','',''],
 ['00040','영인테리어','',''],
 ['5032319384','예가인테리어','백상현','01072293665'],
 ['1701500133','예담 인테리어','강대권','01033775522'],
 ['00176','예담실장님(공사후에사업자나옴)','',''],
 ['3350501685','예승건축디자인','손희수',''],
 ['00068','오로바스','',''],
 ['00058','오케이세라믹','',''],
 ['2851002608','오픈하우스 디자인','고흥석외 1명',''],
 ['2271833644','오피뉴','이용광','01049407227'],
 ['2661302869','온유디자인','노규한',''],
 ['528-04-01693','와이지타일','전세한','010-7663-7900'],
 ['00060','우고집','',''],
 ['4280302435','우림설비','',''],
 ['8440702241','우성 디자인 (달서점)','손현기','010-2336-9920'],
 ['807-06-03434','우성 인테리어 (수성점)','김은아','010-2336-9920'],
 ['504-29-43084','우진건축자재','정대희',''],
 ['5322102266','울진 프렌치페이퍼 풀빌라 오션뷰 펜션 C','백순옥',''],
 ['1993401212','유디자인','김진욱','010-3836-3831'],
 ['00023','유진건설','김현수',''],
 ['169-13-01744','으뜸 인테리어 디자인','이재욱','010-7229-3665'],
 ['3620100259','이뎀디자인','강유미','01052430875'],
 ['00159','이도트레이딩','',''],
 ['3760403241','이레테크','윤성운','010-5800-3804'],
 ['00016','이모션','',''],
 ['00194','이재성 010-4856-9860','',''],
 ['2208165848','이카운트','김신래','070-4034-5500'],
 ['4670401345','인스페이스( IN SPACE )','조수진','010-3217-4260'],
 ['3732700870','인우디자인','양지은','01057008590'],
 ['00148','인홈','',''],
 ['618-11-79191','일품돼지국밥(범어점)','전효영','010-7724-1224'],
 ['00124','장은건축','',''],
 ['00191','정종찬(뉴타운직원)_','','01051482428'],
 ['00192','정화우방팔레스','',''],
 ['8568601901','주식회사 광해디자인','신상규','0537190120'],
 ['7608101769','주식회사 노블건설','신승용','053-784-0072'],
 ['5148186961','주식회사 로얄','조재웅',''],
 ['00004','주식회사 베리굿타일앤스톤','',''],
 ['301-87-02839','주식회사 부광건축디자인','이승희','010-3504-9048'],
 ['6328100806','주식회사 뷰','곽연정',''],
 ['468-87-02302','주식회사 빌드로우','심혜란','010-2248-9530'],
 ['502-81-92325','주식회사 쓰리에프글로벌','서범수','053-764-2240'],
 ['8518801083','주식회사 씨더블유티 (AT인테리어)','오세현','01035850482'],
 ['5598702587','주식회사 올라운드 컴퍼니','배진우',''],
 ['584-86-01350','주식회사 이앤에이치컴퍼니(개인 01074748406)','김은철,전혜정','010-7474-8406'],
 ['732-87-02009','주식회사 재원건설','김경순','0538024567'],
 ['5578602809','주식회사 홈스테드스테이','이세중',''],
 ['00155','주식회사와이엔','',''],
 ['00165','지음 인테리어','',''],
 ['514-24-45856','지음디자인컴퍼니','김수영',''],
 ['00010','청와산업','장병호','0539831255'],
 ['00188','초정건설','',''],
 ['6150289723','최신탕,최신모텔','정진국',''],
 ['00026','충주 현장','',''],
 ['732-24-00724','카린(CARYN)디자인','신민규','010-2689-6230'],
 ['185-58-00729','케이타일','김상욱','01022840157'],
 ['625-88-00597','큰나무 주식회사','최일흠',''],
 ['8233800013','탑세라믹 / TOP','이창수',''],
 ['00013','태경상사','',''],
 ['838-12-00897','태리뷰티','이주희',''],
 ['5041740180','태흥전기조명(라피네) *퀵비선불','배준희',''],
 ['285-18-01454','테스(TES)','임태봉','010-2475-8485'],
 ['604-33-51497','티앤아이 (최지현소개)','김부연','01059409989'],
 ['00056','포트타일','',''],
 ['00085','프렌치','',''],
 ['752-38-01011','플로이 스페이스 대구','김지원','010-7229-3665'],
 ['225-09-26219','하우스창 토탈인테리어','장지원',''],
 ['6021263541','한국 칸막이','조권식','01050020086'],
 ['210-39-17559','한반장','한창현','010-8825-2788'],
 ['00116','한샘리하우스 인동점','',''],
 ['596-76-00321','한샘리하우스 진천대리점','이충정','010-9355-5666'],
 ['717-71-00374','한샘키친 디자인율 대리점','최성원','010-4602-1414'],
 ['00158','한양양행 (청와산업)','',''],
 ['602-81-18362','한인코리아','전명상','051-441-7442'],
 ['3243001047','행복한집','장정훈','01045431717'],
 ['00160','허남영','',''],
 ['5041933664','현대감각','정원우',''],
 ['00043','호이','',''],
 ['727-11-02910','홈엔지니어','진실','010-6592-1582'],
 ['613-81-31083','화신','권오현',''],
 ['00015','흥국','',''],
 ['3050928148','히든','한은주','0417427557'],
 ['00019','히트타일','','']];

 const bizFormat = /^\d{3}-\d{2}-\d{5}$/;
 let filled = 0, alreadySet = 0;
 const matchedNorms = {};
 exportRows.forEach(function (r) {
 const code = String(r[0] || '').trim();
 const name = String(r[1] || '').trim();
 if (!code || !name) return;
 const norm = normalizeVendorName(name);
 // 이카운트 내보내기 이름에 "(주) 에스지세라 / SG", "탑세라믹 / TOP"처럼 담당자/코드 별칭이
 // " / "로 덧붙어 있는 경우가 있어, 그대로 정규화하면 우리 쪽 순수 상호명("탑세라믹")과 매칭이
 // 안 된다. 완전 매칭이 실패하면 " / " 뒤를 잘라내고 한 번 더 시도한다.
 const strippedNorm = normalizeVendorName(name.split(' / ')[0]);
 const matchedKey = byNorm[norm] ? norm : (byNorm[strippedNorm] ? strippedNorm : null);
 if (!matchedKey) return;
 const hit = byNorm[matchedKey];
 matchedNorms[matchedKey] = true;
 if (hit.ecountCode === code && (hit.businessNo || !bizFormat.test(code))) { alreadySet++; return; }
 sheet.getRange(hit.rowIndex, 5).setValue(code);
 if (!hit.businessNo && bizFormat.test(code)) sheet.getRange(hit.rowIndex, 4).setValue(code);
 filled++;
 });

 // 우리 쪽엔 등록돼 있는데 이번 export에서 매칭되지 못한 거래처명을 확인용 시트에 남긴다.
 const unmatched = Object.keys(byNorm).filter(function (norm) { return !matchedNorms[norm]; })
 .map(function (norm) {
 const rowIndex = byNorm[norm].rowIndex;
 return [String(data[rowIndex - 1][0] || '').trim(), byNorm[norm].ecountCode || '(비어있음)'];
 });

 let logSheet = ss.getSheetByName('이카운트코드_확인필요');
 if (!logSheet) logSheet = ss.insertSheet('이카운트코드_확인필요');
 logSheet.clear();
 logSheet.appendRow(['거래처명(우리 시스템)', '기존 이카운트거래처코드', '비고']);
 logSheet.appendRow(['', '', '아래는 이번 이카운트 내보내기 목록에서 이름이 매칭되지 않은 거래처입니다. 이카운트 쪽 실제 표기를 확인해서 D/E열을 직접 채워주세요.']);
 unmatched.forEach(function (row) { logSheet.appendRow(row); });
 logSheet.setFrozenRows(1);

 Logger.log('채움: ' + filled + ', 이미 동일: ' + alreadySet + ', 매칭 안 된 기존 거래처: ' + unmatched.length);
 return { filled: filled, alreadySet: alreadySet, unmatchedCount: unmatched.length };
 }

 // ---- 거래처명 자동완성용 전체 목록 (거래처코드관리 시트 A열, 빈 값 제외 오름차순) ----
 function handleListVendorNames() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(VENDOR_SHEET);
 const data = sheet.getDataRange().getValues();
 const names = [];
 for (let i = 1; i < data.length; i++) {
 const name = String(data[i][0] || '').trim();
 if (name) names.push(name);
 }
 names.sort();
 return jsonOut({ ok: true, names: names });
 }

 // ---- 품목명 자동완성/단가 자동채움용 전체 목록 (품목등록마스터, 품명+규격 기준 중복 제거) ----
 // 판매등록 "직접 입력" 탭에서 품목명 타이핑 시 이 목록으로 규격/출고단가를 자동으로 채워준다.
 function handleListItemMaster() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(MASTER_SHEET);
 if (!sheet) return jsonOut({ ok: true, items: [] });
 const data = sheet.getDataRange().getValues();
 const seen = {};
 const items = [];
 for (let i = 1; i < data.length; i++) {
 const name = String(data[i][1] || '').trim();
 if (!name) continue;
 const spec = String(data[i][3] || '').trim();
 const vendor = String(data[i][12] || '').trim();
 // 거래처까지 키에 포함시켜서, 같은 품명+규격이라도 거래처가 다르면 별도 항목으로 남긴다
 // (자동완성에서 어느 거래처 물건인지 구분해서 보여주기 위함).
 const key = name + '|||' + spec + '|||' + vendor;
 if (seen[key]) continue;
 seen[key] = true;
 items.push({
 code: String(data[i][0] || '').trim(),
 name: name,
 spec: spec,
 vendor: vendor,
 unit: String(data[i][6] || 'EA').trim(),
 outPrice: Number(data[i][10]) || 0
 });
 }
 items.sort(function (a, b) { return a.name.localeCompare(b.name); });
 return jsonOut({ ok: true, items: items });
 }

 // ---- 확인 버튼: 입력한 거래처명이 기존 거래처와 매칭되는지 즉시 조회 ----
 // originalVendorName(Claude가 처음 인식한 표현)이 함께 오고, 매칭됐는데 표현이 다르면
 // 다음부터는 자동으로 잡히도록 교정사전에 그 자리에서 저장해준다.
 function handleCheckVendor(body) {
 const vendorName = String(body.vendorName || '').trim();
 if (!vendorName) throw new Error('거래처명이 없습니다.');
 const originalVendorName = String(body.originalVendorName || '').trim();

 const vendorInfo = findVendor(vendorName);
 let corrected = false;
 if (vendorInfo && originalVendorName && originalVendorName !== vendorName) {
 saveCorrections([[originalVendorName, vendorInfo.storedName]]);
 corrected = true;
 }

 return jsonOut({ ok: true, matched: !!vendorInfo, vendorInfo: vendorInfo, corrected: corrected });
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

 function assignCodesAndPrices(items, prefix, startNumber, vendorName) {
 // 입고단가VAT포함여부/품목구분/세트여부/재고수량관리는 거래처·상품유형과 무관하게 전부 1로 고정한다.
 return items.map(function (it, i) {
 const numberPart = startNumber + i;
 const code = prefix + String(numberPart).padStart(CODE_DIGITS, '0');
 const inPrice = Math.round(Number(it.price) / 100) * 100;
 const outPrice = Math.round((inPrice * 1.5) / 100) * 100;
 return {
 code: code, name: it.name, specType: it.spec ? '사이즈' : '', spec: it.spec || '',
 inPrice: inPrice, inVat: 1, unit: it.unit,
 category: 1, isSet: 1, stockMgmt: 1,
 outPrice: outPrice, outVat: 1
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

 // ==== 이카운트(Ecount) 중계서버 연동 ====
 // GAS는 고정 IP가 없어 이카운트 OAPI를 직접 호출할 수 없으므로, 고정 IP를 가진 중계서버(ecount-relay)를
 // 거쳐서 호출한다. 중계서버 주소/비밀키는 스크립트 속성(ECOUNT_RELAY_URL, ECOUNT_RELAY_SECRET)에 등록해서 쓴다.
 // 이카운트 동기화가 실패해도 구글시트 저장은 이미 끝난 뒤이므로, 흐름을 막지 않고 결과만 응답에 담아 돌려준다.
 function ecountRelayCall(path, payload) {
 const props = PropertiesService.getScriptProperties();
 const url = props.getProperty('ECOUNT_RELAY_URL');
 const secret = props.getProperty('ECOUNT_RELAY_SECRET');
 if (!url || !secret) return { ok: false, error: 'ECOUNT_RELAY_URL/ECOUNT_RELAY_SECRET 스크립트 속성이 설정되지 않았습니다.' };
 try {
 const res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + path, {
 method: 'post',
 contentType: 'application/json',
 headers: { 'X-Relay-Secret': secret },
 payload: JSON.stringify(payload),
 muteHttpExceptions: true
 });
 return JSON.parse(res.getContentText());
 } catch (e) {
 return { ok: false, error: e.message };
 }
 }

 // businessNo(사업자등록번호)는 이카운트의 실제 거래처코드라 필수 - 없으면 동기화를 건너뛴다.
 function ecountSyncVendor(vendorName, businessNo) {
 if (!businessNo) return { ok: false, error: '사업자등록번호가 없어 이카운트 거래처 동기화를 건너뛰었습니다.' };
 return ecountRelayCall('/register-vendor', { businessNo: businessNo, custName: vendorName });
 }

 // 판매전표(매출) 저장 - Sale.js의 handleSaleConfirm에서 사용.
 function ecountSyncSale(pushRows) {
 return ecountRelayCall('/push-sale', { rows: pushRows });
 }

 function ecountSyncItem(item) {
 return ecountRelayCall('/register-item', {
 prodCd: item.code,
 prodDes: item.name,
 spec: item.spec || '',
 unit: item.unit || 'EA',
 inPrice: item.inPrice,
 inPriceVat: !!Number(item.inVat),
 outPrice: item.outPrice,
 outPriceVat: !!Number(item.outVat)
 });
 }

 // 품목등록마스터에서 코드로 조회해서 이카운트에 동기화한다 (구매확정 시, 시트에 이미 있는 코드 기준으로 재동기화할 때 사용).
 function ecountSyncItemsByCode(codes) {
 const unique = codes.filter(function (c, i) { return c && codes.indexOf(c) === i; });
 if (!unique.length) return [];
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 const masterData = masterSheet ? masterSheet.getDataRange().getValues() : [];
 return unique.map(function (code) {
 const row = masterData.find(function (r) { return String(r[0]).trim() === code; });
 if (!row) return { code: code, result: { ok: false, error: '품목등록마스터에서 코드를 찾지 못했습니다.' } };
 return {
 code: code,
 result: ecountSyncItem({ code: code, name: row[1], spec: row[3], unit: row[6], inPrice: row[4], inVat: row[5], outPrice: row[10], outVat: row[11] })
 };
 });
 }
