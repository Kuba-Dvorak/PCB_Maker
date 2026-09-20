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
const { WebSocketServer } = require('ws');
const http = require("http");

// Express sam o sobe zadny server neni, app.listen si ho uvnitr teprve vyrobi
// a nikomu ho neda. WebSocketServer ale potrebuje ten samy server, aby jel na
// stejnem portu jako stranka - proto se vyrobi tady a listen je uplne dole
// na nem, ne na app.
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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


// Sloupec s delkou posledniho tisku pribyl az pozdeji a tabulka se nikde
// v kodu nezaklada, takze se dopln tady - na kazde kopii databaze zvlast.
db.all(`PRAGMA table_info(gcodeList)`, [], (err, columns) => {
    if (err) {
        console.error("[JS DB] Job list table could not be read:", err.message)
        return
    }

    if (columns.some(column => column.name === "duration")) {
        return
    }

    db.run(`ALTER TABLE gcodeList ADD COLUMN duration INTEGER`, (alterErr) => {
        if (alterErr) {
            console.error("[JS DB] Duration column could not be added:", alterErr.message)
            return
        }

        console.log("[JS DB] Duration column was added to the job list")
    })
})

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


// Hotovy G-kod se da nahrat i primo, bez gerberu a bez pcb2gcode - treba
// kdyz si ho nekdo vygeneroval jinde.
const gcodeExtensions = [
    ".gcode",
    ".gco",
    ".ngc",
    ".nc",
    ".tap"
]


function isGcodeName(fileName) {
    return gcodeExtensions.includes(path.extname(fileName).toLowerCase())
}


const gcodeStorage = multer.diskStorage({
    // Absolutni cesta, ne "../gcodes". Ta se rozbaluje proti pracovnimu
    // adresari procesu, takze by soubory koncily jinde podle toho, odkud
    // se backend pustil - pod systemd treba v "/".
    destination: gcodeDir,
    filename: (req, file, cb) => {
        // basename zahodi pripadne ../ z nazvu, ktery prisel z prohlizece
        cb(null, path.basename(file.originalname))
    }
})


const gcodeUpload = multer({
    storage: gcodeStorage,
    fileFilter: (req, file, cb) => {
        if (isGcodeName(file.originalname)) {
            cb(null, true)
            return
        }

        console.warn(`[JS] Upload rejected, not a G-code: ${file.originalname}`)
        cb(null, false)
    }
})


// Stav jobu drzi backend, Nano o zadnem "jobu" nevi. Jog se podle toho
// zamyka, takze to musi byt na jednom miste a ne rozhozene po handlerech.
let printUnderGoing = false
let jobPaused = false
let currentGcodeName = ""

// Kdy job zacal. Az na konci se z toho spocita, jak dlouho trval - driv to
// nikdo nevi, protoze delka zavisi na tom, co je v souboru.
let jobStartedAt = 0


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


// Vraci, jestli se to opravdu odeslalo. Bez toho by frontend dostal potvrzeni
// pauzy i ve chvili, kdy emergency socket vubec nestoji a znak nikam nesel.
function sendEmergency(emegencyNum) {
    if (emegencyNum == 4 || emegencyNum == 5) {
        if (!emergencyTransition || emergencyTransition.destroyed) {
            console.log('[JS] Emergency socket is not connected, emergency was dropped:', emegencyNum)
            return false
        }
    }

    if (emegencyNum == 4) {
         emergencyTransition.write(`;`);
         console.log('[JS] Send an emergency')
         return true
    }

    else if (emegencyNum == 5) {
         emergencyTransition.write(`#`);
         console.log('[JS] Send an emergency')
         return true
    }

    else if (emegencyNum == 6) {
         if (sendCMD({ cmd: 5 })) {
             console.log('[JS] Send an emergency, to continue print')
             return true
         }

         return false
    }

    console.log('[JS] Unknown emergency number')
    return false
}



// --- prikazy od frontendu -----------------------------------------------
// Cisla z frontendu (documentation/FE-BE-protocol.txt) NEJSOU stejna jako
// cisla tasku pro nanoComm (commProtocol.txt). Preklad mezi nimi je jedina
// prace, kterou tady backend dela - proto ma kazdy prikaz svoji funkci.

