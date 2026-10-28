# -*- coding: utf-8 -*-
"""dyna2web.py —— 通用 LS-DYNA d3plot → Web 数据转换器

阶段：
  --stage probe （第 1~2 步，本文件当前实现）
      文件枚举(含 MPP 识别) → 头部探测 → 版本规范化 → 逐文件尾部策略
      → 布局候选 + 三重校验(整除 / 时间递增 / 坐标指纹) → part 自动分类
      → 单位制交叉校验 → 写出 {key}.probe.json（不写容器、不改前端）
  --stage all   （第 3 步及以后：写自描述容器）

设计约束（见 .trae/documents/通用转换器与一比一适配方案.md）：
  - 不写死任何"算例数字"；头部字段位置属 d3plot 格式常量，值全部自动读取
  - 多文件序列按进位排序；MPP(d3plot.01/.02) 检测到即报错降级
  - 尾部长度独立剥离并做交叉校验
  - 布局候选优先查 config/layouts.json（精确键 → 前缀通配），未命中按头部标志位生成
  - part 角色按 .k 的 *PART/*SECTION/*MAT 判定；无 .k 退化到启发式并记录依据
  - 单位制：ENDTIM 比对 + 量级/波速一致性，输出【依据 + 置信度】，不做错误估算
"""
import argparse
import itertools
import json
import os
import re
import struct
import sys
import time
import numpy as np
try:
    import zstandard as _zstd          # 第 7 步 ④：每帧独立 zstd 压缩块
except Exception:
    _zstd = None

ROOT = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(ROOT, 'config')
REPORTS = os.path.join(ROOT, 'reports')
WEB_DATA = os.path.join(ROOT, 'webapp', 'data')

# ---------------------------------------------------------------- 头部字段位置
# 以下索引是 LS-DYNA d3plot 头部格式常量（按文件字长计数的"字"位置），
# 与具体算例无关；值一律从文件读出，不写死。
HDR_IDX = dict(ndim=15, numnp=16, icode=17, nglbv=18, it=19, iu=20, iv=21, ia=22,
               nel8=23, nummat8=24, nv3d=27, neiph=34, maxint=36, nmsph=37)
# 这些位置在不同版本/求解器下有差异，仅作提示字段，不参与 stride
HDR_HINT = dict(nel3=28, nel4=29, nel2=30, nel4s=31,
                nv3d_beam=32, nv3d_shell=33)

SUF36 = "0123456789abcdefghijklmnopqrstuvwxyz"
MAT_ROLE = {
    'MAT_JOHNSON_HOLMQUIST_CERAMICS': 'structure',
    'MAT_JOHNSON_COOK': 'structure',
    'MAT_PLASTIC_KINEMATIC': 'structure',
    'MAT_PLASTICITY_WITH_DAMAGE': 'structure',
    'MAT_RHT': 'structure',
    'MAT_ELASTIC': 'structure',
    'MAT_RIGID': 'structure',
    'MAT_ORTHOTROPIC': 'structure',
    'MAT_NULL': 'air',
    'MAT_HIGH_EXPLOSIVE_BURN': 'explosive',
    'MAT_ELASTIC_PLASTIC_HYDRO': 'structure',
}
SEC_KIND = {'SECTION_SOLID': 'solid', 'SECTION_SOLID_ALE': 'solid',
            'SECTION_SHELL': 'shell', 'SECTION_BEAM': 'beam', 'SECTION_SPH': 'sph'}


# ================================================================ 1 文件枚举
def _sufval(s):
    v = 0
    for ch in s:
        i = SUF36.find(ch.lower())
        if i < 0:
            return None
        v = v * 36 + i
    return v


def enumerate_d3plot_files(ddir):
    """按 LS-DYNA 进位规则排序 d3plot 序列；返回 (base|None, [(path,kind)], mpp)
    命名规则（实测）：d3plot → d3plot01..d3plot99 → d3plot100,d3plot101... （三位十进制）
                    ；另有 d3plota0..d3plotzz 形式（两位 base36）作为兜底
    """
    names = [n for n in os.listdir(ddir)]
    mpp = sorted([n for n in names if re.fullmatch(r'd3plot\.\d+', n)],
                 key=lambda x: int(x.split('.')[-1]))
    if mpp:
        return None, [(os.path.join(ddir, n), 'mpp') for n in mpp], True
    base = os.path.join(ddir, 'd3plot')
    if not os.path.exists(base):
        raise SystemExit(f'错误: 目录里没有 d3plot: {ddir}')
    seq = []
    for n in names:
        m = re.fullmatch(r'd3plot(\d{1,4})', n)
        if m:                                   # 十进制序号（含 100+ 的三/四位）
            seq.append(((0, int(m.group(1))), os.path.join(ddir, n), n))
            continue
        m = re.fullmatch(r'd3plot([0-9a-zA-Z]{2})', n)
        if m:                                   # base36 两位（a0..zz）
            v = _sufval(m.group(1))
            if v is not None:
                seq.append(((1, v), os.path.join(ddir, n), n))
    seq.sort(key=lambda x: x[0])
    return base, [(base, 'base')] + [(p, 'seq') for _, p, _ in seq], False


# ================================================================ 2 头部探测
def read_words(path, ws, n, off=0, endian='<'):
    dt = endian + ('f8' if ws == 8 else 'f4')
    with open(path, 'rb') as f:
        f.seek(off * ws)
        return np.frombuffer(f.read(n * ws), dtype=dt)


def _read_title(base):
    """d3plot 头部前 80 字节为算例标题（可能含不可打印字符）"""
    try:
        with open(base, 'rb') as f:
            raw = f.read(80)
        s = ''.join(chr(c) if 32 <= c < 127 else ' ' for c in raw).strip()
        return s or None
    except OSError:
        return None


def probe_header(base):
    """自动判字长并读取头部；返回 dict（含 raw 前 64 字，便于人工核对）"""
    for ws in (8, 4):
        w = read_words(base, ws, 64)
        if len(w) < 64:
            continue
        i = np.frombuffer(w.tobytes(), dtype='<i8' if ws == 8 else '<i4')
        h = {k: int(i[v]) for k, v in HDR_IDX.items()}
        h['ws'] = ws
        h['raw'] = [int(x) for x in i[:64]]
        h['hint'] = {k: (int(i[v]) if len(i) > v else None)
                     for k, v in HDR_HINT.items()}
        if (0 < h['numnp'] < 5e7 and 0 < h['nel8'] < 5e7 and 0 <= h['nglbv'] < 1e4
                and 0 < h['nv3d'] < 1e4 and 0 <= h['nmsph'] < 5e7):
            h['title'] = _read_title(base)
            return h
    # P4-15：大端探测（仅检测 + 明确报错，不做支持）
    for ws in (8, 4):
        w = read_words(base, ws, 64, endian='>')
        if len(w) < 64:
            continue
        i = np.frombuffer(w.tobytes(), dtype='>i8' if ws == 8 else '>i4')
        if (0 < int(i[HDR_IDX['numnp']]) < 5e7
                and 0 < int(i[HDR_IDX['nel8']]) < 5e7
                and 0 < int(i[HDR_IDX['nv3d']]) < 1e4):
            raise SystemExit('错误: 检测到大端字节序 d3plot（暂不支持，请先转为小端）')
    raise SystemExit('错误: 头部解析失败(既非 8 字节也非 4 字节字布局)')


def read_version(base):
    with open(base, 'rb') as f:
        b = f.read(1024)
    txt = ''.join(chr(c) if 32 <= c < 127 else ' ' for c in b)
    m = re.search(r'(LS-?DYNA[^R]{0,24}?R\s?\d+(?:\.\d+)?)', txt, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r'R\s?(\d+(?:\.\d+)?)', txt)
    return m.group(0).strip() if m else '(未识别)'


def normalize_version(raw):
    """规范化到两级 'r11.1'；只有主版本时补 .0；无法识别返回 '*'"""
    m = re.search(r'R\s?(\d+)(?:\.(\d+))?', raw, re.I)
    if not m:
        return '*', None
    major, minor = m.group(1), m.group(2)
    norm = f'r{major}.{minor if minor is not None else 0}'
    return norm, f'r{major}'


def detect_solver(files, mpp):
    return 'mpp' if mpp else 'smp'


# ================================================================ 3 .k 解析
KW_RE = re.compile(r'^\*([A-Z_0-9]+)')


def split_k_fields(s):
    """数据行字段拆分：LS-DYNA 定宽格式（LS-PrePost 与 ANSYS WB 都按 10 字符列右对齐写出）。
    一个字段恰好占满 10 列时，下一字段前面没有空格 → 空白拆分会把两个数粘成一个
    （实测 tnt/1 非 TITLE 卡片：MID=4 与 RO=1.63E-6 粘成 41.63000E-6，
     解析成 RO=4.163e-5，偏大 25 倍，直接污染单位制材料锚点）。
    规则：先按 10 字符切 4 列，**全部可解析为数值**才采用（自由格式行会切出非数值片段 → 自动回退空白拆分）。"""
    cols = [s[i:i + 10].strip() for i in range(0, min(len(s), 40), 10)]
    if len(cols) >= 2:
        for c in cols:
            if not c:
                continue
            try:
                float(c)
            except ValueError:
                break
        else:
            return cols
    return s.split()


# ---------------------------------------------------------------- 3b .k 编码 + *INCLUDE（P4-1/P4-2）
_INC_ENC = ('utf-8-sig', 'utf-8', 'gbk', 'latin-1')


def _read_k_text(path):
    """按 utf-8-sig → utf-8 → gbk → latin-1 依次尝试解码；返回 (text, encoding)。
    原先的 open(..., errors='ignore') 会**静默吞掉中文标题**（P4-2），这里改为显式探测。"""
    for enc in _INC_ENC:
        try:
            with open(path, 'r', encoding=enc) as f:
                return f.read(), enc
        except (UnicodeDecodeError, LookupError):
            continue
    with open(path, 'r', encoding='latin-1') as f:      # 兜底：latin-1 永不失败
        return f.read(), 'latin-1'


INC_RE = re.compile(r'^\*INCLUDE\b(.*)$', re.I)
INCPATH_RE = re.compile(r'^\*INCLUDE_PATH\b(.*)$', re.I)
_INC_MAX_DEPTH = 16


def _inc_add_dirs(s, base_dir, search):
    """把 INCLUDE_PATH 的目录列表追加到搜索路径"""
    for d in re.split(r'[,\s]+', s):
        d = d.strip().strip('"').strip("'")
        if not d:
            continue
        for b in [base_dir] + search:
            cand = d if os.path.isabs(d) else os.path.join(b, d)
            if os.path.isdir(cand):
                search.append(os.path.abspath(cand))
                break


def _inc_resolve(fn, base_dir, search):
    cands = ([fn] if os.path.isabs(fn) else [os.path.join(b, fn)
             for b in [base_dir] + search])
    return next((c for c in cands if os.path.exists(c)), None)


def iter_k_lines(path, include_paths=None, _stack=None, _depth=0, _files=None):
    """按 LS-DYNA 语义展开 *INCLUDE / *INCLUDE_PATH，逐行 yield (line, src_path)。
    - 支持"文件名同行"与"关键字换行后再写文件名"两种写法；
    - 相对路径基于**当前文件所在目录**；*INCLUDE_PATH 追加搜索目录（对后续 include 生效）；
    - os.path.realpath 集合做**循环引用检测**（命中即报错并给出引用链）；递归深度上限 16。
    - `_files`（可变 list）收集展开过的文件 realpath，供报告记录。"""
    stack = _stack or []
    rp = os.path.realpath(path)
    if rp in stack:
        raise SystemExit('[*INCLUDE] 循环引用: ' + ' -> '.join(stack + [rp]))
    if _depth > _INC_MAX_DEPTH:
        raise SystemExit(f'[*INCLUDE] 递归深度超过 {_INC_MAX_DEPTH}')
    if _files is not None:
        _files.append(rp)
    text, _enc = _read_k_text(path)
    base_dir = os.path.dirname(os.path.abspath(path))
    search = list(include_paths or [])
    pending = None                                  # None | 'include' | 'incpath'
    for raw in text.splitlines():
        st = raw.strip()
        if not st or st.startswith('$'):
            yield raw, path
            continue
        if pending == 'include':
            pending = None
            fn = st.strip().strip('"').strip("'")
            found = _inc_resolve(fn, base_dir, search)
            if not found:
                raise SystemExit(f'[*INCLUDE] 找不到包含文件: {fn}（引用自 {path}）')
            yield from iter_k_lines(found, search, stack + [rp], _depth + 1, _files)
            continue
        if pending == 'incpath':
            pending = None
            _inc_add_dirs(st, base_dir, search)
            yield raw, path
            continue
        m_ip = INCPATH_RE.match(st)
        if m_ip:
            rest = m_ip.group(1).strip()
            if rest:
                _inc_add_dirs(rest, base_dir, search)
            else:
                pending = 'incpath'
            yield raw, path
            continue
        m = INC_RE.match(st)
        if m:
            rest = m.group(1).strip().strip('"').strip("'")
            if not rest:
                pending = 'include'
                yield raw, path
                continue
            found = _inc_resolve(rest, base_dir, search)
            if not found:
                raise SystemExit(f'[*INCLUDE] 找不到包含文件: {rest}（引用自 {path}）')
            yield from iter_k_lines(found, search, stack + [rp], _depth + 1, _files)
            continue
        yield raw, path


def k_encoding(path):
    """主 .k 文件实际使用的编码（报告用）"""
    return _read_k_text(path)[1] if path and os.path.exists(path) else None


def expand_k_parameters(lines):
    """P4-3：*PARAMETER 数值展开（name=value / name, value / name value），
    并将后续行中的 &name 替换为数值；表达式/单位不处理（保留原样）。
    lines: [(line, src), ...] -> 同结构的新列表"""
    params = {}
    i, n = 0, len(lines)
    while i < n:
        s = lines[i][0].strip()
        if re.match(r'^\*PARAMETER\b', s, re.I):
            i += 1
            while i < n and not lines[i][0].lstrip().startswith('*'):
                t = lines[i][0].strip()
                if t and not t.startswith('$'):
                    m = re.match(r'([A-Za-z_]\w*)\s*(?:[=,]|\s)\s*'
                                 r'([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)', t)
                    if m:
                        params[m.group(1)] = m.group(2)
                i += 1
            continue
        i += 1
    if not params:
        return lines
    pat = re.compile(r'&([A-Za-z_]\w*)')
    return [(pat.sub(lambda m: params.get(m.group(1), m.group(0)), line), src)
            for line, src in lines]


def parse_k(path, need_counts=True):
    """流式单遍解析 .k：part/材料/截面/起爆点/终止时间/SPH·PBM 计数"""
    out = dict(parts=[], sections={}, materials={}, deto=[], endtim=None,
               dt_init=None, counts={}, addons={}, mat_cards=[], kw_lines=0)
    if not path or not os.path.exists(path):
        return out
    state = None
    cnt = 0
    title = ''
    # *ELEMENT_SOLID 两行卡：暂存 pid
    _pend = [None]
    # P4-1/P4-2：*INCLUDE 递归展开 + 编码自适应，用生成器逐行喂给下面的解析循环
    _inc_files = []
    out['encoding'] = _read_k_text(path)[1]
    _lines = expand_k_parameters(list(iter_k_lines(path, _files=_inc_files)))
    for _ in (0,):                                          # 占位外层：保持内层原缩进（避免大段重排）
        for line, _src in _lines:
            if line[:1] == '*':
                m = KW_RE.match(line.strip().upper())
                state = m.group(1) if m else None
                out['kw_lines'] += 1
                cnt = 0
                _pend[0] = None
                if state == 'PART':
                    title = ''                               # 每张 *PART 重置标题（有的卡无标题行）
                if state and state.startswith('MAT_') and not state.startswith('MAT_ADD_'):
                    # 每张 *MAT_* 卡片只登记一次（数据行有多行，不能重复登记）
                    out['mat_cards'].append(
                        state[:-6] if state.endswith('_TITLE') else state)
                continue
            if not line.strip() or line.lstrip().startswith('$'):
                continue
            s = line[:80]
            cnt += 1
            try:
                if state == 'PART':
                    v = s.split()
                    if cnt == 1 and v and not v[0].lstrip('-').isdigit():
                        title = s.strip()                       # 标题行（可选：有的 *PART 无标题）
                        continue
                    if v and v[0].lstrip('-').isdigit() and len(v) >= 3:
                        out['parts'].append(dict(pid=int(v[0]), secid=int(v[1]),
                                                 mid=int(v[2]),
                                                 eosid=int(v[3]) if len(
                                                     v) > 3 else 0,
                                                 title=title))
                elif state and state.startswith('SECTION_'):
                    v = s.split()
                    sid = int(v[0])
                    elform = int(v[1]) if len(
                        v) > 1 and v[1].lstrip('-').isdigit() else 0
                    thick = None
                    if state == 'SECTION_SHELL' and len(v) > 3:
                        try:
                            thick = float(v[3])
                        except ValueError:
                            thick = None
                    out['sections'][sid] = dict(kind=SEC_KIND.get(state, state.lower()),
                                                elform=elform, thickness=thick)
                elif state and state.startswith('MAT_'):
                    # 附加卡片(如 *MAT_ADD_EROSION)不是本构,
                    if state.startswith('MAT_ADD_'):
                        out['addons'][state] = out['addons'].get(state, 0) + 1
                    else:
                        is_title = state.endswith('_TITLE')
                        kw = state[:-6] if is_title else state
                        v = split_k_fields(s) if cnt <= 6 else []
                        if v and v[0].lstrip('-').isdigit() and not is_title:
                            out.setdefault('materials_explicit', {})[
                                int(v[0])] = kw
                        # 数据行是否带 mid 由**内容**判定（首列是整数 ⇒ 带 mid），不靠 *_TITLE 后缀：
                        # LS-PrePost 的 TITLE 输出把标题写在关键字后单独一行，数据行**仍带 mid**
                        # （实测 tnt/1：*MAT_CONCRETE_DAMAGE_REL3_TITLE 数据行首列 = 1 = mid，与 *PART 的 mid 一致；
                        #  若首列是带小数点/指数的实数（如 1.63E-6）才算"无 mid、首列即 RO"）。
                        if cnt == (2 if is_title else 1):
                            vals = []
                            for x in v:
                                try:
                                    vals.append(float(x))
                                except ValueError:
                                    vals.append(None)
                            off = 1 if (v and v[0].lstrip(
                                '-').isdigit()) else 0
                            rec = dict(kw=kw, ro=(vals[off] if len(vals) > off else None),
                                       vals=vals[:12], off=off)
                            if kw == 'MAT_HIGH_EXPLOSIVE_BURN':
                                rec['d'] = vals[off +
                                                1] if len(vals) > off + 1 else None
                                rec['pcj'] = vals[off +
                                                  2] if len(vals) > off + 2 else None
                            out.setdefault('mat_records', []).append(rec)
                elif state == 'INITIAL_DETONATION':
                    v = s.split()
                    out['deto'].append(dict(pid=int(v[0]), x=float(v[1]), y=float(v[2]),
                                            z=float(v[3]) if len(
                                                v) > 3 else 0.0,
                                            lt=float(v[4]) if len(v) > 4 else 0.0))
                elif state == 'CONTROL_TERMINATION':
                    v = s.split()
                    if out['endtim'] is None and v:
                        out['endtim'] = float(v[0])
                elif state == 'CONTROL_TIMESTEP':
                    v = s.split()
                    if out['dt_init'] is None and len(v) >= 3:
                        try:
                            out['dt_init'] = float(v[2])
                        except ValueError:
                            pass
                elif state in ('ELEMENT_SPH', 'ELEMENT_DISCRETE', 'ELEMENT_MASS'):
                    out['counts']['sph'] = out['counts'].get('sph', 0) + 1
                elif state == 'NODE':
                    # P0-1：收集 .k 节点编号（判连续性）
                    v = s.split()
                    if v:
                        try:
                            nid = int(v[0])
                            out.setdefault('_k_nodes', []).append(nid)
                            if len(v) >= 4:                    # 节点坐标（part 几何对齐用）
                                out.setdefault('_k_node_xyz', {})[nid] = (
                                    float(v[1]), float(v[2]), float(v[3]))
                        except ValueError:
                            pass
                elif state.startswith('ELEMENT'):
                    # P0-1：收集 .k 单元编号
                    v0 = s.split(None, 1)
                    if v0:
                        try:
                            out.setdefault('_k_elems', []).append(int(v0[0]))
                        except ValueError:
                            pass
                    if state == 'ELEMENT_SOLID':                # P0-1：实体的节点编号（与 d3plot 连接表逐位对齐用）
                        # *ELEMENT_SOLID 两种卡格式（实测）：
                        #   ① 单行 `eid pid n1..n8`（tnt_1/smooth/presplit/sph1/sph2）
                        #   ② 两行 `eid pid` + 下一行 `n1..n8`（airblast / ANSYS Workbench 导出）
                        v = s.split()
                        try:
                            if len(v) >= 9:
                                out.setdefault('_k_elem_pids', []
                                               ).append(int(v[1]))
                                out.setdefault('_k_solid_nodes', []).append(
                                    [int(x) for x in v[2:10]])
                                _pend[0] = None
                            elif len(v) == 2:
                                _pend[0] = int(v[1])
                            elif len(v) >= 8 and _pend[0] is not None:
                                out.setdefault('_k_elem_pids', []
                                               ).append(_pend[0])
                                out.setdefault('_k_solid_nodes', []).append(
                                    [int(x) for x in v[:8]])
                                _pend[0] = None
                        except ValueError:
                            _pend[0] = None
                elif state == 'INITIAL_VELOCITY_GENERATION':
                    pass
            except (ValueError, IndexError):
                continue
    # include 展开记录（第 1 项是主 .k 自身）：供报告审计
    out['include_files'] = [os.path.basename(p) for p in _inc_files[1:]]
    # P0-1：保留 .k 的完整编号集合（供 narbs 滑动搜索）+ 是否恰为连续 1..N
    _kn = out.pop('_k_nodes', None)
    _ke = out.pop('_k_elems', None)
    out['k_node_ids'] = (sorted(set(int(x) for x in _kn)) if _kn else None)
    out['k_elem_ids'] = (sorted(set(int(x) for x in _ke)) if _ke else None)
    out['k_solid_nodes'] = out.pop('_k_solid_nodes', None)
    # 与 k_solid_nodes 同序：每单元的 *PART pid
    out['k_elem_pids'] = out.pop('_k_elem_pids', None)
    # 节点 id → (x,y,z)，供 part 几何对齐
    out['k_node_xyz'] = out.pop('_k_node_xyz', None)
    _conts = [c for c in (_ids_contiguous(out['k_node_ids']),
                          _ids_contiguous(out['k_elem_ids'])) if c is not None]
    out['k_contiguous'] = (all(_conts) if _conts else None)
    # 材料 id 回填：这些 .k 用 *_TITLE 形式，卡片本身不带 mid（只有 title + 数据），
    # 此时按"*MAT_* 卡片的出现顺序"对应 mid = 1,2,3...（LS-DYNA TITLE 输出格式的约定），
    # 已被显式 mid 覆盖的以显式值为准。回填方式写进报告，便于人工核对。
    out['materials'] = dict(out.get('materials_explicit', {}))
    filled = 0
    for i, kw in enumerate(out['mat_cards'], start=1):
        if i not in out['materials']:
            out['materials'][i] = kw
            filled += 1
    out['material_id_method'] = ('explicit' if not filled else
                                 ('order-fill' if out.get('materials_explicit')
                                  else 'order-only'))
    out.pop('materials_explicit', None)
    # 材料参数(RO/D/PCJ)按同一 id 规则挂到 mid 上，供单位制交叉核对
    props = {}
    for i, rec in enumerate(out.get('mat_records', []), start=1):
        props[i] = rec
    out['mat_props'] = props
    return out


