/**
 * ===== 대표님 확인 (업무 사이트 /confirm/) — 2026-11-24 =====
 * 클라우드 Claude가 대표님께 물을 것 · 부탁할 것을 시트 「대표님확인」 탭에 올리고,
 * 대표님이 휴대폰 화면에서 선택 · 답변 · 완료 체크를 하면 바로 시트에 저장한다.
 * 대표님 PC의 연락함 지킴이(tools/inbox-watch.ps1)가 1분마다 owner_check_pending_notify로 새 답을 받아
 * 비공개 연락함 PR #1에 「[클라우드에게] 대표님 확인 답 #ID …」 댓글을 남기고 owner_check_mark_notified로 표시한다(토큰 0).
 *
 * action
 * - owner_check_list           { status: '대기'|'완료'|'전체'(기본) }                     → 항목 목록
 * - owner_check_upsert         { items: [{ id?, category, title, desc, link, options, multi, status }] } → 추가 · 수정(id 있으면 수정)
 * - owner_check_answer         { id, choice?, answer?, done? }                              → 화면에서 대표님 답 저장
 * - owner_check_pending_notify { settleSec? }                                               → PC용: 답이 생겼는데 아직 연락함에 안 알린 것
 * - owner_check_mark_notified  { items: [{ id, answeredAt }] }                              → PC용: 알렸다고 표시(그 사이 새 답이 오면 표시 안 함)
 * - owner_check_close          { id, memo }                                                 → 클라우드: 처리 끝(완료 + 처리 메모)
 * 거래처 · 금액 같은 내용은 시트에만 있다(저장소에 쓰지 않는다).
 */

const OWNER_CHECK_SHEET = '대표님확인';
const OWNER_CHECK_HEADERS = ['ID', '만든시각', '분류', '제목', '설명', '링크', '선택지(쉼표)', '상태', '선택', '답변', '답변시각',
  '알림여부', '클라우드처리', '여러개선택'];
const OWNER_CHECK_CATEGORIES = ['돈', '확정', '전송', '결정', '대표님 손', '참고'];

function ownerCheckNow() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function ownerCheckText(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  return String(v == null ? '' : v);
}

// 탭이 없으면 만든다. 모든 칸을 글자 형식으로 둬서 시각 · 숫자가 자동 변환되지 않게 한다.
function ownerCheckSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(OWNER_CHECK_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(OWNER_CHECK_SHEET);
    sheet.getRange(1, 1, 1, OWNER_CHECK_HEADERS.length).setValues([OWNER_CHECK_HEADERS]).setFontWeight('bold');
    sheet.getRange(1, 1, sheet.getMaxRows(), OWNER_CHECK_HEADERS.length).setNumberFormat('@');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ownerCheckReadAll(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, OWNER_CHECK_HEADERS.length).getValues();
  const rows = [];
  values.forEach(function (r, i) {
    const id = ownerCheckText(r[0]).trim();
    if (!id) return;
    rows.push({
      row: i + 2,
      id: id,
      createdAt: ownerCheckText(r[1]),
      category: ownerCheckText(r[2]),
      title: ownerCheckText(r[3]),
      desc: ownerCheckText(r[4]),
      link: ownerCheckText(r[5]),
      options: ownerCheckText(r[6]).split(',').map(function (s) { return s.trim(); }).filter(String),
      status: ownerCheckText(r[7]) || '대기',
      choice: ownerCheckText(r[8]),
      answer: ownerCheckText(r[9]),
      answeredAt: ownerCheckText(r[10]),
      notified: ownerCheckText(r[11]),
      cloudMemo: ownerCheckText(r[12]),
      multi: /^(y|yes|true|1|예|o)$/i.test(ownerCheckText(r[13]).trim())
    });
  });
  return rows;
}

function ownerCheckRowValues(it) {
  return [it.id, it.createdAt, it.category, it.title, it.desc, it.link, (it.options || []).join(', '), it.status,
    it.choice, it.answer, it.answeredAt, it.notified, it.cloudMemo, it.multi ? 'Y' : ''];
}

function ownerCheckPublic(it) {
  const o = {};
  Object.keys(it).forEach(function (k) { if (k !== 'row') o[k] = it[k]; });
  return o;
}

function ownerCheckWithLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('다른 저장이 진행 중이에요. 잠시 후 다시 시도해주세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function handleOwnerCheckList(body) {
  const status = String((body && body.status) || '전체');
  const rows = ownerCheckReadAll(ownerCheckSheet()).filter(function (it) {
    return status === '전체' || it.status === status;
  });
  return jsonOut({ ok: true, items: rows.map(ownerCheckPublic), now: ownerCheckNow() });
}

