# 히트타일 업무 시스템 — 공통 규칙

히트타일(대구, 타일 · 욕실자재 도소매)의 업무용 사이트 · Apps Script · 이카운트 연동 저장소다.
대표님은 개발자가 아니다. 모든 세션과 직원(.claude/agents)은 아래 규칙을 지킨다.

## 대화 규칙
- **대표님께는 한글로만** 말한다. 영어 문장 · 용어 남발 금지(코드 · 파일명은 예외).
- 결론부터, 짧게. 표를 쓸 수 있으면 표로.
- 대표님께 무언가를 부탁할 때는 **바로 열 수 있는 링크를 같이** 준다.
- 사진에서 잘린 값(단가 등)이나 애매한 값(부가세 포함 여부, 거래처)은 추측해서 저장하지 말고 묻는다.
- 인증키 · 비밀번호는 채팅에 쓰지 말라고 안내한다. 받아도 다른 세션 · 파일로 옮기지 않는다.

## 자주 쓰는 주소
| 이름 | 주소 |
|---|---|
| 업무 사이트 첫 화면 | https://ppfppf2010-hue.github.io/HIT-TILE/ |
| 판매등록 | https://ppfppf2010-hue.github.io/HIT-TILE/sale/ |
| 구매등록 | https://ppfppf2010-hue.github.io/HIT-TILE/purchase/ |
| 품목등록 | https://ppfppf2010-hue.github.io/HIT-TILE/itemregister/ |
| 상담체크리스트 | https://ppfppf2010-hue.github.io/HIT-TILE/checklist/ |
| 타일량 계산기 | https://ppfppf2010-hue.github.io/HIT-TILE/tile-calc/ |
| 배송관리 | https://ppfppf2010-hue.github.io/HIT-TILE/delivery/ |
| 배송기사 | https://ppfppf2010-hue.github.io/HIT-TILE/driver/ |
| 거래처잔액 | https://ppfppf2010-hue.github.io/HIT-TILE/balance/ |
| 히트타일 구글 시트 | https://docs.google.com/spreadsheets/d/1XBzkR5oVC1kmRkT270FnbIm_IdRzzumpB48TGorKJSM/edit |
| 이카운트 | https://loginbb.ecount.com |

## 직원 명단 (.claude/agents)
| 직원 | 파일 | 하는 일 |
|---|---|---|
| 품목등록담당 | item-register.md | 품목 등록, 한글명 붙이기, 중복 정리 |
| 판매·구매담당 | sales-purchase.md | 거래명세표로 판매 · 구매 등록, 적요(공간) 정리 |
| 상담·견적담당 | consult-quote.md | 상담체크리스트 → 타일량 계산 → 판매등록 연결 |
| 배송담당 | delivery.md | 배송 일정, 기사 배정, 반품 |
| 경리담당 | accounting.md | 미수금 · 잔액, 전표 · 입금, 이카운트 대조 |
| 시스템담당 | system.md | 업무 사이트 수정, Apps Script · 중계서버 배포 순서 |

직원을 새로 만들거나 규칙을 바꾸면 이 표도 같이 고친다.

## 시스템 구조 (꼭 알아둘 것)
- 화면: GitHub Pages(이 저장소 main) — main에 합치면 1분 안에 자동 배포.
- 서버 기능: Google Apps Script `gas/`(메인 웹앱), `checklist-gas/`(상담체크리스트). **clasp로 대표님 PC에서만 배포 가능**(클라우드 세션 불가).
- 이카운트: Apps Script → 중계서버(네이버클라우드 175.106.98.59, `ecount-relay/`) → 이카운트. 중계서버 반영도 **PC에서만** 가능(git pull + `pm2 restart ecount-relay`).
- 메인 웹앱 주소(조회 · 등록 호출용):
  `https://script.google.com/macros/s/AKfycbzx_vaUy7Ar1mqidKErG2WYcwNZpL6FGsfI8JNR0nILnSW9hf4bJ_N8aJmDM8J0DOKWwQ/exec` (POST, 본문 JSON `{"action": ...}`)
- 클라우드 세션은 이카운트 · 중계서버 · 일부 외부 사이트에 직접 접속할 수 없다. 이카운트 조회는 웹앱의 `debug_ecount_items` 등으로 한다.

## 이카운트 주의사항
- **시간당 연속 오류 30건 제한.** 실패하는 호출을 반복하지 않는다.
- 이카운트 OAPI에는 **거래처 조회 · 판매 조회 · 품목 삭제 API가 없다.** 이런 일은 대표님이 이카운트 화면에서 하거나 엑셀로 내려받는다.
- 새 API를 쓰려면 테스트키로 먼저 검증해야 한다(`ecount-relay/verify-apis.js`).
- 등록(저장) 계열 호출 전에는 항상 미리보기 · 대조로 **기존 데이터를 덮어쓰지 않는지** 확인한다.

## 저장소 규칙
- 운영에 배포된 코드는 반드시 main에도 있어야 한다. 다른 브랜치에서 배포했으면 바로 main에 합친다
  (안 그러면 다음 main 배포 때 운영 기능이 사라진다).
