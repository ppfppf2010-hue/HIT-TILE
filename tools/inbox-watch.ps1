# 히트타일 연락함 지킴이 (토큰 0)
# 5분마다 비공개 연락함(ppfppf2010-hue/hittile-inbox PR #1)을 gh로 확인만 한다. Claude는 부르지 않는다.
# "[까망이에게]"(예전 "[까망에게]"도 받음)로 시작하는 새 요청이 있을 때만 까망(Claude Code)을 한 번 실행해서 처리시킨다.
# 설치: tools/inbox-watch-install.ps1   기록: %LOCALAPPDATA%\hittile-inbox-watch.log
#
# 안전장치
# - 이미 [완료 #ID] / [대표님 확인 필요 #ID] / [까망이 오류 #ID] 답이 있는 요청은 다시 하지 않는다.
# - 처리를 맡긴 요청 ID는 기록해 두고 다시 맡기지 않는다(같은 일 두 번 방지).
# - 앞 실행이 아직 돌고 있으면(잠금 파일) 이번 회차는 건너뛴다.

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Repo   = 'ppfppf2010-hue/hittile-inbox'
$Pr     = 1
$Work   = Split-Path -Parent $PSScriptRoot      # HIT-TILE 저장소 폴더 (까망이 일하는 곳)
$Log    = Join-Path $env:LOCALAPPDATA 'hittile-inbox-watch.log'
$State  = Join-Path $env:LOCALAPPDATA 'hittile-inbox-dispatched.txt'
$Lock   = Join-Path $env:LOCALAPPDATA 'hittile-inbox-watch.lock'
function Write-Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $Log -Append -Encoding utf8 }

if (Test-Path $Lock) {
  if (((Get-Date) - (Get-Item $Lock).LastWriteTime).TotalMinutes -lt 30) { exit 0 }
  Remove-Item $Lock -Force   # 30분 넘은 잠금은 비정상 종료로 보고 푼다
}

$json = gh api "repos/$Repo/issues/$Pr/comments" --paginate 2>$null
if ($LASTEXITCODE -ne 0 -or -not $json) { Write-Log '건너뜀: GitHub 확인 실패 (gh 로그인 · 인터넷 확인)'; exit 0 }
$comments = ($json -join "`n") | ConvertFrom-Json
if ($comments -isnot [array]) { $comments = @($comments) }

$answered = @{}
foreach ($c in $comments) {
  foreach ($m in [regex]::Matches([string]$c.body, '\[(완료|대표님 확인 필요|까망이? 오류)\s*#(\d+)\]')) { $answered[$m.Groups[2].Value] = $true }
}
$done = @{}
if (Test-Path $State) { Get-Content $State | ForEach-Object { if ($_) { $done[$_.Trim()] = $true } } }

$todo = @($comments | Where-Object {
  (([string]$_.body).TrimStart() -match '^\[까망(이)?에게\]') -and -not $answered["$($_.id)"] -and -not $done["$($_.id)"]
})
if (-not $todo.Count) { exit 0 }   # 할 일 없음 → Claude를 부르지 않으므로 토큰 0

New-Item -ItemType File -Path $Lock -Force | Out-Null
try {
  $ids = ($todo | ForEach-Object { $_.id }) -join ', '
  $todo | ForEach-Object { "$($_.id)" | Out-File -FilePath $State -Append -Encoding utf8 }
  Write-Log "새 요청 $($todo.Count)건 → 까망이 실행 (댓글 ID: $ids)"

  $prompt = @"
너는 까망이(히트타일 전용 PC의 Claude Code)다. 비공개 연락함 $Repo PR #$Pr 에 클라우드 Claude가 남긴 요청을 처리한다.
처리할 댓글 ID: $ids
1. gh api repos/$Repo/issues/$Pr/comments 로 그 댓글 내용을 읽고, gh api repos/$Repo/contents/README.md 의 규칙을 따른다.
2. 요청을 처리한 뒤 각 댓글마다 gh pr comment $Pr -R $Repo --body "[완료 #댓글ID] 결과" 로 답한다.
3. 입금 · 전표 확정 · 거래처에 단가/발주 답장 · 삭제가 걸린 일은 하지 말고 "[대표님 확인 필요 #댓글ID] 이유" 로 답한다.
4. 할 수 없거나 실패하면 "[까망이 오류 #댓글ID] 이유" 로 답한다. 어떤 경우에도 답은 꼭 남긴다.
"@
  # 무인 작업용 로그인(claude setup-token). 값은 이 PC 사용자만 풀 수 있게 암호화(DPAPI)된 파일에만 있다.
  # 저장: tools/inbox-watch-set-token.ps1. 파일이 없으면 평소 로그인으로 실행한다. 토큰 값은 기록에 남기지 않는다.
  $TokenFile = Join-Path $env:LOCALAPPDATA 'hittile-claude-token.dat'
  if (Test-Path $TokenFile) {
    try {
      $sec = (Get-Content $TokenFile -Raw).Trim() | ConvertTo-SecureString
      $env:CLAUDE_CODE_OAUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    } catch { Write-Log '무인 로그인 파일을 풀지 못함 → 평소 로그인으로 실행' }
  }
  Push-Location $Work
  try {
    & claude -p $prompt --permission-mode auto 2>&1 | ForEach-Object { Write-Log "[까망이] $_" }
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  Write-Log "까망이 종료 (코드 $code)"

  # 답을 못 남기고 끝난 요청은 오류 답을 대신 남겨서 클라우드가 알게 한다.
  $after = ((gh api "repos/$Repo/issues/$Pr/comments" --paginate 2>$null) -join "`n") | ConvertFrom-Json
  $ans2 = @{}
  foreach ($c in @($after)) { foreach ($m in [regex]::Matches([string]$c.body, '\[(완료|대표님 확인 필요|까망이? 오류)\s*#(\d+)\]')) { $ans2[$m.Groups[2].Value] = $true } }
  foreach ($t in $todo) {
    if (-not $ans2["$($t.id)"]) {
      gh pr comment $Pr -R $Repo --body "[까망이 오류 #$($t.id)] 까망이가 답을 남기지 못하고 끝났습니다 (종료 코드 $code). 까망이 PC의 기록: %LOCALAPPDATA%\hittile-inbox-watch.log" | Out-Null
      Write-Log "답 없음 → 오류 답 대신 남김 (#$($t.id))"
    }
  }
} finally { Remove-Item $Lock -Force -ErrorAction SilentlyContinue }
