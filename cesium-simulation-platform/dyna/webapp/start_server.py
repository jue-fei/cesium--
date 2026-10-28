# 隧道爆破数字孪生可视化平台 - 本地服务器 (含 d3plot 导入转换 API)
# 用法:  python start_server.py   然后浏览器打开 http://localhost:8765
#
# API:
#   POST /api/convert  {path, key?, label?, k?, layers?[]}
#                      → 启动 dyna2web.py(容器转换器) 后台子进程, 返回 {job}
#                        （第 8 步：legacy auto_convert.py 已下线，导入 API 改走容器管线）
#   GET  /api/job?id=  → {status: running|ok|fail, log}
#   GET  /api/field_spec → 返回 工作区/config/field_spec.json（字段注册表，前后端共享）
#   GET  /api/incoming → 列出 webapp/incoming/ 下含 d3plot 的子目录 (快捷导入)
#   GET  /api/cases    → 算例清单（MySQL 优先，经后端 /api/dyna/cases；后端不可用时回退 data_v3/cases.json）
#
# 算例信息（元数据）的唯一权威存储是 MySQL 的 dyna_cases 表；转换完成后会自动调用
# 后端 /api/dyna/sync 入库。容器本体（mesh.bin / frames.bin）仍落盘，由本服务 Range 读取。
# 后端地址可用环境变量 DYNA_BACKEND_URL 指定（默认 http://127.0.0.1:3003）。
#
# 静态文件支持 HTTP Range (206)：data_v3/ 的容器 frames.bin 可达数 GB，
# 前端按帧惰性读取，必须用本版本服务器（旧版无 Range 会退回 legacy 路径）。
import http.server
import socketserver
import os
import json
import subprocess
import threading
import uuid
import sys
import re
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs

WEBAPP = os.path.dirname(os.path.abspath(__file__))
os.chdir(WEBAPP)
PORT = 8765
WORKSPACE = os.path.dirname(WEBAPP)                 # 工作区目录
AUTO_CONVERT = os.path.join(WORKSPACE, 'dyna2web.py')   # 容器转换器（第 8 步后唯一管线）
INCOMING = os.path.join(WEBAPP, 'incoming')
os.makedirs(INCOMING, exist_ok=True)
BACKEND = os.environ.get(
    'DYNA_BACKEND_URL', 'http://127.0.0.1:3003').rstrip('/')

JOBS = {}   # jid → {status, log, code}


