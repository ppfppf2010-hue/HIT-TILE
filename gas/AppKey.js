/**
 * ===== 웹앱 열쇠 검사 =====
 * 웹앱 주소가 공개 저장소에 적혀 있어서, 주소만 알면 누구나 조회 · 저장 · 삭제를 부를 수 있었다.
 * 스크립트 속성 APP_KEY를 넣으면 요청의 key가 같을 때만 action을 실행한다.
 *
 *   APP_KEY               : 열쇠 값. **비어 있으면 검사하지 않는다**(예전과 똑같이 동작).
 *   APP_KEY_OPEN_ACTIONS  : 열쇠 없이 허용할 action을 쉼표로(예: price_search,delivery_by_date). 기본 빈 값.
 *
 * doPost(Code.js) · doGet(Balance.js)이 action 분기 전에 appKeyGate_()를 한 번 부른다.
 * 열쇠 값은 응답 · 로그 어디에도 넣지 않는다. 켜는 순서는 .claude/agents/system.md 「웹앱 열쇠」.
 */

// 순수 함수(시험용): 통과면 true.
//   appKey: 속성 APP_KEY 값, openList: 속성 APP_KEY_OPEN_ACTIONS 값, action: 실행할 action, given: 요청이 보낸 key
function appKeyAllowed_(appKey, openList, action, given) {
  const need = String(appKey == null ? '' : appKey).trim();
  if (!need) return true; // 속성이 없으면 검사 안 함
  const act = String(action == null ? '' : action).trim();
  if (act) {
    const open = String(openList == null ? '' : openList).split(',');
    for (let i = 0; i < open.length; i++) {
      if (open[i].trim() === act) return true;
    }
  }
  if (typeof given !== 'string') return false;
  const got = given.trim();
  if (got.length !== need.length) return false;
  let diff = 0;
  for (let i = 0; i < need.length; i++) diff |= need.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// 막아야 하면 돌려줄 응답(jsonOut)을, 통과면 null을 돌려준다.
function appKeyGate_(action, given) {
  const props = PropertiesService.getScriptProperties();
  const appKey = props.getProperty('APP_KEY') || '';
  if (!appKey) return null;
  if (appKeyAllowed_(appKey, props.getProperty('APP_KEY_OPEN_ACTIONS') || '', action, given)) return null;
  return jsonOut({ ok: false, needKey: true, error: '열쇠가 필요합니다.' });
}
