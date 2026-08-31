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
 const PURCHASE_REVIEW_SHEET = '구매확인중';
 const DEFAULT_WAREHOUSE = '본사창고'; // 추후 변경될 수 있음

 // Ecount 웹자료올리기 일자 입력 형식(YYYYMMDD, 하이픈 없는 8자리)에 맞춘다.
 // 하이픈 섞인 문자열("2026-07-08")을 그대로 올리면 Ecount 쪽에서 Date로 잘못 파싱해
 // 타임존이 꼬인 ISO 타임스탬프로 표시되는 문제가 있었다.
 function normalizeDateYyyyMmDd(s) {
 const digits = String(s || '').replace(/\D/g, '');
 return digits.length === 8 ? digits : '';
 }

 const PURCHASE_REVIEW_HEADERS = ['일자', '순번', '거래처코드', '거래처명', '담당자', '입고창고', '거래유형', '통화', '환율',
 '품목코드', '품목명', '규격명', '수량', '단가(vat포함)', '외화금액', '공급가액', '부가세', '적요',
 '원본품목명(자동,수정금지)', '원본규격(자동,수정금지)'];

 // ---- 매입 문서 업로드 -> 거래처+품목 인식 + "구매확인중" 시트에 미리보기로 채워둠 ----
 // 거래처가 미등록 상태면 Claude를 다시 부르지 않고, 인식된 내용(parsed)을 그대로 프론트에 돌려줘서
 // 사용자가 접두어를 정하면 handlePurchaseRegisterVendor로 이어서 등록하게 한다(품목등록 페이지와 동일한 흐름).
 function handlePurchaseExtract(body) {
 const fileBase64 = body.fileBase64;
 const mimeType = body.mimeType || 'application/pdf';
 const targetMonth = String(body.targetMonth || '').trim(); // 'YYYY-MM', 선택 시 그 달 품목만 등록
 if (!fileBase64) throw new Error('파일이 없습니다.');

 const parsed = extractPurchaseWithClaude(fileBase64, mimeType, targetMonth);
 if (!parsed.vendorName) throw new Error('문서에서 거래처명을 인식하지 못했습니다.');
 if (!parsed.items || parsed.items.length === 0) throw new Error('문서에서 품목을 찾지 못했습니다.');

 filterItemsByMonth(parsed, targetMonth);

 const vendorInfo = findVendor(parsed.vendorName);
 if (!vendorInfo) {
 return jsonOut({
 ok: true,
 needsPrefix: true,
 vendorName: parsed.vendorName,
 suggestedPrefix: matchPrefix(parsed.vendorName) || '',
 parsed: parsed,
 targetMonth: targetMonth
 });
 }

 return finalizePurchaseRegistration(parsed, vendorInfo, !!targetMonth);
 }

 // ---- 신규 거래처 접두어 확정 -> 거래처 등록 + 이어서 구매확인중 스테이징 (Claude 재호출 없음) ----
 function handlePurchaseRegisterVendor(body) {
 const vendorName = String(body.vendorName || '').trim();
 const prefix = String(body.prefix || '').trim().toUpperCase();
 const businessNo = String(body.businessNo || '').trim();
 const parsed = body.parsed;
 const targetMonth = String(body.targetMonth || '').trim();
 if (!vendorName) throw new Error('거래처명이 없습니다.');
 if (!parsed || !parsed.items || !parsed.items.length) throw new Error('품목 데이터가 없습니다.');

 // 접두어 확정 사이에 다른 문서로 같은 거래처가 이미 등록됐을 수 있으니 한 번 더 확인한다.
 // (확인 버튼으로 이미 기존 거래처와 일치하는 걸 확인했다면 접두어 없이도 그대로 기존 거래처로 등록된다.)
 let vendorInfo = findVendor(vendorName);
 if (!vendorInfo) {
 if (!prefix) throw new Error('코드 접두어를 입력해주세요.');
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sharedMax = getMaxLastUsedForPrefix(prefix);
 ss.getSheetByName(VENDOR_SHEET).appendRow([vendorName, prefix, sharedMax, businessNo]);
 vendorInfo = { storedName: vendorName, prefix: prefix, lastUsed: sharedMax, businessNo: businessNo };
 ecountSyncVendor(vendorName, businessNo);
 }

 return finalizePurchaseRegistration(parsed, vendorInfo, !!targetMonth);
 }

 // ---- 문서 전체 기준 targetMonth 필터(재확인용) ----
 function filterItemsByMonth(parsed, targetMonth) {
 if (!targetMonth) return;
 parsed.items = parsed.items.filter(function (it) {
 const d = String(it.date || parsed.docDate || '');
 return d.indexOf(targetMonth) === 0;
 });
 if (!parsed.items.length) {
 throw new Error('선택한 월(' + targetMonth + ')에 해당하는 품목을 찾지 못했어요. 문서의 날짜를 확인해주세요.');
 }
 }

 // ---- 공통: 품목 매칭/자동등록 + 구매확인중 스테이징 ----
 function finalizePurchaseRegistration(parsed, vendorInfo, filteredByMonth) {
 const totalExtracted = parsed.items.length;
 const finalVendorName = vendorInfo.storedName;

 const rows = buildPurchaseRows(parsed, finalVendorName);
 const reviewUrl = stageForPurchaseReview(rows);

 return jsonOut({
 ok: true,
 vendorName: finalVendorName,
 vendorMatched: true,
 rows: rows,
 totalExtracted: totalExtracted,
 filteredByMonth: !!filteredByMonth,
 reviewUrl: reviewUrl
 });
 }

 // ---- "구매확인중" 탭에 미리보기 기록 (원본 품목명/규격은 숨김열에 보관 -> 확정 시 수정본과 비교해 교정사전에 반영) ----
 function stageForPurchaseReview(rows) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(PURCHASE_REVIEW_SHEET);
 if (!sheet) sheet = ss.insertSheet(PURCHASE_REVIEW_SHEET);
 sheet.clear();

 sheet.appendRow(PURCHASE_REVIEW_HEADERS);
 rows.forEach(function (r) {
 sheet.appendRow([
 r.date, r.seq, r.vendorCode, r.vendorName, r.manager, r.warehouse,
 r.dealType, r.currency, r.rate, r.itemCode, r.itemName, r.spec,
 r.qty, r.unitPrice, r.foreignAmount, r.supply, r.vat, r.note,
 r.itemName, r.spec // 원본값 (수정 여부 비교용, 숨김열)
 ]);
 });

 sheet.setFrozenRows(1);
 try { sheet.autoResizeColumns(1, 18); } catch (e) { /* ignore */ }
 try { sheet.hideColumns(19, 2); } catch (e) { /* ignore */ }
 const headerRange = sheet.getRange(1, 1, 1, PURCHASE_REVIEW_HEADERS.length);
 headerRange.setFontWeight('bold').setBackground('#eef4ff');

 if (rows.length) applyItemCodeDropdown(sheet, rows.length);

 SpreadsheetApp.flush();
 return ss.getUrl() + '#gid=' + sheet.getSheetId();
 }

 // ---- 품목코드 칸(J열)에서 "코드 | 품목명 | 규격" 형태로 기존 품목을 검색/선택할 수 있게 드롭다운을 건다 ----
 // 이미 매칭된 행에도 걸어서, 오인식으로 잘못 매칭됐을 때 다른 코드로 바꿀 수 있게 한다.
 // allowInvalid를 켜둬서 빈 칸(신규 품목 확정용)이나 직접 타이핑한 코드도 그대로 허용한다.
 function applyItemCodeDropdown(sheet, rowCount) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 if (!masterSheet) return;
 const masterData = masterSheet.getDataRange().getValues();

 const labels = [];
 for (let i = 1; i < masterData.length; i++) {
 const code = String(masterData[i][0] || '').trim();
 const name = String(masterData[i][1] || '').trim();
 if (!code || !name) continue;
 const spec = String(masterData[i][3] || '').trim();
 labels.push(code + ' | ' + name + (spec ? ' | ' + spec : ''));
 }
 if (!labels.length) return;

 const helperCol = 28; // AB열 - 드롭다운 소스 목록을 적어두는 숨김 열
 sheet.getRange(1, helperCol, labels.length, 1).setValues(labels.map(function (l) { return [l]; }));
 try { sheet.hideColumns(helperCol); } catch (e) { /* ignore */ }

 const rule = SpreadsheetApp.newDataValidation()
 .requireValueInRange(sheet.getRange(1, helperCol, labels.length, 1), true)
 .setAllowInvalid(true)
 .build();
 sheet.getRange(2, 10, rowCount, 1).setDataValidation(rule);
 }

 // ---- 품목코드로 품목등록마스터에서 이름/규격을 찾는다 (코드를 바꿨을 때 이름을 그 코드 기준으로 맞추는 데 사용) ----
 function lookupMasterItemByCode(masterData, code) {
 if (!code) return null;
 for (let i = 1; i < masterData.length; i++) {
 if (String(masterData[i][0] || '').trim() === code) {
 return { name: String(masterData[i][1] || '').trim(), spec: String(masterData[i][3] || '').trim() };
 }
 }
 return null;
 }

 // ---- "구매확인중" 시트에서 품목코드(J열)를 드롭다운으로 바꾸면, 품목명/규격(K/L열)도 그 코드 기준으로
 //      바로 맞춰준다. (그냥 두면 코드만 바뀌고 이름은 원래 인식된 값 그대로 남아서 혼동을 준다.)
 function onEdit(e) {
 try {
 const range = e.range;
 const sheet = range.getSheet();
 if (sheet.getName() !== PURCHASE_REVIEW_SHEET) return;
 if (range.getColumn() !== 10 || range.getRow() < 2) return; // J열(품목코드), 헤더 제외
 if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return; // 단일 셀 수정만 처리

 const ss = e.source;
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 if (!masterSheet) return;
 const masterData = masterSheet.getDataRange().getValues();

 const raw = String(range.getValue() || '').trim();
 const pipeIdx = raw.indexOf('|');
 const code = (pipeIdx === -1 ? raw : raw.slice(0, pipeIdx)).trim();
 const match = lookupMasterItemByCode(masterData, code);
 if (!match) return;

 sheet.getRange(range.getRow(), 11).setValue(match.name); // K열 품목명
 sheet.getRange(range.getRow(), 12).setValue(match.spec); // L열 규격명
 } catch (err) {
 // onEdit은 실패해도 조용히 넘어간다 (사용자 편집 흐름을 막지 않기 위함)
 }
 }

 // ---- "구매확인중" 시트 내용을 그대로 읽어와 "구매입력"에 확정 저장 ----
 function handlePurchaseConfirm() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(PURCHASE_REVIEW_SHEET);
 if (!sheet) throw new Error('구매확인중 시트를 찾을 수 없습니다.');

 const data = sheet.getDataRange().getValues();
 if (data.length <= 1) throw new Error('구매확인중 시트에 저장할 품목이 없습니다. (다 지우신 건 아닌지 확인해주세요)');

 const rows = data.slice(1).filter(function (r) { return String(r[10]).trim() !== ''; });
 if (!rows.length) throw new Error('구매확인중 시트에 저장할 품목이 없습니다.');

 // 원본(자동인식값) vs 수정본 비교 -> 교정사전에 자동 기록
 const corrections = [];
 rows.forEach(function (r) {
 const editedName = String(r[10] || '').trim();
 const originalName = String(r[18] || '').trim();
 if (originalName && editedName && originalName !== editedName) corrections.push([originalName, editedName]);
 const editedSpec = String(r[11] || '').trim();
 const originalSpec = String(r[19] || '').trim();
 if (originalSpec && editedSpec && originalSpec !== editedSpec) corrections.push([originalSpec, editedSpec]);
 });
 if (corrections.length) saveCorrections(corrections);

 // 품목코드 칸은 드롭다운으로 "코드 | 품목명 | 규격"을 고른 경우 그 전체 라벨이 그대로 들어있으니
 // 맨 앞의 코드만 떼어낸다. 사람이 코드만 직접 타이핑했거나 비워뒀으면 그대로 통과한다.
 function parseItemCode(raw) {
 const s = String(raw || '').trim();
 if (!s) return '';
 const pipeIdx = s.indexOf('|');
 return (pipeIdx === -1 ? s : s.slice(0, pipeIdx)).trim();
 }

 // 확정 시점에도 한 번 더: 품목코드가 있는 행은 K/L열에 남아있는 텍스트가 아니라 그 코드로
 // 품목등록마스터에 등록된 이름/규격을 최종값으로 쓴다. (onEdit으로 못 잡은 경우의 안전망)
 const masterSheetForConfirm = ss.getSheetByName(MASTER_SHEET);
 const masterDataForConfirm = masterSheetForConfirm ? masterSheetForConfirm.getDataRange().getValues() : [];

 const finalRows = rows.map(function (r) {
 const code = parseItemCode(r[9]);
 const masterMatch = code ? lookupMasterItemByCode(masterDataForConfirm, code) : null;
 return {
 date: r[0], seq: r[1], vendorCode: r[2], vendorName: r[3], manager: r[4], warehouse: r[5],
 dealType: r[6], currency: r[7], rate: r[8],
 itemCode: code,
 itemName: masterMatch ? masterMatch.name : r[10],
 spec: masterMatch ? masterMatch.spec : r[11],
 qty: r[12], unitPrice: r[13], foreignAmount: r[14], supply: r[15], vat: r[16], note: r[17]
 };
 });

 const vendorName = String(rows[0][3] || '').trim();
 const vendorInfo = findVendor(vendorName);

 // ---- 품목코드가 여전히 비어있는(=신규 품목으로 그대로 확정된) 행은 이 시점에 비로소 채번+마스터 등록한다 ----
 // (미매칭 상태로 검토 화면까지 왔다가, 사람이 기존 코드로 지정하지 않고 그대로 둔 품목만 해당.)
 const newItemKeys = [];
 const newItemMap = {};
 finalRows.forEach(function (r) {
 if (r.itemCode) return;
 const key = String(r.itemName).trim() + '|||' + String(r.spec || '').trim();
 if (!newItemMap[key]) {
 // 타일(사이즈*사이즈포셀린... 접두어가 붙은 품목명)은 규격을 이름에서 떼어 spec에 두는 정식 표기로 등록한다.
 let finalName = r.itemName, finalSpec = r.spec || '';
 if (!finalSpec) {
 const split = splitTileSizePrefix(finalName);
 if (split) { finalName = split.name; finalSpec = split.spec; }
 }
 newItemMap[key] = { name: finalName, spec: finalSpec, price: r.unitPrice, unit: 'EA' };
 newItemKeys.push(key);
 }
 });

 if (newItemKeys.length) {
 if (!vendorInfo) throw new Error('거래처(' + vendorName + ')가 등록되어 있지 않아 신규 품목에 코드를 발급할 수 없습니다.');
 const toRegister = newItemKeys.map(function (key) { return newItemMap[key]; });
 const sharedMax = getMaxLastUsedForPrefix(vendorInfo.prefix);
 const startNumber = Math.max(vendorInfo.lastUsed, sharedMax) + 1;
 const newRows = assignCodesAndPrices(toRegister, vendorInfo.prefix, startNumber, vendorName);
 appendToMasterSheet(vendorName, newRows);
 newRows.forEach(function (r) { ecountSyncItem(r); }); // 실패해도 로컬 등록은 이미 끝났으니 무시하고 진행
 saveLastUsedByPrefix(vendorInfo.prefix, Math.max(startNumber + newRows.length - 1, sharedMax));

 const codeByKey = {};
 newItemKeys.forEach(function (key, i) { codeByKey[key] = newRows[i]; });
 finalRows.forEach(function (r) {
 if (r.itemCode) return;
 const key = String(r.itemName).trim() + '|||' + String(r.spec || '').trim();
 const nr = codeByKey[key];
 if (nr) { r.itemCode = nr.code; r.itemName = nr.name; r.spec = nr.spec; r.note = (r.note ? r.note + ' / ' : '') + '신규 품목 자동등록됨'; }
 });
 }

 const sheetGid = appendToPurchaseSheet(finalRows);

 // 구매확인중 시트는 헤더만 남기고 비움
 sheet.clear();
 sheet.appendRow(PURCHASE_REVIEW_HEADERS);
 sheet.setFrozenRows(1);

 // ---- 이카운트 중계서버로 거래처 동기화 + 품목 동기화 + 매입전표 저장 ----
 // 실패해도 구글시트 저장은 이미 끝난 뒤이므로 흐름을 막지 않고 결과만 응답에 담아 돌려준다.
 const ecountVendorResult = ecountSyncVendor(vendorName, vendorInfo ? vendorInfo.businessNo : '');

 const codesToSync = finalRows.filter(function (r) { return r.itemCode; }).map(function (r) { return r.itemCode; });
 const ecountItemResults = ecountSyncItemsByCode(codesToSync);

 const whCd = PropertiesService.getScriptProperties().getProperty('ECOUNT_DEFAULT_WH_CD') || '';
 // 이카운트 거래처코드 = 사업자등록번호(숫자만)다. CUST_DES(이름)만 보내면 이카운트가 이름으로
 // 알아서 매칭을 시도하다 기존 등록된 거래처를 못 찾고 새 거래처로 잡거나 실패할 수 있어서,
 // 이미 등록된 사업자등록번호가 있으면 CUST_CD로 명시해서 정확히 그 거래처에 붙게 한다.
 const custCd = vendorInfo && vendorInfo.businessNo ? String(vendorInfo.businessNo).replace(/\D/g, '') : '';
 const pushRows = finalRows.filter(function (r) { return r.itemCode; }).map(function (r) {
 return { date: r.date, custCd: custCd, custDes: vendorName, whCd: whCd, prodCd: r.itemCode, prodDes: r.itemName, qty: r.qty, unitPriceVat: r.unitPrice, supply: r.supply, vat: r.vat, remarks: r.note || '' };
 });
 let ecountPurchaseResult;
 if (!pushRows.length) {
 ecountPurchaseResult = { ok: false, error: '품목코드가 매칭된 행이 없어 이카운트 매입전표 저장을 건너뛰었습니다.' };
 } else if (!whCd) {
 ecountPurchaseResult = { ok: false, error: 'ECOUNT_DEFAULT_WH_CD 스크립트 속성이 없어 이카운트 매입전표 저장을 건너뛰었습니다. Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성에서 입고창고의 이카운트 창고코드를 등록해주세요.' };
 } else {
 ecountPurchaseResult = ecountRelayCall('/push-purchase', { rows: pushRows });
 }

 return jsonOut({ ok: true, vendorName: vendorName, savedCount: finalRows.length, rows: finalRows, sheetGid: sheetGid,
 ecount: { vendor: ecountVendorResult, items: ecountItemResults, purchase: ecountPurchaseResult } });
 }

 // ---- 품목코드 매칭 + 공급가액/부가세 계산해서 행 조립 ----
 // v3 변경점: 미매칭 품목을 여기서 바로 신규 채번/등록하지 않는다. 인식 오류로 미매칭된 품목이
 // 계속 새 코드로 잘못 생성되는 문제 때문에, 코드가 빈 채로 "구매확인중" 시트에 올려서
 // 사람이 (a) 기존 코드로 지정하거나 (b) 그대로 둬서 confirm 시점에 신규 등록하게 한다.
 function buildPurchaseRows(parsed, vendorName) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 const masterData = masterSheet.getDataRange().getValues();
 const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
 const docDate = normalizeDateYyyyMmDd(parsed.docDate) || today;

 // 품명이 같아도 규격이 다르면 다른 품목이므로, 매칭도 품명+규격을 묶은 키로 구분한다.
 function itemKey(name, spec) { return String(name || '').trim() + '|||' + String(spec || '').trim(); }

 const codeMap = {};
 parsed.items.forEach(function (it) {
 const key = itemKey(it.name, it.spec);
 if (codeMap[key] !== undefined) return;
 const match = findMasterItem(masterData, vendorName, it.name, it.price, it.spec);
 if (match) codeMap[key] = match;
 });

 return parsed.items.map(function (it, i) {
 const key = itemKey(it.name, it.spec);
 const match = codeMap[key];
 const code = match ? match.code : '';
 const finalName = match ? match.name : it.name;
 const finalSpec = match && match.spec ? match.spec : (it.spec || '');
 const unitPrice = Math.round(Number(it.price) || 0);
 const qty = Number(it.qty) || 0;
 const supply = Math.round((unitPrice * qty) / 1.1);
 const vat = Math.round(unitPrice * qty) - supply;

 return {
 date: normalizeDateYyyyMmDd(it.date) || docDate,
 seq: i + 1,
 vendorCode: '',
 vendorName: vendorName,
 manager: '',
 warehouse: DEFAULT_WAREHOUSE,
 dealType: '',
 currency: '',
 rate: 1,
 itemCode: code,
 itemName: finalName,
 spec: finalSpec,
 qty: qty,
 unitPrice: unitPrice,
 foreignAmount: '',
 supply: supply,
 vat: vat,
 note: code ? '' : '신규/미확인 - 기존 품목이면 품목코드 칸에서 검색해 선택, 신규 품목이면 비워둔 채 확정하면 자동 채번됩니다'
 };
 });
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
 return sheet.getSheetId();
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
 // targetMonth('YYYY-MM')가 있으면 그 달 품목만 뽑도록 프롬프트 단계에서부터 범위를 좁힌다.
 // (거래처원장처럼 여러 달 수백 줄이 섞인 문서를 통째로 추출시키면 출력이 max_tokens를 넘어 통째로 실패하기 때문)
 function extractPurchaseWithClaude(fileBase64, mimeType, targetMonth) {
 const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
 if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

 const correctionText = getCorrectionListText();
 const correctionBlock = correctionText
 ? ['', '[과거 교정 이력 - 우선 참고]',
 '아래는 과거에 사람이 직접 오타를 고친 이력입니다. 문서에서 이와 비슷하게 애매하게 보이는 품목명이 나오면, 아래 정정표현을 우선적으로 사용하세요.',
 correctionText, '']
 : [''];

 const systemPrompt = [
 '당신은 매입 거래명세서(세금계산서, 거래처원장 포함) PDF 또는 이미지에서 거래처명과 매입 품목을 추출하는 도우미입니다.',
 ''
 ].concat(correctionBlock).concat([
 '[거래처명 인식]',
 '- 문서 안에 보통 "공급자:", "공급자명 :", "공급하는자:", "공급처명 :" 같은 라벨과 함께 회사명이 적혀 있습니다. 예: 주식회사 베리굿타일앤스, 주식회사 대명세라믹스.',
 '- "매출처별 거래원장"/"거래처원장" 형식이면 공급자(물건을 판 쪽, 이 문서를 발행한 회사)가 발행한 것이라, 문서 상단에 "거래처명 :"이라는 라벨이 있어도 그건 그 공급자 입장에서의 고객(=히트타일)을 가리키는 것입니다. 절대 vendorName으로 쓰지 마세요. 대신 "공급자명 :"/"공급처명 :" 라벨 옆의 회사명을 vendorName으로 쓰세요.',
 '- 히트타일이 매입하는 입장이므로, 실제 물건을 판매한 공급자 상호명을 정확히 그대로 추출하세요. "히트타일"이라는 이름 자체(대구/서울 등 지점명이 붙은 형태 포함)는 절대 vendorName이 될 수 없습니다 — 그건 우리 회사입니다.',
 '- "공급자명"/"공급처명" 라벨이 아예 안 보이는 문서도 있습니다. 이 경우 문서 하단의 계좌/입금 안내문(예: "OOO 당사는 이 계좌 외 입금은 받지않습니다")에 적힌 회사명이 실제 공급자이니, 그 이름을 vendorName으로 쓰세요.',
 '- 또는 각 페이지 맨 아래에 "(회사명), TEL) 000-000-0000 FAX) 000-000-0000" 형태의 꼬리말이 반복해서 찍혀 있는 문서도 있습니다("매출처원장" 등). 이런 경우 그 꼬리말에 적힌 회사명이 이 문서를 발행한 공급자이니, 그 이름을 vendorName으로 쓰세요.',
 '- "거래명세표" 표준 양식은 공급자 정보 칸에 "상호(법인명)"과 "성명" 두 칸이 나란히 있습니다. 반드시 "상호(법인명)" 칸의 값(회사/상호명)을 vendorName으로 쓰세요 — 그 옆 "성명" 칸은 대표자 개인 이름이라 vendorName으로 쓰면 안 됩니다. 예: 상호(법인명)="블루밍", 성명="최준우"이면 vendorName은 "블루밍"입니다.',
 '',
 '[품목 추출 규칙]',
 '1. 일자, 품명, 규격, 단위, 수량, 단가, 공급가액, 세액 컬럼이 있는 표에서 실제 품목 거래행만 추출합니다.',
 '2. 소계/합계/부가세 합계/월별집계 등 요약행은 무시하고 실제 품목행만 추출합니다.',
 '3. 단가는 부가세 포함 단가(vat포함) 기준으로 추출합니다. 문서에 공급가액과 세액이 따로 있으면 (공급가액+세액)/수량으로 계산해서 단가를 구하세요.',
 '4. 단위는 문서에 적힌 그대로(BOX, 포, SET, 통, EA, 봉지 등) 추출하세요. 단위가 없으면 "EA"로 둡니다.',
 '5. 문서에 날짜가 하나만 있으면 그 날짜를 docDate에 YYYY-MM-DD 형식으로 넣으세요. 거래처원장처럼 품목 행마다 날짜가 다르면(예 26.07.06, 26.07.13 등 여러 날짜가 섞여 있으면), 각 품목의 실제 거래일자를 그 품목 항목의 date 필드에 YYYY-MM-DD 형식으로 각각 넣으세요. 날짜에 연도가 없으면(예 "01.20"처럼 월.일만 있으면) 문서의 기준일자/출력일시나 이월 기준일 등 문맥으로 연도를 추론하세요. 이 경우 docDate는 문서에 적힌 기준일자나 가장 이른 날짜로 채워도 됩니다.',
 '6. 이 문서가 매출/입금 방식(공급자 입장에서 매출로 기록된 방식)이거나 컬럼 구성이 다르더라도, 히트타일이 지불하는 금액에 해당하는 단가 컬럼을 찾아 최대한 추출을 시도하세요. 설명이 필요해 보여도 거절하지 말고 best-effort로 JSON을 출력하세요.',
 '7. 이월, 전기이월, 수입, 대체, 대입, 입금, 카드, 통장결제, DC처리, 계좌변경 안내 같은 결제/이월/요약 행은 실제 매입 품목이 아니므로 items에서 제외하세요.',
 '8. 반품/취소 행은 별도 품목이 아니라 원래 품목의 수량을 마이너스로 처리한 것입니다. 문서의 수량(qty) 컬럼에 마이너스가 적혀 있으면 그대로 마이너스로 추출하세요. 수량은 양수인데 금액(공급가액/합계금액) 컬럼만 마이너스라면, 그 경우엔 qty에도 마이너스 부호를 붙여서 추출하세요.',
 '9. 아래 JSON 형식으로만 출력하세요. 다른 설명이나 코드블록 표시 없이 순수 JSON 객체 하나만 출력합니다. 교정이력을 참고해서 무언가 고쳤더라도 그 사실을 설명하는 문장을 절대 앞뒤에 붙이지 마세요 - 오직 JSON 객체 하나만, 그 자체로 시작하고 끝나야 합니다.',
 '{"vendorName":"거래처 상호명","docDate":"YYYY-MM-DD","items":[{"name":"품목명","spec":"규격(없으면 빈 문자열)","unit":"단위","qty":숫자,"price":단가숫,"date":"YYYY-MM-DD(해당 품목 행의 실제 날짜, 문서 전체가 한 날짜뿐이면 생략 가능)"}]}'
 ]).join('\n');

 const contentBlock = mimeType === 'application/pdf'
 ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
 : { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBase64 } };

 let userText = '이 매입 거래명세서에서 거래처와 품목을 규칙대로 추출해서 JSON 객체만 출력해줘.';
 if (targetMonth) {
 userText += ' 이 문서는 여러 달의 거래가 섞여 있을 수 있는데, ' + targetMonth + ' 월(YYYY-MM)에 해당하는 거래일자의 품목 행만 추출하고 다른 달의 행은 절대 items에 포함하지 마세요. vendorName/docDate는 문서 전체 기준으로 정상적으로 채우세요.';
 }

 const payload = {
 model: CLAUDE_MODEL,
 // 24페이지 7개월치 거래처원장도 thinking을 끄고 32000이면 한 번에 끝까지 추출됨(실측 확인).
 // 예전엔 16000 + thinking 켜짐 조합이라 큰 문서에서 출력이 잘리거나(비어서) 실패했음.
 max_tokens: 32000,
 thinking: { type: 'disabled' },
 system: systemPrompt,
 messages: [{
 role: 'user',
 content: [
 contentBlock,
 { type: 'text', text: userText }
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
 // 지침(순수 JSON만 출력)을 어기고 "OO은 교정이력에 따라 정정합니다" 같은 설명 문장을 JSON 앞뒤에
 // 덧붙이는 경우가 가끔 있어서, 첫 '{'~마지막 '}' 구간만 잘라내 파싱한다.
 const firstBrace = jsonText.indexOf('{');
 const lastBrace = jsonText.lastIndexOf('}');
 if (firstBrace !== -1 && lastBrace > firstBrace) jsonText = jsonText.slice(firstBrace, lastBrace + 1);

 try {
 const parsed = JSON.parse(jsonText);
 applyCorrectionDictionary(parsed.items);
 return parsed;
 } catch (e) {
 throw new Error('Claude가 이 문서에서 매입 정보를 추출하지 못했습니다: ' + jsonText.slice(0, 300));
 }
 }
 