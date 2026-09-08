
const XForward = document.getElementById("XbuttP")
const XBackwards = document.getElementById("XbuttM")
const YForward = document.getElementById("YbuttP")
const YBackwards = document.getElementById("YbuttM")
const ZForward = document.getElementById("ZbuttP")
const ZBackwards = document.getElementById("ZbuttM")

const stopBut = document.getElementById("stop")
const pauseBut = document.getElementById("pause")
const continueBut = document.getElementById("continue")
const homeMinBut = document.getElementById("homeMin")
const homeMaxBut = document.getElementById("homeMax")

const stepSizeSlider = document.getElementById("stepSize")
const stepSpeedSlider = document.getElementById("stepSpeed")
const stepSpindleSlider = document.getElementById("stepSpindle")

const stepSizeValue = document.getElementById("stepSizeValue")
const stepSpeedValue = document.getElementById("stepSpeedValue")
const stepSpindleValue = document.getElementById("stepSpindleValue")

const zSpeedHint = document.getElementById("zSpeedHint")

const jogLock = document.getElementById("jogLock")
const jobBadge = document.getElementById("jobBadge")
const jobMeter = document.getElementById("jobMeter")
const jobBar = document.getElementById("jobBar")
const jobNameText = document.getElementById("jobName")
const jobLineText = document.getElementById("jobLine")

const jobCurrentList = document.getElementById("jobCurrentList")

//visual stuff

const 















// Vsechno, cim jde strojem hnout rucne. Behem jobu se to zamyka, aby se
// doprostred frezovani nedala poslat druha sada souradnic. Prekryv sam
// o sobe nestaci - klavesnici by se na tlacitka poradu dalo dostat.
const jogControls = [
    XForward, XBackwards, YForward, YBackwards, ZForward, ZBackwards,
    homeMinBut, homeMaxBut,
    stepSizeSlider, stepSpeedSlider, stepSpindleSlider
]

// null, ne false: prvni report ma stav vzdycky nastavit, i kdyz job nebezi.
let jogLocked = null

// Osa Z jede pres trapezovou tyc T8, tedy 200 kroku/mm proti 12.5 kroku/mm
// u GT2 remene na X a Y. Stejna rychlost v mm/s tam znamena 16x vyssi
// frekvenci kroku a nad timhle stropem uz motor kroky ztraci.
// Skutecny limit si hlida firmware v maxSpeedZ - tohle je jen proto, aby
// uzivatel dopredu videl, co se opravdu posle, a nedivil se, ze stroj
// jede jinak, nez kam si posunul posuvnik.
const maxSpeedZ = 10

// Kroku na 1 mm, musi sedet se stepLenghtGT2 a stepLenghtT8 v
// nanoCode/src/main.cpp. X a Y jedou po GT2 remeni (12.5 kroku/mm, tedy
// jeden krok = 0.08 mm), Z po trapezove tyci T8 (200 kroku/mm, 0.005 mm).
//
// Posuvnik kroku jde dolu az na 0.05 mm kvuli sazeni nastroje v ose Z.
// Na X a Y je ale 0.05 mm POD jednim krokem: move2D pocita
// maxStepX = abs(12.5 * 0.05) = int(0.625) = 0, takze se nestane vubec nic
// a tlacitko vypada jako mrtve. Proto ta hlaska nize.
//
// Pozor na rozdil v zaokrouhleni: move2D kroky USEKAVA (int cast), moveZ
// je ZAOKROUHLUJE (+ 0.5f pred castem). Nasleduje se to tady stejne, aby
// vypis odpovidal tomu, co stroj opravdu ujede.
const stepsPerMMXY = 12.5
const stepsPerMMZ = 200

function realStepFor(axis, size) {
    if (axis === "z") {
        return Math.trunc(size * stepsPerMMZ + 0.5) / stepsPerMMZ
    }

    return Math.trunc(size * stepsPerMMXY) / stepsPerMMXY
}

