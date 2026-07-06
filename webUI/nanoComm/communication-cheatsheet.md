# Communication Cheatsheet

Short reference for communication between backend, `nanoComm` C++ code, and Arduino Nano.

## Layers

```txt
Web UI
  -> backend
  -> JSON task files
  -> nanoComm C++
  -> USB serial
  -> Arduino Nano
```

`nanoComm` is the only program that talks to the Nano over USB serial.

## Main Flow

```txt
readTask()
  read one complex task from backend JSON queue

doTask(task)
  ping Nano
  if ping failed -> fail task
  use ping response as first report

  loop until complex task is done:
    read emergency command from backend
    write latest Nano report/status for backend
    prepare next basicCMD from current task + latest report
    send prepared basicCMD to Nano
    wait for Nano response/report
    if Nano returned error -> fail or stop task
    if task is complete -> mark done
```

Emergency from Web UI is a soft stop. It means "finish current small command, then stop safely".
Real emergency stop is handled by hardware power/Nano controls.

## Backend -> C++ JSON Tasks

One JSON file should represent one complex task.

Example task:

```json
{
  "id": "task_001",
  "type": "move",
  "payload": {
    "x": 10.0,
    "y": 5.0,
    "z": -0.2,
    "speed": 300
  }
}
```

Example G-code task:

```json
{
  "id": "task_002",
  "type": "readGcode",
  "payload": {
    "path": "/home/pi/cnc/gcode/board.nc"
  }
}
```

Recommended queue folders:

```txt
taskQueue/
  initialized/   backend writes new tasks here
  processing/    nanoComm moves active task here
  processed/     nanoComm writes done tasks here
  failed/        nanoComm writes failed tasks here
  emergency/     backend writes soft-stop commands here
  reports/       nanoComm writes latest status for backend here
```

Backend should write tasks as `.tmp` first, then rename to `.json` when complete.

```txt
task_001.tmp -> task_001.json
```

That prevents C++ from reading a half-written JSON file.

## Backend Task Commands

These are complex/general commands read by `readTask()`.

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `ping` | Test Nano connection |
| `1` | `move` | Move to/change position |
| `2` | `home` | Run homing |
| `3` | `readGcode` | Parse and execute G-code file |
| `4` | `stop` | Soft stop current task |
| `5` | `end` | End/shutdown current operation |
| `6` | `position` | Ask for known position |
| `7` | `speed` | Ask/change speed |
| `8` | `status` | Ask current task/status |

## C++ -> Nano basicCMD

Current binary-ish command shape:

```cpp
struct position {
    float x, y;
};

struct basicCMD {
    uint8_t command;
    position position;
    float z;
    float speed;
};
```

Nano command codes:

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `ping` | Nano replies with report |
| `1` | `move` | Simple movement command |
| `2` | `spindleSpeed` | Set spindle speed |
| `3` | `home` | Homing command |

`speed = -1` means "do not change speed".

## Nano -> C++ Report

Keep Nano responses small and numeric. Avoid strings in the real protocol.

Suggested report shape:

```cpp
struct nanoReport {
    uint8_t status;
    uint8_t error;
    position position;
    float z;
    float speed;
};
```

Suggested status codes:

| Code | Name |
| --- | --- |
| `0` | `ok` |
| `1` | `busy` |
| `2` | `done` |
| `3` | `error` |

Suggested error codes:

| Code | Name |
| --- | --- |
| `0` | `none` |
| `1` | `outOfRange` |
| `2` | `endstopTriggered` |
| `3` | `unknownCommand` |
| `4` | `serialError` |

## Soft Stop Logic

During `doTask()`:

```txt
if emergency command exists:
  prepare safe stop / no next movement
  mark task as stopped
  write final report
```

The current Nano command may finish first. For better responsiveness, split long G-code moves into smaller `basicCMD` moves.

## Important Rules

- Only `nanoComm` opens the USB serial port.
- One complex backend task can produce many `basicCMD` commands.
- C++ should wait for a Nano report before sending the next `basicCMD`.
- Nano validates machine limits and endstops.
- Backend reads reports, but does not directly control USB serial.
