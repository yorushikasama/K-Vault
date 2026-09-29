"""K-Vault 抖音游客 Cookie 抓取器。

以服务器自身 IP 访问 douyin.com 抓游客 Cookie（无需登录账号），写成 Netscape
cookies.txt 供 MEDIA_RESOLVE_COOKIES_FILE 使用。写入采用"验证通过才原子替换"：
先用候选文件实测一次解析，失败则保留旧文件，绝不把好 Cookie 换成坏的。

环境变量：
  DATA_DIR        Cookie 输出根目录（默认 /opt/k-vault/data）
  KV_PROBE_URL    用于验证的抖音链接（默认本仓库 README 里的示例）
"""

import asyncio
import json
import os
import subprocess
import sys
import time

from playwright.async_api import async_playwright

CHROME_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
DATA_DIR = os.environ.get("DATA_DIR", "/opt/k-vault/data")
OUT = os.path.join(DATA_DIR, "cookies", "douyin.cookies.txt")
PROBE_URL = os.environ.get("KV_PROBE_URL", "https://v.douyin.com/Mo-sO_XEbyg")
REQUIRED_COOKIES = {"ttwid", "s_v_web_id", "__ac_signature"}


def to_netscape(cookies):
    lines = [
        "# Netscape HTTP Cookie File",
        "# Auto-refreshed by kvault-douyin-cookies.service - do not commit.",
        "",
    ]
    for c in cookies:
        domain = c.get("domain") or ""
        include = "TRUE" if domain.startswith(".") else "FALSE"
        path = c.get("path") or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        expiry = int(c.get("expires") or 0)
        if expiry <= 0:
            expiry = int(time.time()) + 30 * 86400
        lines.append("\t".join([
            domain, include, path, secure, str(expiry),
            c.get("name", ""), c.get("value", ""),
        ]))
    return "\n".join(lines) + "\n"


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


async def harvest():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
        ])
        ctx = await browser.new_context(
            user_agent=CHROME_UA, locale="zh-CN",
            viewport={"width": 1280, "height": 800},
        )
        page = await ctx.new_page()
        await page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(7000)
        try:
            await page.goto("https://www.douyin.com/discover",
                            wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(6000)
        except Exception:
            pass
        cookies = await ctx.cookies()
        await browser.close()
        return cookies


def verify(path):
    """候选 Cookie 必须真的能解析，否则保留旧文件。"""
    r = subprocess.run(
        ["yt-dlp", "--no-playlist", "--no-config", "--no-warnings", "--no-progress",
         "--socket-timeout", "20", "--retries", "1", "--dump-single-json", "--skip-download",
         "--add-header", "Referer: https://www.douyin.com/",
         "--cookies", path, PROBE_URL],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0 or not r.stdout.strip():
        print(f"  verify FAILED (exit={r.returncode}) {r.stderr[-200:]}")
        return False
    try:
        data = json.loads(r.stdout)
        count = len(data.get("formats") or [])
        print(f"  verify OK: {count} formats")
        return count > 0
    except Exception as exc:
        print(f"  verify FAILED (json): {exc}")
        return False


async def main():
    cookies = await harvest()
    names = {c.get("name") for c in cookies}
    missing = REQUIRED_COOKIES - names
    print(f"  harvested {len(cookies)} cookies; missing={sorted(missing) if missing else 'none'}")
    if missing:
        print("  KEEPING OLD FILE (harvest incomplete)")
        sys.exit(1)

    candidate = OUT + ".candidate"
    write_atomic(candidate, to_netscape(cookies))
    if not verify(candidate):
        os.remove(candidate)
        print("  KEEPING OLD FILE (verification failed)")
        sys.exit(2)

    write_atomic(OUT, to_netscape(cookies))
    st = os.stat(OUT)
    print(f"  REFRESHED {OUT} ({len(cookies)} cookies, "
          f"mtime={time.strftime('%F %T', time.localtime(st.st_mtime))})")


asyncio.run(main())
