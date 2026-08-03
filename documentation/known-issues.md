# Unfinished work and traps

State as of 3 August 2026. Ordered by how much damage each one can do.


## 1. Safety

### The Z axis is never homed, but claims it was

`home()` in `nanoCode/src/main.cpp` has the entire Z block commented out:

```cpp
//int freqZ = int(15 * myCalib.stepLenghtT8) / 2;
//myCalib.setupFreqZ(freqZ);
//while (myCalib.finishedJob < 1) { }
```

Yet at the end of the function it still does:

```cpp
myToolHead.z = myCalib.maxZ;   // or 0
myCalib.homed = true;
```

**The firmware therefore believes Z is at a known position without ever having
moved it.** After homing, the Z value is fabricated. The first cutting move is
derived from it, so the tip either travels through air or digs into the board.

This is the one item on the list that has to be fixed **before** the first real
milling run.

When uncommenting it, watch that commented-out frequency:
`MAX_SPEED * stepLenghtT8 / 2` is 16000 Hz, i.e. 80 mm/s on Z. That is eight
times what the axis can take. It has to use the same ceiling as `moveZ()`.

### The emergency button is disconnected

In `initialate()`:

```cpp
//pinMode(EMERGENCY_PIN, INPUT_PULLUP);
//attachInterrupt(digitalPinToInterrupt(EMERGENCY_PIN), emergencyButtonInterupt, FALLING);
```

The hardware stop on D2 does nothing. Emergency from the frontend is only a
software stop meaning "finish the current command, then hold" — it does not act
mid-move. While this stands, the only real emergency stop is cutting power.

### The endstops are wired NO

Normally open to GND, so "not pressed" is HIGH. A broken wire looks exactly
like "everything is fine". NC wiring fails in the safe direction, and in code
it is just a flipped condition in `interupt*()`.


## 2. Functional bugs

### listenUART reports success even after a total timeout

`webUI/nanoComm/main.cpp`. When the 600 s deadline expires, the loop exits the
same way it does after a successful read, and `datafieng()` parses whatever was
left in the buffer. The report goes out as **status 1, error 0** — "everything
is fine" — even though the Nano sent nothing for ten minutes.

This is now logged (`[UART] Timed out after ...`), but the return value did not
change. It needs its own error code and a `return` instead of falling through.

### The report does not show real spindle rpm

`myToolHead.spindleSpeed` is read into the report but **never written
anywhere**. `controlSpindl()` computes the duty and drives the pin, but never
stores it back into `myToolHead`. The frontend therefore keeps showing the same
value no matter what the spindle is doing.

### moveAwayFromEndStop runs inside an interrupt and probably does nothing

`motorNema17::moveAwayFromEndStop()` is called from `interupt*()`, i.e. **from
inside `ISR(TIMER1_COMPA_vect)`**. It does 25 steps with `delayMicroseconds(2)`
on both edges — roughly 100 µs spent inside an interrupt handler. The timer
ticks at 20 kHz, i.e. every 50 µs, so the retract costs two or more missed
ticks.

On top of that, 2 + 2 µs is a 4 µs period, i.e. 250 kHz. No stepper follows
that, so those 25 steps are never actually taken and the axis just buzzes. It
needs either a wider pulse spacing or the retract moved out of the ISR behind a
flag.

### The backend connects to nanoComm exactly once

`connectSockets()` runs at startup and never retries on failure. If nanoComm
crashes or restarts, the backend stays disconnected until it is restarted
itself. `sendCMD()` at least reports this honestly and returns `false`.

This is also where the startup order requirement comes from — nanoComm has to
be running before the backend.

### nanoComm's homed never returns to false

`communicator::homed` is set to `true` on homing and stays there. When the
machine later hits an endstop and loses its reference, the Nano drops its own
flag and starts reporting error 7, but nanoComm does not know and keeps
forwarding moves. Clearing the flag when an error 7 report arrives would fix it.

### deleteGcode does not delete the generated G-code

It removes the SQLite row and the Gerber from `gerbers/`, but leaves
`gcodes/<name>.gcode` in place. There is a TODO for it in the code. The
consequence: deleting and re-uploading the same name can reuse the old G-code.


## 3. Fragile spots that currently hold

These are not bugs today, but they break on the first change next to them.

### timer1Start() is called before setupPins()

`initialate()` starts the timer before configuring the pins. The ISR is already
running and reaches for `motorX.portStep`, which is not set yet. It only works
because `myCNC` is a global and therefore zeroed before its constructor runs,
so `clockX/Y/Z` are 0 and the ISR services no axis. Swapping those two lines
would make it robust.

### masterFreq always assumes GT2 geometry

```cpp
10UL * (max(maxSpeedX, maxSpeedY, maxSpeedZ) / (2 * pulleyNumTeeth)) * (jumperDown * 200)
```

The maximum is taken across all three axes, but the divisor is always the
pulley. While all three speeds are equal this comes out right. The moment
`maxSpeedZ` grows past the others it comes out wrong, because Z runs on a
leadscrew.

### counter*Max is integer division

`counterXMax = masterFreq / freq`. A frequency above `masterFreq` (20000)
yields **zero** and the axis runs away. Every path that computes a frequency
therefore needs its own ceiling — `moveZ()` has one, and `home()` will need one
too once it is uncommented.

### moveZ sets maxStepZ after setupFreqZ

```cpp
myCalib.setupFreqZ(freqZ);
myCalib.maxStepZ = abs(...);
```

`setupFreqZ()` sets `clockZ = 1`, which is what makes the ISR start servicing
the axis. `maxStepZ` is only computed afterwards, so between those two lines
the ISR is working against the old limit. Swap the order.

### counterX starts at masterFreq

`setupFreqX()` sets `counterX = masterFreq`, i.e. 20000. The first step
therefore only arrives after that many ticks, until the ramp pulls the value
down. Worth measuring whether this causes a noticeable delay at the start of
every move.


## 4. Cleanup

### Relative paths in server.js

`../gerbers`, `../gcodes`, `../database/gcodes.db` and `../printer/millproject`
are relative to the **working directory**, not the source file. The backend has
to be started from `webUI/backend/`. Using `__dirname` would harden it.

Likewise `../../gcodes/<name>.gcode` in `/printGcode` assumes nanoComm runs
from `cmake-build-debug/`. There is a large comment about it in the code.

### machineMaxZ in the backend disagrees with the firmware

`server.js` has `machineMaxZ = 15`, the firmware has `MAX_Z 25`. The variable
is also unused — `checkBoardFits()` only looks at X and Y. Either reconcile it
or drop it.

### webUI/printer/info.json is empty and nothing reads it

Zero bytes, not referenced anywhere in the code.

### Outdated documentation

`webUI/nanoComm/communication-cheatsheet.md` describes communication through
JSON files on disk (`readTask()`, `doTask()`, a file queue). Today it is TCP on
ports 5000/5001. It carries a header saying it is historical — either keep that
or delete the file.

### tests/nanoTest

A standalone PlatformIO project meant to serve as a motor test. Not rewritten
yet.
</content>