// Smer jogu na znamenka os: subCmd 1-3 je plus, 4-6 minus.
const jogDirections = {
    1: { x: 1, y: 0, z: 0 },
    2: { x: 0, y: 1, z: 0 },
    3: { x: 0, y: 0, z: 1 },
    4: { x: -1, y: 0, z: 0 },
    5: { x: 0, y: -1, z: 0 },
    6: { x: 0, y: 0, z: -1 }
}

const machineSettings = { safeZ: null, workZ: null }


// Kdyz se ke stroji vubec nic neposlalo, nema kdo poslat report - a frontend
// by cekal na neco, co nikdy neprijde. Status 2 znamena "hlasi backend".
function backendReport(errorNum) {
    sendMessageFe({
        cmdBE: 2,
        nanoReport: {
            status: 2,
            error: errorNum,
            position: { x: -1, y: -1 },
            z: -1,
            speed: -1,
            spindlSpeed: -1,
            endstops: -1
        }
    })
}


// Potvrzeni, ze prikaz odesel. subCMD je cislo prikazu pro NANO, ne to
// z frontendu - podle nej si frontend vypise, co se povedlo.
function confirmToFe(nanoCmd) {
    sendMessageFe({ cmdBE: 4, subCMD: nanoCmd })
}


// Behem pauzy je jog naopak povoleny, prave kvuli vymene hrotu. Pozici
// k navratu si drzi nanoComm, takze ji rucni pojezd nerozbije.
function machineIsBusy() {
    return printUnderGoing && !jobPaused
}


function jogFromFrontend(message) {
    const direction = jogDirections[message.subCmd]

    if (!direction) {
        console.warn(`[JS] Jog with unknown subCmd ${message.subCmd} was dropped`)
        backendReport(2)
        return
    }

    const step = Number(message.value3)
    const speed = Number(message.value)
    const spindleSpeed = Number(message.value2)

    if (!Number.isFinite(step) || !Number.isFinite(speed) || !Number.isFinite(spindleSpeed)) {
        console.warn("[JS] Jog without usable numbers was dropped:", JSON.stringify(message))
        backendReport(2)
        return
    }

    if (machineIsBusy()) {
        console.warn("[JS] Jog refused, a job is running")
        backendReport(3)
        return
    }

    // Task 1 pro nanoComm je relativni posun, ten si ho prelozi na cmd 8
    // pro Nano. Osy, kterymi se nehybe, jdou jako nula.
    const sent = sendCMD({
        cmd: 1,
        x: direction.x * step,
        y: direction.y * step,
        z: direction.z * step,
        speed: speed,
        spindleSpeed: spindleSpeed
    })

    if (!sent) {
        backendReport(5)
        return
    }

    confirmToFe(8)
}


function homeFromFrontend(message) {
    if (machineIsBusy()) {
        console.warn("[JS] Homing refused, a job is running")
        backendReport(3)
        return
    }

    // subCmd 1 = na minimum, cokoliv jineho na maximum. Frontend ma zatim jen
    // tlacitko HomeMax, takze maximum je vychozi.
    const toMinimum = message.subCmd === 1

    if (!sendCMD({ cmd: toMinimum ? 2 : 4 })) {
        backendReport(5)
        return
    }

    confirmToFe(toMinimum ? 3 : 4)
}


function jobFromFrontend(message) {
    if (!printUnderGoing) {
        console.warn(`[JS] Job command ${message.subCmd} arrived, but no job is running`)
    }

    // Stop. Emergency 5 je znak # a nanoComm ho bere jako konec - job se uz
    // nevraci, na rozdil od pauzy.
    if (message.subCmd === 1) {
        if (!sendEmergency(5)) {
            backendReport(5)
            return
        }

        setJobRunning(false)
        confirmToFe(7)
        return
    }

    // Pauza. Emergency 4 je znak ; a nanoComm si pri nem zapamatuje pozici
    // a odjede homingem na maximum, aby hrot nezustal v desce.
    if (message.subCmd === 2) {
        if (!sendEmergency(4)) {
            backendReport(5)
            return
        }

        setJobPaused(true)
        confirmToFe(4)
        return
    }

    if (message.subCmd === 3) {
        if (!sendEmergency(6)) {
            backendReport(5)
            return
        }

        setJobPaused(false)
        confirmToFe(5)
        return
    }

    console.warn(`[JS] Job command with unknown subCmd ${message.subCmd} was dropped`)
    backendReport(2)
}


