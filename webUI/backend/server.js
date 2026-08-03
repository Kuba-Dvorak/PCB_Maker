const { Interface } = require("readline");
const path = require("path");
const { Socket } = require("dgram");
const fs = require("fs")
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const app = express();
const net = require('net');
const readline = require('readline');
const sqlite3 = require("sqlite3").verbose();
const { spawn } = require("child_process");
const db = new sqlite3.Database("../database/gcodes.db");

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


app.use(cors())
app.use(express.json());
let mainTransmisionSocket;
let emergencyTransition;

async function connectSockets() {
     emergencyTransition = net.createConnection({ port: 5001 }, () => {
        console.log('[JS] Connected to main port 5001');
    });

    emergencyTransition.on('close', () => console.log('[JS] Emergency connection ended.'));

    emergencyTransition.on('error', (err) => {
        console.log("[JS] Emergency socket error:", err.message);
    });

    await sleep(500);

    mainTransmisionSocket = net.createConnection({ port: 5000 }, () => {
        console.log('[JS] Connected to main port 5000');
    });

    mainTransmisionSocket.on('close', () => console.log('[JS] Main connection ended.'));

    mainTransmisionSocket.on('error', (err) => {
        console.log("[JS] Main socket error:", err.message);
    });

    mainReader = readline.createInterface({input: mainTransmisionSocket})
    mainReader.on('line', handleNanoLine)
    mainReader.on('error', (err) => {
        console.log("[JS] Main reader error:", err.message);
    });
}

connectSockets()


let mainReader

// Musi to byt stejny seznam jako gerberExtensions ve frontend/index.js.
// Zamerne tu neni .txt, i kdyz nektere nastroje tak exportuji vrtani -
// pustilo by to dovnitr jakykoliv soubor.
const gerberExtensions = [
    ".gbr", ".ger", ".gbrjob",
    ".gtl", ".gbl",
    ".gts", ".gbs",
    ".gto", ".gbo",
    ".gtp", ".gbp",
    ".gm1", ".gko",
    ".drl", ".xln"
]


function isGerberName(fileName) {
    const lower = fileName.toLowerCase()
    return gerberExtensions.some(extension => lower.endsWith(extension))
}


// Gerbery maji vlastni slozku. C++ demon prohledava jen gcodes/, takze
// se mu sem nesmi dostat nic, co by zkusil poslat do Nana jako G-kod.
const gerberDir = "../gerbers"
fs.mkdirSync(gerberDir, { recursive: true })

// Vygenerovany G-kod a konfigurace stroje pro pcb2gcode.
const gcodeDir = "../gcodes"
const millprojectPath = "../printer/millproject"
fs.mkdirSync(gcodeDir, { recursive: true })

// Pracovni prostor stroje. Musi sedet s MAX_X / MAX_Y v nanoCode/src/main.cpp.
const machineMaxX = 75
const machineMaxY = 95
const machineMaxZ = 15

const gerberStorage = multer.diskStorage({
    destination: gerberDir,
    filename: (req, file, cb) => {
        // basename zahodi pripadne ../ z nazvu, ktery prisel z prohlizece
        cb(null, path.basename(file.originalname))
    }
})


const gerberUpload = multer({
    storage: gerberStorage,
    fileFilter: (req, file, cb) => {
        if (isGerberName(file.originalname)) {
            cb(null, true)
            return
        }

        console.warn(`[JS] Upload rejected, not a Gerber: ${file.originalname}`)
        cb(null, false)
    }
})


let currentReport = {
    status: 2,
    error: 0,
    x: -1,
    y: -1,
    z: -1,
    speed: -1,
    spindlSpeed: -1,
    endstops: -1
}

let printUnderGoing = false
let currentGcodeName = ""


function handleNanoLine(line) {
    if (line.startsWith('$')) {
        const rawText = line.slice(1)
        try {
            const message = JSON.parse(rawText);
            const position = message.position
            console.log('[JS] Recieved report from nano')
            currentReport.status = message.status
            currentReport.error = message.error
            currentReport.x = position.x
            currentReport.y = position.y
            currentReport.z = message.z
            currentReport.speed = message.speed
            currentReport.spindlSpeed = message.spindlSpeed
            // -1 znamena "nevim". Radsi nic, nez ukazovat na FE stary stav koncaku jako aktualni.
            currentReport.endstops = message.endstops ?? -1

        } catch {
            console.log('[JS] Sent message from C++ is not a JSON')
            currentReport.status = 2
            currentReport.error = 33
            currentReport.endstops = -1
        }
        return
    }

    else {
        console.log('[JS] Sent message from C++ did not contain correct starting symbol')
        currentReport.status = 2
        currentReport.error = 34
        currentReport.endstops = -1
        return
    }

}


