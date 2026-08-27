/**
 * ===== 상담 체크리스트 저장소 (메인 스프레드시트로 통합) =====
 * 예전에는 체크리스트 페이지가 완전히 별도의 Apps Script/스프레드시트에 저장했는데,
 * 판매입력과 연동하려고 이 파일로 옮겨서 본사 메인 스프레드시트(SPREADSHEET_ID, Code.js)에 저장한다.
 *
 * 탭: 상담기록 (자동 생성됨, 미리 안 만들어도 됨)
 *   헤더: ID | 저장일시 | 업체 | 현장주소 | 연락처 | 현장비번 | 타일시공일 | 도기시공일 |
 *         타일JSON | 집기JSON | 특이사항
 */

const CONSULTATION_SHEET = '상담기록';
const CONSULTATION_HEADERS = ['ID', '저장일시', '업체', '현장주소', '연락처', '현장비번',
  '타일시공일', '도기시공일', '타일JSON', '집기JSON', '특이사항'];

function setupConsultationSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONSULTATION_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONSULTATION_SHEET);
    sheet.appendRow(CONSULTATION_HEADERS);
    sheet.setFrozenRows(1);
    const headerRange = sheet.getRange(1, 1, 1, CONSULTATION_HEADERS.length);
    headerRange.setFontWeight('bold').setBackground('#eef4ff');
  }
  return sheet;
}

// ---- 상담 체크리스트 저장 ----
function handleSaveConsultation(body) {
  const company = String(body.company || '').trim();
  if (!company) throw new Error('업체명이 없습니다.');

  const sheet = setupConsultationSheet();
  const id = Utilities.getUuid();
  const now = new Date();

  sheet.appendRow([
    id, now, company,
    String(body.address || '').trim(),
    String(body.contact || '').trim(),
    String(body.sitePw || '').trim(),
    body.tileDate || '',
    body.ceramicDate || '',
    JSON.stringify(body.tile || {}),
    JSON.stringify(body.fixture || {}),
    String(body.note || '').trim()
  ]);

  return jsonOut({ ok: true, id: id, timestamp: now.toISOString() });
}

// ---- 목차별(업체별) 보관 목록 - 요약 정보만, 무거운 JSON은 제외 ----
function handleListConsultations() {
  const sheet = setupConsultationSheet();
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][0] || '').trim();
    if (!id) continue;
    list.push({
      id: id,
      timestamp: data[i][1] instanceof Date ? data[i][1].toISOString() : String(data[i][1] || ''),
      company: String(data[i][2] || '').trim(),
      address: String(data[i][3] || '').trim(),
      tileDate: data[i][6] instanceof Date ? Utilities.formatDate(data[i][6], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(data[i][6] || ''),
      ceramicDate: data[i][7] instanceof Date ? Utilities.formatDate(data[i][7], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(data[i][7] || '')
    });
  }
  list.sort(function (a, b) { return b.timestamp.localeCompare(a.timestamp); });
  return jsonOut({ ok: true, list: list });
}

// ---- 상담 체크리스트 상세 1건 조회 (타일/집기 JSON 포함) ----
function handleGetConsultation(body) {
  const id = String(body.id || '').trim();
  if (!id) throw new Error('id가 없습니다.');

  const sheet = setupConsultationSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim() === id) {
      const row = data[i];
      return jsonOut({
        ok: true,
        record: {
          id: id,
          timestamp: row[1] instanceof Date ? row[1].toISOString() : String(row[1] || ''),
          '업체': String(row[2] || ''),
          '현장주소': String(row[3] || ''),
          '연락처': String(row[4] || ''),
          '현장비번': String(row[5] || ''),
          '타일시공일': row[6] instanceof Date ? Utilities.formatDate(row[6], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(row[6] || ''),
          '도기시공일': row[7] instanceof Date ? Utilities.formatDate(row[7], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(row[7] || ''),
          'tile_json': String(row[8] || '{}'),
          'fixture_json': String(row[9] || '{}'),
          '특이사항': String(row[10] || '')
        }
      });
    }
  }
  throw new Error('해당 상담 기록을 찾을 수 없습니다.');
}
