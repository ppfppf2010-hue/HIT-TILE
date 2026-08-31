var SHEET_NAME = 'Consultations';
var HEADERS = ['id','timestamp','업체','현장주소','연락처','현장비번','타일시공일','도기시공일','tile_json','fixture_json','특이사항'];

// 새 상담이 저장될 때마다 알림 메일을 받을 주소
var NOTIFY_EMAIL = 'ppfppf2010@gmail.com';

// 상담 저장 시 자동 등록할 캘린더 이름 (없으면 자동 생성됩니다)
var ORDER_CALENDAR_NAME = '히트타일 발주';

var FIXTURE_ITEMS = [
  { key:'toilet', label:'양변기' },
  { key:'sink', label:'세면대' },
  { key:'sinkFaucet', label:'세면 수전' },
  { key:'showerFaucet', label:'샤워 수전' },
  { key:'slideBar', label:'슬라이드바' },
  { key:'towelBar', label:'수건걸이' },
  { key:'hanger', label:'옷걸이' },
  { key:'tissue', label:'휴지걸이' },
  { key:'shelf', label:'코너선반' },
  { key:'cabinet', label:'욕실장' },
  { key:'mirror', label:'거울' },
  { key:'sprayGun', label:'스프레이건' },
  { key:'tub', label:'욕조' },
  { key:'partition', label:'파티션' },
  { key:'ventilator', label:'환풍기' },
  { key:'kitchenFaucet', label:'주방수전' },
];

var FIXTURE_ZONES = [
  { key:'common', label:'공용욕실' },
  { key:'master', label:'안방욕실' },
];

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

// 메일 권한이 제대로 승인됐는지 확인하기 위한 테스트 함수.
// Apps Script 편집기에서 이 함수를 선택해 직접 "실행"해보세요.
function testEmail() {
  MailApp.sendEmail(NOTIFY_EMAIL, '[HIT TILE] 테스트 메일', '이 메일이 보이면 메일 권한이 정상입니다.');
}

function doPost(e) {
  try {
    var sheet = getSheet_();
    var data = JSON.parse(e.postData.contents);
    var id = Utilities.getUuid();
    var timestamp = new Date().toISOString();

    sheet.appendRow([
      id,
      timestamp,
      data.company || '',
      data.address || '',
      data.contact || '',
      data.sitePw || '',
      data.tileDate || '',
      data.ceramicDate || '',
      JSON.stringify(data.tile || {}),
      JSON.stringify(data.fixture || {}),
      data.note || ''
    ]);

    sendNotificationEmail_(data);
    createOrderCalendarEvent_(data);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, id: id }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function sendNotificationEmail_(data) {
  if (!NOTIFY_EMAIL) return;

  try {
    var lines = [];
    lines.push('새 상담이 등록되었습니다.');
    lines.push('');
    lines.push('업체: ' + (data.company || '-'));
    lines.push('현장주소: ' + (data.address || '-'));
    lines.push('연락처: ' + (data.contact || '-'));
    lines.push('현장비번: ' + (data.sitePw || '-'));
    lines.push('타일시공일: ' + (data.tileDate || '-'));
    lines.push('도기시공일: ' + (data.ceramicDate || '-'));
    lines.push('');
    lines.push('[타일 정보]');

    var tile = data.tile || {};
    Object.keys(tile).forEach(function(key) {
      var d = tile[key];
      if (d && (d.size || d.name || d.memo)) {
        var label = d.label || key;
        lines.push(label + ': ' + [d.size, d.name, d.memo].filter(Boolean).join(' / '));
      }
    });

    if (data.note) {
      lines.push('');
      lines.push('[특이사항]');
      lines.push(data.note);
    }

    lines.push('');
    lines.push('※ 상세 이미지는 저장 화면에서 "이미지로 저장" 버튼으로 바로 받으실 수 있습니다.');

    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: '[HIT TILE] 새 상담 등록 - ' + (data.company || '업체명 미입력'),
      body: lines.join('\n')
    });
  } catch (err) {
    // 메일 발송 실패해도 저장 자체는 성공 처리되도록 조용히 무시
  }
}

function getOrCreateOrderCalendar_() {
  var calendars = CalendarApp.getCalendarsByName(ORDER_CALENDAR_NAME);
  if (calendars.length > 0) {
    return calendars[0];
  }
  return CalendarApp.createCalendar(ORDER_CALENDAR_NAME);
}

function createOrderCalendarEvent_(data) {
  try {
    var calendar = getOrCreateOrderCalendar_();

    var now = new Date();
    var eventDate = new Date(now);
    // 오후 6시(18시) 이후 저장되면 다음날 일정으로 등록
    if (now.getHours() >= 18) {
      eventDate.setDate(eventDate.getDate() + 1);
    }

    var title = '[' + (data.company || '업체명 미입력') + '/발주] ' + (data.address || '현장주소 미입력');
    var description = buildEventDescription_(data);

    calendar.createAllDayEvent(title, eventDate, { description: description });
  } catch (err) {
    // 캘린더 등록 실패해도 저장 자체는 성공 처리되도록 조용히 무시
  }
}

function buildEventDescription_(data) {
  var lines = [];
  lines.push('연락처: ' + (data.contact || '-'));
  lines.push('현장비번: ' + (data.sitePw || '-'));
  lines.push('타일시공일: ' + (data.tileDate || '-'));
  lines.push('도기시공일: ' + (data.ceramicDate || '-'));
  lines.push('');
  lines.push('[타일 정보]');

  var tile = data.tile || {};
  Object.keys(tile).forEach(function(key) {
    var d = tile[key];
    if (d && (d.size || d.name || d.memo)) {
      var label = d.label || key;
      lines.push(label + ': ' + [d.size, d.name, d.memo].filter(Boolean).join(' / '));
    }
  });

  var fixture = data.fixture || {};
  var fixtureLines = [];
  FIXTURE_ZONES.forEach(function(zone) {
    var zoneData = fixture[zone.key] || {};
    var items = [];
    FIXTURE_ITEMS.forEach(function(item) {
      if (zoneData[item.key]) {
        items.push(item.label + ': ' + zoneData[item.key]);
      }
    });
    if (items.length > 0) {
      fixtureLines.push('- ' + zone.label + ' : ' + items.join(', '));
    }
  });
  if (fixtureLines.length > 0) {
    lines.push('');
    lines.push('[집기류]');
    lines = lines.concat(fixtureLines);
  }

  if (data.note) {
    lines.push('');
    lines.push('[특이사항]');
    lines.push(data.note);
  }

  return lines.join('\n');
}

// 캘린더 권한이 제대로 승인됐는지 + 상세 내용까지 잘 들어가는지 확인하기 위한 테스트 함수.
// Apps Script 편집기에서 이 함수를 선택해 직접 "실행"해보세요.
function testCalendar() {
  createOrderCalendarEvent_({
    company: '테스트업체',
    address: '테스트 현장주소',
    contact: '010-0000-0000',
    sitePw: '1234*',
    tileDate: '2026-08-01',
    ceramicDate: '2026-08-02',
    tile: {
      entrance: { label: '현관', size: '600*600', name: '유광그레이지', memo: '메지 컬러확인' },
      veranda2: { label: '베란다 2', size: '300*300', name: '뒷베란다용 컬러', memo: '' }
    },
    fixture: {
      common: { toilet: '에페론78', sink: '리베아' }
    },
    note: '테스트 특이사항입니다.'
  });
}