function sendCMD(cmd) {
    if (!mainTransmisionSocket || mainTransmisionSocket.destroyed) {
        console.log('[JS] Main socket is not connected, command was dropped:', JSON.stringify(cmd))
        return false
    }
    const rawText = JSON.stringify(cmd)
    mainTransmisionSocket.write(`$${rawText}\n`);
    console.log('[JS] Send a message')
    return true
}


function sendEmergency(emegencyNum) {
    if (emegencyNum == 4 || emegencyNum == 5) {
        if (!emergencyTransition || emergencyTransition.destroyed) {
            console.log('[JS] Emergency socket is not connected, emergency was dropped:', emegencyNum)
            return
        }
    }

    if (emegencyNum == 4) {
         emergencyTransition.write(`;`);
         console.log('[JS] Send an emergency')
    }

    else if (emegencyNum == 5) {
         emergencyTransition.write(`#`);
         console.log('[JS] Send an emergency')
    }

    else if (emegencyNum == 6) {
         if (sendCMD({ cmd: 5 })) {
             console.log('[JS] Send an emergency, to continue print')
         }
    }

    else {
         console.log('[JS] Unknown emergency number')
    }
}


function sendMistake(code, returnMessage, res) {
    res.status(code).json({
      message: returnMessage
    })
}


// Obali funkci tak, aby se dala zavolat jen jednou.
// Pri ENOENT prijde ze spawn nejdriv "error" a hned po nem jeste "close"
// s kodem -2, takze by se bez tehle pojistky vyresil promise dvakrat
// a log by tvrdil dve ruzne veci.
function once(callback) {
    let called = false

    return function (...callArgs) {
        if (called) {
            return
        }

        called = true
        callback(...callArgs)
    }
}


function pcb2gcodeArgs(gerberPath, workDir, outputName) {
    return [
        "--config", millprojectPath,
        "--front", gerberPath,
        "--output-dir", workDir,
        "--front-output", outputName
    ]
}


// Ze stdoutu pcb2gcode vytahne rozmery desky a porovna je s pracovnim
// prostorem. Radek vypada takhle:
//   "Exporting front... DONE. (Height: 23.2198mm Width: 49.164mm)"
function checkBoardFits(stdoutText) {
    const sizeMatch = stdoutText.match(/Height:\s*([0-9.]+)mm\s*Width:\s*([0-9.]+)mm/)

    if (!sizeMatch) {
        console.warn("[JS] Board size could not be read from pcb2gcode output, size was NOT checked")
        return { ok: true }
    }

    const boardY = Number(sizeMatch[1])
    const boardX = Number(sizeMatch[2])

    // Vetsi deska by se jen orezala clampem v Nanu a vyrobila by zmetek,
    // takze se to zastavi tady a nic se neposila dal.
    if (boardX > machineMaxX || boardY > machineMaxY) {
        console.error(`[JS] Board ${boardX} x ${boardY} mm does not fit into ${machineMaxX} x ${machineMaxY} mm`)
        return {
            ok: false,
            answer: `Board is ${boardX} x ${boardY} mm, the machine can only do ${machineMaxX} x ${machineMaxY} mm`
        }
    }

    console.log(`[JS] Board is ${boardX} x ${boardY} mm, fits into ${machineMaxX} x ${machineMaxY} mm`)
    return { ok: true }
}