const gerberUpload = document.getElementById("gerberUpload")
const gerberFeedback = document.getElementById("gerberFeedback")

// Gerber nema jednu jedinou priponu. Tohle je rodina RS-274X / X2 plus
// Excellon vrtaci soubory, ktere pcb2gcode taky potrebuje.
// Zamerne tu NENI .txt, i kdyz nektere nastroje tak vrtani exportuji -
// pustilo by to dovnitr cokoliv. Stejny seznam musi byt v backend/server.js.
const gerberExtensions = [
    ".gbr", ".ger", ".gbrjob",
    ".gtl", ".gbl",
    ".gts", ".gbs",
    ".gto", ".gbo",
    ".gtp", ".gbp",
    ".gm1", ".gko",
    ".drl", ".xln"
]

const printerStatus = document.getElementById("Status")
const printerError = document.getElementById("error")
const printerErrorMessage = document.getElementById("errorMessage")
const printerPosition = document.getElementById("position")
const printerSpeed = document.getElementById("speed")
const printerSpindlSpeed = document.getElementById("spindlSpeed")
const endstopSummary = document.getElementById("endstopSummary")

// Bity musi souhlasit s poli endstopHits, ktere Nano posila v reportu.
// Poradi je stejne jako v setupPins: front (min) pak end (max), X -> Y -> Z.
const endstopChips = [
    { element: document.getElementById("esXmin"), bit: 1,  label: "X min" },
    { element: document.getElementById("esXmax"), bit: 2,  label: "X max" },
    { element: document.getElementById("esYmin"), bit: 4,  label: "Y min" },
    { element: document.getElementById("esYmax"), bit: 8,  label: "Y max" },
    { element: document.getElementById("esZmin"), bit: 16, label: "Z min" },
    { element: document.getElementById("esZmax"), bit: 32, label: "Z max" }
]

// Kdo report poslal. Stejna hodnota erroru znamena u kazdeho zdroje neco jineho,
// proto se erory hledaji az podle statusu.
const statusNames = {
    0: "Nano",
    1: "C++ communication",
    2: "Backend"
}

const errorMessages = {
    // status 0 - hlasi firmware v Nanu
    0: {
        0:  { level: "ok",   text: "Command finished without any problem." },
        3:  { level: "bad",  text: "Nano could not parse the command it received. The frame was damaged on the way over UART." },
        4:  { level: "ok",   text: "Ping answered. The Nano is alive and talking." },
        5:  { level: "bad",  text: "Nano does not know this command number." },
        6:  { level: "warn", text: "Target was outside the work area, so it was clamped to the nearest edge. The machine moved somewhere else than you asked." },
        7:  { level: "bad",  text: "An endstop was hit during the move, or the machine was never homed. The reported position is no longer trustworthy - home the machine." },
        8:  { level: "ok",   text: "End of job: spindle is off and all axes were homed to maximum." },
        10: { level: "bad",  text: "Emergency button was pressed. Motors and spindle are off and the step timer is stopped." }
    },
    // status 1 - hlasi C++ demon nanoComm
    1: {
        0: { level: "ok",   text: "C++ communication is running." },
        1: { level: "bad",  text: "The requested G-code file was not found on disk." },
        2: { level: "bad",  text: "UART is already busy, the command was dropped." },
        3: { level: "warn", text: "Move refused because the machine is not homed. Run HOME MIN or HOME MAX first." },
        6: { level: "bad",  text: "Nano disconnected from the serial port while a report was being read." },
        7: { level: "bad",  text: "Serial port is not open. Check the cable and the port name." }
    },
    // status 2 - hlasi tenhle JS backend
    2: {
        0:  { level: "warn", text: "Backend has not received any report from the machine yet." },
        33: { level: "bad",  text: "C++ communication sent something that is not valid JSON." },
        34: { level: "bad",  text: "C++ communication sent a message without the $ start marker." }
    }
}

const levelPrefixes = {
    ok: "",
    warn: "Warning: ",
    bad: "Problem: "
}

