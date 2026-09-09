#!/usr/bin/env python3
"""Hardware analysis MCP server (stdio, JSON-RPC 2.0).

Design notes
------------
* Core tools use the standard library only, so this runs with zero pip installs.
* Anything that genuinely needs a third-party package or real hardware reports
  exactly what is missing instead of returning fabricated data.
* Transport is MCP stdio: newline-delimited JSON-RPC on stdin/stdout.
  Nothing may be printed to stdout except protocol messages -- logs go to stderr.

Run `python server.py --selftest` to exercise the pure parsers.
"""

from __future__ import annotations

import json
import platform
import re
import struct
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

SERVER_NAME = "hardware-analysis"
SERVER_VERSION = "0.1.0"
DEFAULT_PROTOCOL = "2024-11-05"


def log(msg: str) -> None:
    """Diagnostics must go to stderr; stdout is reserved for the protocol."""
    print(f"[{SERVER_NAME}] {msg}", file=sys.stderr, flush=True)


# ─────────────────────────── USB descriptor parsing ───────────────────────────

# bDescriptorType -> (name, field spec) where spec is (offset, size, field name)
_DESC_TYPES = {
    0x01: "DEVICE",
    0x02: "CONFIGURATION",
    0x03: "STRING",
    0x04: "INTERFACE",
    0x05: "ENDPOINT",
    0x0B: "INTERFACE_ASSOCIATION",
    0x21: "HID",
    0x24: "CS_INTERFACE",
    0x25: "CS_ENDPOINT",
}

_CLASS_NAMES = {
    0x00: "Per-interface",
    0x01: "Audio",
    0x02: "CDC Control",
    0x03: "HID",
    0x05: "Physical",
    0x06: "Image",
    0x07: "Printer",
    0x08: "Mass Storage",
    0x09: "Hub",
    0x0A: "CDC Data",
    0x0B: "Smart Card",
    0x0E: "Video",
    0xE0: "Wireless Controller",
    0xFF: "Vendor Specific",
}

_XFER_TYPES = {0: "Control", 1: "Isochronous", 2: "Bulk", 3: "Interrupt"}


def _hex_to_bytes(text: str) -> bytes:
    """Accept '12 01 00 02', '1201 0002', '0x12,0x01' and similar."""
    cleaned = re.sub(r"0[xX]", " ", text)
    cleaned = re.sub(r"[^0-9a-fA-F]", " ", cleaned)
    tokens = cleaned.split()
    if all(len(t) == 2 for t in tokens) and tokens:
        return bytes(int(t, 16) for t in tokens)
    joined = "".join(tokens)
    if len(joined) % 2:
        raise ValueError("hex string has an odd number of digits")
    return bytes.fromhex(joined)


def _bcd(value: int) -> str:
    return f"{value >> 8:x}.{(value >> 4) & 0xF:x}{value & 0xF:x}"


