# 상담체크리스트 백엔드 (로컬 clasp 작업용)

`checklist/index.html`이 저장할 때 호출하는 `WEBAPP_URL`은 히트타일 메인 허브(gas/)와는
**다른, 별도의 Apps Script 프로젝트**입니다. 이 프로젝트의 코드는 이 저장소에 없어서
(clasp로 연결된 적이 없어서) Claude가 직접 열어볼 수 없습니다. 아래 순서대로 로컬에서
진행하면 됩니다.

## 0. 준비물

```bash
npm install -g @google/clasp
clasp login
```

## 1. 기존 상담체크리스트 프로젝트를 로컬로 내려받기

1. 브라우저에서 상담체크리스트를 저장할 때 쓰는 Apps Script 편집기를 엽니다.
   (`checklist/index.html`의 `WEBAPP_URL`을 배포한 바로 그 프로젝트)
2. 왼쪽 톱니바퀴 **프로젝트 설정**에서 **스크립트 ID**를 복사합니다.
3. 이 폴더(`checklist-gas/`)에서:

```bash
cd checklist-gas
clasp clone <복사한 스크립트 ID>
```

기존 `Code.gs`(또는 여러 개의 `.gs` 파일)가 전부 이 폴더로 내려옵니다. 이제 Claude가
그 코드를 직접 읽고 안전하게 이어붙일 수 있습니다 — 클론 후 이 폴더를 다시 열어서
"백엔드 코드 받아왔어, 이어서 진행해줘"라고 알려주세요.

## 2. (참고) 이번에 추가하려는 것 — `ConsultationList.js`

같이 넣어둔 `ConsultationList.js`는 **기존 코드를 건드리지 않고** 새 파일로 얹는
초안입니다:

- `doGet`으로 `?action=list` 요청을 받으면, 저장된 상담 시트를 읽어서 JSON 목록으로 돌려줍니다.
- 헤더 행(1행)을 그대로 키로 사용하므로 실제 시트의 컬럼명이 무엇이든 동작합니다.
- 모든 저장 건에 상태를 `상담완료 발주대기`로 붙여서 내려줍니다 (시트에 컬럼을 추가할
  필요 없음 — 저장된 상담은 정의상 전부 이 상태이기 때문).

**주의할 점 (clone 받은 뒤 꼭 확인)**
- `CONSULTATION_SHEET_ID` / `CONSULTATION_SHEET_NAME` 두 상수를 실제 값으로 채워야 합니다.
- 기존 코드에 이미 `doGet`이 있으면 이름이 겹칩니다. 그 경우 `ConsultationList.js`의
  `doGet` 내용을 기존 `doGet` 안으로 옮겨 병합해야 합니다 (Claude에게 시키면 됩니다).
- 기존 코드에 이미 `jsonOut` 같은 이름의 함수가 있어도, 이 파일은 `jsonOutList`라는
  별도 이름을 써서 충돌을 피했습니다.

## 3. 배포

```bash
clasp push
```

그 다음 Apps Script 편집기에서 **배포 → 배포 관리 → (연필 아이콘) → 새 버전 → 배포**
(스킬 노하우: 배포 다이얼로그가 가끔 불안정해서 2~3회 시도가 필요할 수 있습니다).

## 4. 프론트엔드는 이미 준비되어 있습니다

`checklist/index.html`은 이미 시작 화면이 "상담 목록"이고, 좌하단 **+ 새 상담** 버튼을
누르면 지금의 입력 체크리스트로 넘어가도록 되어 있습니다. 목록 화면은
`WEBAPP_URL?action=list`를 호출해서 위 `ConsultationList.js`가 돌려주는 JSON을 그립니다.
백엔드 배포 전까지는 "아직 불러올 수 없다"는 안내만 뜹니다.
