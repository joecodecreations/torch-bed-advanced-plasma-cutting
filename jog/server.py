#!/usr/bin/env python3
"""TorchBed: plasma CNC controller.

Talks to GRBL on the Arduino over USB and serves a small control page at
http://127.0.0.1:8790 . Standard library only, so there is nothing to install.

Works on macOS, Linux and Windows.

Run:  python3 server.py            (auto-detects the Arduino)
      python3 server.py /dev/cu.usbmodemXXXX     (Mac)
      py server.py COM5                          (Windows)
"""
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HTTP_PORT = int(os.environ.get("JOG_HTTP_PORT") or 8790)
CONFIG_PATH = os.environ.get("JOG_CONFIG") or os.path.join(HERE, "config.json")
MAX_PROGRAM_POINTS = 200000
JOG_CANCEL = b"\x85"
# A held arrow key asks for one move of at most "max_hold_mm" and cancels it on
# release. The cap is the safety net: with no limit switches, a lost key-up can
# never travel further than this. The watchdog is the second net.
DEFAULT_MAX_HOLD_MM = 25
NO_LIMIT_MM = 2000
WATCHDOG_SECONDS = 0.4

ERRORS = {
    "error:2": "bad number in command",
    "error:8": "machine is busy, command needs it idle",
    "error:9": "machine is locked, press Unlock",
    "error:15": "move would go past the soft limit",
    "error:16": "bad jog command",
    "error:22": "no speed set for the move",
}


WINDOWS = os.name == "nt"

if WINDOWS:
    import ctypes
    import winreg
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _INVALID_HANDLE = wintypes.HANDLE(-1).value

    class _DCB(ctypes.Structure):
        _fields_ = [("DCBlength", wintypes.DWORD), ("BaudRate", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("wReserved", wintypes.WORD),
                    ("XonLim", wintypes.WORD), ("XoffLim", wintypes.WORD),
                    ("ByteSize", ctypes.c_ubyte), ("Parity", ctypes.c_ubyte),
                    ("StopBits", ctypes.c_ubyte), ("XonChar", ctypes.c_char),
                    ("XoffChar", ctypes.c_char), ("ErrorChar", ctypes.c_char),
                    ("EofChar", ctypes.c_char), ("EvtChar", ctypes.c_char),
                    ("wReserved1", wintypes.WORD)]

    class _COMMTIMEOUTS(ctypes.Structure):
        _fields_ = [("ReadIntervalTimeout", wintypes.DWORD),
                    ("ReadTotalTimeoutMultiplier", wintypes.DWORD),
                    ("ReadTotalTimeoutConstant", wintypes.DWORD),
                    ("WriteTotalTimeoutMultiplier", wintypes.DWORD),
                    ("WriteTotalTimeoutConstant", wintypes.DWORD)]

    _k32.CreateFileW.restype = wintypes.HANDLE
    _k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                 wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _k32.SetCommState.argtypes = [wintypes.HANDLE, ctypes.POINTER(_DCB)]
    _k32.SetCommTimeouts.argtypes = [wintypes.HANDLE, ctypes.POINTER(_COMMTIMEOUTS)]
    _k32.SetupComm.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
    _k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                              ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    _k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                               ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.EscapeCommFunction.argtypes = [wintypes.HANDLE, wintypes.DWORD]

    def _winerr(what):
        code = ctypes.get_last_error()
        return OSError(code, "%s: %s" % (what, ctypes.FormatError(code).strip()))

    def list_ports():
        """COM ports Windows knows about, USB serial adapters (Arduino) first."""
        found = []
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DEVICEMAP\SERIALCOMM")
        except OSError:
            return []
        with key:
            i = 0
            while True:
                try:
                    device, name, _ = winreg.EnumValue(key, i)
                except OSError:
                    break
                i += 1
                d = device.lower()
                if "bth" in d:  # Bluetooth serial links: never the Arduino, and slow to open
                    continue
                # A real Uno shows up as "USBSER", clones as CH340/CP210x. FTDI
                # adapters ("VCP") are usually some other machine, so try them later.
                if "usbser" in d:
                    rank = 0
                elif any(t in d for t in ("ch34", "silab", "prolific")):
                    rank = 1
                elif "vcp" in d:
                    rank = 2
                else:
                    rank = 4 if name.upper() in ("COM1", "COM2") else 3
                found.append((rank, name))
        return [name for _, name in sorted(found)]

    def port_exists(port):
        return port.upper() in [p.upper() for p in list_ports()]

    class SerialPort:
        """115200 8N1 serial port through the Win32 API (no pyserial needed)."""

        def __init__(self, port, baud=115200):
            h = _k32.CreateFileW("\\\\.\\" + port, 0xC0000000, 0, None, 3, 0, None)
            if h == _INVALID_HANDLE:
                raise _winerr("open")
            self.h = h
            try:
                _k32.SetupComm(h, 4096, 4096)
                dcb = _DCB()
                dcb.DCBlength = ctypes.sizeof(_DCB)
                dcb.BaudRate = baud
                # binary mode, DTR and RTS held on: raising DTR is what resets
                # the Uno when the port is opened, same as on the Mac.
                dcb.flags = 0x0001 | 0x0010 | 0x1000
                dcb.ByteSize = 8
                if not _k32.SetCommState(h, ctypes.byref(dcb)):
                    raise _winerr("configure")
                # Reads return at once with whatever has arrived, so a read in
                # one thread never holds up a stop command written by another.
                to = _COMMTIMEOUTS(0xFFFFFFFF, 0, 0, 0, 500)
                if not _k32.SetCommTimeouts(h, ctypes.byref(to)):
                    raise _winerr("timeouts")
            except OSError:
                _k32.CloseHandle(h)
                raise
            self.buf = ctypes.create_string_buffer(4096)

        def read(self, timeout):
            """Bytes that arrived within `timeout` seconds; b"" if none."""
            end = time.time() + timeout
            n = wintypes.DWORD(0)
            while True:
                if not _k32.ReadFile(self.h, self.buf, 4096, ctypes.byref(n), None):
                    raise _winerr("read")
                if n.value:
                    return self.buf.raw[:n.value]
                if time.time() >= end:
                    return b""
                time.sleep(0.005)

        def write(self, data):
            n = wintypes.DWORD(0)
            if not _k32.WriteFile(self.h, data, len(data), ctypes.byref(n), None):
                raise _winerr("write")
            if n.value != len(data):
                raise OSError("write timed out")

        def set_dtr(self, on):
            """Drive DTR and RTS; pulling them low then high resets an Arduino."""
            _k32.EscapeCommFunction(self.h, 5 if on else 6)   # SETDTR / CLRDTR
            _k32.EscapeCommFunction(self.h, 3 if on else 4)   # SETRTS / CLRRTS

        def close(self):
            _k32.CloseHandle(self.h)

else:
    import fcntl
    import select
    import struct
    import termios

    def list_ports():
        pats = ("/dev/cu.usbmodem*", "/dev/cu.usbserial*", "/dev/cu.wchusbserial*",
                "/dev/ttyACM*", "/dev/ttyUSB*")
        return [hit for pat in pats for hit in sorted(glob.glob(pat))]

    def port_exists(port):
        return os.path.exists(port)

    class SerialPort:
        """115200 8N1 serial port through termios."""

        def __init__(self, port, baud=115200):
            fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            try:
                a = termios.tcgetattr(fd)
                a[0] = 0
                a[1] = 0
                a[3] = 0
                a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
                a[4] = a[5] = getattr(termios, "B%d" % baud)
                termios.tcsetattr(fd, termios.TCSANOW, a)
            except Exception:
                os.close(fd)
                raise
            self.fd = fd

        def read(self, timeout):
            """Bytes that arrived within `timeout` seconds; b"" if none."""
            r, _, _ = select.select([self.fd], [], [], timeout)
            if not r:
                return b""
            chunk = os.read(self.fd, 4096)
            if not chunk:
                raise OSError("port closed")
            return chunk

        def write(self, data):
            view = memoryview(data)
            while view:                      # the port is non-blocking: keep going until it is all out
                try:
                    view = view[os.write(self.fd, view):]
                except BlockingIOError:
                    select.select([], [self.fd], [], 0.5)

        def set_dtr(self, on):
            """Drive DTR and RTS; pulling them low then high resets an Arduino."""
            bits = struct.pack("I", termios.TIOCM_DTR | termios.TIOCM_RTS)
            try:
                fcntl.ioctl(self.fd, termios.TIOCMBIS if on else termios.TIOCMBIC, bits)
            except OSError:
                pass

        def close(self):
            os.close(self.fd)


termios_error = OSError if WINDOWS else termios.error


FW_DIR = os.path.join(os.path.dirname(HERE), "firmware")
FW_NOTES = {
    "grbl-1.1h-corexy.hex": "GRBL 1.1h, CoreXY (what this machine was set up with). Torch relay switches on with a HIGH signal.",
    "grbl-1.1h-corexy-torch-inverted.hex": "GRBL 1.1h, CoreXY, torch signal inverted: for relay boards that switch on with a LOW signal.",
    "grbl-1.1h-standard-xy.hex": "GRBL 1.1h, ordinary X/Y (one motor per axis, not CoreXY). Torch relay switches on with a HIGH signal.",
    "grbl-1.1h-standard-xy-torch-inverted.hex": "GRBL 1.1h, ordinary X/Y, torch signal inverted for LOW-triggered relay boards.",
    "uno1_original_backup.hex": "Backup of what was on the board before GRBL was put on it.",
}


PROJ_DIR = os.environ.get("JOG_PROJECTS") or os.path.join(os.path.dirname(HERE), "projects")
PROJ_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9 _.()\-]{0,59}$")