const operationResult = document.getElementById("operateAnswer")
const gcodeList = document.getElementById("GcodeList")
const emergencyResult = document.getElementById("EmergencyID")
const gcodeListArrNames = []

/** @type {HTMLInputElement} */
const gerberFile = document.getElementById("gerberInput")

let currentSizeOperator = 0
let currentSpeedSizeOperator = 0
let currentSpindleSpeedSizeOperator = 0


window.addEventListener("DOMContentLoaded", () => {
    loadGcodesFromDB()

    loadNanoReport()
    setInterval(loadNanoReport, 500)
})


async function sendEmergencyCMD(name) {
    try {
        const response = await fetch("/emergency", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            },
            body: JSON.stringify({
                cmd: name
            })
        })

        const data = await response.json()
        emergencyResult.textContent = data.answer
    } catch (err) {
        console.error(`[FE] Emergency command ${name} could not be sent:`, err)
        emergencyResult.textContent = "Backend is not responding"
    }
}


async function stopButton(event) {
    event.preventDefault()
    await sendEmergencyCMD("Stop")
}


async function pauseButton(event) {
    event.preventDefault()
    await sendEmergencyCMD("Pause")
}


async function continueButton(event) {
    event.preventDefault()
    await sendEmergencyCMD("Continue")
}


function homeButton(direction) {
    return async function (event) {
        event.preventDefault()
        try {
            const response = await fetch("/home", {
                method: "POST",
                headers: {
                    "Content-Type" : "application/json"
                },
                body: JSON.stringify({
                    cmd: direction
                })
            })

            const data = await response.json()
            emergencyResult.textContent = data.answer
        } catch (err) {
            console.error(`[FE] Homing command ${direction} could not be sent:`, err)
            emergencyResult.textContent = "Backend is not responding"
        }
    }
}


function bindSlider(slider, readout, unit, apply) {
    function refresh() {
        const value = Number(slider.value)
        apply(value)
        readout.textContent = `${value} ${unit}`
    }

    slider.addEventListener("input", refresh)
    refresh()
}


async function rmButFunq (event) {
        event.preventDefault()
        let curName = event.target.id
        const gcodeName = curName.replace("-remove", "")
        operateGcodeList(gcodeName, 0, 0, "remove")
        const response = await fetch("/deleteGcode", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            },
            body: JSON.stringify({
                aprove: 1,
                name: gcodeName
            })
        })
}


async function printButFunq (event) {
        event.preventDefault()

        let curName = event.target.id
        const gcodeName = curName.replace("-print", "")
        const responsePlace = document.getElementById(`${gcodeName}-response`)

        const response = await fetch("/printGcode", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            },
            body: JSON.stringify({
                aprove: 1,
                gcodeName: gcodeName
            })
        })

        const data = await response.json()
        responsePlace.textContent = "Response: " + data.answer
}


function listAddListeners(name) {
    const printBut = document.getElementById(`${name}-print`)
    const rmBut = document.getElementById(`${name}-remove`)

    rmBut.addEventListener("click", rmButFunq)

    printBut.addEventListener("click", printButFunq)
}


function listRmListeners(name) {
    const printBut = document.getElementById(`${name}-print`)
    const rmBut = document.getElementById(`${name}-remove`)
    printBut.removeEventListener("click", printButFunq)
    rmBut.removeEventListener("click", rmButFunq)
}


