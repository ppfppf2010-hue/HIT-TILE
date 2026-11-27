/**
 * * ===== 판매등록 자동화 (Google Apps Script) v3 =====
 * "직접 입력" 화면에서 거래처명+품목(수량/단가/단위)을 입력하면,
 * 기존 판매거래처/품목등록마스터 시트에서 코드를 매칭해
 * '판매입력' 탭에 Ecount 판매 일괄등록 양식 그대로 누적 저장한다.
 *
 * v3 변경점: 판매 거래처(고객사)를 매입 거래처(거래처코드관리 시트)와 완전히 분리했다.
 * 이제 SALE_VENDOR_SHEET("판매거래처")를 따로 쓴다 — 매입처에 코드 채번용 프리픽스가 필요한 것과
 * 달리, 판매는 신규 품목을 만들지 않으므로 프리픽스 개념 자체가 필요 없다.
 *
 * v2 변경점: 사진/PDF 업로드(Claude OCR 추출) 방식을 완전히 제거했다. 판매는 이미 등록된
 * 품목만 팔 수 있으므로, 인식 오류로 신규 품목이 잘못 자동등록되는 걸 원천 차단하기 위해
 * 신규 품목 등록 자체를 없애고 — 매칭 안 되는 품목은 마스터 전체에서 편집거리가 가장 가까운
 * 기존 품목으로 항상 강제 매칭한다(낮은 확신도는 note에 표시, 검토 화면에서 확인/수정).
 *
 * 품목등록마스터는 구매 때 등록된 것을 그대로 재사용한다(같은 품목을 사고 팔기 때문).
 *
 * 주의: 거래처코드(Ecount 자체 코드)/담당자/출하창고/거래유형은
 * 이 시스템에 매핑 정보가 없어 빈 칸으로 남긴다. 등록 전 확인 필요.
 *
 * doPost action="sale_manual_entry" 로 Code.gs의 doPost에서 라우팅됨.
 */

 const SALE_SHEET = '판매입력';
 const SALE_REVIEW_SHEET = '판매확인중';
 const SALE_VENDOR_SHEET = '판매거래처';
 const DEFAULT_SHIP_WAREHOUSE = '본사창고'; // 추후 변경될 수 있음

 const SALE_REVIEW_HEADERS = ['일자', '순번', '거래처코드', '거래처명', '담당자', '출하창고', '거래유형', '통화', '환율',
 '품목코드', '품목명', '규격명', '수량', '단가(vat포함)', '외화금액', '공급가액', '부가세', '적요',
 '원본품목명(자동,수정금지)', '원본규격(자동,수정금지)', '현장명(배송주소)'];
 // 현장명(배송주소)은 이카운트 판매입력 「현장명」 = 문자형식1(판매) = SaveSale U_MEMO1 (대표님 화면 확인 2026-11-19).
 // 대표님 방침: 현장명은 절대 빠지면 안 된다 - 비어 있으면 저장은 하되 응답에 siteMissing으로 반드시 알린다.

 // 적요 칸에서 공간명과 확인용 경고(⚠ ...)를 구분하는 구분자
 const NOTE_SEP = ' / ';

 // 확인용 경고는 판매확인중 시트에서만 보이고, 판매입력 시트 · 이카운트 적요에는 공간명만 남긴다
 function stripSaleWarning(note) {
 return String(note || '').split(NOTE_SEP).filter(function (part) { return part.trim().indexOf('⚠') !== 0; }).join(NOTE_SEP).trim();
 }

 const SALE_VENDOR_HEADERS = ['거래처명', '사업자등록번호', '대표자명', '전화', '이카운트거래처코드'];

 // ---- 판매거래처 시트 최초 1회 세팅 (없으면 자동 생성) ----
 function setupSaleVendorSheet() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(SALE_VENDOR_SHEET);
 if (!sheet) sheet = ss.insertSheet(SALE_VENDOR_SHEET);
 if (sheet.getLastRow() === 0) {
 sheet.getRange(1, 1, 1, SALE_VENDOR_HEADERS.length).setValues([SALE_VENDOR_HEADERS]);
 sheet.setFrozenRows(1);
 }
 return sheet;
 }

 // ---- 판매거래처 일괄 등록 (한 번만 실행) ----
 // 이카운트에서 내려받은 "거래처등록" 목록을 판매거래처 시트에 채워 넣는다.
 // 이미 등록된 이름은 건너뛰므로 몇 번을 다시 실행해도 중복 등록되지 않는다.
 // 사업자등록번호 칸은 "XXX-XX-XXXXX" 형식으로 정확히 표기된 경우에만 채웠다 - 나머지는 이카운트
 // 내부 코드일 뿐 실제 사업자번호가 아닐 수 있어 비워두고 이카운트거래처코드 칸에만 참고용으로 남겼다.
 // 사용법: Apps Script 편집기에서 이 함수를 선택하고 [Run] 버튼으로 한 번 실행하면 됩니다.
 function importSaleVendorsBulk() {
 const sheet = setupSaleVendorSheet();
 const existing = sheet.getDataRange().getValues().slice(1).map(function (r) { return String(r[0] || '').trim(); });
 const existingSet = {};
 existing.forEach(function (n) { if (n) existingSet[n] = true; });

 // 이카운트 "거래처등록" 목록(거래처명 · 사업자번호 · 대표자 · 연락처 · 이카운트코드)은 개인정보라 공개 저장소에 두지 않는다(2026-11-20).
 // 구글 시트 "거래처내보내기_판매" 탭에 A~E열 순서 그대로(1행 머리글) 붙여 넣은 뒤 실행한다.
 const rows = readVendorExportSheet_(SpreadsheetApp.openById(SPREADSHEET_ID), '거래처내보내기_판매')
 .map(function (r) { return [r[0], r[1] || '', r[2] || '', r[3] || '', r[4] || '']; });
 if (!rows.length) throw new Error('"거래처내보내기_판매" 시트가 없거나 비어 있습니다. A~E열(거래처명 · 사업자번호 · 대표자 · 연락처 · 이카운트코드)로 붙여 넣은 뒤 다시 실행하세요.');

 const toAppend = rows.filter(function (r) { return r[0] && !existingSet[r[0]]; });
 toAppend.forEach(function (r) { sheet.appendRow(r); });

 Logger.log('판매거래처 ' + toAppend.length + '건 추가 (전체 ' + rows.length + '건 중 ' + (rows.length - toAppend.length) + '건은 이미 있어서 건너뜀)');
 return { ok: true, added: toAppend.length, total: rows.length };
 }

 // ---- 판매거래처 조회 (완전일치 우선, 실패 시 정규화 비교로 표기 차이 흡수) ----
 // normalizeVendorName/getCorrectionMap은 Code.js에 정의된 공용 헬퍼(매입/판매 공통 재사용).
 function findSaleVendor(vendorName) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(SALE_VENDOR_SHEET);
 if (!sheet) return null;
 const data = sheet.getDataRange().getValues();
 const correctionMap = getCorrectionMap();
 const rawKey = String(vendorName || '').trim();
 let correctedName = correctionMap[rawKey];
 if (!correctedName) {
 const normKey = normalizeVendorName(vendorName);
 for (const wrong in correctionMap) {
 if (normalizeVendorName(wrong) === normKey) { correctedName = correctionMap[wrong]; break; }
 }
 }
 correctedName = correctedName || vendorName;
 const target = normalizeVendorName(correctedName);

 for (let i = 1; i < data.length; i++) {
 const stored = String(data[i][0] || '');
 if (!stored.trim()) continue;
 if (stored.trim() === String(correctedName).trim() || normalizeVendorName(stored) === target) {
 return { rowIndex: i + 1, storedName: stored.trim(), businessNo: String(data[i][1] || '').trim(), ecountCode: String(data[i][4] || '').trim() };
 }
 }
 return null;
 }

 // ---- 판매거래처명 자동완성용 전체 목록 ----
 function handleListSaleVendorNames() {
 const sheet = setupSaleVendorSheet();
 const data = sheet.getDataRange().getValues();
 const names = [];
 for (let i = 1; i < data.length; i++) {
 const name = String(data[i][0] || '').trim();
 if (name) names.push(name);
 }
 names.sort();
 return jsonOut({ ok: true, names: names });
 }

 // ---- 판매거래처명+연락처 목록 (다른 페이지의 업체명 자동완성용, 예: 상담체크리스트) ----
 // 배송일정 이력 기반 추측(getDeliveryVendorContacts)과 달리, 이건 실제 등록된 판매거래처 원장이라 더 정확하다.
 function handleListSaleVendorContacts() {
 const sheet = setupSaleVendorSheet();
 const data = sheet.getDataRange().getValues();
 const contacts = [];
 for (let i = 1; i < data.length; i++) {
 const name = String(data[i][0] || '').trim();
 if (!name) continue;
 contacts.push({ name: name, phone: String(data[i][3] || '').trim() });
 }
 contacts.sort(function (a, b) { return a.name.localeCompare(b.name); });
 return jsonOut({ ok: true, contacts: contacts });
 }

 // ---- 확인 버튼: 입력한 판매거래처명이 기존 거래처와 매칭되는지 즉시 조회 ----
 // handleCheckVendor(매입용, Code.js)와 동일한 패턴이지만 판매거래처 시트를 조회한다.
 function handleCheckSaleVendor(body) {
 const vendorName = String(body.vendorName || '').trim();
 if (!vendorName) throw new Error('거래처명이 없습니다.');
 const originalVendorName = String(body.originalVendorName || '').trim();

 const vendorInfo = findSaleVendor(vendorName);
 let corrected = false;
 if (vendorInfo && originalVendorName && originalVendorName !== vendorName) {
 saveCorrections([[originalVendorName, vendorInfo.storedName]]);
 corrected = true;
 }

 return jsonOut({ ok: true, matched: !!vendorInfo, vendorInfo: vendorInfo, corrected: corrected });
 }

 // ---- 신규 판매거래처 등록 확정 -> 이어서 판매확인중 스테이징 ----
 // 매입거래처와 달리 프리픽스(코드 접두어) 개념이 없다 - 판매는 신규 품목을 만들지 않으므로 필요 없음.
 function handleSaleRegisterVendor(body) {
 const vendorName = String(body.vendorName || '').trim();
 const businessNo = String(body.businessNo || '').trim();
 const parsed = body.parsed;
 const targetMonth = String(body.targetMonth || '').trim();
 if (!vendorName) throw new Error('거래처명이 없습니다.');
 if (!parsed || !parsed.items || !parsed.items.length) throw new Error('품목 데이터가 없습니다.');
 if (body.site) parsed.site = String(body.site).trim();

 // 등록 확정 사이에 다른 입력으로 같은 거래처가 이미 등록됐을 수 있으니 한 번 더 확인한다.
 // (확인 버튼으로 이미 기존 거래처와 일치하는 걸 확인했다면 그대로 기존 거래처로 등록된다.)
 let vendorInfo = findSaleVendor(vendorName);
 if (!vendorInfo) {
 setupSaleVendorSheet().appendRow([vendorName, businessNo, '', '', '']);
 vendorInfo = { storedName: vendorName, businessNo: businessNo };
 if (businessNo) ecountSyncVendor(vendorName, businessNo);
 }

 return finalizeSaleRegistration(parsed, vendorInfo, !!targetMonth);
 }

 // ---- 판매등록 "직접 입력" 탭: 거래처명+품목을 사람이 직접 입력한 것을 받아서 ----
 // handleSaleRegisterVendor와 완전히 같은 모양의 parsed 객체를 만들어서 같은 이후 흐름
 // (거래처 매칭 -> 필요시 신규 등록 -> 판매확인중 스테이징)을 그대로 탄다.
 function handleSaleManualEntry(body) {
 const vendorName = String(body.vendorName || '').trim();
 const rawItems = Array.isArray(body.items) ? body.items : [];
 if (!vendorName) throw new Error('거래처명이 없습니다.');

 const items = rawItems
 .map(function (it) {
 return {
 name: String(it.name || '').trim(),
 spec: String(it.spec || '').trim(),
 unit: String(it.unit || 'EA').trim(),
 qty: Number(it.qty) || 0,
 price: Number(it.unitPrice) || 0,
 memo: String(it.memo || '').trim(), // 적요 — 상담/타일량 계산기에서 넘어온 공간명 (외욕실, 현관 등)
 code: String(it.itemCode || it.code || '').trim() // 품목코드를 직접 지정하면 이름 매칭 없이 그 품목으로 등록
 };
 })
 .filter(function (it) { return it.name && it.qty; });
 if (!items.length) throw new Error('품목명과 수량을 입력해주세요.');

 const parsed = { vendorName: vendorName, docDate: String(body.docDate || '').trim(), site: String(body.site || '').trim(), items: items };

 const vendorInfo = findSaleVendor(vendorName);
 if (!vendorInfo) {
 return jsonOut({
 ok: true,
 needsPrefix: true,
 vendorName: vendorName,
 suggestedPrefix: '',
 parsed: parsed,
 targetMonth: ''
 });
 }

 return finalizeSaleRegistration(parsed, vendorInfo, false);
 }

 // ---- 공통: 품목 매칭 + 판매확인중 스테이징 ----
 function finalizeSaleRegistration(parsed, vendorInfo, filteredByMonth) {
 const totalExtracted = parsed.items.length;
 const finalVendorName = vendorInfo.storedName;

 const rows = buildSaleRows(parsed, finalVendorName);
 const reviewUrl = stageForSaleReview(rows);

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

 // ---- "판매확인중" 탭에 미리보기 기록 (원본 품목명/규격은 숨김열에 보관 -> 확정 시 수정본과 비교해 교정사전에 반영) ----
 function stageForSaleReview(rows) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(SALE_REVIEW_SHEET);
 if (!sheet) sheet = ss.insertSheet(SALE_REVIEW_SHEET);
 sheet.clear();

 sheet.appendRow(SALE_REVIEW_HEADERS);
 rows.forEach(function (r) {
 sheet.appendRow([
 r.date, r.seq, r.vendorCode, r.vendorName, r.manager, r.warehouse,
 r.dealType, r.currency, r.rate, r.itemCode, r.itemName, r.spec,
 r.qty, r.unitPrice, r.foreignAmount, r.supply, r.vat, r.note,
 r.itemName, r.spec, // 원본값 (수정 여부 비교용, 숨김열)
 r.site || '' // 현장명(배송주소) - 21열, 보이는 열(시트에서 고칠 수 있음)
 ]);
 });

 sheet.setFrozenRows(1);
 try { sheet.autoResizeColumns(1, 18); } catch (e) { /* ignore */ }
 try { sheet.hideColumns(19, 2); } catch (e) { /* ignore */ }
 const headerRange = sheet.getRange(1, 1, 1, SALE_REVIEW_HEADERS.length);
 headerRange.setFontWeight('bold').setBackground('#eef4ff');

 // applyItemCodeDropdown은 Purchase.js에 정의된 공용 헬퍼(품목등록마스터 기준이라 구매/판매 공통 재사용 가능)
 if (rows.length) applyItemCodeDropdown(sheet, rows.length);

 SpreadsheetApp.flush();
 return ss.getUrl() + '#gid=' + sheet.getSheetId();
 }

 // ---- "판매확인중" 시트 내용을 그대로 읽어와 "판매입력"에 확정 저장 ----
 function handleSaleConfirm(body) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(SALE_REVIEW_SHEET);
 if (!sheet) throw new Error('판매확인중 시트를 찾을 수 없습니다.');

 const data = sheet.getDataRange().getValues();
 if (data.length <= 1) throw new Error('판매확인중 시트에 저장할 품목이 없습니다. (다 지우신 건 아닌지 확인해주세요)');

 const rows = data.slice(1).filter(function (r) { return String(r[10]).trim() !== ''; });
 if (!rows.length) throw new Error('판매확인중 시트에 저장할 품목이 없습니다.');

 // 날짜가 미래 · 30일 넘게 과거면 아무것도 저장하기 전에 멈춘다(allowDate:true면 통과, 검사는 Purchase.js checkVoucherDates_)
 const dateProblems = checkVoucherDates_(rows);
 if (dateProblems.length && !(body && body.allowDate)) return voucherDateBlockResponse_(dateProblems, SALE_REVIEW_SHEET);

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
 // 품목등록마스터에 등록된 이름/규격을 최종값으로 쓴다(구매확인중 확정 로직과 동일한 안전망 —
 // 드롭다운으로 품목코드만 바꾸고 이름/규격 텍스트는 그대로 둔 채 확정해도 등록되는 이름/규격이
 // 실제 코드와 어긋나지 않게 한다).
 const masterSheetForConfirm = ss.getSheetByName(MASTER_SHEET);
 const masterDataForConfirm = masterSheetForConfirm ? masterSheetForConfirm.getDataRange().getValues() : [];

 const finalRows = rows.map(function (r) {
 const code = parseItemCode(r[9]);
 const masterMatch = code ? lookupMasterItemByCode(masterDataForConfirm, code) : null;
 // 공급가액/부가세는 시트에 남아있는(수정 전 기준으로 계산된) 값을 믿지 않고, 수량/단가를
 // 시트에서 직접 고친 경우에도 정확히 반영되도록 항상 현재 수량*단가로 다시 계산한다.
 const qty = Number(r[12]) || 0;
 const unitPrice = Math.round(Number(r[13]) || 0);
 const supply = Math.round((unitPrice * qty) / 1.1);
 const vat = Math.round(unitPrice * qty) - supply;
 return {
 date: r[0], seq: r[1], vendorCode: r[2], vendorName: r[3], manager: r[4], warehouse: r[5],
 dealType: r[6], currency: r[7], rate: r[8],
 itemCode: code,
 itemName: masterMatch ? masterMatch.name : r[10],
 spec: masterMatch ? masterMatch.spec : r[11],
 qty: qty, unitPrice: unitPrice, foreignAmount: r[14], supply: supply, vat: vat, note: stripSaleWarning(r[17]),
 site: String(r[20] || '').trim()
 };
 });

 const vendorName = String(rows[0][3] || '').trim();
 const vendorInfo = findSaleVendor(vendorName);

 // ---- 판매는 신규 품목을 등록하지 않는다 - 품목코드가 비어있는 행이 남아있으면 확정을 막는다 ----
 // (buildSaleRows가 항상 가장 비슷한 기존 품목으로 강제 매칭해두므로, 여기서 비어있다는 건
 // 마스터에 품목이 하나도 없거나 사람이 드롭다운에서 일부러 코드를 지운 경우뿐이다.)
 const missingCodeNames = finalRows.filter(function (r) { return !r.itemCode; }).map(function (r) { return r.itemName; });
 if (missingCodeNames.length) {
 throw new Error('품목코드가 없는 행이 있어요: ' + missingCodeNames.join(', ') + ' — "판매확인중" 시트에서 그 행의 품목코드 칸을 클릭해 기존 품목을 선택해주세요. 판매는 신규 품목을 자동 등록하지 않습니다.');
 }

 // 대표님 11/23: 판매전표에 현장명 기재 — 현장명이 비어 있으면 확정하지 않는다(시트 · 이카운트 모두 저장 전, 판매확인중은 그대로 남음).
 if (!finalRows.some(function (r) { return r.site; })) {
   throw new Error('현장명이 비어 있어 확정하지 않았어요 — "판매확인중" 시트 현장명 칸(U열)에 배송 주소를 넣고 다시 확정해주세요. (대표님 방침: 판매전표에 현장명 기재)');
 }
 const sheetGid = appendToSaleSheet(finalRows);

 // 판매확인중 시트는 헤더만 남기고 비움
 sheet.clear();
 sheet.appendRow(SALE_REVIEW_HEADERS);
 sheet.setFrozenRows(1);

 // ---- 이카운트 중계서버로 거래처 동기화 + 품목 동기화 + 판매전표 저장 ----
 // 실패해도 구글시트 저장은 이미 끝난 뒤이므로 흐름을 막지 않고 결과만 응답에 담아 돌려준다.
 // 판매거래처 시트 E열(이카운트거래처코드)이 있으면 등록을 부르지 않는다(중복 거래처 방지, 2026-11-20 공간제작소).
 const ecountVendorResult = ecountSyncVendor(vendorName, vendorInfo ? vendorInfo.businessNo : '', vendorInfo ? vendorInfo.ecountCode : '');
 if (vendorInfo) saveRegisteredEcountVendorCode_(SALE_VENDOR_SHEET, vendorInfo.rowIndex, vendorInfo.businessNo, ecountVendorResult);

 // 이미 이카운트에 있는 품목(1시간 대조에서 ✓ 일치 / ✎ 수정으로 확인된 품목)은 다시 등록하지 않는다.
 // 다시 보내면 "이미 존재하는 코드" 오류가 나서 이카운트 시간당 연속 오류 30건 한도를 깎아 먹는다.
 const inEcount = {};
 for (let m = 1; m < masterDataForConfirm.length; m++) {
 if (isItemKnownInEcount_(masterDataForConfirm[m][ITEM_STATUS_COL - 1])) inEcount[String(masterDataForConfirm[m][0] || '').trim()] = true;
 }
 const codesToSync = finalRows.map(function (r) { return r.itemCode; })
 .filter(function (c, i, arr) { return c && arr.indexOf(c) === i && !inEcount[c]; });
 const ecountItemResults = codesToSync.length ? ecountSyncItemsByCode(codesToSync) : [];

 const whCd = PropertiesService.getScriptProperties().getProperty('ECOUNT_DEFAULT_SHIP_WH_CD') || '';
 // 구매(Purchase.js)와 같은 원칙: 이름(CUST_DES)만 보내면 이카운트가 거래처를 못 찾아 미수금(잔액)이
 // 그 업체에 잡히지 않는다. 판매거래처 시트 E열(이카운트거래처코드)을 최우선, 없으면 사업자등록번호를 CUST_CD로 보낸다.
 const custCd = vendorInfo && vendorInfo.ecountCode ? vendorInfo.ecountCode
 : (vendorInfo && vendorInfo.businessNo ? String(vendorInfo.businessNo).replace(/\D/g, '') : '');
 // 한 전표 = 한 현장. 줄마다 다르게 적혀 있으면 첫 번째 값으로 통일한다.
 const site = (finalRows.filter(function (r) { return r.site; })[0] || {}).site || '';
 const pushRows = finalRows.filter(function (r) { return r.itemCode; }).map(function (r) {
 return { date: r.date, custCd: custCd, custDes: vendorName, whCd: whCd, prodCd: r.itemCode, prodDes: r.itemName, qty: r.qty, unitPriceVat: r.unitPrice, supply: r.supply, vat: r.vat, remarks: ecountSafeRemarks_(r.note), site: site };
 });
 let ecountSaleResult;
 if (!pushRows.length) {
 ecountSaleResult = { ok: false, error: '품목코드가 매칭된 행이 없어 이카운트 판매전표 저장을 건너뛰었습니다.' };
 } else if (!whCd) {
 ecountSaleResult = { ok: false, error: 'ECOUNT_DEFAULT_SHIP_WH_CD 스크립트 속성이 없어 이카운트 판매전표 저장을 건너뛰었습니다. Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성에서 출하창고의 이카운트 창고코드를 등록해주세요.' };
 } else {
 ecountSaleResult = ecountSyncSale(pushRows);
 }

 return jsonOut({ ok: true, vendorName: vendorName, savedCount: finalRows.length, rows: finalRows, sheetGid: sheetGid,
 site: site, siteMissing: !site,
 ecount: { vendor: ecountVendorResult, items: ecountItemResults, sale: ecountSaleResult } });
 }

 // ---- 품목코드 매칭 + 공급가액/부가세 계산해서 행 조립 ----
 // 품목등록마스터는 구매 때 등록된 것을 그대로 재사용한다 — 같은 품목을 사고 팔기 때문.
 // 판매는 신규 품목을 만들지 않는다(이미 등록된 품목만 팔 수 있음) — 정확히 매칭 안 되는 품목도
 // 그냥 비워두지 않고, 마스터 전체에서 가장 비슷한 기존 품목으로 강제 매칭한다. 확신이 낮은
 // (편집거리 기반 추측) 매칭은 note에 표시해서 검토 화면/시트에서 사람이 확인·수정하게 한다.
 function buildSaleRows(parsed, vendorName) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const masterSheet = ss.getSheetByName(MASTER_SHEET);
 const masterData = masterSheet.getDataRange().getValues();
 const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
 const docDate = normalizeDateYyyyMmDd(parsed.docDate) || today;

 // 품명이 같아도 규격이 다르면 다른 품목이므로, 매칭도 품명+규격을 묶은 키로 구분한다.
 function itemKey(name, spec) { return String(name || '').trim() + '|||' + String(spec || '').trim(); }

 // 품목코드를 직접 지정한 줄은 이름이 같은 다른 코드(예: 히트타일 번호 vs 구매처 코드)로 잘못 잡히지 않게 코드로 바로 찾는다.
 function lineKey(it) { return it.code ? 'CODE:' + it.code : itemKey(it.name, it.spec); }
 const codeMap = {};
 parsed.items.forEach(function (it) {
 const key = lineKey(it);
 if (codeMap[key] !== undefined) return;
 if (it.code) {
 let row = null;
 for (let r = 1; r < masterData.length; r++) { if (String(masterData[r][0] || '').trim() === it.code) { row = masterData[r]; break; } }
 codeMap[key] = row ? { match: normalizeMasterMatch(row), guessed: false } : { match: null, guessed: false, badCode: it.code };
 return;
 }
 // 고객사(거래처)는 우리가 어디서 사왔는지와 무관하므로, 거래처로 좁히지 않고 전체 마스터에서 찾는다
 // (배송 매칭과 같은 이유: 배송받는/구매하는 고객사는 품목등록마스터의 매입 거래처와 무관함).
 let match = findMasterItemAnyVendor(masterData, it.name, it.price, it.spec);
 let guessed = false;
 if (!match) { match = findClosestMasterItemAnyVendor(masterData, it.name, it.spec); guessed = true; }
 codeMap[key] = match ? { match: match, guessed: guessed } : null;
 });

 const built = parsed.items.map(function (it, i) {
 const key = lineKey(it);
 const entry = codeMap[key];
 const match = entry ? entry.match : null;
 const code = match ? match.code : '';
 const finalName = match ? match.name : it.name;
 const finalSpec = match && match.spec ? match.spec : (it.spec || '');
 // 카톡 캡처 등 가격이 안 적힌 주문은, 매칭된 기존 품목이면 마스터에 등록된 출고단가를 그대로 쓴다.
 const unitPrice = Math.round(Number(it.price) || (match && match.outPrice) || 0);
 const qty = Number(it.qty) || 0;
 const supply = Math.round((unitPrice * qty) / 1.1);
 const vat = Math.round(unitPrice * qty) - supply;

 let warning = '';
 if (!match && entry && entry.badCode) warning = '⚠ 지정한 품목코드 ' + entry.badCode + '가 품목등록마스터에 없어요 - 품목코드 칸에서 직접 선택해주세요';
 else if (!match) warning = '⚠ 품목마스터에 등록된 품목이 없어 매칭하지 못했어요 - 품목코드 칸에서 직접 선택해주세요';
 else if (entry.guessed) warning = '⚠ 가장 비슷한 기존 품목으로 자동 매칭됨 - 맞는지 확인해주세요';
 // 적요 = 공간명. 확인용 경고는 뒤에 붙였다가 확정할 때 stripSaleWarning으로 떼어낸다
 const note = [it.memo || '', warning].filter(String).join(NOTE_SEP);

 return {
 date: normalizeDateYyyyMmDd(it.date) || docDate,
 seq: i + 1,
 vendorCode: '',
 vendorName: vendorName,
 manager: '',
 warehouse: DEFAULT_SHIP_WAREHOUSE,
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
 note: note,
 site: String(parsed.site || '').trim(),
 _memo: it.memo || '',
 _warning: warning
 };
 });
 return mergeSameSaleItems_(built);
 }

 // ---- 같은 품목(품목코드 · 규격 · 단가가 같은 줄)은 한 줄로 합치고, 적요에 위치를 모두 적는다 (대표님 방식) ----
 // 예: PVC 연그레이 외욕실 3 / 내욕실 3 / 주방 1 -> PVC 연그레이 7, 적요 "외욕실·내욕실·주방".
 // 품목코드가 없는 줄(매칭 실패)은 품목명+규격이 같을 때만 합친다. 날짜가 다르면 합치지 않는다.
 function mergeSameSaleItems_(rows) {
 const out = [];
 const byKey = {};
 rows.forEach(function (r) {
 const key = [r.date, r.itemCode || ('NAME:' + r.itemName), r.spec, r.unitPrice].join('|||');
 const prev = byKey[key];
 if (!prev) {
 const copy = Object.assign({}, r);
 copy._memos = r._memo ? [r._memo] : [];
 byKey[key] = copy;
 out.push(copy);
 return;
 }
 prev.qty += r.qty;
 if (r._memo) {
 r._memo.split('·').forEach(function (m) { m = m.trim(); if (m && prev._memos.indexOf(m) === -1) prev._memos.push(m); });
 }
 });
 return out.map(function (r, i) {
 const memo = r._memos.join('·');
 const supply = Math.round((r.unitPrice * r.qty) / 1.1);
 const res = Object.assign({}, r, {
 seq: i + 1,
 supply: supply,
 vat: Math.round(r.unitPrice * r.qty) - supply,
 note: [memo, r._warning].filter(String).join(NOTE_SEP)
 });
 delete res._memo; delete res._memos; delete res._warning;
 return res;
 });
 }

 // ---- 판매입력 시트에 누적 저장 (Ecount 양식 컬럼 순서 그대로) — 시트가 없으면 헤더까지 새로 만든다 ----
 function appendToSaleSheet(rows) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(SALE_SHEET);
 if (!sheet) {
 sheet = ss.insertSheet(SALE_SHEET);
 setupSaleSheet(sheet);
 }
 rows.forEach(function (r) {
 sheet.appendRow([
 r.date, r.seq, r.vendorCode, r.vendorName, r.manager, r.warehouse,
 r.dealType, r.currency, r.rate, r.itemCode, r.itemName, r.spec,
 r.qty, r.unitPrice, r.foreignAmount, r.supply, r.vat, r.note
 ]);
 });
 return sheet.getSheetId();
 }

 // ---- 판매입력 탭 헤더 세팅 (시트 최초 생성 시 자동 호출됨. 필요하면 Run 버튼으로 직접 실행도 가능) ----
 function setupSaleSheet(sheetArg) {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = sheetArg || ss.getSheetByName(SALE_SHEET);
 const header = ['일자', '순번', '거래처코드', '거래처명', '담당자', '출하창고', '거래유형', '통화', '환율', '품목코드', '품목명', '규격명', '수량', '단가(vat포함)', '외화금액', '공급가액', '부가세', '적요'];
 sheet.getRange(1, 1, 1, header.length).setValues([header]);
 sheet.setFrozenRows(1);
 }

