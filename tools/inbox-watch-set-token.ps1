# 연락함 지킴이용 무인 로그인 저장 (대표님 PC에서 직접 실행)
# 1) 다른 창에서 `claude setup-token` 실행 → 브라우저에서 승인 → 나온 토큰(sk-ant-oat...)을 복사
# 2) 이 스크립트 실행 → 입력칸에 붙여넣기(화면에 * 로만 보임) → Enter
# 토큰은 이 PC · 이 사용자만 풀 수 있게 암호화(DPAPI)해서 %LOCALAPPDATA%\hittile-claude-token.dat 에 저장한다.
# 채팅 · 연락함 · 저장소에는 절대 쓰지 않는다. 지우기: Remove-Item "$env:LOCALAPPDATA\hittile-claude-token.dat"
$File = Join-Path $env:LOCALAPPDATA 'hittile-claude-token.dat'
$sec = Read-Host '토큰을 붙여넣고 Enter (화면에 보이지 않음)' -AsSecureString
if ($sec.Length -lt 20) { Write-Host '저장 안 함: 토큰이 비었거나 너무 짧습니다.'; exit 1 }
$sec | ConvertFrom-SecureString | Set-Content -Path $File -Encoding ASCII
Set-Clipboard -Value ' '   # 클립보드에 남은 토큰 지우기
Write-Host "저장 완료: $File (암호화됨). 클립보드도 비웠습니다."
Write-Host '이제 지킴이(HitTile InboxWatch)가 Claude를 실행할 때 이 로그인을 씁니다.'
