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
const os = require("os");
const util = require("util");

// Vsechny cesty se odvozuji od umisteni tohohle souboru, ne od pracovniho
// adresare. Pri rucnim spusteni z webUI/backend to vyjde stejne jako driv,
// ale pod systemd na RPi je cwd typicky "/", takze relativni "../gerbers"
// by ukazovalo mimo projekt a upload i pcb2gcode by spadly.
const webUIDir = path.join(__dirname, "..")

// Logy. Stejna slozka i stejny format jako u nanoCommu, at se daji cist
// vedle sebe - jeden job je vzdycky videt v obou. Musi to byt uplne nahore,
// jeste pred connectSockets(), jinak by prvni vypisy do souboru nedosly.
const logDir = process.env.CNC_LOG_DIR || path.join(webUIDir, "logs")
// Env je hlavne kvuli testovani, psat 15000 radku jen kvuli overeni rotace
// nema smysl.
const logLineLimit = Number(process.env.CNC_LOG_MAX_LINES) > 0
    ? Number(process.env.CNC_LOG_MAX_LINES)
    : 15000

let logStream = null
let logLines = 0


function twoDigits(value) {
    return String(value).padStart(2, "0")
}


function logTimeStamp() {
    const now = new Date()
    return `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`
}


function openLogFile() {
    if (logStream) {
        logStream.end(`--- limit ${logLineLimit} lines reached, continuing in a new file ---\n`)
    }

    const now = new Date()
    const stamp = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
        + `_${twoDigits(now.getHours())}-${twoDigits(now.getMinutes())}-${twoDigits(now.getSeconds())}`

    let target = path.join(logDir, `backendLog-${stamp}.txt`)

    // Dve rotace ve stejne sekunde jsou nepravdepodobne, ale prepsat
    // predchozi log by bylo horsi nez oskliva pripona.
    for (let attempt = 2; fs.existsSync(target) && attempt < 1000; attempt++) {
        target = path.join(logDir, `backendLog-${stamp}-${attempt}.txt`)
    }

    logStream = fs.createWriteStream(target, { flags: "a" })
    logLines = 0

    // Nesmi to logovat pres console, to by se zacyklilo.
    logStream.on("error", (err) => {
        logStream = null
        process.stderr.write(`[JS] File logging stopped: ${err.message}\n`)
    })

    return target
}


// Prepise console.* tak, aby psaly i do souboru. Menit se tim padem nemusi
// ani jeden z existujicich vypisu.
function startFileLogging() {
    fs.mkdirSync(logDir, { recursive: true })
    const activePath = openLogFile()

    for (const level of ["log", "info", "warn", "error"]) {
        const original = console[level].bind(console)

        console[level] = (...args) => {
            original(...args)
            writeLogLine(level, args)
        }
    }

    console.log(`[JS] Console output is mirrored to ${activePath}`)
}


function writeLogLine(level, args) {
    if (!logStream) {
        return
    }

    const text = args
        .map(part => typeof part === "string" ? part : util.inspect(part, { depth: 3 }))
        .join(" ")

    const tag = level === "log" || level === "info" ? "" : `${level.toUpperCase()} `

    for (const line of text.split("\n")) {
        logStream.write(`[${logTimeStamp()}] ${tag}${line}\n`)
        logLines++
    }

    if (logLines >= logLineLimit) {
        openLogFile()
    }
}


startFileLogging()


const db = new sqlite3.Database(path.join(webUIDir, "database", "gcodes.db"));

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


app.use(cors())
app.use(express.json());

// Frontend jede ze stejneho portu jako API, takze prohlizec dostane stranku
// i data ze stejneho originu. Diky tomu staci ve fetch relativni cesty
// ("/home" misto "http://localhost:3300/home") a nikde v kodu nemusi byt
// natvrdo IP Raspberry Pi. Static jde pred routy zamerne - nazvy souboru
// (index.html, index.css, index.js) se s nazvy endpointu nekryji.
app.use(express.static(path.join(webUIDir, "frontend")))
let mainTransmisionSocket;
let emergencyTransition;