function settingsFromFrontend(message) {
    const value = Number(message.value)

    if (!Number.isFinite(value)) {
        console.warn("[JS] Setting without a usable number was dropped:", JSON.stringify(message))
        backendReport(2)
        return
    }

    if (message.subCmd === 1) {
        machineSettings.safeZ = value
    }

    else if (message.subCmd === 2) {
        machineSettings.workZ = value
    }

    else {
        console.warn(`[JS] Setting with unknown subCmd ${message.subCmd} was dropped`)
        backendReport(2)
        return
    }

    // POZOR: nanoComm zatim nema task, kterym by se nastaveni dalo predat -
    // resumeSafeZ i gcodeCutZ jsou v nem napevno. Nez takovy task vznikne,
    // zustava hodnota jen tady a na stroj nema zadny vliv.
    console.log(`[JS] Setting stored: safeZ ${machineSettings.safeZ}, workZ ${machineSettings.workZ}`)
    console.warn("[JS] Settings are not sent anywhere yet, nanoComm has no task for them")
}


async function startPrint(gerberName) {
    if (printUnderGoing) {
        console.warn(`[JS] Print of ${gerberName} refused, a job is already running`)
        backendReport(3)
        return
    }

    // Job je bud gerber, ke kteremu se G-kod teprve vyrobi, nebo rovnou
    // nahrany G-kod. U toho druheho uz soubor lezi v gcodes/ pod svym
    // vlastnim jmenem a generovat neni z ceho.
    const uploaded = path.join(gcodeDir, gerberName)
    const direct = isGcodeName(gerberName) && fs.existsSync(uploaded)
    const gcodePath = direct ? uploaded : path.join(gcodeDir, `${gerberName}.gcode`)

    // Rozhoduje soubor na disku, ne priznak v databazi. Prepocitat G-kod
    // znovu je levnejsi nez poslat stroji cestu k necemu, co tam neni.
    if (!fs.existsSync(gcodePath)) {
        console.log(`[JS] No G-code for ${gerberName} yet, generating it`)
        const result = await generateGcode(gerberName)

        if (!result.ok) {
            console.error(`[JS] G-code for ${gerberName} was not generated: ${result.answer}`)
            backendReport(4)
            return
        }
    }

    // Cesta jde absolutni. nanoComm ji rozbaluje proti svemu pracovnimu
    // adresari, a ten muze byt kdekoliv - pod systemd treba "/".
    if (!sendCMD({ cmd: 3, path: gcodePath })) {
        backendReport(5)
        return
    }

    setJobRunning(true, gerberName)
}


function deletePrint(name) {
    if (printUnderGoing && currentGcodeName === name) {
        console.warn(`[JS] ${name} cannot be deleted, it is being milled right now`)
        backendReport(3)
        return
    }

    for (const filePath of [path.join(gerberDir, name), path.join(gcodeDir, name), path.join(gcodeDir, `${name}.gcode`)]) {
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { force: true })
            console.log(`[JS] Deleted ${filePath}`)
        }
    }

    db.run(`DELETE FROM gcodeList WHERE name = ?`, [name], (err) => {
        if (err) {
            console.error("[JS DB] Row could not be deleted:", err.message)
        }
    })
}


async function printFromFrontend(message) {
    // basename kvuli tomu, ze jmeno prichazi z prohlizece: bez nej by
    // "../../etc/neco" ukazalo mimo gerbers/ a gcodes/.
    const name = path.basename(String(message.value ?? ""))

    if (!name || name === "." || name === "..") {
        console.warn("[JS] Print command without a usable name was dropped")
        backendReport(2)
        return
    }

    if (message.subCmd === 1) {
        await startPrint(name)
        return
    }

    if (message.subCmd === 2) {
        deletePrint(name)
        return
    }

    console.warn(`[JS] Print command with unknown subCmd ${message.subCmd} was dropped`)
    backendReport(2)
}


