# 히트타일 PC 자동 배포 설치: 윈도우 작업 스케줄러에 "10분마다 pc-auto-deploy.ps1 실행"을 등록한다.
# 대표님 PC에서 한 번만 실행. 다시 실행해도 같은 작업을 덮어쓸 뿐이다.
# 끄기: schtasks /Delete /TN "HitTile AutoDeploy" /F
$Script = Join-Path $PSScriptRoot 'pc-auto-deploy.ps1'
$Action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
schtasks /Create /TN "HitTile AutoDeploy" /SC MINUTE /MO 10 /TR $Action /F
if ($LASTEXITCODE -eq 0) {
  Write-Host '설치 완료: 10분마다 main을 확인해서 Apps Script가 바뀌었으면 자동 배포합니다.'
  Write-Host ('기록 파일: ' + (Join-Path $env:LOCALAPPDATA 'hittile-auto-deploy.log'))
  & $Script
} else { Write-Host '설치 실패: 작업 스케줄러 등록이 안 됐습니다.' }
