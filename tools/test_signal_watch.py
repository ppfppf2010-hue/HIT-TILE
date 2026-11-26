# -*- coding: utf-8 -*-
"""신호 지킴이 시험 (표준 unittest). 전부 가짜 자료 — GitHub를 읽지도 쓰지도 않는다.
실행: python -m unittest tools/test_signal_watch.py -v   (또는 tools 폴더에서 python -m unittest -v)
"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, time as dtime
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signal_watch as sw  # noqa: E402

KST = sw.KST


def kst(s):
    return sw.parse_time(s)


def cmt(cid, at, body):
    """가짜 댓글(GitHub 모양: created_at 은 UTC)."""
    return {'id': cid, 'created_at': kst(at).astimezone(sw.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'body': body}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='sigwatch-test-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, 'state.json')
        self.log = os.path.join(self.tmp, 'signal.log')
        self.inbox_dir = os.path.join(self.tmp, '연락함')          # 만들기 전에는 없음 → D · E 건너뜀
        self.inbox_log = os.path.join(self.tmp, 'inbox-watch.log')  # 만들기 전에는 없음 → C 건너뜀
        self.posted = []
        # 어떤 시험에서도 진짜 gh 가 돌지 않게 막는다
        p = mock.patch.object(sw.subprocess, 'run', side_effect=AssertionError('시험에서 gh를 실행하면 안 됨'))
        p.start()
        self.addCleanup(p.stop)

    # ── 도우미 ──
    def run_main(self, now, comments=None, extra=(), dry=False, post_ok=True):
        argv = ['--now', now, '--state-file', self.state, '--log-file', self.log,
                '--inbox-dir', self.inbox_dir, '--inbox-log', self.inbox_log,
                '--inbox-alive', os.path.join(self.tmp, 'alive')] + list(extra)
        if comments is not None:
            cf = os.path.join(self.tmp, 'comments.json')
            with open(cf, 'w', encoding='utf-8') as f:
                json.dump(comments, f, ensure_ascii=False)
            argv += ['--comments-file', cf]
        if dry:
            argv.append('--dry-run')

        def fake_post(repo, pr, body):
            if not post_ok:
                raise sw.GhError('가짜 실패')
            self.posted.append(body)
        out = io.StringIO()
        with mock.patch.object(sw, 'post_comment', side_effect=fake_post), redirect_stdout(out):
            code = sw.main(argv)
        return code, out.getvalue()

    def write_log_file(self, path, lines):
        with open(path, 'w', encoding='utf-8-sig') as f:   # PowerShell Out-File -Encoding utf8 처럼 BOM 있음
            f.write('\n'.join(lines) + '\n')

    def make_csv(self, name, text, mtime):
        d = os.path.join(self.inbox_dir, '자료', '최근전표')
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, name)
        with open(p, 'w', encoding='utf-8-sig') as f:
            f.write(text)
        ts = kst(mtime).timestamp()
        os.utime(p, (ts, ts))
        return p


class TestTime(unittest.TestCase):
    def test_business_minutes(self):
        bm = lambda a, b: sw.business_minutes(kst(a), kst(b), dtime(8, 0), dtime(19, 0), (0, 1, 2, 3, 4, 5))
        self.assertEqual(bm('2026-11-26T10:00:00+09:00', '2026-11-26T10:30:00+09:00'), 30)
        # 저녁 18:50 → 다음 날 08:15 = 10분 + 15분
        self.assertEqual(bm('2026-11-26T18:50:00+09:00', '2026-11-27T08:15:00+09:00'), 25)
        # 밤 22:00 → 다음 날 07:59 = 0분
        self.assertEqual(bm('2026-11-26T22:00:00+09:00', '2026-11-27T07:59:00+09:00'), 0)
        # 토요일 18:50 → 월요일 08:10 : 일요일(11/29)은 세지 않음 = 10 + 10
        self.assertEqual(bm('2026-11-28T18:50:00+09:00', '2026-11-30T08:10:00+09:00'), 20)
        self.assertEqual(bm('2026-11-26T10:00:00+09:00', '2026-11-26T09:00:00+09:00'), 0)

    def test_parse_time(self):
        self.assertEqual(kst('2026-11-26T06:30:00Z').hour, 15)                 # UTC → 한국 시간
        self.assertEqual(kst('2026-11-26T15:30:00').utcoffset(), timedelta(hours=9))   # 시간대 없으면 한국 시간
        self.assertEqual(kst('2026-11-26T15:30:00+09:00').weekday(), 3)        # 목요일

    def test_parse_json_pages(self):
        self.assertEqual(len(sw.parse_json_pages('[{"id":1}]\n[{"id":2},{"id":3}]')), 3)
        self.assertEqual(sw.parse_json_pages(''), [])

    def test_recent_only(self):
        raw = [cmt(i, '2026-11-26T09:00:00+09:00', 'x') for i in range(1, 301)]
        got = sw.normalize_comments(raw)
        self.assertEqual(len(got), sw.COMMENTS_MAX)
        self.assertEqual(got[-1]['id'], '300')


class TestSignalA(Base):
    NOW = '2026-11-26T15:30:00+09:00'

    def test_alert_then_not_twice(self):
        cs = [cmt(1001, '2026-11-26T10:00:00+09:00', '[까망이에게] 자료 정리'),
              cmt(1002, '2026-11-26T10:05:00+09:00', '[까망이 보류 #1001] 로그인이 필요함\n둘째 줄')]
        code, _ = self.run_main(self.NOW, cs)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.posted), 1)
        body = self.posted[0]
        self.assertTrue(body.startswith('[클라우드에게] 신호 1건'))
        self.assertIn('댓글 1002', body)
        self.assertIn('로그인이 필요함', body)
        self.assertIn('5시간 25분 지남', body)
        self.assertNotIn('둘째 줄', body)
        self.assertTrue(body.rstrip().endswith(sw.FOOTER))
        # 두 번째 실행(10분 뒤)에는 다시 알리지 않는다
        code, _ = self.run_main('2026-11-26T15:40:00+09:00', cs)
        self.assertEqual((code, len(self.posted)), (0, 1))

    def test_not_yet_two_hours(self):
        cs = [cmt(1002, '2026-11-26T14:00:00+09:00', '[까망이 오류 #1001] 실패')]
        self.run_main(self.NOW, cs)
        self.assertEqual(self.posted, [])

    def test_followed_up_by_request_id_or_comment_id(self):
        hold = cmt(1002, '2026-11-26T10:05:00+09:00', '[작업담당 보류 #1001] 파일 없음')
        for follow in ('[까망이에게] #1001 다시 해 주세요', '[작업담당에게] 보류 1002 건 — 파일 올렸음'):
            self.posted.clear()
            if os.path.exists(self.state):
                os.remove(self.state)
            self.run_main(self.NOW, [hold, cmt(1003, '2026-11-26T11:00:00+09:00', follow)])
            self.assertEqual(self.posted, [], follow)

    def test_other_id_does_not_count(self):
        cs = [cmt(1002, '2026-11-26T10:05:00+09:00', '[까망이 보류 #1001] 파일 없음'),
              cmt(1003, '2026-11-26T11:00:00+09:00', '[까망이에게] #10019 다른 일'),      # 숫자 일부만 같음
              cmt(1004, '2026-11-26T09:00:00+09:00', '[까망이에게] #1001 (보류보다 먼저 쓴 글)')]
        self.run_main(self.NOW, cs)
        self.assertEqual(len(self.posted), 1)

    def test_done_later_or_newer_hold(self):
        cs = [cmt(1002, '2026-11-26T09:00:00+09:00', '[까망이 보류 #1001] 첫 보류'),
              cmt(1005, '2026-11-26T12:00:00+09:00', '[완료 #1001] 끝')]
        self.run_main(self.NOW, cs)
        self.assertEqual(self.posted, [])
        # 같은 요청에 보류가 두 번이면 최근 것 하나만
        cs = [cmt(1002, '2026-11-26T09:00:00+09:00', '[까망이 보류 #1001] 첫 보류'),
              cmt(1006, '2026-11-26T12:00:00+09:00', '[까망이 오류 #1001] 다시 실패')]
        self.run_main(self.NOW, cs)
        self.assertEqual(len(self.posted), 1)
        self.assertIn('댓글 1006', self.posted[0])
        self.assertNotIn('댓글 1002', self.posted[0])

    def test_marker_only_at_start(self):
        cs = [cmt(1007, '2026-11-26T09:00:00+09:00', '[까망이에게] 지난번 [까망이 보류 #1001] 건 말고 새 일')]
        self.run_main(self.NOW, cs)
        self.assertEqual(self.posted, [])


class TestBusinessHoursOnly(Base):
    """A · C 는 영업시간(월~토 08:00~19:00) 안에서만 알린다. 밤에 걸린 것은 다음 영업시간 첫 회차에, 그때도 걸릴 때만."""

    def test_in_business_hours(self):
        f = lambda t: sw.in_business_hours(kst(t))
        self.assertTrue(f('2026-11-26T08:00:00+09:00'))
        self.assertTrue(f('2026-11-26T19:00:00+09:00'))
        self.assertTrue(f('2026-11-28T12:00:00+09:00'))     # 토요일
        self.assertFalse(f('2026-11-26T07:59:00+09:00'))
        self.assertFalse(f('2026-11-26T19:01:00+09:00'))
        self.assertFalse(f('2026-11-29T12:00:00+09:00'))    # 일요일

    def test_a_waits_for_morning(self):
        cs = [cmt(1002, '2026-11-26T18:00:00+09:00', '[까망이 보류 #1001] 로그인이 필요함')]
        for night in ('2026-11-26T20:10:00+09:00', '2026-11-26T23:50:00+09:00', '2026-11-27T07:50:00+09:00'):
            code, _ = self.run_main(night, cs)
            self.assertEqual((code, self.posted), (0, []), night)
        self.assertFalse(os.path.exists(self.state))        # 밤에는 알린 것으로 적지도 않는다
        self.run_main('2026-11-27T08:00:00+09:00', cs)      # 다음 영업시간 첫 회차
        self.assertEqual(len(self.posted), 1)
        self.assertIn('댓글 1002', self.posted[0])
        self.run_main('2026-11-27T08:10:00+09:00', cs)
        self.assertEqual(len(self.posted), 1)

    def test_a_resolved_overnight_never_alerts(self):
        cs = [cmt(1002, '2026-11-26T18:00:00+09:00', '[까망이 보류 #1001] 로그인이 필요함')]
        self.run_main('2026-11-26T21:00:00+09:00', cs)
        cs.append(cmt(1003, '2026-11-26T22:00:00+09:00', '[까망이에게] #1001 다시'))
        self.run_main('2026-11-27T08:00:00+09:00', cs)
        self.assertEqual(self.posted, [])

    def test_c_waits_for_morning(self):
        klog = os.path.join(self.tmp, 'kakao.log')
        self.write_log_file(klog, ['2026-11-26 19:30:00 확인 끝'])
        self.write_log_file(self.inbox_log, ['2026-11-26 21:%02d:00 댓글 실패' % m for m in range(1, 9)])
        code, _ = self.run_main('2026-11-26T21:10:00+09:00', [], extra=['--kakao-log', klog])
        self.assertEqual((code, self.posted), (0, []))      # 밤: 멈춤도 오류 몰림도 안 알림
        self.run_main('2026-11-27T08:00:00+09:00', [], extra=['--kakao-log', klog])
        self.assertEqual(len(self.posted), 1)               # 아침에도 멈춰 있으면 알림(오류 몰림은 지나서 빠짐)
        self.assertIn('카톡 지킴이', self.posted[0])
        self.assertNotIn('오류 몰림', self.posted[0])

    def test_c_recovered_overnight_never_alerts(self):
        klog = os.path.join(self.tmp, 'kakao.log')
        self.write_log_file(klog, ['2026-11-26 19:30:00 확인 끝'])
        self.run_main('2026-11-26T21:10:00+09:00', [], extra=['--kakao-log', klog])
        self.write_log_file(klog, ['2026-11-27 07:55:00 확인 끝'])
        self.run_main('2026-11-27T08:00:00+09:00', [], extra=['--kakao-log', klog])
        self.assertEqual(self.posted, [])

    def test_b_d_e_unchanged_at_night(self):
        """B 는 밤에도(영업시간으로 60분이 이미 찼으면) 알린다 — 바꾼 것은 A · C 뿐."""
        cs = [cmt(2001, '2026-11-26T15:00:00+09:00', '[클라우드에게] 일 요청 — 새 글'),
              cmt(1002, '2026-11-26T15:00:00+09:00', '[까망이 보류 #1001] 나중에')]
        self.run_main('2026-11-26T21:00:00+09:00', cs)
        self.assertEqual(len(self.posted), 1)
        self.assertIn('B 요청 묵음', self.posted[0])
        self.assertNotIn('A 보류', self.posted[0])
        self.run_main('2026-11-27T08:00:00+09:00', cs)      # A 는 아침에 따로
        self.assertEqual(len(self.posted), 2)
        self.assertIn('A 보류 묵음', self.posted[1])
        self.assertNotIn('B 요청', self.posted[1])


class TestSignalB(Base):
    def test_alert_then_not_twice(self):
        cs = [cmt(2001, '2026-11-26T10:00:00+09:00', '[클라우드에게] 일 요청 — 발주방 새 글'),
              cmt(2002, '2026-11-26T10:10:00+09:00', '[클라우드에게] 질문 #1500 어느 쪽으로 할까요')]
        self.run_main('2026-11-26T11:15:00+09:00', cs)
        self.assertEqual(len(self.posted), 1)
        body = self.posted[0]
        self.assertIn('신호 2건', body)
        self.assertIn('댓글 2001', body)
        self.assertIn('댓글 2002', body)
        self.run_main('2026-11-26T11:25:00+09:00', cs)
        self.assertEqual(len(self.posted), 1)

    def test_under_60_minutes(self):
        cs = [cmt(2001, '2026-11-26T10:00:00+09:00', '[클라우드에게] 일 요청 — 발주방 새 글')]
        self.assertEqual(sw.B_WAIT_MIN, 60)
        self.run_main('2026-11-26T10:59:00+09:00', cs)
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-26T11:00:00+09:00', cs)
        self.assertEqual(len(self.posted), 1)

    def test_night_does_not_count(self):
        cs = [cmt(2001, '2026-11-26T18:50:00+09:00', '[클라우드에게] 질문 #1500 밤에 온 질문')]
        self.run_main('2026-11-26T23:30:00+09:00', cs)      # 영업시간으로는 10분
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-27T08:45:00+09:00', cs)      # 10 + 45 = 55분
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-27T08:55:00+09:00', cs)      # 65분
        self.assertEqual(len(self.posted), 1)

    def test_answered(self):
        q = cmt(2002, '2026-11-26T10:10:00+09:00', '[클라우드에게] 질문 #1500 어느 쪽으로 할까요')
        for ans in ('[까망이에게] 답 #1500 첫째로', '[까망이에게] 답 #2002 첫째로', '[작업담당에게] 2002 답: 첫째'):
            self.posted.clear()
            self.run_main('2026-11-26T11:30:00+09:00', [q, cmt(2003, '2026-11-26T10:20:00+09:00', ans)])
            self.assertEqual(self.posted, [], ans)
        # 그 ID를 말하지 않은 글 · 질문보다 먼저 쓴 글은 답이 아니다
        self.run_main('2026-11-26T11:30:00+09:00',
                      [cmt(2000, '2026-11-26T10:00:00+09:00', '[까망이에게] 답 #1500 (먼저 쓴 글)'), q,
                       cmt(2003, '2026-11-26T10:20:00+09:00', '[까망이에게] 다른 일')])
        self.assertEqual(len(self.posted), 1)

    def test_own_signal_and_other_cloud_comments_excluded(self):
        cs = [cmt(2101, '2026-11-26T09:00:00+09:00',
                  '[클라우드에게] 신호 1건 (11/26 09:00)\n\n| 신호 | 대상 | 내용 |\n|---|---|---|\n'
                  '| B 요청 묵음 | 댓글 2001 | 〔클라우드에게〕 질문 #1500 … |\n\n' + sw.FOOTER),
              cmt(2102, '2026-11-26T09:00:00+09:00', '[클라우드에게] 대표님 확인 답 #7 제목 — 선택: 가'),
              cmt(2103, '2026-11-26T09:00:00+09:00', '[클라우드에게] 신호 질문 일 요청')]
        self.run_main('2026-11-26T15:30:00+09:00', cs)
        self.assertEqual(self.posted, [])

    def test_quoted_text_is_neutralized(self):
        """신호 댓글에 옮겨 적은 첫 줄이 다른 지킴이의 말머리 정규식에 걸리지 않아야 한다."""
        cs = [cmt(2001, '2026-11-26T10:00:00+09:00', '[클라우드에게] 질문 #1500 [완료 #777] 인지 | 확인'),
              cmt(2002, '2026-11-26T10:00:00+09:00', '[까망이 보류 #1400] 나중에')]
        self.run_main('2026-11-26T15:30:00+09:00', cs)
        body = self.posted[0]
        self.assertIsNone(sw.ANSWER_RE.search(body))              # inbox-watch.ps1 의 「답 있음」 모양
        self.assertIsNone(sw.TO_PC_RE.match(body))                # [까망이에게] · [작업담당에게] 로 시작하지 않음
        self.assertIsNone(sw.CLOUD_REQ_RE.match(body))
        self.assertIsNotNone(sw.SIGNAL_RE.match(body))
        self.assertEqual(body.count('[클라우드에게]'), 1)
        rows = [l for l in body.splitlines() if l.startswith('| A') or l.startswith('| B')]
        self.assertTrue(all(l.count('|') == 4 for l in rows), rows)   # 표 칸이 안 깨짐
        # 그 신호 댓글이 다음 회차 목록에 들어와도 새 신호가 생기지 않는다
        cs2 = cs + [cmt(2999, '2026-11-26T15:30:00+09:00', body)]
        self.run_main('2026-11-26T18:00:00+09:00', cs2)
        self.assertEqual(len(self.posted), 1)


class TestSignalC(Base):
    NOW = '2026-11-26T15:30:00+09:00'

    def test_inbox_quiet_is_not_stopped(self):
        """연락함 지킴이는 일이 없으면 기록을 안 남긴다 → 기록이 오래됐다는 것만으로는 알리지 않는다."""
        self.write_log_file(self.inbox_log, ['2026-11-26 09:00:00 새 요청 1건 → 까망이 실행 (댓글 ID: 1)'])
        self.run_main(self.NOW, [])
        self.assertEqual(self.posted, [])

    def test_inbox_stopped_with_waiting_request(self):
        self.write_log_file(self.inbox_log, ['2026-11-26 09:00:00 까망이 종료 (코드 0)'])
        cs = [cmt(3001, '2026-11-26T15:00:00+09:00', '[까망이에게] 최근전표')]
        self.run_main(self.NOW, cs)
        self.assertEqual(len(self.posted), 1)
        self.assertIn('연락함 지킴이', self.posted[0])
        self.assertIn('마지막 기록 11/26 09:00', self.posted[0])
        self.assertIn('댓글 3001', self.posted[0])
        self.run_main('2026-11-26T15:40:00+09:00', cs)          # 같은 멈춤은 다시 알리지 않음
        self.assertEqual(len(self.posted), 1)

    def test_inbox_waiting_but_answered_or_fresh(self):
        self.write_log_file(self.inbox_log, ['2026-11-26 09:00:00 까망이 종료 (코드 0)'])
        self.run_main(self.NOW, [cmt(3001, '2026-11-26T15:00:00+09:00', '[까망이에게] 최근전표'),
                                 cmt(3002, '2026-11-26T15:01:00+09:00', '[완료 #3001] 올림')])
        self.run_main(self.NOW, [cmt(3003, '2026-11-26T15:20:00+09:00', '[작업담당에게] 방금 시킨 일')])
        self.assertEqual(self.posted, [])

    def test_alive_file(self):
        """매 회차 갱신 파일이 있으면 그 시각만 본다."""
        self.write_log_file(self.inbox_log, ['2026-11-26 09:00:00 까망이 종료 (코드 0)'])
        alive = os.path.join(self.tmp, 'alive')
        open(alive, 'w').close()
        ts = kst('2026-11-26T15:25:00+09:00').timestamp()
        os.utime(alive, (ts, ts))
        self.run_main(self.NOW, [cmt(3001, '2026-11-26T15:00:00+09:00', '[까망이에게] 최근전표')])
        self.assertEqual(self.posted, [])
        ts = kst('2026-11-26T15:00:00+09:00').timestamp()
        os.utime(alive, (ts, ts))
        self.run_main(self.NOW, [])
        self.assertEqual(len(self.posted), 1)
        self.assertIn('마지막 기록 11/26 15:00 (30분 전)', self.posted[0])

    def test_error_burst(self):
        lines = ['2026-11-26 14:00:00 건너뜀: GitHub 확인 실패 (오래된 줄)'] * 9
        lines += ['2026-11-26 15:%02d:00 건너뜀: GitHub 확인 실패' % m for m in (5, 10, 15, 20)]
        self.write_log_file(self.inbox_log, lines)
        self.run_main(self.NOW, [])                              # 30분 안에는 4줄뿐
        self.assertEqual(self.posted, [])
        lines.append('2026-11-26 15:25:00 [까망이] 오류가 났습니다')
        self.write_log_file(self.inbox_log, lines)
        self.run_main(self.NOW, [])
        self.assertEqual(len(self.posted), 1)
        self.assertIn('실패 · 오류 줄 5개', self.posted[0])
        self.run_main('2026-11-26T15:40:00+09:00', [])           # 바로 다시 알리지 않음
        self.assertEqual(len(self.posted), 1)

    def test_kakao_log(self):
        klog = os.path.join(self.tmp, 'kakao.log')
        self.run_main(self.NOW, [], extra=['--kakao-log', klog])           # 파일 없음 → 건너뜀
        self.assertEqual(self.posted, [])
        self.write_log_file(klog, ['2026-11-26 15:20:00 확인 끝'])
        self.run_main(self.NOW, [], extra=['--kakao-log', klog])           # 10분 전 → 정상
        self.assertEqual(self.posted, [])
        self.write_log_file(klog, ['2026-11-26 15:00:00 확인 끝', '시각 없는 줄'])
        self.run_main(self.NOW, [], extra=['--kakao-log', klog, '--kakao-stale-min', '0'])   # 멈춤 검사 끔
        self.assertEqual(self.posted, [])
        self.run_main(self.NOW, [], extra=['--kakao-log', klog])           # 30분 전 → 멈춤
        self.assertEqual(len(self.posted), 1)
        self.assertIn('카톡 지킴이', self.posted[0])
        self.assertIn('마지막 기록 11/26 15:00 (30분 전)', self.posted[0])
        self.run_main('2026-11-26T15:40:00+09:00', [], extra=['--kakao-log', klog])
        self.assertEqual(len(self.posted), 1)
        # 다시 살아났다가 또 멈추면(마지막 기록이 다름) 새로 알린다
        self.write_log_file(klog, ['2026-11-26 16:00:00 확인 끝'])
        self.run_main('2026-11-26T16:30:00+09:00', [], extra=['--kakao-log', klog])
        self.assertEqual(len(self.posted), 2)


class TestSignalDE(Base):
    def test_d_alert_once_a_day(self):
        self.make_csv('판매.csv', '전표번호\n2026/11/26-1\n', '2026-11-26T10:00:00+09:00')
        self.run_main('2026-11-26T11:50:00+09:00', [])           # 1시간 50분
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-26T12:10:00+09:00', [])           # 2시간 10분
        self.assertEqual(len(self.posted), 1)
        self.assertIn('D 최근전표 안 올라옴', self.posted[0])
        self.assertIn('마지막 수정 11/26 10:00', self.posted[0])
        self.run_main('2026-11-26T14:00:00+09:00', [])           # 같은 날 다시 알리지 않음
        self.assertEqual(len(self.posted), 1)

    def test_d_morning_and_outside_hours(self):
        self.make_csv('판매.csv', '전표번호\n2026/11/25-1\n2026/11/26-1\n', '2026-11-25T18:00:00+09:00')
        self.run_main('2026-11-26T09:30:00+09:00', [])           # 어제 30분 + 오늘 30분 = 1시간
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-26T20:00:00+09:00', [])           # 18:30 뒤에는 안 봄
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-28T12:00:00+09:00', [])           # 토요일은 평일이 아님
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-26T10:40:00+09:00', [])           # 30분 + 1시간 40분 = 2시간 10분
        self.assertEqual(len(self.posted), 1)

    def test_no_inbox_dir_skips(self):
        self.run_main('2026-11-26T15:30:00+09:00', [])
        self.assertEqual(self.posted, [])

    def test_e_zero_slips_once(self):
        self.make_csv('판매.csv', '전표번호\n2026/11/26-1\n', '2026-11-26T15:20:00+09:00')       # 누적이 우선
        self.make_csv('판매_누적.csv', '전표번호,거래처\n2026/11/25-3,가\n2026/11/2-6,나\n', '2026-11-26T15:20:00+09:00')
        self.run_main('2026-11-26T14:50:00+09:00', [])           # 15시 전
        self.assertEqual(self.posted, [])
        self.run_main('2026-11-26T15:30:00+09:00', [])
        self.assertEqual(len(self.posted), 1)
        self.assertIn('오늘 15시까지 판매 전표 0건', self.posted[0])
        self.assertIn('판매_누적.csv', self.posted[0])
        self.run_main('2026-11-26T16:30:00+09:00', [])           # 하루 한 번
        self.assertEqual(len(self.posted), 1)

    def test_e_has_slips_or_fallback_or_weekend(self):
        self.make_csv('판매.csv', '전표번호\n2026/11/26-1\n2026/11/26-1\n2026/11/26-2\n', '2026-11-26T15:20:00+09:00')
        self.run_main('2026-11-26T15:30:00+09:00', [])           # 누적 없음 → 판매.csv, 오늘 2건
        self.assertEqual(self.posted, [])
        self.assertEqual(sw.count_today_slips('2026/11/26-1,2026/11/26-2,2026/11/26-1', kst('2026-11-26T00:00:00').date()), 2)
        self.assertEqual(sw.count_today_slips('2026/1/5-1 2026/01/05-2 2026/1/50-3', datetime(2026, 1, 5).date()), 2)
        self.run_main('2026-11-28T15:30:00+09:00', [])           # 토요일
        self.run_main('2026-11-27T20:00:00+09:00', [])           # 19시 뒤
        self.assertEqual(self.posted, [])

    def test_e_cp949_file(self):
        p = self.make_csv('판매_누적.csv', '', '2026-11-26T15:20:00+09:00')
        with open(p, 'wb') as f:
            f.write('전표번호,거래처\n2026/11/26-4,가나다\n'.encode('cp949'))
        ts = kst('2026-11-26T15:20:00+09:00').timestamp()
        os.utime(p, (ts, ts))
        self.run_main('2026-11-26T15:30:00+09:00', [])
        self.assertEqual(self.posted, [])


class TestCommon(Base):
    def all_signals(self):
        """A · B · C · D · E 가 한꺼번에 걸리는 자료."""
        self.write_log_file(self.inbox_log, ['2026-11-26 15:%02d:00 댓글 실패' % m for m in range(10, 16)])
        self.make_csv('판매.csv', '전표번호\n2026/11/25-1\n', '2026-11-26T09:10:00+09:00')
        return [cmt(1002, '2026-11-26T10:05:00+09:00', '[까망이 보류 #1001] 로그인이 필요함'),
                cmt(2001, '2026-11-26T11:00:00+09:00', '[클라우드에게] 일 요청 — 발주방 새 글')]

    def test_bundled_into_one_comment(self):
        cs = self.all_signals()
        code, _ = self.run_main('2026-11-26T15:30:00+09:00', cs)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.posted), 1)
        body = self.posted[0]
        self.assertIn('신호 5건', body)
        for head in ('| A 보류 묵음', '| B 요청 묵음', '| C 지킴이 오류 몰림', '| D 최근전표 안 올라옴', '| E 판매 전표 0건'):
            self.assertIn(head, body)
        self.assertTrue(body.rstrip().endswith(sw.FOOTER))
        self.assertIn('\n\n| 신호 | 대상 | 내용 |\n|---|---|---|\n', body)
        with open(self.state, encoding='utf-8') as f:
            self.assertEqual(len(json.load(f)['notified']), 5)
        with open(self.log, encoding='utf-8') as f:
            self.assertIn('신호 5건 연락함에 알림', f.read())
        code, _ = self.run_main('2026-11-26T15:40:00+09:00', cs)
        self.assertEqual((code, len(self.posted)), (0, 1))

    def test_sunday_silent(self):
        cs = self.all_signals()
        code, out = self.run_main('2026-11-29T15:30:00+09:00', cs)          # 일요일
        self.assertEqual((code, self.posted), (0, []))
        self.assertFalse(os.path.exists(self.state))
        code, out = self.run_main('2026-11-29T15:30:00+09:00', cs, dry=True)
        self.assertIn('일요일', out)

    def test_dry_run_posts_nothing_and_keeps_state(self):
        cs = self.all_signals()
        code, out = self.run_main('2026-11-26T15:30:00+09:00', cs, dry=True)
        self.assertEqual((code, self.posted), (0, []))
        self.assertIn('[클라우드에게] 신호 5건', out)
        self.assertFalse(os.path.exists(self.state))
        self.run_main('2026-11-26T15:30:00+09:00', cs)                      # 시험 뒤 진짜 실행은 그대로 알림
        self.assertEqual(len(self.posted), 1)

    def test_post_failure_retries_next_time(self):
        cs = self.all_signals()
        code, _ = self.run_main('2026-11-26T15:30:00+09:00', cs, post_ok=False)
        self.assertEqual(code, 4)
        self.assertFalse(os.path.exists(self.state))
        with open(self.log, encoding='utf-8') as f:
            self.assertIn('알림 실패', f.read())
        self.run_main('2026-11-26T15:40:00+09:00', cs)
        self.assertEqual(len(self.posted), 1)

    def test_gh_missing(self):
        """gh 가 없으면 기록만 남기고 0이 아닌 코드로 끝난다(예외로 죽지 않음)."""
        with mock.patch.object(sw.shutil, 'which', return_value=None):
            code, _ = self.run_main('2026-11-26T15:30:00+09:00', None)      # 댓글 파일 없이 → gh 로 읽으려 함
            self.assertEqual(code, 3)
            self.assertEqual(self.posted, [])
            with open(self.log, encoding='utf-8') as f:
                self.assertIn('gh 명령이 없음', f.read())
            # 댓글 달기도 gh 가 없으면 GhError
            with self.assertRaises(sw.GhError):
                sw.post_comment(sw.REPO, sw.PR, '본문')

    def test_gh_not_logged_in(self):
        fake = mock.Mock(returncode=1, stdout=b'', stderr=b'not logged in')
        with mock.patch.object(sw.shutil, 'which', return_value='gh'), \
                mock.patch.object(sw.subprocess, 'run', return_value=fake) as run:
            code, _ = self.run_main('2026-11-26T15:30:00+09:00', None)
            self.assertEqual(code, 3)
            args = run.call_args[0][0]
            self.assertEqual(args[:2], ['gh', 'api'])
            self.assertIn('per_page=100&since=2026-11-24T06:30:00Z', args[2])   # 최근 48시간만
        with open(self.log, encoding='utf-8') as f:
            self.assertIn('GitHub 확인 실패', f.read())

    def test_gh_down_still_reports_pc_signals(self):
        """GitHub를 못 읽어도 PC 파일로 아는 신호(C · D · E)는 계속 본다."""
        self.all_signals()
        with mock.patch.object(sw.shutil, 'which', return_value=None):
            code, out = self.run_main('2026-11-26T15:30:00+09:00', None, dry=True)
        self.assertEqual(code, 3)
        self.assertIn('신호 3건', out)

    def test_row_cap(self):
        cs = [cmt(5000 + i, '2026-11-26T09:00:00+09:00', '[클라우드에게] 일 요청 %d' % i) for i in range(15)]
        self.run_main('2026-11-26T15:30:00+09:00', cs)
        self.assertEqual(len(self.posted), 1)
        self.assertIn('신호 15건', self.posted[0])
        self.assertIn('외 3건은 다음 회차에', self.posted[0])
        self.run_main('2026-11-26T15:40:00+09:00', cs)                      # 남은 3건
        self.assertEqual(len(self.posted), 2)
        self.assertIn('신호 3건', self.posted[1])
        self.run_main('2026-11-26T15:50:00+09:00', cs)
        self.assertEqual(len(self.posted), 2)

    def test_broken_state_file(self):
        with open(self.state, 'w') as f:
            f.write('{깨진 파일')
        cs = [cmt(2001, '2026-11-26T11:00:00+09:00', '[클라우드에게] 일 요청')]
        code, _ = self.run_main('2026-11-26T15:30:00+09:00', cs)
        self.assertEqual((code, len(self.posted)), (0, 1))

    def test_post_comment_uses_body_file(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen['cmd'] = cmd
            with open(cmd[cmd.index('--body-file') + 1], 'rb') as f:
                seen['bytes'] = f.read()
            return mock.Mock(returncode=0, stdout=b'', stderr=b'')
        with mock.patch.object(sw.shutil, 'which', return_value='gh'), \
                mock.patch.object(sw.subprocess, 'run', side_effect=fake_run):
            sw.post_comment('a/b', 1, '[클라우드에게] 신호 1건\n한글')
        self.assertEqual(seen['cmd'][:6], ['gh', 'pr', 'comment', '1', '-R', 'a/b'])
        self.assertEqual(seen['bytes'].decode('utf-8'), '[클라우드에게] 신호 1건\n한글')   # BOM 없음
        self.assertFalse(os.path.exists(seen['cmd'][-1]))                             # 임시 파일 지움


if __name__ == '__main__':
    unittest.main()


class TestCloudAck(Base):
    """창구의 짧은 확인 [클라우드 확인 #ID] · [클라우드 처리 #ID] 는 A · B 모두 「답 있음」."""
    NOW = '2026-11-26T15:30:00+09:00'

    def fresh(self):
        self.posted.clear()
        if os.path.exists(self.state):
            os.remove(self.state)

    def test_ack_closes_hold(self):
        hold = cmt(1002, '2026-11-26T10:05:00+09:00', '[까망이 보류 #1001] 이카운트 로그인 실패')
        for ack in ('[클라우드 확인 #1001] 새 요청으로 다시 시킴', '[클라우드 처리 #1002] 채팅으로 처리',
                    '[클라우드확인 #1001] 붙여 써도 됨'):
            self.fresh()
            self.run_main(self.NOW, [hold, cmt(1003, '2026-11-26T11:00:00+09:00', ack)])
            self.assertEqual(self.posted, [], ack)

    def test_ack_closes_request_by_comment_or_request_id(self):
        req = cmt(2001, '2026-11-26T10:00:00+09:00', '[클라우드에게] 일 요청 #162\n- 방: 발주방 새 글')
        for ack in ('[클라우드 확인 #2001] 채팅으로 대표님께 보고함', '[클라우드 확인 #162] 처리함',
                    '[클라우드 처리 #162] 전표 확인'):
            self.fresh()
            self.run_main(self.NOW, [req, cmt(2002, '2026-11-26T10:30:00+09:00', ack)])
            self.assertEqual(self.posted, [], ack)

    def test_ack_must_match_id_and_come_later(self):
        req = cmt(2001, '2026-11-26T10:00:00+09:00', '[클라우드에게] 일 요청 #162\n- 방: 발주방 새 글')
        cases = [
            [req, cmt(2002, '2026-11-26T10:30:00+09:00', '[클라우드 확인 #1620] 숫자 일부만 같음')],
            [cmt(2000, '2026-11-26T09:00:00+09:00', '[클라우드 확인 #162] 먼저 쓴 글'), req],
            [req, cmt(2002, '2026-11-26T10:30:00+09:00', '참고: [클라우드 확인 #162] 말머리가 맨 앞이 아님')],
        ]
        for cs in cases:
            self.fresh()
            self.run_main(self.NOW, cs)
            self.assertEqual(len(self.posted), 1, cs)
        # 보류도 다른 ID 확인은 답이 아님
        self.fresh()
        self.run_main(self.NOW, [cmt(1002, '2026-11-26T10:05:00+09:00', '[까망이 보류 #1001] 실패'),
                                 cmt(1003, '2026-11-26T11:00:00+09:00', '[클라우드 확인 #999] 다른 건')])
        self.assertEqual(len(self.posted), 1)

    def test_ack_is_not_a_signal_or_request(self):
        """확인 댓글 자체는 B 대상도, 연락함 지킴이의 PC 요청도 아니다."""
        b = '[클라우드 확인 #162] 처리함'
        self.assertIsNone(sw.CLOUD_REQ_RE.match(b))
        self.assertIsNone(sw.TO_PC_RE.match(b))
        self.assertIsNone(sw.SIGNAL_RE.match(b))


class TestNoActionRequest(Base):
    NOW = '2026-11-26T15:30:00+09:00'

    def test_no_action_requests_skipped(self):
        bodies = [
            '[클라우드에게] 일 요청 #170 (참고만)\n- 방: 발주방 새 글',
            '[클라우드에게] 일 요청 #171\n알림만 — 거래처가 통화 완료',
            '[클라우드에게] 일 요청 #172 (기록용)',
            '[클라우드에게] 일 요청 #173\n- 사진 1장\n- 전송 없음 · 새 요청 없음',
            '[클라우드에게] 일 요청 #174\n- 통화 결과 공유\n- 할 일 없음',
        ]
        cs = [cmt(3000 + i, '2026-11-26T09:00:00+09:00', b) for i, b in enumerate(bodies)]
        self.run_main(self.NOW, cs)
        self.assertEqual(self.posted, [])

    def test_real_requests_still_alert(self):
        """보수적으로: 「전송 없음」만 · 셋째 줄 뒤의 「참고만」 · 「참고:」는 빼지 않는다."""
        bodies = [
            '[클라우드에게] 일 요청 #163 (매입단가 기록 + 견적 짝 확인, 전송 없음)\n- 단가 기록 부탁',
            '[클라우드에게] 일 요청 #162\n- 방: 발주방\n- 원문: 반품입니다\n- 사진은 참고만',
            '[클라우드에게] 일 요청 #164\n- 참고: 앞 요청과 같은 반품 건',
            '[클라우드에게] 질문 #1500 새 요청 없음인데 전송해도 될까요',
        ]
        cs = [cmt(3100 + i, '2026-11-26T09:00:00+09:00', b) for i, b in enumerate(bodies)]
        self.run_main(self.NOW, cs)
        self.assertEqual(len(self.posted), 1)
        self.assertIn('신호 4건', self.posted[0])


class TestBaseline(Base):
    def old_stuff(self):
        return [cmt(1002, '2026-11-25T10:05:00+09:00', '[까망이 보류 #1001] 로그인 실패'),
                cmt(2001, '2026-11-25T11:00:00+09:00', '[클라우드에게] 일 요청 #162 발주방 새 글')]

    def test_baseline_remembers_without_posting(self):
        cs = self.old_stuff()
        code, out = self.run_main('2026-11-26T14:30:00+09:00', cs, extra=['--baseline'])
        self.assertEqual(code, 0)
        self.assertEqual(self.posted, [])
        with open(self.state, encoding='utf-8') as f:
            notified = json.load(f)['notified']
        self.assertIn('A:1002', notified)
        self.assertIn('B:2001', notified)
        self.assertIn('2건', out)
        with open(self.log, encoding='utf-8') as f:
            self.assertIn('기준선', f.read())
        # 다음 회차: 옛 건은 조용, 새로 생긴 것만 알린다
        cs2 = cs + [cmt(2002, '2026-11-26T14:40:00+09:00', '[클라우드에게] 일 요청 #180 새 글')]
        self.run_main('2026-11-26T15:50:00+09:00', cs2)
        self.assertEqual(len(self.posted), 1)
        self.assertIn('신호 1건', self.posted[0])
        self.assertIn('댓글 2002', self.posted[0])
        self.assertNotIn('댓글 2001', self.posted[0])
        self.assertNotIn('댓글 1002', self.posted[0])

    def test_baseline_at_night_or_sunday_includes_a(self):
        """밤 · 일요일에 설치해도 A(영업시간에만 알리는 것)까지 기억해 아침에 옛 건이 안 올라온다."""
        for now in ('2026-11-26T22:00:00+09:00', '2026-11-29T10:00:00+09:00'):
            if os.path.exists(self.state):
                os.remove(self.state)
            self.posted.clear()
            code, _ = self.run_main(now, self.old_stuff(), extra=['--baseline'])
            self.assertEqual((code, self.posted), (0, []))
            with open(self.state, encoding='utf-8') as f:
                self.assertIn('A:1002', json.load(f)['notified'])
        self.run_main('2026-11-30T09:30:00+09:00', self.old_stuff())
        self.assertEqual(self.posted, [])

    def test_baseline_dry_run_keeps_state(self):
        code, out = self.run_main('2026-11-26T14:30:00+09:00', self.old_stuff(), extra=['--baseline'], dry=True)
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(self.state))
        self.assertIn('기준선', out)
        self.assertEqual(self.posted, [])

    def test_baseline_gh_failure_returns_3(self):
        with mock.patch.object(sw, 'fetch_comments', side_effect=sw.GhError('gh 로그인 안 됨')):
            code, out = self.run_main('2026-11-26T14:30:00+09:00', extra=['--baseline'])
        self.assertEqual(code, 3)
        self.assertEqual(self.posted, [])
        self.assertIn('못 읽어', out)

    def test_install_script_runs_baseline_first(self):
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'signal-watch-install.ps1')
        with open(p, encoding='utf-8-sig') as f:
            text = f.read()
        self.assertIn('--baseline', text)
        self.assertLess(text.index('--baseline'), text.index('schtasks /Create'))
