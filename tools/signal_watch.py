# -*- coding: utf-8 -*-
"""히트타일 신호 지킴이 (토큰 0 — Claude를 부르지 않는 순수 파이썬)

10분마다 한 번 돌고 끝난다. 아래 신호를 찾으면 비공개 연락함 PR에 댓글 하나
(`[클라우드에게] 신호 …`)를 남겨서, 그 PR을 구독 중인 클라우드 창구 세션을 깨운다.
같은 신호는 상태 파일(%LOCALAPPDATA%\\hittile-signal-watch.json)에 적어 두고 두 번 알리지 않는다.

  A. [까망이 보류/오류 #ID] · [작업담당 보류/오류 #ID] 가 2시간 넘게 그대로
  B. [클라우드에게] 일 요청 / 질문 이 영업시간 30분 넘게 답 없음
  C. 지킴이(연락함 · 카톡)가 멈춤 또는 실패 · 오류 줄이 몰림
  D. 최근전표(판매.csv)가 평일 낮에 2시간 넘게 안 올라옴
  E. 평일 15시가 지나도록 오늘 판매 전표 0건 (하루 한 번)

설치: tools/signal-watch-install.ps1   기록: %LOCALAPPDATA%\\hittile-signal-watch.log
시험: python tools/signal_watch.py --dry-run --now "2026-11-26T15:30:00+09:00"
      python -m unittest tools/test_signal_watch.py
표준 라이브러리와 gh 명령만 쓴다. 실패하면 기록 한 줄만 남기고 끝난다(다음 회차에 다시).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone, time as dtime

# ───────────────────────── 값은 여기 한 곳에서 바꾼다 ─────────────────────────
REPO = 'ppfppf2010-hue/hittile-inbox'   # tools/inbox-watch.ps1 과 같은 값 (--repo 로 바꿀 수 있음)
PR = 1                                  # (--pr)
KST = timezone(timedelta(hours=9))      # 한국 시간 고정(Windows에 tzdata가 없어도 되게 zoneinfo를 안 씀)

COMMENTS_LOOKBACK_HOURS = 48    # 댓글은 최근 이만큼만 읽는다(gh api ...?since=)
COMMENTS_MAX = 200              # 그중에서도 최근 이 개수만 본다
MAX_ROWS = 12                   # 한 댓글에 묶는 신호 줄 수 상한(넘으면 「외 n건」, 나머지는 다음 회차)
FIRST_LINE_MAX = 80             # 첫 줄 인용 글자 수

A_HOLD_HOURS = 2                # A: 보류 · 오류 뒤 이 시간 동안 다시 시킨 글이 없으면 알림

B_WAIT_MIN = 30                 # B: 영업시간으로 이만큼 지나도록 답이 없으면 알림
B_OPEN, B_CLOSE = dtime(8, 0), dtime(19, 0)
B_DAYS = (0, 1, 2, 3, 4, 5)     # 월(0)~토(5). 일요일은 세지 않는다

C_STALE_MIN = 15                # C: 지킴이 마지막 기록이 이만큼 오래되면 「멈춤」
C_ERR_WINDOW_MIN = 30           # C: 최근 이 시간 안에
C_ERR_COUNT = 5                 #    「실패」 · 「오류」 줄이 이 개수 이상이면 알림
C_ERR_WORDS = ('실패', '오류')
C_ERR_AGAIN_HOURS = 3           # 오류 몰림을 한 번 알린 뒤 이 시간 동안은 다시 알리지 않는다
C_LOG_TAIL_BYTES = 300000       # 기록 파일은 끝의 이만큼만 읽는다

D_STALE_HOURS = 2               # D: 판매.csv 가 (아래 시간 안에서 센) 이만큼 넘게 안 바뀌면 알림
D_OPEN, D_CLOSE = dtime(9, 0), dtime(18, 30)
WEEKDAYS = (0, 1, 2, 3, 4)      # 평일(월~금) — D · E 에 쓴다

E_AFTER = dtime(15, 0)          # E: 평일 이 시각이 지나도록 오늘 전표 0건이면 알림
E_UNTIL = dtime(19, 0)          #    이 시각 뒤에는 알리지 않는다

SILENT_DAYS = (6,)              # 일요일(6): 아무 신호도 보내지 않는다
STATE_KEEP_DAYS = 14            # 알린 기록은 이만큼만 기억
FOOTER = '(신호 지킴이 · 프로그램 자동 글 · 토큰 0)'
SIGNAL_HEAD = '[클라우드에게] 신호'
# ────────────────────────────────────────────────────────────────────────────

_LOCAL = os.environ.get('LOCALAPPDATA') or tempfile.gettempdir()
DEFAULT_STATE = os.path.join(_LOCAL, 'hittile-signal-watch.json')
DEFAULT_LOG = os.path.join(_LOCAL, 'hittile-signal-watch.log')
DEFAULT_INBOX_LOG = os.path.join(_LOCAL, 'hittile-inbox-watch.log')
DEFAULT_INBOX_DIR = os.path.join(os.environ.get('USERPROFILE') or os.path.expanduser('~'),
                                 'Desktop', '히트타일업무자동화', '연락함')

# 말머리 (tools/inbox-watch.ps1 의 정규식과 같은 모양)
HOLD_RE = re.compile(r'^\[(까망이?|작업\s*담당)\s*(보류|오류)\s*#(\d+)\]')
TO_PC_RE = re.compile(r'^\[(까망(이)?에게|작업\s*담당에게)\]')
CLOUD_REQ_RE = re.compile(r'^\[클라우드에게\]\s*(일\s*요청|질문)')
SIGNAL_RE = re.compile(r'^\[클라우드에게\]\s*신호')
ANSWER_RE = re.compile(r'\[(완료|대표님 확인 필요|까망이? 오류|까망이? 보류|(?:까망이?\s*)?진행\s?중'
                       r'|작업\s*담당\s*(?:오류|보류|진행\s?중))\s*#(\d+)\]|\[클라우드에게\]\s*질문\s*#(\d+)')
DONE_RE = re.compile(r'\[완료\s*#(\d+)\]')
LOG_TIME_RE = re.compile(r'^﻿?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})')


class GhError(Exception):
    pass


# ───────────────────────── 시간 ─────────────────────────
def parse_time(s):
    """ISO 시각 → 한국 시간(aware). 시간대가 없으면 한국 시간으로 본다."""
    s = str(s).strip()
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=KST)
    return d.astimezone(KST)


def business_minutes(start, end, open_t, close_t, days):
    """start~end 사이에서 지정한 요일 · 시간대(open~close) 안에 든 분만 센다."""
    start, end = start.astimezone(KST), end.astimezone(KST)
    if end <= start:
        return 0.0
    total = 0.0
    day = start.date()
    while day <= end.date():
        if day.weekday() in days:
            o = datetime.combine(day, open_t, KST)
            c = datetime.combine(day, close_t, KST)
            lo, hi = max(start, o), min(end, c)
            if hi > lo:
                total += (hi - lo).total_seconds() / 60.0
        day += timedelta(days=1)
    return total


def fmt_dur(minutes):
    minutes = int(minutes)
    h, m = divmod(minutes, 60)
    if h and m:
        return '%d시간 %d분' % (h, m)
    return '%d시간' % h if h else '%d분' % m


def fmt_kst(d):
    return d.astimezone(KST).strftime('%m/%d %H:%M')


# ───────────────────────── 댓글 ─────────────────────────
def parse_json_pages(text):
    """gh api --paginate 는 쪽마다 배열을 이어 붙여 준다([...][...]) → 하나로 합친다."""
    out, dec, i, n = [], json.JSONDecoder(), 0, len(text)
    while i < n:
        while i < n and text[i] in ' \t\r\n﻿':
            i += 1
        if i >= n:
            break
        obj, i = dec.raw_decode(text, i)
        if isinstance(obj, list):
            out.extend(obj)
        else:
            out.append(obj)
    return out


def normalize_comments(raw):
    """필요한 칸만 뽑아 시간순으로. 최근 COMMENTS_MAX 개만."""
    out = []
    for c in raw:
        try:
            out.append({'id': str(c['id']), 'at': parse_time(c['created_at']),
                        'body': str(c.get('body') or '').lstrip()})
        except Exception:
            continue
    out.sort(key=lambda c: (c['at'], int(c['id']) if c['id'].isdigit() else 0))
    return out[-COMMENTS_MAX:]


def fetch_comments(repo, pr, now):
    """연락함 댓글 중 최근 것만 읽는다(읽기 전용). gh 가 없거나 실패하면 GhError."""
    if not shutil.which('gh'):
        raise GhError('gh 명령이 없음')
    since = (now - timedelta(hours=COMMENTS_LOOKBACK_HOURS)).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    url = 'repos/%s/issues/%s/comments?per_page=100&since=%s' % (repo, pr, since)
    try:
        r = subprocess.run(['gh', 'api', url, '--paginate'], capture_output=True, timeout=120)
    except Exception as e:
        raise GhError('gh 실행 실패: %s' % e)
    if r.returncode != 0:
        raise GhError('GitHub 확인 실패 (gh 로그인 · 인터넷 확인) 코드 %s' % r.returncode)
    try:
        return parse_json_pages(r.stdout.decode('utf-8', 'replace'))
    except Exception as e:
        raise GhError('댓글 목록을 읽지 못함: %s' % e)


def first_line(body):
    for line in str(body).splitlines():
        line = line.strip()
        if line:
            return line[:FIRST_LINE_MAX] + ('…' if len(line) > FIRST_LINE_MAX else '')
    return ''


def mentions(body, num):
    """본문에 그 번호가 (다른 숫자의 일부가 아니라) 통째로 나오는지."""
    return bool(num) and re.search(r'(?<!\d)%s(?!\d)' % re.escape(str(num)), body) is not None


def quote(text):
    """신호 댓글 안에 옮겨 적을 때: 대괄호 말머리가 다른 지킴이 정규식에 걸리지 않게 바꾸고, 표가 안 깨지게."""
    return (str(text).replace('[', '〔').replace(']', '〕').replace('|', '/')
            .replace('\r', ' ').replace('\n', ' '))


# ───────────────────────── 신호 A · B ─────────────────────────
def signal_a(comments, now):
    """보류 · 오류 답이 달린 뒤 A_HOLD_HOURS 동안 그 일을 다시 시킨 글([까망이에게]/[작업담당에게])이 없음."""
    latest = {}   # 요청 ID → 가장 최근 보류 · 오류 댓글
    for i, c in enumerate(comments):
        m = HOLD_RE.match(c['body'])
        if m:
            latest[m.group(3)] = (i, c, m.group(2))
    out = []
    for req_id, (i, c, kind) in latest.items():
        age_min = (now - c['at']).total_seconds() / 60.0
        if age_min < A_HOLD_HOURS * 60:
            continue
        handled = False
        for later in comments[i + 1:]:
            b = later['body']
            if TO_PC_RE.match(b) and (mentions(b, req_id) or mentions(b, c['id'])):
                handled = True
                break
            if any(d == req_id for d in DONE_RE.findall(b)):   # 그 뒤에 실제로 끝났으면 묵은 것이 아님
                handled = True
                break
        if handled:
            continue
        out.append({'key': 'A:' + c['id'], 'kind': 'A ' + kind + ' 묵음', 'target': '댓글 ' + c['id'],
                    'text': '%s · %s 지남' % (quote(first_line(c['body'])), fmt_dur(age_min)), 'at': c['at']})
    out.sort(key=lambda s: s['at'])
    return out


def signal_b(comments, now):
    """[클라우드에게] 일 요청 · 질문 뒤 영업시간 B_WAIT_MIN 분 동안 클라우드 쪽 답이 없음."""
    out = []
    for i, c in enumerate(comments):
        b = c['body']
        if SIGNAL_RE.match(b):          # 신호 지킴이가 남긴 글은 대상이 아니다(자기 글을 다시 알리는 고리 방지)
            continue
        if not CLOUD_REQ_RE.match(b):
            continue
        waited = business_minutes(c['at'], now, B_OPEN, B_CLOSE, B_DAYS)
        if waited < B_WAIT_MIN:
            continue
        m = re.match(r'^\[클라우드에게\]\s*질문\s*#(\d+)', b)
        ref = m.group(1) if m else ''
        answered = False
        for later in comments[i + 1:]:
            lb = later['body']
            if TO_PC_RE.match(lb) and (mentions(lb, c['id']) or mentions(lb, ref)):
                answered = True
                break
        if answered:
            continue
        out.append({'key': 'B:' + c['id'], 'kind': 'B 요청 묵음', 'target': '댓글 ' + c['id'],
                    'text': '%s · 영업시간 %s 답 없음' % (quote(first_line(b)), fmt_dur(waited)), 'at': c['at']})
    return out


def waiting_pc_requests(comments, now, minutes):
    """PC 쪽에 시킨 요청 중 minutes 분이 지나도록 아무 답도 없는 것(지킴이가 안 집어 간 증거)."""
    answered = set()
    for c in comments:
        for m in ANSWER_RE.finditer(c['body']):
            answered.add(m.group(2) or m.group(3))
    return [c for c in comments
            if TO_PC_RE.match(c['body']) and c['id'] not in answered
            and (now - c['at']).total_seconds() / 60.0 >= minutes]


# ───────────────────────── 신호 C ─────────────────────────
def read_log_tail(path):
    with open(path, 'rb') as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - C_LOG_TAIL_BYTES))
        data = f.read()
    text = data.decode('utf-8', 'replace')
    if text.count('�') > len(text) // 20:       # UTF-8이 아니면(예: cp949) 다시
        text = data.decode('cp949', 'replace')
    return text.splitlines()


def log_line_time(line):
    m = LOG_TIME_RE.match(line)
    if not m:
        return None
    try:
        return datetime(*[int(x) for x in m.groups()], tzinfo=KST)
    except ValueError:
        return None


def signal_c(name, tag, log_path, now, stale_min, alive_path=None, quiet_ok=False, waiting=None):
    """지킴이 기록 파일로 멈춤 · 오류 몰림을 본다.
    quiet_ok: 일이 없으면 기록을 안 남기는 지킴이(연락함 지킴이) — 마지막 기록이 오래돼도
              '기다리는 요청(waiting)'이 있을 때만 멈춘 것으로 본다. alive_path(매 회차 갱신되는 파일)가 있으면 그 시각으로 본다."""
    out = []
    if not log_path or not os.path.isfile(log_path):
        return out
    try:
        lines = read_log_tail(log_path)
    except OSError:
        return out
    last, errs = None, 0
    for line in lines:
        t = log_line_time(line)
        if t is None:
            continue
        if last is None or t > last:
            last = t
        if 0 <= (now - t).total_seconds() <= C_ERR_WINDOW_MIN * 60 and any(w in line for w in C_ERR_WORDS):
            errs += 1
    alive_used = False
    if alive_path and os.path.isfile(alive_path):
        last = datetime.fromtimestamp(os.path.getmtime(alive_path), KST)
        alive_used = True
    if stale_min and last is not None:
        age = (now - last).total_seconds() / 60.0
        if age > stale_min:
            if alive_used or not quiet_ok:
                out.append({'key': 'C:%s:stale:%s' % (tag, last.strftime('%Y-%m-%dT%H:%M')),
                            'kind': 'C 지킴이 멈춤', 'target': name,
                            'text': '마지막 기록 %s (%s 전)' % (fmt_kst(last), fmt_dur(age))})
            elif waiting:
                ids = ', '.join(c['id'] for c in waiting[:5])
                out.append({'key': 'C:%s:stale:%s' % (tag, last.strftime('%Y-%m-%dT%H:%M')),
                            'kind': 'C 지킴이 멈춤', 'target': name,
                            'text': '마지막 기록 %s (%s 전) · %d분 넘게 안 집어 간 요청 %d건 (댓글 %s)'
                                    % (fmt_kst(last), fmt_dur(age), stale_min, len(waiting), ids)})
    if errs >= C_ERR_COUNT:
        out.append({'key': 'C:%s:errors' % tag, 'again_hours': C_ERR_AGAIN_HOURS,
                    'kind': 'C 지킴이 오류 몰림', 'target': name,
                    'text': '최근 %d분 실패 · 오류 줄 %d개 · 마지막 기록 %s'
                            % (C_ERR_WINDOW_MIN, errs, fmt_kst(last) if last else '없음')})
    return out


# ───────────────────────── 신호 D · E ─────────────────────────
def signal_d(inbox_dir, now):
    """평일 D_OPEN~D_CLOSE 안에서, 판매.csv 가 그 시간대로 D_STALE_HOURS 넘게 안 바뀜."""
    if now.weekday() not in WEEKDAYS or not (D_OPEN <= now.timetz().replace(tzinfo=None) <= D_CLOSE):
        return []
    path = os.path.join(inbox_dir, '자료', '최근전표', '판매.csv')
    if not os.path.isfile(path):
        return []
    mtime = datetime.fromtimestamp(os.path.getmtime(path), KST)
    stale = business_minutes(mtime, now, D_OPEN, D_CLOSE, WEEKDAYS)
    if stale <= D_STALE_HOURS * 60:
        return []
    return [{'key': 'D:' + now.strftime('%Y-%m-%d'), 'kind': 'D 최근전표 안 올라옴', 'target': '판매.csv',
             'text': '마지막 수정 %s (평일 낮 기준 %s 동안 그대로)' % (fmt_kst(mtime), fmt_dur(stale))}]


def read_text_any(path):
    with open(path, 'rb') as f:
        data = f.read()
    for enc in ('utf-8-sig', 'cp949'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', 'replace')


def count_today_slips(text, day):
    """전표번호 YYYY/MM/DD-n 중 오늘 것의 가짓수(월 · 일 앞의 0은 있어도 없어도)."""
    pat = re.compile(r'(?<!\d)%d/0?%d/0?%d\s*-\s*(\d+)' % (day.year, day.month, day.day))
    return len(set(pat.findall(text)))


def signal_e(inbox_dir, now):
    """평일 E_AFTER 가 지나도록 오늘 날짜 판매 전표가 0건. 하루 한 번."""
    t = now.timetz().replace(tzinfo=None)
    if now.weekday() not in WEEKDAYS or not (E_AFTER <= t <= E_UNTIL):
        return []
    base = os.path.join(inbox_dir, '자료', '최근전표')
    path = os.path.join(base, '판매_누적.csv')
    if not os.path.isfile(path):
        path = os.path.join(base, '판매.csv')
    if not os.path.isfile(path):
        return []
    try:
        n = count_today_slips(read_text_any(path), now.date())
    except OSError:
        return []
    if n:
        return []
    return [{'key': 'E:' + now.strftime('%Y-%m-%d'), 'kind': 'E 판매 전표 0건', 'target': os.path.basename(path),
             'text': '오늘 %d시까지 판매 전표 0건 (파일 수정 %s)'
                     % (E_AFTER.hour, fmt_kst(datetime.fromtimestamp(os.path.getmtime(path), KST)))}]


# ───────────────────────── 상태 · 댓글 ─────────────────────────
def load_state(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            st = json.load(f)
        if isinstance(st, dict) and isinstance(st.get('notified'), dict):
            return st
    except (OSError, ValueError):
        pass
    return {'notified': {}}


def save_state(path, state, now):
    keep = {}
    for k, v in state['notified'].items():
        try:
            if (now - parse_time(v)).days <= STATE_KEEP_DAYS:
                keep[k] = v
        except Exception:
            continue
    state['notified'] = keep
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def is_new(sig, state, now):
    prev = state['notified'].get(sig['key'])
    if not prev:
        return True
    again = sig.get('again_hours')
    if again:
        try:
            return (now - parse_time(prev)).total_seconds() >= again * 3600
        except Exception:
            return True
    return False


def build_comment(signals, now, more=0):
    lines = ['%s %d건 (%s)' % (SIGNAL_HEAD, len(signals) + more, fmt_kst(now)), '',
             '| 신호 | 대상 | 내용 |', '|---|---|---|']
    for s in signals:
        lines.append('| %s | %s | %s |' % (s['kind'], s['target'], s['text'].replace('|', '/')))
    if more:
        lines.append('')
        lines.append('외 %d건은 다음 회차에 알립니다.' % more)
    lines += ['', FOOTER]
    return '\n'.join(lines)


def post_comment(repo, pr, body):
    if not shutil.which('gh'):
        raise GhError('gh 명령이 없음')
    fd, tmp = tempfile.mkstemp(prefix='hittile-signal-', suffix='.txt')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:   # BOM 없는 UTF-8
            f.write(body)
        try:
            r = subprocess.run(['gh', 'pr', 'comment', str(pr), '-R', repo, '--body-file', tmp],
                               capture_output=True, timeout=120)
        except Exception as e:
            raise GhError('gh 실행 실패: %s' % e)
        if r.returncode != 0:
            raise GhError('댓글 실패 코드 %s' % r.returncode)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def write_log(path, msg):
    try:
        with open(path, 'a', encoding='utf-8') as f:
            f.write('%s %s\n' % (datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S'), msg))
    except OSError:
        pass


def collect(comments, now, args):
    """지금 조건에 걸리는 신호 전부(이미 알린 것 포함)."""
    sigs = []
    if comments is not None:
        sigs += signal_a(comments, now)
        sigs += signal_b(comments, now)
    waiting = waiting_pc_requests(comments, now, C_STALE_MIN) if comments is not None else []
    sigs += signal_c('연락함 지킴이', 'inbox', args.inbox_log, now, C_STALE_MIN,
                     alive_path=args.inbox_alive, quiet_ok=True, waiting=waiting)
    if args.kakao_log:
        sigs += signal_c('카톡 지킴이', 'kakao', args.kakao_log, now, args.kakao_stale_min)
    if args.inbox_dir and os.path.isdir(args.inbox_dir):
        sigs += signal_d(args.inbox_dir, now)
        sigs += signal_e(args.inbox_dir, now)
    return sigs


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='히트타일 신호 지킴이 (토큰 0)')
    p.add_argument('--repo', default=REPO)
    p.add_argument('--pr', default=str(PR))
    p.add_argument('--dry-run', action='store_true', help='댓글을 달지 않고 무엇을 알릴지만 출력(상태 파일도 안 바꿈)')
    p.add_argument('--now', help='시험용 현재 시각. 예: 2026-11-26T15:30:00+09:00')
    p.add_argument('--comments-file', help='시험용: 댓글 목록(JSON)을 gh 대신 이 파일에서 읽는다')
    p.add_argument('--inbox-dir', default=os.environ.get('HITTILE_INBOX_DIR') or DEFAULT_INBOX_DIR,
                   help='연락함 저장소 로컬 복사본 폴더(없으면 D · E 건너뜀). 환경변수 HITTILE_INBOX_DIR')
    p.add_argument('--inbox-log', default=DEFAULT_INBOX_LOG, help='연락함 지킴이 기록 파일')
    p.add_argument('--inbox-alive', default=os.path.join(_LOCAL, 'hittile-inbox-watch.alive'),
                   help='연락함 지킴이가 매 회차 갱신하는 파일(있을 때만 씀)')
    p.add_argument('--kakao-log', default=os.environ.get('HITTILE_KAKAO_LOG') or '',
                   help='카톡 지킴이 기록 파일(없으면 건너뜀). 환경변수 HITTILE_KAKAO_LOG')
    p.add_argument('--kakao-stale-min', type=int, default=C_STALE_MIN,
                   help='카톡 지킴이 「멈춤」 기준 분. 0이면 멈춤은 안 보고 오류 몰림만 본다')
    p.add_argument('--state-file', default=DEFAULT_STATE)
    p.add_argument('--log-file', default=DEFAULT_LOG)
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    now = parse_time(args.now) if args.now else datetime.now(KST)
    if now.weekday() in SILENT_DAYS:
        if args.dry_run:
            print('일요일 — 신호를 보내지 않습니다.')
        return 0

    # 댓글 읽기. 실패해도 C · D · E 는 PC 파일만 보므로 계속하고, 끝에 0이 아닌 코드로 끝낸다.
    comments, read_error = None, None
    try:
        if args.comments_file:
            with open(args.comments_file, 'r', encoding='utf-8-sig') as f:
                raw = parse_json_pages(f.read())
        else:
            raw = fetch_comments(args.repo, args.pr, now)
        comments = normalize_comments(raw)
    except (GhError, OSError, ValueError) as e:
        read_error = str(e)
        write_log(args.log_file, '댓글 읽기 실패: %s' % read_error)

    state = load_state(args.state_file)
    found = collect(comments, now, args)
    fresh = [s for s in found if is_new(s, state, now)]
    if not fresh:
        if args.dry_run:
            print('새 신호 없음 (조건에 걸린 것 %d건은 이미 알림)' % len(found))
        return 3 if read_error else 0

    send, more = fresh[:MAX_ROWS], max(0, len(fresh) - MAX_ROWS)
    body = build_comment(send, now, more)
    if args.dry_run:
        print('[시험] 댓글을 달지 않습니다. 아래 내용을 알릴 예정:\n')
        print(body)
        return 3 if read_error else 0
    try:
        post_comment(args.repo, args.pr, body)
    except GhError as e:
        write_log(args.log_file, '신호 %d건 알림 실패 → 다음 회차에 다시: %s' % (len(send), e))
        return 4
    for s in send:
        state['notified'][s['key']] = now.isoformat()
    try:
        save_state(args.state_file, state, now)
    except OSError as e:
        write_log(args.log_file, '상태 파일 저장 실패(같은 신호가 다시 갈 수 있음): %s' % e)
        return 5
    write_log(args.log_file, '신호 %d건 연락함에 알림: %s' % (len(send), ', '.join(s['key'] for s in send)))
    return 3 if read_error else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:   # 어떤 오류든 기록 한 줄만 남기고 끝낸다(다음 회차에 다시)
        write_log(DEFAULT_LOG, '예상 못 한 오류: %s: %s' % (type(e).__name__, e))
        sys.exit(1)
