# Development

TorchBed is deliberately small and dependency-free.

```
jog/
  server.py        Python standard library only: serial link to GRBL, cut program streaming,
                   settings, firmware flashing, project files, Blender conversion. Serves the page.
  index.html       The whole user interface in one file (no build step, no framework).
  flasher.py       STK500v1 firmware flasher (no avrdude).
  tools/
    boolops.js     polygon boolean operations
    slicer.js      STL/OBJ parsing, mesh slicing, sheet nesting
    formats.js     GLB/glTF, 3MF, PLY, OFF, AMF, 3D DXF readers
    slicer2.js     never-undersize slicing, interlocking grids, plan ranking
    blender_to_stl.py  run inside Blender to convert .blend, FBX, USD...
    fake_grbl.py       simulated GRBL controller
    fake_bootloader.py simulated Arduino bootloader
firmware/          prebuilt GRBL images, patch and licence
tests/             Node and Python test suites
scripts/           module sync and firmware build
```

## The one-file page

The geometry modules are developed and tested as separate files in `jog/tools/`, then pasted into `index.html` between marker comments so the app still runs from a single file. After editing a module:

```bash
python3 scripts/sync_modules.py
```

CI fails if the page and the modules disagree.

## Tests

```bash
node tests/boolops.test.js
```

```bash
node tests/slicer.test.js
```

```bash
node tests/slicer2.test.js
```

```bash
node tests/formats.test.js
```

```bash
python3 tests/test_flasher.py
```

Node 18+ and Python 3.8+. The flasher test needs macOS or Linux (it uses a pseudo-terminal).

## Run without a machine

In one terminal, start the simulated controller. It prints a port name:

```bash
python3 jog/tools/fake_grbl.py
```

In another, start TorchBed on that port, on a spare web port, with throwaway settings and projects:

```bash
JOG_HTTP_PORT=8791 JOG_CONFIG=/tmp/torchbed-test.json JOG_PROJECTS=/tmp/torchbed-projects python3 jog/server.py /dev/ttys012
```

Open http://127.0.0.1:8791. The simulator moves a pretend torch at the asked speed and prints when the torch goes on and off. `tools/fake_bootloader.py` does the same for firmware flashing.

## Environment variables

| Variable | Effect |
|---|---|
| `JOG_HTTP_PORT` | Web port (default 8790) |
| `JOG_CONFIG` | Path of the settings file (default `jog/config.json`) |
| `JOG_PROJECTS` | Folder for saved drawings (default `projects/`) |
| `JOG_BLENDER` | Path to Blender for converting .blend, FBX and similar |

## Design rules

- The server only listens on `127.0.0.1`, and refuses requests from other web origins.
- Anything that moves the machine or fires the torch goes through the server, which enforces bed limits, the arm switch and the "one program at a time" rule.
- Every wait on the controller has a timeout; a silent controller is reset rather than waited on.
- Plain language in the interface. No G-code knowledge should be needed to use it.
