# 히트타일 작업 담당 일꾼 (연락함 [작업담당에게] 요청 처리, 11/26 일꾼분리 계획 4단계)
# 연락함 지킴이(tools/inbox-watch.ps1)가 [작업담당에게] 새 요청이 있을 때 이 스크립트를 따로 띄운다. 직접 실행할 일은 없다.
#   powershell -File tools/inbox-worker.ps1 -Ids 123,456
# - 화면(pyautogui · 앞 창 · 카톡)을 안 쓰는 일만 하므로 화면잠금 · 까망이 잠금을 잡지 않는다 → 카톡 담당과 동시에 돈다.
# - 작업 담당끼리는 하나만: 지킴이가 hittile-inbox-worker.lock 을 만든 뒤 띄우고, 이 스크립트가 끝날 때 지운다.
# - 실행 시간 상한 15분(사용량 한도 보호 — 카톡 담당과 같은 계정). 넘으면 Claude를 강제로 멈추고 [작업담당 오류 #ID]를 남긴다.
# - 답([완료 #ID] / [작업담당 보류 #ID] 등)을 못 남기고 끝난 요청은 [작업담당 오류 #ID]를 대신 남긴다.
# 기록: %LOCALAPPDATA%\hittile-inbox-watch.log (지킴이와 같은 파일, [작업담당] 붙여서)
param([string]$Ids = '')

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Repo    = 'ppfppf2010-hue/hittile-inbox'
# 연락함 PR 번호: 주마다 새 PR을 연다(대표님 11/26) → 지금 열린 PR 중 head 브랜치가 inbox로 시작하는 가장 큰 번호. 못 찾으면 1.
$Pr = 1
try {
  $prs = (gh pr list -R $Repo --state open --json number,headRefName --limit 50 2>$null) -join "`n" | ConvertFrom-Json
  $cand = @($prs | Where-Object { $_.headRefName -like 'inbox*' } | Sort-Object number -Descending)
  if ($cand.Count -gt 0) { $Pr = [int]$cand[0].number }
} catch { }
$Work    = Split-Path -Parent $PSScriptRoot      # HIT-TILE 저장소 폴더
$Log     = Join-Path $env:LOCALAPPDATA 'hittile-inbox-watch.log'
$WLock   = Join-Path $env:LOCALAPPDATA 'hittile-inbox-worker.lock'
$LimitMin = 15
function Write-Log($m) {
  # 지킴이 · 까망이와 같은 기록 파일을 쓰므로 잠깐 겹치면 한 번 더 시도
  for ($i = 0; $i -lt 3; $i++) {
    try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [작업담당] $m" | Out-File -FilePath $Log -Append -Encoding utf8 -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 200 }
  }
}
# 지킴이와 같은 「답 있음」 모양(tools/inbox-watch.ps1 의 $AnsRe — 바꾸면 같이 바꾼다)
$AnsRe = '\[(완료|대표님 확인 필요|까망이? 오류|까망이? 보류|(?:까망이?\s*)?진행\s?중|작업\s*담당\s*(?:오류|보류|진행\s?중))\s*#(\d+)\]|\[클라우드에게\]\s*질문\s*#(\d+)'

$idList = @($Ids -split '[,\s]+' | Where-Object { $_ -match '^\d+$' })
if (-not $idList.Count) { Write-Log '처리할 댓글 ID가 없음 → 종료'; Remove-Item $WLock -Force -ErrorAction SilentlyContinue; exit 0 }
$ids = $idList -join ', '

