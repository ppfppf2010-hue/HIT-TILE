/**
 * * ===== 판매등록 자동화 (Google Apps Script) v2 =====
 * "직접 입력" 화면에서 거래처명+품목(수량/단가/단위)을 입력하면,
 * 기존 거래처코드관리/품목등록마스터 시트에서 코드를 매칭해
 * '판매입력' 탭에 Ecount 판매 일괄등록 양식 그대로 누적 저장한다.
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
 const DEFAULT_SHIP_WAREHOUSE = '본사창고'; // 추후 변경될 수 있음

 const SALE_REVIEW_HEADERS = ['일자', '순번', '거래처코드', '거래처명', '담당자', '출하창고', '거래유형', '통화', '환율',
 '품목코드', '품목명', '규격명', '수량', '단가(vat포함)', '외화금액', '공급가액', '부가세', '적요',
 '원본품목명(자동,수정금지)', '원본규격(자동,수정금지)'];

 // ---- 신규 거래처 접두어 확정 -> 거래처 등록 + 이어서 판매확인중 스테이징 ----
 function handleSaleRegisterVendor(body) {
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

 return finalizeSaleRegistration(parsed, vendorInfo, !!targetMonth);
 }

 // ---- 판매등록 "직접 입력" 탭: 거래처명+품목을 사람이 직접 입력한 것을 받아서 ----
 // handleSaleRegisterVendor와 완전히 같은 모양의 parsed 객체를 만들어서 같은 이후 흐름
 // (거래처 매칭 -> 필요시 접두어 등록 -> 판매확인중 스테이징)을 그대로 탄다.
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
 price: Number(it.unitPrice) || 0
 };
 })
 .filter(function (it) { return it.name && it.qty; });
 if (!items.length) throw new Error('품목명과 수량을 입력해주세요.');

 const parsed = { vendorName: vendorName, docDate: String(body.docDate || '').trim(), items: items };

 const vendorInfo = findVendor(vendorName);
 if (!vendorInfo) {
 return jsonOut({
 ok: true,
 needsPrefix: true,
 vendorName: vendorName,
 suggestedPrefix: matchPrefix(vendorName) || '',
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
 r.itemName, r.spec // 원본값 (수정 여부 비교용, 숨김열)
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
 function handleSaleConfirm() {
 const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
 const sheet = ss.getSheetByName(SALE_REVIEW_SHEET);
 if (!sheet) throw new Error('판매확인중 시트를 찾을 수 없습니다.');

 const data = sheet.getDataRange().getValues();
 if (data.length <= 1) throw new Error('판매확인중 시트에 저장할 품목이 없습니다. (다 지우신 건 아닌지 확인해주세요)');

 const rows = data.slice(1).filter(function (r) { return String(r[10]).trim() !== ''; });
 if (!rows.length) throw new Error('판매확인중 시트에 저장할 품목이 없습니다.');

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

 const finalRows = rows.map(function (r) {
 return {
 date: r[0], seq: r[1], vendorCode: r[2], vendorName: r[3], manager: r[4], warehouse: r[5],
 dealType: r[6], currency: r[7], rate: r[8], itemCode: parseItemCode(r[9]), itemName: r[10], spec: r[11],
 qty: r[12], unitPrice: r[13], foreignAmount: r[14], supply: r[15], vat: r[16], note: r[17]
 };
 });

 const vendorName = String(rows[0][3] || '').trim();
 const vendorInfo = findVendor(vendorName);

 // ---- 판매는 신규 품목을 등록하지 않는다 - 품목코드가 비어있는 행이 남아있으면 확정을 막는다 ----
 // (buildSaleRows가 항상 가장 비슷한 기존 품목으로 강제 매칭해두므로, 여기서 비어있다는 건
 // 마스터에 품목이 하나도 없거나 사람이 드롭다운에서 일부러 코드를 지운 경우뿐이다.)
 const missingCodeNames = finalRows.filter(function (r) { return !r.itemCode; }).map(function (r) { return r.itemName; });
 if (missingCodeNames.length) {
 throw new Error('품목코드가 없는 행이 있어요: ' + missingCodeNames.join(', ') + ' — "판매확인중" 시트에서 그 행의 품목코드 칸을 클릭해 기존 품목을 선택해주세요. 판매는 신규 품목을 자동 등록하지 않습니다.');
 }

 const sheetGid = appendToSaleSheet(finalRows);

 // 판매확인중 시트는 헤더만 남기고 비움
 sheet.clear();
 sheet.appendRow(SALE_REVIEW_HEADERS);
 sheet.setFrozenRows(1);

 // ---- 이카운트 중계서버로 거래처 동기화 + 품목 동기화 + 판매전표 저장 ----
 // 실패해도 구글시트 저장은 이미 끝난 뒤이므로 흐름을 막지 않고 결과만 응답에 담아 돌려준다.
 const ecountVendorResult = ecountSyncVendor(vendorName, vendorInfo ? vendorInfo.businessNo : '');

 const codesToSync = finalRows.filter(function (r) { return r.itemCode; }).map(function (r) { return r.itemCode; });
 const ecountItemResults = ecountSyncItemsByCode(codesToSync);

 const whCd = PropertiesService.getScriptProperties().getProperty('ECOUNT_DEFAULT_SHIP_WH_CD') || '';
 const pushRows = finalRows.filter(function (r) { return r.itemCode; }).map(function (r) {
 return { date: r.date, custDes: vendorName, whCd: whCd, prodCd: r.itemCode, prodDes: r.itemName, qty: r.qty, unitPriceVat: r.unitPrice, supply: r.supply, vat: r.vat, remarks: r.note || '' };
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

 const codeMap = {};
 parsed.items.forEach(function (it) {
 const key = itemKey(it.name, it.spec);
 if (codeMap[key] !== undefined) return;
 // 고객사(거래처)는 우리가 어디서 사왔는지와 무관하므로, 거래처로 좁히지 않고 전체 마스터에서 찾는다
 // (배송 매칭과 같은 이유: 배송받는/구매하는 고객사는 품목등록마스터의 매입 거래처와 무관함).
 let match = findMasterItemAnyVendor(masterData, it.name, it.price, it.spec);
 let guessed = false;
 if (!match) { match = findClosestMasterItemAnyVendor(masterData, it.name, it.spec); guessed = true; }
 codeMap[key] = match ? { match: match, guessed: guessed } : null;
 });

 return parsed.items.map(function (it, i) {
 const key = itemKey(it.name, it.spec);
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

 let note = '';
 if (!match) note = '⚠ 품목마스터에 등록된 품목이 없어 매칭하지 못했어요 - 품목코드 칸에서 직접 선택해주세요';
 else if (entry.guessed) note = '⚠ 가장 비슷한 기존 품목으로 자동 매칭됨 - 맞는지 확인해주세요';

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
 note: note
 };
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