// Pusti pcb2gcode nad jednim gerberem a vrati { ok, answer }.
// Parametry stroje (Z, posuvy, otacky, prumer hrotu) jsou v millprojectu,
// tady se predava jen to, co se lisi job od jobu.
function generateGcode(gerberName) {
    return new Promise((resolve) => {
        const safeName = path.basename(gerberName)
        const gerberPath = path.join(gerberDir, safeName)
        const outputName = `${safeName}.gcode`

        if (!fs.existsSync(gerberPath)) {
            console.error(`[JS] pcb2gcode not started, gerber is missing: ${gerberPath}`)
            resolve({ ok: false, answer: `Gerber "${safeName}" was not found on disk` })
            return
        }

        // pcb2gcode sype do output-dir jeste pet SVG nahledu a jejich jmena
        // jsou pevna (processed_front.svg atd.), takze by se pri druhem behu
        // prepisovaly a zaneradily by gcodes/. Generuje se proto stranou
        // a prenasi se jen vysledny G-kod.
        const workDir = fs.mkdtempSync(path.join(gcodeDir, ".p2g-"))
        const args = pcb2gcodeArgs(gerberPath, workDir, outputName)

        console.log(`[JS] Running: pcb2gcode ${args.join(" ")}`)

        // Argumenty jdou jako pole a shell je vypnuty (vychozi stav spawn).
        // Jmeno souboru prichazi z prohlizece, pres exec by ho vyhodnotil shell.
        const child = spawn("pcb2gcode", args)
        let stdoutText = ""
        let stderrText = ""

        const finish = once((result) => {
            fs.rmSync(workDir, { recursive: true, force: true })
            resolve(result)
        })

        child.stdout.on("data", (chunk) => {
            stdoutText += chunk.toString()
            console.log("[pcb2gcode]", chunk.toString().trimEnd())
        })

        child.stderr.on("data", (chunk) => {
            stderrText += chunk.toString()
            console.warn("[pcb2gcode]", chunk.toString().trimEnd())
        })

        child.on("error", (err) => {
            if (err.code === "ENOENT") {
                console.error("[JS] pcb2gcode is not installed or is not in PATH")
                finish({
                    ok: false,
                    answer: "pcb2gcode is not installed. Arch: yay -S pcb2gcode, Debian/RPi OS: sudo apt install pcb2gcode"
                })
                return
            }

            console.error("[JS] pcb2gcode could not be started:", err.message)
            finish({ ok: false, answer: `pcb2gcode could not be started: ${err.message}` })
        })

        child.on("close", (code) => {
            // 0 = hotovo, 100 = nedokazal precist vstup, 101 = spatny parametr
            if (code !== 0) {
                console.error(`[JS] pcb2gcode failed with exit code ${code}`)
                finish({
                    ok: false,
                    answer: `pcb2gcode failed (exit ${code}): ${(stderrText || stdoutText).trim()}`
                })
                return
            }

            const producedPath = path.join(workDir, outputName)

            if (!fs.existsSync(producedPath)) {
                console.error("[JS] pcb2gcode ended with code 0 but produced no G-code file")
                finish({ ok: false, answer: "pcb2gcode reported success but generated no G-code" })
                return
            }

            const sizeCheck = checkBoardFits(stdoutText)

            if (!sizeCheck.ok) {
                finish(sizeCheck)
                return
            }

            const finalPath = path.join(gcodeDir, outputName)

            try {
                fs.renameSync(producedPath, finalPath)
            } catch (err) {
                console.error("[JS] Generated G-code could not be moved:", err.message)
                finish({ ok: false, answer: `G-code could not be moved: ${err.message}` })
                return
            }

            console.log(`[JS] G-code generated: ${finalPath}`)
            finish({ ok: true, answer: "G-code was generated" })
        })
    })
}


app.post("/currentPrinterInfo", async (req, res) => {
    res.json(currentReport)
})


