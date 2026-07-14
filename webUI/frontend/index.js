
const XForward = document.getElementById("XbuttP")
const XBackwards = document.getElementById("XbuttM")
const gcodeUpload = document.getElementById("gcodeUpload")
const gcodeBackText = document.getElementById("uploadSuccesText")
const printerStatus = document.getElementById("Status")
const printerError = document.getElementById("error")
const printerPosition = document.getElementById("position")
const printerSpeed = document.getElementById("speed")
const printerSpindlSpeed = document.getElementById("spindlSpeed")
const operationResult = document.getElementById("operateAnswer")
const gcodeList = document.getElementById("GcodeList")
const gcodeListArrNames = []


/** @type {HTMLInputElement} */
const gcodeFile = document.getElementById("gcodeInput")


async function rmButFunq (event) {
        event.preventDefault()
        let curName = event.target.id
        const gcodeName = curName.replace("-remove", "")
        operateGcodeList(gcodeName, 0, 0, "remove")
}


async function printButFunq (event) {
        event.preventDefault()

        let curName = event.target.id
        const gcodeName = curName.replace("-print", "")
        const responsePlace = document.getElementById(`${gcodeName}-`)

        const response = await fetch("http://localhost:3300/operate", {
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


XForward.addEventListener("click", async function (event) {
    event.preventDefault()
    
    const response = await fetch("http://localhost:3300/operate", {
        method: "POST",
        headers: {
            "Content-Type" : "application/json"
        }
    })

    const data = await response.json()
    operationResult.textContent = data.answer
})


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

    const data2 = await response.json()
    console.log("DB response:" + data2.answer)
})