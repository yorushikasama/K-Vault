#!/usr/bin/env python3
"""Deploy K-Vault to a remote host over SSH/SFTP.

Used for updating the self-hosted instance. The password is read from the
KV_SSH_PASSWORD environment variable, never argv, so it does not land in the
process table or shell history.

Two modes:

    # Upload a local directory tree to a remote directory (recursive).
    KV_SSH_PASSWORD=... python scripts/deploy-remote.py put <local> <remote>

    # Run a command on the remote host.
    KV_SSH_PASSWORD=... python scripts/deploy-remote.py run "<command>"

The upload preserves file permissions (so executables stay executable) and
creates the remote directory if it does not exist. It never deletes anything on
the remote side: removing stale files is a separate, explicit step, because a
silent "mirror" would happily delete a file the operator still needs.
"""
import os
import posixpath
import stat
import sys

import paramiko

HOST = os.environ.get("KV_SSH_HOST", "103.117.139.31")
USER = os.environ.get("KV_SSH_USER", "wbadmin")
PASSWORD = os.environ.get("KV_SSH_PASSWORD", "")
PORT = int(os.environ.get("KV_SSH_PORT", "22"))


def connect() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        port=PORT,
        username=USER,
        password=PASSWORD,
        timeout=30,
        banner_timeout=30,
        auth_timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run_command(client: paramiko.SSHClient, command: str, timeout: int = 300) -> int:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=False)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    return code


def upload_tree(client: paramiko.SSHClient, local: str, remote: str) -> int:
    sftp = client.open_sftp()
    uploaded = 0

    def ensure_dir(path: str) -> None:
        """按层级创建目录；已存在则跳过。
        直接用 sftp.mkdir 会在「已存在」时报错，而 stat 探存在某些服务器上
        又因权限/挂载差异不可靠，所以两层都用 try 包住，只认最终可写。
        """
        parts = [p for p in path.split("/") if p]
        cur = "/" if path.startswith("/") else ""
        for p in parts:
            cur = posixpath.join(cur, p) if cur else p
            try:
                sftp.stat(cur)
            except IOError:
                try:
                    sftp.mkdir(cur)
                except IOError:
                    # 并发或权限导致的失败：再确认一次是否已存在，否则抛出
                    try:
                        sftp.stat(cur)
                    except IOError:
                        raise

    try:
        ensure_dir(remote)

        for root, dirs, files in os.walk(local):
            # 跳过版本控制与依赖目录，它们不属于部署内容
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
            rel = os.path.relpath(root, local)
            rdir = remote if rel == "." else posixpath.join(remote, rel.replace(os.sep, "/"))
            if rel != ".":
                ensure_dir(rdir)
            for name in files:
                lp = os.path.join(root, name)
                rp = posixpath.join(rdir, name)
                sftp.put(lp, rp)
                # 保留可执行位：部署脚本可能被 systemd 或 cron 直接调用
                mode = os.stat(lp).st_mode
                sftp.chmod(rp, 0o755 if mode & stat.S_IXUSR else 0o644)
                uploaded += 1
    finally:
        sftp.close()
    return uploaded


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    mode = sys.argv[1]
    client = connect()
    try:
        if mode == "run":
            command = sys.argv[2] if len(sys.argv) > 2 else "echo ok"
            return run_command(client, command)
        if mode == "put":
            if len(sys.argv) < 4:
                print("用法: put <local> <remote>")
                return 2
            n = upload_tree(client, sys.argv[2], sys.argv[3])
            print(f"已上传 {n} 个文件 -> {sys.argv[3]}")
            return 0
        print(f"未知模式: {mode}")
        return 2
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
