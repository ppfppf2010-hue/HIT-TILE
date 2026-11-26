# 히트타일 신호 지킴이 설치: 작업 스케줄러에 "10분마다 signal-watch.ps1"을 등록한다(창 없이, 7일 만료 없음).
# 집 PC에서 한 번만 실행. 끄기: schtasks /Delete /TN "HitTile SignalWatch" /F
$Script = Join-Path $PSScriptRoot 'signal-watch.ps1'
$Action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
schtasks /Create /TN "HitTile SignalWatch" /SC MINUTE /MO 10 /TR $Action /F
if ($LASTEXITCODE -eq 0) {
  Write-Host '설치 완료: 10분마다 보류 · 묵은 요청 · 지킴이 멈춤 · 최근전표를 확인하고, 신호가 있을 때만 연락함에 [클라우드에게] 신호 댓글을 남깁니다(토큰 0).'
  Write-Host ('기록 파일: ' + (Join-Path $env:LOCALAPPDATA 'hittile-signal-watch.log'))
  Write-Host ('알린 신호: ' + (Join-Path $env:LOCALAPPDATA 'hittile-signal-watch.json'))
} else { Write-Host '설치 실패: 작업 스케줄러 등록이 안 됐습니다.' }