function operateGcodeList(name, date, size, opperation) {
    if (opperation === "add") {
        if (!(gcodeListArrNames.includes(name))) {
            const cardHTML = `
                <div id="${name}-card" class="gcode-card">
                    <p id="${name}-nameing" class="gcodeName"><strong>Name:</strong> ${name}</p>
                    <p id="${name}-date" class="gcodeDate">Uploaded: ${new Date(date).toLocaleString()}</p>
                    <p id="${name}-size" class="gcodeSize">Size: ${(size / (1024 * 1024)).toFixed(2)} MB</p>
                    <button id="${name}-print" class="gcodePrint">Print</button>
                    <button id="${name}-remove" class="gcodeRemove">Remove</button>
                    <p id="${name}-response" class="gcodeRes">Response: </p>
                </div>
            `
            gcodeList.insertAdjacentHTML('beforeend', cardHTML)
            gcodeListArrNames.push(name)
            listAddListeners(name)
        } else {
            console.log("Name occupied: operateGcodeList")
        }

    }

    else if (opperation === "remove") {
        if (gcodeListArrNames.includes(name)) {
            listRmListeners(name)
            const gcodeCard = document.getElementById(`${name}-card`)

            if (gcodeCard) {
                gcodeCard.remove()
            }

            const index = gcodeListArrNames.indexOf(name);

            if (index !== -1) {
                gcodeListArrNames.splice(index, 1);
            }
        }
        else {
            console.log("Unknown name: operateGcodeList")
        }
    }

    else {
        console.log("Unknown command from: operateGcodeList")
    }
}


async function sendOperate(axis, size, speed, spindleSpeed) {
    try {
        const response = await fetch("/operate", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            },
            body: JSON.stringify({
                corect: true,
                cmd: axis,
                size: size,
                speed: speed,
                spindleSpeed: spindleSpeed
            })
        })

        const data = await response.json()
        operationResult.textContent = data.answer
    } catch (err) {
        console.error(`[FE] Jog ${axis} by ${size} could not be sent:`, err)
        operationResult.textContent = "Backend is not responding"
    }
}


function refreshZSpeedHint(feed) {
    const capped = feed > maxSpeedZ
    zSpeedHint.textContent = capped ? `capped at ${maxSpeedZ} mm/s` : `max ${maxSpeedZ} mm/s`
    zSpeedHint.classList.toggle("hint-active", capped)
}


function jogButton(axis, direction) {
    return async function (event) {
        event.preventDefault()
        let speed = currentSpeedSizeOperator

        if (axis === "z" && speed > maxSpeedZ) {
            console.log(`[FE] Z jog feed ${speed} mm/s capped to ${maxSpeedZ} mm/s`)
            speed = maxSpeedZ
        }

        const real = realStepFor(axis, currentSizeOperator)

        if (real === 0) {
            console.warn(`[FE] ${axis.toUpperCase()} jog ${currentSizeOperator} mm is below one motor step - firmware rounds it to zero steps and the axis will not move at all`)
        }
        else if (Math.abs(real - currentSizeOperator) > 1e-9) {
            console.log(`[FE] ${axis.toUpperCase()} jog ${currentSizeOperator} mm is not a whole number of steps, machine will move ${real.toFixed(4)} mm`)
        }

        await sendOperate(axis, direction * currentSizeOperator, speed, currentSpindleSpeedSizeOperator)
    }
}


XForward.addEventListener("click", jogButton("x", 1))
XBackwards.addEventListener("click", jogButton("x", -1))
YForward.addEventListener("click", jogButton("y", 1))
YBackwards.addEventListener("click", jogButton("y", -1))
ZForward.addEventListener("click", jogButton("z", 1))
ZBackwards.addEventListener("click", jogButton("z", -1))

stopBut.addEventListener("click", stopButton)
pauseBut.addEventListener("click", pauseButton)
continueBut.addEventListener("click", continueButton)
homeMinBut.addEventListener("click", homeButton("min"))
homeMaxBut.addEventListener("click", homeButton("max"))

bindSlider(stepSizeSlider, stepSizeValue, "mm", (value) => { currentSizeOperator = value })
bindSlider(stepSpeedSlider, stepSpeedValue, "mm/s", (value) => {
    currentSpeedSizeOperator = value
    refreshZSpeedHint(value)
})
bindSlider(stepSpindleSlider, stepSpindleValue, "rpm", (value) => { currentSpindleSpeedSizeOperator = value })


function gerberExtensionOf(fileName) {
    const lower = fileName.toLowerCase()
    return gerberExtensions.find(extension => lower.endsWith(extension)) ?? null
}


