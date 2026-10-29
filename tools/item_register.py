#!/usr/bin/env python3
"""히트타일 품목등록 도구 — 품목등록담당(.claude/agents/item-register.md)이 쓰는 명령줄 도구.

업무용 사이트 메인 Apps Script 웹앱을 그대로 호출한다(품목등록 페이지 "직접 입력"과 같은 action).
등록 전에 항상 이카운트 실제 품목 목록과 대조해서, 이미 있는 품목이거나 새 코드가 이카운트의 기존
코드와 겹치면(= 기존 품목을 덮어쓰게 되면) 등록하지 않는다.

  python3 tools/item_register.py search 이비자 IBIZA          # 품목등록마스터 + 이카운트에서 찾기
  python3 tools/item_register.py vendors 베리굿                # 거래처 정확한 이름 찾기
  python3 tools/item_register.py add --vendor "블루밍" --name "비엔트-와이드 주방원홀" \\
      --spec GB-3000 --unit EA --price 25000 --margin 1.4    # 미리보기만 (저장 안 함)
  python3 tools/item_register.py add ... --yes                 # 실제 등록
  python3 tools/item_register.py rename VG00034 "타일IBIZA BEIGE 600*600 (이비자 베이지)" --yes

--price 는 입고단가(부가세 포함)다. 부가세 별도 금액이면 --price-ex-vat 로 넣으면 1.1배 해서 넣는다.
"""
import argparse
import json
import re
import sys
import urllib.request

ENDPOINT = ('https://script.google.com/macros/s/'
            'AKfycbzx_vaUy7Ar1mqidKErG2WYcwNZpL6FGsfI8JNR0nILnSW9hf4bJ_N8aJmDM8J0DOKWwQ/exec')
SHEET_URL = 'https://docs.google.com/spreadsheets/d/1XBzkR5oVC1kmRkT270FnbIm_IdRzzumpB48TGorKJSM/edit'
ECOUNT_URL = 'https://loginbb.ecount.com'


