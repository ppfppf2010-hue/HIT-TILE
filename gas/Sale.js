/**
 * * ===== 판매등록 자동화 (Google Apps Script) v1 =====
 * 판매 거래명세서/세금계산서(히트타일이 발행한 것) PDF 또는 이미지를 업로드하면
 * Claude가 거래처명(공급받는자) + 품목(수량/단가/단위)을 추출하고,
 * 기존 거래처코드관리/품목등록마스터 시트에서 코드를 매칭해
 * '판매입력' 탭에 Ecount 판매 일괄등록 양식 그대로 누적 저장한다.
 *
 * Purchase.js(구매등록 자동화)를 그대로 미러링한 구조 — 방향만 반대(매입 -> 판매).
 * 품목등록마스터는 구매 때 등록된 것을 그대로 재사용한다(같은 품목을 사고 팔기 때문).
 *
 * 주의: 거래처코드(Ecount 자체 코드)/담당자/출하창고/거래유형은
 * 이 시스템에 매핑 정보가 없어 빈 칸으로 남긴다. 업로드 전 확인 필요.
 *
 * doPost action="sale_extract" 로 Code.gs의 doPost에서 라우팅됨.
 */

 const SALE_SHEET = '판매입력';
 const SALE_REVIEW_SHEET = '판매확인중';
 const DEFAULT_SHIP_WAREHOUSE = '본사창고'; // 추후 변경될 수 있음

 const SALE_REVIEW_HEADERS = ['일자', '순번', '거래처코드', '거래처명', '담당자', '출하창고', '거래유형', '통화', '환율',
 '품목코드', '품목명', '규격명', '수량', '단가(vat포함)', '외화금액', '공급가액', '부가세', '적요',
 '원본품목명(자동,수정금지)', '원본규격(자동,수정금지)'];

 // ---- 판매 문서 업로드 -> 거래처+품목 인식 + "판매확인중" 시트에 미리보기로 채워둠 ----
 // 거래처가 미등록 상태면 Claude를 다시 부르지 않고, 인식된 내용(parsed)을 그대로 프론트에 돌려줘서
 // 사용자가 접두어를 정하면 handleSaleRegisterVendor로 이어서 등록하게 한다(구매입력 페이지와 동일한 흐름).
 function handleSaleExtract(body) {
 const fileBase64 = body.fileBase64;
 const mimeType = body.mimeType || 'application/pdf';
 const targetMonth = String(body.targetMonth || '').trim(); // 'YYYY-MM', 선택 시 그 달 품목만 등록
 if (!fileBase64) throw new Error('파일이 없습니다.');

 const parsed = extractSaleWithClaude(fileBase64, mimeType, targetMonth);
 if (!parsed.vendorName) throw new Error('문서에서 거래처명을 인식하지 못했습니다.');
 if (!parsed.items || parsed.items.length === 0) throw new Error('문서에서 품목을 찾지 못했습니다.');

 filterSaleItemsByMonth(parsed, targetMonth);

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

 return finalizeSaleRegistration(parsed, vendorInfo, !!targetMonth);
 }

 // ---- 신규 거래처 접두어 확정 -> 거래처 등록 + 이어서 판매확인중 스테이징 (Claude 재호출 없음) ----
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

 // ---- 판매등록 "직접 입력" 탭: 사진/PDF 업로드 없이 사람이 직접 거래처명+품목을 입력한 경우 ----
 // Claude 추출 단계를 건너뛰고, 문서 인식 결과와 똑같은 모양의 parsed 객체를 만들어서
 // handleSaleExtract와 완전히 같은 이후 흐름(거래처 매칭 -> 필요시 접두어 등록 -> 판매확인중 스테이징)을 그대로 탄다.
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

 // ---- 문서 전체 기준 targetMonth 필터(재확인용) ----
 function filterSaleItemsByMonth(parsed, targetMonth) {
 if (!targetMonth) return;
 parsed.items = parsed.items.filter(function (it) {
 const d = String(it.date || parsed.docDate || '');
 return d.indexOf(targetMonth) === 0;
 });
 if (!parsed.items.length) {
 throw new Error('선택한 월(' + targetMonth + ')에 해당하는 품목을 찾지 못했어요. 문서의 날짜를 확인해주세요.');
 }
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
 // 구매등록과 마찬가지로, 미매칭 품목을 여기서 바로 신규 채번/등록하지 않는다. 인식 오류로 미매칭된
 // 품목이 계속 새 코드로 잘못 생성되는 문제 때문에, 코드가 빈 채로 "판매확인중" 시트에 올려서
 // 사람이 (a) 기존 코드로 지정하거나 (b) 그대로 둬서 confirm 시점에 신규 등록하게 한다.
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
 const match = findMasterItemAnyVendor(masterData, it.name, it.price, it.spec);
 if (match) codeMap[key] = match;
 });

 return parsed.items.map(function (it, i) {
 const key = itemKey(it.name, it.spec);
 const match = codeMap[key];
 const code = match ? match.code : '';
 const finalName = match ? match.name : it.name;
 const finalSpec = match && match.spec ? match.spec : (it.spec || '');
 // 카톡 캡처 등 가격이 안 적힌 주문은, 매칭된 기존 품목이면 마스터에 등록된 출고단가를 그대로 쓴다.
 const unitPrice = Math.round(Number(it.price) || (match && match.outPrice) || 0);
 const qty = Number(it.qty) || 0;
 const supply = Math.round((unitPrice * qty) / 1.1);
 const vat = Math.round(unitPrice * qty) - supply;

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
 note: code ? '' : '신규/미확인 - 기존 품목이면 품목코드 칸에서 검색해 선택, 신규 품목이면 비워둔 채 확정하면 자동 채번됩니다'
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

 // ---- Claude API 호출: 판매 거래명세서에서 거래처(공급받는자)+품목 추출 ----
 // 히트타일이 발행하는 문서이므로 구매 때와 반대로, "공급받는자"/"거래처명" 쪽이 실제 고객이고
 // "공급자"/발행자 쪽은 히트타일 자신이다. targetMonth('YYYY-MM')가 있으면 그 달 품목만 뽑도록
 // 프롬프트 단계에서부터 범위를 좁힌다(큰 문서 통째 추출 시 max_tokens 초과로 실패하는 것 방지).
 function extractSaleWithClaude(fileBase64, mimeType, targetMonth) {
 const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
 if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

 const correctionText = getCorrectionListText();
 const correctionBlock = correctionText
 ? ['', '[과거 교정 이력 - 우선 참고]',
 '아래는 과거에 사람이 직접 오타를 고친 이력입니다. 문서에서 이와 비슷하게 애매하게 보이는 품목명이 나오면, 아래 정정표현을 우선적으로 사용하세요.',
 correctionText, '']
 : [''];

 const systemPrompt = [
 '당신은 히트타일의 판매 기록(정식 거래명세서/세금계산서뿐 아니라, 카카오톡 등 메신저로 고객이 보낸 주문 캡처도 포함)에서 거래처명과 판매 품목을 추출하는 도우미입니다.',
 ''
 ].concat(correctionBlock).concat([
 '[거래처명 인식]',
 '- 정식 문서면 보통 "공급받는자:", "공급받는자명 :", "거래처명 :" 같은 라벨과 함께 실제 고객 회사명이 적혀 있습니다.',
 '- "공급자:"/"공급자명 :" 라벨 옆에는 대부분 히트타일 자신(대구/서울 등 지점명이 붙은 형태 포함)이 적혀 있습니다. 이건 절대 vendorName으로 쓰지 마세요 — 그건 우리 회사입니다.',
 '- 실제로 추출해야 할 거래처명은 "공급받는자"/"거래처명" 라벨 옆의 회사명(=우리 고객)입니다.',
 '- 이런 라벨이 아예 안 보이는 문서도 있습니다. 이 경우 문서 상단/하단에 실제 물건을 받은 쪽으로 보이는 회사명을 찾아 vendorName으로 쓰세요.',
 '- "거래명세표" 표준 양식은 거래처 정보 칸에 "상호(법인명)"과 "성명" 두 칸이 나란히 있습니다. 반드시 "상호(법인명)" 칸의 값(회사/상호명)을 vendorName으로 쓰세요 — 그 옆 "성명" 칸은 대표자 개인 이름이라 vendorName으로 쓰면 안 됩니다.',
 '- 카카오톡 등 메신저 캡처인 경우: 대화방 이름, 상대방 프로필명, 또는 대화 내용 중 언급된 업체명(현장명 포함)을 거래처명으로 쓰세요. 정말 아무 단서가 없으면 캡처 속 상대방 이름(개인명이라도)을 그대로 vendorName으로 쓰세요.',
 '',
 '[카카오톡/메신저 캡처 인식 - 표 형식 문서와 다름]',
 '- 이런 캡처는 표가 아니라 대화체입니다. "타일 20장 주세요", "OO 5개요" 처럼 품명+수량만 짧게 적혀 있고 규격/단가는 아예 없는 경우가 대부분입니다.',
 '- 품명은 정식 등록명이 아니라 손님이 부르는 약칭/줄임말/오타로 적혀있을 수 있습니다. 억지로 새 품목명을 만들지 말고, 실제 의미(제품 종류)가 통하도록 자연스러운 품명으로 정리해서 추출하세요 — 정확한 품목코드 매칭은 이후 별도 로직이 처리합니다.',
 '- 단가가 대화에 전혀 없으면 price를 0으로 두세요 (0이면 이후 로직이 기존 등록 단가를 자동으로 채웁니다). 절대 임의로 가격을 추측해서 채우지 마세요.',
 '- 수량 표현이 "장/개/박스/판" 등 다양하게 나올 수 있습니다. 문서에 적힌 단위 그대로 unit에 넣고, 숫자만 qty로 추출하세요.',
 '- 여러 사람이 순서대로 대화한 캡처면, 실제 "주문 확정"으로 보이는 메시지만 품목으로 반영하고, 단순 질문/잡담/이모티콘 메시지는 무시하세요.',
 '',
 '[품목 추출 규칙]',
 '1. 일자, 품명, 규격, 단위, 수량, 단가, 공급가액, 세액 컬럼이 있는 표에서 실제 품목 거래행만 추출합니다.',
 '2. 소계/합계/부가세 합계/월별집계 등 요약행은 무시하고 실제 품목행만 추출합니다.',
 '3. 단가는 부가세 포함 단가(vat포함) 기준으로 추출합니다. 문서에 공급가액과 세액이 따로 있으면 (공급가액+세액)/수량으로 계산해서 단가를 구하세요.',
 '4. 단위는 문서에 적힌 그대로(BOX, 포, SET, 통, EA, 봉지 등) 추출하세요. 단위가 없으면 "EA"로 둡니다.',
 '5. 문서에 날짜가 하나만 있으면 그 날짜를 docDate에 YYYY-MM-DD 형식으로 넣으세요. 여러 날짜가 섞여 있으면, 각 품목의 실제 거래일자를 그 품목 항목의 date 필드에 YYYY-MM-DD 형식으로 각각 넣으세요. 날짜에 연도가 없으면 문서의 기준일자 등 문맥으로 연도를 추론하세요.',
 '6. 컬럼 구성이 다르더라도, 고객이 지불하는 금액에 해당하는 단가 컬럼을 찾아 최대한 추출을 시도하세요. 설명이 필요해 보여도 거절하지 말고 best-effort로 JSON을 출력하세요.',
 '7. 이월, 전기이월, 수입, 대체, 대입, 입금, 카드, 통장결제, DC처리, 계좌변경 안내 같은 결제/이월/요약 행은 실제 판매 품목이 아니므로 items에서 제외하세요.',
 '8. 반품/취소 행은 별도 품목이 아니라 원래 품목의 수량을 마이너스로 처리한 것입니다. 문서의 수량(qty) 컬럼에 마이너스가 적혀 있으면 그대로 마이너스로 추출하세요. 수량은 양수인데 금액 컬럼만 마이너스라면, qty에도 마이너스 부호를 붙여서 추출하세요.',
 '9. 아래 JSON 형식으로만 출력하세요. 다른 설명이나 코드블록 표시 없이 순수 JSON 객체 하나만 출력합니다. 교정이력을 참고해서 무언가 고쳤더라도 그 사실을 설명하는 문장을 절대 앞뒤에 붙이지 마세요 - 오직 JSON 객체 하나만, 그 자체로 시작하고 끝나야 합니다.',
 '{"vendorName":"거래처 상호명","docDate":"YYYY-MM-DD","items":[{"name":"품목명","spec":"규격(없으면 빈 문자열)","unit":"단위","qty":숫자,"price":단가숫자,"date":"YYYY-MM-DD(해당 품목 행의 실제 날짜, 문서 전체가 한 날짜뿐이면 생략 가능)"}]}'
 ]).join('\n');

 const contentBlock = mimeType === 'application/pdf'
 ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
 : { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBase64 } };

 let userText = '이 판매 거래명세서에서 거래처와 품목을 규칙대로 추출해서 JSON 객체만 출력해줘.';
 if (targetMonth) {
 userText += ' 이 문서는 여러 달의 거래가 섞여 있을 수 있는데, ' + targetMonth + ' 월(YYYY-MM)에 해당하는 거래일자의 품목 행만 추출하고 다른 달의 행은 절대 items에 포함하지 마세요. vendorName/docDate는 문서 전체 기준으로 정상적으로 채우세요.';
 }

 const payload = {
 model: CLAUDE_MODEL,
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
 throw new Error('Claude가 이 문서에서 판매 정보를 추출하지 못했습니다: ' + jsonText.slice(0, 300));
 }
 }