gerberUpload.addEventListener("click", async function (event) {
    event.preventDefault()

    if (gerberFile.files.length === 0) {
        gerberFeedback.textContent = "No file was selected"
        return
    }

    const chosenFile = gerberFile.files[0]
    const nameGerber = chosenFile.name

    // Prvni kontrola je tady, druha na backendu. Tuhle jde obejit
    // (accept v <input> je jen napoveda dialogu, ne validace), tu druhou ne.
    if (!gerberExtensionOf(nameGerber)) {
        console.warn("[FE] Upload rejected, not a Gerber extension:", nameGerber)
        gerberFeedback.textContent = `"${nameGerber}" is not a Gerber file. Allowed: ${gerberExtensions.join(", ")}`
        return
    }

    const fileForm = new FormData()
    fileForm.append("gerber", chosenFile)

    try {
        const response = await fetch("/uploadGerber", {
            method: "POST",
            body: fileForm
        })

        const data = await response.json()
        gerberFeedback.textContent = data.answer

        // Do seznamu a do DB se zapisuje teprve az backend soubor prijal.
        // Driv se to zapsalo vzdycky, i kdyz upload selhal.
        if (!response.ok) {
            console.warn("[FE] Backend rejected the Gerber:", data.answer)
            return
        }

        operateGcodeList(nameGerber, Date.now(), chosenFile.size, "add")

        const response2 = await fetch("/newDBGcodeIns", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            },
            body: JSON.stringify({
                time: Date.now(),
                size: chosenFile.size,
                name: nameGerber
            })
        })

        const data2 = await response2.json()
        console.log("[FE] DB response:", data2.answer)
    } catch (err) {
        console.error("[FE] Gerber upload failed:", err)
        gerberFeedback.textContent = "Backend is not responding"
    }
})


async function loadGcodesFromDB() {
    try {
        const response = await fetch("/gcodeListUpload");
        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const gcodes = await response.json();

        gcodeList.innerHTML = "";
        gcodeListArrNames.length = 0;

        gcodes.forEach(gcode => {
            operateGcodeList(gcode.name, gcode.date, gcode.gsize, "add");
        });

        console.log("[FE] Seznam G-kódů úspěšně načten z databáze.");
    } catch (err) {
        console.error("[FE] Nepodařilo se načíst G-kódy:", err);
    }
}


function describeError(status, error) {
    const perStatus = errorMessages[status]

    if (perStatus && perStatus[error]) {
        return perStatus[error]
    }

    return { level: "warn", text: `Error code ${error} is not described anywhere, look into commProtocol.txt.` }
}


// Cisla z Nana jdou pres float v C++ a nlohmann je serializuje jako double,
// takze v JSON prijde treba 12.340000152587891. Tady se to jen zobrazuje,
// proto se to krati az na miste vypisu.
function formatNumber(value, digits) {
    const number = Number(value)

    if (!Number.isFinite(number)) {
        return "--"
    }

    return number.toFixed(digits)
}


function renderEndstops(mask) {
    const known = Number.isInteger(mask) && mask >= 0
    const hitNames = []

    endstopChips.forEach(chip => {
        if (!chip.element) {
            return
        }

        chip.element.classList.remove("endstop-hit", "endstop-clear", "endstop-unknown")

        if (!known) {
            chip.element.classList.add("endstop-unknown")
            return
        }

        if (mask & chip.bit) {
            chip.element.classList.add("endstop-hit")
            hitNames.push(chip.label)
        } else {
            chip.element.classList.add("endstop-clear")
        }
    })

    if (!known) {
        endstopSummary.textContent = "Endstop states are not present in the report yet."
        return
    }

    if (hitNames.length === 0) {
        endstopSummary.textContent = "No endstop was hit during the last move."
        return
    }

    endstopSummary.textContent = `Hit during the last move: ${hitNames.join(", ")}.`
}