async function resolveMessage(messageData) {
    let message

    // ws predava data jako Buffer, ne jako retezec. JSON.parse si s nim
    // poradi, porovnavat ho s retezcem by ale neslo.
    try {
        message = JSON.parse(messageData)
    }

    catch {
        console.warn("[JS] Frontend sent something that is not JSON, it was dropped")
        backendReport(1)
        return
    }

    try {
        if (message.cmd === 1) {
            jogFromFrontend(message)
            return
        }

        if (message.cmd === 2) {
            homeFromFrontend(message)
            return
        }

        if (message.cmd === 3) {
            jobFromFrontend(message)
            return
        }

        if (message.cmd === 4) {
            settingsFromFrontend(message)
            return
        }

        if (message.cmd === 5) {
            await printFromFrontend(message)
            return
        }

        console.warn(`[JS] Frontend sent unknown cmd ${message.cmd}, it was dropped`)
        backendReport(2)
    }

    // Bez tohohle by chyba uvnitr shodila cely handler zpravy a spojeni by
    // dal jen tise nic nedelalo.
    catch (err) {
        console.error("[JS] Frontend command failed:", err.message)
        backendReport(2)
    }
}


// message ani close nejsou udalosti serveru, ale jednotliveho spojeni -
// na wss se da chytit jen 'connection'. Predava se funkce, ne jeji vysledek:
// resolveMessage(data) by se zavolalo hned a navic s necim, co tady neexistuje.
// Job dobehl do konce souboru. Jmeno i zacatek se berou z toho, co si
// backend pamatuje od startu tisku - v reportu nic z toho neni.
function finishJob() {
    const name = currentGcodeName
    const startedAt = jobStartedAt

    setJobRunning(false)

    if (!name || !startedAt) {
        console.warn("[JS] A job finished, but the backend did not know which one, no duration was saved")
        return
    }

    const duration = Math.round((Date.now() - startedAt) / 1000)

    db.run(`UPDATE gcodeList SET duration = ? WHERE name = ?`, [duration, name], (err) => {
        if (err) {
            console.error("[JS DB] Duration could not be saved:", err.message)
            return
        }

        console.log(`[JS] Job ${name} took ${duration} s`)
        sendJobRow(name)
    })
}


// Posle jeden radek seznamu na frontend. Ten si podle jmena prepise ten svuj,
// takze se tim da doplnit cas, aniz by se posilal cely seznam znovu.
function sendJobRow(name) {
    db.get(`SELECT name, date, gsize, duration FROM gcodeList WHERE name = ?`, [name], (err, row) => {
        if (err || !row) {
            console.error("[JS DB] Job row could not be read:", err ? err.message : "no such row")
            return
        }

        sendMessageFe({
            cmdBE: 1,
            job: { name: row.name, date: row.date, size: row.gsize, duration: row.duration }
        })
    })
}


// Cely seznam jobu z databaze, nejnovejsi nahore.
function readJobList() {
    return new Promise((resolve) => {
        db.all(`SELECT name, date, gsize, duration FROM gcodeList ORDER BY date DESC`, [], (err, rows) => {
            if (err) {
                console.error("[JS DB] Job list could not be read:", err.message)
                resolve([])
                return
            }

            resolve(rows || [])
        })
    })
}


wss.on('connection', async client => {
    console.log('[JS] Frontend connected')

    // Seznam dostane jen ten, kdo se prave pripojil. Ostatni uz ho maji a
    // broadcastem by si ho zdvojili.
    for (const row of await readJobList()) {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                cmdBE: 1,
                job: { name: row.name, date: row.date, size: row.gsize, duration: row.duration }
            }))
        }
    }

    client.on('message', data => resolveMessage(data))

    client.on('close', () => {
        console.log('[JS] Frontend disconnected')
    })
})


function sendMessageFe(message) {
    wss.clients.forEach(client => {
        if (client.readyState == 1) {
            client.send(JSON.stringify(message))
        }
    });
}


