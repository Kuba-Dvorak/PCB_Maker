# Cheatsheet: JSON soubory mezi backendem a C++

Tenhle dokument je pro komunikaci:

```txt
backend JS -> JSON soubory -> nanoComm C++
```

Cil: jednoduche tasky pres soubory, bez socketu a bez sdileneho jednoho JSON souboru.

## Doporucene knihovny/API

### JavaScript backend

Pouzij vestavene Node.js API:

```js
import fs from "fs/promises";
import path from "path";
```

Na JSON nepotrebujes extra knihovnu:

```js
JSON.stringify(data, null, 2);
JSON.parse(text);
```

### C++ nanoComm

Pouzij standardni filesystem API:

```cpp
#include <filesystem>
#include <fstream>
```

Na JSON doporucuju knihovnu:

```cpp
#include <nlohmann/json.hpp>
```

Je jednoducha, citelna a na tenhle projekt uplne staci.

## Struktura queue slozek

```txt
taskQueue/
  initialized/   nove tasky od backendu
  processing/    task, ktery zrovna zpracovava C++
  processed/     hotove tasky
  failed/        tasky, ktere skoncily chybou
  emergency/     soft stop prikazy z backendu
  reports/       posledni status/report pro backend
```

## Zakladni pravidlo

Nikdy nezapisuj rovnou finalni `.json` soubor.

Spravne:

```txt
task_001.tmp
task_001.tmp -> task_001.json
```

Proc:

```txt
C++ cte jen .json soubory.
Backend zapisuje .tmp.
Az kdyz je soubor kompletni, backend ho prejmenuje na .json.
```

Prejmenovani souboru na stejnem filesystemu je na Linuxu atomicke.

## JS: vytvoreni tasku

```js
import fs from "fs/promises";
import path from "path";

const queueDir = "./taskQueue/initialized";

async function createTask(task) {
  const fileName = `${task.id}.json`;
  const tmpPath = path.join(queueDir, `${task.id}.tmp`);
  const finalPath = path.join(queueDir, fileName);

  const jsonText = JSON.stringify(task, null, 2);

  await fs.writeFile(tmpPath, jsonText, "utf8");
  await fs.rename(tmpPath, finalPath);
}
```

Pouziti:

```js
await createTask({
  id: "task_001",
  type: "move",
  payload: {
    x: 10.0,
    y: 5.0,
    z: -0.2,
    speed: 300
  }
});
```

## JS: precteni reportu

```js
import fs from "fs/promises";

async function readReport(pathToReport) {
  const text = await fs.readFile(pathToReport, "utf8");
  return JSON.parse(text);
}
```

Pokud report jeste neexistuje, `readFile` vyhodi chybu. To je normalni stav, ktery muzes osetrit:

```js
async function tryReadReport(pathToReport) {
  try {
    const text = await fs.readFile(pathToReport, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}
```

## JS: soft stop / emergency prikaz

```js
async function createSoftStop() {
  await createTaskInDir("./taskQueue/emergency", {
    id: `stop_${Date.now()}`,
    type: "stop",
    payload: {
      reason: "web_ui"
    }
  });
}

async function createTaskInDir(dir, task) {
  const tmpPath = path.join(dir, `${task.id}.tmp`);
  const finalPath = path.join(dir, `${task.id}.json`);

  await fs.writeFile(tmpPath, JSON.stringify(task, null, 2), "utf8");
  await fs.rename(tmpPath, finalPath);
}
```

## C++: cteni JSON tasku

```cpp
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;

std::optional<fs::path> findFirstJsonTask(const fs::path& dir) {
    for (const auto& entry : fs::directory_iterator(dir)) {
        if (entry.is_regular_file() && entry.path().extension() == ".json") {
            return entry.path();
        }
    }

    return std::nullopt;
}

json readJsonFile(const fs::path& filePath) {
    std::ifstream file(filePath);
    return json::parse(file);
}
```

## C++: presun tasku do processing

```cpp
fs::path moveToProcessing(const fs::path& taskPath) {
    fs::path processingDir = "./taskQueue/processing";
    fs::path targetPath = processingDir / taskPath.filename();

    fs::rename(taskPath, targetPath);
    return targetPath;
}
```

Tohle je podobny princip jako `.tmp -> .json`: task se presune a tim je jasne, ze ho C++ zacalo zpracovavat.

## C++: zapis reportu pro backend

```cpp
void writeJsonAtomic(const fs::path& finalPath, const json& data) {
    fs::path tmpPath = finalPath;
    tmpPath += ".tmp";

    {
        std::ofstream file(tmpPath);
        file << data.dump(2);
    }

    fs::rename(tmpPath, finalPath);
}
```

Pouziti:

```cpp
void writeLatestReport(const json& report) {
    writeJsonAtomic("./taskQueue/reports/latest.json", report);
}
```

Priklad reportu:

```cpp
json report = {
    {"state", "working"},
    {"taskId", "task_001"},
    {"position", {
        {"x", 10.0},
        {"y", 5.0},
        {"z", -0.2}
    }},
    {"error", 0}
};

writeLatestReport(report);
```

## C++: oznaceni tasku jako hotovy/chybny

```cpp
void finishTask(const fs::path& processingTaskPath, bool ok) {
    fs::path targetDir = ok ? "./taskQueue/processed" : "./taskQueue/failed";
    fs::path targetPath = targetDir / processingTaskPath.filename();

    fs::rename(processingTaskPath, targetPath);
}
```

## C++: kontrola soft stopu

```cpp
bool hasSoftStopRequest() {
    fs::path emergencyDir = "./taskQueue/emergency";

    for (const auto& entry : fs::directory_iterator(emergencyDir)) {
        if (entry.is_regular_file() && entry.path().extension() == ".json") {
            return true;
        }
    }

    return false;
}
```

Jednoducha verze: kdyz C++ najde emergency JSON, prestane pripravovat dalsi `basicCMD`.

## Doporuceny tvar tasku

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

Pro G-code:

```json
{
  "id": "task_002",
  "type": "readGcode",
  "payload": {
    "path": "/home/pi/cnc/gcode/board.nc"
  }
}
```

## Doporuceny tvar reportu

```json
{
  "state": "working",
  "taskId": "task_002",
  "message": "running gcode",
  "position": {
    "x": 10.0,
    "y": 5.0,
    "z": -0.2
  },
  "nano": {
    "status": 0,
    "error": 0
  }
}
```

## Minimalni loop v C++

```cpp
while (true) {
    auto taskPath = findFirstJsonTask("./taskQueue/initialized");

    if (!taskPath.has_value()) {
        // sleep treba 100 ms
        continue;
    }

    fs::path processingPath = moveToProcessing(taskPath.value());
    json task = readJsonFile(processingPath);

    bool ok = doTask(task);

    finishTask(processingPath, ok);
}
```

## Prakticke poznamky

- Backend zapisuje tasky.
- C++ tasky presouva a zpracovava.
- Backend nemaze task v `processing`.
- C++ nemluvi pres HTTP, jen pres soubory a USB serial.
- Report `latest.json` muze C++ prepisovat porad dokola.
- Pro tasky pouzivej unikatni `id`, treba `task_${Date.now()}`.
- Pokud C++ spadne, task zustane v `processing`, coz je dobre pro debug.