// ---- 판매입력 조회 (읽기 전용) ----
// 이카운트 OAPI에 판매 조회가 없어서, 우리 시스템으로 저장한 판매(판매입력 시트)를 화면 조작 없이 읽는다.
// body: { vendor: '리바스'(거래처명 일부, 선택), from: '2026-11-18', to: '2026-11-18'(선택) }
// 주의: 이카운트 화면에서 직접 입력한 전표는 이 시트에 없다.
function handleSaleList(body) {
 const vendorQ = normalizeVendorName(String(body.vendor || ''));
 const toNum = function (v) {
 if (v instanceof Date) return Number(Utilities.formatDate(v, 'Asia/Seoul', 'yyyyMMdd'));
 const d = String(v || '').replace(/\D/g, '');
 return d.length >= 8 ? Number(d.slice(0, 8)) : 0;
 };
 const from = toNum(body.from) || 0;
 const to = toNum(body.to) || 99991231;
 const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SALE_SHEET);
 const values = (sheet && sheet.getLastRow() >= 2) ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues() : [];
 const slips = {};
 values.forEach(function (r) {
 const d = toNum(r[0]);
 if (!d || d < from || d > to) return;
 if (vendorQ && normalizeVendorName(String(r[3])).indexOf(vendorQ) < 0) return;
 const key = d + '-' + r[1] + '-' + r[3];
 if (!slips[key]) slips[key] = { source: '판매등록', date: String(d), seq: r[1], vendorName: r[3], items: [], supply: 0, vat: 0, total: 0, note: '' };
 const s = slips[key];
 const supply = Number(r[15]) || 0, vat = Number(r[16]) || 0;
 s.items.push({ itemCode: r[9], itemName: r[10], spec: r[11], qty: r[12], unitPrice: r[13], supply: supply, vat: vat, note: r[17] });
 s.supply += supply; s.vat += vat; s.total += supply + vat;
 if (!s.note && r[17]) s.note = String(r[17]);
 });
 // 이카운트판매 시트(까망이 PC가 매일 이카운트 판매조회 엑셀을 올림) — 이카운트에서 직접 입력한 전표까지 포함
 const ecSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(ECOUNT_SALE_SHEET);
 if (ecSheet && ecSheet.getLastRow() >= 2) {
 ecSheet.getRange(2, 1, ecSheet.getLastRow() - 1, ECOUNT_SALE_HEADER.length).getValues().forEach(function (r) {
 const d = toNum(r[0]);
 if (!d || d < from || d > to) return;
 if (vendorQ && normalizeVendorName(String(r[2])).indexOf(vendorQ) < 0) return;
 const key = 'EC-' + r[1];
 if (!slips[key]) slips[key] = { source: '이카운트', date: String(d), seq: r[1], vendorName: r[2], site: r[3], items: [], supply: 0, vat: 0, total: 0, note: '' };
 const s = slips[key];
 const supply = Number(r[9]) || 0, vat = Number(r[10]) || 0, total = Number(r[11]) || (supply + vat);
 s.items.push({ itemCode: r[4], itemName: r[5], spec: r[6], qty: r[7], unitPrice: r[8], supply: supply, vat: vat, total: total });
 s.supply += supply; s.vat += vat; s.total += total;
 });
 }
 const list = Object.keys(slips).map(function (k) { return slips[k]; })
 .sort(function (a, b) { return (a.date + a.seq) < (b.date + b.seq) ? -1 : 1; });
 const ecLast = ecSheet && ecSheet.getLastRow() >= 2 ? String(ecSheet.getRange(1, ECOUNT_SALE_HEADER.length + 1).getValue() || '') : '';
 return jsonOut({ ok: true, count: list.length, slips: list, ecountImportedAt: ecLast, warning: '이카운트 전표는 까망이 PC가 올린 시점(ecountImportedAt)까지만 들어 있습니다. 판매등록 전표와 같은 건이 두 번(source 다름) 나올 수 있습니다.' });
}