$tmpPrompt = Join-Path $env:TEMP "hittile-worker-prompt-$PID.txt"
$tmpOut    = Join-Path $env:TEMP "hittile-worker-out-$PID.txt"
$code = $null
$timedOut = $false
try {
  New-Item -ItemType File -Path $WLock -Force | Out-Null   # 잠금 시각을 지금으로(지킴이의 20분 판정 기준)
  Write-Log "시작 (댓글 ID: $ids, 상한 ${LimitMin}분)"

  $prompt = @"
너는 히트타일 집 PC의 **작업 담당** 일꾼(Claude Code, 무인 실행)이다. 카톡 담당(까망이)과 동시에 돌고 있다.
비공개 연락함 $Repo PR #$Pr 에 클라우드가 [작업담당에게] 로 남긴 요청을 처리한다.
처리할 댓글 ID: $ids

## 꼭 지킬 것 (이 글이 가장 우선 — pc-tools/작업담당_프롬프트.md · README 의 옛 규칙과 다르면 이 글을 따른다)
- **화면 사용 금지**: pyautogui · 마우스 · 키보드 · 앞 창 전환 · 화면 캡처, 카톡 창 조작을 하지 않는다. 화면잠금(화면잠금.txt)도 잡지 않는다(카톡 담당이 씀).
  화면을 쓰는 예전 프로그램(이카운트도구.py 의 focus/click 등, 화면 방식 캡처 · 수집 프로그램)도 실행하지 않는다.
- **이카운트는 도구\이카운트_무화면.py(9333번 포트 전용 크롬)로만** 다룬다.
  - 로그인된 업무 탭은 **주소 이동 · 새로고침 · 닫기 금지** — 화면 안 메뉴 · 버튼(요소)을 눌러서만 이동한다(주소를 바꾸면 로그인이 풀린다).
  - --초기화 · 자동 로그인 · 비밀번호 입력 금지. 로그인이 풀려 있으면 그 일은 보류로 답한다(대표님이 그 크롬에서 직접 로그인).
  - **저장 · 삭제 · 확정 · 사용중단 같은 바꾸는 동작 금지**(조회 · 내려받기 · PDF · 캡처만). 바꾸는 일이 요청에 있으면 하지 말고 [대표님 확인 필요 #댓글ID] 로 답한다.
  - 예외 하나: **품목 사용중단**은 요청 글에 「대표님 OK」(확인 번호나 날짜)와 **품목코드 목록**이 함께 적혀 있을 때만, 그 코드들에 한해 이카운트 품목등록 화면의 「사용중단」만 누른다. 처리 전 코드 · 품목명이 요청과 같은지 읽어 확인(다르면 그 줄 멈춤), 처리 후 재조회. 삭제 · 다른 칸 수정은 여전히 금지.
- **카톡 전송 금지.** 카톡으로 보낼 일은 결과에 「카톡 담당에게 넘길 것」으로 적기만 한다.
- 입금 · 전표 확정 · 거래처 답장 · 삭제가 걸린 일은 하지 않고 "[대표님 확인 필요 #댓글ID] 이유" 로 답한다.
- 실행 시간은 ${LimitMin}분이 상한이다(넘으면 강제로 멈춤). 오래 걸릴 일은 한 단계만 하고 남은 일을 보류 답에 적는다.
- 인증키 · 비밀번호 · 현관 비번은 댓글 · 파일 · 기록에 쓰지 않는다.

## 순서
1. gh api repos/$Repo/issues/$Pr/comments --paginate 로 그 댓글 내용을 읽는다. 필요하면 gh api repos/$Repo/contents/README.md 와
   pc-tools/작업담당_프롬프트.md 를 참고하되, 위 「꼭 지킬 것」과 다르면 위를 따른다.
   도구 폴더: %USERPROFILE%\Desktop\히트타일업무자동화\도구 (파이썬은 PYTHONIOENCODING=utf-8 로 실행).
2. 처리한 뒤 각 댓글마다 gh pr comment $Pr -R $Repo --body "[완료 #댓글ID] 결과(파일 경로 · 건수)" 로 답한다. 「완료」는 실제로 끝난 일에만 쓴다.
3. 지금 못 해서 미루는 일(로그인 풀림 · 프로그램 없음 · 화면이 필요한 일 등)은 "[작업담당 보류 #댓글ID] 이유 · 다시 하려면 필요한 것" 으로 답한다.
4. 실패하면 "[작업담당 오류 #댓글ID] 이유" 로 답한다. 어떤 경우에도 답은 꼭 남긴다.
5. 대표님 · 클라우드 답이 필요하면 "[클라우드에게] 질문 #댓글ID 하던 일 / 물어볼 것 / 고를 수 있는 답" 을 남기고 멈춘다
   (클라우드가 [작업담당에게] 답 #질문ID … 로 답하면 지킴이가 다시 띄운다).
"@
  [IO.File]::WriteAllText($tmpPrompt, $prompt, (New-Object Text.UTF8Encoding $false))

  # 무인 작업용 로그인(지킴이와 같은 파일, DPAPI 암호화). 값은 기록에 남기지 않는다. 이 프로세스와 그 자식에만 들어간다.
  $TokenFile = Join-Path $env:LOCALAPPDATA 'hittile-claude-token.dat'
  if (Test-Path $TokenFile) {
    try {
      $sec = (Get-Content $TokenFile -Raw).Trim() | ConvertTo-SecureString
      $env:CLAUDE_CODE_OAUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    } catch { Write-Log '무인 로그인 파일을 풀지 못함 → 평소 로그인으로 실행' }
  }
  $env:PYTHONIOENCODING = 'utf-8'
  $env:HITTILE_WORKER = '1'   # 프로그램이 「작업 담당이 부름」을 알 수 있게(쓰는 곳 없으면 무시됨)

  # claude 위치(claude.exe 또는 npm 의 claude.cmd). 시간 상한을 걸려고 cmd.exe 로 감싸 따로 띄우고,
  # 프롬프트는 파일로 표준입력에 넣는다(따옴표 · 줄바꿈 · 한글이 명령줄에서 깨지지 않게). 출력도 파일로 받는다.
  $cl = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cl) { throw 'claude 명령을 찾지 못함(PATH 확인)' }
  $cmdLine = "/d /c `"`"$($cl.Path)`" -p --permission-mode bypassPermissions < `"$tmpPrompt`" > `"$tmpOut`" 2>&1`""
  $p = Start-Process -FilePath "$env:ComSpec" -ArgumentList $cmdLine -WorkingDirectory $Work -WindowStyle Hidden -PassThru
  $null = $p.Handle   # 끝난 뒤 종료 코드를 읽으려면 미리 손잡이를 잡아 둔다
  if (-not $p.WaitForExit($LimitMin * 60 * 1000)) {
    $timedOut = $true
    & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null   # cmd · claude · 그 자식(파이썬 등)까지 함께 멈춤
    Write-Log "${LimitMin}분 상한을 넘겨 강제로 멈춤"
  } else { $code = $p.ExitCode }
  if (Test-Path $tmpOut) { Get-Content $tmpOut -Encoding UTF8 | ForEach-Object { Write-Log "$_" } }
  Write-Log "종료 (코드 $code)"
} catch {
  Write-Log "실행 실패: $($_.Exception.Message)"
} finally {
  # 답을 못 남기고 끝난 요청은 오류 답을 대신 남겨서 클라우드가 알게 한다.
  try {
    $after = ((gh api "repos/$Repo/issues/$Pr/comments" --paginate 2>$null) -join "`n") | ConvertFrom-Json
    $ans2 = @{}
    foreach ($c in @($after)) { foreach ($m in [regex]::Matches([string]$c.body, $AnsRe)) { $ans2[($m.Groups[2].Value + $m.Groups[3].Value)] = $true } }
    if ($after) {
      foreach ($id in $idList) {
        if (-not $ans2[$id]) {
          $why = if ($timedOut) { "${LimitMin}분 안에 끝나지 않아 멈췄습니다(사용량 한도 보호). 일을 잘게 나눠 새 요청으로" } else { "작업 담당이 답을 남기지 못하고 끝났습니다 (종료 코드 $code)" }
          gh pr comment $Pr -R $Repo --body "[작업담당 오류 #$id] $why. 집 PC 기록: %LOCALAPPDATA%\hittile-inbox-watch.log" | Out-Null
          Write-Log "답 없음 → 오류 답 대신 남김 (#$id)"
        }
      }
    } else { Write-Log '끝난 뒤 연락함 확인 실패 → 오류 답을 못 남김(gh 확인)' }
  } catch { Write-Log "끝난 뒤 확인 실패: $($_.Exception.Message)" }
  Remove-Item $tmpPrompt, $tmpOut -Force -ErrorAction SilentlyContinue
  Remove-Item $WLock -Force -ErrorAction SilentlyContinue
}
