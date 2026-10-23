/**
 * ===== 품목명 한글 병기 (베리굿 등 영문 품목명 → "영문명 (한글명)") =====
 * 새로 온 경리가 영문 품목명을 읽기 어려워서, 품목명 뒤에 괄호로 한글 이름을 붙인다.
 *
 * 1) action="korean_name_preview" : 품목등록마스터에서 대상 거래처(기본 베리굿, 코드 접두어 VG)의
 *    한글이 없는 품목을 골라 Claude로 한글명을 만들고 "한글명검토" 탭에 적는다.
 *    이미 탭에 있는 품목은 다시 번역하지 않는다(사람이 고친 한글명을 지키기 위함).
 * 2) 사람이 "한글명검토" 탭의 한글명을 확인/수정한다.
 * 3) action="korean_name_apply" : 탭의 한글명으로 이카운트(/register-item, SaveBasicProduct)와
 *    품목등록마스터 품목명을 "영문명 (한글명)"으로 바꾼다. 실행시간 제한 때문에 limit개씩 끊어서 처리하고,
 *    끝난 줄은 상태 칸에 "완료"를 남겨 다시 호출하면 남은 것부터 이어 간다.
 */

const KO_REVIEW_SHEET = '한글명검토';
const KO_HEADERS = ['품목코드', '현재 품목명', '규격', '한글명(수정 가능)', '바뀔 품목명', '상태'];
const KO_BATCH = 60;
const HANGUL_RE = /[가-힣]/;
// 이미 끝에 "(한글)"이 붙은 이름 — 예: "타일IBIZA GREY (이비자 그레이)"
const KO_SUFFIX_RE = /\([^)]*[가-힣][^)]*\)\s*$/;

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
    '- 의미를 모르는 약어는 지어내지 말고 영문 그대로 두세요.',
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
  // 이카운트는 연달아 호출하면 HTML 오류 페이지를 돌려준다 → 호출 사이를 띄우고, 그 오류면 한 번 더 기다렸다 재시도
  const delayMs = Math.max(0, Number(body && body.delayMs) || 12000);
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(KO_REVIEW_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({ ok: false, error: '한글명검토 탭이 비어 있습니다. 먼저 korean_name_preview를 실행하세요.' });

  const masterSheet = ss.getSheetByName(MASTER_SHEET);
  const masterData = masterSheet.getDataRange().getValues();
  const rowByCode = {};
  masterData.forEach(function (r, i) { if (i > 0) rowByCode[String(r[0]).trim()] = i + 1; });

  const review = sheet.getRange(2, 1, sheet.getLastRow() - 1, KO_HEADERS.length).getValues();
  const results = [];
  let processed = 0;
  for (let i = 0; i < review.length && processed < limit; i++) {
    const code = String(review[i][0]).trim();
    const ko = String(review[i][3]).trim();
    const status = String(review[i][5]).trim();
    if (!code || !ko || status.indexOf('완료') === 0) continue;
    if (onlyCode && code !== onlyCode) continue;
    processed++;

    const statusCell = sheet.getRange(i + 2, 6);
    const masterRow = rowByCode[code];
    if (!masterRow) { statusCell.setValue('실패: 품목등록마스터에 코드 없음'); results.push({ code: code, ok: false }); continue; }
    const m = masterData[masterRow - 1];
    const current = String(m[1]).trim();
    if (KO_SUFFIX_RE.test(current)) { statusCell.setValue('완료(이미 한글 병기)'); results.push({ code: code, ok: true, skipped: true }); continue; }

    const newName = current + ' (' + ko + ')';
    const item = { code: code, name: newName, spec: m[3], unit: m[6], inPrice: m[4], inVat: m[5], outPrice: m[10], outVat: m[11] };
    if (processed > 1) Utilities.sleep(delayMs);
    let res = ecountSyncItem(item);
    if (res && !res.ok && /DOCTYPE|JSON/.test(String(res.error || ''))) {
      Utilities.sleep(10000);
      res = ecountSyncItem(item);
    }
    if (res && res.ok) {
      masterSheet.getRange(masterRow, 2).setValue(newName);
      statusCell.setValue('완료 ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM-dd HH:mm'));
      results.push({ code: code, ok: true, name: newName });
    } else {
      const err = (res && (res.error || res.rawBody)) || '알 수 없는 오류';
      statusCell.setValue('실패: ' + String(err).slice(0, 200));
      results.push({ code: code, ok: false, error: err, ecount: res && res.ecount });
    }
  }

  const remaining = sheet.getRange(2, 1, sheet.getLastRow() - 1, KO_HEADERS.length).getValues()
    .filter(function (r) { return r[0] && String(r[3]).trim() && String(r[5]).indexOf('완료') !== 0; }).length;
  return jsonOut({ ok: true, processed: processed, remaining: remaining, results: results });
}

// 이카운트에 실제로 저장된 품목 정보 확인 (적용 전후 비교용)
function handleKoreanNameCheck(body) {
  const codes = (body && body.codes) || [];
  return jsonOut({ ok: true, items: codes.map(function (c) { return { code: c, ecount: ecountRelayCall('/list-items', { prodCd: c }) }; }) });
}

// 품목명을 통째로 지정해서 바꾼다 (예: "(무광)"을 빼고 한글명으로 바꾸는 경우) — body.items = [{code, name}]
function handleKoreanNameSet(body) {
  const delayMs = Math.max(0, Number(body && body.delayMs) || 12000);
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const masterSheet = ss.getSheetByName(MASTER_SHEET);
  const masterData = masterSheet.getDataRange().getValues();
  const results = ((body && body.items) || []).map(function (it, i) {
    const idx = masterData.findIndex(function (r) { return String(r[0]).trim() === String(it.code).trim(); });
    if (idx < 1 || !it.name) return { code: it.code, ok: false, error: '코드 없음 또는 이름 없음' };
    const m = masterData[idx];
    if (i > 0) Utilities.sleep(delayMs);
    const res = ecountSyncItem({ code: it.code, name: it.name, spec: m[3], unit: m[6], inPrice: m[4], inVat: m[5], outPrice: m[10], outVat: m[11] });
    if (res && res.ok) masterSheet.getRange(idx + 1, 2).setValue(it.name);
    return { code: it.code, ok: !!(res && res.ok), name: it.name, error: res && res.error };
  });
  return jsonOut({ ok: true, results: results });
}