def parse_usb_descriptors(data: bytes) -> list[dict[str, Any]]:
    """Walk a descriptor blob using each descriptor's own bLength."""
    out: list[dict[str, Any]] = []
    i = 0
    while i < len(data):
        length = data[i]
        if length == 0:
            out.append({"offset": i, "error": "bLength == 0, stopping to avoid a loop"})
            break
        if i + length > len(data):
            out.append(
                {
                    "offset": i,
                    "error": f"bLength {length} runs past end of data "
                    f"({len(data) - i} bytes left)",
                }
            )
            break
        chunk = data[i : i + length]
        dtype = chunk[1] if length > 1 else -1
        item: dict[str, Any] = {
            "offset": i,
            "bLength": length,
            "bDescriptorType": f"0x{dtype:02X}" if dtype >= 0 else "?",
            "type": _DESC_TYPES.get(dtype, "UNKNOWN"),
            "raw": chunk.hex(" "),
        }

        try:
            if dtype == 0x01 and length >= 18:
                (
                    bcd_usb, dclass, dsub, dproto, maxp, vid, pid, bcd_dev,
                    imanu, iprod, iserial, nconf,
                ) = struct.unpack("<HBBBBHHHBBBB", chunk[2:18])
                item.update(
                    bcdUSB=_bcd(bcd_usb),
                    bDeviceClass=f"0x{dclass:02X} ({_CLASS_NAMES.get(dclass, 'Unknown')})",
                    bDeviceSubClass=f"0x{dsub:02X}",
                    bDeviceProtocol=f"0x{dproto:02X}",
                    bMaxPacketSize0=maxp,
                    idVendor=f"0x{vid:04X}",
                    idProduct=f"0x{pid:04X}",
                    bcdDevice=_bcd(bcd_dev),
                    iManufacturer=imanu,
                    iProduct=iprod,
                    iSerialNumber=iserial,
                    bNumConfigurations=nconf,
                )
            elif dtype == 0x02 and length >= 9:
                total, nifaces, cval, iconf, attrs, maxpower = struct.unpack(
                    "<HBBBBB", chunk[2:9]
                )
                item.update(
                    wTotalLength=total,
                    bNumInterfaces=nifaces,
                    bConfigurationValue=cval,
                    iConfiguration=iconf,
                    bmAttributes=f"0x{attrs:02X}",
                    selfPowered=bool(attrs & 0x40),
                    remoteWakeup=bool(attrs & 0x20),
                    maxPower_mA=maxpower * 2,
                )
            elif dtype == 0x04 and length >= 9:
                (inum, alt, neps, icls, isub, iproto, iiface) = struct.unpack(
                    "<BBBBBBB", chunk[2:9]
                )
                item.update(
                    bInterfaceNumber=inum,
                    bAlternateSetting=alt,
                    bNumEndpoints=neps,
                    bInterfaceClass=f"0x{icls:02X} ({_CLASS_NAMES.get(icls, 'Unknown')})",
                    bInterfaceSubClass=f"0x{isub:02X}",
                    bInterfaceProtocol=f"0x{iproto:02X}",
                    iInterface=iiface,
                )
            elif dtype == 0x05 and length >= 7:
                addr, attrs, maxpkt, interval = struct.unpack("<BBHB", chunk[2:7])
                item.update(
                    bEndpointAddress=f"0x{addr:02X}",
                    direction="IN" if addr & 0x80 else "OUT",
                    endpointNumber=addr & 0x0F,
                    transferType=_XFER_TYPES.get(attrs & 0x03, "?"),
                    wMaxPacketSize=maxpkt,
                    bInterval=interval,
                )
            elif dtype == 0x03 and length > 2:
                try:
                    item["string"] = chunk[2:].decode("utf-16-le", errors="replace")
                except Exception:  # pragma: no cover - defensive
                    pass
        except struct.error as exc:
            item["error"] = f"truncated descriptor: {exc}"

        out.append(item)
        i += length
    return out


# ───────────────────────────────── pcap reading ───────────────────────────────

_LINKTYPES = {
    0: "NULL",
    1: "ETHERNET",
    101: "RAW",
    189: "USB_LINUX",
    220: "USB_LINUX_MMAPPED",
    249: "USBPCAP",
}


def _read_pcap(path: Path, limit: int) -> dict[str, Any]:
    """Classic libpcap. Returns header info plus per-packet lengths/timestamps."""
    with path.open("rb") as fh:
        gh = fh.read(24)
        if len(gh) < 24:
            raise ValueError("file is too short to be a pcap")
        magic = gh[:4]
        if magic == b"\xd4\xc3\xb2\xa1":
            endian, nano = "<", False
        elif magic == b"\xa1\xb2\xc3\xd4":
            endian, nano = ">", False
        elif magic == b"\x4d\x3c\xb2\xa1":
            endian, nano = "<", True
        elif magic == b"\xa1\xb2\x3c\x4d":
            endian, nano = ">", True
        else:
            raise ValueError(f"not a classic pcap file (magic {magic.hex()})")

        _vmaj, _vmin, _tz, _sf, snaplen, linktype = struct.unpack(
            endian + "HHiIII", gh[4:24]
        )
        packets: list[dict[str, Any]] = []
        count = 0
        first_ts = last_ts = None
        while True:
            ph = fh.read(16)
            if len(ph) < 16:
                break
            ts_sec, ts_frac, incl, orig = struct.unpack(endian + "IIII", ph)
            body = fh.read(incl)
            if len(body) < incl:
                break
            ts = ts_sec + ts_frac / (1e9 if nano else 1e6)
            first_ts = ts if first_ts is None else first_ts
            last_ts = ts
            count += 1
            if len(packets) < limit:
                packets.append(
                    {"index": count, "ts": round(ts, 6), "caplen": incl, "wirelen": orig}
                )
        return {
            "format": "pcap",
            "linktype": linktype,
            "linktypeName": _LINKTYPES.get(linktype, f"UNKNOWN({linktype})"),
            "snaplen": snaplen,
            "packetCount": count,
            "firstTimestamp": first_ts,
            "lastTimestamp": last_ts,
            "packets": packets,
        }


