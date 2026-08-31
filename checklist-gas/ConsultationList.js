/**
 * 상담체크리스트 - 저장된 상담 목록 조회 + 취소 처리용 엔드포인트.
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
    if (action === 'cancel') {
      return jsonOutList(cancelConsultation(e.parameter.row));
    }
    return jsonOutList({ success: false, error: '알 수 없는 action: ' + action });
  } catch (err) {
    return jsonOutList({ success: false, error: err.message });
  }
}

function getConsultationSheet_() {
  const ss = SpreadsheetApp.openById(CONSULTATION_SHEET_ID);
  return CONSULTATION_SHEET_NAME ? ss.getSheetByName(CONSULTATION_SHEET_NAME) : ss.getSheets()[0];
}

function listConsultations() {
  const sheet = getConsultationSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const rows = values.slice(1);

  return rows
    .map((row, i) => {
      const rec = {};
      headers.forEach((h, idx) => { rec[h] = row[idx]; });
      if (!rec['상태']) rec['상태'] = '상담완료 발주대기'; // 아직 취소 안 된 건의 기본 상태
      rec['_row'] = i + 2; // 실제 시트 행 번호 (상담 취소 요청 때 그대로 돌려받아 사용)
      return rec;
    })
    .reverse(); // 최근 저장분이 먼저 보이도록
}

// ---- 상담 취소: 해당 행의 "상태" 칸에 "상담취소"를 기록한다 (컬럼이 없으면 맨 뒤에 새로 만듦) ----
function cancelConsultation(rowParam) {
  const row = parseInt(rowParam, 10);
  if (!row || row < 2) return { success: false, error: 'row 파라미터가 올바르지 않습니다.' };

  const sheet = getConsultationSheet_();
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let statusCol = headers.indexOf('상태') + 1; // 1-based, 없으면 0
  if (statusCol === 0) {
    statusCol = lastCol + 1;
    sheet.getRange(1, statusCol).setValue('상태');
  }
  sheet.getRange(row, statusCol).setValue('상담취소');
  return { success: true };
}

function jsonOutList(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
