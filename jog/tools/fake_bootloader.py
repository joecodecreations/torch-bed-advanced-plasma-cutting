#!/usr/bin/env python3
"""Fake Optiboot (ATmega328P, STK500v1) on a pseudo-terminal, for testing flasher.py.

POSIX only (uses pty). Standard library only.

In-process:
    sim = FakeBootloader(banner=True)
    sim.port       # slave tty path, e.g. /dev/ttys012
    sim.flash      # bytearray(32768), starts as 0xFF
    sim.reset()    # what a DTR pulse does on a real board
    sim.close()

As a script:
    python3 fake_bootloader.py [--banner] [--wrong-signature] [--dead] ...
prints the port name and serves until Ctrl-C. A pty has no DTR line, so in
script mode the bootloader is simply always listening.
"""

import argparse
import os
import pty
import select
import threading
import time
import tty

FLASH_SIZE = 32768
GRBL_BANNER = b"\r\nGrbl 1.1h ['$' for help]\r\n"
ATMEGA328P = bytes([0x1E, 0x95, 0x0F])
ATMEGA168 = bytes([0x1E, 0x94, 0x06])      # handy "wrong chip"

INSYNC, OK, EOP = 0x14, 0x10, 0x20

# Fixed number of bytes between the command byte and EOP.
FIXED_ARGS = {
    0x30: 0,    # GET_SYNC
    0x41: 1,    # GET_PARAMETER
    0x42: 20,   # SET_DEVICE
    0x45: 5,    # SET_DEVICE_EXT
    0x50: 0,    # ENTER_PROGMODE
    0x51: 0,    # LEAVE_PROGMODE
    0x55: 2,    # LOAD_ADDRESS
    0x74: 3,    # READ_PAGE (len_hi len_lo memtype)
    0x75: 0,    # READ_SIGN
}


