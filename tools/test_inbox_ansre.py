# -*- coding: utf-8 -*-
"""연락함 지킴이 「답 있음」 모양($AnsRe) 시험.

inbox-watch.ps1 · inbox-worker.ps1 에 적힌 정규식을 그대로 읽어 와서(.NET 과 파이썬에서 같은 뜻인 문법만 씀)
답으로 봐야 하는 글 · 보면 안 되는 글을 확인한다. 두 파일의 모양이 같은지도 같이 본다.
실행: python -m unittest tools/test_inbox_ansre.py
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    with open(os.path.join(HERE, name), encoding='utf-8') as f:
        m = re.search(r"^\$AnsRe = '(.+)'\s*$", f.read(), re.M)
    assert m, name + ' 에서 $AnsRe 를 찾지 못함'
    return m.group(1)


def ids(pattern, body):
    return {m.group(2) or m.group(3) for m in re.finditer(pattern, body)}


class AnsReTest(unittest.TestCase):
    def setUp(self):
        self.re = load('inbox-watch.ps1')

    def test_two_files_same(self):
        self.assertEqual(self.re, load('inbox-worker.ps1'))

    def test_answers(self):
        cases = [
            # 11/27 거짓 「까망이 오류」 알림이 난 두 모양
            ('[클라우드에게] [보류 #7207920487] 뉴타운 방 읽기 못 함', '7207920487'),
            ('[클라우드에게] [완료 #7208263266 — 일부만, 준비 끝 아님]\n| 표 |', '7208263266'),
            # 원래 되던 모양
            ('[클라우드에게] [완료 #7207946477] 읽음', '7207946477'),
            ('[완료 #7208257410] 끝', '7208257410'),
            ('[까망이 보류 #7207738776] 로그인 필요', '7207738776'),
            ('[까망이 오류 #11] 실패', '11'),
            ('[까망 오류 #12] 실패', '12'),
            ('[오류 #13] 실패', '13'),
            ('[대표님 확인 필요 #14] 입금 건', '14'),
            ('[까망이 진행중 #15]', '15'),
            ('[진행 중 #16]', '16'),
            ('[작업담당 보류 #17] 로그인 풀림', '17'),
            ('[작업담당 오류 #18] 시간 초과', '18'),
            ('[작업 담당 진행중 #19]', '19'),
            ('[작업담당 보류 #20 — 한 단계만 함] 남은 일', '20'),
            ('[클라우드에게] 질문 #21 하던 일 / 물어볼 것', '21'),
        ]
        for body, want in cases:
            self.assertEqual(ids(self.re, body), {want}, body)

    def test_not_answers(self):
        for body in [
            '[까망이에게] 뉴타운 방 최근 글 읽기 (전송 없음)',
            '[작업담당에게] 최근전표 다시 받기',
            '[까망이에게] 답 #7207920487 대표님 OK',
            '[클라우드에게] 일 요청 #22 발주 접수',
            '[클라우드 확인 #23] 채팅으로 보고함',
            '완료 #24 (대괄호 없음)',
            '[완료] #25',
            '[완료 #26\n다음 줄] 줄이 바뀌면 답이 아님',
        ]:
            self.assertEqual(ids(self.re, body), set(), body)


if __name__ == '__main__':
    unittest.main()
