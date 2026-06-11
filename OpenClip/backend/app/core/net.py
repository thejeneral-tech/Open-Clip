"""Network helpers.

On some networks the IPv6 route to certain hosts (notably ``huggingface.co``)
is broken in a nasty way: the TCP connection *succeeds*, but the subsequent
TLS handshake is reset (``WinError 10054``). Python resolves IPv6 first and
``socket.create_connection`` commits to that address the moment TCP connects,
so the later TLS reset has no chance to fall back to IPv4 — model downloads
fail intermittently.

``prefer_ipv4()`` reorders DNS results so IPv4 addresses are tried first,
leaving IPv6 as a real fallback (used only if IPv4 TCP connect fails). It does
*not* remove IPv6, so IPv6-only hosts still work. Set ``OPENCLIP_PREFER_IPV4=0``
to turn it off.
"""
from __future__ import annotations

import os
import socket

_patched = False


def prefer_ipv4() -> None:
    """Idempotently make DNS resolution return IPv4 results before IPv6."""
    global _patched
    if _patched or os.getenv("OPENCLIP_PREFER_IPV4", "1") == "0":
        return

    _orig_getaddrinfo = socket.getaddrinfo

    def _ipv4_first(host, port, family=0, type=0, proto=0, flags=0):  # noqa: A002
        results = _orig_getaddrinfo(host, port, family, type, proto, flags)
        # Stable sort: IPv4 (AF_INET) group moves ahead of IPv6, order preserved.
        results.sort(key=lambda r: 0 if r[0] == socket.AF_INET else 1)
        return results

    socket.getaddrinfo = _ipv4_first
    _patched = True
