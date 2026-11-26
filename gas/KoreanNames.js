/**
 * ===== 품목명 한글 병기 (베리굿 등 영문 품목명 → "영문명 (한글명)") =====
 * 새로 온 경리가 영문 품목명을 읽기 어려워서, 품목명 뒤에 괄호로 한글 이름을 붙인다.
 *
 * 1) action="korean_name_preview" : 품목등록마스터에서 대상 거래처(기본 베리굿, 코드 접두어 VG)의
 *    한글이 없는 품목을 골라 Claude로 한글명을 만들고 "한글명검토" 탭에 적는다.
 *    이미 탭에 있는 품목은 다시 번역하지 않는다(사람이 고친 한글명을 지키기 위함).
 * 2) 사람이 "한글명검토" 탭의 한글명을 확인/수정한다.
 * 3) action="korean_name_apply" : 탭의 한글명으로 품목등록마스터 품목명을 "영문명 (한글명)"으로 바꾸고 이름 고정을 건다
 *    (이카운트 품목명은 못 바꾼다 — 아래 「이름 고정」). 실행시간 제한 때문에 limit개씩 끊어서 처리하고,
 *    끝난 줄은 상태 칸에 "완료"를 남겨 다시 호출하면 남은 것부터 이어 간다.
 * 4) 자동: runKoreanNameAuto를 1시간마다 실행(action="setup_korean_name_auto"로 트리거 등록).
 *    새 영문 품목은 1)로 한글명을 만들고 3)으로 바로 적용한다. 한글명 칸이 비었거나 한글이 없는 줄은 건너뛰므로,
 *    모델번호만 있는 품목은 사람이 "한글명검토" 탭에 이름을 적어 두면 다음 실행 때 적용된다.
 *
 * ===== 이름 고정(ITEM_NAME_HOLD, 2026-11-26) =====
 *   이카운트 OAPI에는 품목 「수정」 API가 없다. 저장(SaveBasicProduct)은 등록 전용이라 이미 있는 코드는 「이미 존재」 오류만 나고
 *   이카운트 이름은 안 바뀐다 — 그 오류는 이카운트 시간당 연속 오류 30건 한도도 깎는다(11/26 한도 초과 사고).
 *   그런데 1시간 대조(runItemSyncAll)는 이카운트 이름으로 B열을 덮어써서, 웹앱으로 바꾼 이름이 1시간 뒤 전부 옛 이름으로 돌아갔다.
 *   그래서 korean_name_set · korean_name_apply는 이카운트를 부르지 않고 시트 B열만 고친 뒤
 *   스크립트 속성 ITEM_NAME_HOLD에 {코드: 이름}을 남긴다(「이름 고정」 — 단가 고정 ItemPrice.js와 같은 방식).
 *   runItemSyncAll은 고정된 코드의 품목명을 덮지 않고, 이카운트 이름이 고정 이름과 같아지면(대표님이 이카운트 화면에서 고치면) 고정을 스스로 푼다.
 *   이카운트 화면의 품목명은 대표님이 이카운트 품목등록에서 직접 고친다. 고정 목록: action item_name_holds.
 *   속성 한 칸은 9KB까지라 이름이 많으면 ITEM_NAME_HOLD, ITEM_NAME_HOLD_2, … 로 나눠 저장한다.
 */

const KO_REVIEW_SHEET = '한글명검토';
const KO_HEADERS = ['품목코드', '현재 품목명', '규격', '한글명(수정 가능)', '바뀔 품목명', '상태'];
const KO_BATCH = 60;
const HANGUL_RE = /[가-힣]/;
// 이미 끝에 "(한글)"이 붙은 이름 — 예: "타일IBIZA GREY (이비자 그레이)"
const KO_SUFFIX_RE = /\([^)]*[가-힣][^)]*\)\s*$/;