def project_path(name):
    name = str(name or "").strip()
    if not PROJ_NAME.match(name) or name.endswith("."):
        return None
    return os.path.join(PROJ_DIR, name + ".json")


def project_list():
    out = []
    try:
        names = os.listdir(PROJ_DIR)
    except OSError:
        return out
    for n in names:
        if not n.endswith(".json"):
            continue
        path = os.path.join(PROJ_DIR, n)
        try:
            with open(path) as f:
                d = json.load(f)
            out.append({"name": n[:-5], "saved": os.path.getmtime(path), "shapes": len(d.get("shapes") or []),
                        "sheets": d.get("sheets", 1), "thumb": d.get("thumb", ""), "pieces": len((d.get("assembly") or {}).get("pieces") or [])})
        except (OSError, ValueError, AttributeError):
            continue
    out.sort(key=lambda x: -x["saved"])
    return out


def project_save(name, data):
    path = project_path(name)
    if not path:
        return "Use letters, numbers, spaces, dashes or dots in the name (up to 60 characters)."
    if not isinstance(data, dict) or not isinstance(data.get("shapes"), list):
        return "Nothing to save"
    os.makedirs(PROJ_DIR, exist_ok=True)
    # keep the previous draft for a while, so one bad autosave cannot wipe the last good one
    if name == "_autosave" and os.path.exists(path) and time.time() - os.path.getmtime(path) > 600:
        try:
            os.replace(path, os.path.join(PROJ_DIR, "_autosave-earlier.json"))
        except OSError:
            pass
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)
    return None


BLENDER_TYPES = {".blend", ".fbx", ".dae", ".gltf", ".glb", ".usd", ".usda", ".usdc", ".usdz", ".abc", ".x3d", ".wrl", ".3ds",
                 ".obj", ".ply", ".stl"}
CAD_TYPES = {".step", ".stp", ".iges", ".igs", ".f3d", ".f3z", ".sat", ".smt", ".sldprt", ".ipt", ".dwg"}


