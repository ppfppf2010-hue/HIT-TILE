# 히트타일 연락함 지킴이 (토큰 0)
# 1분마다(11/19부터, 예전 5분) 비공개 연락함(ppfppf2010-hue/hittile-inbox PR #1)을 gh로 확인만 한다. Claude는 부르지 않는다.
# "[까망이에게]"(예전 "[까망에게]"도 받음)로 시작하는 새 요청이 있을 때만 까망(Claude Code)을 한 번 실행해서 처리시킨다.
# 설치: tools/inbox-watch-install.ps1   기록: %LOCALAPPDATA%\hittile-inbox-watch.log
#
# 안전장치
# - 이미 [완료 #ID] / [대표님 확인 필요 #ID] / [까망이 오류 #ID] / [까망이 보류 #ID] / [까망이 진행중 #ID] / [클라우드에게] 질문 #ID 답이 있는 요청은 다시 하지 않는다.
#   (진행중 = PC 사용 중 등으로 대기. 5분마다 다시 실행하면 토큰만 드니 다시 하지 않고, 필요하면 새 요청으로 다시 시킨다.)
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

# ── 대표님 확인(/confirm/) 새 답 → 연락함에 [클라우드에게] 댓글 (11/24, 토큰 0) ──
#   웹앱 owner_check_pending_notify로 대표님이 체크 · 선택 · 답한 것 중 아직 안 알린 것을 받아 댓글을 남기고
#   owner_check_mark_notified로 표시한다. [클라우드에게]로 시작하므로 아래 [까망이에게] 요청으로 잡히지 않는다(까망이 안 깨움).
#   까망이가 오래 일하는 중(아래 잠금)에도 알림은 늦지 않게 따로 짧은 잠금을 쓴다. 실패하면 기록만 남기고 다음 회차에 다시.
$WebApp = 'https://script.google.com/macros/s/AKfycbzx_vaUy7Ar1mqidKErG2WYcwNZpL6FGsfI8JNR0nILnSW9hf4bJ_N8aJmDM8J0DOKWwQ/exec'
function Invoke-WebApp($payload) {
  # 웹앱 열쇠: 환경변수 HITTILE_APP_KEY가 있으면 key로 같이 보낸다(없으면 예전과 같게). 값은 기록에 남기지 않는다.
  if ($env:HITTILE_APP_KEY) { $payload = $payload.Clone(); $payload['key'] = $env:HITTILE_APP_KEY }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 5 -Compress))
  $r = Invoke-WebRequest -UseBasicParsing -Uri $WebApp -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 60
  return ([Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json)
}
$OcLock = Join-Path $env:LOCALAPPDATA 'hittile-ownercheck.lock'
if (-not (Test-Path $OcLock) -or ((Get-Date) - (Get-Item $OcLock).LastWriteTime).TotalMinutes -ge 5) {
  New-Item -ItemType File -Path $OcLock -Force | Out-Null
  try {
    $oc = Invoke-WebApp @{ action = 'owner_check_pending_notify' }
    if (-not $oc.ok) { Write-Log "대표님 확인: 목록 실패 $($oc.error)" }
    foreach ($it in @($oc.items)) {
      if (-not $it -or -not $it.id) { continue }
      $cut = { param($s, $n) $s = [string]$s; if ($s.Length -gt $n) { $s.Substring(0, $n) + '…' } else { $s } }
      $parts = @()
      if ($it.choice) { $parts += "선택: $($it.choice)" }
      if ($it.answer) { $parts += "답: $(& $cut $it.answer 1500)" }
      if ($it.status -eq '완료') { $parts += '완료 체크' }
      if (-not $parts.Count) { $parts += '(선택 · 답 지움)' }
      $body = "[클라우드에게] 대표님 확인 답 #$($it.id) $($it.title) — $($parts -join ' / ')`n(https://ppfppf2010-hue.github.io/HIT-TILE/confirm/ · 지킴이 자동, 토큰 0)"
      # 답에 따옴표 · 줄바꿈이 있어도 깨지지 않게 파일로 넘긴다(UTF-8, BOM 없음)
      $bf = Join-Path $env:TEMP "hittile-ownercheck-$($it.id).txt"
      [IO.File]::WriteAllText($bf, $body, (New-Object Text.UTF8Encoding $false))
      gh pr comment $Pr -R $Repo --body-file $bf | Out-Null
      $ghCode = $LASTEXITCODE
      Remove-Item $bf -Force -ErrorAction SilentlyContinue
      if ($ghCode -ne 0) { Write-Log "대표님 확인: 댓글 실패 #$($it.id) → 다음 회차에 다시"; continue }
      $mk = Invoke-WebApp @{ action = 'owner_check_mark_notified'; items = @(@{ id = [string]$it.id; answeredAt = [string]$it.answeredAt }) }
      Write-Log "대표님 확인: 연락함에 알림 #$($it.id) (표시 $(@($mk.marked).Count)건)"
    }
  } catch { Write-Log "대표님 확인: 확인 실패 $($_.Exception.Message)" }
  finally { Remove-Item $OcLock -Force -ErrorAction SilentlyContinue }
}

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
  foreach ($m in [regex]::Matches([string]$c.body, '\[(완료|대표님 확인 필요|까망이? 오류|까망이? 보류|(?:까망이?\s*)?진행\s?중)\s*#(\d+)\]|\[클라우드에게\]\s*질문\s*#(\d+)')) { $answered[($m.Groups[2].Value + $m.Groups[3].Value)] = $true }
}
$done = @{}
if (Test-Path $State) { Get-Content $State | ForEach-Object { if ($_) { $done[$_.Trim()] = $true } } }

