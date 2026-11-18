# Contributing to TorchBed

Thanks for helping. The project is young, and the most useful contributions right now are:

1. **Reports from real machines.** What you cut, on what, what worked and what did not. Material settings that gave clean cuts are gold.
2. **Bug reports** with steps to reproduce, your operating system, and the text from Setup > Controller messages.
3. **Pull requests**, small and focused.

## Ground rules

- **Safety first.** Changes that touch motion, the torch or stopping need a clear explanation of what happens when things go wrong (lost connection, browser closed, controller reset).
- **No dependencies.** The server uses only the Python standard library and the page uses no framework or build step. That is a feature.
- **Plain language** in everything a user reads. No jargon they would have to look up.
- **Keep it tested.** Geometry and file-format code lives in `jog/tools/*.js` with tests in `tests/`. Add a test with a fix.

## Working on it

See [docs/development.md](docs/development.md) for the layout, the simulators and how to run the tests. After changing a module in `jog/tools/`, run `python3 scripts/sync_modules.py` so the page picks it up.

Before opening a pull request, run all the tests and try the change in the browser against the simulator.

## Licence

By contributing you agree that your work is released under the project's MIT licence. Do not add code under other licences; the GRBL firmware images are the one exception and stay in `firmware/` under the GPL.