// Pauza je zamerne oddelena od "job bezi". Job zustava rozdelany a continue
// se k nemu vrati, ale stroj mezitim stoji, takze se smi jogovat - treba na
// vymenu hrotu. Pozice pro navrat si drzi nanoComm ve svem remeberedReport,
// takze ji rucni pojezd nerozbije.
function setJobPaused(paused) {
    if (jobPaused === paused) {
        return
    }

    jobPaused = paused

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
    jobStartedAt = running ? Date.now() : 0

    if (!running) {
        setJobPaused(false)
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
            console.log('[JS] Recieved report from nano')

            if (message.status === 1 && message.error === 163) {
                sendMessageFe({
                    cmdBE: 3, nanoReport: message
                })
                return
            }

            if (message.status === 1 && message.error === 162) {
                sendMessageFe({
                    cmdBE: 5, nanoReport: message
                })
                return
            }

            // Konec jobu. Nano posle error 8 na M2, nanoComm 11 kdyz dojel
            // soubor a 10 kdyz job umrel driv. Bez tohohle by printUnderGoing
            // zustalo natrvalo true a jog by uz nikdy nesel odemknout.
            if (message.status === 0 && message.error === 8) {
                setJobRunning(false)
            }

            // 11 je dojeti az na konec souboru, jen u nej ma smysl ukladat
            // delku. 10 znamena, ze job umrel driv, takze by to byl cas
            // nedodelane prace.
            if (message.status === 1 && message.error === 11) {
                finishJob()
            }

            if (message.status === 1 && message.error === 10) {
                setJobRunning(false)
            }

            sendMessageFe({
                cmdBE: 2, nanoReport: message
            })

        } catch {
            console.log('[JS] Sent message from C++ is not a JSON')
            backendReport(33)
        }
        return
    }

    else {
        console.log('[JS] Sent message from C++ did not contain correct starting symbol')
        backendReport(34)
        return
    }

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


app.post("/uploadGerber", gerberUpload.single("gerber"), async (req, res) => {
    // fileFilter soubor zahodil -> multer nenastavi req.file
    if (!req.file) {
        console.warn("[JS] Gerber upload was rejected by the file filter")
        return res.status(400).json({
            answer: `Rejected: not a Gerber file. Allowed: ${gerberExtensions.join(", ")}`
        })
    }

    // Do seznamu patri i gerber. G-kod k nemu jeste neexistuje, ten se
    // vyrobi az pri tisku - ale job uz je to ted.
    const name = req.file.filename
    const date = Date.now()
    const size = req.file.size

    if (!await rememberGcode(name, date, size)) {
        return res.status(500).json({
            answer: "Gerber was saved on disk, but it could not be written into the job list"
        })
    }

    console.log(`[JS] Gerber: ${name}, was uploaded, ${size} B`)
    sendMessageFe({ cmdBE: 1, job: { name: name, date: date, size: size } })

    res.json({
        answer: "Gerber upload was succesfull"
    })
})


// Jmeno je v tabulce unikatni, takze druhy upload stejneho jmena radek
// prepise - soubor na disku se prepsal taky, dva zaznamy na jeden soubor
// by si jen odporovaly.
function rememberGcode(name, date, size) {
    return new Promise((resolve) => {
        db.run(
            `INSERT INTO gcodeList (name, date, gsize, printed) VALUES (?, ?, ?, 0)
             ON CONFLICT(name) DO UPDATE SET date = excluded.date, gsize = excluded.gsize`,
            [name, date, size],
            (err) => {
                if (err) {
                    console.error("[JS DB] G-code could not be written into the list:", err.message)
                    resolve(false)
                    return
                }

                resolve(true)
            }
        )
    })
}


app.post("/uploadGcode", gcodeUpload.single("gcode"), async (req, res) => {
    // fileFilter soubor zahodil -> multer nenastavi req.file
    if (!req.file) {
        console.warn("[JS] G-code upload was rejected by the file filter")
        return res.status(400).json({
            answer: `Rejected: not a G-code file. Allowed: ${gcodeExtensions.join(", ")}`
        })
    }

    // Datum i velikost bere backend ze sebe, ne z tela requestu. Driv je
    // posilal prohlizec zvlast na /newDBGcodeIns a mohly rict cokoliv.
    const name = req.file.filename
    const date = Date.now()
    const size = req.file.size

    const stored = await rememberGcode(name, date, size)

    if (!stored) {
        return res.status(500).json({
            answer: "G-code was saved on disk, but it could not be written into the job list"
        })
    }

    console.log(`[JS] G-code: ${name}, was uploaded, ${size} B`)

    // Seznam jobu na frontendu se tim doplni hned, bez refreshe stranky.
    sendMessageFe({ cmdBE: 1, job: { name: name, date: date, size: size } })

    res.json({
        answer: "Gcode upload was succesfull"
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


server.listen(httpPort, httpHost, () => {
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
