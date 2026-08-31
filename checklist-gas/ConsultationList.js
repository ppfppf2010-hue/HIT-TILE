/**
 * 상담체크리스트 - 저장된 상담 목록 조회용 엔드포인트.
 * 기존 doPost/저장 로직은 건드리지 않고 새 파일로 얹는 초안입니다.
 * 로컬로 clasp clone 받은 뒤, 아래 두 상수만 채우면 됩니다.
 *
 * 주의: 프로젝트에 이미 doGet이 있다면 이름이 겹칩니다 — 그 경우 이 doGet의
 * 내용을 기존 doGet 안으로 옮겨 병합하세요 (README.md 참고).
 */

// TODO: 상담체크리스트가 저장하는 스프레드시트 ID와 시트(탭) 이름을 채워주세요.
// 스프레드시트 ID는 주소창 .../d/<이 부분>/edit 에서 확인할 수 있습니다.
const CONSULTATION_SHEET_ID = 'PUT_SPREADSHEET_ID_HERE';
const CONSULTATION_SHEET_NAME = 'PUT_SHEET_NAME_HERE'; // 비워두면(빈 문자열) 첫 번째 시트를 사용

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'list';
    if (action === 'list') {
      return jsonOutList({ success: true, records: listConsultations() });
    }
    return jsonOutList({ success: false, error: '알 수 없는 action: ' + action });
  } catch (err) {
    return jsonOutList({ success: false, error: err.message });
  }
}

function listConsultations() {
  const ss = SpreadsheetApp.openById(CONSULTATION_SHEET_ID);
  const sheet = CONSULTATION_SHEET_NAME
    ? ss.getSheetByName(CONSULTATION_SHEET_NAME)
    : ss.getSheets()[0];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const rows = values.slice(1);

  return rows
    .map(row => {
      const rec = {};
      headers.forEach((h, i) => { rec[h] = row[i]; });
      rec['상태'] = '상담완료 발주대기'; // 저장된 상담은 전부 이 상태로 표시 (시트 컬럼 추가 불필요)
      return rec;
    })
    .reverse(); // 최근 저장분이 먼저 보이도록
}

function jsonOutList(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
