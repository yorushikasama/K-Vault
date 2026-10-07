#!/usr/bin/env python3
"""Run a sudo command over SSH, feeding the password to stdin.

remote-ssh.py executes as the login user, so anything that needs root
(journalctl for the service unit, the deploy script) fails with
"sudo: a password is required" unless the password is piped in.

Password comes from KV_SSH_PASSWORD only, never argv.
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
    timeout = int(os.environ.get("KV_SSH_TIMEOUT", "180"))

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

    # get_pty=True gives sudo a tty so it reads the password from the prompt
    # rather than refusing when stdin isn't a terminal.
    stdin, stdout, stderr = client.exec_command(
        f"sudo -S -p '' {command}", timeout=timeout, get_pty=True
    )
    stdin.write(PASSWORD + "\n")
    stdin.flush()

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