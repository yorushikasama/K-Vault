#!/usr/bin/env python3
"""Local HTTP CONNECT proxy that forwards through the deployment server.

Why this exists: github.com is unreachable on 443 from this machine, so pushes
and fetches cannot go out directly. The deployment server can reach GitHub, so
we tunnel through it over SSH.

Why it must speak HTTP CONNECT rather than piping bytes: git opens the tunnel
with `CONNECT github.com:443 HTTP/1.1` and then waits for a status line. A raw
byte pipe looks like it works (the listener accepts, the channel opens) but git
aborts with "Proxy CONNECT aborted" because nothing ever answers that request.
So this parses the CONNECT request, opens a direct-tcpip channel to the target,
replies `HTTP/1.1 200 Connection Established`, and only then shuttles bytes.

Usage:
    YV_SSH_PASSWORD=... python scripts/gh-tunnel.py [--port 8899] [--host github.com]

Then point git at it:
    git -c http.proxy=http://127.0.0.1:8899 push origin main

The password is read from the environment so it never lands in argv or history.
"""
import argparse
import os
import select
import socket
import sys
import threading

import paramiko

HOST = os.environ.get("YV_SSH_HOST", "103.117.139.31")
USER = os.environ.get("YV_SSH_USER", "wbadmin")
PASSWORD = os.environ.get("YV_SSH_PASSWORD", "") or os.environ.get("KV_SSH_PASSWORD", "")


def log(message):
    sys.stderr.write("[gh-tunnel] %s\n" % message)
    sys.stderr.flush()


def read_request_head(conn):
    """Read the CONNECT request head (terminated by a blank line)."""
    buf = b""
    while b"\r\n\r\n" not in buf and b"\n\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > 65536:
            return None
    head, _, rest = buf.partition(b"\r\n\r\n")
    if not rest:
        head, _, rest = buf.partition(b"\n\n")
    return head.decode("iso-8859-1", "replace"), rest


def shuttle(client, channel):
    """Copy bytes both ways until either side closes."""
    try:
        while True:
            readable, _, _ = select.select([client, channel], [], [], 30)
            if not readable:
                continue
            for src in readable:
                data = src.recv(65536)
                if not data:
                    return
                if src is client:
                    channel.sendall(data)
                else:
                    client.sendall(data)
    except Exception:
        return


def handle(conn, transport, args):
    try:
        parsed = read_request_head(conn)
        if not parsed:
            return
        head, leftover = parsed
        lines = head.splitlines()
        if not lines:
            return
        parts = lines[0].split()
        if len(parts) < 2 or parts[0].upper() != "CONNECT":
            conn.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        target = parts[1]
        if ":" in target:
            host, _, port_text = target.rpartition(":")
        else:
            host, port_text = target, "443"
        try:
            port = int(port_text)
        except ValueError:
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return

        try:
            channel = transport.open_channel(
                "direct-tcpip", (host, port), ("127.0.0.1", 0), timeout=30
            )
        except Exception as exc:
            log("channel to %s:%d failed: %s" % (host, port, exc))
            conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return

        conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        if leftover:
            channel.sendall(leftover)
        log("tunnelling %s:%d" % (host, port))
        shuttle(conn, channel)
        channel.close()
    except Exception as exc:
        log("handler error: %s" % exc)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    if not PASSWORD:
        log("YV_SSH_PASSWORD (or KV_SSH_PASSWORD) is not set")
        return 2

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        port=int(os.environ.get("YV_SSH_PORT", "22")),
        username=USER,
        password=PASSWORD,
        timeout=30,
        banner_timeout=30,
        auth_timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    transport = client.get_transport()
    transport.set_keepalive(30)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.bind, args.port))
    server.listen(16)
    log("listening on %s:%d via %s" % (args.bind, args.port, HOST))

    try:
        while True:
            conn, _ = server.accept()
            threading.Thread(
                target=handle, args=(conn, transport, args), daemon=True
            ).start()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