// Node od verze 18 zkousi u localhost soucasne ::1 i 127.0.0.1 a kdyz selzou
// obe, vrati AggregateError, ktery ma err.message PRAZDNY. Log by pak vypsal
// jen "socket error:" a nic dal, coz je presne ta situace, kdy clovek u RPi
// potrebuje vedet nejvic. Tohle z nej vytahne kod chyby a rovnou napovi, ze
// nejcastejsi pricina je nespusteny nanoComm.
function describeSocketError(err) {
    const code = err.code || (err.errors && err.errors[0] && err.errors[0].code) || "unknown"
    const text = err.message || `${err.name || "Error"} (${code})`

    if (code === "ECONNREFUSED") {
        return `${text} - nothing is listening, the nanoComm daemon is probably not running`
    }

    return text
}


async function connectSockets() {
    // Host je tu schvalne. Bez nej Node vezme "localhost", ktery se od verze
    // 18 resolvuje na ::1 i 127.0.0.1 a Node otevre OBE spojeni soucasne -
    // to pomalejsi pak zavre. nanoComm posloucha jen na IPv4, takze prvni
    // accept chytil to zahazovane spojeni, hned videl EOF a prisel o kanal.
     emergencyTransition = net.createConnection({ host: "127.0.0.1", port: 5001 }, () => {
        console.log('[JS] Connected to main port 5001');
    });

    emergencyTransition.on('close', () => console.log('[JS] Emergency connection ended.'));

    emergencyTransition.on('error', (err) => {
        console.log("[JS] Emergency socket error on port 5001:", describeSocketError(err));
    });

    await sleep(500);

    mainTransmisionSocket = net.createConnection({ host: "127.0.0.1", port: 5000 }, () => {
        console.log('[JS] Connected to main port 5000');
    });

    mainTransmisionSocket.on('close', () => console.log('[JS] Main connection ended.'));

    mainTransmisionSocket.on('error', (err) => {
        console.log("[JS] Main socket error on port 5000:", describeSocketError(err));
    });

    mainReader = readline.createInterface({input: mainTransmisionSocket})
    mainReader.on('line', handleNanoLine)
    mainReader.on('error', (err) => {
        console.log("[JS] Main reader error:", describeSocketError(err));
    });
}

connectSockets()


let mainReader
const jobArray = []
const adminCode = "5369" 
const currentAdmins = []
const currentBannedUsers = []

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
const gerberDir = path.join(webUIDir, "gerbers")
fs.mkdirSync(gerberDir, { recursive: true })

// Vygenerovany G-kod a konfigurace stroje pro pcb2gcode.
const gcodeDir = path.join(webUIDir, "gcodes")
const millprojectPath = path.join(webUIDir, "printer", "millproject")
fs.mkdirSync(gcodeDir, { recursive: true })


// Vzdalenost mezi koncaky. Musi sedet s MAX_X / MAX_Y / MAX_Z
// v nanoCode/src/main.cpp.
const machineMaxX = 60
const machineMaxY = 80
const machineMaxZ = 15

// Odsazeni od dorazu, musi sedet s MINIMAL_DISTANCE_MM_X / _Y v nanoCode
// a s x-offset / y-offset v printer/millproject. Levy dolni roh desky
// lezi tady, protoze na (0,0) sedi koncaky Xmin a Ymin.
const originOffsetX = 3
const originOffsetY = 2

// Pouzitelna plocha, ne vzdalenost mezi koncaky: odsazeni se odecita
// na obou stranach, protoze i na druhem konci je doraz.
const usableX = machineMaxX - 2 * originOffsetX
const usableY = machineMaxY - 2 * originOffsetY

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
    endstops: -1,
    // Postup v souboru. -1 = job nebezi, plni to nanoComm v doGcodeTask.
    gcodeLine: -1,
    gcodeLines: -1,
    // Odvozene tady, ne v Nanu: ten o zadnem "jobu" nevi.
    jobRunning: false,
    jobPaused: false,
    jobName: ""
}

let printUnderGoing = false
let jobPaused = false
let currentGcodeName = ""


// Pauza je zamerne oddelena od "job bezi". Job zustava rozdelany a continue
// se k nemu vrati, ale stroj mezitim stoji, takze se smi jogovat - treba na
// vymenu hrotu. Pozice pro navrat si drzi nanoComm ve svem remeberedReport,
// takze ji rucni pojezd nerozbije.
function setJobPaused(paused) {
    if (jobPaused === paused) {
        return
    }

    jobPaused = paused
    currentReport.jobPaused = jobPaused

    if (paused) {
        console.log("[JS] Job paused, jogging is unlocked")
    }

    // Pri konci jobu se pauza taky rusi, ale tam uz se nic nezamyka a hlasku
    // o konci vypise setJobRunning. Bez tehle podminky by log tvrdil
    // "locked again" presne ve chvili, kdy se jog naopak odemyka.
    else if (printUnderGoing) {
        console.log("[JS] Job resumed, jogging is locked again")
    }
}


