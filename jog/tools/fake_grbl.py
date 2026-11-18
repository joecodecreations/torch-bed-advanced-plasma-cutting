#!/usr/bin/env python3
"""A pretend GRBL controller for testing the jog page without the machine.

Mac/Linux only (it uses a pseudo-terminal). Run:

    python3 tools/fake_grbl.py

It prints a port name. In another terminal start the server on that port, on a
spare web port and with a throwaway settings file so the real ones are left alone:

    JOG_HTTP_PORT=8791 JOG_CONFIG=/tmp/jog-test.json python3 server.py /dev/ttysNNN

It moves a pretend torch at the asked speed, answers status requests, and
understands jogs, G0/G1, G4 dwell, G10 L20 zeroing, M3/M5/M8/M9, feed hold,
jog cancel and soft reset. Torch on/off is printed as it happens.
"""
import math
import os
import pty
import re
import sys
import threading
import time
import tty

SPEEDUP = float(os.environ.get("FAKE_GRBL_SPEEDUP") or 1.0)


class Fake:
    def __init__(self, fd):
        self.fd = fd
        self.lock = threading.Lock()
        self.pos = [0.0, 0.0]
        self.wco = [0.0, 0.0]
        self.state = "Idle"
        self.queue = []          # (kind, data, wants_ok_after)
        self.absolute = True
        self.feed = 1000.0
        self.torch = False
        self.hold = False
        self.epoch = 0
        self.settings = {"0": "10", "1": "25", "2": "0", "3": "0", "4": "0", "5": "0", "6": "0", "10": "1", "11": "0.010",
                         "12": "0.002", "13": "0", "20": "0", "21": "0", "22": "0", "23": "0", "24": "25.000", "25": "500.000",
                         "26": "250", "27": "1.000", "30": "1000", "31": "0", "32": "0", "100": "80.000", "101": "80.000",
                         "102": "250.000", "110": "6000.000", "111": "6000.000", "112": "500.000", "120": "200.000",
                         "121": "200.000", "122": "10.000", "130": "340.000", "131": "340.000", "132": "200.000"}

    def out(self, text):
        try:
            os.write(self.fd, (text + "\r\n").encode())
        except OSError:
            pass

    def banner(self):
        self.out("")
        self.out("Grbl 1.1h ['$' for help]")

    def set_torch(self, on):
        if on != self.torch:
            self.torch = on
            print("TORCH %s at X%.2f Y%.2f" % ("ON " if on else "off", self.pos[0] - self.wco[0],
                                                self.pos[1] - self.wco[1]), flush=True)

    def reset(self):
        with self.lock:
            self.epoch += 1
            self.queue.clear()
            self.hold = False
            self.state = "Idle"
            self.absolute = True
        self.set_torch(False)
        self.banner()

    def realtime(self, c):
        if c == 0x18:
            self.reset()
        elif c == ord("?"):
            st = self.state
            self.out("<%s|MPos:%.3f,%.3f,0.000|FS:0,0|WCO:%.3f,%.3f,0.000>" % (
                st, self.pos[0], self.pos[1], self.wco[0], self.wco[1]))
        elif c == ord("!"):
            self.hold = True
            if self.state in ("Idle", "Run"):
                self.state = "Hold:0"
        elif c == ord("~"):
            self.hold = False
            if self.state.startswith("Hold"):
                self.state = "Idle"
        elif c == 0x85:
            with self.lock:
                if self.state == "Jog":
                    self.epoch += 1
                    self.queue = [q for q in self.queue if q[0] != "jog"]

    def line(self, text):
        text = text.strip()
        if not text:
            return self.out("ok")
        up = text.upper().replace(" ", "")
        if up == "$$":
            for k in sorted(self.settings, key=int):
                self.out("$%s=%s" % (k, self.settings[k]))
            return self.out("ok")
        if up == "$I":
            self.out("[VER:1.1h.20190830:]")
            self.out("[OPT:VC,15,128]")
            return self.out("ok")
        m = re.match(r"^\$(\d+)=(-?[\d.]+)$", up)
        if m:
            if m.group(1) not in self.settings:
                return self.out("error:3")
            old = self.settings[m.group(1)]
            self.settings[m.group(1)] = ("%.3f" % float(m.group(2))) if "." in old else str(int(float(m.group(2))))
            return self.out("ok")
        if up == "$X":
            return self.out("ok")
        if up.startswith("$J="):
            words = dict((m.group(1), float(m.group(2))) for m in re.finditer(r"([XYF])(-?[\d.]+)", up[3:]))
            rel = "G91" in up
            with self.lock:
                self.queue.append(("jog", (words, rel), False))
            return self.out("ok")
        if up.startswith("G10L20"):
            self.wco = list(self.pos)
            return self.out("ok")
        words = re.findall(r"([A-Z])(-?[\d.]+)", up)
        g = [float(v) for k, v in words if k == "G"]
        m = [float(v) for k, v in words if k == "M"]
        vals = dict((k, float(v)) for k, v in words if k in "XYFPS")
        if 90 in g:
            self.absolute = True
        if 91 in g:
            self.absolute = False
        if "F" in vals:
            self.feed = vals["F"]
        if 4 in g:
            with self.lock:
                self.queue.append(("dwell", vals.get("P", 0), True))
            return
        if m:
            with self.lock:
                self.queue.append(("torch", any(x in (3, 4, 7, 8) for x in m), True))
            return
        if "X" in vals or "Y" in vals:
            if not self.feed:
                return self.out("error:22")
            with self.lock:
                self.queue.append(("move", (vals, self.absolute, self.feed), False))
        self.out("ok")

    def travel(self, target, feed, state, epoch):
        self.state = state
        last = time.time()
        while True:
            time.sleep(0.01)
            now = time.time()
            dt, last = now - last, now
            if epoch != self.epoch:
                break
            if self.hold:
                continue
            dx, dy = target[0] - self.pos[0], target[1] - self.pos[1]
            dist = math.hypot(dx, dy)
            step = feed / 60.0 * dt * SPEEDUP
            if dist <= step or dist < 1e-6:
                self.pos = list(target)
                break
            self.pos[0] += dx / dist * step
            self.pos[1] += dy / dist * step

    def worker(self):
        while True:
            with self.lock:
                item = self.queue.pop(0) if self.queue else None
                epoch = self.epoch
            if item is None:
                if not self.hold and self.state in ("Run", "Jog"):
                    self.state = "Idle"
                time.sleep(0.005)
                continue
            kind, data, ok_after = item
            if kind == "jog":
                words, rel = data
                wx, wy = self.pos[0] - self.wco[0], self.pos[1] - self.wco[1]
                tx = (wx if rel else 0) + words["X"] if "X" in words else wx
                ty = (wy if rel else 0) + words["Y"] if "Y" in words else wy
                self.travel([tx + self.wco[0], ty + self.wco[1]], words.get("F", 1000), "Jog", epoch)
            elif kind == "move":
                vals, absolute, feed = data
                wx, wy = self.pos[0] - self.wco[0], self.pos[1] - self.wco[1]
                tx = (vals["X"] if absolute else wx + vals["X"]) if "X" in vals else wx
                ty = (vals["Y"] if absolute else wy + vals["Y"]) if "Y" in vals else wy
                self.travel([tx + self.wco[0], ty + self.wco[1]], feed, "Run", epoch)
            elif kind == "dwell":
                if not self.hold:
                    self.state = "Idle"
                end = time.time() + data / SPEEDUP
                while time.time() < end and epoch == self.epoch:
                    time.sleep(0.01)
            elif kind == "torch":
                self.set_torch(data)
            if ok_after and epoch == self.epoch:
                self.out("ok")

    def serve(self):
        threading.Thread(target=self.worker, daemon=True).start()
        self.banner()
        buf = b""
        while True:
            try:
                chunk = os.read(self.fd, 1024)
            except OSError:
                time.sleep(0.2)
                continue
            for c in chunk:
                if c in (0x18, ord("?"), ord("!"), ord("~")) or c >= 0x80:
                    self.realtime(c)
                    if c == 0x18:
                        buf = b""
                elif c in (10, 13):
                    if buf:
                        self.line(buf.decode(errors="replace"))
                    buf = b""
                else:
                    buf += bytes([c])


def main():
    master, slave = pty.openpty()
    tty.setraw(master)
    print("Pretend GRBL is on port: %s" % os.ttyname(slave), flush=True)
    Fake(master).serve()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
