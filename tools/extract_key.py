#!/usr/bin/env python3
"""
extract_key.py — 在重签过的 QQ 副本上自动抓取 NTQQ 数据库密钥。

做法：
  1. 用系统自带 lldb（CLT 版，不需要 Xcode 许可）以 pty 子进程方式启动 QQ 副本；
  2. import qq_key_extractor.py（社区脚本，负责定位 nt_sqlite3_key_v2 并下断点）；
  3. 等 QQ 主界面出现后暂停 → qq-setbp → 继续；
  4. 用户点「登录」时断点命中，密钥被脚本打印，我们抓下来写进 dbkey.txt（chmod 600）；
  5. detach + 退出 lldb，QQ 副本继续活着（调用方随后关掉它）。

用法：
  python3 tools/extract_key.py --app ~/.dsh/career-planner/qq/app/QQ.app \
      --out ~/.dsh/career-planner/qq/dbkey.txt [--wait 600]

退出码：0 抓到密钥；1 超时/失败。
"""

from __future__ import annotations

import argparse
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time

LLDB_CANDIDATES = [
    "/Library/Developer/CommandLineTools/usr/bin/lldb",
    "/usr/bin/lldb",
]

KEY_RE = re.compile(r"KEY\s*:\s*(\S+)")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")


def find_lldb() -> str:
    for p in LLDB_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 lldb（请安装 Xcode Command Line Tools）")


class Pty:
    """极简 pty 驱动：能读、能写、能等模式出现。"""

    def __init__(self, argv: list[str]):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            os.execv(argv[0], argv)
            os._exit(127)
        self.buf = ""
        self.log: list[str] = []

    def read(self, timeout: float = 0.5) -> str:
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r:
            return ""
        try:
            chunk = os.read(self.fd, 65536)
        except OSError:
            return ""
        if not chunk:
            return ""
        text = chunk.decode("utf-8", errors="replace")
        self.buf += text
        self.log.append(text)
        sys.stdout.write(text)
        sys.stdout.flush()
        return text

    def write(self, text: str) -> None:
        os.write(self.fd, text.encode())

    def wait_for(self, pattern: str, timeout: float) -> bool:
        deadline = time.time() + timeout
        rx = re.compile(pattern)
        while time.time() < deadline:
            if rx.search(ANSI_RE.sub("", self.buf)):
                return True
            self.read(0.3)
        return False

    def drain(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            self.read(0.2)

    def interrupt(self) -> None:
        self.write("\x03")

    def close(self) -> None:
        try:
            os.kill(self.pid, signal.SIGTERM)
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True, help="重签过的 QQ.app 路径")
    ap.add_argument("--out", required=True, help="密钥输出文件")
    ap.add_argument("--wait", type=float, default=600, help="等用户登录的最长秒数")
    ap.add_argument("--boot-wait", type=float, default=12, help="启动后等 wrapper.node 加载的秒数")
    ap.add_argument("--hook", default="", help="qq_key_extractor.py 路径（默认用包内 tools/）")
    ap.add_argument("--data-dir", default="", help="传给 QQ 的 --user-data-dir（用副本数据目录就不会动原库）")
    args = ap.parse_args()

    app = os.path.expanduser(args.app)
    binary = os.path.join(app, "Contents", "MacOS", "QQ")
    if not os.path.exists(binary):
        print(f"[!] 找不到可执行文件：{binary}")
        return 1
    tool_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        args.hook and os.path.expanduser(args.hook),
        os.path.join(tool_dir, "qq_key_extractor.py"),
        os.path.expanduser("~/.dsh/career-planner/qq/tools/qq_key_extractor.py"),
    ]
    hook = next((c for c in candidates if c and os.path.exists(c)), None)
    if not hook:
        print("[!] 找不到 qq_key_extractor.py（可用 --hook 指定）")
        return 1

    lldb = find_lldb()
    print(f"[*] lldb     : {lldb}")
    print(f"[*] 目标进程 : {binary}")
    print("[*] 请在弹出的 QQ 窗口里扫码/登录（如果它自己登录了就无需操作）")

    p = Pty([lldb, "--no-lldbinit", binary])
    try:
        if not p.wait_for(r"\(lldb\)", 30):
            print("[!] lldb 没有起来")
            return 1
        p.write(f"command script import {hook}\n")
        p.drain(1.5)
        # 启动 QQ：先放行，让 wrapper.node 加载出来
        p.write("settings set target.process.stop-on-sharedlibrary-events false\n")
        if args.data_dir:
            data_dir = os.path.expanduser(args.data_dir)
            print(f"[*] 使用数据目录 : {data_dir}")
            p.write(f"settings set -- target.run-args --user-data-dir={data_dir}\n")
        p.write("run\n")
        p.drain(args.boot_wait)
        # 暂停 → 设断点 → 继续
        p.interrupt()
        p.drain(1.5)
        p.write("qq-setbp\n")
        p.drain(2.0)
        p.write("c\n")
        print("[*] 断点已就绪，等待登录……")

        deadline = time.time() + args.wait
        key = None
        while time.time() < deadline:
            p.read(0.5)
            m = KEY_RE.search(ANSI_RE.sub("", p.buf))
            if m:
                key = m.group(1)
                break
        if not key:
            print("[!] 超时：没有抓到密钥")
            return 1
        print(f"[+] 密钥长度 {len(key)}：{key[:4]}…（完整内容已写入 {args.out}）")
        out = os.path.expanduser(args.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(key + "\n")
        os.chmod(out, 0o600)
        # 放开进程，别把用户的 QQ 卡在断点上
        p.write("process detach\n")
        p.drain(2.0)
        p.write("quit\n")
        p.drain(1.0)
        return 0
    finally:
        p.close()
        try:
            subprocess.run(["pkill", "-f", f"{app}/Contents/MacOS/QQ"], timeout=5)
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