def _read_pcapng(path: Path, limit: int) -> dict[str, Any]:
    """Minimal pcapng: enough to count packets and read link type from the IDB."""
    with path.open("rb") as fh:
        data = fh.read()
    if len(data) < 12 or data[:4] != b"\x0a\x0d\x0d\x0a":
        raise ValueError("not a pcapng file")
    bom = data[8:12]
    endian = "<" if bom == b"\x4d\x3c\x2b\x1a" else ">"

    off = 0
    linktype = None
    count = 0
    packets: list[dict[str, Any]] = []
    while off + 12 <= len(data):
        btype, blen = struct.unpack(endian + "II", data[off : off + 8])
        if blen < 12 or off + blen > len(data):
            break
        body = data[off + 8 : off + blen - 4]
        if btype == 0x00000001 and len(body) >= 4:  # Interface Description Block
            linktype = struct.unpack(endian + "H", body[0:2])[0]
        elif btype == 0x00000006 and len(body) >= 20:  # Enhanced Packet Block
            _iface, ts_hi, ts_lo, caplen, wirelen = struct.unpack(
                endian + "IIIII", body[0:20]
            )
            count += 1
            if len(packets) < limit:
                packets.append(
                    {
                        "index": count,
                        "tsRaw": (ts_hi << 32) | ts_lo,
                        "caplen": caplen,
                        "wirelen": wirelen,
                    }
                )
        off += blen
    return {
        "format": "pcapng",
        "linktype": linktype,
        "linktypeName": _LINKTYPES.get(linktype, f"UNKNOWN({linktype})")
        if linktype is not None
        else None,
        "packetCount": count,
        "packets": packets,
    }


def pcap_summary(path_str: str, limit: int = 20) -> dict[str, Any]:
    path = Path(path_str)
    if not path.is_file():
        raise FileNotFoundError(f"no such file: {path}")
    head = path.open("rb").read(4)
    info = _read_pcapng(path, limit) if head == b"\x0a\x0d\x0d\x0a" else _read_pcap(path, limit)
    info["file"] = str(path)
    info["fileSizeBytes"] = path.stat().st_size
    lens = [p["wirelen"] for p in info["packets"]]
    if lens:
        info["sampledLengthStats"] = {
            "min": min(lens),
            "max": max(lens),
            "mean": round(sum(lens) / len(lens), 2),
            "note": f"computed over the first {len(lens)} packets only",
        }
    if info.get("firstTimestamp") and info.get("lastTimestamp"):
        info["durationSeconds"] = round(info["lastTimestamp"] - info["firstTimestamp"], 6)
    return info


# ─────────────────────────────── log analysis ─────────────────────────────────

_ERR_RE = re.compile(r"\b(error|fail(?:ed|ure)?|fatal|panic|assert|exception)\b", re.I)
_WARN_RE = re.compile(r"\b(warn(?:ing)?|deprecated|retry|timeout)\b", re.I)
# POST codes look like "POST: 0x3A" / "Checkpoint 0xB2" / bare "[0x1F]"
_POST_RE = re.compile(r"(?:post|checkpoint|cp)\W{0,3}(0x[0-9a-f]{2,4})", re.I)
# Leading timestamps: "[   12.345678]" or "12.345678:" or "00:00:12.345"
_TS_RE = re.compile(r"^\s*[\[<]?\s*(\d+\.\d+)\s*[\]>]?")