function setJogLocked(locked) {
    if (jogLocked === locked) {
        return
    }

    jogLocked = locked
    jogLock.hidden = !locked

    for (const control of jogControls) {
        if (control) {
            control.disabled = locked
        }
    }

    console.log(locked
        ? "[FE] Job is running, jog controls locked"
        : "[FE] No job is running, jog controls unlocked")
}


// jobRunning drzi backend, protoze Nano zadny pojem "job" nema. gcodeLine
// a gcodeLines plni nanoComm z dekoderu a dokud neprijde prvni report
// z jobu, jsou na -1.
function renderJob(data) {
    const running = data?.jobRunning === true
    const paused = data?.jobPaused === true

    // V pauze stroj stoji a pozice pro navrat je zapamatovana v nanoComm,
    // takze rucni pojezd nicemu nevadi. Zamyka se jen skutecne bezici job.
    setJogLocked(running && !paused)

    const state = !running ? "Idle" : (paused ? "Paused" : "Running")
    jobBadge.textContent = state
    jobBadge.className = `panel-badge job-badge ${!running ? "job-idle" : (paused ? "job-paused" : "job-active")}`

    if (!running) {
        jobNameText.textContent = "No job is running"
        jobLineText.textContent = "Line —"
        jobBar.style.width = "0%"
        jobMeter.setAttribute("aria-valuenow", "0")
        return
    }

    jobNameText.textContent = paused
        ? `${data.jobName || "Unnamed job"} — paused, jogging is allowed`
        : (data.jobName || "Unnamed job")

    const line = Number(data.gcodeLine)
    const total = Number(data.gcodeLines)

    // Mezi odeslanim tisku a prvnim reportem z dekoderu se nic nepocita.
    if (!Number.isFinite(line) || line < 0 || !Number.isFinite(total) || total <= 0) {
        jobLineText.textContent = "Line — (waiting for the first report)"
        jobBar.style.width = "0%"
        jobMeter.setAttribute("aria-valuenow", "0")
        return
    }

    const percent = Math.min(100, Math.max(0, (line / total) * 100))
    jobLineText.textContent = `Line ${line} of ${total} · ${percent.toFixed(0)} %`
    jobBar.style.width = `${percent}%`
    jobBar.className = paused ? "job-bar job-paused-bar" : "job-bar"
    jobMeter.setAttribute("aria-valuenow", percent.toFixed(0))
}


async function loadNanoReport() {
    let data
    try {
        const response = await fetch("/currentPrinterInfo", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            }
        })

        data = await response.json()
    } catch (err) {
        console.error("[FE] Telemetry could not be loaded:", err)
        printerStatus.textContent = "Status: backend is not responding"
        printerError.textContent = "Error: --"
        printerErrorMessage.textContent = "Problem: the frontend cannot reach the backend that served this page. Nothing below is live."
        printerErrorMessage.className = "error-message level-bad"
        renderEndstops(undefined)
        // Bez backendu stejne zadny prikaz neodejde, takze zamek nema co
        // chranit - nechat ho zavreny by jen znemoznilo jogovat po navratu.
        renderJob(undefined)
        return
    }

    const statusContent = statusNames[data.status] ?? `Unknown source (${data.status})`
    const description = describeError(data.status, data.error)

    printerStatus.textContent = "Status: " + statusContent
    printerError.textContent = "Error: " + data.error
    printerErrorMessage.textContent = levelPrefixes[description.level] + description.text
    printerErrorMessage.className = `error-message level-${description.level}`

    printerPosition.textContent = `X: ${formatNumber(data.x, 2)} | Y: ${formatNumber(data.y, 2)} | Z: ${formatNumber(data.z, 2)}`
    printerSpeed.textContent = `Speed: ${formatNumber(data.speed, 2)} mm/s`
    printerSpindlSpeed.textContent = `Spindle speed: ${formatNumber(data.spindlSpeed, 0)} rpm`

    renderEndstops(data.endstops)
    renderJob(data)
    // jeste nejaka zmena svetilka na to aby to signalizovalo zmenu telemetrie
}


async function loadCurrentJobList() {
    
}