function handleOwnerCheckUpsert(body) {
  const list = Array.isArray(body.items) ? body.items : (body.item ? [body.item] : [body]);
  return ownerCheckWithLock(function () {
    const sheet = ownerCheckSheet();
    const rows = ownerCheckReadAll(sheet);
    const byId = {};
    let maxNum = 0;
    rows.forEach(function (it) {
      byId[it.id] = it;
      const n = Number(String(it.id).replace(/\D/g, '')) || 0;
      if (n > maxNum) maxNum = n;
    });
    const saved = [];
    list.forEach(function (src) {
      if (!src || typeof src !== 'object') return;
      const opts = src.options == null ? null
        : (Array.isArray(src.options) ? src.options : String(src.options).split(','))
          .map(function (s) { return String(s).trim(); }).filter(String);
      if (src.category && OWNER_CHECK_CATEGORIES.indexOf(String(src.category)) < 0) {
        throw new Error('분류는 ' + OWNER_CHECK_CATEGORIES.join(' · ') + ' 중 하나로 써주세요: ' + src.category);
      }
      const id = src.id != null && String(src.id).trim() ? String(src.id).trim() : '';
      if (id && byId[id]) {
        // 수정: 보낸 칸만 바꾼다(대표님 답 · 선택은 클라우드가 일부러 보낼 때만 바뀜)
        const it = byId[id];
        if (src.category != null) it.category = String(src.category);
        if (src.title != null) it.title = String(src.title);
        if (src.desc != null) it.desc = String(src.desc);
        if (src.link != null) it.link = String(src.link);
        if (opts) it.options = opts;
        if (src.multi != null) it.multi = !!src.multi;
        if (src.status != null) it.status = String(src.status) === '완료' ? '완료' : '대기';
        if (src.cloudMemo != null) it.cloudMemo = String(src.cloudMemo);
        sheet.getRange(it.row, 1, 1, OWNER_CHECK_HEADERS.length).setValues([ownerCheckRowValues(it)]);
        saved.push({ id: id, updated: true });
      } else {
        if (!src.title) throw new Error('제목(title)이 없는 항목이 있어요.');
        maxNum += 1;
        const it = {
          id: id || String(maxNum), createdAt: ownerCheckNow(), category: String(src.category || '결정'),
          title: String(src.title), desc: String(src.desc || ''), link: String(src.link || ''), options: opts || [],
          status: '대기', choice: '', answer: '', answeredAt: '', notified: '', cloudMemo: String(src.cloudMemo || ''),
          multi: !!src.multi
        };
        const r = sheet.getLastRow() + 1;
        sheet.getRange(r, 1, 1, OWNER_CHECK_HEADERS.length).setNumberFormat('@').setValues([ownerCheckRowValues(it)]);
        it.row = r;
        byId[it.id] = it;
        saved.push({ id: it.id, created: true });
      }
    });
    return jsonOut({ ok: true, saved: saved });
  });
}

function handleOwnerCheckAnswer(body) {
  const id = String(body.id || '').trim();
  if (!id) throw new Error('항목 ID가 없어요.');
  return ownerCheckWithLock(function () {
    const sheet = ownerCheckSheet();
    const it = ownerCheckReadAll(sheet).filter(function (x) { return x.id === id; })[0];
    if (!it) throw new Error('항목을 찾지 못했어요: ' + id);
    if (body.choice != null) it.choice = String(body.choice);
    if (body.answer != null) it.answer = String(body.answer);
    if (body.done != null) it.status = body.done ? '완료' : '대기';
    it.answeredAt = ownerCheckNow();
    it.notified = '';   // 새 답 → PC가 연락함에 다시 알림
    sheet.getRange(it.row, 1, 1, OWNER_CHECK_HEADERS.length).setValues([ownerCheckRowValues(it)]);
    return jsonOut({ ok: true, item: ownerCheckPublic(it) });
  });
}

// 답을 쓰는 도중에 여러 번 알리지 않도록, 완료 체크된 것은 바로 · 아니면 마지막 저장 후 settleSec(기본 90초) 지난 것만.
function handleOwnerCheckPendingNotify(body) {
  const settle = Math.max(0, Number(body && body.settleSec != null ? body.settleSec : 90) || 0);
  const nowMs = new Date().getTime();
  const items = ownerCheckReadAll(ownerCheckSheet()).filter(function (it) {
    if (!it.answeredAt || it.notified) return false;
    if (it.status === '완료') return true;
    const t = new Date(it.answeredAt.replace(' ', 'T') + '+09:00').getTime();
    return !t || nowMs - t >= settle * 1000;
  });
  return jsonOut({ ok: true, items: items.map(ownerCheckPublic) });
}

function handleOwnerCheckMarkNotified(body) {
  const list = Array.isArray(body.items) ? body.items : (body.items ? [body.items] : (body.id ? [body] : []));
  return ownerCheckWithLock(function () {
    const sheet = ownerCheckSheet();
    const byId = {};
    ownerCheckReadAll(sheet).forEach(function (it) { byId[it.id] = it; });
    const marked = [], skipped = [];
    list.forEach(function (m) {
      const it = byId[String(m && m.id || '').trim()];
      if (!it) return;
      // 알리는 사이에 대표님이 또 답했으면(답변시각이 바뀜) 표시하지 않고 다음 회차에 다시 알린다.
      if (m.answeredAt != null && String(m.answeredAt) !== it.answeredAt) { skipped.push(it.id); return; }
      it.notified = ownerCheckNow();
      sheet.getRange(it.row, 12).setValue(it.notified);
      marked.push(it.id);
    });
    return jsonOut({ ok: true, marked: marked, skipped: skipped });
  });
}

function handleOwnerCheckClose(body) {
  const id = String(body.id || '').trim();
  if (!id) throw new Error('항목 ID가 없어요.');
  return ownerCheckWithLock(function () {
    const sheet = ownerCheckSheet();
    const it = ownerCheckReadAll(sheet).filter(function (x) { return x.id === id; })[0];
    if (!it) throw new Error('항목을 찾지 못했어요: ' + id);
    it.status = '완료';
    it.cloudMemo = (body.memo ? String(body.memo) + ' ' : '처리 끝 ') + '(' + ownerCheckNow() + ')';
    if (!it.notified) it.notified = '클라우드 처리';   // 클라우드가 이미 아는 것이므로 다시 알리지 않음
    sheet.getRange(it.row, 1, 1, OWNER_CHECK_HEADERS.length).setValues([ownerCheckRowValues(it)]);
    return jsonOut({ ok: true, item: ownerCheckPublic(it) });
  });
}
