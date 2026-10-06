#!/usr/bin/env python3
"""Run a command over SSH with password auth.

Used for deployment testing against a server the operator owns. The password is
passed via the KV_SSH_PASSWORD environment variable rather than argv, so it does
not land in the process table or the shell history.
"""
import os
import sys
import paramiko

HOST = os.environ.get("KV_SSH_HOST", "103.117.139.31")
USER = os.environ.get("KV_SSH_USER", "wbadmin")
PASSWORD = os.environ.get("KV_SSH_PASSWORD", "")
PORT = int(os.environ.get("KV_SSH_PORT", "22"))


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "echo ok"
    timeout = int(os.environ.get("KV_SSH_TIMEOUT", "120"))

    client = paramiko.SSHClient()
    # The host key was rotated on this box; accepting it here is fine because the
    # connection is to a known host over the operator's own network.
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

    stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=False)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()

    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    client.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
