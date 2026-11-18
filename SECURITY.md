# Security

TorchBed controls a machine that can hurt people, so problems that could cause unexpected motion or torch firing are treated as security issues, alongside the usual kind.

## Reporting

Please report privately with GitHub's **Security > Report a vulnerability** form on this repository rather than a public issue. Include what you did, what happened and which version (commit) you used.

## Design notes

- The server listens only on `127.0.0.1` and rejects requests whose `Origin` is another site, so a web page you happen to have open cannot drive the machine.
- It is not meant to be exposed to a network. Do not port-forward it or bind it to other addresses.
- `.blend` files are converted with Blender's auto-run scripts disabled.
- Firmware flashing never writes the bootloader region.