// ---- 판매입력 시트 줄 지우기 (좁은 기능 — 이카운트 전송 실패로 시트에만 남은 줄 정리용, 대표님 OK 후) ----
// 이카운트는 건드리지 않는다. 판매입력 시트의 줄만 지운다.
// 찾기(읽기 전용): { find: { date: '2026-11-21', vendor: '개성인테리어'(일부), note: '신당동'(적요 일부) } }
//   → 조건에 맞는 줄의 실제 행 번호 + 내용을 돌려준다(지우지 않음).
// 지우기: { rows: [{ row: 25, date, vendorName, itemCode, note }], dryRun: true|false }
//   → 각 행의 실제 일자 · 거래처명 · 품목코드 · 적요가 기대값과 「전부」 같을 때만, 아래 행부터 위로 지운다.
//     하나라도 다르면 한 줄도 지우지 않는다. dryRun이면 대조 결과만 돌려준다.
function handleSaleSheetDeleteRows(body) {
 const ymd = function (v) {
 if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyyMMdd');
 const d = String(v || '').replace(/\D/g, '');
 return d.length >= 8 ? d.slice(0, 8) : '';
 };
 const str = function (v) { return String(v == null ? '' : v).trim(); };
 const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SALE_SHEET);
 if (!sheet) throw new Error('판매입력 시트가 없습니다.');
 const lastRow = sheet.getLastRow();
 const rowInfo = function (n, r) {
 return { row: n, date: ymd(r[0]), seq: r[1], vendorName: str(r[3]), itemCode: str(r[9]), itemName: str(r[10]),
 qty: r[12], unitPrice: r[13], supply: Number(r[15]) || 0, vat: Number(r[16]) || 0, note: str(r[17]) };
 };

 // 1) 찾기 — 읽기 전용
 if (body.find) {
 const f = body.find;
 const fDate = ymd(f.date), fVendor = normalizeVendorName(str(f.vendor)), fNote = str(f.note);
 if (!fDate) throw new Error('find.date(일자)가 필요합니다.');
 const values = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 18).getValues() : [];
 const found = [];
 values.forEach(function (r, i) {
 if (ymd(r[0]) !== fDate) return;
 if (fVendor && normalizeVendorName(str(r[3])).indexOf(fVendor) < 0) return;
 if (fNote && str(r[17]).indexOf(fNote) < 0) return;
 found.push(rowInfo(i + 2, r));
 });
 return jsonOut({ ok: true, mode: 'find', count: found.length, rows: found });
 }

 // 2) 대조 후 지우기
 const targets = Array.isArray(body.rows) ? body.rows : [];
 if (!targets.length) throw new Error('rows(지울 행 목록) 또는 find(찾기 조건)가 필요합니다.');
 if (targets.length > 50) throw new Error('한 번에 50줄까지만 지울 수 있습니다.');
 const lock = LockService.getScriptLock();
 lock.waitLock(30000);
 try {
 const seen = {};
 const checks = targets.map(function (t) {
 const n = Number(t.row);
 if (!(n >= 2 && n <= sheet.getLastRow() && Math.floor(n) === n)) return { row: t.row, ok: false, reason: '행 번호가 범위 밖' };
 if (seen[n]) return { row: n, ok: false, reason: '행 번호 중복' };
 seen[n] = true;
 const r = sheet.getRange(n, 1, 1, 18).getValues()[0];
 const actual = rowInfo(n, r);
 const diff = [];
 if (actual.date !== ymd(t.date)) diff.push('일자');
 if (actual.vendorName !== str(t.vendorName)) diff.push('거래처명');
 if (actual.itemCode !== str(t.itemCode)) diff.push('품목코드');
 if (actual.note !== str(t.note)) diff.push('적요');
 return { row: n, ok: diff.length === 0, reason: diff.length ? '다름: ' + diff.join(', ') : '', actual: actual };
 });
 const allOk = checks.every(function (c) { return c.ok; });
 if (body.dryRun || !allOk) {
 return jsonOut({ ok: allOk, mode: 'check', dryRun: !!body.dryRun, deleted: 0, checks: checks,
 error: allOk ? undefined : '기대값과 다른 행이 있어 한 줄도 지우지 않았습니다.' });
 }
 const order = checks.map(function (c) { return c.row; }).sort(function (a, b) { return b - a; });
 order.forEach(function (n) { sheet.deleteRow(n); });
 return jsonOut({ ok: true, mode: 'delete', deleted: order.length, deletedRows: order, checks: checks });
 } finally {
 lock.releaseLock();
 }
}

