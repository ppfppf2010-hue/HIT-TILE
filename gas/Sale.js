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
 '원본품목명(자동,수정금지)', '원본규격(자동,수정금지)'];

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

 const rows = [
 ['(주)디자인디오스','','정수표','','5028189529'],
 ['(주)아인','','안수경','','5038179062'],
 ['(주)하이홈','','정성미','','4048702477'],
 ['CREER DESIGN','','','010-2531-0900','00181'],
 ['LX지인 달서점 스타일하우스','','이정희','','3932001345'],
 ['가가인테리어','502-24-16867','이광섭','010-2533-0802','502-24-16867'],
 ['가람인테리어','463-30-00509','임태원','053-742-0431','463-30-00509'],
 ['개성인테리어','','유영환','01020515150','8040103158'],
 ['개인김철완','','','01044145222','00048'],
 ['고령예가인테리어','','','','00062'],
 ['고운디자인','','손성원','','5052120898'],
 ['공간플랜','','정상훈','01088817593','5571301640'],
 ['권패밀리','409-36-01016','KWON SELVA','010-7455-9770','409-36-01016'],
 ['글로벌하우징','339-11-02765','이기욱','010-38224745','339-11-02765'],
 ['글로우마이너','','신재욱','','2112822928'],
 ['나멜','','안지열','01040794868','7862001080'],
 ['뉴타운인테리어','','박준영','','4140794711'],
 ['다희 디자인','','박치현','010-6559-2636','1213792249'],
 ['더 그리다','','김경진','010-4130-1993','00027'],
 ['더봄디자인','783-29-01895','배연한','010-4533-7247','783-29-01895'],
 ['더블유오에이 스튜디오','','이상철','01099355560','8994300881'],
 ['더윈썸디자인','','이창원','','5784401001'],
 ['데일리디자인','598-28-01010','김건하','010-5322-9048','598-28-01010'],
 ['도도디자인','836-09-02604','장순필','010-5820-1249','836-09-02604'],
 ['도빌 디자인','225-07-96079','박태웅','010-2220-9733','225-07-96079'],
 ['도준승','328-05-02745','백선혜','01044711000','328-05-02745'],
 ['동진종합상사','504-23-88604','이수규','010-3529-4505','504-23-88604'],
 ['두꺼비집(지인)','514-13-69492','강상범','010-2526-8204','514-13-69492'],
 ['두손종합건설','','조정옥','','4408800754'],
 ['디어유니버스디자인','102-26-67587','김주언','010-8940-0481','102-26-67587'],
 ['디자인 비버','381-05-03046','곽동훈','','381-05-03046'],
 ['디자인 우리','783-21-00129','김성민','010-2651-4117','783-21-00129'],
 ['디자인 지안','','박신후','01055789975','3230400589'],
 ['디자인80','342-14-02762','정원우','010-3734-6676','342-14-02762'],
 ['디자인잇 (파운데스트 디자인)','268-35-00461','백유준','','268-35-00461'],
 ['레이백','603-17-52718','이상민','01049407227','603-17-52718'],
 ['로뎀인테리어','','하민철','01054440410','4071300313'],
 ['리바스타일&줄눈(최현우)','207-52-00973','김지인','010-7229-3665','207-52-00973'],
 ['리바트 리첸 범어점*퀵비선불','502-28-90981','김준현','0537591200','502-28-90981'],
 ['맥스터 인테리어(maxtor)','','김광석','010-9576-0916','8643301094'],
 ['무돌 리하우스','','김형준','','1621502391'],
 ['미자네 인테리어 조명','198-48-01045','이호섭','010-4611-5044','198-48-01045'],
 ['미품디자인','','허효섭','','6624001569'],
 ['바로 집수리','','정영숙','','1732203104'],
 ['바로집수리 (제갈동균)','765-22-01923','제갈동균','010-8933-8254','765-22-01923'],
 ['바른 타일','','박재형','01087188747','1254800771'],
 ['바스 스미스','345-12-02490','박영훈','010-4691-1995','345-12-02490'],
 ['블리스퍼니처','','류태환','','3303101850'],
 ['비버건축','','','','00178'],
 ['삼덕본타일','','서향숙,조원준','','7788600451'],
 ['삼성장식','','최진환','01093616818','5140581322'],
 ['삼성하우징 (까사세라믹)','','','010-3581-3505','00129'],
 ['삼현종합인테리어','','이현호','01036962210','7881401940'],
 ['석건축디자인(욜로)','468-54-00460','김석한','010-2808-5959','468-54-00460'],
 ['설렘디자인하우스','','설원형','01085635582','1193071830'],
 ['성심 인테리어','','장윤혁','01029342727','1224003147'],
 ['성운종합인테리어','','최선규','01045126104','7570601918'],
 ['수엘','','김재술','010-6686-0781','1804700581'],
 ['스토리 스튜디오','','장성재','','6594900780'],
 ['스튜디오 기와','','','','00163'],
 ['스페이스원','505-17-69292','원석주','010-7159-8926','505-17-69292'],
 ['신우데코','504-11-95612','이수복','','504-11-95612'],
 ['아이엠건설','705-04-03212','이현찬','010-6528-2329','705-04-03212'],
 ['아이원인테리어','','임용택','010-2640-7722','5043141074'],
 ['아하(AHA)','','노재영','','1304769606'],
 ['알토','774-29-01611','강부곤','010-4079-8366','774-29-01611'],
 ['에스씨세라믹','','','053-985-8907','00177'],
 ['에스엠 E.N.G','609-44-03472','홍성민','010-7643-5555','609-44-03472'],
 ['에이스 싱크','233-06-00989','박중한','010-3188-1929','233-06-00989'],
 ['에이치엠 건축','588-63-00524','김원호','010-8589-0581','588-63-00524'],
 ['예가인테리어','','백상현','01072293665','5032319384'],
 ['예담 인테리어','','강대권','01033775522','1701500133'],
 ['예승건축디자인','','손희수','','3350501685'],
 ['오픈하우스 디자인','','고흥석외 1명','','2851002608'],
 ['오피뉴','','이용광','01049407227','2271833644'],
 ['온유디자인','','노규한','','2661302869'],
 ['와이지타일','528-04-01693','전세한','010-7663-7900','528-04-01693'],
 ['우성 디자인 (달서점)','','손현기','010-2336-9920','8440702241'],
 ['우성 인테리어 (수성점)','807-06-03434','김은아','010-2336-9920','807-06-03434'],
 ['우진건축자재','504-29-43084','정대희','','504-29-43084'],
 ['울진 프렌치페이퍼 풀빌라 오션뷰 펜션 C','','백순옥','','5322102266'],
 ['유디자인','','김진욱','010-3836-3831','1993401212'],
 ['유진건설','','김현수','','00023'],
 ['으뜸 인테리어 디자인','169-13-01744','이재욱','010-7229-3665','169-13-01744'],
 ['이뎀디자인','','강유미','01052430875','3620100259'],
 ['이레테크','','윤성운','010-5800-3804','3760403241'],
 ['이재성 010-4856-9860','','','','00194'],
 ['인스페이스( IN SPACE )','','조수진','010-3217-4260','4670401345'],
 ['인우디자인','','양지은','01057008590','3732700870'],
 ['인홈','','','','00148'],
 ['장은건축','','','','00124'],
 ['정종찬(뉴타운직원)_','','','01051482428','00191'],
 ['주식회사 광해디자인','','신상규','0537190120','8568601901'],
 ['주식회사 노블건설','','신승용','053-784-0072','7608101769'],
 ['주식회사 로얄','','조재웅','','5148186961'],
 ['주식회사 부광건축디자인','301-87-02839','이승희','010-3504-9048','301-87-02839'],
 ['주식회사 뷰','','곽연정','','6328100806'],
 ['주식회사 빌드로우','468-87-02302','심혜란','010-2248-9530','468-87-02302'],
 ['주식회사 쓰리에프글로벌','502-81-92325','서범수','053-764-2240','502-81-92325'],
 ['주식회사 씨더블유티 (AT인테리어)','','오세현','01035850482','8518801083'],
 ['주식회사 올라운드 컴퍼니','','배진우','','5598702587'],
 ['주식회사 이앤에이치컴퍼니(개인 01074748406)','584-86-01350','김은철,전혜정','010-7474-8406','584-86-01350'],
 ['주식회사 재원건설','732-87-02009','김경순','0538024567','732-87-02009'],
 ['주식회사 홈스테드스테이','','이세중','','5578602809'],
 ['지음디자인컴퍼니','514-24-45856','김수영','','514-24-45856'],
 ['카린(CARYN)디자인','732-24-00724','신민규','010-2689-6230','732-24-00724'],
 ['케이타일','185-58-00729','김상욱','01022840157','185-58-00729'],
 ['큰나무 주식회사','625-88-00597','최일흠','','625-88-00597'],
 ['태흥전기조명(라피네) *퀵비선불','','배준희','','5041740180'],
 ['테스(TES)','285-18-01454','임태봉','010-2475-8485','285-18-01454'],
 ['플로이 스페이스 대구','752-38-01011','김지원','010-7229-3665','752-38-01011'],
 ['한반장','210-39-17559','한창현','010-8825-2788','210-39-17559'],
 ['한샘리하우스 진천대리점','596-76-00321','이충정','010-9355-5666','596-76-00321'],
 ['한샘키친 디자인율 대리점','717-71-00374','최성원','010-4602-1414','717-71-00374'],
 ['행복한집','','장정훈','01045431717','3243001047'],
 ['현대감각','','정원우','','5041933664']
 ];

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
 return { rowIndex: i + 1, storedName: stored.trim(), businessNo: String(data[i][1] || '').trim() };
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
 price: Number(it.unitPrice) || 0
 };
 })
 .filter(function (it) { return it.name && it.qty; });
 if (!items.length) throw new Error('품목명과 수량을 입력해주세요.');

 const parsed = { vendorName: vendorName, docDate: String(body.docDate || '').trim(), items: items };

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
 qty: qty, unitPrice: unitPrice, foreignAmount: r[14], supply: supply, vat: vat, note: r[17]
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