// Jedno misto, kde se meni stav jobu, aby se to nerozjelo mezi endpointy.
// Nano nema pojem "job", takze to musi drzet backend: zapina se odeslanim
// tisku, vypina koncem programu (error 8) nebo tvrdym stopem z frontendu.
function setJobRunning(running, name = "") {
    if (printUnderGoing === running && currentGcodeName === name) {
        return
    }

    printUnderGoing = running
    currentGcodeName = running ? name : ""
    currentReport.jobRunning = printUnderGoing
    currentReport.jobName = currentGcodeName

    if (!running) {
        setJobPaused(false)
        currentReport.gcodeLine = -1
        currentReport.gcodeLines = -1
    }

    console.log(running
        ? `[JS] Job started: ${currentGcodeName}`
        : "[JS] Job is no longer running, jogging is unlocked")
}


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

            // Reporty z jogu maji obe pole -1, prepsat by se tim smazal
            // posledni znamy postup jobu. Bere se jen to, co ma smysl.
            if (Number.isInteger(message.gcodeLine) && message.gcodeLine >= 0) {
                currentReport.gcodeLine = message.gcodeLine
                currentReport.gcodeLines = message.gcodeLines ?? -1
            }

            // Error 8 posila Nano na M2, tedy na konci programu.
            if (message.error === 8) {
                setJobRunning(false)
            }

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
    // takze se to zastavi tady a nic se neposila dal. Porovnava se proti
    // pouzitelne plose, ne proti vzdalenosti mezi koncaky - deska zacina
    // az na offsetu a stejny kus musi zbyt i na druhe strane.
    if (boardX > usableX || boardY > usableY) {
        console.error(`[JS] Board ${boardX} x ${boardY} mm does not fit into the usable ${usableX} x ${usableY} mm`)
        console.error(`[JS] Usable area is ${machineMaxX} x ${machineMaxY} mm between the endstops, minus ${originOffsetX} mm in X and ${originOffsetY} mm in Y on each side`)
        return {
            ok: false,
            answer: `Board is ${boardX} x ${boardY} mm, the machine can only do ${usableX} x ${usableY} mm`
        }
    }

    console.log(`[JS] Board is ${boardX} x ${boardY} mm, fits into the usable ${usableX} x ${usableY} mm`)
    console.log(`[JS] Board origin sits at (${originOffsetX}, ${originOffsetY}) mm, place the bottom left corner there`)
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


// Cesta ke G-kodu se nanoCommu posila ABSOLUTNE. Driv to byla relativni
// "../../gcodes/...", ktera se rozbalovala proti pracovnimu adresari nanoCommu,
// ne proti umisteni souboru - fungovala jen pri spusteni z podslozky, kterou
// udela cmake. Rozbila se pokazde, kdyz se demon pustil odjinud: ze scriptu,
// z jineho build adresare, nebo pod systemd, ktery dava services cwd "/".
// gcodePath je uz spocitany vys pres path.join(gcodeDir, ...), takze staci
// poslat jeho.
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


function checkUserPermission(owner, name) {
    for (let i = 0; i < jobArray.length; i++) {
        if (jobArray[i].name === name && jobArray[i].owner === owner) {
            return true
        }
    }

    return false
}


function checkUserBanned(user) {
    for (let i = 0; i < currentBannedUsers.length; i++) {
        if (currentBannedUsers[i] === owner) {
            return true
        }
    }
    return false
}



function checkUserAdmin(owner) {
    for (let i = 0; i < currentAdmins.length; i++) {
        if (currentAdmins[i] === owner) {
            return true
        }
    }
    return false
}


function jobArrayChangeOrder(index, newIndex) {

}