// ---- 이카운트 판매조회 엑셀 → 「이카운트판매」 시트 (까망이 PC 프로그램이 하루 1번 올림) ----
// 이카운트 OAPI에 판매 조회가 없어서, PC가 판매조회 화면의 엑셀을 내려받아 줄 단위로 보낸다.
// body: { from: '2026-11-01', to: '2026-11-19', rows: [{ date, slipNo('2026/11/17-9'), vendorName, site, itemCode, itemName, spec, qty, unitPrice, supply, vat, total }] }
// from~to 기간의 기존 줄을 지우고 새 줄로 바꾼다(같은 기간을 다시 올려도 중복 없음). 이카운트는 건드리지 않는다.
const ECOUNT_SALE_SHEET = '이카운트판매';
const ECOUNT_SALE_HEADER = ['일자', '전표번호', '거래처명', '현장명', '품목코드', '품목명', '규격', '수량', '단가', '공급가액', '부가세', '합계'];
function handleImportEcountSales(body) {
 const toNum = function (v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 8 ? Number(d.slice(0, 8)) : 0; };
 const from = toNum(body.from), to = toNum(body.to);
 if (!from || !to || from > to) throw new Error('from · to(기간)가 필요합니다.');
 const rows = Array.isArray(body.rows) ? body.rows : [];
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 let sheet = ss.getSheetByName(ECOUNT_SALE_SHEET);
 if (!sheet) {
 sheet = ss.insertSheet(ECOUNT_SALE_SHEET);
 sheet.getRange(1, 1, 1, ECOUNT_SALE_HEADER.length).setValues([ECOUNT_SALE_HEADER]);
 sheet.setFrozenRows(1);
 }
 const lock = LockService.getScriptLock(); lock.waitLock(30000);
 try {
 const keep = sheet.getLastRow() >= 2
 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, ECOUNT_SALE_HEADER.length).getValues().filter(function (r) { const d = toNum(r[0]); return d && (d < from || d > to); })
 : [];
 const add = [];
 rows.forEach(function (r) {
 const d = toNum(r.date);
 if (!d || d < from || d > to) return;
 add.push([String(d), String(r.slipNo || ''), String(r.vendorName || ''), String(r.site || ''), String(r.itemCode || ''), String(r.itemName || ''), String(r.spec || ''),
 Number(r.qty) || 0, Number(r.unitPrice) || 0, Number(r.supply) || 0, Number(r.vat) || 0, Number(r.total) || 0]);
 });
 const all = keep.concat(add).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1); });
 if (sheet.getLastRow() >= 2) sheet.getRange(2, 1, sheet.getLastRow() - 1, ECOUNT_SALE_HEADER.length).clearContent();
 if (all.length) sheet.getRange(2, 1, all.length, ECOUNT_SALE_HEADER.length).setNumberFormat('@').setValues(all);
 const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' (' + from + '~' + to + ')';
 sheet.getRange(1, ECOUNT_SALE_HEADER.length + 1).setValue(stamp);
 return jsonOut({ ok: true, replacedRange: from + '~' + to, added: add.length, kept: keep.length, importedAt: stamp });
 } finally { lock.releaseLock(); }
}

