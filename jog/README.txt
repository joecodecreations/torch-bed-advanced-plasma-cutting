TorchBed: draw, slice, preview and cut on a plasma table
=======================================================

Start it
  Windows:  double-click start.bat
  Mac:      double-click start.command

It opens http://127.0.0.1:8790 in the browser. Leave the black window open
while you use the machine; closing it stops the controller.

Windows needs Python 3 (python.org, or "winget install Python.Python.3.12").
Nothing else to install.

First time at the machine
  1. Move tab: jog the torch to the front-left corner of the bed.
  2. Setup tab: press "Front-left = zero".
  3. Jog to the back-right corner and press "Back-right". That teaches the
     bed size. (Or just type the width and depth and press Save.)
  The controller forgets where it is whenever it restarts, so set zero again
  each time you power up.

Making something
  - Draw with Line, Rectangle, Circle or Freehand above the bed.
  - "Trace image" turns a black and white picture into cut outlines.
  - "Import SVG / DXF" loads a drawing from Inkscape, Fusion and the like.
    You can also drop a file onto the bed.
  - Select a shape to move it, drag a corner to resize, or type exact
    position and size in the strip above the bed.
  - "Move torch here": click any point on the bed and the torch goes there.
  - Pen: click for a corner, click and drag for a curve. A green ring shows
    when the next click will close the shape (Line and Freehand do the same).
  - Size and position boxes take units and sums: 2in, 27cm, 2in + 2cm + 0.5ft.
  - Ctrl+C / Ctrl+V copies shapes. Pasting a picture opens Trace image.
  - Select two or more closed shapes to Join, Subtract, Overlap or Difference
    them. The first shape you clicked is the one kept or cut into.
  - Snap: the Snap button opens a slider (1 mm steps) and a box for any size.

3D models (flat pieces you cut and weld)
  - "3D model" loads a 3D file. Read directly: STL, OBJ, GLB/glTF, 3MF, PLY,
    OFF, AMF and DXF with 3D faces. Opened through Blender when Blender is
    installed on this computer: .blend, FBX, USD, Alembic, X3D and 3DS.
    CAD solids (STEP, IGES, F3D) cannot be read: in Fusion use File > Export
    and choose 3MF, STL or OBJ.
  - Files that state their unit (glTF, 3MF, AMF, some DXF) are sized for
    you. Set the finished size and pick the metal: one of your saved
    materials, or type any thickness.
  - Stacked layers: solid, flat layers stacked in one direction (bottom to
    top, front to back, or side to side).
  - Interlocking grid: a frame of plates in two directions that slot into
    each other (X and Y, X and Z, or Y and Z).
  - "Find the best way for me" tries all six and ranks them.
  - "Never undersize" cuts each piece to the widest part of the model inside
    its thickness, so there is metal to grind back, never a shortfall.
    "Extra material all round" adds a further margin for grinding or milling.
  - The tiles show the number of pieces, the smallest piece, the length of
    cutting and how many sheets it takes. A warning appears if pieces are
    too small to handle or too big for the bed.
  - The preview plays the assembly piece by piece: Play, step with the
    arrows, drag the timeline, and use Explode to pull the pieces apart.
  - "Show the model" lays the original model (blue) over the pieces, from
    hidden to solid. Metal showing outside the blue is what you would grind
    or machine away; blue showing outside the metal means a shortfall.
  - If the pieces do not fit on one sheet the job is split over several:
    use the sheet arrows at the top left of the bed and cut one at a time.
  - Each piece shows its number on the bed. After cutting, "Assembly" in the
    toolbar replays how they go together.

Saving
  - File > Save keeps the drawing, every sheet, the cut order and the 3D
    assembly in the "projects" folder next to the app. File > Open shows them
    with a thumbnail.
  - A draft is saved automatically as you work. If the browser or computer
    dies, the last draft comes back when you open the app again, and it is
    also listed under File > Open.

Cutting (Cut tab)
  - Click a shape and choose "Don't cut" to leave it out (it turns dashed).
  - Cut order: the list on the left shows the shapes in the order they will
    be cut. Click a row to select that shape, drag rows to reorder, or use
    Cut first / Cut last. A warning triangle marks an outline that would be
    cut before something inside it. "Use automatic order" goes back to
    holes first, then nearest.
  - "Watch the cut on screen" plays the job in 2D or 3D without moving the
    machine: drag to orbit, scrub the timeline, change the playback speed.
  - Pick a material at the top of the settings. Each one remembers its own
    thickness, cut speed, pierce delay and pause. Change the numbers and
    press "Save to this material", or "New..." to add your own label.
    "Cut width (kerf)" is the width of the slot the torch leaves. Measure
    a test cut and type it in; the preview then shows cuts at that width.
    The built-in ones are rough starting points: tune them against the cut
    chart in your plasma cutter's manual.
  - "Trace the perimeter" runs the square around all shapes, torch off, to
    check the metal is big enough and in the right place.
  - "Trace the cut lines" follows the real cut path, torch off.
  - To cut: flip "Arm the torch", press Cut, confirm.
  - STOP, the Space bar or Escape halts any move or cut and switches the
    torch off.

Torch relay wiring
  Relay signal input -> Arduino pin A3 (labelled CoolEn on a CNC shield)
  Relay ground       -> Arduino GND
  Relay contacts     -> the torch's trigger wires
  Use a relay board that switches ON with a HIGH signal. GRBL turns A3 on
  with M8 and off with M9; no firmware change is needed. The commands can be
  changed in the Setup tab if you wire it to a different output.

Board tab
  - Pick your controller board, then "Show the wiring diagram" to see every
    pin, what it does and what is wired to it on this machine.
  - "Settings stored on the board" reads GRBL's $ settings (steps per mm,
    top speed, acceleration, motor direction and so on) and lets you change
    them. They are saved on the Arduino straight away.
  - Firmware: choose a build and press "Flash this firmware". It first saves
    a copy of what is on the board into firmware/backups, then writes the new
    firmware and checks it. No extra software is needed.
      grbl-1.1h-corexy                    this machine's normal firmware
      grbl-1.1h-corexy-torch-inverted     for relay boards that switch on LOW
      grbl-1.1h-standard-xy               one motor per axis (not CoreXY)
      grbl-1.1h-standard-xy-torch-inverted
    To get back to where you were, flash the newest file under backups.

Arduino not found on Windows?
  - A real Arduino Uno needs no driver on Windows 10/11.
  - A clone with a CH340 chip needs the CH340 driver (search "CH341SER").
  - Device Manager > Ports (COM & LPT) shows its COM number. To force it:
    open a Command Prompt in this folder and run   start.bat COM5
  - Only one program can hold the port. Close Arduino IDE, UGS, Candle, etc.

Appearance: Setup tab > "Colours and appearance" opens a panel with a tab for
each part of the app: the drawing bed (cut line, fill, cut order numbers,
move path, shading by cut order), the cut preview (cut line, torch, sparks)
and the 3D views (metal, the piece being placed, the model overlay). The cut
preview has its own Appearance button too. These are saved in the browser.

Settings (bed size, directions, cut settings, materials) are saved in
config.json.

Testing without the machine (Mac/Linux): see tools/fake_grbl.py.
