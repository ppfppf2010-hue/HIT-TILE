# 히트타일 연락함 지킴이 설치: 작업 스케줄러에 "5분마다 inbox-watch.ps1"을 등록한다(창 없이, 7일 만료 없음).
# 대표님 PC에서 한 번만 실행. 끄기: schtasks /Delete /TN "HitTile InboxWatch" /F
$Script = Join-Path $PSScriptRoot 'inbox-watch.ps1'
$Action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
schtasks /Create /TN "HitTile InboxWatch" /SC MINUTE /MO 5 /TR $Action /F
if ($LASTEXITCODE -eq 0) {
  Write-Host '설치 완료: 5분마다 연락함을 확인하고, [까망이에게] 새 요청이 있을 때만 까망이를 실행합니다.'
  Write-Host ('기록 파일: ' + (Join-Path $env:LOCALAPPDATA 'hittile-inbox-watch.log'))
} else { Write-Host '설치 실패: 작업 스케줄러 등록이 안 됐습니다.' }
