# Getting started

## Install and run

1. Install [Python 3.8+](https://www.python.org/downloads/). On Windows tick "Add python.exe to PATH".
2. Download or clone this repository.
3. Start it:
   - **Windows:** double-click `jog\start.bat`
   - **macOS:** double-click `jog/start.command`
   - **Any system:** `python3 jog/server.py`
4. Your browser opens http://127.0.0.1:8790. Leave the terminal window open while you work.

The app finds the Arduino by itself. To force a port: `python3 jog/server.py COM5` (Windows) or `python3 jog/server.py /dev/ttyACM0`.

## Teach it your machine

1. **Move** tab: use the arrow keys or the on-screen pad to jog the torch to the front-left corner.
2. **Setup** tab: press **Front-left = zero**.
3. Jog to the back-right corner and press **Back-right**. The bed on screen now matches your table. You can also type the width and depth.
4. If an arrow moves the wrong way, tick the boxes under **Direction setup** until right is right and up is away from you.

GRBL forgets where it is when it restarts, so set zero again each time you power up.

## Make something

- **Draw:** Line, Pen (click for corners, drag for curves), Rectangle, Circle, Freehand. A green ring shows when a click will close the shape.
- **Trace image:** load or paste a black and white picture.
- **Import SVG / DXF**, or drop a file on the bed.
- **3D model:** see the [3D slicing guide](3d-slicing.md).

Select a shape to move, resize, rotate, mirror or duplicate it. Size boxes accept units and sums: `2in`, `27cm`, `2in + 2cm + 0.5ft`. Select two or more closed shapes to join, subtract, overlap or take the difference.

## Cut

1. **Cut** tab: pick the material. Each one stores thickness, cut speed, pierce delay, pause after each cut and cut width. Change the numbers and press **Save to this material**, or **New…** for your own.
2. Check the **cut order** list on the left. Drag rows to rearrange, or use **Cut first** / **Cut last**.
3. **Watch the cut on screen** to see the whole job played out.
4. **Trace the perimeter**, then **Trace the cut lines**: both run with the torch off.
5. Flip **Arm the torch**, press **Cut**, confirm.

**STOP**, the **Space bar** and **Escape** halt everything and switch the torch off.

The built-in material numbers are rough starting points. Use the cut chart in your plasma cutter's manual and save over them.

## Save your work

**File > Save** stores the drawing, every sheet, the cut order and any 3D assembly in the `projects` folder. A draft is saved automatically as you work and comes back if the browser or computer dies.

## Keyboard

| Key | Does |
|---|---|
| Arrow keys | Jog |
| Space, Esc | Stop everything |
| `[` `]` | Jog slower / faster |
| V G L P R C F | Select, Go to, Line, Pen, Rectangle, Circle, Freehand |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+C / Ctrl+V / Ctrl+X | Copy, paste, cut shapes (paste a picture to trace it) |
| Ctrl+D | Duplicate |
| Ctrl+A | Select all |
| Ctrl+S | Save |
| Delete | Delete selection |
| Enter | Finish a line or pen path |