def _http_json(url, payload=None, timeout=3):
    """轻量 JSON 调用（不引第三方依赖）；失败返回 None。"""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(
        url, data=data, headers=headers,
        method='POST' if data is not None else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception:
        return None


def sync_case_to_db(key):
    """转换完成后把算例信息写入 MySQL（经后端 /api/dyna/sync）；失败不阻断转换。"""
    if not key:
        return False
    resp = _http_json(BACKEND + '/api/dyna/sync', {'key': key}, timeout=8)
    if isinstance(resp, dict) and resp.get('code') == 0:
        print(f"[dyna] 算例 {key} 已同步入库: {resp.get('synced')}")
        return True
    print(f"[dyna] 算例 {key} 入库失败（后端 {BACKEND} 不可用？可稍后跑 migrate_dyna.py）")
    return False


def run_job(jid, cmd):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding='utf-8', errors='replace',
                         cwd=WORKSPACE)
    JOBS[jid]['proc'] = p                      # 供 /api/cancel 终止
    JOBS[jid]['log'] = JOBS[jid].get('log', '')      # 保留调用方写入的前缀（如"已忽略的提取层"）
    for line in p.stdout:
        JOBS[jid]['log'] += line
        if len(JOBS[jid]['log']) > 60000:            # 防止日志无限膨胀
            JOBS[jid]['log'] = JOBS[jid]['log'][-40000:]
    p.wait()
    JOBS[jid]['code'] = p.returncode
    if JOBS[jid].get('status') != 'cancelled':       # 取消后不被 fail 覆盖
        JOBS[jid]['status'] = 'ok' if p.returncode == 0 else 'fail'
    if JOBS[jid].get('status') == 'ok':              # 转换成功 → 算例信息入库
        sync_case_to_db(JOBS[jid].get('key'))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_range(self, path, rng):
        """支持 HTTP Range (206)：容器 frames.bin 可达数 GB，前端按帧惰性读取"""
        try:
            size = os.path.getsize(path)
        except OSError:
            self.send_error(404, 'File not found')
            return
        m = re.fullmatch(r'bytes=(\d*)-(\d*)', rng.strip())
        if not m:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        s, e = m.group(1), m.group(2)
        if s == '':                                   # 后缀形式 bytes=-N (最后 N 字节)
            if e == '':
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            n = int(e)
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(s)
            end = min(int(e), size - 1) if e else size - 1
        if start > end or start >= size:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        n = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(n))
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            remaining = n
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_GET(self):
        if self.path == '/api/field_spec':
            # 字段注册表（前后端共享唯一源 = 工作区/config/field_spec.json）；前端 bootV3 读它生成 V3_FIELD_SPEC
            fp = os.path.join(WORKSPACE, 'config', 'field_spec.json')
            try:
                body = open(fp, 'rb').read()
            except OSError:
                self.send_error(404, 'field_spec.json missing: ' + fp)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith('/api/cases'):
            # 算例清单：MySQL 优先（后端代理），失败回退磁盘 cases.json
            db = _http_json(BACKEND + '/api/dyna/cases', timeout=4)
            if isinstance(db, dict) and isinstance(db.get('data'), dict) and db['data']:
                db['source'] = 'mysql'
                self._json(db)
                return
            fp = os.path.join(WEBAPP, 'data_v3', 'cases.json')
            try:
                body = json.loads(open(fp, encoding='utf-8').read())
            except OSError:
                self._json({'code': 1, 'data': {}, 'source': 'none',
                            'error': 'cases.json missing: ' + fp})
                return
            self._json({'code': 0, 'data': body, 'source': 'file'})
            return
        if self.path == '/api/incoming':
            items = []
            if os.path.isdir(INCOMING):
                for d in sorted(os.listdir(INCOMING)):
                    full = os.path.abspath(os.path.join(INCOMING, d))
                    if os.path.isdir(full) and any(
                            f == 'd3plot' or (f.startswith(
                                'd3plot') and f[6:].isdigit())
                            for f in os.listdir(full)):
                        items.append(full)
            self._json(items)
            return
        if self.path.startswith('/api/job'):
            jid = self.path.split('id=')[-1]
            job = dict(JOBS.get(jid, {'status': 'unknown', 'log': '未知任务'}))
            job.pop('proc', None)                # Popen 不可序列化
            self._json(job)
            return
        if self.path.startswith('/api/report'):
            q = parse_qs(urlparse(self.path).query)
            key = (q.get('key') or [''])[0]
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', key):
                self._json({'error': 'key 非法'}, 400)
                return
            fp = os.path.join(WORKSPACE, 'reports', key + '.report.json')
            try:
                body = open(fp, 'rb').read()
            except OSError:
                self._json({'error': '报告不存在: ' + fp}, 404)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        rng = self.headers.get('Range')
        if rng:
            path = self.translate_path(self.path)
            if os.path.isfile(path):
                self._serve_range(path, rng)
                return
        super().do_GET()

    def do_OPTIONS(self):
        # CORS 预检: 允许从其他端口(如 8765 静态页)跨域调用转换 API
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/cancel':
            try:
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(
                    n).decode('utf-8')) if n else {}
            except Exception as e:
                self._json({'error': f'请求解析失败: {e}'}, 400)
                return
            jid = (body.get('job') or '').strip()
            job = JOBS.get(jid)
            if not job:
                self._json({'error': '未知任务'}, 404)
                return
            if job.get('status') == 'running':
                job['status'] = 'cancelled'
                p = job.get('proc')
                if p and p.poll() is None:
                    try:
                        p.terminate()
                    except Exception:
                        pass
            self._json({'job': jid, 'status': job.get('status')})
            return
        if self.path == '/api/convert':
            try:
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n).decode('utf-8'))
            except Exception as e:
                self._json({'error': f'请求解析失败: {e}'}, 400)
                return
            path = (body.get('path') or '').strip().strip('"')
            if not os.path.isdir(path) or not os.path.exists(os.path.join(path, 'd3plot')):
                self._json({'error': f'目录无效或缺少 d3plot 基文件: {path}'}, 400)
                return
            key = (body.get('key') or '').strip(
            ) or os.path.basename(os.path.normpath(path))
            key = ''.join(ch if (ch.isalnum() and ch.isascii())
                          or ch in '_-' else '_' for ch in key)
            label = (body.get('label') or '').strip() or key
            raw_layers = body.get('layers') or []
            if not isinstance(raw_layers, list):
                raw_layers = []
            # 层名映射到容器 EXTRACT_LAYERS 支持集（stress/velocity/acceleration/sph）。
            # 前端导入面板已与该集合一致（批次2 U0-2）；此处只做白名单过滤，被丢弃项写入任务日志，不再静默忽略。
            SUPPORTED_LAYERS = ('stress', 'velocity', 'acceleration', 'sph')
            mapped = [x for x in raw_layers if x in SUPPORTED_LAYERS]
            dropped = [x for x in raw_layers if x not in SUPPORTED_LAYERS]
            if 'velocity' not in mapped:
                mapped.append('velocity')            # PPV 为核心指标，默认带上
            cmd = [sys.executable, AUTO_CONVERT, path,
                   '--key', key, '--label', label,
                   '--stage', 'all', '--compress', 'zstd', '--verify',
                   '--field-location', 'element',   # 与 data_v3 既有算例同口径（单元云图）
                   '--extract', ','.join(mapped)]
            k = (body.get('k') or '').strip()
            if k and os.path.exists(k):
                cmd += ['--k', k]
            jid = uuid.uuid4().hex[:8]
            warn = ('⚠ 已忽略不支持的提取层: ' + ', '.join(dropped) +
                    '\n') if dropped else ''
            JOBS[jid] = {'status': 'running', 'log': warn, 'key': key}
            threading.Thread(target=run_job, args=(
                jid, cmd), daemon=True).start()
            self._json({'job': jid, 'key': key})
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        pass  # 静默访问日志


httpd = None
for TRY_PORT in (8765, 8766, 8767):
    try:
        httpd = socketserver.ThreadingTCPServer(
            ("127.0.0.1", TRY_PORT), Handler)
        PORT = TRY_PORT
        break
    except OSError:
        print(f"端口 {TRY_PORT} 被占用, 尝试下一个…")
if httpd is None:
    raise SystemExit("8765/8766/8767 端口均被占用")
print(f"Serving at http://localhost:{PORT}  (Ctrl+C to stop)")
print(f"转换 API: POST /api/convert · 任务查询: /api/job?id= · incoming: {INCOMING}")
print(f"算例清单: GET /api/cases（MySQL 优先，后端 {BACKEND}）")
httpd.serve_forever()
