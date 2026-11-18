# Firmware

TorchBed drives an Arduino Uno (or Nano) running [GRBL 1.1h](https://github.com/gnea/grbl), unchanged except for build options. The app can flash these builds itself from the **Board** tab; no extra software is needed.

| File in `variants/` | Use it when |
|---|---|
| `grbl-1.1h-corexy.hex` | CoreXY machine, relay board that switches on with a HIGH signal |
| `grbl-1.1h-corexy-torch-inverted.hex` | CoreXY machine, relay board that switches on with a LOW signal |
| `grbl-1.1h-standard-xy.hex` | One motor per axis, relay switches on HIGH |
| `grbl-1.1h-standard-xy-torch-inverted.hex` | One motor per axis, relay switches on LOW |

The torch relay is driven from GRBL's coolant output (Uno pin **A3**): `M8` on, `M9` off.

## Source and licence

These are builds of GRBL, which is licensed under the GNU GPL v3 (see `COPYING-GPLv3`). The complete corresponding source is:

- upstream: https://github.com/gnea/grbl at commit `40eb439bf2afc4c6f3003836c396e183ba72c45b`
- plus `grbl-corexy.patch` in this folder (CoreXY on, per-axis homing cycles)
- the "torch inverted" builds also define `INVERT_COOLANT_FLOOD_PIN`; the "standard XY" builds leave `COREXY` off

`scripts/build_firmware.sh` rebuilds all four from that source with `arduino-cli`.

The rest of TorchBed (everything outside this folder) is a separate program that only talks to GRBL over a serial port, and is under the MIT licence.
