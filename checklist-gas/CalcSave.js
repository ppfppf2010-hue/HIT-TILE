/**
 * 상담체크리스트 - 타일량 계산기(tile-calc) 결과를 상담 행에 저장한다.
 * doPost에서 action === 'save_calc' 일 때 호출된다.
 *
 * 시트에 컬럼이 없으면 맨 뒤에 새로 만든다:
 *   calc_json  : 계산기 입력값 + 발주 품목/수량 (판매등록 연결, 계산기 다시 열기에 사용)
 *   수량요약   : 사람이 읽는 발주서 텍스트
 *   수량저장일 : 마지막 저장 시각
 * 같은 상담의 "히트타일 발주" 캘린더 일정 설명에도 수량을 덧붙인다.
 */

var CALC_BLOCK_START = '[타일 수량]';

function saveCalc_(data) {
  if (!data.id) return { success: false, error: '상담 id가 없습니다.' };
  var calc = data.calc || {};

  var sheet = getConsultationSheet_();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  var idCol = headers.indexOf('id') + 1;
  if (!idCol) return { success: false, error: '시트에 id 컬럼이 없습니다.' };

  var ids = sheet.getRange(2, idCol, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  var row = 0;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.id)) { row = i + 2; break; }
  }
  if (!row) return { success: false, error: '상담을 찾을 수 없습니다. (id: ' + data.id + ')' };

  var summary = calc.summary || '';
  sheet.getRange(row, ensureColumn_(sheet, headers, 'calc_json')).setValue(JSON.stringify({ state: calc.state || null, items: calc.items || [] }));
  sheet.getRange(row, ensureColumn_(sheet, headers, '수량요약')).setValue(summary);
  sheet.getRange(row, ensureColumn_(sheet, headers, '수량저장일')).setValue(new Date());

  var rec = {};
  var values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  headers.forEach(function(h, idx) { rec[h] = values[idx]; });

  return { success: true, calendarUpdated: updateOrderEventWithCalc_(rec, summary) };
}

// headers 배열을 같이 갱신해서, 한 번의 저장에서 여러 컬럼을 연달아 만들어도 위치가 겹치지 않게 한다
function ensureColumn_(sheet, headers, name) {
  var col = headers.indexOf(name) + 1;
  if (col) return col;
  headers.push(name);
  col = headers.length;
  sheet.getRange(1, col).setValue(name);
  return col;
}

// 상담 저장 때 만든 "[업체/발주] 현장주소" 종일 일정을 찾아 설명 끝에 수량을 붙인다.
// 일정은 저장일(오후 6시 이후면 다음날)에 만들어지므로 저장일 전후로 찾는다.
function updateOrderEventWithCalc_(rec, summary) {
  try {
    var calendars = CalendarApp.getCalendarsByName(ORDER_CALENDAR_NAME);
    if (!calendars.length) return false;
    var title = '[' + (rec['업체'] || '업체명 미입력') + '/발주] ' + (rec['현장주소'] || '현장주소 미입력');

    var saved = new Date(rec['timestamp']);
    if (isNaN(saved.getTime())) return false;
    var from = new Date(saved.getTime() - 24 * 3600 * 1000);
    var to = new Date(saved.getTime() + 3 * 24 * 3600 * 1000);

    var events = calendars[0].getEvents(from, to).filter(function(ev) { return ev.getTitle() === title; });
    if (!events.length) return false;

    events.forEach(function(ev) {
      var desc = ev.getDescription() || '';
      var cut = desc.indexOf(CALC_BLOCK_START);
      if (cut !== -1) desc = desc.slice(0, cut).replace(/\s+$/, '');
      ev.setDescription(desc + '\n\n' + CALC_BLOCK_START + '\n' + summary);
    });
    return true;
  } catch (err) {
    // 캘린더 갱신 실패해도 시트 저장은 성공 처리
    return false;
  }
}