$todo = @($comments | Where-Object {
  (([string]$_.body).TrimStart() -match '^\[까망(이)?에게\]') -and -not $answered["$($_.id)"] -and -not $done["$($_.id)"]
})
if (-not $todo.Count) { exit 0 }   # 할 일 없음 → Claude를 부르지 않으므로 토큰 0

# ── 정해진 모양의 요청은 Claude 없이 프로그램을 바로 실행 (11/19 대표님 「빠르게」, 토큰 0) ──
#   [까망이에게] 명세서캡처 2026/11/19-10   → 도구\이카운트_명세서캡처.py
#   사람이 PC를 쓰는 중이라 못 하면 다음 회차(1분 뒤)에 다시, 30분 넘게 못 하면 [까망이 진행중 #ID]로 답하고 멈춤.
$Tools  = Join-Path $env:USERPROFILE 'Desktop\히트타일업무자동화\도구'
$Retry  = Join-Path $env:LOCALAPPDATA 'hittile-inbox-direct-retry.txt'
$direct = @($todo | Where-Object { ([string]$_.body).TrimStart() -match '^\[까망이?에게\]\s*명세서\s*캡처\s+(\d{4}/\d{1,2}/\d{1,2}\s*-\s*\d+)\s*(\r?\n|$)' })
if ($direct.Count) {
  New-Item -ItemType File -Path $Lock -Force | Out-Null
  try {
    $env:PYTHONIOENCODING = 'utf-8'
    $first = @{}
    if (Test-Path $Retry) { Get-Content $Retry | ForEach-Object { $kv = $_ -split ' ', 2; if ($kv.Count -eq 2) { $first[$kv[0]] = [datetime]$kv[1] } } }
    foreach ($d in $direct) {
      $null = ([string]$d.body).TrimStart() -match '^\[까망이?에게\]\s*명세서\s*캡처\s+(\d{4}/\d{1,2}/\d{1,2}\s*-\s*\d+)'
      $slip = $Matches[1] -replace '\s', ''
      $t0 = Get-Date
      $out = (& python (Join-Path $Tools '이카운트_명세서캡처.py') $slip 2>&1 | ForEach-Object { "$_" }) -join "`n"
      $code = $LASTEXITCODE
      $sec = [int]((Get-Date) - $t0).TotalSeconds
      Write-Log "바로 실행: 명세서캡처 $slip (#$($d.id)) → 코드 $code, ${sec}초"
      if ($out -match '사람이 PC를 쓰는 중|화면잠금을 다른 세션이 쓰는 중') {
        if (-not $first["$($d.id)"]) { $first["$($d.id)"] = Get-Date }
        if (((Get-Date) - $first["$($d.id)"]).TotalMinutes -lt 30) { continue }   # 다음 회차에 다시
        gh pr comment $Pr -R $Repo --body "[까망이 진행중 #$($d.id)] 명세서캡처 $slip — 30분 동안 PC를 쓰는 중이라 못 했습니다. 다시 시키려면 새 요청으로." | Out-Null
      } elseif ($code -eq 0 -and $out -match '저장 (.+\.png)') {
        $png = Split-Path -Leaf $Matches[1]
        gh pr comment $Pr -R $Repo --body "[완료 #$($d.id)] 명세서캡처 $slip → ``자료/전표캡처/$png`` (${sec}초, Claude 없이 프로그램 바로 실행)" | Out-Null
      } else {
        $tail = (($out -split "`n") | Where-Object { $_ -and $_ -notmatch 'Deprecat|mss' } | Select-Object -Last 4) -join ' / '
        gh pr comment $Pr -R $Repo --body "[까망이 오류 #$($d.id)] 명세서캡처 $slip 실패 (코드 $code): $tail" | Out-Null
      }
      "$($d.id)" | Out-File -FilePath $State -Append -Encoding utf8
      $first.Remove("$($d.id)")
    }
    ($first.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value.ToString('o'))" }) | Set-Content -Path $Retry -Encoding utf8
  } finally { Remove-Item $Lock -Force -ErrorAction SilentlyContinue }
  $todo = @($todo | Where-Object { $direct.id -notcontains $_.id })
  if (-not $todo.Count) { exit 0 }
}

