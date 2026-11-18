"""Flash an Arduino Uno/Nano (ATmega328P, Optiboot or old ATmegaBOOT) over serial.

Speaks the STK500v1 bootloader protocol, i.e. what
    avrdude -c arduino -p atmega328p -D -U flash:w:file.hex:i
does. Standard library only.

This module never opens a serial port itself. The caller passes a factory:

    open_port(baud) -> port with
        port.read(timeout_seconds) -> bytes   (b"" if nothing arrived)
        port.write(data) -> None
        port.set_dtr(on) -> None              (also drives RTS)
        port.close() -> None

Public API: FlashError, parse_hex, make_hex, read_flash, write_flash.
"""

import time

PAGE_SIZE = 128            # ATmega328P flash page, in bytes
FLASH_SIZE = 32768         # whole flash, bootloader included
MAX_IMAGE = 0x7E00         # 32256: space below a 512-byte Optiboot

# Signatures we accept: ATmega328P and ATmega328 (non-P).
SIGNATURES = (b"\x1e\x95\x0f", b"\x1e\x95\x14")

# STK500v1 constants
STK_INSYNC = 0x14
STK_OK = 0x10
STK_NOSYNC = 0x15
CRC_EOP = 0x20             # ends every command
STK_GET_SYNC = 0x30
STK_ENTER_PROGMODE = 0x50
STK_LEAVE_PROGMODE = 0x51
STK_LOAD_ADDRESS = 0x55
STK_PROG_PAGE = 0x64
STK_READ_PAGE = 0x74
STK_READ_SIGN = 0x75

CMD_TIMEOUT = 1.5          # seconds to wait for an ordinary reply
PAGE_TIMEOUT = 3.0         # seconds to wait for a page write
SYNC_WINDOW = 2.5          # seconds spent trying to get sync at one baud
SYNC_INTERVAL = 0.08       # seconds between sync attempts


class FlashError(Exception):
    """Something went wrong; the message is plain English for the user."""


# --------------------------------------------------------------------------
# Intel HEX
# --------------------------------------------------------------------------

def parse_hex(text):
    """Intel HEX text -> flash image starting at address 0 (gaps = 0xFF)."""
    image = bytearray()
    base = 0
    seen_record = False
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        where = "Line %d of the firmware file" % number
        if not line.startswith(":"):
            raise FlashError("%s is not Intel HEX (it does not start with ':')." % where)
        try:
            rec = bytes.fromhex(line[1:])
        except ValueError:
            raise FlashError("%s contains characters that are not hex digits." % where)
        if len(rec) < 5 or len(rec) != rec[0] + 5:
            raise FlashError("%s has the wrong length; the file may be cut off." % where)
        if sum(rec) & 0xFF:
            raise FlashError("%s has a bad checksum; the file is damaged." % where)
        seen_record = True
        count, offset, kind = rec[0], (rec[1] << 8) | rec[2], rec[3]
        data = rec[4:4 + count]

        if kind == 0x00:                                  # data
            start = base + offset
            end = start + count
            if end > 0x10000:
                raise FlashError("%s puts data above 64 KiB; this is not firmware "
                                 "for an Arduino Uno/Nano." % where)
            if end > len(image):
                image.extend(b"\xff" * (end - len(image)))
            image[start:end] = data
        elif kind == 0x01:                                # end of file
            break
        elif kind in (0x02, 0x04):                        # segment / linear base
            if count != 2:
                raise FlashError("%s has a malformed address record." % where)
            value = (data[0] << 8) | data[1]
            base = value << 4 if kind == 0x02 else value << 16
            if base >= 0x10000:
                raise FlashError("%s addresses memory above 64 KiB; this is not "
                                 "firmware for an Arduino Uno/Nano." % where)
        elif kind in (0x03, 0x05):                        # start address: unused
            pass
        else:
            raise FlashError("%s has an unknown record type %02X." % (where, kind))
    if not seen_record:
        raise FlashError("The firmware file is empty or is not an Intel HEX file.")
    return bytes(image)


def make_hex(data):
    """Flash image -> Intel HEX text (16-byte records, trailing 0xFF trimmed)."""
    data = bytes(data).rstrip(b"\xff")
    if len(data) > 0x10000:
        raise FlashError("The image is larger than 64 KiB and cannot be saved "
                         "as a simple HEX file.")
    lines = []
    for addr in range(0, len(data), 16):
        chunk = data[addr:addr + 16]
        rec = bytes([len(chunk), addr >> 8, addr & 0xFF, 0x00]) + chunk
        rec += bytes([(-sum(rec)) & 0xFF])
        lines.append(":" + rec.hex().upper())
    lines.append(":00000001FF")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Serial link to the bootloader
