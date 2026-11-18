#!/usr/bin/env python3
"""Tests for jog/flasher.py against jog/tools/fake_bootloader.py (pty simulator)."""
import os
import random
import select
import sys
import time
import traceback
import tty

JOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "jog")
sys.path.insert(0, JOG)
sys.path.insert(0, os.path.join(JOG, "tools"))
sys.dont_write_bytecode = True

import flasher
from flasher import FlashError, parse_hex, make_hex, read_flash, write_flash
from fake_bootloader import FakeBootloader, ATMEGA168

GRBL_HEX = os.path.join(JOG, "..", "firmware", "variants", "grbl-1.1h-corexy.hex")


class PtyPort:
    """The app's serial-port interface, over the simulator's pty slave."""
    opened = 0
    closed = 0

    def __init__(self, sim, baud, chunk=None):
        self.sim, self.chunk, self.dtr = sim, chunk, True
        self.fd = os.open(sim.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        tty.setraw(self.fd)
        sim.set_host_baud(baud)
        sim.reset()                      # opening the port resets a real board
        PtyPort.opened += 1

    def read(self, timeout):
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if not ready:
            return b""
        try:
            return os.read(self.fd, self.chunk or 4096)
        except BlockingIOError:
            return b""

    def write(self, data):
        os.set_blocking(self.fd, True)
        try:
            os.write(self.fd, data)
        finally:
            os.set_blocking(self.fd, False)

    def set_dtr(self, on):
        if on and not self.dtr:
            self.sim.reset()             # rising DTR = reset pulse
        self.dtr = on

    def close(self):
        os.close(self.fd)
        PtyPort.closed += 1


def factory(sim, chunk=None):
    return lambda baud: PtyPort(sim, baud, chunk)


def expect_error(fn, *needles):
    try:
        fn()
    except FlashError as exc:
        msg = str(exc)
        for n in needles:
            assert n.lower() in msg.lower(), "message %r lacks %r" % (msg, n)
        return msg
    raise AssertionError("FlashError was not raised")


def grbl_image():
    with open(GRBL_HEX) as fh:
        return parse_hex(fh.read())


RESULTS = []
NOTES = []


def test(fn):
    before = (PtyPort.opened, PtyPort.closed)
    t0 = time.monotonic()
    try:
        fn()
        # every port that was opened must have been closed again
        assert PtyPort.opened - before[0] == PtyPort.closed - before[1], "port left open"
        RESULTS.append((fn.__name__, True, time.monotonic() - t0, ""))
    except Exception:
        RESULTS.append((fn.__name__, False, time.monotonic() - t0, traceback.format_exc()))
    return fn


# ---------------- hex ----------------

@test
def hex_roundtrip_random():
    rng = random.Random(1234)
    for size in (1, 15, 16, 17, 128, 1000, 32256):
        img = bytes(rng.randrange(256) for _ in range(size - 1)) + b"\x5a"
        text = make_hex(img)
        assert text.endswith(":00000001FF\n")
        assert all(len(l) <= 43 for l in text.splitlines())
        assert parse_hex(text) == img
    # trailing 0xFF padding is trimmed
    assert parse_hex(make_hex(b"\x01\x02" + b"\xff" * 50)) == b"\x01\x02"
    # CRLF line endings are fine
    assert parse_hex(make_hex(img).replace("\n", "\r\n")) == img


@test
def hex_roundtrip_real_grbl():
    img = grbl_image()
    NOTES.append("grblUpload.ino.hex -> %d bytes (%d pages, %d bytes free below 0x7E00)"
                 % (len(img), -(-len(img) // 128), 32256 - len(img)))
    assert 20000 < len(img) <= 32256
    assert parse_hex(make_hex(img)) == img


@test
def hex_gaps_and_record_types():
    # gap filled with 0xFF; type 04 with base 0 and type 02 with base 0 accepted
    text = ":020000040000FA\n:020000020000FC\n:0100000011EE\n:0100100022CD\n:00000001FF\n"
    img = parse_hex(text)
    assert img == b"\x11" + b"\xff" * 15 + b"\x22", img
    # type 02 segment 0x0100 -> base 0x1000
    img = parse_hex(":020000020100FB\n:01000000AA55\n:00000001FF\n")
    assert len(img) == 0x1001 and img[0x1000] == 0xAA and img[0] == 0xFF
    # type 04 with nonzero base -> beyond 64 KiB
    expect_error(lambda: parse_hex(":020000040001F9\n:01000000AA55\n:00000001FF\n"), "64 KiB")
    expect_error(lambda: parse_hex(":020000021000EC\n:00000001FF\n"), "64 KiB")
    expect_error(lambda: parse_hex(""), "empty")
    expect_error(lambda: parse_hex("hello\n"), "not Intel HEX")
    expect_error(lambda: parse_hex(":0100000011\n"), "length")
    expect_error(lambda: parse_hex(":01000000ZZEE\n"), "hex digits")


@test
def hex_bad_checksum_refused():
    text = make_hex(grbl_image())
    lines = text.splitlines()
    l = lines[100]
    lines[100] = l[:-1] + ("0" if l[-1] != "0" else "1")
    expect_error(lambda: parse_hex("\n".join(lines)), "checksum", "line 101")


# ---------------- flashing ----------------

@test
def write_real_grbl_and_compare():
    img = grbl_image()
    events = []
    with FakeBootloader() as sim:
        res = write_flash(factory(sim), img, progress=lambda *a: events.append(a))
        assert res["bytes"] == len(img) and res["baud"] == 115200 and res["verified"] is True, res
        assert bytes(sim.flash[:len(img)]) == img
        assert sim.flash[len(img):] == b"\xff" * (32768 - len(img))
        assert sim.pages_written == -(-len(img) // 128)
        assert sim.commands[-1] == 0x51          # LEAVE_PROGMODE was last
        assert sim.protocol_errors == 0
    # progress: sensible and monotonic
    stages = [e[0] for e in events]
    order = [s for i, s in enumerate(stages) if i == 0 or stages[i - 1] != s]
    assert order == ["connect", "write", "verify"], order
    for stage in order:
        ev = [e for e in events if e[0] == stage]
        dones = [e[1] for e in ev]
        assert dones == sorted(dones), stage
        assert all(0 <= e[1] <= e[2] for e in ev), stage
        assert len({e[2] for e in ev}) == 1, stage
        assert ev[-1][1] == ev[-1][2], "%s did not reach 100%%" % stage
        if stage != "connect":
            assert ev[0][1] == 0 and ev[0][2] == len(img)
            assert len(ev) == -(-len(img) // 128) + 1
    NOTES.append("write+verify of GRBL: %d progress events, result %r" % (len(events), res))


@test
def read_flash_returns_image():
    img = grbl_image()
    events = []
    with FakeBootloader() as sim:
        write_flash(factory(sim), img)
        back = read_flash(factory(sim), progress=lambda *a: events.append(a))
        assert len(back) == 32256
        assert back[:len(img)] == img and back[len(img):] == b"\xff" * (32256 - len(img))
        # odd size, not a page multiple
        assert read_flash(factory(sim), size=1001) == img[:1001]
        assert parse_hex(make_hex(back)) == img   # trailing 0xFF trimmed -> same image
    rd = [e for e in events if e[0] == "read"]
    assert rd[0][1:] == (0, 32256) and rd[-1][1:] == (32256, 32256)
    assert [e[1] for e in rd] == sorted(e[1] for e in rd)


@test
def overwrite_existing_firmware():
    # -D semantics: no chip erase, pages are simply rewritten
    rng = random.Random(7)
    with FakeBootloader() as sim:
        sim.flash[:32256] = bytes(rng.randrange(256) for _ in range(32256))
        old_tail = bytes(sim.flash[640:32256])
        img = bytes(rng.randrange(256) for _ in range(600))   # ends mid-page
        write_flash(factory(sim), img)
        assert bytes(sim.flash[:600]) == img
        assert sim.flash[600:640] == b"\xff" * 40             # padding of last page
        assert bytes(sim.flash[640:32256]) == old_tail        # rest untouched


@test
def junk_before_sync_tolerated():
    img = grbl_image()[:2000]
    for kw in (dict(banner=True),
               dict(junk=bytes(range(256))),                  # contains 0x14 and 0x10 bytes
               dict(junk=b"\x14\x00\x10\x14", banner=True),
               dict(banner=True, ignore_syncs=6)):            # slow to start as well
        with FakeBootloader(**kw) as sim:
            res = write_flash(factory(sim), img)
            assert res["verified"] and bytes(sim.flash[:2000]) == img, kw


@test
def realistic_one_second_listen_window():
    # Bootloader gives up 1 s after reset/last command, like real Optiboot.
    img = grbl_image()
    with FakeBootloader(banner=True, listen_window=1.0) as sim:
        write_flash(factory(sim), img)
        assert bytes(sim.flash[:len(img)]) == img


@test
def one_byte_at_a_time_reads():
    img = grbl_image()[:3000]
    with FakeBootloader(banner=True) as sim:
        write_flash(factory(sim, chunk=1), img)
        assert read_flash(factory(sim, chunk=1), size=3000) == img


@test
def falls_back_to_57600():
    img = grbl_image()[:1000]
    events = []
    with FakeBootloader(baud=57600) as sim:
        res = write_flash(factory(sim), img, progress=lambda *a: events.append(a))
        assert res["baud"] == 57600, res
        assert bytes(sim.flash[:1000]) == img
    assert [e[1:] for e in events if e[0] == "connect"] == [(0, 2), (1, 2), (2, 2)]


@test
def wrong_signature_raises():
    with FakeBootloader(signature=ATMEGA168) as sim:
        msg = expect_error(lambda: write_flash(factory(sim), b"\x00" * 300), "1E 94 06")
        assert sim.pages_written == 0
        expect_error(lambda: read_flash(factory(sim)), "1E 94 06")
    NOTES.append("wrong signature message: " + msg)
    # ATmega328 (non-P) is accepted
    with FakeBootloader(signature=bytes([0x1E, 0x95, 0x14])) as sim:
        write_flash(factory(sim), b"\x00" * 300)


@test
def dead_port_raises_quickly():
    with FakeBootloader(dead=True) as sim:
        t0 = time.monotonic()
        msg = expect_error(lambda: write_flash(factory(sim), b"\x00" * 300), "did not answer")
        took = time.monotonic() - t0
        assert took < 8, took
    NOTES.append("dead port: FlashError after %.1f s (two bauds). Message: %s" % (took, msg))


@test
def board_dies_mid_write():
    with FakeBootloader(die_after_pages=5) as sim:
        t0 = time.monotonic()
        msg = expect_error(lambda: write_flash(factory(sim), grbl_image()),
                           "stopped answering", "incomplete")
        assert time.monotonic() - t0 < 6
    NOTES.append("mid-write stall message: " + msg)


@test
def corrupted_readback_raises_verify_error():
    img = grbl_image()
    with FakeBootloader(corrupt_read_at=0x1234) as sim:
        msg = expect_error(lambda: write_flash(factory(sim), img),
                           "verification failed", "0x1234")
        assert bytes(sim.flash[:len(img)]) == img      # the write itself was fine
        res = write_flash(factory(sim), img, verify=False)   # no verify -> no error
        assert res["verified"] is False
    NOTES.append("verify message: " + msg)


@test
def oversize_and_empty_refused_before_opening():
    def no_port(baud):
        raise AssertionError("port must not be opened")
    expect_error(lambda: write_flash(no_port, b"\x00" * 32257), "too big")
    expect_error(lambda: write_flash(no_port, b""), "empty")
    expect_error(lambda: read_flash(no_port, size=40000), "40000")
    with FakeBootloader() as sim:                       # exactly 32256 is allowed
        img = bytes(random.Random(3).randrange(256) for _ in range(32256))
        write_flash(factory(sim), img)
        assert bytes(sim.flash[:32256]) == img and sim.flash[32256:] == b"\xff" * 512


@test
def open_failure_is_flash_error():
    def busy(baud):
        raise OSError(16, "Resource busy")
    expect_error(lambda: write_flash(busy, b"\x00" * 10), "could not open", "Resource busy")


if __name__ == "__main__":
    width = max(len(r[0]) for r in RESULTS)
    for name, ok, took, tb in RESULTS:
        print("%-*s  %s  %5.1fs" % (width, name, "PASS" if ok else "FAIL", took))
        if tb:
            print(tb)
    print()
    for n in NOTES:
        print("note:", n)
    failed = sum(1 for r in RESULTS if not r[1])
    print("\n%d passed, %d failed" % (len(RESULTS) - failed, failed))
    sys.exit(1 if failed else 0)