app.get("/gcodeListUpload", (req, res) => {
    db.all(`SELECT name, date, gsize, printed FROM gcodeList`, [], (err, rows) => {
        if (err) {
            console.error("[JS DB] Error when loading DB:", err);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});


app.post("/uploadGerber", gerberUpload.single("gerber"), async (req, res) => {
    // fileFilter soubor zahodil -> multer nenastavi req.file
    if (!req.file) {
        console.warn("[JS] Gerber upload was rejected by the file filter")
        return res.status(400).json({
            answer: `Rejected: not a Gerber file. Allowed: ${gerberExtensions.join(", ")}`
        })
    }

    console.log(`[JS] Gerber: ${req.file.originalname}, was uploaded`)
    res.json({
        answer: "Gerber upload was succesfull"
    })
})


app.post("/newDBGcodeIns", async (req, res) => {
    const time = req.body.time
    const size = req.body.size
    const name = req.body.name
    db.run(`INSERT INTO gcodeList (name, date, gsize) VALUES (?, ?, ?)`, [name, time, size], function(err) {
        if (err) {
            console.error("[JS DB] Insert of G-code failed:", err);
            return res.status(500).json({
                answer: err.message
            })
        }

        res.json({
            answer: "All good, G-code was uploaded"
        })
    })
})


// DULEZITE print je ted nakonfigurovany na to ze C++ je kompilovane v cmaku, ktery udela pod slozku v slozce nanoComm
//PROTO je ../../gcodes a ne ../gcodes, pokud doslo k zmene, nebo se nekompiluje z podslozky, tak zmenit!!!
function readPrintedFlag(name) {
    return new Promise((resolve) => {
        // db.get, ne db.all - ceka se jeden radek, ne pole
        db.get(`SELECT printed FROM gcodeList WHERE name = ?`, [name], (err, row) => {
            if (err) {
                console.error("[JS DB] Could not read the printed flag, generating a new G-code:", err.message)
                resolve(null)
                return
            }

            resolve(row)
        })
    })
}


app.post("/printGcode", async (req, res) => {
    if (req.body.aprove !== 1) {
        console.log("[JS] Frontend made wrong gcode print request")
        return res.json({
            answer: "Wrong gcode print request json"
        })
    }

    const name = path.basename(req.body.gcodeName ?? "")
    console.log("[JS] Frontend made a gcode print request named: " + name)

    if (name === "") {
        console.warn("[JS] Print request arrived without a job name")
        return res.status(400).json({
            answer: "No job name was sent"
        })
    }

    const row = await readPrintedFlag(name)
    const gcodePath = path.join(gcodeDir, `${name}.gcode`)

    // Priznak z DB sam nestaci - soubor uz mohl nekdo smazat rucne.
    // Kdyz chybi kterakoliv z tech dvou veci, generuje se znovu.
    const alreadyGenerated = Number(row?.printed) > 0 && fs.existsSync(gcodePath)

    if (!alreadyGenerated) {
        const result = await generateGcode(name)

        if (!result.ok) {
            console.error(`[JS] Print aborted, G-code was not generated: ${result.answer}`)
            return res.status(500).json({
                answer: result.answer
            })
        }

        db.run(`UPDATE gcodeList SET printed = ? WHERE name = ?`, [`${Number(row?.printed) + 1}`, name], (err) => {
            if (err) {
                console.error("[JS DB] Could not store the printed flag:", err.message)
            }
        })
    }

    else {
        console.log(`[JS] G-code already generated, reusing: ${gcodePath}`)
    }

    // Az tady, kdyz soubor opravdu existuje. Driv se cmd 3 poslalo hned
    // a Nano dostalo cestu k souboru, ktery jeste nevznikl.
    sendCMD({
        cmd: 3,
        path: `../../gcodes/${name}.gcode`
    })

    res.json({
        answer: "Print comming ahead"
    })
})


app.post("/deleteGcode", async (req, res) => {
    if (req.body.aprove === 1) {
        const name = req.body.name
        db.run(`DELETE FROM gcodeList WHERE name = ?`, [name], function(err) {
            if (err) {
                console.error("[JS DB] Delete of G-code failed:", err);
                return;
            }
        })
        // Upload jde do gerbers/, takze se maze odtud.
        // TODO az bude pcb2gcode: smazat i vygenerovany gcodes/<name>.gcode
        fs.unlink(`${gerberDir}/${path.basename(name)}`, (err) => {
        if (err) {
            console.error("[JS] Gerber file could not be deleted:", err.message)
            return
        }

        console.log("[JS] gerber file deleted")
    })
        res.json({
            answer: `Succesufully deleted gcode named: ${name}`
        })
    }
    else {
        console.log("[JS] Frontend made wrong gcode delete request")
        res.json({
            answer: "Wrong gcode print request json"
        })
    }
})


app.post("/operate", async (req, res) => {
    if (req.body.corect === true) {
        if (req.body.cmd === "x") {
            sendCMD({
                cmd: 1,
                x: req.body.size,
                y: -1,
                z: -1,
                speed: req.body.speed,
                spindleSpeed: req.body.spindleSpeed
            })
        }
        else if (req.body.cmd === "y") {
            sendCMD({
                cmd: 1,
                x: -1,
                y: req.body.size,
                z: -1,
                speed: req.body.speed,
                spindleSpeed: req.body.spindleSpeed
            })
        }
        else if (req.body.cmd === "z") {
            sendCMD({
                cmd: 1,
                x: -1,
                y: -1,
                z: req.body.size,
                speed: req.body.speed,
                spindleSpeed: req.body.spindleSpeed
            })
        }

        else {
            console.log("[JS] Unknown operate command:", req.body.cmd)
            return res.json({
                answer: "Unknown operate command"
            })
        }

        res.json({
            answer: "Movement sent"
        })
    }

    else {
        res.json({
            answer: "Wrong code"
        })
    }
})


app.post("/home", async (req, res) => {
    if (req.body.cmd === "min") {
        sendCMD({
            cmd: 2
        })
        res.json({
            answer: "Homing to min sent"
        })
    }

    else if (req.body.cmd === "max") {
        sendCMD({
            cmd: 4
        })
        res.json({
            answer: "Homing to max sent"
        })
    }

    else {
        console.log("[JS] Unknown homing direction:", req.body.cmd)
        res.json({
            answer: "Unknown homing direction"
        })
    }
})


app.post("/emergency", async (req, res) => {
    if (req.body.cmd === "Pause") {
        sendEmergency(4)
        res.json({
            answer: "Pause sent"
        })
    }

    else if (req.body.cmd === "Stop") {
        sendEmergency(5)
        res.json({
            answer: "Stop sent"
        })
    }
    
    else if (req.body.cmd === "Continue") {
        sendEmergency(6)
        res.json({
            answer: "Continue sent"
        })
    }

    else {
        console.log("[JS] Unknown command")
        res.json({
            answer: "Unknown command"
        })
    }
})




app.listen(3300, () => {
  console.log("Backend bezi na http://localhost:3300");
});