const ITEM_NAME_HOLD_PROP = 'ITEM_NAME_HOLD';
const ITEM_NAME_HOLD_CHUNK = 2500; // 글자 수 — 한글 3바이트여도 9KB 한도 안쪽
const ITEM_NAME_ECOUNT_NOTE = '이카운트 OAPI에 품목 수정 API가 없어 이카운트 품목명은 그대로예요. 시트 이름을 고정해서 1시간 대조가 되돌리지 않습니다. ' +
  '이카운트 화면 이름은 대표님이 이카운트 품목등록에서 직접 고쳐 주세요(같아지면 고정은 스스로 풀림).';

// { 코드: 이름 }
function itemNameHoldRead_() {
  try {
    const props = PropertiesService.getScriptProperties();
    let raw = props.getProperty(ITEM_NAME_HOLD_PROP) || '';
    for (let i = 2; raw; i++) {
      const more = props.getProperty(ITEM_NAME_HOLD_PROP + '_' + i);
      if (!more) break;
      raw += more;
    }
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

function itemNameHoldWrite_(hold) {
  const props = PropertiesService.getScriptProperties();
  const raw = Object.keys(hold).length ? JSON.stringify(hold) : '';
  const parts = [];
  for (let i = 0; i < raw.length; i += ITEM_NAME_HOLD_CHUNK) parts.push(raw.slice(i, i + ITEM_NAME_HOLD_CHUNK));
  if (parts.length) props.setProperty(ITEM_NAME_HOLD_PROP, parts[0]);
  else props.deleteProperty(ITEM_NAME_HOLD_PROP);
  for (let i = 1; i < parts.length; i++) props.setProperty(ITEM_NAME_HOLD_PROP + '_' + (i + 1), parts[i]);
  // 줄어든 만큼 뒤쪽 조각을 지운다
  for (let i = Math.max(parts.length, 1) + 1; props.getProperty(ITEM_NAME_HOLD_PROP + '_' + i) !== null; i++) {
    props.deleteProperty(ITEM_NAME_HOLD_PROP + '_' + i);
  }
}

// 순수 함수(시험용): 대조 때 품목명을 이카운트 이름으로 덮을지. hold는 그 자리에서 바뀐다.
//   → 'sync'(평소대로) | 'keep'(고정 — 덮지 않음) | 'caught'(이카운트 이름이 고정 이름과 같아짐 — 고정 풀고 평소대로)
function itemNameHoldDecide_(hold, code, ecountName) {
  if (!hold || !Object.prototype.hasOwnProperty.call(hold, code)) return 'sync';
  const want = String(hold[code] || '').trim();
  if (!want) { delete hold[code]; return 'sync'; }
  if (String(ecountName || '').trim() === want) { delete hold[code]; return 'caught'; }
  return 'keep';
}

function handleItemNameHolds() {
  return jsonOut({ ok: true, holds: itemNameHoldRead_() });
}

function koTargetRows_(masterData, keyword, prefix) {
  return masterData.slice(1).filter(function (r) {
    const code = String(r[0]).trim();
    const name = String(r[1]).trim();
    // "타일IBIZA GREY"처럼 앞에 한글이 붙은 이름도 대상 — 영문 단어가 있고 한글 병기가 아직 없으면 된다
    if (!code || !name || !/[A-Za-z]{3,}/.test(name) || KO_SUFFIX_RE.test(name)) return false;
    return (prefix && code.indexOf(prefix) === 0) || (keyword && String(r[12]).indexOf(keyword) !== -1);
  });
}

function koGetReviewSheet_(ss) {
  let sheet = ss.getSheetByName(KO_REVIEW_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(KO_REVIEW_SHEET);
    sheet.getRange(1, 1, 1, KO_HEADERS.length).setValues([KO_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function handleKoreanNamePreview(body) {
  const keyword = (body && body.vendor) || '베리굿';
  const prefix = (body && body.prefix !== undefined) ? body.prefix : (matchPrefix(keyword) || '');
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const masterData = ss.getSheetByName(MASTER_SHEET).getDataRange().getValues();
  const targets = koTargetRows_(masterData, keyword, prefix);

  const sheet = koGetReviewSheet_(ss);
  const existing = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues() : [];
  const known = {};
  existing.forEach(function (r) { known[String(r[0]).trim()] = true; });

  // body.items = [{code, ko}]가 오면 그 한글명을 그대로 쓰고(사람이 정한 목록), 없으면 Claude로 만든다
  const given = {};
  ((body && body.items) || []).forEach(function (it) { if (it && it.code && it.ko) given[String(it.code).trim()] = String(it.ko).trim(); });
  const useGiven = Object.keys(given).length > 0;
  const todo = targets.filter(function (r) {
    const code = String(r[0]).trim();
    return !known[code] && (!useGiven || given[code]);
  });
  const translated = useGiven ? given : {};
  for (let i = 0; !useGiven && i < todo.length; i += KO_BATCH) {
    Object.assign(translated, translateNamesWithClaude_(todo.slice(i, i + KO_BATCH).map(function (r) {
      return { code: String(r[0]).trim(), name: String(r[1]).trim(), spec: String(r[3] || '').trim() };
    })));
  }

  if (todo.length) {
    const start = sheet.getLastRow() + 1;
    const rows = todo.map(function (r, i) {
      const n = start + i;
      return [String(r[0]).trim(), String(r[1]).trim(), String(r[3] || '').trim(), translated[String(r[0]).trim()] || '',
        '=IF(D' + n + '="","",B' + n + '&" ("&D' + n + '&")")', ''];
    });
    sheet.getRange(start, 1, rows.length, KO_HEADERS.length).setValues(rows);
  }

  const all = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, KO_HEADERS.length).getDisplayValues() : [];
  return jsonOut({
    ok: true,
    vendor: keyword,
    prefix: prefix,
    targets: targets.length,
    added: todo.length,
    rows: all.map(function (r) { return { code: r[0], name: r[1], spec: r[2], ko: r[3], status: r[5] }; })
  });
}

// [{code, name, spec}] → {code: 한글명}
function translateNamesWithClaude_(items) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY 스크립트 속성이 설정되지 않았습니다.');

  const prompt = [
    '아래는 타일 도매상의 품목 목록입니다(품목명이 영문). 한국 타일 업계 직원이 읽고 부르기 쉬운 한글 품목명을 만들어주세요.',
    '',
    '규칙:',
    '- 시리즈·컬러명은 업계에서 부르는 대로 한글 발음으로 적으세요 (예: Calacatta → 칼라카타, Statuario → 스타투아리오, Grey → 그레이).',
    '- 표면 마감은 우리말로: Matt/Matte → 무광, Polished/Glossy → 유광, Lappato/Semi → 반광, Rustic/Structure → 요철.',
    '- 사이즈 숫자(600x600 등)와 품목코드는 넣지 마세요. 규격 칸에 따로 있습니다.',
    '- 이름 앞의 "타일" 같은 이미 한글인 부분은 빼고, 영문 부분만 한글로 적으세요.',
    '- 모델번호·약어만 있고 읽을 단어가 없거나(예: WT3674, VG R05) 뜻을 모르면 지어내지 말고 빈 문자열 ""로 두세요.',
    '- 아래 JSON 객체 하나만 출력하세요. 설명 없이 {"품목코드":"한글명", ...}',
    '',
    JSON.stringify(items)
  ].join('\n');

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (data.error) throw new Error('Claude API 오류: ' + data.error.message);

  const textBlock = (data.content || []).filter(function (c) { return c.type === 'text'; })[0];
  let jsonText = textBlock ? textBlock.text : '{}';
  const a = jsonText.indexOf('{'), b = jsonText.lastIndexOf('}');
  if (a === -1 || b === -1) return {};
  try {
    const map = JSON.parse(jsonText.substring(a, b + 1));
    const out = {};
    Object.keys(map).forEach(function (k) { out[k] = String(map[k] || '').trim(); });
    return out;
  } catch (e) {
    Logger.log('한글명 응답 파싱 실패: ' + jsonText);
    return {};
  }
}

function handleKoreanNameApply(body) {
  const limit = Math.max(1, Math.min(Number(body && body.limit) || 40, 80));
  const onlyCode = body && body.code ? String(body.code).trim() : '';
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(KO_REVIEW_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({ ok: false, error: '한글명검토 탭이 비어 있습니다. 먼저 korean_name_preview를 실행하세요.' });

  const masterSheet = ss.getSheetByName(MASTER_SHEET);
  const masterData = masterSheet.getDataRange().getValues();
  const rowByCode = {};
  masterData.forEach(function (r, i) { if (i > 0) rowByCode[String(r[0]).trim()] = i + 1; });

  const review = sheet.getRange(2, 1, sheet.getLastRow() - 1, KO_HEADERS.length).getValues();
  const results = [];
  const nameHold = itemNameHoldRead_();
  let holdTouched = false;
  let processed = 0;
  for (let i = 0; i < review.length && processed < limit; i++) {
    const code = String(review[i][0]).trim();
    const ko = String(review[i][3]).trim();
    const status = String(review[i][5]).trim();
    if (!code || !HANGUL_RE.test(ko) || status.indexOf('완료') === 0) continue;
    if (onlyCode && code !== onlyCode) continue;
    processed++;

    const statusCell = sheet.getRange(i + 2, 6);
    const masterRow = rowByCode[code];
    if (!masterRow) { statusCell.setValue('실패: 품목등록마스터에 코드 없음'); results.push({ code: code, ok: false }); continue; }
    const m = masterData[masterRow - 1];
    const current = String(m[1]).trim();
    if (KO_SUFFIX_RE.test(current)) { statusCell.setValue('완료(이미 한글 병기)'); results.push({ code: code, ok: true, skipped: true }); continue; }

    const newName = current + ' (' + ko + ')';
    // 이카운트는 부르지 않는다(이미 있는 품목은 「이미 존재」 오류만 나고 연속 오류 한도를 깎음) — 시트 이름 + 이름 고정
    try {
      masterSheet.getRange(masterRow, 2).setValue(newName);
      nameHold[code] = newName;
      holdTouched = true;
      statusCell.setValue('완료 ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM-dd HH:mm') + ' (시트 이름 고정 · 이카운트 이름은 그대로)');
      results.push({ code: code, ok: true, name: newName, held: true });
    } catch (err) {
      statusCell.setValue('실패: ' + String(err).slice(0, 200));
      results.push({ code: code, ok: false, error: String(err) });
    }
  }
  if (holdTouched) itemNameHoldWrite_(nameHold);

  const remaining = sheet.getRange(2, 1, sheet.getLastRow() - 1, KO_HEADERS.length).getValues()
    .filter(function (r) { return r[0] && HANGUL_RE.test(String(r[3])) && String(r[5]).indexOf('완료') !== 0; }).length;
  return jsonOut({ ok: true, processed: processed, remaining: remaining, results: results, ecountNameUnchanged: true, note: ITEM_NAME_ECOUNT_NOTE });
}

// 이카운트에 실제로 저장된 품목 정보 확인 (적용 전후 비교용)
function handleKoreanNameCheck(body) {
  const codes = (body && body.codes) || [];
  return jsonOut({ ok: true, items: codes.map(function (c) { return { code: c, ecount: ecountRelayCall('/list-items', { prodCd: c }) }; }) });
}

// 품목명을 통째로 지정해서 바꾼다 (예: "(무광)"을 빼고 한글명으로 바꾸는 경우) — body.items = [{code, name} 또는 {code, release:true}]
// 이카운트는 부르지 않는다 — 품목 수정 API가 없어 이름이 안 바뀌고 「이미 존재」 오류로 연속 오류 한도만 깎인다(위 「이름 고정」).
// 시트 B열을 고치고 이름 고정을 건다. release:true → 시트는 그대로 두고 고정만 푼다(다음 대조 때 이카운트 이름으로 돌아감).
function handleKoreanNameSet(body) {
  const list = (body && body.items) || [];
  const lock = LockService.getScriptLock(); // 1시간 대조(runItemSyncAll)가 옛 값으로 되써 버리지 않게 같은 잠금
  if (!lock.tryLock(30000)) throw new Error('다른 품목 작업(대조 등)이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const masterSheet = ss.getSheetByName(MASTER_SHEET);
    const masterData = masterSheet.getDataRange().getValues();
    const hold = itemNameHoldRead_();
    const label = nowLabel();
    const results = list.map(function (it) {
      const code = String((it && it.code) || '').trim();
      const name = String((it && it.name) || '').trim();
      const idx = masterData.findIndex(function (r, i) { return i > 0 && String(r[0]).trim() === code; });
      if (idx < 1) return { code: code, ok: false, error: '품목등록마스터에 없는 코드예요.' };
      const before = String(masterData[idx][1] || '').trim();
      if (it.release === true) {
        const had = Object.prototype.hasOwnProperty.call(hold, code);
        delete hold[code];
        return { code: code, ok: true, name: before, released: had };
      }
      if (!name) return { code: code, ok: false, error: '이름(name)이 없어요.' };
      masterSheet.getRange(idx + 1, 2).setValue(name);
      masterSheet.getRange(idx + 1, ITEM_STATUS_COL).setValue('✎ 웹앱 이름 수정: ' + before + ' → ' + name + ' · 이카운트 품목명은 그대로(이름 고정) (' + label + ')');
      masterData[idx][1] = name;
      hold[code] = name;
      return { code: code, ok: true, before: before, name: name, held: true };
    });
    itemNameHoldWrite_(hold);
    return jsonOut({ ok: true, results: results, ecountNameUnchanged: true, note: ITEM_NAME_ECOUNT_NOTE });
  } finally {
    lock.releaseLock();
  }
}

// 한글명을 사람이 정해야 하는 품목(모델번호만 있는 타일 등)을 한글명 칸을 비운 채 탭에 올려 둔다 — body.items = [{code, status}]
// 탭에 올라간 품목은 자동 실행 때 Claude로 다시 번역하지 않는다.
function handleKoreanNameSeed(body) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const masterData = ss.getSheetByName(MASTER_SHEET).getDataRange().getValues();
  const sheet = koGetReviewSheet_(ss);
  const known = {};
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) { known[String(r[0]).trim()] = true; });
  const start = sheet.getLastRow() + 1;
  const rows = [];
  ((body && body.items) || []).forEach(function (it) {
    const code = String(it.code || '').trim();
    const m = masterData.find(function (r) { return String(r[0]).trim() === code; });
    if (!code || known[code] || !m) return;
    known[code] = true;
    const n = start + rows.length;
    rows.push([code, String(m[1]).trim(), String(m[3] || '').trim(), '', '=IF(D' + n + '="","",B' + n + '&" ("&D' + n + '&")")', it.status || '']);
  });
  if (rows.length) sheet.getRange(start, 1, rows.length, KO_HEADERS.length).setValues(rows);
  return jsonOut({ ok: true, added: rows.length });
}

// ---- 자동 실행: 새 영문 품목에 한글명 만들기 + 적용 (시간 트리거) ----
function runKoreanNameAuto() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    handleKoreanNamePreview({});
    handleKoreanNameApply({ limit: 10 });
  } finally {
    lock.releaseLock();
  }
}

function handleSetupKoreanNameAuto() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runKoreanNameAuto'; });
  if (!exists) ScriptApp.newTrigger('runKoreanNameAuto').timeBased().everyHours(1).create();
  return jsonOut({ ok: true, created: !exists });
}
