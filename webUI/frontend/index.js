
const XForward = document.getElementById("XbuttP")
const XBackwards = document.getElementById("XbuttM")
const YForward = document.getElementById("YbuttP")
const YBackwards = document.getElementById("YbuttM")
const ZForward = document.getElementById("ZbuttP")
const ZBackwards = document.getElementById("ZbuttM")

const stopBut = document.getElementById("stop")
const pauseBut = document.getElementById("pause")
const continueBut = document.getElementById("continue")
const homeBut = document.getElementById("home")

const gcodeUpload = document.getElementById("gcodeUpload")
const gcodeBackText = document.getElementById("uploadSuccesText")

const printerStatus = document.getElementById("Status")
const printerError = document.getElementById("error")
const printerPosition = document.getElementById("position")
const printerSpeed = document.getElementById("speed")
const printerSpindlSpeed = document.getElementById("spindlSpeed")

const operationResult = document.getElementById("operateAnswer")
const gcodeList = document.getElementById("GcodeList")
const emergencyResult = document.getElementById("EmergencyID")
const gcodeListArrNames = []

/** @type {HTMLInputElement} */
const gcodeFile = document.getElementById("gcodeInput")

let currentSizeOperator = 10
let currentSpeedSizeOperator = 10
let currentSpindleSpeedSizeOperator = 10


window.addEventListener("DOMContentLoaded", () => {
    loadGcodesFromDB()

    loadNanoReport()
    setInterval(loadNanoReport, 500)
})


async function sendEmergencyCMD(name) {
    try {
        const response = await fetch("http://localhost:3300/emergency", {
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


async function homeButton(event) {
    event.preventDefault()
    try {
        const response = await fetch("http://localhost:3300/home", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            },
            body: JSON.stringify({
                cmd: "min"
            })
        })

        const data = await response.json()
        emergencyResult.textContent = data.answer
    } catch (err) {
        console.error("[FE] Homing command could not be sent:", err)
        emergencyResult.textContent = "Backend is not responding"
    }
}


async function rmButFunq (event) {
        event.preventDefault()
        let curName = event.target.id
        const gcodeName = curName.replace("-remove", "")
        operateGcodeList(gcodeName, 0, 0, "remove")
        const response = await fetch("http://localhost:3300/deleteGcode", {
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

        const response = await fetch("http://localhost:3300/printGcode", {
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


async function sendOperate(axis, size) {
    try {
        const response = await fetch("http://localhost:3300/operate", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            },
            body: JSON.stringify({
                corect: true,
                cmd: axis,
                size: size
            })
        })

        const data = await response.json()
        operationResult.textContent = data.answer
    } catch (err) {
        console.error(`[FE] Jog ${axis} by ${size} could not be sent:`, err)
        operationResult.textContent = "Backend is not responding"
    }
}


function jogButton(axis, direction) {
    return async function (event) {
        event.preventDefault()
        await sendOperate(axis, direction * currentSizeOperator)
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
homeBut.addEventListener("click", homeButton)


gcodeUpload.addEventListener("click", async function (event) {
    event.preventDefault()

    if (gcodeFile.files.length === 0) {
        alert('No file was uploaded')
        gcodeBackText.textContent = 'No file was uploaded'
        return
    }

    const fileForm = new FormData
    const nameGcode = gcodeFile.files[0].name
    fileForm.append("gcode", gcodeFile.files[0])
    const response = await fetch("http://localhost:3300/uploadGcode", {
        method: "POST",
        body: fileForm
    })

    const data = await response.json()
    gcodeBackText.textContent = data.answer

    operateGcodeList(nameGcode, Date.now(), gcodeFile.files[0].size, "add")
    const response2 = await fetch("http://localhost:3300/newDBGcodeIns", {
                method: "POST",
                headers: {
                    "Content-Type" : "application/json"
                },
                body: JSON.stringify({
                    time: Date.now(),
                    size: gcodeFile.files[0].size,
                    name: nameGcode
                })
            })

    const data2 = await response2.json()
    console.log("DB response:" + data2.answer)
})


async function loadGcodesFromDB() {
    try {
        const response = await fetch("http://localhost:3300/gcodeListUpload");
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


async function loadNanoReport() {
    let data
    try {
        const response = await fetch("http://localhost:3300/currentPrinterInfo", {
            method: "POST",
            headers: {
                "Content-Type" : "application/json"
            }
        })

        data = await response.json()
    } catch (err) {
        console.error("[FE] Telemetry could not be loaded:", err)
        printerStatus.textContent = "Status: backend is not responding"
        return
    }

    let statusContent = "Frontend"
    let error = "Not connected"

    if (data.status === 0) {
        statusContent = "Nano"
    }
    if (data.status === 1) {
        statusContent = "C++ communication"
    }
    if (data.status === 2) {
        statusContent = "Backend"
    }

    // if-else strom na erory

    printerStatus.textContent = "Status: " + statusContent
    printerError.textContent = "Error: " + error
    printerPosition.textContent = `X: ${data.x} | Y: ${data.y} | Z: ${data.z}`
    printerSpeed.textContent = "Speed: " + `${data.speed}`
    printerSpindlSpeed.textContent = "Spindle speed: " + `${data.spindlSpeed}`
    // jeste nejaka zmena svetilka na to aby to signalizovalo zmenu telemetrie
}