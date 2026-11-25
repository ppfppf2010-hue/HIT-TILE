/*
 * 히트타일 웹앱 열쇠 (모든 화면 공용)
 *
 * 웹앱(Apps Script)이 스크립트 속성 APP_KEY로 열쇠 검사를 켜면, 이 파일이 화면의 fetch를 감싸서
 *   1) 이 기기에 저장된 열쇠(localStorage 'hittileAppKey')를 요청에 같이 보내고
 *      (POST: JSON 본문의 key, GET: 주소의 key)
 *   2) 서버가 { needKey: true }라고 답하면 열쇠를 한 번 물어 저장하고 같은 요청을 한 번만 다시 보낸다.
 *      그래도 틀리면 저장한 값을 지우고 서버의 오류 응답을 그대로 돌려준다(반복하지 않음).
 * 서버가 검사를 안 하고 저장된 열쇠도 없으면 요청 · 응답을 전혀 건드리지 않는다.
 * script.google.com/macros 주소가 아닌 요청은 손대지 않는다.
 *
 * 쓰는 법: fetch를 쓰는 스크립트보다 먼저 <script src="../appkey.js"></script>
 * 열쇠 값은 이 파일 · 저장소 · 채팅 어디에도 적지 않는다.
 */
(function (root) {
  'use strict';
  if (!root || typeof root.fetch !== 'function' || root.__hittileAppKeyOn) return;
  root.__hittileAppKeyOn = true;

  var STORE = 'hittileAppKey';
  var TARGET = 'script.google.com/macros';
  var QUIET_AFTER_CANCEL_MS = 60000; // 취소하면 1분 동안 다시 묻지 않는다(자동 새로고침 화면에서 계속 뜨지 않게)
  var QUIET_AFTER_WRONG_MS = 3000;   // 틀리면 동시에 나간 다른 요청들이 줄줄이 다시 묻지 않게
  var origFetch = root.fetch;
  var memKey = '';   // localStorage를 못 쓰는 브라우저(사생활 보호 모드 등)용
  var quietUntil = 0;

  function getKey() {
    try { return (root.localStorage.getItem(STORE) || '').trim(); } catch (e) { return memKey; }
  }
  function setKey(v) {
    memKey = v;
    try { root.localStorage.setItem(STORE, v); } catch (e) { /* 저장 못 해도 이번 화면에서는 쓴다 */ }
  }
  function clearKey() {
    memKey = '';
    try { root.localStorage.removeItem(STORE); } catch (e) { /* 무시 */ }
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (root.URL && input instanceof root.URL) return input.href;
    return ''; // Request 객체 등은 건드리지 않는다(이 사이트 화면은 모두 문자열 주소로 부른다)
  }

  function addQueryKey(url, key) {
    var hash = '';
    var h = url.indexOf('#');
    if (h >= 0) { hash = url.slice(h); url = url.slice(0, h); }
    url = url.replace(/([?&])key=[^&]*(&|$)/, function (m, a, b) { return b ? a : ''; });
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(key) + hash;
  }

  // 열쇠를 넣은 [주소, 옵션]을 만든다. 원래 옵션 객체는 바꾸지 않는다.
  function withKey(url, init, key) {
    var method = String((init && init.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return [addQueryKey(url, key), init];
    var body = init && init.body;
    if (typeof body === 'string') {
      var obj = null;
      try { obj = JSON.parse(body); } catch (e) { obj = null; }
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        obj.key = key;
        var next = {};
        for (var k in init) next[k] = init[k];
        next.body = JSON.stringify(obj);
        return [url, next];
      }
    }
    // JSON 문자열이 아닌 본문(FormData 등)은 본문을 건드리지 않고 주소에 붙인다(서버가 POST도 주소의 key를 본다)
    return [addQueryKey(url, key), init];
  }

  function send(url, init, key) {
    if (!key) return origFetch.call(root, url, init);
    var a = withKey(url, init, key);
    return origFetch.call(root, a[0], a[1]);
  }

  // 응답이 { needKey: true }인지 본다. 원래 호출자가 본문을 읽을 수 있게 복사본으로 읽는다.
  function needsKey(res) {
    var copy;
    try { copy = res.clone(); } catch (e) { return Promise.resolve(false); }
    return copy.text().then(function (t) {
      if (t.indexOf('needKey') < 0) return false;
      try { var d = JSON.parse(t); return !!(d && d.needKey === true); } catch (e) { return false; }
    }, function () { return false; });
  }

  root.fetch = function (input, init) {
    var url = urlOf(input);
    if (!url || url.indexOf(TARGET) < 0) return origFetch.apply(this, arguments);

    var sent = getKey();
    return send(url, init, sent).then(function (res) {
      return needsKey(res).then(function (need) {
        if (!need) return res;

        var now = getKey();
        var retryKey = '';
        if (now && now !== sent) {
          // 같이 나간 다른 요청이 방금 새 열쇠를 받아 저장했다 → 묻지 않고 그 열쇠로 다시
          retryKey = now;
        } else {
          if (now) clearKey(); // 보낸 열쇠가 틀렸다
          if (Date.now() < quietUntil || typeof root.prompt !== 'function') return res;
          var typed = root.prompt('히트타일 열쇠를 입력하세요');
          typed = (typed == null ? '' : String(typed)).trim();
          if (!typed) { quietUntil = Date.now() + QUIET_AFTER_CANCEL_MS; return res; }
          setKey(typed);
          retryKey = typed;
        }

        // 한 번만 다시 보낸다
        return send(url, init, retryKey).then(function (res2) {
          return needsKey(res2).then(function (need2) {
            if (need2) {
              if (getKey() === retryKey) clearKey();
              quietUntil = Date.now() + QUIET_AFTER_WRONG_MS;
            }
            return res2;
          });
        });
      });
    });
  };
})(typeof window !== 'undefined' ? window : this);