def call(payload, timeout=200):
    req = urllib.request.Request(ENDPOINT, data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                                 headers={'Content-Type': 'text/plain;charset=utf-8'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode('utf-8'))


def master_items():
    return call({'action': 'list_item_master'}).get('items', [])


def ecount_items():
    data = call({'action': 'debug_ecount_items'})
    if not data.get('ok'):
        sys.exit('이카운트 품목 조회 실패: ' + str(data.get('error')))
    return data.get('items', [])


def norm(s):
    return re.sub(r'[\s\-_*×x()\[\]]', '', str(s or '')).upper()


def cmd_search(args):
    words = [norm(w) for w in args.words]
    hit = lambda text: any(w in norm(text) for w in words)
    print('== 품목등록마스터')
    for x in master_items():
        if hit(x['name'] + x['spec'] + x['code']):
            print(f"  {x['code']:<14} {x['name']} [{x['spec']}] 거래처={x['vendor'] or '-'} 단위={x['unit']} 출고={x['outPrice']}")
    print('== 이카운트')
    for x in ecount_items():
        if hit(x['prodDes'] + x['spec'] + x['prodCd']):
            print(f"  {x['prodCd']:<14} {x['prodDes']} [{x['spec']}] 단위={x['unit']} 입고={x['inPrice']}(VAT{'포함' if x['inPriceVat'] == '1' else '별도'}) 출고={x['outPrice']}")


def cmd_vendors(args):
    names = call({'action': 'list_vendor_names'}).get('names', [])
    for n in names:
        if not args.words or any(norm(w) in norm(n) for w in args.words):
            print(n)


def cmd_add(args):
    price = args.price if args.price is not None else round(args.price_ex_vat * 1.1)
    body = {'action': 'item_manual_add', 'vendorName': args.vendor, 'name': args.name, 'spec': args.spec or '',
            'unit': args.unit or 'EA', 'price': price}
    if args.out_price is not None:
        body['outPrice'] = args.out_price
    if args.margin is not None:
        body['margin'] = args.margin
    if args.prefix:
        body['prefix'] = args.prefix
    if args.business_no:
        body['businessNo'] = args.business_no
    if args.force:
        body['force'] = True

    preview = call(dict(body, dryRun=True))
    if preview.get('needsPrefix'):
        sys.exit(f"신규 거래처입니다: {args.vendor}. --prefix(영문 2~4자, 안 쓰는 것)와 가능하면 --business-no를 넣어 다시 실행하세요.")
    if preview.get('duplicate'):
        sys.exit(f"이미 같은 품목이 있습니다: {preview.get('matchedCode')} {preview.get('matchedName')} — 새로 만들지 말고 기존 품목을 쓰세요(정말 새 코드가 필요하면 --force).")
    if not preview.get('ok'):
        sys.exit('미리보기 실패: ' + json.dumps(preview, ensure_ascii=False))

    code = preview.get('code')
    ecodes = {x['prodCd'] for x in ecount_items()}
    if code in ecodes:
        m = re.match(r'^(\D+)(\d+)$', code)
        top = max((int(c[len(m.group(1)):]) for c in ecodes if c.startswith(m.group(1)) and c[len(m.group(1)):].isdigit()), default=0) if m else 0
        sys.exit(f"중단: 새 코드 {code}가 이카운트에 이미 있습니다(그대로 등록하면 기존 품목을 덮어씀).\n"
                 f"거래처코드관리 탭에서 이 거래처 줄 C열을 {top}(으)로 고쳐 달라고 요청하세요: {SHEET_URL}")

    row = preview.get('row', {})
    print(f"코드 {code} | {row.get('name')} [{row.get('spec')}] | 거래처 {preview.get('vendorName')}"
          f"{' (신규 거래처)' if preview.get('willCreateVendor') else ''} | 단위 {row.get('unit')}"
          f" | 입고 {row.get('inPrice'):,} | 출고 {row.get('outPrice'):,} ({preview.get('marginLabel')} {preview.get('margin')})")
    if not args.yes:
        print('(미리보기만 했습니다. 등록하려면 --yes)')
        return
    done = call(body)
    print(json.dumps(done, ensure_ascii=False))


def cmd_rename(args):
    if not args.yes:
        print(f"{args.code} → {args.name} (미리보기. 바꾸려면 --yes)")
        return
    print(json.dumps(call({'action': 'korean_name_set', 'items': [{'code': args.code, 'name': args.name}]}), ensure_ascii=False))


def main():
    p = argparse.ArgumentParser(description='히트타일 품목등록 도구')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('search'); s.add_argument('words', nargs='+'); s.set_defaults(fn=cmd_search)
    v = sub.add_parser('vendors'); v.add_argument('words', nargs='*'); v.set_defaults(fn=cmd_vendors)
    a = sub.add_parser('add')
    a.add_argument('--vendor', required=True)
    a.add_argument('--name', required=True)
    a.add_argument('--spec', default='')
    a.add_argument('--unit', default='EA')
    g = a.add_mutually_exclusive_group(required=True)
    g.add_argument('--price', type=float, help='입고단가 (부가세 포함)')
    g.add_argument('--price-ex-vat', type=float, help='입고단가 (부가세 별도) — 1.1배 해서 넣음')
    a.add_argument('--out-price', type=float, help='출고단가 (부가세 포함). 없으면 마진으로 계산')
    a.add_argument('--margin', type=float, choices=[1.2, 1.4, 1.5])
    a.add_argument('--prefix', help='신규 거래처일 때 코드 접두어 (영문 2~4자)')
    a.add_argument('--business-no')
    a.add_argument('--force', action='store_true')
    a.add_argument('--yes', action='store_true')
    a.set_defaults(fn=cmd_add)
    r = sub.add_parser('rename'); r.add_argument('code'); r.add_argument('name'); r.add_argument('--yes', action='store_true'); r.set_defaults(fn=cmd_rename)
    args = p.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
