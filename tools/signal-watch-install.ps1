# 히트타일 신호 지킴이 설치: 작업 스케줄러에 "10분마다 signal-watch.ps1"을 등록한다(창 없이, 7일 만료 없음).
# 집 PC에서 한 번만 실행. 끄기: schtasks /Delete /TN "HitTile SignalWatch" /F
# 등록 전에 기준선(--baseline)을 한 번 돌려, 지금 이미 걸려 있는 옛 보류 · 요청은 「알린 것」으로 기억만 한다(댓글 없음).
# 그래서 첫 회차부터 설치 뒤에 새로 생긴 신호만 연락함에 올라간다.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
$Py = Join-Path $PSScriptRoot 'signal_watch.py'
$Kakao = @()
if ($env:HITTILE_KAKAO_LOG) { $Kakao = @('--kakao-log', $env:HITTILE_KAKAO_LOG) }

Write-Host '1) 기준선: 지금 걸려 있는 신호를 「알린 것」으로 기억합니다(댓글 없음).'
& python $Py --baseline @Kakao
if ($LASTEXITCODE -ne 0) {
  Write-Host ('기준선 실패(코드 ' + $LASTEXITCODE + '): gh 로그인 · 인터넷을 확인하고 이 설치 파일을 다시 실행하세요. 작업 스케줄러에는 아직 등록하지 않았습니다.')
  exit 1
}

Write-Host '2) 작업 스케줄러 등록'
$Script = Join-Path $PSScriptRoot 'signal-watch.ps1'
$Action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
schtasks /Create /TN "HitTile SignalWatch" /SC MINUTE /MO 10 /TR $Action /F
if ($LASTEXITCODE -eq 0) {
  Write-Host '설치 완료: 10분마다 보류 · 묵은 요청 · 지킴이 멈춤 · 최근전표를 확인하고, 신호가 있을 때만 연락함에 [클라우드에게] 신호 댓글을 남깁니다(토큰 0).'
  Write-Host ('기록 파일: ' + (Join-Path $env:LOCALAPPDATA 'hittile-signal-watch.log'))
  Write-Host ('알린 신호: ' + (Join-Path $env:LOCALAPPDATA 'hittile-signal-watch.json'))
} else { Write-Host '설치 실패: 작업 스케줄러 등록이 안 됐습니다.' }