app.post("/printGcode", async (req, res) => {
    if (req.body.aprove !== 1) {
        console.log("[JS] Frontend made wrong gcode print request")
        return res.json({
            answer: "Wrong gcode print request json"
        })
    }

    // Zamek jogovani je jen ve frontendu, tenhle endpoint se da zavolat
    // i primo. Druhy job poslany doprostred prvniho by nanoComm rozjel
    // soubezne s bezicim gcodeSender - to zastavit tady.
    if (printUnderGoing) {
        console.warn(`[JS] Print request refused, "${currentGcodeName}" is still running`)
        return res.status(409).json({
            answer: `Job "${currentGcodeName}" is still running. Stop it before starting another one.`
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

    res.json({
        answer: "Print addded to the queue"
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



app.post("/currentJobs", async (req, res) => {
    if (req.body.reason === "load") {
        const index = req.body.index
        if (index < 0 || index >= jobArray.length) {
            res.json({
                nextOne: false
            })
        }

        else {
            let youAreOwner = false
            if (req.body.user === jobArray[index].owner) {
                youAreOwner = true
            }

            res.json({
                nextOne: true,
                name: jobArray[index].name,
                you: youAreOwner
            })
        }
    }

    else if (req.body.reason === "operate") {
        if (!checkUserBanned(req.body.user)) {
            if (req.body.cmd === "SpecialOp" && checkUserAdmin(req.body.user)) {
            if (req.body.spcmd === "rearange") {
                jobArrayChangeOrder(req.body.index, req.body.newIndex)
                if (req.body.newIndex === 0) {
                    sendEmergency(4)
                    setJobPaused(true)
                }
            }
            
            else if (req.body.spcmd === "banUser") {
                if (!checkUserAdmin(req.body.reqUser)) {
                    currentBannedUsers.push(req.body.reqUser)
                }
            }
        }

        const name = req.body.jobName
        if (name === jobArray[0].name) {
            if (req.body.cmd === "Start") {
                const gcodePath = path.join(gcodeDir, `${name}.gcode`)
                sendCMD({
                    cmd: 3,
                    path: gcodePath
                })

                setJobRunning(true, name)
                res.json({
                    answer: `Print ${name} started`
                })
                return
            }

            if (checkUserPermission(req.body.user, req.body.jobName) || checkUserAdmin(req.body.user)) {
                if (req.body.cmd === "Pause") {
                    sendEmergency(4)
                    setJobPaused(true)
                    res.json({
                        answer: "Pause sent"
                    })
                }

                else if (req.body.cmd === "Stop") {
                    sendEmergency(5)
                    // Tvrdy stop job zahazuje, continue uz ho nevzkrisi - odemknout jog.
                    // Pause naopak nechava job bezet, tam se stav nemeni.
                    setJobRunning(false)
                    res.json({
                        answer: "Stop sent"
                    })
                    jobArray.shift()
                }
                
                else if (req.body.cmd === "Continue") {
                    sendEmergency(6)
                    setJobPaused(false)
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
            }
            
            else {
                res.json({
                        answer: "Permission denied for this job, you are not the owner of this job"
                })
            }
        }

        else {
            res.json({
                answer: "You can only operate the first job in the queue"
            })
        }
        }
    }
})



app.post("/siteAdminAttepmt", async (req, res) => {
    if (req.body.code === adminCode) {
        currentAdmins.push(req.body.myName)
        res.json({
            permission: true
        })
    }
    
    else {
        res.json({
            permission: false
        })
    }
})




// 3300 se nekryje s nicim z MainsailOS na stejnem RPi: nginx drzi 80 (a 81
// pro kameru), Moonraker 7125. Kdyby se to nekdy trefilo, meni se to tady.
const httpPort = 3300

// "0.0.0.0" znamena vsechna sitova rozhrani, ne jen loopback. Bez toho by
// backend odpovidal jen na samotnem RPi a z notebooku v siti by byl mrtvy.
const httpHost = "0.0.0.0"


// Vypise adresy, na kterych stranka opravdu je. Pri deploymentu je to jedina
// informace, kterou clovek u RPi potrebuje - a usetri to hledani IP jinde.
function localAddresses() {
    const found = []

    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === "IPv4" && !address.internal) {
                found.push(`${address.address} (${name})`)
            }
        }
    }

    return found
}


app.listen(httpPort, httpHost, () => {
    console.log(`[JS] Backend and frontend are listening on ${httpHost}:${httpPort}`)
    console.log(`[JS] On the Pi itself: http://localhost:${httpPort}`)

    const addresses = localAddresses()

    if (addresses.length === 0) {
        console.warn("[JS] No external IPv4 address found, the machine may be offline. Only localhost will work.")
    }

    for (const address of addresses) {
        console.log(`[JS] From the local network: http://${address.split(" ")[0]}:${httpPort}`)
    }
});
