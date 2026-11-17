# 히트타일 PC 자동 배포
# 클라우드 Claude가 main에 합친 Apps Script(gas/, checklist-gas/) 변경을 대표님 PC가 10분마다 받아서
# clasp push + 기존 웹앱 배포를 새 버전으로 업데이트한다(웹앱 주소 그대로). 설치는 pc-auto-deploy-install.ps1.
# 기록: %LOCALAPPDATA%\hittile-auto-deploy.log
#
# 안전장치
# - PC 저장소가 main 브랜치가 아니거나, PC에 커밋 안 한 수정이 있으면 아무것도 안 하고 기록만 남긴다(PC 작업을 덮지 않음).
# - main을 빨리감기(fast-forward)로만 받는다. 꼬여 있으면 건너뛴다.
# - gas/ 또는 checklist-gas/ 안의 파일이 바뀐 경우에만 배포한다.

$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
$Log = Join-Path $env:LOCALAPPDATA 'hittile-auto-deploy.log'
function Write-Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $Log -Append -Encoding utf8 }

# 폴더 -> 기존 웹앱 배포 ID (업무 사이트가 부르는 /exec 주소의 ID)
$Deployments = [ordered]@{
  'gas'           = 'AKfycbzx_vaUy7Ar1mqidKErG2WYcwNZpL6FGsfI8JNR0nILnSW9hf4bJ_N8aJmDM8J0DOKWwQ'  # 메인 웹앱
  'checklist-gas' = 'AKfycbyGTRMKSfiTQvhAeFDH0BUtFYjhaLal8ba_S9rFGDi2JhiRn49Dp4OR7tQ3GGkmeHze'  # 상담체크리스트 · 타일량 계산기
}

Set-Location $Repo
git fetch -q origin main 2>$null
if ($LASTEXITCODE -ne 0) { Write-Log '건너뜀: GitHub에서 받기 실패(인터넷 확인)'; exit 0 }

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Write-Log "건너뜀: PC 저장소가 main이 아님 ($branch)"; exit 0 }
if (git status --porcelain) { Write-Log '건너뜀: PC에 커밋 안 한 수정이 있음'; exit 0 }

$old = (git rev-parse HEAD).Trim()
$new = (git rev-parse origin/main).Trim()
if ($old -eq $new) { exit 0 }

git merge --ff-only -q origin/main 2>$null
if ($LASTEXITCODE -ne 0) { Write-Log '건너뜀: main을 그대로 받을 수 없음(PC 쪽 커밋과 꼬임)'; exit 0 }
$short = $new.Substring(0, 7)
Write-Log "받음: $($old.Substring(0,7)) -> $short"

$changed = git diff --name-only $old $new
foreach ($dir in $Deployments.Keys) {
  if (-not ($changed | Where-Object { $_ -like "$dir/*" })) { continue }
  Push-Location (Join-Path $Repo $dir)
  try {
    clasp push -f 2>&1 | ForEach-Object { Write-Log "[$dir] $_" }
    if ($LASTEXITCODE -ne 0) { Write-Log "[$dir] 오류: clasp push 실패"; continue }
    clasp deploy -i $Deployments[$dir] -d "자동 배포 $short" 2>&1 | ForEach-Object { Write-Log "[$dir] $_" }
    if ($LASTEXITCODE -ne 0) { Write-Log "[$dir] 오류: 웹앱 배포 실패"; continue }
    Write-Log "[$dir] 배포 완료 ($short)"
  } finally { Pop-Location }
}