def find_blender():
    """Path of a Blender program on this computer, or None."""
    cands = [os.environ.get("JOG_BLENDER"), shutil.which("blender")]
    if sys.platform == "darwin":
        cands += ["/Applications/Blender.app/Contents/MacOS/Blender",
                  os.path.expanduser("~/Applications/Blender.app/Contents/MacOS/Blender")]
    elif WINDOWS:
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                cands += sorted(glob.glob(os.path.join(base, "Blender Foundation", "Blender*", "blender.exe")), reverse=True)
                cands += sorted(glob.glob(os.path.join(base, "Programs", "Blender Foundation", "Blender*", "blender.exe")), reverse=True)
        cands += sorted(glob.glob(r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe"))
    else:
        cands += ["/usr/bin/blender", "/snap/bin/blender", "/usr/local/bin/blender"]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def convert_model(name, data):
    """Turn a 3D file this app cannot read by itself into binary STL (mm), using Blender. -> (bytes, error)"""
    ext = os.path.splitext(str(name))[1].lower()
    if ext in CAD_TYPES:
        return None, ("%s is a CAD (solid) file, which needs a CAD program to read. In Fusion use File > Export "
                      "(or right-click the body > Save As Mesh) and choose 3MF, STL or OBJ, then load that." % ext.upper().lstrip("."))
    if ext not in BLENDER_TYPES:
        return None, "%s files are not supported." % (ext or "Those")
    blender = find_blender()
    if not blender:
        return None, ("Opening %s files needs Blender, which was not found on this computer. Install Blender (blender.org), "
                      "or export the model as GLB, 3MF, STL or OBJ and load that." % ext.lstrip("."))
    work = tempfile.mkdtemp(prefix="plasma-convert-")
    try:
        src = os.path.join(work, "model" + ext)
        dst = os.path.join(work, "out.stl")
        with open(src, "wb") as f:
            f.write(data)
        script = os.path.join(HERE, "tools", "blender_to_stl.py")
        # -Y: never run scripts stored inside the file
        cmd = [blender, "--background", "--factory-startup", "-Y"] + ([src] if ext == ".blend" else []) + ["--python", script, "--", src, dst]
        try:
            run = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
        except subprocess.TimeoutExpired:
            return None, "Blender took too long to convert that file."
        except OSError as e:
            return None, "Could not start Blender: %s" % e
        out = run.stdout.decode(errors="replace")
        if os.path.isfile(dst) and "PLASMA_OK" in out:
            with open(dst, "rb") as f:
                return f.read(), None
        m = re.search(r"PLASMA_ERROR (.*)", out)
        if m:
            return None, "Blender opened the file but %s." % m.group(1).strip()
        tail = [ln for ln in out.strip().splitlines() if ln.strip()][-1:] or ["no details"]
        return None, "Blender could not convert that file (%s)." % tail[0][:200]
    finally:
        shutil.rmtree(work, ignore_errors=True)


def firmware_files():
    """Firmware images that can be flashed: [(name, path, note)]."""
    out = []
    for sub, note in (("variants", None), ("", None), ("backups", "Backup read from the board.")):
        folder = os.path.join(FW_DIR, sub) if sub else FW_DIR
        try:
            names = sorted(os.listdir(folder), reverse=(sub == "backups"))
        except OSError:
            continue
        for n in names:
            if n.lower().endswith(".hex"):
                label = (sub + "/" + n) if sub else n
                out.append((label, os.path.join(folder, n), FW_NOTES.get(n) or note or "Firmware file."))
    return out


# Starting points only: every plasma cutter differs, so tune these against the cut chart in
# the cutter's manual and save over them.
DEFAULT_MATERIALS = [
    {"name": "Mild steel 1.5 mm", "kerf": 1.2, "thickness": 1.5, "cut_feed": 3500, "pierce_delay": 0.2, "end_delay": 0.2},
    {"name": "Mild steel 3 mm", "kerf": 1.5, "thickness": 3.0, "cut_feed": 2000, "pierce_delay": 0.4, "end_delay": 0.2},
    {"name": "Mild steel 6 mm", "kerf": 2.0, "thickness": 6.0, "cut_feed": 800, "pierce_delay": 0.8, "end_delay": 0.3},
    {"name": "Stainless steel 3 mm", "kerf": 1.5, "thickness": 3.0, "cut_feed": 1800, "pierce_delay": 0.5, "end_delay": 0.2},
    {"name": "Aluminium 3 mm", "kerf": 1.6, "thickness": 3.0, "cut_feed": 2400, "pierce_delay": 0.4, "end_delay": 0.2},
]
MATERIAL_LIMITS = {"kerf": (0.1, 10), "thickness": (0.1, 100), "cut_feed": (10, 20000), "pierce_delay": (0, 10), "end_delay": (0, 10)}


def clean_materials(raw):
    """Validate a list of material presets coming from the page."""
    out, seen = [], set()
    if not isinstance(raw, list):
        return None
    for m in raw[:60]:
        if not isinstance(m, dict):
            continue
        name = re.sub(r"[\x00-\x1f<>]", "", str(m.get("name", ""))).strip()[:40]
        if not name or name.lower() in seen:
            continue
        item = {"name": name}
        try:
            for k, (lo, hi) in MATERIAL_LIMITS.items():
                v = float(m.get(k, 1.5) if k == "kerf" else m.get(k))   # older saves have no kerf
                if not math.isfinite(v):
                    raise ValueError
                item[k] = max(lo, min(v, hi))
        except (TypeError, ValueError):
            continue
        seen.add(name.lower())
        out.append(item)
    return out or None


def load_config():
    cfg = {"swap_xy": False, "flip_x": False, "flip_y": False, "max_hold_mm": DEFAULT_MAX_HOLD_MM,
           "x_max": None, "y_max": None,
           # Cutting. The torch relay hangs off GRBL's coolant pin (Uno A3),
           # which M8 switches on and M9 switches off.
           "cut_feed": 1500, "travel_feed": 3000, "dry_feed": 2000,
           "pierce_delay": 0.5, "end_delay": 0.2,
           "torch_on": "M8", "torch_off": "M9", "return_zero": True,
           "board": "uno-cnc-shield-v3",
           "thickness": 3.0, "kerf": 1.5, "material": "Mild steel 3 mm",
           "materials": [dict(m) for m in DEFAULT_MATERIALS]}
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    # settings saved before the cut width existed: fill it in
    stock = {m["name"]: m["kerf"] for m in DEFAULT_MATERIALS}
    for m in cfg.get("materials") or []:
        if isinstance(m, dict) and "kerf" not in m:
            m["kerf"] = stock.get(m.get("name"), 1.5)
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


class Grbl:
    def __init__(self, port=None):
        self.wanted_port = port
        self.port = None
        self.fd = None
        self.wlock = threading.RLock()
        self.state = "Disconnected"
        self.mpos = [0.0, 0.0, 0.0]
        self.wco = [0.0, 0.0, 0.0]
        self.max_feed = 6000.0
        self.rates = {}
        self.log = deque(maxlen=300)
        self.seq = 0
        self.holding = False
        self.last_keep = 0.0
        self.gen = 0
        self.glock = threading.Lock()
        self.last_status = 0.0
        self.need_resume = False
        # True once zero has been set since the controller last started. The
        # controller forgets where it is on every reset, so until then the
        # saved travel limits cannot be trusted and are not applied.
        self.zero_ok = False
        self.free = False  # free travel: ignore travel limits until zero is set again
        self.abort_after_hold = False
        self.keep_zero = False
        self.pending = deque()
        self.acks = 0
        self.last_err = None
        self.prog = {"active": False, "mode": None, "done": 0, "total": 0, "error": None, "result": None}
        self.prog_abort = False
        self.torch = False
        self.abort_deadline = None
        self.settings = {}      # GRBL "$" settings as read from the board: {"100": "80.000", ...}
        self.info = {"version": None, "options": None}
        self.flashing = False
        self.flash = {"active": False, "stage": None, "done": 0, "total": 0, "error": None, "result": None, "file": None}
        self.last_open_error = None
        self.silent_ports = set()
        self.got_status = False
        self.cfg = load_config()

    # ---- serial ---------------------------------------------------------
    def find_port(self):
        if self.wanted_port:
            return self.wanted_port if port_exists(self.wanted_port) else None
        ports = list_ports()
        # Skip ports that opened but never answered like GRBL (some other
        # serial device). Once every port has been tried, start over.
        fresh = [p for p in ports if p not in self.silent_ports]
        if not fresh:
            self.silent_ports.clear()
            fresh = ports
        return fresh[0] if fresh else None

    def connect(self):
        port = self.find_port()
        if not port:
            return False
        try:
            with self.wlock:  # never while disconnect() is still closing the port
                fd = SerialPort(port)
        except (OSError, termios_error) as e:
            msg = "Could not open %s: %s" % (port, e)
            if msg != self.last_open_error:  # retried every 1.5 s: say it once
                self.last_open_error = msg
                self.say(msg)
            return False
        self.last_open_error = None
        self.got_status = False
        self.fd, self.port = fd, port
        self.last_status = time.time() + 4.0
        self.state = "Connecting"
        self.say("Connected to %s" % port)
        return True

    def disconnect(self, why):
        with self.wlock:
            fd, self.fd = self.fd, None
            if fd is not None:
                try:
                    fd.close()
                except OSError:
                    pass
        if fd is not None:
            self.say("Disconnected: %s" % why)
            if not self.got_status and self.port:
                self.silent_ports.add(self.port)
        self.state = "Disconnected"
        self.holding = False

    def say(self, text):
        self.seq += 1
        self.log.append((self.seq, text))

    def write(self, data):
        if self.fd is None:
            return False
        with self.wlock:
            try:
                fd = self.fd
                if fd is None:
                    return False
                fd.write(data)
                return True
            except OSError as e:
                self.disconnect(str(e))
                return False

    def send_line(self, line, echo=False):
        if echo:
            self.say("> " + line)
        self.pending.append(time.time())
        return self.write((line.strip() + "\n").encode())

    def reader(self):
        buf = b""
        opened_at = 0.0
        asked_settings = False
        while True:
            if self.flashing:               # the flasher owns the port for now
                buf = b""
                time.sleep(0.2)
                continue
            if self.fd is None:
                buf = b""
                if self.connect():
                    opened_at = time.time()
                    asked_settings = False
                else:
                    time.sleep(1.5)
                continue
            # Opening the port resets the Uno; give GRBL time to boot.
            if not asked_settings and time.time() - opened_at > 2.5:
                asked_settings = True
                self.send_line("$$")
                self.send_line("$I")
            try:
                chunk = self.fd.read(0.2)
            except (OSError, ValueError, TypeError, AttributeError) as e:
                self.disconnect(str(e))
                continue
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self.on_line(raw.decode(errors="replace").strip())

    def on_line(self, line):
        if not line:
            return
        if line == "ok" or line.startswith("error:"):
            if self.pending:
                self.pending.popleft()
            self.last_err = None if line == "ok" else line
            self.acks += 1
            if line == "ok":
                return
        if line.startswith("Grbl "):
            self.pending.clear()
            self.torch = False
            if self.prog["active"] and not self.prog_abort:
                self.prog_abort = True
                self.prog["error"] = "The controller restarted"
            self.need_resume = False
            if self.keep_zero:
                # Our own reset after a controlled stop: position is still good.
                self.keep_zero = False
            else:
                if self.zero_ok:
                    self.say("Controller restarted: set zero again to turn the travel limits back on")
                self.zero_ok = False
        if line.startswith("<") and line.endswith(">"):
            self.on_status(line[1:-1])
            return
        if line.startswith("[VER:"):
            self.info["version"] = line[5:].rstrip("]").split(":")[0]
            return
        if line.startswith("[OPT:"):
            self.info["options"] = line[5:].rstrip("]")
            return
        if line.startswith("$") and "=" in line:
            key, val = line[1:].split("=", 1)
            if key.isdigit():
                self.settings[key] = val.strip()
            if key in ("110", "111"):
                try:
                    self.rates[key] = float(val)
                    self.max_feed = min(self.rates.values())
                except ValueError:
                    pass
            return
        if line.startswith("error:"):
            line = "%s (%s)" % (line, ERRORS.get(line, "see GRBL error list"))
        self.say(line)

    def on_status(self, body):
        parts = body.split("|")
        self.last_status = time.time()
        self.got_status = True
        self.silent_ports.clear()
        self.state = parts[0]
        for p in parts[1:]:
            try:
                if p.startswith("MPos:"):
                    self.mpos = [float(v) for v in p[5:].split(",")]
                elif p.startswith("WPos:"):
                    w = [float(v) for v in p[5:].split(",")]
                    self.mpos = [w[i] + self.wco[i] for i in range(3)]
                elif p.startswith("WCO:"):
                    self.wco = [float(v) for v in p[4:].split(",")]
            except (ValueError, IndexError):
                pass
        if not self.state.startswith("Jog"):
            self.holding = False

    def poller(self):
        while True:
            time.sleep(0.15)
            if self.fd is not None:
                self.write(b"?")
                # The controller answers "?" several times a second. Silence
                # means it has hung: reopen the port, which resets the Arduino.
                if time.time() - self.last_status > 2.5:
                    self.say("Controller stopped answering; resetting it")
                    self.disconnect("no reply from controller")
            # Stop a held jog if the page stopped saying the key is still down
            # (browser closed, tab hidden, lost key-up).
            if self.holding and time.time() - self.last_keep > WATCHDOG_SECONDS:
                self.stop()
                self.say("Jog stopped: lost contact with the control page")
            # GRBL 1.1 can freeze in a hold if a jog cancel lands just as the
            # move ends: it still reports Idle but ignores every command. A
            # resume character clears that, and is harmless otherwise. It is
            # only sent while nothing is queued, so it cannot release a move.
            elif self.abort_after_hold and (self.state.startswith("Hold:0") or (
                    self.abort_deadline and time.time() > self.abort_deadline)):
                # The reset is also what switches the torch off.
                self.abort_after_hold = False
                self.abort_deadline = None
                self.keep_zero = True
                self.pending.clear()
                self.write(b"\x18")
                self.say("Program move stopped")
            elif self.need_resume and self.state == "Idle" and not self.pending:
                self.need_resume = False
                self.write(b"~")
            # Fallback: a command has gone unanswered while the machine sits
            # idle. Soft-reset, which throws away anything queued (never
            # resume here: that would run the queued moves all at once).
            elif (self.pending and self.state == "Idle" and not self.prog["active"]
                  and time.time() - self.pending[0] > 1.5):
                self.pending.clear()
                self.need_resume = False
                self.holding = False
                self.write(b"\x18")
                self.say("Controller was stuck; reset it and cleared queued moves")

    # ---- motion ---------------------------------------------------------
    def to_machine(self, ux, uy):
        """Screen direction -> machine axes, using the direction setup."""
        if self.cfg["flip_x"]:
            ux = -ux
        if self.cfg["flip_y"]:
            uy = -uy
        return (uy, ux) if self.cfg["swap_xy"] else (ux, uy)

    def to_screen(self, mx, my):
        if self.cfg["swap_xy"]:
            mx, my = my, mx
        return (-mx if self.cfg["flip_x"] else mx, -my if self.cfg["flip_y"] else my)

    def work_xy(self):
        return self.to_screen(self.mpos[0] - self.wco[0], self.mpos[1] - self.wco[1])

    def limits_on(self):
        return (not self.free) and self.zero_ok and self.cfg.get("x_max") and self.cfg.get("y_max")

    def room(self, ux, uy):
        """How far the torch may still go in this screen direction (mm)."""
        if not self.limits_on():
            return None
        x, y = self.work_xy()
        room = []
        if ux:
            room.append(self.cfg["x_max"] - x if ux > 0 else x)
        if uy:
            room.append(self.cfg["y_max"] - y if uy > 0 else y)
        return max(0.0, min(room))

    def clamp_feed(self, feed):
        try:
            feed = float(feed)
        except (TypeError, ValueError):
            feed = 600.0
        return max(10.0, min(feed, self.max_feed))

    def wait_idle(self, timeout=2.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.state == "Idle":
                return True
            time.sleep(0.02)
        return self.state == "Idle"

    def bump(self):
        with self.glock:
            self.gen += 1
            return self.gen

    def cancel(self):
        """Cancel a jog only if one may be running, then flag the resume."""
        if self.holding or self.state.startswith("Jog") or self.pending:
            self.write(JOG_CANCEL)
            self.need_resume = True
        self.holding = False

    def settle(self):
        """After a cancel: wait for idle and clear any frozen hold."""
        self.wait_idle()
        if self.need_resume and not self.pending:
            self.need_resume = False
            self.write(b"~")
            time.sleep(0.05)

    def stop(self):
        self.bump()
        if self.prog["active"]:
            # Pause, then the poller resets the controller as soon as it has
            # come to rest (or after 1.5 s regardless). The reset drops the
            # rest of the program and switches the torch off.
            self.prog_abort = True
            self.write(b"!")
            self.abort_after_hold = True
            self.abort_deadline = time.time() + 1.5
            return
        if self.state.startswith(("Run", "Hold")):
            # A program move (not a jog): pause it, then the poller resets the
            # controller once it has come to rest, which discards the rest.
            self.write(b"!")
            self.abort_after_hold = True
            return
        self.cancel()

    def busy(self):
        if self.flashing:
            return "The firmware is being flashed. Wait for it to finish."
        return "A program is running. Press Stop first." if self.prog["active"] else None

    # ---- controller settings and firmware --------------------------------
    def refresh_settings(self):
        if self.fd is None:
            return "Not connected"
        if self.busy():
            return self.busy()
        if not self.state.startswith(("Idle", "Alarm")):
            return "Stop the machine first"
        self.send_line("$$")
        self.send_line("$I")
        return None

    def set_setting(self, num, value):
        try:
            num = int(num)
            value = float(value)
        except (TypeError, ValueError):
            return "That is not a number"
        if not (0 <= num <= 132) or not math.isfinite(value):
            return "That setting does not exist"
        if self.fd is None:
            return "Not connected"
        if self.busy():
            return self.busy()
        if self.state != "Idle":
            return "The machine must be idle to change a setting"
        text = ("%.3f" % value).rstrip("0").rstrip(".")
        self.send_line("$%d=%s" % (num, text), echo=True)
        time.sleep(0.25)        # GRBL writes the EEPROM; then read everything back
        self.send_line("$$")
        return None

    def start_flash(self, name, backup_only=False):
        if self.busy():
            return self.busy()
        if self.state.startswith(("Run", "Jog", "Hold")):
            return "Stop the machine first"
        path = None
        if not backup_only:
            path = dict((n, p) for n, p, _ in firmware_files()).get(name)
            if not path:
                return "That firmware file was not found"
        port = self.port if (self.fd is not None and self.port) else self.find_port()
        if not port:
            return "Arduino not found. Check the USB cable."
        self.flash = {"active": True, "stage": "connect", "done": 0, "total": 1, "error": None, "result": None,
                      "file": None if backup_only else name}
        self.flashing = True
        threading.Thread(target=self.run_flash, args=(port, path, name, backup_only), daemon=True).start()
        return None

    def run_flash(self, port, path, name, backup_only):
        fl = self.flash
        try:
            import flasher
        except ImportError:
            fl.update(active=False, error="flasher.py is missing from the jog folder", result="error")
            self.flashing = False
            return
        self.say("Backing up the board's firmware" if backup_only else "Flashing %s" % name)
        self.disconnect("handing the port to the flasher")
        time.sleep(0.4)

        def open_port(baud):
            last = None
            time.sleep(0.15)
            for _ in range(8):          # Windows can take a moment to let go of the port
                try:
                    return SerialPort(port, baud)
                except (OSError, termios_error) as e:
                    last = e
                    time.sleep(0.3)
            raise OSError("could not open %s: %s" % (port, last))

        def progress(prefix):
            def cb(stage, done, total):
                fl.update(stage=prefix + stage, done=done, total=max(1, total))
            return cb

        try:
            image = None
            if not backup_only:
                with open(path) as f:
                    image = flasher.parse_hex(f.read())
            # Always keep a copy of what is on the board before writing over it. Reading it also
            # tells us which bootloader answered: the fast one (Optiboot, Uno) or the old slow one.
            old = None
            for baud in (115200, 115200, 57600):      # the fast bootloader gets a second try before falling back
                try:
                    old = flasher.read_flash(open_port, progress=progress("backup-"), bauds=(baud,))
                    break
                except flasher.FlashError:
                    if baud == 57600:
                        raise
                    time.sleep(0.4)
            if image is not None and baud == 57600 and len(image) > 30720:
                raise flasher.FlashError(
                    "This board has the old, larger bootloader (common on older Nanos) and this firmware is "
                    "%d bytes, which is more than the 30720 that fit beside it. Nothing was written." % len(image))
            saved = None
            if any(b != 0xFF for b in old):
                folder = os.path.join(FW_DIR, "backups")
                os.makedirs(folder, exist_ok=True)
                saved = "backup-%s.hex" % time.strftime("%Y%m%d-%H%M%S")
                with open(os.path.join(folder, saved), "w") as f:
                    f.write(flasher.make_hex(old))
                self.say("Saved the board's firmware as backups/%s" % saved)
            if backup_only:
                fl.update(result="done", detail="Saved as backups/%s" % saved if saved else "The board was empty; nothing to save.")
            else:
                time.sleep(0.3)
                info = flasher.write_flash(open_port, image, progress=progress(""), bauds=(baud,))
                fl.update(result="done", detail="Wrote %d bytes and checked them." % info.get("bytes", len(image)))
                self.say("Firmware flashed and verified: %s" % name)
        except (flasher.FlashError, OSError, ValueError) as e:
            fl.update(error=str(e), result="error")
            self.say("Firmware flashing failed: %s" % e)
        finally:
            fl["active"] = False
            self.zero_ok = False
            self.settings = {}
            self.info = {"version": None, "options": None}
            self.silent_ports.clear()
            time.sleep(0.5)
            self.flashing = False       # the reader thread reconnects from here

    def jog(self, ux, uy, feed, step=None):
        if self.fd is None:
            return "Not connected"
        if self.prog["active"]:
            # A key-up from the page must not abort a running program.
            return None if (int(ux or 0) == 0 and int(uy or 0) == 0) else self.busy()
        if self.state.startswith("Alarm"):
            return "Machine is locked. Press Unlock."
        ux = max(-1, min(1, int(ux)))
        uy = max(-1, min(1, int(uy)))
        if ux == 0 and uy == 0:
            self.stop()
            return None
        mine = self.bump()
        if step is None:
            # Hold-to-move: replace whatever is moving with the new direction.
            if self.state.startswith("Jog") or self.holding or self.need_resume:
                self.cancel()
                self.settle()
            # A stop or a newer move arrived while we waited: do not start.
            if mine != self.gen:
                return None
            cap = float(self.cfg.get("max_hold_mm", DEFAULT_MAX_HOLD_MM))
            # 0 means "no limit": move until the key is released. GRBL needs a
            # finite target, so ask for far more than the frame is long.
            dist = NO_LIMIT_MM if cap <= 0 else max(1.0, min(cap, 300.0))
        else:
            # Step moves queue up behind each other; only a held move is cancelled.
            if self.holding or self.need_resume:
                self.cancel()
                self.settle()
                if mine != self.gen:
                    return None
            dist = max(0.01, min(float(step), 100.0))
        room = self.room(ux, uy)
        if room is not None:
            if room < 0.05:
                return "At the travel limit"
            dist = min(dist, room)
        mx, my = self.to_machine(ux * dist, uy * dist)
        self.last_keep = time.time()
        self.holding = step is None
        self.send_line("$J=G91 G21 X%.3f Y%.3f F%.0f" % (mx, my, self.clamp_feed(feed)))
        return None

    def go_zero(self, feed):
        return self.goto(0, 0, feed, check=False)

    def goto(self, x, y, feed, check=True):
        """Move straight to a point on the bed (screen/work coordinates, mm)."""
        if self.fd is None:
            return "Not connected"
        if self.busy():
            return self.busy()
        if self.state.startswith("Alarm"):
            return "Machine is locked. Press Unlock."
        try:
            x, y = float(x), float(y)
        except (TypeError, ValueError):
            return "Bad point"
        if not (math.isfinite(x) and math.isfinite(y)):
            return "Bad point"
        if check:
            if not self.zero_ok:
                return "Set zero at the front-left corner first, so the machine knows where it is"
            if self.limits_on() and not (-0.01 <= x <= self.cfg["x_max"] + 0.01
                                         and -0.01 <= y <= self.cfg["y_max"] + 0.01):
                return "That point is outside the bed"
        self.bump()
        self.cancel()
        self.settle()
        mx, my = self.to_machine(x, y)
        self.send_line("$J=G90 G21 X%.3f Y%.3f F%.0f" % (mx, my, self.clamp_feed(feed)))
        return None

    def set_zero(self):
        if self.busy():
            return self.busy()
        if self.state != "Idle":
            return "Stop the machine before setting zero"
        self.send_line("G10 L20 P1 X0 Y0")
        time.sleep(0.5)
        self.zero_ok = True
        self.free = False
        self.say("Zero set here (front-left corner)")
        return None

    def set_corner(self, which):
        """Teach the bed size by jogging the torch to a corner."""
        if which == "fl":
            return self.set_zero()
        if which not in ("fr", "bl", "br"):
            return "Unknown corner"
        if self.busy():
            return self.busy()
        if not self.zero_ok:
            return "Set the front-left corner (zero) first"
        if self.state != "Idle":
            return "Stop the machine first"
        x, y = self.work_xy()
        if which in ("fr", "br") and x < 10:
            return "This corner must be to the right of zero (X above 10 mm)"
        if which in ("bl", "br") and y < 10:
            return "This corner must be behind zero (Y above 10 mm)"
        if which in ("fr", "br"):
            self.cfg["x_max"] = round(x, 2)
        if which in ("bl", "br"):
            self.cfg["y_max"] = round(y, 2)
        save_config(self.cfg)
        names = {"fr": "Front-right", "bl": "Back-left", "br": "Back-right"}
        self.say("%s corner set: bed is now %s x %s mm" % (
            names[which], self.cfg.get("x_max") or "?", self.cfg.get("y_max") or "?"))
        return None

    # ---- programs (cut, dry run) ----------------------------------------
    def build_program(self, paths, mode):
        """Turn shapes (lists of [x, y] in bed mm) into G-code lines.

        mode: "cut" fires the torch, "trace" follows the same lines with the
        torch off, "box" runs the rectangle around everything, "pulse" clicks
        the torch relay for one second without moving.
        """
        c = self.cfg
        on, off = c["torch_on"], c["torch_off"]
        if mode == "pulse":
            return [on, "G4 P1.0", off, "G4 P0.05"], None
        clean = []
        count = 0
        for path in paths or []:
            pts = []
            for p in path:
                x, y = float(p[0]), float(p[1])
                if not (math.isfinite(x) and math.isfinite(y)):
                    return None, "A shape has a bad point"
                pts.append((x, y))
            if len(pts) >= 2:
                clean.append(pts)
                count += len(pts)
        if not clean:
            return None, "Nothing to run: draw or import a shape first"
        if count > MAX_PROGRAM_POINTS:
            return None, "Too many points (%d). Trace with less detail." % count
        xs = [p[0] for pts in clean for p in pts]
        ys = [p[1] for pts in clean for p in pts]
        if c.get("x_max") and c.get("y_max") and not self.free:
            if min(xs) < -0.01 or min(ys) < -0.01 or max(xs) > c["x_max"] + 0.01 or max(ys) > c["y_max"] + 0.01:
                return None, "A shape goes outside the bed. Move it inside first."
        if mode == "box":
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            clean = [[(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]]
        cut = mode == "cut"
        travel = self.clamp_feed(c["travel_feed"])
        feed = self.clamp_feed(c["cut_feed"] if cut else c["dry_feed"])

        def xy(p):
            mx, my = self.to_machine(p[0], p[1])
            return "X%.3f Y%.3f" % (mx, my)

        lines = ["G90 G21"]
        for pts in clean:
            lines.append("G1 %s F%.0f" % (xy(pts[0]), travel))
            if cut:
                lines.append(on)
                if c["pierce_delay"] > 0:
                    lines.append("G4 P%.2f" % c["pierce_delay"])
            first = True
            for p in pts[1:]:
                lines.append("G1 %s%s" % (xy(p), " F%.0f" % feed if first else ""))
                first = False
            if cut:
                lines.append(off)
                if c["end_delay"] > 0:
                    lines.append("G4 P%.2f" % c["end_delay"])
        if c.get("return_zero"):
            lines.append("G1 X0.000 Y0.000 F%.0f" % travel)
        lines.append("G4 P0.05")  # answered only once every move has finished
        return lines, None

    def start_program(self, paths, mode, armed=False):
        if mode not in ("cut", "trace", "box", "pulse"):
            return "Unknown run mode"
        if self.fd is None:
            return "Not connected"
        if self.busy():
            return self.busy()
        if self.state.startswith("Alarm"):
            return "Machine is locked. Press Unlock."
        if self.state != "Idle":
            return "Wait for the machine to stop first"
        if mode in ("cut", "pulse") and not armed:
            return "Arm the torch first"
        if mode != "pulse" and not self.zero_ok:
            return "Set zero at the front-left corner first, so the machine knows where it is"
        try:
            lines, err = self.build_program(paths, mode)
        except (TypeError, ValueError, IndexError):
            return "Could not read the shapes"
        if err:
            return err
        self.bump()
        self.prog_abort = False
        self.prog = {"active": True, "mode": mode, "done": 0, "total": len(lines), "error": None, "result": None}
        threading.Thread(target=self.run_program, args=(lines, mode), daemon=True).start()
        return None

    def run_program(self, lines, mode):
        names = {"cut": "Cut", "trace": "Dry run of the cut lines", "box": "Dry run of the perimeter",
                 "pulse": "Torch test"}
        self.say("%s started" % names[mode])
        on, off = self.cfg["torch_on"], self.cfg["torch_off"]
        prog = self.prog
        for i, line in enumerate(lines):
            if self.prog_abort or self.fd is None:
                break
            n = self.acks
            if not self.send_line(line):
                break
            while self.acks == n and not self.prog_abort and self.fd is not None:
                time.sleep(0.004)
            if self.acks == n:
                break
            if self.last_err:
                prog["error"] = "%s (%s)" % (self.last_err, ERRORS.get(self.last_err, "see GRBL error list"))
                self.stop()
                break
            if mode in ("cut", "pulse"):
                if line == on:
                    self.torch = True
                elif line == off:
                    self.torch = False
            prog["done"] = i + 1
        finished = prog["done"] == prog["total"]
        if self.fd is None and not finished:
            prog["error"] = prog["error"] or "Lost the controller"
        self.torch = False
        if finished:
            prog["result"] = "done"
            self.say("%s finished" % names[mode])
        else:
            prog["result"] = "error" if prog["error"] else "stopped"
            self.say("%s %s" % (names[mode], "failed: " + prog["error"] if prog["error"] else "stopped"))
        prog["active"] = False

    def snapshot(self, since):
        x, y = self.work_xy()
        return {
            "connected": self.fd is not None,
            "port": self.port,
            "state": self.state,
            "x": round(x, 2),
            "y": round(y, 2),
            "max_feed": self.max_feed,
            "config": self.cfg,
            "zero_ok": self.zero_ok,
            "free": self.free,
            "limits_on": bool(self.limits_on()),
            "torch": self.torch,
            "info": dict(self.info),
            "flash": dict(self.flash),
            "program": dict(self.prog),
            "seq": self.seq,
            "log": [t for s, t in list(self.log) if s > since],
        }


GRBL = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        elif path == "/api/state":
            since = 0
            if "since=" in self.path:
                try:
                    since = int(self.path.split("since=")[1].split("&")[0])
                except ValueError:
                    pass
            self.reply(GRBL.snapshot(since))
        elif path == "/api/settings":
            self.reply({"settings": dict(GRBL.settings), "info": dict(GRBL.info)})
        elif path == "/api/projects":
            self.reply({"projects": project_list()})
        elif path == "/api/project":
            from urllib.parse import parse_qs, urlparse
            name = (parse_qs(urlparse(self.path).query).get("name") or [""])[0]
            fp = project_path(name)
            try:
                with open(fp) as f:
                    self.reply({"ok": True, "data": json.load(f)})
            except (OSError, ValueError, TypeError):
                self.reply({"ok": False, "error": "That project could not be opened"})
        elif path == "/api/firmware":
            self.reply({"files": [{"name": n, "note": note} for n, _, note in firmware_files()]})
        else:
            self.reply({"error": "not found"}, 404)

    def do_POST(self):
        # Only this page may drive the machine, not some other site open in the browser.
        origin = self.headers.get("Origin")
        if origin and origin not in ("http://127.0.0.1:%d" % HTTP_PORT, "http://localhost:%d" % HTTP_PORT):
            return self.reply({"error": "forbidden"}, 403)
        if self.path.split("?")[0] == "/api/convert":
            # a raw 3D file in, a binary STL in millimetres out
            from urllib.parse import parse_qs, urlparse
            name = (parse_qs(urlparse(self.path).query).get("name") or ["model"])[0]
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if not (0 < n <= 400 * 1024 * 1024):
                return self.reply({"ok": False, "error": "That file is empty or larger than 400 MB."})
            stl, err = convert_model(name, self.rfile.read(n))
            if err:
                return self.reply({"ok": False, "error": err})
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(stl)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(stl)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.reply({"error": "bad request"}, 400)
        g = GRBL
        path = self.path
        err = None
        if path == "/api/jog":
            err = g.jog(body.get("dx", 0), body.get("dy", 0), body.get("feed"), body.get("step"))
        elif path == "/api/keep":
            g.last_keep = time.time()
        elif path == "/api/stop":
            g.stop()
        elif path == "/api/zero":
            err = g.set_zero()
        elif path == "/api/farcorner":
            err = g.set_corner("br")
        elif path == "/api/corner":
            err = g.set_corner(body.get("which"))
        elif path == "/api/project/save":
            try:
                err = project_save(body.get("name"), body.get("data"))
            except OSError as e:
                err = "Could not save: %s" % e
        elif path == "/api/project/delete":
            fp = project_path(body.get("name"))
            try:
                os.remove(fp)
            except (OSError, TypeError):
                err = "That project could not be removed"
        elif path == "/api/settings/refresh":
            err = g.refresh_settings()
        elif path == "/api/setting":
            err = g.set_setting(body.get("n"), body.get("value"))
        elif path == "/api/flash":
            err = g.start_flash(str(body.get("file") or ""), backup_only=bool(body.get("backup_only")))
        elif path == "/api/goto":
            err = g.goto(body.get("x"), body.get("y"), body.get("feed"))
        elif path == "/api/run":
            err = g.start_program(body.get("paths"), body.get("mode"), bool(body.get("armed")))
        elif path == "/api/freetravel":
            g.free = bool(body.get("on"))
            g.say("Free travel ON: travel limits ignored" if g.free else "Free travel off")
        elif path == "/api/clearlimits":
            g.cfg["x_max"] = g.cfg["y_max"] = None
            save_config(g.cfg)
            g.say("Travel limits cleared")
        elif path == "/api/gozero":
            err = g.go_zero(body.get("feed"))
        elif path == "/api/unlock":
            err = g.busy()
            if not err:
                g.send_line("$X", echo=True)
        elif path == "/api/reset":
            g.prog_abort = True
            g.holding = False
            g.need_resume = False
            g.pending.clear()
            g.write(b"\x18")
            g.say("Controller reset")
        elif path == "/api/config":
            for k in ("swap_xy", "flip_x", "flip_y"):
                if k in body:
                    g.cfg[k] = bool(body[k])
            if "max_hold_mm" in body:
                try:
                    cap = float(body["max_hold_mm"])
                    g.cfg["max_hold_mm"] = 0 if cap <= 0 else max(1.0, min(cap, 300.0))
                except (TypeError, ValueError):
                    pass
            for k in ("x_max", "y_max"):
                if k in body:
                    try:
                        g.cfg[k] = None if body[k] in (None, "", 0) else round(max(10.0, min(float(body[k]), 5000.0)), 2)
                    except (TypeError, ValueError):
                        pass
            for k, lo, hi in (("cut_feed", 10, 20000), ("travel_feed", 10, 20000), ("dry_feed", 10, 20000),
                              ("pierce_delay", 0, 10), ("end_delay", 0, 10), ("thickness", 0.1, 100), ("kerf", 0.1, 10)):
                if k in body:
                    try:
                        v = float(body[k])
                        if math.isfinite(v):
                            g.cfg[k] = max(lo, min(v, hi))
                    except (TypeError, ValueError):
                        pass
            for k in ("torch_on", "torch_off"):
                if k in body and re.match(r"^[A-Za-z][A-Za-z0-9 .]{0,29}$", str(body[k]).strip()):
                    g.cfg[k] = str(body[k]).strip().upper()
            if "return_zero" in body:
                g.cfg["return_zero"] = bool(body["return_zero"])
            if "materials" in body:
                mats = clean_materials(body["materials"])
                if mats:
                    g.cfg["materials"] = mats
            if "board" in body and re.match(r"^[a-z0-9-]{1,30}$", str(body["board"])):
                g.cfg["board"] = str(body["board"])
            if "material" in body:
                g.cfg["material"] = str(body["material"])[:40]
            save_config(g.cfg)
        elif path == "/api/cmd":
            line = str(body.get("line", "")).strip()
            err = g.busy()
            if line and not err:
                g.send_line(line, echo=True)
        else:
            return self.reply({"error": "not found"}, 404)
        self.reply({"ok": err is None, "error": err})


def main():
    global GRBL
    GRBL = Grbl(sys.argv[1] if len(sys.argv) > 1 else None)
    threading.Thread(target=GRBL.reader, daemon=True).start()
    threading.Thread(target=GRBL.poller, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler)
    print("TorchBed is running: http://127.0.0.1:%d   (Ctrl+C to quit)" % HTTP_PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        GRBL.stop()
        print("\nStopped.")


if __name__ == "__main__":
    main()
