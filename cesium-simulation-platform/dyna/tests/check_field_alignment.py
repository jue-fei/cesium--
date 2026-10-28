# -*- coding: utf-8 -*-
"""字段对齐测试（P0-5 防"白转换"回归）—— §10.4 验收项之一

规则（镜像前端 v3BuildFieldSpec + v3SelectCase 的字段列表逻辑）：
  A = 容器 frames.header.fields 中 role != 'mask' 的字段 id 集合（后端实际产出）
  B_direct  = field_spec.json 中 render.show != false 且可渲染（非 element 层）的字段 id
  sources   = 这些字段里带 source 的派生量的 source（如 vm/s1/s3 的 source = stress）
  可显示集   = B_direct ∪ sources
  断言：A ⊆ 可显示集（否则 A - 可显示 即 E010 —— 数据在容器里但前端看不见）

用法：python 工作区/tests/check_field_alignment.py   （从仓库根或任意目录均可）
退出码：0 = 通过；1 = 存在 E010（并列出差集）
"""
import json, os, struct, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))      # 工作区
SPEC = os.path.join(ROOT, 'config', 'field_spec.json')
DATA = os.path.join(ROOT, 'webapp', 'data_v3')


def spec_displayable():
    d = json.load(open(SPEC, encoding='utf-8'))
    fields = d['fields']
    b_direct, sources = set(), set()
    for fid, fd in fields.items():
        r = fd.get('render') or {}
        if r.get('show') is False:
            # 派生量即便本身 show:false 也按其 source 计入
            if fd.get('source'):
                sources.add(fd['source'])
            continue
        st = fd.get('store')
        if st and st.get('location') == 'element' and not r.get('derived_ok'):
            continue                                   # element 层 1c 前不可渲染（镜像前端 gate）
        b_direct.add(fid)
        if fd.get('source'):
            sources.add(fd['source'])
    return b_direct, sources


def container_field_ids(path):
    with open(path, 'rb') as f:
        magic = f.read(5)
        ln = struct.unpack('<I', f.read(4))[0]
        hb = json.loads(f.read(ln).decode('utf-8'))
    return [x['id'] for x in hb.get('fields', []) if x.get('role') == 'field']


def main():
    b_direct, sources = spec_displayable()
    displayable = b_direct | sources
    print(f'field_spec 可显示集 ({len(displayable)}): {sorted(displayable)}')
    bad = 0
    for p in sorted(glob.glob(os.path.join(DATA, '*.frames.bin'))):
        key = os.path.basename(p).split('.')[0]
        a = set(container_field_ids(p))
        missing = sorted(a - displayable)
        status = 'OK' if not missing else 'E010'
        print(f'  [{status}] {key}: A={sorted(a)}'
              + (f'  差集(A-可显示)={missing}' if missing else ''))
        if missing:
            bad += 1
    if bad:
        print(f'\nE010 字段注册表不一致：{bad} 个容器存在"后端产出但前端不可显示"的字段 → CI 阻断')
        return 1
    print('\n通过：所有容器的产出字段均可被前端显示（无 E010）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
