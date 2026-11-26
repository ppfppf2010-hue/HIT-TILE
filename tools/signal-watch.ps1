# 히트타일 신호 지킴이 실행기 (토큰 0) — 작업 스케줄러 "HitTile SignalWatch"가 10분마다 이 파일을 창 없이 실행한다.
# 하는 일은 tools/signal_watch.py 를 python 으로 한 번 돌리는 것뿐이다. 조건 · 상수는 그 파이썬 파일 위쪽에 있다.
# 설치: tools/signal-watch-install.ps1   기록: %LOCALAPPDATA%\hittile-signal-watch.log
# 폴더가 기본값과 다르면 환경변수로 알려 준다(setx 후 다음 실행부터):
#   HITTILE_INBOX_DIR  연락함 저장소 로컬 복사본 폴더 (기본 바탕화면\히트타일업무자동화\연락함)
#   HITTILE_KAKAO_LOG  카톡 지킴이 기록 파일 (없으면 카톡 지킴이는 보지 않음)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
& python (Join-Path $PSScriptRoot 'signal_watch.py') @args
exit $LASTEXITCODE