def analyze_log(path_str: str, max_examples: int = 10) -> dict[str, Any]:
    path = Path(path_str)
    if not path.is_file():
        raise FileNotFoundError(f"no such file: {path}")
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    post_codes: Counter[str] = Counter()
    timestamps: list[tuple[int, float]] = []

    for n, line in enumerate(lines, 1):
        if _ERR_RE.search(line):
            if len(errors) < max_examples:
                errors.append({"line": n, "text": line.strip()[:400]})
        elif _WARN_RE.search(line):
            if len(warnings) < max_examples:
                warnings.append({"line": n, "text": line.strip()[:400]})
        for m in _POST_RE.finditer(line):
            post_codes[m.group(1).lower()] += 1
        ts = _TS_RE.match(line)
        if ts:
            try:
                timestamps.append((n, float(ts.group(1))))
            except ValueError:
                pass

    error_total = sum(1 for line in lines if _ERR_RE.search(line))
    warn_total = sum(1 for line in lines if _WARN_RE.search(line) and not _ERR_RE.search(line))

    result: dict[str, Any] = {
        "file": str(path),
        "lineCount": len(lines),
        "errorCount": error_total,
        "warningCount": warn_total,
        "errorSamples": errors,
        "warningSamples": warnings,
        "postCodes": [{"code": c, "count": n} for c, n in post_codes.most_common(20)],
    }

    # Largest time gaps often mark where a boot stalled.
    if len(timestamps) >= 2:
        gaps = [
            {
                "afterLine": timestamps[i][0],
                "fromSeconds": round(timestamps[i][1], 6),
                "toSeconds": round(timestamps[i + 1][1], 6),
                "gapSeconds": round(timestamps[i + 1][1] - timestamps[i][1], 6),
            }
            for i in range(len(timestamps) - 1)
        ]
        gaps.sort(key=lambda g: g["gapSeconds"], reverse=True)
        result["timeSpanSeconds"] = round(timestamps[-1][1] - timestamps[0][1], 6)
        result["largestTimeGaps"] = gaps[:5]

    repeats = Counter(line.strip() for line in lines if line.strip())
    result["mostRepeatedLines"] = [
        {"count": c, "text": t[:200]} for t, c in repeats.most_common(5) if c > 1
    ]
    return result


# ───────────────────────────── USB device listing ─────────────────────────────


def list_usb_devices() -> dict[str, Any]:
    """Enumerate USB devices using whatever the OS actually offers.

    Returns a clear 'unavailable' result rather than inventing devices.
    """
    system = platform.system()
    if system == "Windows":
        # Force UTF-8 on both sides: without this, device names come back mangled
        # on non-English Windows (the console code page is cp950/cp932/etc.).
        ps = (
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
            "Get-PnpDevice -Class USB -ErrorAction SilentlyContinue | "
            "Select-Object Status,InstanceId,FriendlyName | ConvertTo-Json -Compress"
        )
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True, text=True, timeout=30,
                encoding="utf-8", errors="replace",
            )
            if out.returncode != 0:
                return {"available": False, "reason": out.stderr.strip()[:400] or "Get-PnpDevice failed"}
            raw = (out.stdout or "").strip()
            if not raw:
                return {"available": True, "source": "Get-PnpDevice", "devices": []}
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                parsed = [parsed]
            devices = [
                {
                    "status": d.get("Status"),
                    "instanceId": d.get("InstanceId"),
                    "name": d.get("FriendlyName"),
                }
                for d in parsed
            ]
            return {"available": True, "source": "Get-PnpDevice", "count": len(devices), "devices": devices}
        except Exception as exc:
            return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}

    # Linux / macOS: try lsusb, then sysfs, then pyusb.
    try:
        out = subprocess.run(["lsusb"], capture_output=True, text=True, timeout=15)
        if out.returncode == 0 and out.stdout.strip():
            return {
                "available": True,
                "source": "lsusb",
                "devices": [{"line": l} for l in out.stdout.strip().splitlines()],
            }
    except Exception:
        pass
    try:
        import usb.core  # type: ignore

        devs = [
            {"idVendor": f"0x{d.idVendor:04X}", "idProduct": f"0x{d.idProduct:04X}"}
            for d in usb.core.find(find_all=True)
        ]
        return {"available": True, "source": "pyusb", "count": len(devs), "devices": devs}
    except ImportError:
        return {
            "available": False,
            "reason": "no lsusb on PATH and pyusb is not installed (pip install pyusb)",
        }
    except Exception as exc:
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


# ─────────────────────────────── MCP plumbing ─────────────────────────────────

TOOLS = [
    {
        "name": "usb_list_devices",
        "description": (
            "List USB devices currently attached to this machine. Uses Get-PnpDevice on "
            "Windows, lsusb or pyusb elsewhere. Reports availability honestly when no "
            "enumeration method is present."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "usb_parse_descriptor",
        "description": (
            "Decode a raw USB descriptor blob (device / configuration / interface / "
            "endpoint / string) from a hex string. Accepts '12 01 00 02...', '1201...' "
            "or 0x-prefixed comma lists."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"hex": {"type": "string", "description": "Descriptor bytes as hex"}},
            "required": ["hex"],
        },
    },
    {
        "name": "pcap_summary",
        "description": (
            "Summarise a .pcap or .pcapng capture: link type (incl. USB link types), "
            "packet count, duration and per-packet lengths. Pure-stdlib parser, no scapy needed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the capture file"},
                "limit": {"type": "integer", "description": "How many packets to list (default 20)"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "analyze_log",
        "description": (
            "Analyse a BIOS / serial / boot log: error and warning counts with samples, "
            "POST checkpoint codes, the largest gaps between timestamps (where a boot "
            "stalled), and the most repeated lines."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the log file"},
                "maxExamples": {"type": "integer", "description": "Samples per category (default 10)"},
            },
            "required": ["path"],
        },
    },
]