class FakeBootloader:
    """An Optiboot look-alike served on a pty.

    Options (all off by default):
      junk             bytes sent on every reset AND right before the first
                       sync reply after a reset (stale data + noise)
      banner           shorthand for junk = the GRBL startup banner
      signature        3 bytes returned by READ_SIGN
      dead             swallow everything, never answer
      corrupt_read_at  byte address whose value is flipped in READ_PAGE
                       replies (the flash array itself stays correct)
      ignore_syncs     drop this many GET_SYNCs after each reset (slow boot)
      die_after_pages  stop answering after this many PROG_PAGEs
      listen_window    seconds without a command before the "application"
                       starts and the bootloader stops listening until the
                       next reset (real Optiboot: about 1 s). None = forever.
      baud             the baud this board talks at; see set_host_baud()
    """

    def __init__(self, junk=b"", banner=False, signature=ATMEGA328P, dead=False,
                 corrupt_read_at=None, ignore_syncs=0, die_after_pages=None,
                 listen_window=None, baud=115200):
        self.flash = bytearray(b"\xff" * FLASH_SIZE)
        self.junk = bytes(junk) + (GRBL_BANNER if banner else b"")
        self.signature = bytes(signature)
        self.dead = dead
        self.corrupt_read_at = corrupt_read_at
        self.ignore_syncs = ignore_syncs
        self.die_after_pages = die_after_pages
        self.listen_window = listen_window
        self.baud = baud

        # Things tests can look at.
        self.pages_written = 0
        self.resets = 0
        self.protocol_errors = 0
        self.commands = []          # command bytes seen, in order

        self._host_baud = baud
        self._lock = threading.Lock()
        self._buf = bytearray()
        self._address = 0           # byte address
        self._syncs_to_ignore = 0
        self._junk_pending = False
        self._listening = True
        self._deadline = None
        self._stop = False

        self._master, self._slave = pty.openpty()
        tty.setraw(self._slave)     # no echo, no CR/LF translation
        os.set_blocking(self._master, False)
        self.port = os.ttyname(self._slave)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # -- controls used by tests --

    def reset(self):
        """Simulate the board's reset line being pulsed (DTR)."""
        with self._lock:
            self.resets += 1
            self._buf.clear()
            self._address = 0
            self._syncs_to_ignore = self.ignore_syncs
            self._junk_pending = bool(self.junk)
            self._listening = True
            self._touch()
            if self.junk and not self.dead:
                self._send(self.junk)

    def set_host_baud(self, baud):
        """Tell the simulator what baud the host opened the port at.

        A pty has no baud rate, so a mismatch is simulated: the board hears
        nothing sensible and stays silent.
        """
        with self._lock:
            self._host_baud = baud

    def close(self):
        self._stop = True
        self._thread.join(timeout=1.0)
        for fd in (self._master, self._slave):
            try:
                os.close(fd)
            except OSError:
                pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- internals --

    def _send(self, data):
        # Non-blocking: if nobody is reading and the pty is full, give up
        # after a moment and drop the rest (a real UART would lose it too).
        data = bytes(data)
        deadline = time.monotonic() + 0.2
        while data:
            try:
                data = data[os.write(self._master, data):]
            except BlockingIOError:
                if time.monotonic() > deadline:
                    return
                time.sleep(0.005)
            except OSError:
                return

    def _touch(self):
        """Restart the watchdog (Optiboot does this on every command)."""
        if self.listen_window is not None:
            self._deadline = time.monotonic() + self.listen_window

    def _run(self):
        while not self._stop:
            try:
                ready, _, _ = select.select([self._master], [], [], 0.02)
                data = os.read(self._master, 4096) if ready else b""
            except OSError:
                time.sleep(0.02)    # nobody has the slave open right now
                continue
            with self._lock:
                # Watchdog expired: the application starts.
                if (self._listening and self._deadline is not None
                        and time.monotonic() > self._deadline):
                    self._listening = False
                    self._buf.clear()
                    if not self.dead:
                        self._send(GRBL_BANNER)
                if not data:
                    continue
                if (self.dead or not self._listening
                        or self._host_baud != self.baud):
                    continue        # swallowed
                self._buf.extend(data)
                while self._step():
                    pass

    def _step(self):
        """Handle one complete command from the buffer. False = need more."""
        buf = self._buf
        if not buf:
            return False
        cmd = buf[0]

        if cmd == 0x64:                                 # PROG_PAGE
            if len(buf) < 4:
                return False
            length = (buf[1] << 8) | buf[2]
            need = 4 + length + 1
            if len(buf) < need:
                return False
            body, eop = bytes(buf[4:4 + length]), buf[need - 1]
            del buf[:need]
            if not self._accept(cmd, eop):
                return True
            if (self.die_after_pages is not None
                    and self.pages_written >= self.die_after_pages):
                self._listening = False                 # hung board
                buf.clear()
                return False
            end = min(self._address + length, FLASH_SIZE)
            self.flash[self._address:end] = body[:end - self._address]
            self.pages_written += 1
            self._send([INSYNC, OK])
            return True

        if cmd in FIXED_ARGS:
            need = 1 + FIXED_ARGS[cmd] + 1
            if len(buf) < need:
                return False
            args, eop = bytes(buf[1:need - 1]), buf[need - 1]
            del buf[:need]
            if not self._accept(cmd, eop):
                return True
            self._fixed(cmd, args)
            return True

        # Unknown command: swallow up to the EOP and say OK.
        if EOP not in buf:
            return False
        del buf[:buf.index(EOP) + 1]
        self.commands.append(cmd)
        self._touch()
        self._send([INSYNC, OK])
        return True

    def _accept(self, cmd, eop):
        """Common bookkeeping; False if the command had no EOP where expected."""
        if eop != EOP:
            self.protocol_errors += 1                   # real Optiboot resets
            return False
        self.commands.append(cmd)
        self._touch()
        return True

    def _fixed(self, cmd, args):
        if cmd == 0x30:                                 # GET_SYNC
            if self._syncs_to_ignore > 0:
                self._syncs_to_ignore -= 1
                return
            if self._junk_pending:
                self._junk_pending = False
                self._send(self.junk)
            self._send([INSYNC, OK])
        elif cmd == 0x41:                               # GET_PARAMETER
            value = {0x81: 0x04, 0x82: 0x04}.get(args[0], 0x03)
            self._send([INSYNC, value, OK])
        elif cmd == 0x55:                               # LOAD_ADDRESS (words)
            self._address = ((args[0] | (args[1] << 8)) * 2) % FLASH_SIZE
            self._send([INSYNC, OK])
        elif cmd == 0x74:                               # READ_PAGE
            length = (args[0] << 8) | args[1]
            data = bytearray(self.flash[self._address:self._address + length])
            data.extend(b"\xff" * (length - len(data)))
            bad = self.corrupt_read_at
            if bad is not None and self._address <= bad < self._address + length:
                data[bad - self._address] ^= 0x01
            self._send(bytes([INSYNC]) + data + bytes([OK]))
        elif cmd == 0x75:                               # READ_SIGN
            self._send(bytes([INSYNC]) + self.signature + bytes([OK]))
        else:                                           # 0x42 0x45 0x50 0x51
            self._send([INSYNC, OK])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--banner", action="store_true",
                    help="send a GRBL banner before the first sync reply")
    ap.add_argument("--junk", default="", help="hex bytes of junk to send, e.g. 00ff55")
    ap.add_argument("--wrong-signature", action="store_true",
                    help="report an ATmega168 signature")
    ap.add_argument("--dead", action="store_true", help="never answer")
    ap.add_argument("--corrupt-read", type=lambda s: int(s, 0), default=None,
                    metavar="ADDR", help="flip one bit at this address on read-back")
    ap.add_argument("--die-after-pages", type=int, default=None, metavar="N",
                    help="stop answering after N page writes")
    ap.add_argument("--dump", metavar="FILE",
                    help="write the 32768-byte flash array to FILE on exit")
    args = ap.parse_args()

    sim = FakeBootloader(
        junk=bytes.fromhex(args.junk), banner=args.banner,
        signature=ATMEGA168 if args.wrong_signature else ATMEGA328P,
        dead=args.dead, corrupt_read_at=args.corrupt_read,
        die_after_pages=args.die_after_pages)
    sim.reset()
    print(sim.port, flush=True)
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        if args.dump:
            with open(args.dump, "wb") as fh:
                fh.write(sim.flash)
        sim.close()


if __name__ == "__main__":
    main()