# [까망이에게] 최근전표  → 도구\이카운트_최근전표.py (판매 · 구매 최근 목록을 연락함 자료/최근전표/ 에 올림). 바빠서 못 하면 댓글 나이 30분까지 1분마다 다시.
$recent = @($todo | Where-Object { ([string]$_.body).TrimStart() -match '^\[까망이?에게\]\s*최근\s*전표\s*(
?
|$)' })
if ($recent.Count) {
  New-Item -ItemType File -Path $Lock -Force | Out-Null
  try {
    $env:PYTHONIOENCODING = 'utf-8'
    foreach ($d in $recent) {
      $t0 = Get-Date
      $out = (& python (Join-Path $Tools '이카운트_최근전표.py') 2>&1 | ForEach-Object { "$_" }) -join "`n"
      $code = $LASTEXITCODE
      $sec = [int]((Get-Date) - $t0).TotalSeconds
      Write-Log "바로 실행: 최근전표 (#$($d.id)) → 코드 $code, ${sec}초"
      if ($out -match '사람이 PC를 쓰는 중|화면잠금을 다른 세션이 쓰는 중') {
        if (((Get-Date).ToUniversalTime() - [datetime]$d.created_at).TotalMinutes -lt 30) { continue }
        gh pr comment $Pr -R $Repo --body "[까망이 진행중 #$($d.id)] 최근전표 — 30분 동안 PC를 쓰는 중이라 못 했습니다. 다시 시키려면 새 요청으로." | Out-Null
      } elseif ($code -eq 0 -and $out -match '올림') {
        $sum = (($out -split "`n") | Where-Object { $_ -match '건 \(최신' }) -join ' / '
        gh pr comment $Pr -R $Repo --body "[완료 #$($d.id)] 최근전표 → ``자료/최근전표/판매.csv`` · ``구매.csv`` ($sum, ${sec}초, Claude 없이 프로그램 바로 실행)" | Out-Null
      } else {
        $tail = (($out -split "`n") | Where-Object { $_ -and $_ -notmatch 'Deprecat|mss' } | Select-Object -Last 4) -join ' / '
        gh pr comment $Pr -R $Repo --body "[까망이 오류 #$($d.id)] 최근전표 실패 (코드 $code): $tail" | Out-Null
      }
      "$($d.id)" | Out-File -FilePath $State -Append -Encoding utf8
    }
  } finally { Remove-Item $Lock -Force -ErrorAction SilentlyContinue }
  $todo = @($todo | Where-Object { $recent.id -notcontains $_.id })
  if (-not $todo.Count) { exit 0 }
}

# [까망이에게] 현장납품내역 거래처 | 현장명 | 시작일 [| 종료일]  → 도구\이카운트_현장납품내역.py (PDF를 연락함 자료/현장납품내역/ 에 올림, 11/23). 바빠서 못 하면 댓글 나이 30분까지 1분마다 다시.
$siteRe = '^\[까망이?에게\]\s*현장\s*납품\s*내역\s+([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*(\d{4}/\d{1,2}/\d{1,2})(?:\s*\|\s*(\d{4}/\d{1,2}/\d{1,2}))?\s*(\r?\n|$)'
$site = @($todo | Where-Object { ([string]$_.body).TrimStart() -match $siteRe })
if ($site.Count) {
  New-Item -ItemType File -Path $Lock -Force | Out-Null
  try {
    $env:PYTHONIOENCODING = 'utf-8'
    foreach ($d in $site) {
      $null = ([string]$d.body).TrimStart() -match $siteRe
      $pd = { param($s) ($s -split '/' | ForEach-Object -Begin { $i = 0 } -Process { if ($i++ -eq 0) { $_ } else { $_.PadLeft(2, '0') } }) -join '/' }
      $pyArgs = @($Matches[1], $Matches[2], (& $pd $Matches[3]))
      if ($Matches[4]) { $pyArgs += (& $pd $Matches[4]) }
      $t0 = Get-Date
      $out = (& python (Join-Path $Tools '이카운트_현장납품내역.py') @pyArgs 2>&1 | ForEach-Object { "$_" }) -join "`n"
      $code = $LASTEXITCODE
      $sec = [int]((Get-Date) - $t0).TotalSeconds
      Write-Log "바로 실행: 현장납품내역 $($pyArgs -join ' | ') (#$($d.id)) → 코드 $code, ${sec}초"
      if ($out -match '사람이 PC를 쓰는 중|화면잠금을 다른 세션이 쓰는 중|카톡 담당이 응대 중') {
        if (((Get-Date).ToUniversalTime() - [datetime]$d.created_at).TotalMinutes -lt 30) { continue }
        gh pr comment $Pr -R $Repo --body "[까망이 진행중 #$($d.id)] 현장납품내역 — 30분 동안 PC를 쓰는 중이라 못 했습니다. 다시 시키려면 새 요청으로." | Out-Null
      } elseif ($code -eq 0 -and $out -match '올림: (\S+\.pdf)') {
        gh pr comment $Pr -R $Repo --body "[완료 #$($d.id)] 현장납품내역 $($pyArgs -join ' | ') → ``$($Matches[1])`` (${sec}초, Claude 없이 프로그램 바로 실행)" | Out-Null
      } else {
        $tail = (($out -split "`n") | Where-Object { $_ -and $_ -notmatch 'Deprecat|mss' } | Select-Object -Last 4) -join ' / '
        gh pr comment $Pr -R $Repo --body "[까망이 오류 #$($d.id)] 현장납품내역 실패 (코드 $code): $tail" | Out-Null
      }
      "$($d.id)" | Out-File -FilePath $State -Append -Encoding utf8
    }
  } finally { Remove-Item $Lock -Force -ErrorAction SilentlyContinue }
  $todo = @($todo | Where-Object { $site.id -notcontains $_.id })
  if (-not $todo.Count) { exit 0 }
}

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
   지금은 못 해서 미루는 일(로그인 · 파일 없음 · 카톡이 먼저 등)은 "[까망이 보류 #댓글ID] 이유 · 다시 하려면 필요한 것" 으로 답한다. "[완료 #ID]"는 실제로 끝난 일에만 쓴다(11/23 「완료 — 보류」 답이 이틀 묻힘).
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
    & claude -p $prompt --permission-mode bypassPermissions 2>&1 | ForEach-Object { Write-Log "[까망이] $_" }
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  Write-Log "까망이 종료 (코드 $code)"

  # 답을 못 남기고 끝난 요청은 오류 답을 대신 남겨서 클라우드가 알게 한다.
  $after = ((gh api "repos/$Repo/issues/$Pr/comments" --paginate 2>$null) -join "`n") | ConvertFrom-Json
  $ans2 = @{}
  foreach ($c in @($after)) { foreach ($m in [regex]::Matches([string]$c.body, '\[(완료|대표님 확인 필요|까망이? 오류|까망이? 보류|(?:까망이?\s*)?진행\s?중)\s*#(\d+)\]|\[클라우드에게\]\s*질문\s*#(\d+)')) { $ans2[($m.Groups[2].Value + $m.Groups[3].Value)] = $true } }
  foreach ($t in $todo) {
    if (-not $ans2["$($t.id)"]) {
      gh pr comment $Pr -R $Repo --body "[까망이 오류 #$($t.id)] 까망이가 답을 남기지 못하고 끝났습니다 (종료 코드 $code). 까망이 PC의 기록: %LOCALAPPDATA%\hittile-inbox-watch.log" | Out-Null
      Write-Log "답 없음 → 오류 답 대신 남김 (#$($t.id))"
    }
  }
} finally { Remove-Item $Lock -Force -ErrorAction SilentlyContinue }
