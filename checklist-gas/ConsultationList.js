/**
 * 상담체크리스트 - 저장된 상담 목록 조회 + 취소 처리용 엔드포인트.
 * 기존 doPost/저장 로직은 건드리지 않고 새 파일로 얹는 초안입니다.
 * 로컬로 clasp clone 받은 뒤, 아래 두 상수만 채우면 됩니다.
 *
 * 주의: 프로젝트에 이미 doGet이 있다면 이름이 겹칩니다 — 그 경우 이 doGet의
 * 내용을 기존 doGet 안으로 옮겨 병합하세요 (README.md 참고).
 *
 * 이미 이 파일을 한 번 배포해서 CONSULTATION_SHEET_ID/NAME을 채워둔 상태라면,
 * 그 값은 그대로 두고 doGet / cancelConsultation / listConsultations 쪽만
 * 이 최신 버전 내용으로 바꿔주면 됩니다 (상담 취소 기능이 새로 추가됨).
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