def find_k_file(ddir):
    cands = [os.path.join(ddir, n)
             for n in os.listdir(ddir) if n.lower().endswith('.k')]
    cands = [c for c in cands if os.path.getsize(c) > 0]
    if not cands:
        return None
    cands.sort(key=lambda p: -os.path.getsize(p))
    return cands[0]


# ================================================================ 4 布局探测
def build_candidates(h, kc, layouts, files=None):
    """候选布局列表：① 头部公式推导 ② 文件尺寸反推（兜底，防头部字段误读）"""
    n, nel = h['numnp'], h['nel8']
    nglbv, nv3d = h['nglbv'], h['nv3d']
    iu, ia = int(bool(h['iu'])), int(bool(h['ia']))
    n_sph = h.get('nmsph') or 0
    if n_sph == 0:
        n_sph = kc.get('counts', {}).get('sph', 0)
    n_pbm = kc.get('counts', {}).get('pbm', 0)
    cands = []
    # 基础块（本项目实测：坐标/速度/加速度三块恒为 3N，即使 iu/ia 为 0）
    base9 = 1 + nglbv + 9 * n
    basef = 1 + nglbv + 3 * n * (1 + iu + ia)
    elem = nv3d * nel + nel                       # 实体历史 + part 数组
    for tag, b in (('blocks=3N(实测通用)', base9), ('blocks=(1+iu+ia)*N', basef)):
        for tail in (497, 0):
            s = b + elem + tail
            cands.append(dict(desc=f'FEM/ALE {tag}, tail={tail}, 无粒子',
                              stride=s, tail=tail, n_sph=0, n_pbm=0))
            if n_sph:
                for rec_s in (33, 32, 28, 36):
                    s2 = s + rec_s * n_sph
                    cands.append(dict(desc=f'{tag}, tail={tail}, SPH rec={rec_s}',
                                      stride=s2, tail=tail, n_sph=n_sph, n_pbm=0,
                                      rec_sph=rec_s))
                    if n_pbm:
                        for rec_p in (14, 12, 16):
                            s3 = s2 + rec_p * n_pbm
                            cands.append(dict(desc=f'{tag}, tail={tail}, SPH rec={rec_s}, PBM rec={rec_p}',
                                              stride=s3, tail=tail, n_sph=n_sph,
                                              n_pbm=n_pbm, rec_sph=rec_s, rec_pbm=rec_p))
    # ② 尺寸反推兜底：序列文件的众数尺寸(以及它被 1..4 整除的商) 作为 stride 候选
    if files:
        sizes = {}
        for p, k in files:
            if k != 'seq':
                continue
            w = os.path.getsize(p) // h['ws']
            sizes[w] = sizes.get(w, 0) + 1
        for w, _cnt in sorted(sizes.items(), key=lambda x: -x[1])[:2]:
            for d in (1, 2, 3, 4):
                if w % d == 0:
                    cands.append(dict(desc=f'尺寸反推: 序列文件 {w} 词 / {d} = stride',
                                      stride=w // d, tail=0, n_sph=0, n_pbm=0,
                                      from_size=True))
    return cands


def next_increasing(times):
    return all(times[i] < times[i + 1] for i in range(len(times) - 1)) if len(times) > 1 else True