// ---- 판매거래처 한 줄 넣기 · 바로잡기 (클라우드 세션이 시트에 직접 넣는 용도, 대표님 지시 2026-11-20) ----
// action: 'sale_vendor_upsert'
// body: { name, bizNo, ceo, phone, ecountCode, dryRun }
//  - A열이 name과 정확히 같은 줄, 또는 A열이 "name |"로 시작하는 깨진 줄(한 칸에 통째로 붙여 넣은 것)을 찾아 그 줄의 A~E만 고친다.
//  - 없으면 맨 아래에 새 줄. 같은 이름 줄이 2개 이상이면 아무것도 안 쓰고 오류.
//  - dryRun=true면 쓰지 않고 바꾸기 전/후만 돌려준다. 다른 줄 · 다른 열은 건드리지 않고, 지우지도 않는다.
//  - 사업자번호 · 거래처코드 · 전화는 하이픈 그대로 글자로 저장(숫자로 바뀌지 않게 서식 '@').
function handleSaleVendorUpsert(body) {
  const t = function (v) { return String(v == null ? '' : v).trim(); };
  const name = t(body.name);
  if (!name) throw new Error('거래처명(name)이 없습니다.');
  const dryRun = body.dryRun === true;
  const after = [name, t(body.bizNo), t(body.ceo), t(body.phone), t(body.ecountCode)];

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 작업이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    const sheet = setupSaleVendorSheet();
    const lastRow = sheet.getLastRow();
    const data = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues() : [];
    const hits = [];
    for (let i = 0; i < data.length; i++) {
      const a = t(data[i][0]);
      if (a === name || a.indexOf(name + ' |') === 0) hits.push({ row: i + 2, before: data[i].slice(0, 5), broken: a !== name });
    }
    if (hits.length > 1) {
      return jsonOut({ ok: false, error: '같은 이름 줄이 ' + hits.length + '개 있어 아무것도 쓰지 않았습니다.', rows: hits });
    }
    const hit = hits[0];
    const row = hit ? hit.row : lastRow + 1;
    const result = { ok: true, dryRun: dryRun, mode: hit ? (hit.broken ? '깨진 줄 바로잡기' : '기존 줄 고치기') : '새 줄 추가',
      row: row, before: hit ? hit.before : null, after: after };
    if (!dryRun) {
      const range = sheet.getRange(row, 1, 1, 5);
      range.setNumberFormat('@');
      range.setValues([after]);
      SpreadsheetApp.flush();
      result.saved = sheet.getRange(row, 1, 1, 5).getDisplayValues()[0];
    }
    return jsonOut(result);
  } finally {
    lock.releaseLock();
  }
}


// 이카운트 적요(REMARKS)는 특수문자(→ · — 등)가 있으면 「적요(특수문자)」 오류로 전표 전체가 저장되지 않는다
// (2026-11-23 신당동 반품). 한글 · 영문 · 숫자 · 공백 · 기본 문장부호만 남긴다. 구글시트 기록은 그대로 둔다.
function ecountSafeRemarks_(note) {
  return String(note || '').replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ\s()\[\].,\-\/:*+#%&]/g, ' ').replace(/\s+/g, ' ').trim();
}
