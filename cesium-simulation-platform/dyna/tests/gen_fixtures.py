"""生成容器 fixture（用于容器口径回归，不依赖 www 数据）。

用法:
  python tests/gen_fixtures.py [--src DIR] [--out DIR] [--key KEY] [--frames N] [--force]

默认:
  --src    C:/Users/allblack/Desktop/tnt/1   （任意含 d3plot 的目录）
  --out    tests/fixtures/container_v2
  --key    fixture_hexa
  --frames 2                                  （只取前 2 帧，控制体积 ≤5 MB）

产出:
  {out}/{key}.mesh.bin / {key}.frames.bin / cases.json
  {out}/expected.json  ← 关键期望值（供 validate_container.js 复核）
"""
import argparse
import json
import os
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = r'C:\Users\allblack\Desktop\tnt\1'
DEFAULT_OUT = os.path.join(ROOT, 'tests', 'fixtures', 'container_v2')
DEFAULT_KEY = 'fixture_hexa'


def read_header(path, magic_len):
    with open(path, 'rb') as f:
        f.read(magic_len)
        n = struct.unpack('<I', f.read(4))[0]
        return json.loads(f.read(n).decode('utf-8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC, help='含 d3plot 的目录')
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--key', default=DEFAULT_KEY)
    ap.add_argument('--frames', type=int, default=2)
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    out = os.path.abspath(args.out)
    if not os.path.isdir(src):
        raise SystemExit(f'源目录不存在: {src}')
    os.makedirs(out, exist_ok=True)
    mesh = os.path.join(out, args.key + '.mesh.bin')
    frames = os.path.join(out, args.key + '.frames.bin')
    if os.path.exists(mesh) and os.path.exists(frames) and not args.force:
        print(f'[skip] 已存在 fixture: {out}（--force 可重建）')
    else:
        cmd = [sys.executable, os.path.join(ROOT, 'dyna2web.py'), src,
               '--key', args.key, '--label', args.key,
               '--stage', 'all', '--compress', 'zstd', '--verify',
               '--frames-limit', str(args.frames),
               '--field-location', 'element',
               '--extract', 'velocity',
               '--precision', 'auto',
               '--out', out]
        print('运行:', ' '.join(cmd))
        subprocess.run(cmd, check=True)

    mh = read_header(mesh, 4)
    fh = read_header(frames, 5)
    exp = dict(
        key=args.key,
        schema_version=mh.get('schema_version'),
        counts=mh.get('counts'),
        units_system=mh.get('units_system'),
        id_source=mh.get('id_source'),
        nframes=fh.get('nframes'),
        frame_bytes=fh.get('frame_bytes'),
        fields=[dict(id=f['id'], dtype=f['dtype'], location=f['location'],
                     count=f['count'], comps=f.get('comps'))
                for f in fh.get('fields', [])],
    )
    with open(os.path.join(out, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(exp, f, ensure_ascii=False, indent=1)
    print(f'[ok] fixture: {out}')
    print(
        f"     nframes={exp['nframes']} fields={len(exp['fields'])} frame_bytes={exp['frame_bytes']}")


if __name__ == '__main__':
    main()
