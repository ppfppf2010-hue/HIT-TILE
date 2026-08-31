/**
 * 상담체크리스트 - 저장된 상담 목록 조회용 엔드포인트.
 * 기존 doPost/저장 로직(Code.js)은 건드리지 않고 새 파일로 얹었습니다.
 */

const CONSULTATION_SHEET_ID = '1ZHTkKtNHqEHfh4scCVtbUIBZDvbxKVXX28m7skWqpZw';
const CONSULTATION_SHEET_NAME = 'Consultations';

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