def call_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "usb_list_devices":
        return list_usb_devices()
    if name == "usb_parse_descriptor":
        data = _hex_to_bytes(args["hex"])
        return {"byteCount": len(data), "descriptors": parse_usb_descriptors(data)}
    if name == "pcap_summary":
        return pcap_summary(args["path"], int(args.get("limit", 20)))
    if name == "analyze_log":
        return analyze_log(args["path"], int(args.get("maxExamples", 10)))
    raise ValueError(f"unknown tool: {name}")


def handle(msg: dict[str, Any]) -> dict[str, Any] | None:
    method = msg.get("method")
    mid = msg.get("id")

    if method == "initialize":
        requested = (msg.get("params") or {}).get("protocolVersion")
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {
                "protocolVersion": requested if isinstance(requested, str) else DEFAULT_PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        }
    if method in ("notifications/initialized", "initialized"):
        return None  # notification: no reply
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name", "")
        args = params.get("arguments") or {}
        try:
            payload = call_tool(name, args)
            text = json.dumps(payload, indent=2, ensure_ascii=False)
            return {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {"content": [{"type": "text", "text": text}], "isError": False},
            }
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}],
                    "isError": True,
                },
            }

    if mid is None:
        return None  # unknown notification: ignore
    return {
        "jsonrpc": "2.0",
        "id": mid,
        "error": {"code": -32601, "message": f"method not found: {method}"},
    }


def serve() -> None:
    log(f"ready on stdio (python {platform.python_version()}, {platform.system()})")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            log(f"bad JSON: {exc}")
            continue
        try:
            reply = handle(msg)
        except Exception as exc:  # never let one bad call kill the server
            log(f"handler crashed: {type(exc).__name__}: {exc}")
            reply = {
                "jsonrpc": "2.0",
                "id": msg.get("id"),
                "error": {"code": -32603, "message": str(exc)},
            }
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def selftest() -> None:
    """Runnable check for the pure parsers -- no hardware, no files needed."""
    # A real 18-byte USB 2.0 device descriptor (VID 0x1234 / PID 0x5678).
    dev = "12 01 00 02 00 00 00 40 34 12 78 56 00 01 01 02 03 01"
    got = parse_usb_descriptors(_hex_to_bytes(dev))
    assert len(got) == 1, got
    d = got[0]
    assert d["type"] == "DEVICE", d
    assert d["idVendor"] == "0x1234", d
    assert d["idProduct"] == "0x5678", d
    assert d["bcdUSB"] == "2.00", d
    assert d["bMaxPacketSize0"] == 64, d

    # Endpoint descriptor: 0x81 = IN endpoint 1, bulk, 512 bytes.
    ep = parse_usb_descriptors(_hex_to_bytes("07 05 81 02 00 02 00"))[0]
    assert ep["direction"] == "IN" and ep["endpointNumber"] == 1, ep
    assert ep["transferType"] == "Bulk" and ep["wMaxPacketSize"] == 512, ep

    # Truncated input must be reported, not silently swallowed.
    bad = parse_usb_descriptors(bytes([0x12, 0x01, 0x00]))
    assert "error" in bad[0], bad

    # Hex parsing accepts the common spellings.
    assert _hex_to_bytes("0x12,0x01") == bytes([0x12, 0x01])
    assert _hex_to_bytes("1201") == bytes([0x12, 0x01])

    # Protocol surface.
    init = handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert init and init["result"]["serverInfo"]["name"] == SERVER_NAME, init
    tools = handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert tools and len(tools["result"]["tools"]) == len(TOOLS), tools
    assert handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None

    # A failing tool call must come back as isError, not as a crash.
    err = handle(
        {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "analyze_log", "arguments": {"path": "/definitely/missing"}},
        }
    )
    assert err and err["result"]["isError"] is True, err

    print("selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        serve()