# --------------------------------------------------------------------------

class _Link:
    """One open port plus the STK500 request/reply helpers."""

    def __init__(self, port):
        self.port = port
        self.buf = bytearray()      # bytes received but not yet consumed

    # -- raw I/O (port errors become FlashError) --

    def _write(self, data):
        try:
            self.port.write(bytes(data))
        except OSError as exc:
            raise FlashError("The connection to the board was lost (%s). "
                             "Check the USB cable." % exc)

    def _fill(self, timeout):
        """Wait up to `timeout` for more bytes; True if any arrived."""
        try:
            chunk = self.port.read(max(timeout, 0.0))
        except OSError as exc:
            raise FlashError("The connection to the board was lost (%s). "
                             "Check the USB cable." % exc)
        if chunk:
            self.buf.extend(chunk)
        return bool(chunk)

    def _read_exact(self, count, timeout):
        """Return exactly `count` bytes, or None if they did not all arrive."""
        deadline = time.monotonic() + timeout
        while len(self.buf) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self._fill(remaining)
        out = bytes(self.buf[:count])
        del self.buf[:count]
        return out

    def drain(self, quiet=0.05, limit=0.5):
        """Throw away input until the line is quiet (or `limit` seconds pass)."""
        deadline = time.monotonic() + limit
        while self._fill(quiet) and time.monotonic() < deadline:
            pass
        self.buf.clear()

    # -- protocol --

    def command(self, payload, reply_len=0, timeout=CMD_TIMEOUT):
        """Send payload + EOP; return the `reply_len` bytes between INSYNC and OK."""
        self._write(bytes(payload) + bytes([CRC_EOP]))
        reply = self._read_exact(reply_len + 2, timeout)
        if reply is None:
            raise FlashError("The board stopped answering. Check the USB cable "
                             "and try again.")
        if reply[0] != STK_INSYNC or reply[-1] != STK_OK:
            if reply[0] == STK_NOSYNC:
                raise FlashError("The board lost its place in the conversation. "
                                 "Unplug it, plug it back in and try again.")
            raise FlashError("The board sent an answer that makes no sense "
                             "(%s). Try again." % reply[:4].hex())
        return reply[1:-1]

    def reset_board(self):
        """Pulse DTR/RTS so the auto-reset circuit restarts the bootloader."""
        try:
            self.port.set_dtr(False)
            time.sleep(0.1)
            self.port.set_dtr(True)
        except OSError as exc:
            raise FlashError("The connection to the board was lost (%s). "
                             "Check the USB cable." % exc)
        time.sleep(0.2)

    def sync(self):
        """Reset the board and try to get the bootloader's attention."""
        self.reset_board()
        self.drain()
        deadline = time.monotonic() + SYNC_WINDOW
        found = False
        while not found and time.monotonic() < deadline:
            self._write(bytes([STK_GET_SYNC, CRC_EOP]))
            wait_until = time.monotonic() + SYNC_INTERVAL
            while time.monotonic() < wait_until:
                self._fill(wait_until - time.monotonic())
                # Junk (a GRBL banner, noise) may come before the real reply.
                if bytes([STK_INSYNC, STK_OK]) in self.buf:
                    found = True
                    break
            del self.buf[:-1]       # keep one byte in case a reply is split
        if not found:
            return False
        # Replies to earlier attempts may still be on the way: let them land,
        # drop them, then do one clean exchange to be sure we are aligned.
        self.drain(quiet=0.1)
        try:
            self.command([STK_GET_SYNC])
        except FlashError:
            return False
        return True

    def signature(self):
        return self.command([STK_READ_SIGN], reply_len=3)

    def load_address(self, byte_addr):
        word = byte_addr // 2       # the protocol uses word addresses
        self.command([STK_LOAD_ADDRESS, word & 0xFF, (word >> 8) & 0xFF])

    def prog_page(self, byte_addr, data):
        self.load_address(byte_addr)
        head = [STK_PROG_PAGE, len(data) >> 8, len(data) & 0xFF, ord("F")]
        self.command(bytes(head) + data, timeout=PAGE_TIMEOUT)

    def read_page(self, byte_addr, count):
        self.load_address(byte_addr)
        head = [STK_READ_PAGE, count >> 8, count & 0xFF, ord("F")]
        return self.command(head, reply_len=count)

    def finish(self):
        """Leave programming mode (reply optional) and always close the port."""
        try:
            self._write(bytes([STK_LEAVE_PROGMODE, CRC_EOP]))
            self._read_exact(2, 0.3)
        except FlashError:
            pass
        self.close()

    def close(self):
        try:
            self.port.close()
        except OSError:
            pass