def scan_states(files, stride, ws, tail, max_per_file=4096):
    """逐文件按 stride 扫状态；时间不合理或不再递增则停在该文件"""
    dt = '<d' if ws == 8 else '<f'
    times, per_file, where = [], [], []
    last = -1.0
    for path, kind in files:
        nw = os.path.getsize(path) // ws
        body = max(0, nw - tail)
        n_state = min(body // stride, max_per_file)
        cnt = 0
        with open(path, 'rb') as f:
            for k in range(n_state):
                f.seek(k * stride * ws)
                t = struct.unpack(dt, f.read(ws))[0]
                if not (0.0 <= t < 1e7) or t <= last:
                    break
                last = t
                times.append(t)
                where.append((path, k * stride))
                cnt += 1
        per_file.append(dict(file=os.path.basename(path), kind=kind, words=nw,
                             states=cnt, body=body))
    return times, per_file, where


def fingerprint(base, files, ws, h, cand):
    """坐标指纹：用第一个可用状态坐标块反查基文件坐标起点（附带中间点二次校验）"""
    n3 = 3 * h['numnp']
    nref = min(n3, 3000)
    seq = [p for p, k in files if k == 'seq'] or [base]
    state_path = seq[0]
    off_words = 1 + h['nglbv']
    try:
        sco = read_words(state_path, ws, nref, off_words)
    except Exception:
        return None, '读状态坐标失败'
    if sco.size < 6:
        return None, '状态坐标样本过短'
    tol = 1e-3 if ws == 4 else 1e-6
    mid = min(nref - 1, n3 // 2)
    bw = read_words(base, ws, min(6000 + nref, 3 * n3 + 6000))
    for c in range(40, min(6000, max(0, bw.size - nref))):
        if not np.allclose(bw[c:c + 6], sco[:6], rtol=1e-5, atol=tol):
            continue
        if c + mid < bw.size and abs(bw[c + mid] - sco[mid]) <= max(tol, 1e-5 * abs(sco[mid])):
            return c, f'基文件坐标 @ 字 {c}（与 {os.path.basename(state_path)} 状态0 匹配）'
    return None, '未找到坐标匹配'


DIV_TOL_WORDS = 4096        # 允许的"不满一个状态"的尾部残留(实测存在)


def validate_layout(cand, files, base, ws, h):
    """三重校验：整除(仅序列文件) / 时间严格递增 / 坐标指纹。
    基文件含几何区，不参与整除校验；序列文件允许小于 DIV_TOL_WORDS 的尾部残留。"""
    reasons = []
    stride, tail = cand['stride'], cand['tail']
    rems = []
    ok_div = True
    for path, kind in files:
        if kind == 'base':
            continue
        nw = os.path.getsize(path) // ws
        body = nw - tail
        r = (body % stride) if body > 0 else body
        rems.append(int(r))
        if r > DIV_TOL_WORDS:
            ok_div = False
            if len(reasons) < 6:
                reasons.append(f'{os.path.basename(path)}: body%stride={r}')
    times, per_file, where = scan_states(files, stride, ws, tail)
    ok_time = len(times) > 0 and next_increasing(times)
    if len(times) == 0:
        reasons.append('扫不到任何状态')
    elif not next_increasing(times):
        reasons.append('时间非严格递增')
    fp_off, fp_msg = (None, '跳过')
    ok_fp = False
    if ok_div and ok_time:
        fp_off, fp_msg = fingerprint(base, files, ws, h, cand)
        ok_fp = fp_off is not None
        if not ok_fp:
            reasons.append(f'指纹: {fp_msg}')
    return dict(ok_div=ok_div, ok_time=ok_time, ok_fp=ok_fp, reasons=reasons,
                times=times, per_file=per_file, where=where, fp_off=fp_off, fp_msg=fp_msg,
                n_states=len(times), remainders=rems)


def find_layout_entry(layouts, version, prefix, solver):
    """布局库查找：精确键 'r12.0|smp' 优先，再前缀通配 'r12.*|smp'（也覆盖 'r12|smp'）"""
    src = layouts.get('layouts', [])
    exact = f'{version}|{solver}'
    for e in src:
        if e.get('key') == exact:
            return e, 'exact'
    for e in src:
        k = e.get('key', '')
        head, _, slv = k.partition('|')
        if slv != solver:
            continue
        if head.endswith('*'):
            if version.startswith(head[:-1]):
                return e, 'wildcard'
        elif head in (version, prefix or '', f'{version}.0'):
            return e, 'wildcard'
    return None, None


def probe_layout(files, base, ws, h, kc, layouts):
    cands = build_candidates(h, kc, layouts, files)
    tried = []
    best = None
    for c in cands:
        r = validate_layout(c, files, base, ws, h)
        tried.append(dict(desc=c['desc'], stride=c['stride'],
                          ok_div=r['ok_div'], ok_time=r['ok_time'], ok_fp=r['ok_fp'],
                          n_states=r['n_states'], reasons=r['reasons']))
        score = (r['ok_fp'], r['ok_div'], r['ok_time'], r['n_states'])
        if best is None or score > best[0]:
            best = (score, c, r)
        if r['ok_fp'] and r['ok_div'] and r['ok_time']:
            return c, r, tried, True
    return (best[1], best[2], tried, False) if best else (None, None, tried, False)


# ================================================================ 5 part 分类
def read_base_conn(base, ws, coords_off, h):
    dt = '<i8' if ws == 8 else '<i4'
    n = 9 * h['nel8']
    return np.fromfile(base, dtype=dt, count=n,
                       offset=(coords_off + 3 * h['numnp']) * ws).reshape(-1, 9)


def read_base_coords(base, ws, coords_off, h):
    return read_words(base, ws, 3 * h['numnp'], coords_off).reshape(-1, 3).astype(np.float32)


# ---------------------------------------------------------------- 5b 编号真实化（P0-1）
# 实测结论（2026-10-20，勿推翻）：d3plot 基文件里**找不到 narbs 置换块**
# （唯一长度=numnp 的整数列是恒等 [0..N-1]，字 394509）；旧 probe_narbs 的"滑动交集率"
# 搜索为**假阳性**（261293 处仅 6567 唯一值），故已删除该函数。编号来源改为四级判定，
# 见 convert_one 中 k_elem_align → contiguous → internal → fallback。
def _ids_contiguous(ids):
    """ids 去重排序后是否恰为 1..N（返回 True/False/None=未知）"""
    if not ids:
        return None
    try:
        s = sorted(set(int(x) for x in ids))
    except (ValueError, TypeError):
        return None
    return s == list(range(1, len(s) + 1))


def derive_ids_from_deck(conn, k_solid_nodes, numnp, nel):
    """P0-1：由 **d3plot 连接表（内部编号）↔ .k *ELEMENT_SOLID（用户编号）逐位对齐** 反推
    内部→用户 节点编号映射。要求：单元顺序一致、每单元 8 节点顺序一致、结果双射且全覆盖。
    返回 (node_ids_int32, 'k_elem_align') 或 (None, reason)。"""
    if not k_solid_nodes:
        return None, 'no .k solid nodes'
    n = min(int(nel), len(k_solid_nodes))
    if n == 0:
        return None, 'empty'
    mp = np.zeros(int(numnp), np.int64)
    for i in range(n):
        kn = k_solid_nodes[i]
        if len(kn) < 8:
            return None, f'element {i} node count {len(kn)}'
        ci = conn[i][:8]
        for j in range(8):
            idx = int(ci[j]) - 1
            if 0 <= idx < numnp and mp[idx] == 0:
                mp[idx] = int(kn[j])
    miss = int((mp == 0).sum())
    if miss:
        return None, f'未覆盖 {miss}/{numnp}（可能是单元顺序或类型不一致）'
    if np.unique(mp).size != numnp:
        return None, '映射非双射'
    return mp.astype(np.int32), 'k_elem_align'


# ---------------------------------------------------------------- 壳/梁（P2 静态实现，⚠ 布局未验证）
# 连接表字长：每单元 = 节点数 + 1 个 part 号（与实体实测「8 节点 + part = 9 字」同一约定）。
# ⚠ 本机 6 算例均无壳/梁几何，d3plot「元素数据块的顺序与字长」无法本地核对 → 下面用
#   「候选偏移 + 节点索引校验」定位，定不到就明确报告"未提取"，不猜、不静默。
SHELL_CONN_WORDS = 5     # 4 节点 + part
BEAM_CONN_WORDS = 3      # 2 节点 + part


def element_type_counts(ctx, h):
    """壳/梁单元数：优先用 .k 的 section 类型（可靠），无 .k 时退回 header hint（索引未验证，仅提示）。"""
    nel4 = nel2 = 0
    for p in ctx.get('parts', []):
        st = (p.get('sectype') or '').upper()
        ne = int(p.get('elems') or 0)
        if 'SHELL' in st:
            nel4 += ne
        elif 'BEAM' in st:
            nel2 += ne
    if nel4 or nel2:
        return dict(nel4=nel4, nel2=nel2, source='.k section kinds')
    # 无 .k 时退回 header hint；因这些索引未验证，再用对应 nv3d 是否为 0 兜一层（nv3d=0 视为无该类数据）
    hb = h.get('hint', {}) or {}
    nel4 = int(hb.get('nel4') or 0) if int(hb.get('nv3d_shell') or 0) else 0
    nel2 = int(hb.get('nel2') or 0) if int(hb.get('nv3d_beam') or 0) else 0
    return dict(nel4=nel4, nel2=nel2, source='header hint（索引未验证，仅提示；nv3d=0 已置 0）')


def read_element_conn(base, ws, geom_off, h, nel, per_elem, numnp):
    """在几何段（坐标 + 实体连接表之后）尝试定位某类元素（壳/梁）的连接表：
    按候选偏移逐一尝试，并用「节点列落在 [1, numnp]」校验；全不合法 → 返回 (None, None)。"""
    dt = '<i8' if ws == 8 else '<i4'
    solid_end = geom_off + 3 * h['numnp'] + 9 * h['nel8']
    hb = h.get('hint', {}) or {}
    beam_guess = int(hb.get('nel2') or 0) * BEAM_CONN_WORDS
    for off in dict.fromkeys([solid_end + beam_guess, solid_end]):
        if off < 0:
            continue
        try:
            arr = np.fromfile(base, dtype=dt, count=nel * per_elem,
                              offset=off * ws).reshape(nel, per_elem)
        except Exception:
            continue
        if arr.shape[0] != nel:
            continue
        nd = arr[:, :per_elem - 1]
        if nd.min() < 1 or nd.max() > numnp:
            continue
        if per_elem >= 5:                       # 壳：四边形四节点不得重复（防"拓扑错误但索引合法"）
            s = np.sort(nd, axis=1)
            if (s[:, :-1] == s[:, 1:]).any():
                continue
        return arr, f'word {off}'
    return None, None


def _k_node_alignment(kc, coords, numnp):
    """把 d3plot 内部节点序号(0基)映射到 .k 的节点 id。
    ① 坐标指纹（6→3 位取整逐档试，吸收 float32/float64 差异）优先；
    ② 若 .k 节点 id 恰为 1..N 连续（或长度 N 的连续段）→ 用编号偏移。
    返回 (np.int32[numnp] | None, note)。"""
    kids = kc.get('k_node_ids')
    xyz = kc.get('k_node_xyz') or {}
    if coords is not None and xyz and len(coords) >= numnp:
        # 注意：d3plot 坐标是 float32、.k 解析出 float64 → 取整位数太严会假性不命中（实测 6 位仅 9.3%，
        # 4 位 100%）。按 6→5→4→3 逐档试，命中率 ≥95% 即采用。
        for nd in (6, 5, 4, 3):
            by_key = {}
            for nid, p in xyz.items():
                by_key[(round(p[0], nd), round(p[1], nd),
                        round(p[2], nd))] = int(nid)
            out = np.zeros(numnp, np.int32)
            hit = 0
            for i in range(numnp):
                c = coords[i]
                k = by_key.get((round(float(c[0]), nd), round(float(c[1]), nd),
                                round(float(c[2]), nd)))
                if k:
                    out[i] = k
                    hit += 1
            rate = hit / max(1, numnp)
            if rate >= 0.95:
                return out, f'坐标指纹命中 {rate*100:.1f}%（取整 {nd} 位）'
        kids_note = f'需 {nd} 位取整时最佳命中 {rate*100:.1f}%'
    else:
        kids_note = '无坐标表'
    if _ids_contiguous(kids) is True and len(kids) == numnp:
        return np.arange(1, numnp + 1, dtype=np.int32), '连续编号偏移（.k 节点 id 恰为 1..N）'
    if kids and len(kids) == numnp and (max(kids) - min(kids) + 1) == numnp:
        return (np.arange(numnp, dtype=np.int32) + int(min(kids))), \
            f'连续段偏移（.k 节点 id 为长度 N 的连续段，id = i + {int(min(kids)) - 1}）'
    return None, kids_note


def align_parts_to_deck(conn, kc, coords, numnp):
    """把 d3plot 的 part 编号**对齐到 .k 的 `*PART` 编号**（part = 前处理自定义组件）。
    依据（可靠优先）：① d3plot 各 part 元素数 ↔ .k 各 pid 元素数（多重集）；
      ② 元素数并列时，用**节点集合 Jaccard**（需先把 .k 节点 id 对齐到 d3plot 序号）。
    返回 (map{d3plot_pid: k_pid} | None, note, ok)。ok=True 表示对齐成立（map 为 {} 表示本就一致）。"""
    kp, kn = kc.get('k_elem_pids'), kc.get('k_solid_nodes')
    nel = int(conn.shape[0])
    if not kp or not kn or len(kp) != len(kn) or len(kp) != nel:
        return None, (f'.k 单元表缺失或与 d3plot 单元数不一致'
                      f'（{0 if not kp else len(kp)} vs {nel}）'), False
    d_cnt, k_cnt = {}, {}
    for x in conn[:, 8]:
        d_cnt[int(x)] = d_cnt.get(int(x), 0) + 1
    k_elem_of = {}
    for i, p in enumerate(kp):
        p = int(p)
        k_cnt[p] = k_cnt.get(p, 0) + 1
        k_elem_of.setdefault(p, []).append(i)
    cand = {p: [q for q, c in k_cnt.items() if c == n]
            for p, n in d_cnt.items()}
    bad = {p: v for p, v in cand.items() if not v}
    if bad:
        return None, f'd3plot part {sorted(bad)} 在 .k 中没有相同元素数的候选（编号不同源）', False
    tie = {p: v for p, v in cand.items() if len(v) > 1}
    kparts = {p['pid']: p for p in kc.get('parts', [])}
    pick, used, need_nodes, eq_ties = {}, set(), [], []
    for p in sorted(cand):
        v = cand[p]
        if len(v) == 1:
            pick[p] = v[0]
            used.add(v[0])
            continue
        # 并列候选若"标题+材料+截面"完全相同 → 视作等价：按序取**未被占用**的那个（保证单射）
        sigs = {tuple((kparts.get(q, {}) or {}).get(x) for x in ('title', 'mid', 'secid'))
                for q in v}
        if len(sigs) == 1:
            free = [q for q in sorted(v) if q not in used]
            if not free:
                return None, f'part {p} 的等价并列候选已被占用 {sorted(v)}', False
            pick[p] = free[0]
            used.add(free[0])
            eq_ties.append(p)
            continue
        need_nodes.append(p)
    node_map, nm_note = (None, '无并列')
    if need_nodes:                                     # 只有"非同价并列"才需要节点集合裁决
        node_map, nm_note = _k_node_alignment(kc, coords, numnp)
        if node_map is None:
            return None, f'元素数并列 {sorted(need_nodes)} 且节点无法对齐：{nm_note}', False
    k_nodes_of = {}
    for pid, idxs in k_elem_of.items():
        s = set()
        for i in idxs:
            s.update(int(x) for x in kn[i])
        k_nodes_of[pid] = s
    for p in need_nodes:
        v = cand[p]
        dn = set()
        for i in range(nel):
            if int(conn[i, 8]) != p:
                continue
            for nd in conn[i, :8]:
                j = int(nd) - 1
                if 0 <= j < numnp and node_map[j]:
                    dn.add(int(node_map[j]))
        best, bs = None, -1.0
        for q in v:
            kns = k_nodes_of.get(q, set())
            inter, uni = len(dn & kns), len(dn | kns) or 1
            sc = inter / uni
            if sc > bs:
                best, bs = q, sc
        if bs < 0.95:
            return None, f'part {p} 并列候选最高 Jaccard 仅 {bs:.3f}（{nm_note}）', False
        pick[p] = best
    if len(set(pick.values())) != len(pick):
        return None, f'映射非单射：{pick}', False
    ident = all(int(a) == int(b) for a, b in pick.items())
    if ident:
        note = '编号本就与 .k *PART 一致（无需重编号）'
    else:
        how = []
        if eq_ties:
            how.append(f'{len(eq_ties)} 个并列因"标题+材料+截面"相同按序任取')
        if need_nodes:
            how.append(f'{len(need_nodes)} 个并列按节点集合 Jaccard 裁决（{nm_note}）')
        note = ('按元素数对齐 d3plot→.k pid' +
                ('（' + '；'.join(how) + '）' if how else ''))
    return ({} if ident else pick), note, True


def classify_parts(h, kc, mats_count):
    """返回 [{pid, elems, mat, sectype, elform, roles[], basis}]"""
    parts = []
    kparts = {p['pid']: p for p in kc.get('parts', [])}
    for pid, ne in sorted(mats_count.items()):
        p = kparts.get(pid)
        info = dict(pid=pid, elems=int(ne), roles=[], basis='')
        if p:
            kw = kc.get('materials', {}).get(p['mid'], f"MAT_{p['mid']}")
            sec = kc.get('sections', {}).get(p['secid'], {})
            info.update(mat=kw, sectype=sec.get('kind', '?'), elform=sec.get('elform'),
                        thickness=sec.get('thickness'), title=p.get('title', ''))
            role = MAT_ROLE.get(kw)
            if role:
                info['roles'] = [role]
                info['basis'] = f'.k: pid{pid} -> {kw} + {sec.get("kind", "?")}'
            elif sec.get('kind') == 'shell':
                info['roles'] = ['shell']
                info['basis'] = f'.k: pid{pid} -> SECTION_SHELL(elform={sec.get("elform")})'
            elif sec.get('kind') == 'beam':
                info['roles'] = ['beam']
                info['basis'] = f'.k: pid{pid} -> SECTION_BEAM'
            else:
                info['roles'] = ['structure']
                info['basis'] = f'.k: pid{pid} -> {kw}(未在映射表, 默认 structure)'
        else:
            info['basis'] = '无 .k 记录, 启发式'
            info['roles'] = ['structure']
        parts.append(info)
    if parts and all(p['basis'].startswith('无 .k') for p in parts):
        # 纯启发式：最大 part 视为结构
        parts.sort(key=lambda p: -p['elems'])
        parts[0]['roles'] = ['structure']
        parts[0]['basis'] = '启发式: 单元数最多的 part = structure'
        for p in parts[1:]:
            p['roles'] = ['unknown']
            p['basis'] = '启发式: 未分类(建议提供 .k)'
    return parts


# ================================================================ 6 单位校验
def detect_units(coords, times, kc, vmax_raw=None, pmax_raw=None, deck=None):
    """单位制交叉校验（**材料常数锚点优先 + 四条场值锚点兜底**）：
      材料常数锚点（来自 .k，见 deck_unit_check）：炸药密度∈600~2200 kg/m³、爆速∈1500~9500 m/s、
      空气密度∈0.5~2.0 kg/m³、岩石剪切模量∈10~45 GPa、PCJ∈5~40 GPa。
      命中数最多且领先次高 ≥2 项 → 该制为定论（confidence=high），**优先于场值锚点**。
      场值锚点（兜底，材料常数不可用时）：
      ① 模型尺度 L=span×factor 落 [0.3, 200] m
      ② 总时长 T=末帧t×factor 落 [1e-7, 5e-2] s
      ③ 最大节点速度 PPV=max|v|×factor 落 [0.05, 20000] m/s
      ④ 峰值压力 p=max|p|×stress 落 [1e6, 1e11] Pa
    为什么材料常数优先（实测教训）：③④ 的阈值区间过宽，会把空气爆炸（blasting in air）这种
    "结果量级本来就小"的算例误判到 kg-mm-ms——该算例在 kg-mm-ms 下 TNT 密度=1.631 kg/m³、
    爆速=6.7e6 m/s（都非物理），而在 t-mm-s 下 1631 kg/m³、6717 m/s（✓，且与 ANSYS Workbench
    导出的 MatML/CAERep 的 SI 值逐项吻合）。tnt/1、re-1 在 kg-mm-ms 下三项 ✓（2800/1630/7840），
    在 g-cm-µs 全 ✗，故仍判 kg-mm-ms。场值锚点保留作交叉核对与材料常数缺失时的兜底。
    deck 为 None 或命中不领先（<2 项 / 领先 <2 项）时，回到纯场值锚点逻辑。"""
    span = float(np.ptp(coords, axis=0).max()) if coords.size else 0.0
    tlast = times[-1] if len(times) else 0.0
    deck = deck or {}
    deck_hint = deck.get('material_hint_system')
    rows = []
    for name, s in UNIT_FACTORS.items():
        L = span * s['length']
        T = tlast * s['time']
        V = (vmax_raw * s['velocity']) if vmax_raw else None
        P = (pmax_raw * s['stress']) if pmax_raw else None
        ok_l = 0.3 <= L <= 200.0
        ok_t = 1e-7 <= T <= 5e-2
        ok_v = (0.05 <= V <= 20000.0) if V is not None else None
        ok_p = (1e6 <= P <= 1e11) if P is not None else None
        score = (int(ok_l) + int(ok_t) + (int(ok_v) if ok_v is not None else 0)
                 + (int(ok_p) if ok_p is not None else 0))
        rows.append(dict(system=name, model_span_m=round(L, 4), total_time_s=T,
                         ppv_m_s=(round(V, 2) if V is not None else None),
                         pressure_pa=(P if P is None else float(f'{P:.4g}')),
                         ok_span=bool(ok_l), ok_time=bool(ok_t), ok_ppv=ok_v, ok_pressure=ok_p,
                         score=score, plausible=bool(score >= 3)))
    rows.sort(key=lambda r: (-r['score'],
              0 if r['system'] == deck_hint else 1))
    top, second = rows[0], (rows[1] if len(rows) > 1 else None)
    tie = bool(second and second['score'] == top['score'])
    endtim = kc.get('endtim')
    rel_raw = (abs(tlast - endtim) /
               endtim) if (endtim and tlast > 0) else None
    basis, conf, pick = [], 'low', (top['system']
                                    if top['score'] >= 3 and not tie else None)
    dhs, dhm = deck.get('material_hint_score'), deck.get(
        'material_hint_margin')
    decisive = bool(deck_hint and dhs and dhs >= 2 and dhm and dhm >= 2)
    if decisive:
        dc = [r for r in deck.get('candidates', [])
              if r['system'] == deck_hint][0]
        pick, conf, top = deck_hint, 'high', (rows[[
                                              r['system'] for r in rows].index(deck_hint)])
        basis.append(
            f"材料常数锚点定论：{pick}。该项下 "
            + '、'.join(f"{k}={v}" for k, v in
                       (('空气密度/kg·m⁻³', dc.get('air_density_kg_m3')),
                        ('炸药密度/kg·m⁻³', dc.get('explosive_ro_kg_m3')),
                        ('爆速/m·s⁻¹', dc.get('det_velocity_m_s')),
                        ('岩石剪切模量/GPa', dc.get('rock_shear_gpa')),
                        ('PCJ/GPa', dc.get('pcj_gpa'))) if v is not None)
            + f"；命中 {dhs} 项，领先次高 {dhm} 项")
        tie = False
    if pick:
        if decisive:
            basis.append(f"场值锚点交叉核对（同一 {pick} 制下）：模型尺度 {top['model_span_m']} m"
                         + (f"、总时长 {top['total_time_s']:.4g} s" if top['total_time_s'] else '')
                         + (f"、PPV {top['ppv_m_s']} m/s" if top['ppv_m_s'] is not None else '')
                         + (f"、峰值压力 {top['pressure_pa']} Pa" if pmax_raw else '')
                         + f"（场值得分 {top['score']}/4；时长/压力若越阈值区间，是算例结果量级偏小，"
                         f"不改判据）")
        else:
            basis.append(f"该制下 模型尺度 {top['model_span_m']} m、总时长 {top['total_time_s']:.4g} s"
                         + (f"、PPV {top['ppv_m_s']} m/s" if top['ppv_m_s'] is not None else '')
                         + (f"、峰值压力 {top['pressure_pa']} Pa" if pmax_raw else '')
                         + f" 均落常规区间，得分 {top['score']}/4"
                         + (f"（与 .k 应力线索 {deck_hint} 一致）" if deck_hint == top['system'] else ''))
            conf = 'high' if top['score'] >= 4 else 'medium'
        if tie:
            basis.append(
                f"注意：{second['system']} 同分（{second['score']}/4）→ 建议显式 --units")
    else:
        basis.append('各候选制均不满足（或并列）：需人工指定 --units')
    if vmax_raw:
        basis.append(f"最大节点速度原始值 {vmax_raw:.6g}（模型单位）→ 各制换算："
                     + ' / '.join(f"{r['system']}:{r['ppv_m_s']}" for r in rows))
    if pmax_raw:
        basis.append(f"峰值压力原始值 {pmax_raw:.6g}（模型单位）→ 各制换算："
                     + ' / '.join(f"{r['system']}:{r['pressure_pa']}" for r in rows))
    if deck_hint and pick and deck_hint != pick:
        conf = 'medium' if conf == 'high' else conf
        basis.append(f"注意：材料常数锚点指向 {deck_hint}，与场值锚点 {pick} 冲突 "
                     f"（材料常数命中数不足以定论）→ 容器按场值锚点，置信度降为 {conf}，建议人工确认")
    if rel_raw is not None:
        if rel_raw < 0.05:
            basis.append(f"d3plot 末帧原始时间 {tlast:.4g} 与 .k ENDTIM={endtim} 相对差 "
                         f"{rel_raw*100:.2f}% → 时间单位与 .k 一致")
        else:
            basis.append(f"末帧原始时间 {tlast:.4g} 与 ENDTIM={endtim} 相差 {rel_raw*100:.1f}% "
                         f"→ 可能是截断运行（只影响时长判据，不改单位制）")
    return dict(candidates=rows, pick=pick, ambiguous=bool(tie),
                basis=basis, confidence=conf, endtim_from_k=endtim,
                last_time_raw=tlast, vmax_raw=vmax_raw, pmax_raw=pmax_raw,
                deck_hint=deck_hint, endtim_rel_diff=rel_raw)


# ================================================================ 7 报告输出
def fmt_times(times, n=6):
    if not times:
        return []
    idx = np.linspace(0, len(times) - 1, min(n, len(times))).astype(int)
    return [round(float(times[i]), 6) for i in idx]


def analyze_case(ddir, key, label, kfile=None, parts_override=None, layouts=None):
    """探测一个算例并返回上下文 ctx（probe 报告与写容器共用同一条探测链路）"""
    t0 = time.time()
    base, files, mpp = enumerate_d3plot_files(ddir)
    ctx = dict(key=key, label=label, dir=os.path.abspath(ddir), mpp=mpp,
               files=files, base=base, t0=t0, ok=False)
    if mpp:
        ctx['fatal'] = ('检测到 MPP 分布式 d3plot (d3plot.NN rank 文件)：'
                        '当前不支持 rank 合并，请先用 LS-PrePost 合并为 SMP 单/多文件序列')
        return ctx
    h = probe_header(base)
    ws = h['ws']
    raw_ver = read_version(base)
    norm_ver, prefix = normalize_version(raw_ver)
    solver = detect_solver(files, mpp)
    kf = kfile or find_k_file(ddir)
    kc = parse_k(kf)
    if layouts is None:
        layouts = json.load(
            open(os.path.join(CFG, 'layouts.json'), encoding='utf-8'))
    cand, res, tried, hit = probe_layout(files, base, ws, h, kc, layouts)
    lib_entry, lib_match = find_layout_entry(layouts, norm_ver, prefix, solver)
    ctx.update(ws=ws, h=h, raw_ver=raw_ver, norm_ver=norm_ver, prefix=prefix,
               solver=solver, k_file=kf, kc=kc, layouts=layouts, cand=cand, res=res,
               tried=tried, hit=hit, lib_entry=lib_entry, lib_match=lib_match)
    if not (cand and res):
        return ctx
    coords = read_base_coords(
        base, ws, res['fp_off'], h) if res['fp_off'] else None
    mats_count, conn = {}, None
    try:
        conn = read_base_conn(base, ws, res['fp_off'], h)
        u, c = np.unique(conn[:, 8], return_counts=True)
        mats_count = {int(a): int(b) for a, b in zip(u, c)}
    except Exception as e:
        ctx['warn_conn'] = f'连接表读取失败: {e}'
    # part 对齐到 .k *PART（"part = 前处理自定义组件"）：编号不同源的算例也能对上名称/材料。
    # 成立时把连接表末列的 part 编号整体替换为 .k pid，后续 parts/rules/surf 全部使用该编号。
    ctx['part_source'] = 'd3plot'
    if conn is not None and coords is not None and not parts_override:
        try:
            _d2p, _pmap_note, _pmap_ok = align_parts_to_deck(
                conn, kc, coords, int(h['numnp']))
        except Exception as e:
            _d2p, _pmap_note, _pmap_ok = None, f'对齐异常: {e}', False
        ctx['part_map_note'] = _pmap_note
        if _pmap_ok:
            ctx['part_source'] = 'k_deck'
            if _d2p:
                ctx['part_map'] = _d2p
                conn[:, 8] = np.asarray(
                    [_d2p.get(int(x), int(x)) for x in conn[:, 8]], dtype=conn.dtype)
                u, c = np.unique(conn[:, 8], return_counts=True)
                mats_count = {int(a): int(b) for a, b in zip(u, c)}
    parts = classify_parts(h, kc, mats_count)
    if parts_override:
        for p in parts:
            if p['pid'] in parts_override:
                p['roles'] = [parts_override[p['pid']]]
                p['basis'] = '命令行 --parts 覆盖'
    ctx.update(coords=coords, conn=conn, parts=parts,
               span=(round(float(np.ptp(coords, axis=0).max()), 3)
                     if coords is not None and coords.size else None))
    # 最大节点速度 / 峰值压力（单位制判据③④的锚点）：取中间一帧的速度块与单元历史块
    vmax_raw = pmax_raw = None
    try:
        best_blk, _ = resolve_state_blocks(h, kc, cand['stride'])
        if best_blk:
            blk = build_block_plan(h, best_blk, cand['stride'])
            if res['where']:
                nwh = len(res['where'])
                probes = sorted(set([max(0, nwh // 20), nwh // 4, nwh // 2,
                                     max(0, 3 * nwh // 4)]))
                for i in probes:
                    path, offw = res['where'][i]
                    st = read_state(path, offw // blk['stride'], blk, ws,
                                    ['velocity', 'solid_hist'])
                    vv = st.get('velocity')
                    if vv is not None:
                        v = float(np.linalg.norm(
                            vv.reshape(-1, 3), axis=1).max())
                        vmax_raw = v if vmax_raw is None else max(vmax_raw, v)
                    sh = st.get('solid_hist')
                    if sh is not None:
                        ed = sh.reshape(h['nel8'], h['nv3d'])
                        p = float(
                            np.abs(-(ed[:, 0] + ed[:, 1] + ed[:, 2]) / 3.0).max())
                        pmax_raw = p if pmax_raw is None else max(pmax_raw, p)
                    del st
    except Exception as e:
        ctx['warn_vel'] = f'速度/压力锚点探测失败: {e}'
    dc = deck_unit_check(kc)
    ctx['vmax_raw'] = vmax_raw
    ctx['pmax_raw'] = pmax_raw
    ctx['deck_check'] = dc
    ctx['units'] = detect_units(coords if coords is not None else np.zeros((0, 3)),
                                res['times'], kc, vmax_raw, pmax_raw, dc)
    ctx['ok'] = True
    return ctx


def probe_one(ddir, key, label, kfile=None, parts_override=None, outdir=REPORTS):
    ctx = analyze_case(ddir, key, label, kfile, parts_override)
    t0 = ctx['t0']
    rep = dict(key=key, label=label, dir=os.path.abspath(ddir))
    if not ctx['ok']:
        rep.update(ok=False, fatal=ctx.get('fatal') or '布局探测未通过')
        if ctx.get('files'):
            rep['files'] = [os.path.basename(p) for p, _ in ctx['files']]
        if 'states' not in rep and ctx.get('res'):
            rep['states'] = dict(total=0, per_file=[],
                                 times=[], note='布局探测未通过')
        rep['elapsed_s'] = round(time.time() - t0, 2)
        return rep
    h, ws = ctx['h'], ctx['ws']
    cand, res, kc = ctx['cand'], ctx['res'], ctx['kc']
    rep.update(
        ws=ws, header={k: h[k] for k in HDR_IDX}, header_hint=h['hint'],
        version=dict(raw=ctx['raw_ver'], normalized=ctx['norm_ver'],
                     prefix=ctx['prefix'], solver=ctx['solver']),
        k_file=(os.path.basename(ctx['k_file']) if ctx['k_file'] else None),
        k_summary=dict(parts=len(kc['parts']), sections=len(kc['sections']),
                       materials=len(kc['materials']), deto=len(kc['deto']),
                       endtim=kc['endtim'], counts=kc['counts'], addons=kc.get(
                           'addons', {}),
                       material_id_method=kc.get('material_id_method')),
        deck=dict(encoding=kc.get('encoding'), include_files=kc.get('include_files'),
                  contiguous=kc.get('k_contiguous')),
        layout_probe=dict(hit=(f"{ctx['norm_ver']}|{ctx['solver']}" if ctx['hit'] else None),
                          library_entry=(ctx['lib_entry'].get(
                              'key') if ctx['lib_entry'] else None),
                          library_match=ctx['lib_match'],
                          library_desc=(ctx['lib_entry'].get(
                              'desc') if ctx['lib_entry'] else None),
                          accepted=(cand['desc'] if cand else None),
                          stride=(cand['stride'] if cand else None),
                          tail=(cand['tail'] if cand else None),
                          n_sph=(cand.get('n_sph') if cand else None),
                          n_pbm=(cand.get('n_pbm') if cand else None),
                          rec_sph=(cand.get('rec_sph') if cand else None),
                          rec_pbm=(cand.get('rec_pbm') if cand else None),
                          reasons=(res['reasons'] if res else []),
                          remainders=(res['remainders'][:8] if res else []),
                          fp_msg=(res['fp_msg'] if res else None),
                          tried=ctx['tried'][:12]),
        files=[dict(f=os.path.basename(p), kind=k) for p, k in ctx['files']],
    )
    times = res['times']
    rep['states'] = dict(total=len(times), per_file=res['per_file'], times=times,
                         times_sample=fmt_times(times))
    if ctx.get('warn_conn'):
        rep['warn_conn'] = ctx['warn_conn']
    rep['parts'] = ctx['parts']
    rep['span_model_units'] = ctx['span']
    rep['units'] = ctx['units']
    # 与既有 cases.json 交叉核对（若存在）
    cj = os.path.join(WEB_DATA, 'cases.json')
    if os.path.exists(cj):
        try:
            old = json.load(open(cj, encoding='utf-8')).get(key)
            if old:
                rep['cross_check'] = dict(old_nframes=old.get('nframes'),
                                          old_NEL=old.get('NEL'),
                                          probe_states=len(res['times']),
                                          probe_nel=h['nel8'],
                                          match_frames=(
                                              old.get('nframes') == len(res['times'])),
                                          match_nel=(old.get('NEL') == h['nel8']))
        except Exception as e:
            rep['cross_check'] = f'读取失败: {e}'
    rep['ok'] = True
    rep['elapsed_s'] = round(time.time() - t0, 2)
    return rep


# ================================================================ 8 写自描述容器（第 3 步）
DATA_V3 = os.path.join(ROOT, 'webapp', 'data_v3')
FACES6 = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
          (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
# 单位换算因子：模型单位 → SI 基本单位（容器唯一权威 = mesh.header_json.units）
UNIT_FACTORS = {
    'g-cm-µs': dict(length=0.01, time=1e-6, mass=1e-3, stress=1e11, velocity=1e4,
                    density=1e3, energy=1e5, force=1e7, displacement=0.01, acceleration=1e10),
    'g-mm-ms': dict(length=1e-3, time=1e-3, mass=1e-3, stress=1e6, velocity=1.0,
                    density=1e6, energy=1e-3, force=1.0, displacement=1e-3, acceleration=1e3),
    'kg-mm-ms': dict(length=1e-3, time=1e-3, mass=1.0, stress=1e9, velocity=1.0,
                     density=1e9, energy=1.0, force=1e3, displacement=1e-3, acceleration=1e3),
    # t-mm-s = ANSYS Workbench 的 "N-mm-s" 系（力 N、长度 mm、时间 s）：
    # 密度 t/mm³、应力 MPa、速度 mm/s、能量 mJ。实测 airblast（blasting in air）用它。
    't-mm-s':  dict(length=1e-3, time=1.0, mass=1e3, stress=1e6, velocity=1e-3,
                    density=1e12, energy=1e-3, force=1.0, displacement=1e-3, acceleration=1e-3),
    'kg-m-s': dict(length=1.0, time=1.0, mass=1.0, stress=1.0, velocity=1.0,
                   density=1.0, energy=1.0, force=1.0, displacement=1.0, acceleration=1.0),
}
# markers：起爆点标记的样式/尺寸规则；outline：模型描边的阈值与线宽
DEFAULT_MARKERS = dict(
    kind='point',                 # 起爆点标记类型（圆点精灵）
    dot_ratio=0.011,              # 点尺寸 = dot_ratio × 模型对角线（模型单位）
    dim_factor=0.45,              # 未到期标记的亮度因子（1 = 全亮）
    bucket=100.0,                 # 延期分档门限（显示时间单位；round(lt/bucket) → 0..4）
    delay_colors=[[1.0, 0.25, 0.2], [1.0, 0.62, 0.1], [1.0, 0.9, 0.3],
                  [0.5, 1.0, 0.3], [0.3, 1.0, 0.95]],
)
DEFAULT_OUTLINE = dict(
    crease_deg=60.0,              # 折角棱阈值：相邻面法线夹角 ≥ 该值即描边
    frag_ratio=0.02,              # 碎线阈值：连通棱环总长 < frag_ratio×对角线 则不描
    flat_deg=1.5,                 # 共线合并阈值：相邻折线段夹角 < 该值则合并
    width_px=1.9,                 # 屏幕空间半线宽（像素）
)
# 核心字段（方案：默认始终提取 模型/时间轴/基础动画/损伤/应变/压力）
CORE_FIELDS = ['u', 'damage', 'eps', 'pressure']
# 可选层 → 字段
EXTRACT_LAYERS = {
    'stress': ['stress'], 'velocity': ['vel'], 'acceleration': ['acc'],
    'sph': ['sph_density'],
    # 单元历史全量：nel × nv3d 个 word（体积大，显式开启）
    'hist': ['hist'],
    # 'density' 层已下线：d3plot w11 语义不可靠（单材料 ALE 像密度、多材料 ALE(tnt/1) 是材料分数；
    # 见 config/fieldmaps.json 的 MAT_NULL 条目）——与其输出可疑值不如不输出。
    # field_spec.json 仍登记该字段但 render.show=false（占位，待 w11 语义定论后再启用）。
    'all': ['stress', 'vel', 'acc', 'sph_density'],
}
# 字段元数据（location/comps/单位键）；role='mask' 的 count 语义是字节数（见 frames header）
# 张量分量的**命名顺序**（写入 frames.header.fields[].components）；前端按它切片/派生，不硬编码
FIELD_COMPONENTS = {
    'stress': ['sxx', 'syy', 'szz', 'sxy', 'syz', 'sxz'],
}
FIELD_META = {
    'u':            dict(location='node', comps=3, unit='displacement'),
    'vel':          dict(location='node', comps=3, unit='velocity'),
    'acc':          dict(location='node', comps=3, unit='acceleration'),
    'damage':       dict(location='node', comps=1, unit='-'),
    'eps':          dict(location='node', comps=1, unit='-'),
    'pressure':     dict(location='node', comps=1, unit='stress'),
    # node 插值（与 §1.6 默认一致；element 层无法被 node 基渲染器着色）
    'stress':       dict(location='node', comps=6, unit='stress'),
    'density':      dict(location='element', comps=1, unit='density'),
    'sph_density':  dict(location='sph', comps=1, unit='density'),
    'sph_damage':   dict(location='sph', comps=1, unit='-'),
    'pbm_pos':      dict(location='pbm', comps=3, unit='displacement'),
    'pbm_pressure': dict(location='pbm', comps=1, unit='stress'),
    'pbm_active':   dict(location='pbm', comps=1, unit='-', role='mask'),
    'active_mask':  dict(location='element', comps=1, unit='-', role='mask'),
    # comps 实际 = nv3d，在 field_plan 里覆盖
    'hist':         dict(location='element', comps=1, unit='varies'),
}
# 第 7 步 ③：字段存储精度（'u2' = uint16 归一化，'f4' = float32）。
# u2 语义：写入 raw = clip(round((value-offset)/scale),0,65535)，读出 value = raw*scale+offset；
# scale/offset 由转换器对**全帧**取 min/max 后写入 frames 头（scale=(max-min)/65535, offset=min）。
# 保持 f4 的是：六分量应力张量（数值审计用）与 pbm_pos（后段粒子飞出计算域，极值会压垮常规量程）。
FIELD_STORE = {
    'u': 'u2', 'damage': 'u2', 'eps': 'u2', 'pressure': 'u2', 'vel': 'u2', 'acc': 'u2',
    'density': 'u2', 'sph_density': 'u2', 'sph_damage': 'u2', 'pbm_pressure': 'u2',
    'stress': 'f4', 'pbm_pos': 'f4',
    # hist 必须 f4：nv3d 个 word 量级差 1e10（应力 vs 塑性应变），共享 u2 的 scale/offset
    # 会把小量程 word 全部压成 0
    'hist': 'f4',
}
# frames.bin 头部预留区（字节）：块区起始 = 5(magic)+4(u32)+RESERVE，与头部 JSON 实际长度无关，
# 因此可"先写压缩帧、再回填头部帧索引"，绕开"帧偏移依赖压缩长度"的先有鸡后有蛋问题。
# 1 MiB（可容纳约 1.5 万帧的 {offset,len,usize} 索引）
FRAMES_HDR_RESERVE = 1 << 20


# ---------------------------------------------------------------- 8.0 .k 单位线索交叉核对
def deck_unit_check(kc):
    """用 .k 的**材料常数**反推"模型自身的单位制"——这是独立于算例结果的锚点，
    不受 PPV/压力阈值区间宽度影响（实测教训见 detect_units 文档）。判定区间：
      · 炸药密度 RO 落 600~2200 kg/m³（TNT 1630、乳化/ANFO 900~1500）
      · 炸药爆速 D 落 1500~9500 m/s
      · 空气密度 RO 落 0.5~2.0 kg/m³（MAT_NULL 的空气 part；标准空气 1.18~1.29）
      · 岩石类本构剪切模量 G 落 10~45 GPa（JH-2/RHT；三轴 25~45、单轴 7~24 取并集）
      · 炸药 PCJ 落 5~40 GPa
    返回：各候选制下的换算值 + material 命中数/margin/material_hint_system，
    并保留原 stress_hint（剪切模量+PCJ）作为兼容字段。"""
    props = kc.get('mat_props', {}) or {}
    ro_air = ro_exp = d_det = pcj = None
    shear = None
    for mid, rec in props.items():
        kw = rec.get('kw') or ''
        v = rec.get('vals') or []
        if kw == 'MAT_NULL' and rec.get('ro'):
            ro_air = rec['ro']
        elif kw == 'MAT_HIGH_EXPLOSIVE_BURN':
            ro_exp = rec.get('ro') or ro_exp
            d_det = rec.get('d') or d_det
            pcj = rec.get('pcj') or pcj
        elif kw in ('MAT_JOHNSON_HOLMQUIST_CERAMICS', 'MAT_RHT'):
            # 非 TITLE 版首字段是 mid，剪切模量在其后一位
            o = rec.get('off', 0)
            if len(v) > o + 1 and v[o + 1]:
                shear = v[o + 1]
    if ro_air is None and ro_exp is None and d_det is None and shear is None:
        return None
    rows = []
    for name, s in UNIT_FACTORS.items():
        rows.append(dict(
            system=name,
            air_density_kg_m3=(ro_air * s['density'] if ro_air else None),
            explosive_ro_kg_m3=(ro_exp * s['density'] if ro_exp else None),
            det_velocity_m_s=(d_det * s['velocity'] if d_det else None),
            rock_shear_gpa=(shear * s['stress'] / 1e9 if shear else None),
            pcj_gpa=(pcj * s['stress'] / 1e9 if pcj else None)))

    def stress_hits(r):
        n = 0
        if r['rock_shear_gpa'] is not None:
            n += 1 if 10 <= r['rock_shear_gpa'] <= 45 else 0
        if r['pcj_gpa'] is not None:
            n += 1 if 5 <= r['pcj_gpa'] <= 40 else 0
        return n

    def material_hits(r):
        """密度/爆速/剪切模量/PCJ 五项命中数（各制独立打分，命中数即证据强度）"""
        n = 0
        if r['air_density_kg_m3'] is not None:
            n += 1 if 0.5 <= r['air_density_kg_m3'] <= 2.0 else 0
        if r['explosive_ro_kg_m3'] is not None:
            n += 1 if 600 <= r['explosive_ro_kg_m3'] <= 2200 else 0
        if r['det_velocity_m_s'] is not None:
            n += 1 if 1500 <= r['det_velocity_m_s'] <= 9500 else 0
        n += stress_hits(r)
        return n

    for r in rows:
        r['hits'] = material_hits(r)
    ordered = sorted(rows, key=lambda r: -r['hits'])
    m_hint, m_next = ordered[0], ordered[1]
    m_sys = m_hint['system'] if m_hint['hits'] >= 1 else None
    stress_best = max(rows, key=stress_hits)
    hint_sys = stress_best['system'] if stress_hits(stress_best) > 0 else None
    return dict(deck_ro_air=ro_air, deck_ro_explosive=ro_exp, deck_detonation_d=d_det,
                deck_rock_shear=shear, deck_pcj=pcj, candidates=rows,
                stress_hint_system=hint_sys, stress_hint_score=stress_hits(
                    stress_best),
                material_hint_system=m_sys, material_hint_score=m_hint['hits'],
                material_hint_margin=(m_hint['hits'] - m_next['hits']))


# ---------------------------------------------------------------- 8.1 状态块布局解析
def resolve_state_blocks(h, kc, stride):
    """把状态 stride 拆成具名块（time/globals/coords/vel/acc/solid_hist/solid_part/beam/shell/sph/pbm/tail）。
    粒子块长度与尾长按候选表（layouts.json.block_len_candidates）解方程得到，全部候选入报告，可审计。"""
    n, nel, nv, ng = h['numnp'], h['nel8'], h['nv3d'], h['nglbv']
    n_sph_hdr = int(h.get('nmsph') or 0)
    n_sph_k = int(kc.get('counts', {}).get('sph', 0))
    hb = h.get('hint', {})
    beam_w = int(hb.get('nel2') or 0) * int(hb.get('nv3d_beam') or 0)
    shell_w = int(hb.get('nel4') or 0) * int(hb.get('nv3d_shell') or 0)
    elem = nv * nel + nel
    tails = [497, 0, 62, 116]
    rec_sph_c = [33, 32, 28, 36]
    rec_pbm_c = [14, 12, 16, 18]
    heads = [('blocks=3N(实测通用)', 1 + ng + 9 * n),
             ('blocks=(1+iu+ia)*N', 1 + ng + 3 * n * (1 + int(bool(h['iu'])) + int(bool(h['ia']))))]
    sols = []
    for head_name, head in heads:
        resid = stride - head - elem - beam_w - shell_w
        if resid < 0:
            continue
        if resid in tails:            # 无粒子：残差正好等于候选尾长
            sols.append(dict(head_name=head_name, head=head, n_sph=0, rec_sph=0,
                             n_pbm=0, rec_pbm=0, tail=resid, beam=beam_w, shell=shell_w))
        for n_sph in dict.fromkeys([n_sph_hdr, n_sph_k, 0]):
            if n_sph == 0:
                continue
            for rs in rec_sph_c:
                r1 = resid - rs * n_sph
                if r1 < 0:
                    continue
                for rp in rec_pbm_c:
                    for tl in tails:
                        r2 = r1 - tl
                        if r2 < 0 or r2 % rp:
                            continue
                        sols.append(dict(head_name=head_name, head=head, n_sph=n_sph, rec_sph=rs,
                                         n_pbm=r2 // rp, rec_pbm=rp, tail=tl,
                                         beam=beam_w, shell=shell_w))

    def score(s):
        v = 8 if s['n_sph'] == n_sph_hdr else (2 if s['n_sph'] else 0)
        v += 3 if s['head_name'].startswith('blocks=3N') else 0
        v += 2 if (s['n_sph'] and s['n_pbm']) else 0
        v += (2 - rec_sph_c.index(s['rec_sph'])) if s['n_sph'] else 0
        v += (2 - rec_pbm_c.index(s['rec_pbm'])) if s['n_pbm'] else 0
        v += 1 if s['tail'] == tails[0] else 0
        return v

    if not sols:
        return None, []
    sols.sort(key=score, reverse=True)
    uniq, seen = [], set()
    for s in sols:
        sig = (s['head_name'], s['n_sph'], s['rec_sph'],
               s['n_pbm'], s['rec_pbm'], s['tail'])
        if sig not in seen:
            seen.add(sig)
            uniq.append(s)
    for s in uniq:
        s['score'] = score(s)
    return uniq[0], uniq[:8]


def build_block_plan(h, best, stride):
    """按解析结果生成块偏移表（写/读共用）"""
    n, nel, nv, ng = h['numnp'], h['nel8'], h['nv3d'], h['nglbv']
    plan, cur = [], 0

    def add(name, words):
        nonlocal cur
        plan.append(dict(name=name, words=int(words), off=cur))
        cur += int(words)

    add('time', 1)
    add('globals', ng)
    add('coords', 3 * n)
    if best['head_name'].startswith('blocks=3N'):
        add('velocity', 3 * n)
        add('acceleration', 3 * n)
    add('solid_hist', nv * nel)
    add('solid_part', nel)
    if best['beam']:
        add('beam', best['beam'])
    if best['shell']:
        add('shell', best['shell'])
    if best['n_sph']:
        add('sph', best['n_sph'] * best['rec_sph'])
    if best['n_pbm']:
        add('pbm', best['n_pbm'] * best['rec_pbm'])
    add('tail', best['tail'])
    return dict(plan=plan, by_name={p['name']: p for p in plan}, stride=int(stride),
                used=cur, match=(cur == int(stride)), solved=best)


def read_state(path, k, blk, ws, names):
    """按块表读取某状态的原始字（写容器与 --verify 共用同一读法）；
    用显式 seek+read（支持 >2GB 偏移）。注意：part/删除标记数组在 d3plot 里是 float64
    （实测 tnt/1 与 sph-1：值为 part 号，0 = 已删除），所以要按浮点读。"""
    dt = '<f8' if ws == 8 else '<f4'
    out = {}
    with open(path, 'rb') as f:
        for nm in names:
            b = blk['by_name'].get(nm)
            if b is None:
                continue
            f.seek((k * blk['stride'] + b['off']) * ws)
            raw = f.read(b['words'] * ws)
            out[nm] = np.frombuffer(raw, dtype=dt)
    return out


# ---------------------------------------------------------------- 8.1b 块布局歧义裁决
def _layout_structure_score(h, ws, stride, path, k, best):
    """数据驱动裁决：按候选分解切**一帧**粒子区, 返回"各字槽边际签名的种类数"。
    真实布局各字槽语义不同（编号/位置/密度/损伤/…）→ 签名多样；
    而 rec 与真实不符时（错切）各列边际会趋同 → 退化为 1~2 种。分数越大越像真实布局。"""
    n_sph, rec = int(best.get('n_sph') or 0), int(best.get('rec_sph') or 0)
    if n_sph <= 0 or rec < 2:
        return 0
    blk = build_block_plan(h, best, stride)
    b = blk['by_name'].get('sph')
    if not b:
        return 0
    dt = '<f8' if ws == 8 else '<f4'
    with open(path, 'rb') as f:
        f.seek((int(k) * int(stride) + b['off']) * ws)
        arr = np.frombuffer(f.read(b['words'] * ws), dtype=dt)
    if arr.size < n_sph * rec:
        return 0
    a = arr[:n_sph * rec].reshape(n_sph, rec)
    sigs = set()
    for w in range(rec):
        c = a[:, w]
        sigs.add((round(float(c.min()), 6), round(
            float(c.max()), 6), round(float(c.mean()), 6)))
    return len(sigs)


def refine_state_blocks(best, sols, h, ctx, stride, ws, log=None):
    """块布局歧义裁决（2026-10-20，实测 sph-2 引入）：
    当多组候选的块合计**都等于 stride**（数学上都成立）时，仅靠 score 会选错
    （sph-2 实测：错误解 SPH rec=28 + PBM 19809 + tail497 得分 15 > 正确解 rec=33/无粒子尾 得分 13，
      但按 28 字切片时各字槽统计完全相同 → 说明是错切，字段读取随即越界崩溃）。
    这里用**一帧真实数据**的结构度做最终裁决：真实分解各字槽边际彼此不同, 错切会趋同。
    仅在 top 候选的粒子分解**互不相同**时启用；否则保持既有 score 排序。"""
    if not sols or len(sols) < 2:
        return best
    sigs = {(int(s['n_sph']), int(s['rec_sph']), int(s['n_pbm']), int(s['rec_pbm']), int(s['tail']))
            for s in sols}
    if len(sigs) < 2:
        return best                                        # 粒子分解一致 → 无歧义
    where = (ctx.get('res') or {}).get('where') or []
    if not where:
        return best
    path, offw = where[-1]                                 # 用末帧（场值最"发育"）
    k = int(offw) // int(stride)
    top = sols[:min(4, len(sols))]
    scored = []
    for s in top:
        try:
            scored.append((_layout_structure_score(
                h, ws, stride, path, k, s), s.get('score', 0), s))
        except Exception:
            scored.append((-1, s.get('score', 0), s))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    win = scored[0][2]
    def key(s): return (int(s['n_sph']), int(s['rec_sph']), int(
        s['n_pbm']), int(s['rec_pbm']), int(s['tail']))
    if key(win) != key(best) and log:
        old = next((x[0] for x in scored if x[2] is best), None)
        log(f"块布局歧义：{len(sigs)} 组解合计均 = stride → 按单帧数据结构度裁决："
            f"由 SPH={best['n_sph']}(rec {best['rec_sph']}) PBM={best['n_pbm']}(rec {best['rec_pbm']}) "
            f"tail={best['tail']}（结构度 {old}）改为 SPH={win['n_sph']}(rec {win['rec_sph']}) "
            f"PBM={win['n_pbm']}(rec {win['rec_pbm']}) tail={win['tail']}（结构度 {scored[0][0]}）")
    return win


# ---------------------------------------------------------------- 8.2 几何与表面
def elem_volumes(coords0, nids):
    """六面体体积：沿对角 0-6 的 6 四面体分解（凸六面体下精确）"""
    c = coords0[nids].astype(np.float64)
    tets = [(0, 1, 2, 6), (0, 2, 3, 6), (0, 3, 7, 6),
            (0, 7, 4, 6), (0, 4, 5, 6), (0, 5, 1, 6)]
    vol = np.zeros(len(nids), np.float64)
    for a, b, cc, d in tets:
        e1 = c[:, b] - c[:, a]
        e2 = c[:, cc] - c[:, a]
        e3 = c[:, d] - c[:, a]
        vol += np.abs(np.einsum('ij,ij->i', np.cross(e1, e2), e3)) / 6.0
    return np.maximum(vol, 1e-30)


def build_face_arrays(nids, nel):
    """面数组：行号 = face_slot*nel + elem；返回 (排序键, 原始绕序, 属主单元)"""
    M = 6 * nel
    fk = np.empty((M, 4), np.int64)
    fwrap = np.empty((M, 4), np.int32)
    fowner = np.empty(M, np.int32)
    eidx = np.arange(nel, dtype=np.int32)
    for si, (a, b, c, d) in enumerate(FACES6):
        r0 = si * nel
        f = nids[:, [a, b, c, d]]
        fk[r0:r0 + nel] = np.sort(f, axis=1)
        fwrap[r0:r0 + nel] = f
        fowner[r0:r0 + nel] = eidx
    return fk, fwrap, fowner


def surf_group2(coords0, ecen_elem, fk, fwrap, fowner, nel, elems):
    """单个 part 的闭合外表面 + 绕序统一；返回 (faces i32[Q,4], owner i32[Q], ecent f32[Q,2], 统计)"""
    rows = np.concatenate([s * nel + elems for s in range(6)]).astype(np.int64)
    view = np.ascontiguousarray(fk[rows]).view(
        dtype=[('a', '<i8'), ('b', '<i8'), ('c', '<i8'), ('d', '<i8')]).ravel()
    _u, inv, cnt = np.unique(view, return_inverse=True, return_counts=True)
    keep = rows[cnt[inv] == 1]
    if keep.size == 0:
        return None, None, None, dict(quads=0, degenerate=0, flipped=0, ext_raw=0)
    faces = fwrap[keep].astype(np.int64)
    owner = fowner[keep].astype(np.int32)
    a0, a1, a2, a3 = faces[:, 0], faces[:, 1], faces[:, 2], faces[:, 3]
    ok = (a0 != a1) & (a1 != a2) & (a2 != a3) & (
        a3 != a0) & (a0 != a2) & (a1 != a3)
    ndeg = int((~ok).sum())
    faces, owner = faces[ok], owner[ok]
    fc = coords0[faces].mean(axis=1)                      # 面质心
    du = coords0[faces[:, 1]] - coords0[faces[:, 0]]
    dv = coords0[faces[:, 3]] - coords0[faces[:, 0]]
    bad = (np.cross(du, dv) * (fc - ecen_elem[owner])).sum(axis=1) < 0
    faces[bad] = faces[bad][:, [0, 3, 2, 1]]
    ecent = fc[:, :2].astype(np.float32)
    stat = dict(ext_raw=int(keep.size), quads=int(len(faces)), degenerate=ndeg,
                flipped=int(bad.sum()))
    return faces.astype(np.int32), owner, ecent, stat


def surf_quality(faces, numnp):
    """开边数 / 同向冲突（闭合流形应为 0/0）"""
    f = np.asarray(faces, np.int64).reshape(-1, 4)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]],
                       f[:, [2, 3]], f[:, [3, 0]]])
    a = np.minimum(e[:, 0], e[:, 1])
    b = np.maximum(e[:, 0], e[:, 1])
    base = np.int64(numnp + 1)
    _u, cnt = np.unique(a * base + b, return_counts=True)
    open_edges = int((cnt == 1).sum())
    _u2, cnt2 = np.unique(e[:, 0] * base + e[:, 1], return_counts=True)
    conflicts = int((cnt2 > 1).sum())
    return dict(open_edges=open_edges, directed_conflicts=conflicts, edges=int(len(e)))


# ---------------------------------------------------------------- 8.3 场值
def load_fieldmaps(path=None):
    p = path or os.path.join(CFG, 'fieldmaps.json')
    return json.load(open(p, encoding='utf-8'))


def pick_fieldmap(fm, mat, elem_type, neiph, nv3d):
    """字段表查找：键=(material_model, elem_type, neiph, nv3d)，精确优先，缺失退到同材料/通用条目并标注"""
    best, best_note, best_score = None, '', -1
    for m in fm.get('maps', []):
        if m.get('elem_type', 'solid') != elem_type:
            continue
        matm = m.get('material', '*')
        if matm not in ('*', mat):
            continue
        sc = 0
        exact_mat = (matm == mat)
        sc += 4 if exact_mat else 0
        if neiph in (m.get('neiph') or []):
            sc += 2
        if nv3d in (m.get('nv3d') or []):
            sc += 2
        if sc > best_score:
            best, best_score = m, sc
            note = []
            note.append(f"材料{'精确命中' if exact_mat else '通用条目'}({matm})")
            note.append(
                f"nv3d={nv3d}{'命中' if nv3d in (m.get('nv3d') or []) else '未登记(按同本构偏移)'}")
            if (m.get('verified')):
                note.append('核对依据: ' + m['verified'])
            best_note = '; '.join(note)
    return best, best_note


def part_rules_of(ctx, fm, override=None):
    """每个 part 的字段规则（含所用字段表条目，写入报告以便审计）"""
    h = ctx['h']
    rules, audit = {}, []
    for p in ctx['parts']:
        pid = p['pid']
        mat = p.get('mat') or '*'
        sec = (p.get('sectype') or 'solid').lower()
        et = {'shell': 'shell', 'beam': 'beam'}.get(sec, 'solid')
        m, note = pick_fieldmap(fm, mat, et, h['neiph'], h['nv3d'])
        if m is None:
            m = dict(material='*', elem_type='solid',
                     fields=dict(stress=[0, 6], eps=6, damage=8, pressure=[
                                 0, 1, 2], density=11),
                     verified='内置兜底（未核对）')
            note = (note + '; ' if note else '') + '字段表无匹配 → 内置兜底'
        f = dict(m.get('fields', {}))
        dscale = float(m.get('damage_scale', 1.0))
        rules[pid] = dict(mat=mat, elem_type=et, fields=f, damage_scale=dscale,
                          role=(p['roles'][0] if p.get(
                              'roles') else 'unknown'),
                          low_fields=list(
                              m.get('low_confidence_fields') or []),
                          fieldmap=(m.get('material'), m.get('elem_type')))
        audit.append(dict(pid=pid, mat=mat, elem_type=et, role=rules[pid]['role'],
                          damage_scale=dscale, low_fields=rules[pid]['low_fields'],
                          pick=note or '(无)', fields=f))
    if override:
        for pid, kw in override.items():
            if pid in rules:
                rules[pid]['fields'] = kw.get('fields', rules[pid]['fields'])
                rules[pid]['damage_scale'] = kw.get(
                    'damage_scale', rules[pid]['damage_scale'])
    return rules, audit


def extract_element_fields(ed, part_of_elem, rules, nel, want):
    """单元历史块 → 各字段（全局单元数组，长度 nel；不分组）"""
    nv = ed.shape[1]
    out = {}
    for fid in want:
        if fid == 'stress':
            out[fid] = np.zeros((nel, 6), np.float32)
        elif fid == 'hist':
            # 全部 word，语义见 hist_names
            out[fid] = np.zeros((nel, nv), np.float32)
        else:
            out[fid] = np.zeros(nel, np.float32)
    for pid, rule in rules.items():
        sel = np.nonzero(part_of_elem == pid)[0]
        if sel.size == 0:
            continue
        w = ed[sel]
        f = rule['fields']
        if 'stress' in out:
            s = f.get('stress') or [0, 6]
            if s[1] <= nv:
                out['stress'][sel] = w[:, s[0]:s[1]]
        if 'damage' in out:
            di = f.get('damage')
            if di is not None and di < nv:
                out['damage'][sel] = np.maximum(
                    w[:, di] * rule['damage_scale'], 0.0)
        if 'eps' in out:
            ei = f.get('eps')
            if ei is not None and ei < nv:
                out['eps'][sel] = np.maximum(w[:, ei], 0.0)
        if 'pressure' in out:
            pw = f.get('pressure') or [0, 1, 2]
            if max(pw) < nv:
                out['pressure'][sel] = - \
                    (w[:, pw[0]] + w[:, pw[1]] + w[:, pw[2]]) / 3.0
        if 'density' in out and f.get('density') is not None and f['density'] < nv:
            out['density'][sel] = w[:, f['density']]
        if 'hist' in out:
            out['hist'][sel] = w
    return out


def build_hist_words(rules, nv3d):
    """按已验证的 fieldmaps 偏移生成 hist 的 word 语义表。
    w0..w5 固定为应力 6 分量（所有本构一致）。
    eps/damage **仅当所有规则给出同一偏移且不冲突**时才命名——多材料算例里
    同一个 word 在不同 part 上语义不同（如 072R3 的 w6=damage、JC 的 w6=eps），
    这种情况与 LS-PrePost 一致，统称 history var#N，不猜。"""
    names = {}
    for i, n in enumerate(['sxx', 'syy', 'szz', 'sxy', 'syz', 'sxz']):
        names[i] = dict(name=n, unit='stress')
    eis = {(r.get('fields') or {}).get('eps') for r in rules.values()} - {None}
    dis = {(r.get('fields') or {}).get('damage')
           for r in rules.values()} - {None}
    if len(eis) == 1 and len(dis) == 1 and eis != dis:
        ei, di = int(next(iter(eis))), int(next(iter(dis)))
        if 0 <= ei < nv3d:
            names[ei] = dict(name='eps', unit='-')
        if 0 <= di < nv3d:
            names[di] = dict(name='damage', unit='-')
    words = []
    for i in range(nv3d):
        d = names.get(i) or dict(name='history var#%d' %
                                 i, confidence='unknown')
        words.append(dict(w=i, **d))
    return words


def elem_to_node(vals_e, flat_idx, w8, numnp):
    """单元 → 节点插值：按单元体积加权（np.bincount 实现）"""
    s = np.bincount(flat_idx, weights=np.repeat(vals_e.astype(np.float64), 8) * w8,
                    minlength=numnp)
    c = np.bincount(flat_idx, weights=w8, minlength=numnp)
    return (s / np.maximum(c, 1e-30)).astype(np.float32)


# ---------------------------------------------------------------- 8.4 容器写出
def write_mesh_v3(path, ctx, geo, groups, particles, conn, blk, fm_note, elem_volume=None):
    """写 mesh.bin：先按形状算好块布局 → 写头 → 顺序写块（头与块区不重叠）"""
    h = ctx['h']
    numnp, nel = h['numnp'], h['nel8']
    unit_key = ctx['units_pick']
    hdr = dict(
        _doc=('自描述容器 v3。块区各块的 offset 是相对"块区起点"(=magic4+len4+header_json)的字节偏移，'
              'len 为元素个数，dtype: f4=f32, i4=i32, u1=uint8。'
              'coords/bbox 为模型单位(×units.length 得 m)；conn 是 i4[nel,8] 六面体连接表。'
              '值语义见 frames.bin 的 fields.scale/offset。faces 为四边形顶点索引(每 quad 4 个节点序号)，'
              '三角形化顺序固定：quad i → tri 2i(0,1,2) 与 2i+1(0,2,3)。'
              'markers/outline 为视觉层参数（起爆点标记样式尺寸、模型描边阈值），前端元数据驱动读取。'),
        version='D2W3', key=ctx['key'],
        schema_version=2,                       # 1=v7 旧布局；2=字段注册表/元数据化后（本版）
        id_base=1,
        # k_elem_align | contiguous | internal | fallback（P0-1）
        id_source=ctx.get('id_source'),
        id_map_note=ctx.get('id_map_note'),
        id_note=('编号来源：k_elem_align=连接表(内部)↔.k *ELEMENT_SOLID(用户)逐位对齐反推（双射且全覆盖）；'
                 'contiguous=.k 编号恰为 1..N（arange 精确）；'
                 'internal=d3plot 仅存内部编号 1..N（.k 用户编号带空洞、无 narbs 映射可恢复）；'
                 'fallback=均不成立（按 1..N 假定）'),
        source=dict(dir=ctx['dir'], solver=ctx['solver'],
                    version_raw=ctx['raw_ver'], version_norm=ctx['norm_ver'],
                    d3plot_files=[os.path.basename(p)
                                  for p, _ in ctx['files']],
                    stride=blk['stride'], block_plan=blk['plan'],
                    layout=blk['solved'],
                    header=dict(title=h.get('title'), run_time=None,
                                ndim=h['ndim'], icode=h['icode'],
                                it=h['it'], iu=h['iu'], iv=h['iv'], ia=h['ia'],
                                maxint=h['maxint'], verified=False,
                                note=('title 取自 d3plot 头部前 80 字节；ndim/icode/it/iu/iv/ia/maxint '
                                      '按 HDR_IDX 读取，未经逐版本核对，仅作审计线索；run_time 未解析（尾部格式随版本）'))),
        units=UNIT_FACTORS[unit_key],
        units_system=unit_key,
        units_doc='length→m, time→s, mass→kg, stress→Pa, velocity→m/s, density→kg/m³, '
                  'energy→J, force→N, displacement→m',
        counts=dict(numnp=numnp, nel=nel),
        bbox=geo['bbox'],
        parts=geo['parts'],
        deto=ctx['deto'],
        markers=dict(DEFAULT_MARKERS),
        outline=dict(DEFAULT_OUTLINE),
        fieldmap=fm_note,
    )
    # ---- 布局（只依赖形状）----
    seq = [dict(tag='coords', len=numnp * 3, dtype='f4', arr=lambda: geo['coords0'].reshape(-1)),
           dict(tag='node_ids', len=numnp, dtype='i4',
                arr=lambda: geo['node_ids']),
           dict(tag='elem_ids', len=nel, dtype='i4',
                arr=lambda: geo['elem_ids']),
           dict(tag='conn', len=nel * 8, dtype='i4',
                arr=lambda: conn[:, :8].ravel()),
           dict(tag='conn_part', len=nel, dtype='i4', arr=lambda: conn[:, 8])]
    if elem_volume is not None:
        seq.append(dict(tag='elem_volume', len=nel, dtype='f4',
                        arr=lambda: np.asarray(elem_volume, np.float32).reshape(-1)))
    hdr['surf_groups'] = []
    for g in groups:
        rec = dict(partId=g['partId'], role=g['role'], kind=g.get('kind', 'solid'),
                   quads=g['quads'], stat=g['stat'])
        for k2, dt, arr in (('faces', 'i4', lambda g=g: g['faces'].reshape(-1)),
                            ('owner_elem', 'i4', lambda g=g: g['owner_elem']),
                            ('ecent', 'f4', lambda g=g: g['ecent'].reshape(-1))):
            rebuilt = arr()
            seq.append(dict(tag=f"p{g['partId']}.{k2}",
                       len=rebuilt.size, dtype=dt, arr=arr))
            rec[k2] = dict(len=int(rebuilt.size), dtype=dt, offset=None)
        hdr['surf_groups'].append(rec)
    hdr['particles'] = []
    for p in particles:
        rec = dict((k, v)
                   for k, v in p.items() if k not in ('pos0_arr', 'ids_arr', 'nodes_arr'))
        blks = [('pos0', 'f4', lambda p=p: p['pos0_arr'].reshape(-1)),
                ('ids', 'i4', lambda p=p: p['ids_arr'])]
        if p.get('nodes_arr') is not None:
            blks.append(('nodes', 'i4', lambda p=p: p['nodes_arr']))
        for k2, dt, arr in blks:
            rebuilt = arr()
            seq.append(dict(tag=f"{p['kind']}.{k2}",
                       len=rebuilt.size, dtype=dt, arr=arr))
            rec[k2] = dict(len=int(rebuilt.size), dtype=dt, offset=None)
        hdr['particles'].append(rec)
    # ---- 按顺序累加得到各块 offset（头里的块顺序 = seq 顺序）----
    off = 0
    idx = {s['tag']: s for s in seq}
    for s in seq:
        s['offset'] = off
        off += s['len'] * _dtype_bytes(s['dtype'])
    for k2 in ('coords', 'node_ids', 'elem_ids', 'conn', 'conn_part', 'elem_volume'):
        if k2 not in idx:
            continue
        hdr[k2] = dict(offset=idx[k2]['offset'], len=idx[k2]
                       ['len'], dtype=idx[k2]['dtype'])
    hdr['conn']['shape'] = [nel, 8]
    for rec in hdr['surf_groups']:
        for k2 in ('faces', 'owner_elem', 'ecent'):
            rec[k2]['offset'] = idx[f"p{rec['partId']}.{k2}"]['offset']
    for rec in hdr['particles']:
        for k2 in ('pos0', 'ids', 'nodes'):
            if k2 in rec:
                rec[k2]['offset'] = idx[f"{rec['kind']}.{k2}"]['offset']
    blocks_bytes = off
    hb = json.dumps(hdr, ensure_ascii=False).encode('utf-8')
    # ---- 写头 + 写块 ----
    with open(path, 'wb') as f:
        f.write(b'D2W3' + struct.pack('<I', len(hb)) + hb)
        for s in seq:
            a = np.ascontiguousarray(
                s['arr'](), dtype=np.dtype('<' + s['dtype']))
            if a.size != s['len']:
                raise SystemExit(
                    f"mesh 块 {s['tag']} 长度 {a.size} != 计划 {s['len']}")
            f.write(a.tobytes())
    return dict(path=os.path.basename(path), header_bytes=len(hb), blocks_bytes=blocks_bytes,
                file_bytes=8 + len(hb) + blocks_bytes, header=hdr)


def field_plan(h, blk, extracts, field_location, n_pbm, precision='auto'):
    """本算例的字段表（frames.bin.header.fields）

    precision: 'auto' = 按 FIELD_STORE 字段表（现状）；
               'f4'   = 除 u1 掩膜外全部 f4（无损，体积最大）；
               'u2'   = 标量/矢量场 u2；stress/hist/pbm_pos 仍 f4
                        （多分量或跳量级共享 scale/offset 会失真）。
    """
    numnp, nel = h['numnp'], h['nel8']

    def dtype_of(fid):
        base = FIELD_STORE.get(fid, 'f4')
        if precision == 'f4':
            return 'u1' if base == 'u1' else 'f4'
        if precision == 'u2':
            return 'u1' if base == 'u1' else (
                'f4' if fid in ('stress', 'hist', 'pbm_pos') else 'u2')
        return base

    plan = []
    for fid in CORE_FIELDS + ['pbm_pos', 'pbm_pressure']:
        if fid.startswith('pbm') and not n_pbm:
            continue
        meta = FIELD_META[fid]
        if fid in ('damage', 'eps', 'pressure'):
            loc = field_location
            count = (numnp if loc == 'node' else nel) * meta['comps']
        else:
            loc, count = meta['location'], 0
        if fid == 'u':
            count = numnp * 3
        elif fid == 'pbm_pos':
            count = n_pbm * 3
        elif fid == 'pbm_pressure':
            count = n_pbm
        plan.append(dict(id=fid, dtype=dtype_of(fid), location=loc, count=int(count),
                         scale=1.0, offset=0.0, role=('aux' if fid == 'pbm_pos' else 'field'), unit=meta['unit'],
                         comps=meta['comps'], shape=([count // meta['comps'], meta['comps']]
                                                     if meta['comps'] > 1 else [count])))
    for lay in extracts:
        for fid in EXTRACT_LAYERS.get(lay, []):
            if fid == 'hist':
                nv3d = int(h['nv3d'])
                plan.append(dict(id='hist', dtype=dtype_of('hist'), location='element',
                                 count=int(nel * nv3d), scale=1.0, offset=0.0, role='field',
                                 unit='varies', comps=nv3d, shape=[int(nel), nv3d]))
                continue
            meta = FIELD_META[fid]
            if fid == 'stress':
                count = (numnp if meta['location'] == 'node' else nel) * 6
            elif fid in ('vel', 'acc'):
                count = numnp * 3
            elif fid == 'density':
                count = nel
            elif fid == 'sph_density':
                count = int(h.get('nmsph') or 0)
                if count == 0:
                    continue
            plan.append(dict(id=fid, dtype=dtype_of(fid), location=meta['location'], count=int(count),
                             scale=1.0, offset=0.0, role='field', unit=meta['unit'],
                             comps=meta['comps'],
                             components=(FIELD_COMPONENTS.get(fid) or None),
                             shape=([count // meta['comps'], meta['comps']]
                                    if meta['comps'] > 1 else [count])))
    plan.append(dict(id='active_mask', dtype='u1', location='element',
                     count=int((nel + 7) // 8), scale=1.0, offset=0.0, role='mask',
                     bits=int(nel), unit='-', comps=1, shape=[int(nel)],
                     _doc='1 bit/单元, 1=未删除; byte=idx>>3, bit=idx&7(LSB 优先, 与 np.packbits(bitorder="little") 一致)'))
    if n_pbm:
        plan.append(dict(id='pbm_active', dtype='u1', location='pbm',
                         count=int((n_pbm + 7) // 8), scale=1.0, offset=0.0, role='mask',
                         bits=int(n_pbm), unit='-', comps=1, shape=[int(n_pbm)],
                         _doc='1 bit/粒子, 1=在计算域内(可见); 判据 = |pos - 初始质心| <= 3×模型包围盒对角线(模型单位)，'
                              '用于隐藏飞出计算域的粒子（未删除任何数据）；取位同 active_mask'))
    return plan


def _dtype_bytes(dt):
    return int(np.dtype('<' + dt).itemsize)


def convert_one(ddir, key, label, kfile=None, parts_override=None, units_override=None,
                extract_layers=(), field_location='node', fieldmap_path=None,
                outdir=DATA_V3, do_verify=False, frames_limit=None, log=print,
                codec='zstd', zstd_level=9, precision='auto'):
    """第 3 步：按方案 §二 写自描述容器（mesh.bin + frames.bin）+ 报告 + cases.json 摘要"""
    t0 = time.time()
    ctx = analyze_case(ddir, key, label, kfile, parts_override)
    if not ctx['ok']:
        raise SystemExit(f"[{key}] 转换中止: {ctx.get('fatal') or '布局探测未通过'}")
    h, ws, cand, res, kc = ctx['h'], ctx['ws'], ctx['cand'], ctx['res'], ctx['kc']
    numnp, nel, nv = h['numnp'], h['nel8'], h['nv3d']
    # ---- 单位（唯一权威表，写进 mesh header）----
    upick = units_override or ctx['units'].get('pick')
    if not upick:
        raise SystemExit(f"[{key}] 单位制未能判定（置信度 low）：请显式指定 --units")
    # ---- 1) 状态块布局 ----
    best, sols = resolve_state_blocks(h, kc, cand['stride'])
    if best is None:
        raise SystemExit(
            f"[{key}] 无法把 stride={cand['stride']} 拆成已知块序列，请补 layouts.json 候选")
    # 歧义裁决：多组解合计都 = stride 时，用一帧真实数据的结构度定夺（sph-2 实测需要）
    best = refine_state_blocks(best, sols, h, ctx, cand['stride'], ws, log)
    blk = build_block_plan(h, best, cand['stride'])
    if not blk['match']:
        raise SystemExit(
            f"[{key}] 块表合计 {blk['used']} != stride {blk['stride']}")
    n_sph, n_pbm = int(best['n_sph']), int(best['n_pbm'])
    log(f"[{key}] 块表: stride={blk['stride']} 头{best['head_name']} 粒子 SPH={n_sph}"
        f"(rec {best['rec_sph']}) PBM={n_pbm}(rec {best['rec_pbm']}) tail={best['tail']}")
    if ctx.get('part_source') == 'k_deck':
        log(f"[{key}] part 编号已对齐 .k *PART：{ctx.get('part_map_note')}"
            + (f" 映射(旧→新) {ctx['part_map']}" if ctx.get('part_map') else ''))
    elif ctx.get('part_map_note'):
        log(f"[{key}] part 编号保持 d3plot 原值：{ctx['part_map_note']}")
    if nel == 0:
        raise SystemExit(
            f'[{key}] 该算例没有实体单元(nel8=0)：仅实体路径可用（壳/梁/2D 见方案 §1.5/§9.2）')
    et = element_type_counts(ctx, h)                 # 壳/梁单元数（P2 静态实现）
    el_note = []
    if et['nel4']:
        el_note.append(f"壳单元 {et['nel4']} 个（尝试提取，d3plot 布局未验证）")
    if et['nel2']:
        el_note.append(f"梁单元 {et['nel2']} 个（P2 尚未实现线/管提取）")
    if el_note:
        log(f"[{key}] 元素类型: 实体 {nel} 个 / " +
            '；'.join(el_note) + f"（来源 {et['source']}）")
    # ---- 2) 几何 ----
    coords0 = np.ascontiguousarray(ctx['coords'], np.float32)
    conn = ctx['conn']
    nids = (conn[:, :8] - 1).astype(np.int32)
    part_of_elem = conn[:, 8].astype(np.int32)
    if nids.min() < 0 or nids.max() >= numnp:
        raise SystemExit(
            f'[{key}] 连接表索引越界: [{nids.min()}, {nids.max()}] vs numnp={numnp}')
    # P0-1 编号：① 连接表(内部编号)↔.k *ELEMENT_SOLID(用户编号)逐位对齐反推，双射且全覆盖才采用；
    #          ② .k 编号恰为连续 1..N → arange 精确；③ 都不成立 → 按 1..N 假定并标 fallback。
    node_ids = np.arange(1, numnp + 1, dtype=np.int32)
    elem_ids = np.arange(1, nel + 1, dtype=np.int32)
    id_source = 'fallback'
    _dids, _dwhy = (None, None)
    if kc.get('k_solid_nodes'):
        try:
            _dids, _dwhy = derive_ids_from_deck(
                conn, kc['k_solid_nodes'], numnp, nel)
        except Exception as e:
            _dids, _dwhy = None, str(e)
    if _dids is not None:
        node_ids = _dids
        id_source = 'k_elem_align'
        log(f"[{key}] 编号来源 k_elem_align（连接表 <-> .k 单元逐位对齐，双射且全覆盖）")
    elif kc.get('k_contiguous') is True:
        id_source = 'contiguous'
        log(f"[{key}] 编号来源 contiguous（.k 编号恰为 1..N，arange 精确）")
    elif (int(nids.min()) == 0 and int(nids.max()) == numnp - 1
          and np.unique(nids).size == numnp):
        id_source = 'internal'
        log(f"[{key}] 编号来源 internal（d3plot 连接表为内部编号 1..{numnp}；.k 用户编号带空洞且不可恢复，"
            f"容器按内部编号 1..N）")
    else:
        log(f"[{key}] [WARN] 编号来源 fallback（{_dwhy or '无 .k 单元编号'}）→ 按 1..N 假定（报告标 fallback）")
    ctx['id_source'] = id_source
    ctx['id_map_note'] = _dwhy
    bbox = dict(min=[float(x) for x in coords0.min(0)],
                max=[float(x) for x in coords0.max(0)],
                size=[float(x) for x in (coords0.max(0) - coords0.min(0))])
    parts_hdr = [dict(pid=p['pid'], name=p.get('title', ''), mat=p.get('mat'),
                      sec=p.get('sectype'), roles=p.get('roles'), elform=p.get('elform'),
                      thickness=p.get('thickness'), elems=p.get('elems'), basis=p.get('basis'))
                 for p in ctx['parts']]
    # ---- 3) 表面（按 part 分组，属主单元质心统一绕序）----
    fk, fwrap, fowner = build_face_arrays(nids, nel)
    ecen_elem = coords0[nids].mean(axis=1)
    groups, surf_audit = [], []
    for p in sorted(x['pid'] for x in ctx['parts']):
        elems = np.nonzero(part_of_elem == p)[0].astype(np.int32)
        if elems.size == 0:
            continue
        faces, owner, ecent, stat = surf_group2(
            coords0, ecen_elem, fk, fwrap, fowner, nel, elems)
        role = next((x['roles'][0]
                    for x in ctx['parts'] if x['pid'] == p), 'unknown')
        if faces is None or len(faces) == 0:
            surf_audit.append(dict(partId=int(p), role=role, elems=int(elems.size), quads=0,
                                   note='无外表面'))
            continue
        stat.update(surf_quality(faces, numnp))
        groups.append(dict(partId=int(p), role=role, faces=faces, owner_elem=owner,
                           ecent=ecent, quads=int(len(faces)), stat=stat))
        surf_audit.append(dict(partId=int(p), role=role,
                          elems=int(elems.size), **stat))
        log(f"[{key}] part{p}: 单元 {elems.size} 外表面 {stat['quads']} 面 | 退化 {stat['degenerate']}"
            f" 绕序翻转 {stat['flipped']} 开边 {stat['open_edges']} 同向冲突 {stat['directed_conflicts']}")
        del faces, owner, ecent
    del fk, fwrap, fowner
    # ---- 3b) 壳单元（P2 静态实现；⚠ d3plot 元素块布局未验证，本机无壳算例可固化）----
    shell_note, unhandled = None, []
    if et['nel4']:
        rp = {p['pid']: (p.get('roles') or ['shell'])[0] for p in ctx['parts']}
        sconn, at = read_element_conn(base, ws, res['fp_off'], h, et['nel4'],
                                      SHELL_CONN_WORDS, numnp)
        if sconn is None:
            unhandled.append(f"壳单元 {et['nel4']} 个：连接表候选偏移均校验失败 → 未提取"
                             f"（d3plot 布局未验证，需含壳算例固化）")
        else:
            sf = np.ascontiguousarray(
                sconn[:, :4].astype(np.int32))          # 1 基节点
            se = np.ascontiguousarray(
                coords0[sf - 1].mean(axis=1)[:, :2])    # 单元中心(x,y)
            sp = sconn[:, 4].astype(np.int32)
            for pid in dict.fromkeys(sp.tolist()):
                sel = sp == pid
                gfaces = sf[sel]
                stat = surf_quality(gfaces, numnp)
                stat['mid_surface'] = True
                groups.append(dict(partId=int(pid), role=rp.get(int(pid), 'shell'), kind='shell',
                                   faces=gfaces, owner_elem=np.full(
                                       len(gfaces), -1, np.int32),
                                   ecent=se[sel], quads=int(len(gfaces)), stat=stat))
                surf_audit.append(dict(partId=int(pid), role=rp.get(int(pid), 'shell'),
                                       kind='shell', elems=int(sel.sum()), **stat))
            shell_note = (f"壳单元 {et['nel4']} 个（来源 {et['source']}）：按候选布局 {at} 提取"
                          f"为中面四边形→2 三角（**d3plot 布局未验证**；四节点无重复已校验；壳场值未提取）")
            log(f"[{key}] " + shell_note)
    if et['nel2']:
        unhandled.append(f"梁单元 {et['nel2']} 个：P2 尚未实现线/管提取")
    # ---- 4) 粒子 ----
    particles, part_audit = [], []
    if n_sph:
        # SPH 粒子 = **未被任何实体单元引用的节点**（实测：sph1 恰为尾部区间；sph2 不是！
        #   若按"尾部 n_sph 个节点"取，会把 24093 个 FEM 节点误当粒子 → 模型表面/周边出现大量假粒子）
        used_idx = np.unique(conn[:, :8] - 1)
        unused = np.setdiff1d(np.arange(numnp), used_idx, assume_unique=False)
        if unused.size == n_sph:
            sn, sph_src = unused.astype(np.int32), 'unused_nodes'
        else:
            sn, sph_src = np.arange(
                numnp - n_sph, numnp, dtype=np.int32), 'tail(回退)'
            log(f"[{key}] [WARN] SPH 节点集回退：未被引用节点 {unused.size} != n_sph {n_sph}（W011）")
        contig = (int(sn[-1]) - int(sn[0]) + 1 == n_sph)
        particles.append(dict(kind='sph', n=n_sph,
                              node_start=(int(sn[0]) if contig else None),
                              nodes_arr=sn, rec_words=int(best['rec_sph']),
                              pos0_arr=np.ascontiguousarray(
                                  coords0[sn], np.float32),
                              ids_arr=(sn + 1).astype(np.int32),
                              _doc='SPH 粒子 = 未被实体单元引用的节点集合（node_source=unused_nodes）；'
                                   '逐粒子顺序 = 节点索引升序；位置 = 该节点坐标 + u 字段；'
                                   '密度/损伤取粒子记录'))
        part_audit.append(dict(kind='sph', n=n_sph, node_source=sph_src,
                               node_start=(int(sn[0]) if contig else None),
                               node_span=[int(sn.min()), int(sn.max())]))
    if n_pbm:
        p0path, p0off = res['where'][0]
        pb0 = read_state(
            p0path, p0off // blk['stride'], blk, ws, ['pbm'])['pbm']
        pb0 = pb0.reshape(n_pbm, best['rec_pbm'])
        particles.append(dict(kind='pbm', n=n_pbm, rec_words=int(best['rec_pbm']),
                              pos0_arr=np.ascontiguousarray(
                                  pb0[:, 5:8], np.float32),
                              ids_arr=np.arange(1, n_pbm + 1, dtype=np.int32),
                              _doc='PBM 粒子记录内 pos=word5..7, vel=8..10, rho=12, p=13；每帧位置为 pbm_pos 字段'))
        part_audit.append(dict(kind='pbm', n=n_pbm, rec_words=int(best['rec_pbm']),
                               pos_range=[float(x)
                                          for x in np.abs(pb0[:, 5:8]).max(0)],
                               note='块首词是 int64 计数 36000（与解出的 36000 相符）；位置 w5..w7 已与 '
                                    't=0 的装药柱几何核对；rho@12 / p@13 沿用既有管线偏移（未逐点核对）；'
                                    '后段帧位置可达 ~2e5 模型单位（飞出计算域）→ 用 pbm_active 掩膜隐藏，'
                                    '原始数据全部保留不删'))
        log(f"[{key}] PBM 粒子 {n_pbm}（记录 {best['rec_pbm']} 词）")
    # ---- 5) 字段表与规则 ----
    fm = load_fieldmaps(fieldmap_path)
    rules, fm_audit = part_rules_of(ctx, fm)
    # ---- 6) 字段计划 ----
    # 粒子字段槽位可用性（按实测 rec 判定）：槽位不足即**不纳入计划**（不写零值假数据），并记录原因
    rec_s_, rec_p_ = int(best['rec_sph']), int(best['rec_pbm'])
    slot_note = []
    sph_extra = []
    if n_sph:
        if rec_s_ > 10:
            sph_extra.append('sph_density')
        else:
            slot_note.append(f'SPH rec={rec_s_} 无密度槽(10) → 跳过 sph_density')
        if field_location == 'element':
            if rec_s_ > 29:
                sph_extra.append('sph_damage')
            else:
                slot_note.append(f'SPH rec={rec_s_} 无损伤槽(29) → 跳过 sph_damage')
    plan_fields = field_plan(h, blk, extract_layers,
                             field_location, n_pbm, precision)
    if any(f['id'] == 'hist' for f in plan_fields):
        hw = build_hist_words(rules, int(h['nv3d']))
        for f in plan_fields:
            if f['id'] == 'hist':
                f['hist_words'] = hw
    if n_pbm:
        drop = set()
        if rec_p_ < 8:
            drop |= {'pbm_pos', 'pbm_active'}          # 位置槽缺失 → 在域掩膜也无从计算
        if rec_p_ <= 13:
            drop.add('pbm_pressure')
        if drop:
            plan_fields = [f for f in plan_fields if f['id'] not in drop]
            slot_note.append(
                f'PBM rec={rec_p_} 槽位不足 → 跳过 {",".join(sorted(drop))}')
    if slot_note:
        log(f"[{key}] [WARN] 粒子槽位：{'; '.join(slot_note)}（W010，不产可疑值）")
    if sph_extra:
        for fid in sph_extra:
            if fid not in [f['id'] for f in plan_fields] and fid not in [s['id'] for s in plan_fields]:
                meta = FIELD_META[fid]
                plan_fields.append(dict(id=fid, dtype=FIELD_STORE.get(fid, 'f4'), location='sph',
                                        count=int(n_sph * meta['comps']), scale=1.0, offset=0.0,
                                        role='field', unit=meta['unit'], comps=meta['comps'],
                                        shape=[int(n_sph * meta['comps'])]))
    frame_bytes = sum(_dtype_bytes(f['dtype'])
                      * f['count'] for f in plan_fields)
    # 低置信字段：字偏移来自未与 LS-PrePost 逐点核对的字段表条目（例如 tnt 混凝土的 w7）
    lowf = sorted({fid for r in rules.values()
                  for fid in r.get('low_fields', [])})
    for spec in plan_fields:
        spec['confidence'] = 'low' if spec['id'] in lowf else 'high'
        if spec['id'] in lowf:
            spec['note'] = '该字段的单元历史字偏移未与 LS-PrePost 逐点核对（见 config/fieldmaps.json 对应条目）'
    layer_ids = [f['id'] for f in plan_fields]
    log(f"[{key}] 字段: {layer_ids} | 每帧 {frame_bytes/1e6:.2f} MB"
        + (f" | 低置信: {lowf}" if lowf else ''))
    # ---- 7) 写 mesh.bin ----
    os.makedirs(outdir, exist_ok=True)
    mesh_path = os.path.join(outdir, f'{key}.mesh.bin')
    ctx['units_pick'] = upick
    ctx['deto'] = kc.get('deto', [])
    w_e_mesh = elem_volumes(coords0, nids)
    mesh_meta = write_mesh_v3(mesh_path, ctx, dict(coords0=coords0, node_ids=node_ids,
                                                   elem_ids=elem_ids, bbox=bbox, parts=parts_hdr),
                              groups, particles, conn, blk, fm_audit,
                              elem_volume=w_e_mesh)
    log(f"[{key}] mesh.bin {mesh_meta['file_bytes']/1e6:.2f} MB, {len(groups)} 个表面组")
    # ---- 8) 写 frames.bin（全状态，一比一；u2 归一化 + 每帧独立压缩块）----
    times = [float(x) for x in res['times']]
    if frames_limit:
        times = times[:frames_limit]
    nfr = len(times)
    if codec == 'zstd' and _zstd is None:
        raise SystemExit(
            f"[{key}] 指定 --compress zstd，但未安装 zstandard（pip install zstandard）")
    fr_path = os.path.join(outdir, f'{key}.frames.bin')
    field_ids = [f['id'] for f in plan_fields]
    loc_of = {f['id']: f['location'] for f in plan_fields}
    u2_fields = [f['id'] for f in plan_fields if f['dtype'] == 'u2']
    w_e = elem_volumes(coords0, nids)
    w8 = np.repeat(w_e, 8)
    flat = nids.ravel()
    sph_idx = (particles[[q['kind'] for q in particles].index('sph')]['nodes_arr']
               if n_sph else None)          # SPH 节点索引集合（未被实体单元引用）
    if n_pbm:                                   # PBM 在域判据的参数（初始质心 + 3×包围盒对角线）
        pbm_c0 = particles[[q['kind'] for q in particles].index('pbm')]['pos0_arr'] \
            .astype(np.float64).mean(axis=0)
        pbm_lim = 3.0 * float(np.linalg.norm(coords0.max(0).astype(np.float64)
                                             - coords0.min(0).astype(np.float64)))
        log(f"[{key}] PBM 在域判据: |pos - 初始质心| <= {pbm_lim:.4g} 模型单位"
            f"（初始质心 {np.round(pbm_c0, 3).tolist()}）")
    peaks_el = {k: 0.0 for k in ('damage', 'eps', 'pressure')}
    peaks_nd = {k: 0.0 for k in ('damage', 'eps', 'pressure')}
    scales = {f['id']: 0.0 for f in plan_fields if f['role'] == 'field'}
    want_elem = [k for k in ('damage', 'eps', 'pressure',
                             'stress', 'density', 'hist') if k in field_ids]
    where = res['where']
    coords0_f8 = coords0.astype(np.float64)
    # 损伤占比（对比序列）：口径同 legacy auto_convert.py —— 岩石(structure)单元中 clip(单元损伤,0,1)>0.5 的占比
    rock_pids = [int(p['pid']) for p in ctx['parts']
                 if 'structure' in (p.get('roles') or [])]
    rock_elem_mask = (np.isin(part_of_elem, rock_pids)
                      if rock_pids else np.zeros(nel, dtype=bool))
    NR_rock = int(rock_elem_mask.sum())
    log(f"[{key}] 损伤占比口径: 岩石单元 {NR_rock} 个（clip(单元损伤,0,1)>0.5 占比 → frames.header.damage_frac）")

    def compute_frame(i):
        """读取第 i 帧并算出待存字段的物理值；归一化扫描(pass1)与落盘(pass2)共用同一实现，
        保证 pass1 的 min/max 与 pass2 写入的值逐位一致。"""
        path, offw = where[i]
        st = read_state(path, offw // blk['stride'], blk,
                        ws, ['coords', 'velocity', 'acceleration', 'solid_hist', 'solid_part',
                             'sph', 'pbm', 'globals'])
        cd = st['coords'].reshape(-1, 3)
        u = (cd - coords0_f8).astype(np.float32)
        ed = st.get('solid_hist')
        ed = ed.reshape(nel, nv) if ed is not None else np.zeros((nel, nv))
        eff = extract_element_fields(ed, part_of_elem, rules, nel, want_elem)
        sp_arr = st.get('solid_part')
        sp_arr = sp_arr.astype(
            np.int32) if sp_arr is not None else np.ones(nel, np.int32)
        act = sp_arr != 0
        sp_dmg = sp_rho = None
        if n_sph:
            recs_ = int(best['rec_sph'])
            sph = st['sph'].reshape(n_sph, recs_)
            if recs_ > 10:                                   # 槽位按实测 rec 判定：不足即跳过（不产错数据）
                sp_rho = np.clip(sph[:, 10], 0, None).astype(np.float32)
            if recs_ > 29:
                sp_dmg = np.clip(sph[:, 29], 0, None).astype(np.float32)
        pbm_pos = pbm_p = pbm_ok = None
        if n_pbm:
            recp_ = int(best['rec_pbm'])
            pb = st['pbm'].reshape(n_pbm, recp_)
            if recp_ >= 8:
                pbm_pos = np.ascontiguousarray(pb[:, 5:8], np.float32)
            if recp_ > 13:
                pbm_p = np.maximum(pb[:, 13], 0).astype(np.float32)
            if pbm_pos is not None:
                # 在域判据：|pos - 初始质心| <= 3×包围盒对角线（模型单位）
                pbm_ok = (np.linalg.norm(pbm_pos.astype(
                    np.float64) - pbm_c0, axis=1) <= pbm_lim)
        vals = {}
        for fid in field_ids:
            if fid == 'u':
                vals['u'] = u.ravel()
            elif fid == 'vel':
                vv = st.get('velocity')
                vals['vel'] = (vv.astype(np.float32) if vv is not None
                               else np.zeros(numnp * 3, np.float32))
            elif fid == 'acc':
                aa = st.get('acceleration')
                vals['acc'] = (aa.astype(np.float32) if aa is not None
                               else np.zeros(numnp * 3, np.float32))
            elif fid == 'stress':
                if loc_of.get('stress') == 'node':
                    # (nel, 6) → 逐分量插值到节点, ravel 成 node-major (numnp,6)
                    ev = eff['stress']
                    cols = [elem_to_node(ev[:, c], flat, w8, numnp)
                            for c in range(6)]
                    vals['stress'] = np.stack(
                        cols, axis=1).ravel().astype(np.float32)
                else:
                    vals['stress'] = eff['stress'].ravel()
            elif fid == 'hist':
                vals['hist'] = eff['hist'].ravel().astype(
                    np.float32)   # 单元级全量 word，不插值
            elif fid == 'density':
                vals['density'] = eff['density']
            elif fid == 'active_mask':
                vals['active_mask'] = np.packbits(act, bitorder='little')
            elif fid == 'pbm_pos':
                vals['pbm_pos'] = pbm_pos.ravel()
            elif fid == 'pbm_pressure':
                vals['pbm_pressure'] = pbm_p
            elif fid == 'pbm_active':
                vals['pbm_active'] = np.packbits(pbm_ok, bitorder='little')
            elif fid == 'sph_density':
                vals['sph_density'] = sp_rho
            elif fid == 'sph_damage':
                vals['sph_damage'] = sp_dmg
            else:                                   # damage / eps / pressure
                ev = eff[fid]
                if field_location == 'element':
                    vals[fid] = ev
                else:
                    nv_ = elem_to_node(ev, flat, w8, numnp)
                    if fid == 'damage' and sp_dmg is not None:
                        nv_[sph_idx] = sp_dmg
                    vals[fid] = nv_
        return dict(st=st, cd=cd, u=u, eff=eff, act=act, pbm_ok=pbm_ok, vals=vals)

    # ---- pass 1：全帧 min/max（定 u2 归一化系数）+ 峰值 / 满量程统计 ----
    vmin = {k: np.inf for k in u2_fields}
    vmax = {k: -np.inf for k in u2_fields}
    for i in range(nfr):
        r = compute_frame(i)
        for k in u2_fields:
            a = r['vals'][k]
            if a.size:
                lo, hi = float(a.min()), float(a.max())
                if lo < vmin[k]:
                    vmin[k] = lo
                if hi > vmax[k]:
                    vmax[k] = hi
        for spec in plan_fields:
            if spec['role'] == 'field':
                a = r['vals'][spec['id']]
                if a.size:
                    av = float(np.abs(a).max())
                    if av > scales.get(spec['id'], 0.0):
                        scales[spec['id']] = av
        for k in ('damage', 'eps', 'pressure'):
            if k in r['eff']:
                peaks_el[k] = max(peaks_el[k], float(
                    np.abs(r['eff'][k]).max()))
            if loc_of.get(k) == 'node' and r['vals'].get(k) is not None:
                peaks_nd[k] = max(peaks_nd[k], float(
                    np.abs(r['vals'][k]).max()))
        if r['vals'].get('pbm_pressure') is not None:
            peaks_nd['pbm_pressure'] = max(peaks_nd.get('pbm_pressure', 0.0),
                                           float(r['vals']['pbm_pressure'].max()))
        del r
    # u2 系数：scale=(max-min)/65535, offset=min
    for spec in plan_fields:
        if spec['dtype'] != 'u2':
            continue
        lo, hi = vmin[spec['id']], vmax[spec['id']]
        if not (np.isfinite(lo) and np.isfinite(hi)):
            spec['scale'], spec['offset'] = 1.0, 0.0
        elif hi <= lo:
            spec['scale'], spec['offset'] = 1.0, float(lo)
        else:
            spec['scale'] = float((hi - lo) / 65535.0)
            spec['offset'] = float(lo)
    if u2_fields:
        log(f"[{key}] u2 归一化: " + '; '.join(
            f"{s['id']} scale={s['scale']:.4g} off={s['offset']:.4g}"
            for s in plan_fields if s['dtype'] == 'u2'))
    # ---- pass 2：编码 + 每帧独立压缩块；先占位写帧区，末尾回填含帧索引的头部 ----
    frames_base = 5 + 4 + FRAMES_HDR_RESERVE
    cctx = (_zstd.ZstdCompressor(level=int(zstd_level), threads=-1)
            if (codec == 'zstd' and _zstd) else None)
    frames_rec, active_per_frame, checks, frame_log = [], [], [], []
    e_ke, e_ie, e_te = [], [], []              # ⑤ 全局能量时间序列（globals[0..2]）
    globals_all = []                           # P0-4：globals 全量独立块 [nfr, nglbv] f8
    damage_frac = []                           # P1(a) 损伤占比序列（对比面板）
    with open(fr_path, 'wb') as f:
        f.write(b'D2W3F' + struct.pack('<I', 0) + bytes(FRAMES_HDR_RESERVE))
        offset = frames_base
        for i in range(nfr):
            r = compute_frame(i)
            vals = r['vals']
            payload = bytearray()
            for spec in plan_fields:
                a = vals[spec['id']]
                if spec['dtype'] == 'u2':
                    sc, off = spec['scale'], spec['offset']
                    if sc > 0 and a.size:
                        q = np.rint((a - off) / sc)
                        np.clip(q, 0, 65535, out=q)
                        enc = q.astype('<u2')
                    else:
                        enc = np.zeros(a.size, dtype='<u2')
                else:
                    enc = np.ascontiguousarray(
                        a, dtype=np.dtype('<' + spec['dtype']))
                assert enc.size == spec['count'], \
                    f"{key} 帧{i} 字段 {spec['id']} 长度 {enc.size} != {spec['count']}"
                payload += enc.tobytes()
            assert len(
                payload) == frame_bytes, f"{key} 帧{i} payload {len(payload)} != {frame_bytes}"
            comp = cctx.compress(
                bytes(payload)) if cctx is not None else bytes(payload)
            f.write(comp)
            frames_rec.append(dict(offset=offset, len=len(comp), usize=frame_bytes,
                                   preloaded=(i == 0)))
            offset += len(comp)
            nact = int(r['act'].sum())
            active_per_frame.append(nact)
            checks.append([round(float(np.abs(r['u']).sum()), 4),
                           round(float(r['cd'][:, 0].sum()), 4)])
            fl = dict(frame=i, t=times[i], active=nact, nbytes=frame_bytes,
                      comp_bytes=len(comp), checksum=checks[-1])
            if r['pbm_ok'] is not None:
                fl['pbm_visible'] = int(r['pbm_ok'].sum())
            frame_log.append(fl)
            if i % 10 == 0 or i == nfr - 1:
                log(f"[{key}] 帧 {i+1}/{nfr} t={times[i]:.4g} active={nact}/{nel}"
                    f" ({nact/max(nel, 1)*100:.1f}%)"
                    + (f" pbm 可见 {int(r['pbm_ok'].sum())}/{n_pbm}" if n_pbm else '')
                    + (f" 压缩 {len(comp)/1e6:.2f}/{frame_bytes/1e6:.2f} MB" if codec == 'zstd' else ''))
            # ⑤ globals[0..2] = KE/IE/TE（沿用 legacy 口径）
            gl = r['st'].get('globals')
            if gl is not None and gl.size >= 2:
                e_ke.append(float(gl[0]))
                e_ie.append(float(gl[1]))
                e_te.append(float(gl[2]) if gl.size >
                            2 else float(gl[0]) + float(gl[1]))
                # P0-4：全量 globals（不足补零）
                g_full = np.zeros(int(h['nglbv']), np.float64)
                g_full[:min(gl.size, h['nglbv'])] = gl[:h['nglbv']]
                globals_all.append(g_full)
            edmg = r['eff'].get('damage')        # P1(a) 损伤占比（单元级，口径同 legacy）
            if edmg is not None and NR_rock:
                damage_frac.append(round(float(
                    (np.clip(edmg, 0, 1)[rock_elem_mask] > 0.5).sum()) / NR_rock * 100, 2))
            del r
        # P0-4：globals 全量独立块（追加在帧块区之后、8 字节对齐；不改 frames[0].offset == frames_base）
        globals_meta = None
        if globals_all:
            gl_arr = np.stack(globals_all).astype('<f8')
            pad = (-f.tell()) % 8
            if pad:
                f.write(b'\x00' * pad)
            gl_off = f.tell() - frames_base
            gl_arr.tofile(f)
            globals_meta = dict(offset=int(gl_off), len=int(gl_arr.size), dtype='f8',
                                shape=[int(nfr), int(h['nglbv'])])
        # 回填头部（此时才拿到帧索引；块区起始 = frames_base，与头部长度无关 → 无鸡生蛋问题）
        fr_hdr = dict(version='D2W3F', schema_version=2, key=key, nframes=nfr, times=times, codec=codec,
                      frames_base=frames_base, header_reserve=FRAMES_HDR_RESERVE,
                      frame_bytes=frame_bytes,
                      time_unit='原始单位（与 d3plot 一致）；显示时间 = times[i] * mesh.header.units.time',
                      precision={f['id']: f['dtype'] for f in plan_fields},
                      precision_mode=precision,
                      precision_note=('auto=字段表默认；f4=除掩膜外全 f4（无损）；'
                                      'u2=标量/矢量量化，stress/hist/pbm_pos 仍 f4'),
                      fields=plan_fields, layers=list(extract_layers),
                      field_location=field_location,
                      globals_all=globals_meta, globals_words=int(h['nglbv']),
                      energy=(dict(ke=e_ke, ie=e_ie, te=e_te, unit='energy',
                                   note='d3plot globals[0]/[1]/[2] = KE/IE/TE（模型能量单位，×mesh.units.energy → J）；'
                                        '与 legacy auto_convert.py 同口径（KE=g[0], IE=g[1], TE=g[2]）')
                              if e_ke else None),
                      damage_frac=(damage_frac if len(
                          damage_frac) == nfr else None),
                      _doc=('u2 字段: value = raw*scale + offset（每字段全帧 min/max 归一化，系数见 fields[].scale/offset）；'
                            'f4 字段: value = raw（scale=1, offset=0）。'
                            '帧块 frames[i] = {offset(绝对字节), len(压缩后), usize(解压后=frame_bytes)}；'
                            'codec=zstd 时单帧块是独立 zstd 帧，HTTP Range 可直达；frames[0].preloaded=true。'
                            '块区起始 = frames_base = 5(magic)+4(u32)+header_reserve'),
                      frames=frames_rec)
        hb = json.dumps(fr_hdr, ensure_ascii=False).encode('utf-8')
        if len(hb) > FRAMES_HDR_RESERVE:
            raise SystemExit(f"[{key}] frames 头部 {len(hb)} 字节 > 预留 {FRAMES_HDR_RESERVE}，"
                             f"请调大 FRAMES_HDR_RESERVE")
        f.seek(0)
        f.write(b'D2W3F' + struct.pack('<I', len(hb)) + hb)
    fr_bytes = os.path.getsize(fr_path)
    # ---- 9) 报告 + cases.json ----
    surf_open = sum(s.get('open_edges', 0) for s in surf_audit)
    surf_deg = sum(s.get('degenerate', 0) for s in surf_audit)
    surf_note = ('各 part 外表面闭合（开边 0 / 退化 0）' if surf_open == 0 and surf_deg == 0 else
                 f'开边 {surf_open} / 退化四边形 {surf_deg}：开边主要来自退化(塌陷)单元的剔除，'
                 f'属模型固有的 void/空腔建模（常见于炮孔与空腔区）；非三角化或索引错误。'
                 f'逐 part 统计见 surf。')
    rep = dict(key=key, label=label, dir=os.path.abspath(ddir), ok=True, stage='all',
               precision_mode=precision,
               id_source=ctx.get('id_source'), id_map_note=ctx.get('id_map_note'),
               deck=dict(encoding=kc.get('encoding'), include_files=kc.get('include_files'),
                         contiguous=kc.get('k_contiguous')),
               container=dict(mesh=mesh_meta,
                              frames=dict(path=os.path.basename(fr_path),
                                          bytes=int(fr_bytes), frame_bytes=int(frame_bytes),
                                          codec=codec,
                                          raw_bytes=int(frame_bytes * nfr),
                                          ratio=(round(frame_bytes * nfr / fr_bytes, 2) if fr_bytes else None))),
               block_plan=blk['plan'], block_solution=best, block_candidates=sols,
               particle_slots=(slot_note or None),
               part_source=ctx.get('part_source'),
               part_map=(ctx.get('part_map') or None),
               part_map_note=ctx.get('part_map_note'),
               layout_probe=dict(accepted=(cand['desc'] if cand else None),
                                 stride=cand['stride'], library_entry=(ctx['lib_entry'].get('key')
                                                                       if ctx['lib_entry'] else None),
                                 fp_msg=res['fp_msg']),
               geometry=dict(numnp=numnp, nel=nel, nv3d=nv, nglbv=h['nglbv'], bbox=bbox,
                             n_sph=n_sph, n_pbm=n_pbm, node_base=1, elem_base=1,
                             note='bbox 与 coords 均为模型单位（×units.length → m）；'
                                  'conn 为 i4[nel,8] 六面体连接表'),
               elements_note=(el_note or None),
               elements=dict(nel8=nel, nel4=et['nel4'], nel2=et['nel2'], source=et['source'],
                             shell=shell_note, unhandled=(unhandled or None),
                             shell_confidence=('low（d3plot 布局未验证，仅节点范围+四节点不重复校验）'
                                               if et['nel4'] and shell_note and '未提取' not in shell_note else None),
                             note='P2 静态实现：壳按中面四边形尝试提取（d3plot 布局未验证）；梁/2D 未实现'),
               surf=surf_audit, surf_note=surf_note, particles=part_audit,
               fieldmap=fm_audit, fields=plan_fields, extract_layers=list(
                   extract_layers),
               low_confidence_fields=lowf,
               units=dict(pick=upick, factors=UNIT_FACTORS[upick],
                          source=ctx['units'], override=bool(units_override),
                          deck_check=ctx.get('deck_check')),
               interpolation=dict(location=field_location,
                                  weight='单元体积加权（六面体 6 四面体分解）',
                                  peaks_element=peaks_el, peaks_node=peaks_nd,
                                  note='单元→节点会抹平峰值；两处峰值差即该效应的量化'),
               states=dict(total=nfr, per_file=res['per_file'], times=times,
                           active_per_frame=active_per_frame, checksum=checks,
                           frames=frame_log,
                           note='状态数与 d3plot 一一对应，未抽帧'),
               detector=dict(version=dict(raw=ctx['raw_ver'], normalized=ctx['norm_ver'],
                                          solver=ctx['solver']),
                             k_file=(os.path.basename(
                                 ctx['k_file']) if ctx['k_file'] else None),
                             parts=[dict(pid=p['pid'], mat=p.get('mat'), roles=p.get('roles'),
                                         basis=p.get('basis')) for p in ctx['parts']],
                             span_model_units=ctx['span']),
               scales=scales, elapsed_s=round(time.time() - t0, 2))
    if do_verify:
        rep['verify'] = verify_container(key, ctx, blk, outdir, plan_fields)
    rp = os.path.join(REPORTS, f'{key}.report.json')
    json.dump(rep, open(rp, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    # cases.json：仅摘要，不放 units（唯一权威在 mesh.header.units）
    cj_path = os.path.join(outdir, 'cases.json')
    cj = json.load(open(cj_path, encoding='utf-8')
                   ) if os.path.exists(cj_path) else {}
    cj[key] = dict(label=label, key=key,
                   schema_version=2,                 # 与容器头一致（版本闸）
                   requires_frontend=2,              # = 前端最低需支持的 schema_version
                   type=('mixed' if (n_sph or n_pbm) else
                         ('ale' if all(p['role'] in ('air', 'explosive')
                                       for p in fm_audit) else 'fem')),
                   data_prefix=key, mesh=os.path.basename(mesh_path),
                   frames=os.path.basename(fr_path), nframes=nfr, times=times,
                   parts=[dict(pid=p['pid'], role=(p['roles'][0] if p.get('roles') else 'unknown'),
                               mat=p.get('mat'), elems=p.get('elems')) for p in ctx['parts']],
                   part_types={str(p['pid']): p['role'] for p in fm_audit},
                   fields=[dict(id=f['id'], location=f['location'], unit=f['unit'],
                                role=f['role'], confidence=f.get('confidence', 'high'))
                           for f in plan_fields],
                   low_confidence_fields=lowf,
                   surf_groups=[dict(partId=g['partId'], role=g['role'], quads=g['quads'])
                                for g in groups],
                   particles=[dict(kind=p['kind'], n=p['n'])
                              for p in particles],
                   scales=scales, report=rp, detector=dict(times_unit='原始单位'))
    json.dump(cj, open(cj_path, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    log(f"[{key}] 完成: mesh {mesh_meta['file_bytes']/1e6:.1f} MB + frames {fr_bytes/1e6:.1f} MB "
        f"({nfr} 帧 × {frame_bytes/1e6:.2f} MB)，用时 {rep['elapsed_s']}s")
    rep['report_path'] = rp
    return rep


# ---------------------------------------------------------------- 8.5 --verify（真审计）
def _read_header(path, magic):
    ml = len(magic)
    with open(path, 'rb') as f:
        m = f.read(ml)
        if m != magic:
            return None, f'magic 不符: {m!r} != {magic!r}'
        (n,) = struct.unpack('<I', f.read(4))
        hb = f.read(n)
    try:
        return json.loads(hb.decode('utf-8')), None
    except Exception as e:
        return None, f'header_json 解析失败: {e}'


def verify_container(key, ctx, blk, outdir, plan_fields, n_sample=4, seed=7):
    """① 容器自洽（块边界/字段长度/帧索引）② 随机抽帧与 d3plot 同帧 np.allclose 对比"""
    t0 = time.time()
    h, ws, res = ctx['h'], ctx['ws'], ctx['res']
    numnp, nel, nv = h['numnp'], h['nel8'], h['nv3d']
    out = dict(key=key, ok=True, issues=[])

    def bad(msg):
        out['ok'] = False
        out['issues'].append(msg)

    mesh_path = os.path.join(outdir, f'{key}.mesh.bin')
    fr_path = os.path.join(outdir, f'{key}.frames.bin')
    mh, err = _read_header(mesh_path, b'D2W3')
    fh, err2 = _read_header(fr_path, b'D2W3F')
    if err:
        bad('mesh.bin ' + err)
    if err2:
        bad('frames.bin ' + err2)
    if mh is None or fh is None:
        out['elapsed_s'] = round(time.time() - t0, 2)
        return out
    out['mesh_header'] = dict(units_system=mh.get('units_system'), counts=mh.get('counts'),
                              parts=len(mh.get('parts', [])), groups=len(mh.get('surf_groups', [])),
                              particles=mh.get('particles'))
    out['frames_header'] = dict(nframes=fh.get('nframes'), frame_bytes=fh.get('frame_bytes'),
                                fields=[f['id'] for f in fh.get('fields', [])])
    # 块边界自洽（头的总长 = magic + u32 + header_json）
    msz = os.path.getsize(mesh_path)
    hdr_size = 8 + len(json.dumps(mh, ensure_ascii=False).encode('utf-8'))
    for name, spec in (('coords', mh.get('coords')), ('conn', mh.get('conn'))):
        if spec and spec['offset'] + spec['len'] * _dtype_bytes(spec['dtype']) > msz - hdr_size:
            bad(f'mesh 块 {name} 越界')
    for g in mh.get('surf_groups', []):
        for k2 in ('faces', 'owner_elem', 'ecent'):
            s = g[k2]
            if s['offset'] + s['len'] * _dtype_bytes(s['dtype']) > msz - hdr_size:
                bad(f"mesh 块 part{g['partId']}.{k2} 越界")
    # 帧索引自洽（第 7 步：每帧独立压缩块，偏移/长度由 frames 索引给出）
    fb = fh.get('frame_bytes')
    fsz = os.path.getsize(fr_path)
    frecs = fh.get('frames') or []
    fbase = fh.get('frames_base', 9 +
                   len(json.dumps(fh, ensure_ascii=False).encode('utf-8')))
    codec = fh.get('codec', 'none')
    if not frecs:
        bad('frames 索引为空')
    else:
        if frecs[0]['offset'] != fbase:
            bad(f"首帧 offset {frecs[0]['offset']} != frames_base {fbase}")
        for j, r in enumerate(frecs):
            if r['offset'] + r['len'] > fsz:
                bad(f"帧 {j} 块越界 {r['offset']}+{r['len']} > {fsz}")
        # P0-4：帧块区之后可能追加 globals_all 独立块（8 字节对齐 → 中间有 0~7 字节填充）
        ga = fh.get('globals_all')
        fr_end = frecs[-1]['offset'] + frecs[-1]['len']
        if ga:
            gstart = fbase + ga['offset']
            if not (fr_end <= gstart < fr_end + 8):
                bad(f"帧块区/globals_all 间隙异常: 帧末 {fr_end}, globals 起点 {gstart}（填充须 <8）")
            gend = gstart + ga['len'] * _dtype_bytes(ga['dtype'])
            if gend != fsz:
                bad(f"globals_all 块未铺满: 末 {gend} != 文件 {fsz}")
        elif fr_end != fsz:
            bad(f"帧块区未铺满: 末帧末 {fr_end} != 文件 {fsz}")
    if len(fh.get('fields', [])) != len(plan_fields):
        bad('字段数与写入计划不一致')
    # 表面质量（从容器重读）
    with open(mesh_path, 'rb') as f:
        f.seek(hdr_size)
        for g in mh.get('surf_groups', []):
            f.seek(hdr_size + g['faces']['offset'])
            faces = np.frombuffer(f.read(g['faces']['len'] * 4), dtype='<i4')
            out.setdefault('surf_check', []).append(
                dict(partId=g['partId'], **surf_quality(faces.reshape(-1, 4), numnp)))
    # 抽样对比
    rng = np.random.RandomState(seed)
    nfr = fh['nframes']
    idx = sorted(set([0, int(nfr) - 1] + [int(x)
                 for x in rng.randint(0, nfr, max(1, n_sample - 2))]))
    rules, _ = part_rules_of(ctx, load_fm(ctx))
    part_of_elem = ctx['conn'][:, 8].astype(np.int32)
    coords0 = ctx['coords']
    w_e = elem_volumes(coords0, (ctx['conn'][:, :8] - 1).astype(np.int32))
    w8 = np.repeat(w_e, 8)
    flat = (ctx['conn'][:, :8] - 1).astype(np.int32).ravel()
    meta_of = {s['id']: s for s in fh['fields']}

    def decode_vals(buf):
        """按 fields 布局解码一帧；u2 字段按 scale/offset 还原（与前端同一口径）"""
        o, vals = 0, {}
        for spec in fh['fields']:
            n2 = spec['count'] * _dtype_bytes(spec['dtype'])
            seg = buf[o:o + n2]
            o += n2
            if spec['dtype'] == 'u1':
                vals[spec['id']] = np.frombuffer(seg, dtype='<u1')
            elif spec['dtype'] == 'u2':
                raw = np.frombuffer(seg, dtype='<u2').astype(np.float64)
                vals[spec['id']] = (raw * spec['scale'] +
                                    spec['offset']).astype(np.float32)
            else:
                vals[spec['id']] = np.frombuffer(seg, dtype='<f4')
        return vals

    def close(fid, val, ref):
        """u2 字段容差 = 量化步长/2（scale/2）；f4 字段沿用 rtol 1e-4"""
        sp = meta_of[fid]
        if sp['dtype'] == 'u2':
            atol = abs(sp['scale']) * 0.5 * 1.001 + 1e-6 * \
                max(1.0, float(np.abs(ref).max()))
            return bool(np.allclose(val, ref, rtol=0.0, atol=atol))
        return bool(np.allclose(val, ref, rtol=1e-4,
                                atol=1e-4 * max(1.0, float(np.abs(ref).max()))))

    pos_of = {}
    zdec = _zstd.ZstdDecompressor() if (codec == 'zstd' and _zstd) else None
    with open(fr_path, 'rb') as f:
        for i in idx:
            r = frecs[i]
            f.seek(r['offset'])
            buf = f.read(r['len'])
            if zdec is not None:
                buf = zdec.decompress(
                    buf, max_output_size=int(r.get('usize', fb)))
            vals = decode_vals(buf)
            path, offw = res['where'][i]
            st = read_state(path, offw // blk['stride'], blk, ws,
                            ['coords', 'solid_hist', 'solid_part', 'sph', 'pbm'])
            cd = st['coords'].reshape(-1, 3)
            u_ref = (cd - coords0.astype(np.float64)
                     ).astype(np.float32).ravel()
            ok_u = close('u', vals['u'], u_ref)
            ed = st['solid_hist'].reshape(nel, nv)
            eff = extract_element_fields(ed, part_of_elem, rules, nel, [
                                         'damage', 'eps', 'pressure'])
            exp_act = np.packbits(st['solid_part'].astype(
                np.int32) != 0, bitorder='little')
            ok_mask = bool(np.array_equal(vals['active_mask'], exp_act))
            dmg_loc = meta_of['damage']['location']
            if dmg_loc == 'node':
                dmg_ref = elem_to_node(eff['damage'], flat, w8, numnp)
                # SPH 节点的损伤来自粒子记录 w29（与写入时同一规则），验证须一并复算。
                # 粒子节点集合以容器里 particles[].nodes 为准（sph1 恰为尾段、sph2 为散布集合）。
                prt_s = next((p for p in mh.get('particles', [])
                              if p.get('kind') == 'sph'), None)
                n_sph_v = int(prt_s['n']) if prt_s else 0
                if n_sph_v and st.get('sph') is not None:
                    rec = blk['by_name']['sph']['words'] // n_sph_v
                    s2 = st['sph'].reshape(n_sph_v, rec)
                    if rec > 29:
                        spd = np.clip(s2[:, 29], 0, None).astype(np.float32)
                        if prt_s.get('nodes'):
                            with open(mesh_path, 'rb') as mf:
                                mf.seek(hdr_size + prt_s['nodes']['offset'])
                                nd = np.frombuffer(mf.read(prt_s['nodes']['len'] * 4),
                                                   dtype='<i4')
                            dmg_ref[nd] = spd
                        else:
                            # 旧容器（无 nodes 块）回退
                            dmg_ref[numnp - n_sph_v:] = spd
            else:
                dmg_ref = eff['damage']
            ok_dmg = close('damage', vals['damage'],
                           dmg_ref.astype(np.float32))
            pos_of[str(int(i))] = dict(t=fh['times'][i], ok_u=bool(ok_u), ok_mask=ok_mask,
                                       ok_damage=bool(ok_dmg),
                                       max_abs_diff_u=float(
                                           np.abs(vals['u'] - u_ref).max()),
                                       active=int((st['solid_part'] != 0).sum()))
            if not (ok_u and ok_mask and ok_dmg):
                bad(f'帧 {i} 抽样对比未通过: u={ok_u} mask={ok_mask} damage={ok_dmg}')
    out['frames_checked'] = pos_of
    out['elapsed_s'] = round(time.time() - t0, 2)
    return out


def load_fm(ctx):
    p = os.path.join(CFG, 'fieldmaps.json')
    return json.load(open(p, encoding='utf-8'))


def main():
    ap = argparse.ArgumentParser(
        description='通用 d3plot → Web 转换器 (probe / all)')
    ap.add_argument('dirs', nargs='+', help='一个或多个 d3plot 目录')
    ap.add_argument('--key', default=None)
    ap.add_argument('--label', default=None)
    ap.add_argument('--k', default=None, dest='kfile',
                    help='关键字文件(默认自动查找同目录最大 .k)')
    ap.add_argument('--parts', default=None, help='手工覆盖角色，如 1=structure,2=air')
    ap.add_argument('--units', default=None,
                    help='强制单位制: g-cm-µs | g-mm-ms | kg-mm-ms | t-mm-s | kg-m-s')
    ap.add_argument('--fieldmap', default=None)
    ap.add_argument('--field-location', default='node',
                    choices=['node', 'element'])
    ap.add_argument('--precision', default='auto', choices=['auto', 'f4', 'u2'],
                    help='字段存储精度：auto=按字段表（默认）；f4=除掩膜外全 f4（无损）；'
                         'u2=标量/矢量量化，stress/hist/pbm_pos 仍 f4')
    ap.add_argument('--extract', default='', help='可选层(逗号分隔): stress,velocity,acceleration,'
                    'sph,hist | all')
    ap.add_argument('--stage', default='probe', choices=['probe', 'all'])
    ap.add_argument('--out', default=None,
                    help=f'输出目录(probe 默认 {REPORTS}, all 默认 {DATA_V3})')
    ap.add_argument('--verify', action='store_true',
                    help='写容器后抽样与 d3plot 逐帧对比(真审计)')
    ap.add_argument('--frames-limit', type=int,
                    default=None, help='只写前 N 帧(调试用)')
    ap.add_argument('--compress', default='zstd', choices=['zstd', 'none'],
                    help='每帧块压缩编解码器（zstd 需 pip install zstandard；默认 zstd）')
    ap.add_argument('--zstd-level', type=int,
                    default=9, help='zstd 压缩级别（默认 9）')
    ap.add_argument('--json', action='store_true', help='只输出 JSON 摘要')
    args = ap.parse_args()

    override = None
    if args.parts:
        override = {}
        for kv in args.parts.split(','):
            k, v = kv.split('=')
            override[int(k)] = v
    extracts = [x.strip() for x in args.extract.split(',') if x.strip()]
    for x in extracts:
        if x not in EXTRACT_LAYERS:
            raise SystemExit(f'未知可选层: {x}（可用: {",".join(EXTRACT_LAYERS)}）')
    keys = []
    for d in args.dirs:
        key = args.key or os.path.basename(
            os.path.normpath(d)).strip() or 'case'
        key = ''.join(ch if (ch.isalnum() and ch.isascii())
                      or ch in '_-' else '_' for ch in key)
        keys.append((d, key, args.label or key))

    if args.stage == 'all':
        outdir = args.out or DATA_V3
        os.makedirs(outdir, exist_ok=True)
        reps = []
        for d, key, label in keys:
            try:
                rep = convert_one(d, key, label, args.kfile, override, args.units,
                                  extracts, args.field_location, args.fieldmap,
                                  outdir, args.verify, args.frames_limit, print,
                                  args.compress, args.zstd_level, args.precision)
                reps.append(rep)
            except SystemExit as e:
                print(f'[{key}] 中止: {e}')
                reps.append(dict(key=key, ok=False, fatal=str(e)))
        if args.json:
            print(json.dumps(reps, ensure_ascii=False, indent=1))
        return

    outdir = args.out or REPORTS
    os.makedirs(outdir, exist_ok=True)
    reps = []
    for d, key, label in keys:
        rep = probe_one(d, key, label, args.kfile, override, outdir)
        reps.append(rep)
        p = os.path.join(outdir, f'{key}.probe.json')
        json.dump(rep, open(p, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        if not args.json:
            print('=' * 78)
            print(f"[{key}] {d}")
            if rep.get('fatal'):
                print('  ✗ ' + rep['fatal'])
                continue
            print(f"  字长 {rep['ws']}B | numnp={rep['header']['numnp']} nel8={rep['header']['nel8']} "
                  f"nglbv={rep['header']['nglbv']} nv3d={rep['header']['nv3d']} nmsph={rep['header']['nmsph']}")
            print(f"  版本: {rep['version']['raw']} → {rep['version']['normalized']} "
                  f"({rep['version']['solver']}) | .k: {rep['k_file']} "
                  f"(parts={rep['k_summary']['parts']} deto={rep['k_summary']['deto']} "
                  f"endtim={rep['k_summary']['endtim']})")
            lp = rep['layout_probe']
            print(f"  布局库: {lp.get('library_entry')} ({lp.get('library_match')}) "
                  f"| 探测{'命中' if lp['hit'] else '未命中(用了最优候选)'} → {lp['accepted']}")
            print(f"    stride={lp['stride']} tail={lp['tail']} n_sph={lp['n_sph']} n_pbm={lp['n_pbm']}"
                  f" rec_sph={lp['rec_sph']} rec_pbm={lp['rec_pbm']}")
            print(f"    指纹: {lp['fp_msg']} | 未通过项: {lp['reasons']}")
            st = rep['states']
            print(f"  状态: 共 {st['total']} 个 | 逐文件: " +
                  ', '.join(f"{r['file']}:{r['states']}" for r in st['per_file'][:8]) +
                  (' ...' if len(st['per_file']) > 8 else ''))
            if st.get('times_sample'):
                print(f"    时间样本: {st['times_sample']}")
            print('  部件:')
            for p2 in rep['parts'][:8]:
                print(f"    pid{p2['pid']:>4} 单元{p2['elems']:>8} 角色{','.join(p2['roles']):<12}"
                      f" {p2.get('mat', '?')} {p2['basis']}")
            u = rep['units']
            print(
                f"  单位: {u['pick']} (置信度 {u['confidence']}) | {'; '.join(u['basis'])}")
            print('    候选: ' + ' | '.join(
                f"{r['system']}: L={r['model_span_m']}{'OK' if r['ok_span'] else '×'} "
                f"T={r['total_time_s']:.3g}s{'OK' if r['ok_time'] else '×'} "
                f"PPV={r['ppv_m_s']}{'OK' if r['ok_ppv'] else '×'} "
                f"p={r['pressure_pa']}Pa{'OK' if r['ok_pressure'] else '×'} 得分{r['score']}/4"
                for r in u['candidates']))
            print(f"    模型尺度(模型单位) span={rep.get('span_model_units')}")
            cc = rep.get('cross_check')
            if isinstance(cc, dict):
                print(f"  交叉核对(cases.json): 帧 {cc['old_nframes']} vs 探测 {cc['probe_states']}"
                      f" -> {'一致' if cc['match_frames'] else '不一致'} ; "
                      f"NEL {cc['old_NEL']} vs {cc['probe_nel']} -> {'一致' if cc['match_nel'] else '不一致'}")
            print(
                f"  用时 {rep['elapsed_s']}s → {os.path.join(outdir, key + '.probe.json')}")
    if args.json:
        print(json.dumps(reps, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