def _report(progress, stage, done, total):
    if progress is not None:
        progress(stage, done, total)


def _connect(open_port, bauds, progress):
    """Find the bootloader. Returns (link, baud); the caller must finish() it."""
    bauds = tuple(bauds)
    if not bauds:
        raise FlashError("No baud rates were given to try.")
    for index, baud in enumerate(bauds):
        _report(progress, "connect", index, len(bauds))
        try:
            port = open_port(baud)
        except OSError as exc:
            raise FlashError("Could not open the serial port (%s). Is the board "
                             "plugged in, and is another program using it?" % exc)
        link = _Link(port)
        try:
            if link.sync():
                sig = link.signature()
                if sig not in SIGNATURES:
                    raise FlashError(
                        "This board is not an Arduino Uno/Nano (ATmega328P). Its "
                        "chip signature is %s; expected 1E 95 0F."
                        % sig.hex(" ").upper())
                _report(progress, "connect", len(bauds), len(bauds))
                return link, baud
        except BaseException:
            link.close()
            raise
        link.close()
    raise FlashError(
        "The board's bootloader did not answer. The usual causes are: the wrong "
        "port is selected; another program (Arduino IDE, a G-code sender) has "
        "the port open; the USB cable is charge-only; or the board has no "
        "Arduino bootloader. Unplug the board, plug it back in and try again.")


# --------------------------------------------------------------------------
# Public operations
# --------------------------------------------------------------------------

def read_flash(open_port, size=MAX_IMAGE, progress=None, bauds=(115200, 57600)):
    """Read `size` bytes of flash, starting at address 0."""
    if not 0 < size <= FLASH_SIZE:
        raise FlashError("Cannot read %d bytes; the chip holds %d." % (size, FLASH_SIZE))
    link, _baud = _connect(open_port, bauds, progress)
    try:
        link.command([STK_ENTER_PROGMODE])
        data = bytearray()
        _report(progress, "read", 0, size)
        while len(data) < size:
            count = min(PAGE_SIZE, size - len(data))
            data += link.read_page(len(data), count)
            _report(progress, "read", len(data), size)
        return bytes(data)
    finally:
        link.finish()


def write_flash(open_port, image, progress=None, verify=True, bauds=(115200, 57600)):
    """Write `image` to flash at address 0 (no chip erase), optionally verify."""
    image = bytes(image)
    total = len(image)
    if total == 0:
        raise FlashError("The firmware image is empty; nothing to write.")
    if total > MAX_IMAGE:
        raise FlashError("The firmware is too big for this board: %d bytes, but "
                         "only %d fit." % (total, MAX_IMAGE))
    # Pad the last page with 0xFF, then split into whole pages.
    padded = image + b"\xff" * (-total % PAGE_SIZE)
    pages = [(addr, padded[addr:addr + PAGE_SIZE])
             for addr in range(0, len(padded), PAGE_SIZE)]

    link, baud = _connect(open_port, bauds, progress)
    writing = False
    try:
        link.command([STK_ENTER_PROGMODE])
        _report(progress, "write", 0, total)
        writing = True
        for addr, page in pages:
            link.prog_page(addr, page)
            _report(progress, "write", min(addr + PAGE_SIZE, total), total)

        if verify:
            _report(progress, "verify", 0, total)
            for addr, page in pages:
                got = link.read_page(addr, PAGE_SIZE)
                if got != page:
                    bad = next(i for i in range(PAGE_SIZE) if got[i] != page[i])
                    raise FlashError(
                        "Verification failed at address 0x%04X: the board holds "
                        "0x%02X but the firmware says 0x%02X."
                        % (addr + bad, got[bad], page[bad]))
                _report(progress, "verify", min(addr + PAGE_SIZE, total), total)
    except FlashError as exc:
        if writing:
            raise FlashError("%s The firmware on the board may now be incomplete: "
                             "flash it again before using the machine." % exc)
        raise
    finally:
        link.finish()
    return {"bytes": total, "pages": len(pages), "baud": baud,
            "verified": bool(verify)}
