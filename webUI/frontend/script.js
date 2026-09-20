import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';


//background
const main = document.querySelector('main')
//main.style.backgroundImage = "url('./backgrounds-default/ComplexGraph.png')"



//error graphical conversions
const statusPage = document.querySelector("#statusPage")
const errorPage = document.querySelector("#errorPage")

const errorNumLabel = document.querySelector("#error")
const statusNumLabel = document.querySelector("#status")

const errorMessageLabel = document.querySelector("#errorExplain")
const statusMessageLabel = document.querySelector("#statusExplain")


function changeError(badness) {
    if (badness === 1) {
        errorPage.classList.remove("stateUnknown", "stateOk", "stateBad")
        errorPage.classList.add("stateOk")
    }
    
    else if (badness === 2) {
        errorPage.classList.remove("stateUnknown", "stateOk", "stateBad")
        errorPage.classList.add("stateUnknown")
    }

    else if (badness === 3) {
        errorPage.classList.remove("stateUnknown", "stateOk", "stateBad")
        errorPage.classList.add("stateBad")
    }
}


function changeStatus(badness) {
    if (badness === 1) {
        statusPage.classList.remove("stateUnknown", "stateOk", "stateBad")
        statusPage.classList.add("stateOk")
    }
    
    else if (badness === 2) {
        statusPage.classList.remove("stateUnknown", "stateOk", "stateBad")
        statusPage.classList.add("stateUnknown")
    }

    else if (badness === 3) {
        statusPage.classList.remove("stateUnknown", "stateOk", "stateBad")
        statusPage.classList.add("stateBad")
    }
}


// Kdo report poslal. Podle dokumentace (documentation/commProtocol.txt)
// je status nutny k precteni erroru - stejne cislo znamena u kazdeho zdroje
// neco jineho, napriklad 6 je u Nana "clampnuty cil", ale u nanoCommu
// "Nano se odpojilo".
const statusMessages = {
    0: { badness: 1, text: "Nano is reporting." },
    1: { badness: 1, text: "C++ communication is reporting." },
    2: { badness: 2, text: "Backend is reporting, nothing from the machine yet." },
    3: { badness: 3, text: "Frontend is reporting, the backend is not connected." }
}


// badness odpovida tomu, co berou changeError a changeStatus:
// 1 = ok (zelena), 2 = nerozhodnuto (zluta), 3 = chyba (cervena).
const errorMessages = {
    // --- status 0, hlasi firmware v Nanu ---------------------------------
    0: {
        0:  { badness: 1, text: "Command finished without any problem." },
        3:  { badness: 3, text: "Nano could not parse the command. The frame was damaged over UART." },
        4:  { badness: 1, text: "Ping answered, the Nano is alive." },
        5:  { badness: 3, text: "Nano does not know this command number." },
        6:  { badness: 2, text: "Target was outside the work area and got clamped to the nearest edge. The machine moved somewhere else than you asked." },
        7:  { badness: 3, text: "An endstop was hit, or the machine was never homed. The reported position is not trustworthy, home the machine." },
        8:  { badness: 1, text: "End of job: spindle off, all axes homed to maximum." },
        10: { badness: 3, text: "Emergency button pressed. Motors and spindle are off and the step timer is stopped." }
    },

    // --- status 1, hlasi nanoComm ----------------------------------------
    1: {
        0:  { badness: 1, text: "C++ communication is running." },
        1:  { badness: 3, text: "The requested G-code file was not found on disk." },
        2:  { badness: 3, text: "UART is already busy, the command was dropped." },
        3:  { badness: 2, text: "Move refused, the machine is not homed. Run HOME MIN or HOME MAX first." },
        6:  { badness: 3, text: "Nano disconnected from the serial port while a report was being read." },
        7:  { badness: 3, text: "Serial port is not open. Check the cable and the port name." },
        10: { badness: 3, text: "Job was stopped before the end because the Nano reported an error or stopped answering." },
        11: { badness: 1, text: "Job ran to the end of the file. Spindle is off and the machine is homed." },

        // 162 a 163 nejsou chyby, jsou to znacky (viz commProtocol.txt).
        // Do panelu by se vubec dostat nemely - backend 163 preposila jako
        // cmdBE 3 a 162 si ma vybrat taky sam. Tohle je jen zachytka, at
        // nesviti "neznamy kod", kdyby nekterou pustil dal.
        162: { badness: 1, text: "Time estimate for the running job, not an error." },
        163: { badness: 1, text: "Prereport, the state nanoComm expects before the Nano confirms it. Not an error." }
    },

    // --- status 2, hlasi backend -----------------------------------------
    2: {
        0:  { badness: 2, text: "Backend has not received any report from the machine yet." },
        1:  { badness: 3, text: "Backend could not read the last command, it was not valid JSON." },
        2:  { badness: 3, text: "Backend did not understand the last command and dropped it." },
        3:  { badness: 2, text: "Command refused, a job is running. Pause the job first if you need to jog." },
        4:  { badness: 3, text: "G-code could not be generated, the job did not start." },
        5:  { badness: 3, text: "Command went nowhere, the C++ communication is not connected." },
        33: { badness: 3, text: "C++ communication sent something that is not valid JSON." },
        34: { badness: 3, text: "C++ communication sent a message without the $ start marker." }
    },

    // --- status 3, hlasi frontend ----------------------------------------
    // Tenhle zdroj nic neposila, dopisuje si ho stranka sama v okamziku, kdy
    // spojeni s backendem nestoji. Nic na strance pak neni aktualni, je to
    // posledni znamy stav.
    3: {
        0: { badness: 3, text: "Not connected to the backend yet. Nothing on this page is live." },
        1: { badness: 3, text: "Connection to the backend was closed. Nothing on this page is live until it comes back." },
        2: { badness: 3, text: "Connection to the backend could not be opened. Check that the server runs and that the address is right." }
    }
}

let lastStatusNum = 2


function setStatusPanel(statusNum) {
    lastStatusNum = statusNum

    const known = statusMessages[statusNum]
    const message = known
        ? known.text
        : `Unknown report source ${statusNum}, see commProtocol.txt.`

    if (!known) {
        console.warn(`[FE] Status ${statusNum} is not described anywhere, see commProtocol.txt.`)
    }

    statusNumLabel.textContent = statusNum
    statusMessageLabel.textContent = message
    changeStatus(known ? known.badness : 2)
}

function setErrorPanel(errorNum, statusNum = lastStatusNum) {
    const perStatus = errorMessages[statusNum]
    const known = perStatus ? perStatus[errorNum] : undefined
    const message = known
        ? known.text
        : `Error ${errorNum} from source ${statusNum} is not described anywhere, see commProtocol.txt.`

    if (!known) {
        console.warn(`[FE] Error ${errorNum} at status ${statusNum} has no description, see commProtocol.txt.`)
    }

    errorNumLabel.textContent = errorNum
    errorMessageLabel.textContent = message
    changeError(known ? known.badness : 2)
}


//speeds icons GUI ----------------------------------------------------------------------------------------
class ColorGradiant {
    red;
    green;
    blue;
    differenceRed;
    differenceBlue;
    differenceGreen;
    maxLevel;
    minLevel;

    constructor(red, green, blue, red2, green2, blue2, maxLevel, minLevel) {
        this.red = red
        this.green = green
        this.blue = blue
        this.differenceRed = red2 - red
        this.differenceGreen = green2 - green
        this.differenceBlue = blue2 - blue
        this.maxLevel = maxLevel
        this.minLevel = minLevel
    }

    exportColorOnLevel(level) {
        let exportRed = this.red
        let exportBlue = this.blue
        let exportGreen = this.green

        if (level > this.maxLevel) {
            level = this.maxLevel
        }

        else if (level < this.minLevel) {
            level = this.minLevel
        }

        level = (level - this.minLevel) / (this.maxLevel - this.minLevel)

        exportRed += level * this.differenceRed
        exportGreen += level * this.differenceGreen
        exportBlue += level * this.differenceBlue
        return "#" + this.toHex(exportRed) + this.toHex(exportGreen) + this.toHex(exportBlue)
    }

    toHex(value) {
        return Math.round(value).toString(16).padStart(2, "0")
    }
}


const stepSizeElement = document.querySelector("#stepSize")
const speedSizeElement = document.querySelector("#speedSize")
const spindleSizeElement = document.querySelector("#spindleSize")

const stepSizeIcon = document.querySelector("#stepSizeArrow")
const speedSizeIcon = document.querySelector("#speedSizeArrow")
const spindleSizeIcon = document.querySelector("#spindleSizeArrow")

const stepSizeGradiant = new ColorGradiant(155, 186, 235, 250, 46, 42, 25, 0)
const speedSizeGradiant = new ColorGradiant(53, 173, 2, 252, 49, 30, 175, 1)
const spindleSizeGradiant = new ColorGradiant(155, 186, 235, 250, 46, 42, 20000, 0)


//number inputs normalization ----------------------------------------------------------------------------------------

// Stejna cisla jsou i v HTML u inputu, jenze ta plati jen pro sipky a pro
// validaci formulare. Jakmile uzivatel hodnotu prepise rucne, zustane ve value
// presne tak, jak ji napsal - <input max="175"> klidne vrati 9999 a jen se to
// oznaci jako neplatne. Proto se limity drzi jeste jednou tady.
const numberLimits = {
    stepSize: { min: 0, max: 50, step: 0.1 },
    speedSize: { min: 1, max: 175, step: 1 },
    spindleSize: { min: 0, max: 20000, step: 50 },

    // Obe Z jsou omezene MAX_Z 8 z nanoCode/src/main.cpp. nanoComm ma
    // resumeSafeZ 10, ale to Nano stejne orizne na 8 a posle error 6.
    safeZ: { min: 0, max: 8, step: 0.1 },
    workZ: { min: 0, max: 8, step: 0.05 }
}


// Kolik desetinnych mist ma krok. Bez zaokrouhleni na ne vyjde 0.1 * 14 jako
// 1.4000000000000001 a takove cislo by se poslalo na stroj.
function stepDecimals(step) {
    const text = String(step)
    const dot = text.indexOf(".")

    if (dot === -1) {
        return 0
    }

    return text.length - dot - 1
}


// Hodnota z policka na cislo, ktere uz je bezpecne poslat na stroj: srovnane
// na nejblizsi krok a orezane na min az max. fromWhere je klic do numberLimits,
// tedy "stepSize", "speedSize" nebo "spindleSize".
function returnNormalizeNum(value, fromWhere) {
    const limits = numberLimits[fromWhere]

    if (!limits) {
        console.warn(`[FE] returnNormalizeNum does not know the field "${fromWhere}", the value went through without any check.`)
        return Number(value)
    }

    let number = Number(value)

    // Prazdne policko da Number("") nulu, pismena daji NaN. Oboji spadne na
    // minimum, at se ven nikdy nedostane NaN - to by v kazdem porovnani vyslo false
    // a proslo by i kontrolou pracovniho prostoru.
    if (!Number.isFinite(number)) {
        console.warn(`[FE] ${fromWhere} holds "${value}", which is not a number. Falling back to the minimum ${limits.min}.`)
        number = limits.min
    }

    // Nejdriv na krok, az potom orez. Kdyby maximum na mrizku kroku nesedelo,
    // srovnani na krok by ho po orezu jeste preskocilo.
    const snapped = limits.min + Math.round((number - limits.min) / limits.step) * limits.step
    const clamped = Math.min(Math.max(snapped, limits.min), limits.max)
    const normalized = Number(clamped.toFixed(stepDecimals(limits.step)))

    if (normalized !== number) {
        console.warn(`[FE] ${fromWhere} was normalized from ${value} to ${normalized}, the machine gets the normalized value.`)
    }

    return normalized
}

//-----------------------------------------------------------------------------------------


const gaugeNeedle = document.querySelector("#gauge-needle")
const gaugeCenterX = 85.35
const gaugeCenterY = 157.35


function gaugeAngle(value, min, max) {
    const range = max - min

    if (!(range > 0)) {
        console.warn(`[FE] Gauge has no usable range (min ${min}, max ${max}), needle stays centred.`)
        return 0
    }

    const part = Math.min(1, Math.max(0, (value - min) / range))
    return -90 + 180 * part
}


function operateRuler() {
    stepSizeIcon.style.setProperty("--colorRuler", stepSizeGradiant.exportColorOnLevel(returnNormalizeNum(stepSizeElement.value, "stepSize")))
}


function operateTachometer() {
    const value = returnNormalizeNum(speedSizeElement.value, "speedSize")
    speedSizeIcon.style.setProperty("--colorGauge", speedSizeGradiant.exportColorOnLevel(value))

    const angle = gaugeAngle(value, numberLimits.speedSize.min, numberLimits.speedSize.max)
    gaugeNeedle.setAttribute("transform", `rotate(${angle} ${gaugeCenterX} ${gaugeCenterY})`)
}


function operateSpindleArrow() {
    spindleSizeIcon.style.setProperty("--colorSpindle", spindleSizeGradiant.exportColorOnLevel(returnNormalizeNum(spindleSizeElement.value, "spindleSize")))
}


stepSizeElement.addEventListener("input", operateRuler)
speedSizeElement.addEventListener("input", operateTachometer)
spindleSizeElement.addEventListener("input", operateSpindleArrow)


//speeds stepper arrows ----------------------------------------------------------------------------------------

// Prvni krok padne hned na stisk a opakovani se rozjede az po holdDelay.
// Bez te prodlevy by kazde obycejne kliknuti pridalo rovnou dve hodnoty.
const holdDelay = 400
const holdPeriod = 70

// Cim dele se sipka drzi, tim vic kroku na jedno tiknuti. Bez toho by
// projeti spindlu od 0 do 20000 trvalo pres pul minuty.
const holdRampEvery = 12
const holdMaxMultiplier = 8

const stepArrows = document.querySelectorAll(".stepArrow")

let holdTimer = null
let holdTicks = 0


// stepUp a stepDown si samy hlidaji min, max i step z HTML a na maximu uz dal
// nejdou. Co ale nedelaji, je udalost input, takze bez toho rucniho dispatche
// by se pravitko, tachometr ani sipka spindlu neprekreslily.
function stepInput(input, direction, count) {
    // Rucne napsana hodnota muze byt mimo rozsah a samotne stepUp/stepDown se
    // z ni uz ven nedostanou: nad maximem stepUp neudela nic a pod minimem
    // zase stepDown. Proto se policko nejdriv srovna. id inputu je zaroven
    // klic do numberLimits.
    input.value = returnNormalizeNum(input.value, input.id)

    for (let i = 0; i < count; i++) {
        if (direction === "up") {
            input.stepUp()
        }

        else {
            input.stepDown()
        }
    }

    input.dispatchEvent(new Event("input", { bubbles: true }))
}


function holdMultiplier() {
    return Math.min(holdMaxMultiplier, 1 + Math.floor(holdTicks / holdRampEvery))
}


function startHolding(input, direction) {
    holdTimer = setTimeout(function repeat() {
        holdTicks++
        stepInput(input, direction, holdMultiplier())
        holdTimer = setTimeout(repeat, holdPeriod)
    }, holdDelay)
}


function stopHolding() {
    clearTimeout(holdTimer)
    holdTimer = null
    holdTicks = 0
}


function setUpStepArrow(button) {
    const input = document.querySelector("#" + button.dataset.input)
    const direction = button.dataset.step

    if (!input) {
        console.warn(`[FE] Step arrow points at #${button.dataset.input}, but no such input exists.`)
        return
    }

    if (direction !== "up" && direction !== "down") {
        console.warn(`[FE] Step arrow of #${button.dataset.input} has direction "${direction}", only "up" and "down" are known.`)
        return
    }

    button.addEventListener("pointerdown", event => {
        // Jen leve tlacitko. U praveho vyskoci kontextove menu a pointerup uz
        // nemusi dorazit, takze by sipka zustala viset v opakovani.
        if (event.button !== 0) {
            return
        }

        // Bez toho vybere dlouhy stisk okolni text a na mobilu vyskoci menu.
        event.preventDefault()
        stepInput(input, direction, 1)
        startHolding(input, direction)
    })

    // Enter i mezernik delaji click bez pointeru, takze maji detail 0. Click
    // od mysi se preskoci, ten uz obslouzil pointerdown.
    button.addEventListener("click", event => {
        if (event.detail === 0) {
            stepInput(input, direction, 1)
        }
    })
}


for (const button of stepArrows) {
    setUpStepArrow(button)
}


// Pusteni sipky muze prijit i mimo ni, kdyz uzivatel behem drzeni sjede mysi
// pryc, takze se opakovani zastavuje az na okne.
addEventListener("pointerup", stopHolding)
addEventListener("pointercancel", stopHolding)
addEventListener("blur", stopHolding)


//3D jog model ----------------------------------------------------------------------------------------

const canvas = document.querySelector("#jogModelCanvass")
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });

const scene = new THREE.Scene()

const distance = 240
const camera = new THREE.OrthographicCamera(-distance, distance, distance, -distance, 1, 2000);


const loader = new STLLoader()
const mat = new THREE.MeshLambertMaterial({ color: 0x5472E4 })


const modelPaths = ['./models/', 'staticPart.stl', 'cartY.stl', 'cartX.stl', 'cartZ.stl']
const meshes = []


function loadSTL(path) {
    return new Promise((resolve, reject) => {

        function onLoad(geo) {
            return resolve(geo)
        }

        function onError(error) {
            return reject(error)
        }

        loader.load(
            path,
            onLoad,
            undefined,
            onError
        );
    });
}


async function loadingSequance(paths, meshes) {
    for (let i = 1; i < paths.length; i++) {

        const geo = await loadSTL(paths[0] + paths[i]);

        const mesh = new THREE.Mesh(geo, mat);

        mesh.scale.set(10, 10, 10);

        if (i >= 3) {
            mesh.position.set(-210, 0, 0);
        }

        if (i === 2) {
            mesh.position.y = -45
        }

        mesh.position.z += -160;
        mesh.position.y += -90;

        meshes.push(mesh);

        scene.add(mesh);

        renderer.render(scene, camera);
    }
}


async function canvasStarsSquence() {

    camera.up.set(0, 0, 1);
    camera.position.set(-200, 200, 150)
    camera.lookAt(0, 0, 0)
    renderer.setSize(1920, 1080, false)
    renderer.setClearColor(0x141726)



    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8)
    mainLight.position.set(1, 1, 0.5)
    scene.add(mainLight)

    await loadingSequance(modelPaths, meshes)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const moventQuality = 100
// Hranice pohybu v souradnicich MODELU, ne stroje. Prvni tri jsou poloha
// pri nule stroje, druhe tri pri maximu - odpovida to MAX_X 60, MAX_Y 80
// a MAX_Z 8 z nanoCode/src/main.cpp dosazenym do prepoctu nize.
const MaxesAndMins = [
    -270, -135, -160, -210, -55, -152
]


// Kazda osa jde v modelu jinym smerem, takze se porovnani nepise rucne. from
// je konec, od ktereho se jede, to je konec, za ktery uz se nesmi. Diky tomu
// prezije prehozeni smeru osy ve MaxesAndMins - Y ma ted maximum vetsi nez
// minimum, X a Z mensi - aniz by se tady neco prepisovalo.
function notPast(value, from, to) {
    if (to >= from) {
        return value <= to
    }

    return value >= to
}


function checkMaxes(x, y, z) {
    return notPast(x, MaxesAndMins[0], MaxesAndMins[3])
        && notPast(y, MaxesAndMins[1], MaxesAndMins[4])
        && notPast(z, MaxesAndMins[2], MaxesAndMins[5])
}


function checkMins(x, y, z) {
    return notPast(x, MaxesAndMins[3], MaxesAndMins[0])
        && notPast(y, MaxesAndMins[4], MaxesAndMins[1])
        && notPast(z, MaxesAndMins[5], MaxesAndMins[2])
}


function clampAxis(value, endA, endB) {
    return Math.min(Math.max(value, Math.min(endA, endB)), Math.max(endA, endB))
}


// Orizne souradnice modelu na pracovni prostor.
function clampToWorkArea(x, y, z) {
    return [
        clampAxis(x, MaxesAndMins[0], MaxesAndMins[3]),
        clampAxis(y, MaxesAndMins[1], MaxesAndMins[4]),
        clampAxis(z, MaxesAndMins[2], MaxesAndMins[5])
    ]
}


async function updatePosition(x, y, z, speed) {
    const translatedX = -x - 210
    const translatedY = y - 135
    const translatedZ = z - 160

    // Report ze stroje muze prijit z nehomovaneho stavu nebo o par setin
    // vedle (napr. X 60.04 po homingu na max), takze se cil orizne na
    // pracovni prostor. Model dojede na hranu misto toho, aby se nehnul.
    const [targetX, targetY, targetZ] = clampToWorkArea(translatedX, translatedY, translatedZ)
    const insideArea = checkMins(translatedX, translatedY, translatedZ)
        && checkMaxes(translatedX, translatedY, translatedZ)

    if (!insideArea) {
        console.warn(`[FE] Position X ${x} Y ${y} Z ${z} is outside the work area, the model was clamped to the edge.`)
    }

    if (speed <= 0) {
        meshes[1].position.y = targetY
        meshes[2].position.x = targetX
        meshes[3].position.z = targetZ
        meshes[3].position.x = targetX
    }
    const distanceY = (targetY - meshes[1].position.y)
    const distanceX = (targetX - meshes[2].position.x)
    const distanceZ = (targetZ - meshes[3].position.z)
    const time = ((Math.max(Math.abs(distanceX), Math.abs(distanceY), Math.abs(distanceZ)) / speed) / moventQuality) * 1000
    for (let i = 0; i < moventQuality; i++) {
        meshes[1].position.y += distanceY / moventQuality
        meshes[2].position.x += distanceX / moventQuality
        meshes[3].position.z += distanceZ / moventQuality
        meshes[3].position.x += distanceX / moventQuality
        renderer.render(scene, camera);
        await sleep(time)
    }

    // false znamena "dojel jsem, ale na hranu, ne tam, kam jsi chtel".
    return insideArea
}


async function jogPosition(changeX, changeY, changeZ, speed) {
    // Jog dostava prirustky, ne polohu, takze se orezava az cil - tedy kde
    // model po tom pohybu skonci. Bere se z aktualni polohy mesi, ne z
    // posledniho reportu: jogu muze jit za sebou vic a report chodi az po
    // dokonceni pohybu.
    const wantedX = meshes[2].position.x + changeX
    const wantedY = meshes[1].position.y + changeY
    const wantedZ = meshes[3].position.z + changeZ

    const [targetX, targetY, targetZ] = clampToWorkArea(wantedX, wantedY, wantedZ)
    const insideArea = checkMins(wantedX, wantedY, wantedZ) && checkMaxes(wantedX, wantedY, wantedZ)

    if (!insideArea) {
        console.warn(`[FE] Jog by X ${changeX} Y ${changeY} Z ${changeZ} would leave the work area, the model was clamped to the edge.`)
    }

    // Vzdalenosti se pocitaji az z orezaneho cile, ne z puvodniho prirustku -
    // jinak by se model posunul cely krok a orez by nemel zadny ucinek.
    const distanceX = targetX - meshes[2].position.x
    const distanceY = targetY - meshes[1].position.y
    const distanceZ = targetZ - meshes[3].position.z

    if (speed <= 0) {
        meshes[1].position.y += distanceY
        meshes[2].position.x += distanceX
        meshes[3].position.z += distanceZ
        meshes[3].position.x += distanceX
    }
    const time = ((Math.max(Math.abs(distanceX), Math.abs(distanceY), Math.abs(distanceZ)) / speed) / moventQuality) * 1000
    for (let i = 0; i < moventQuality; i++) {
        meshes[1].position.y += distanceY / moventQuality
        meshes[2].position.x += distanceX / moventQuality
        meshes[3].position.z += distanceZ / moventQuality
        meshes[3].position.x += distanceX / moventQuality
        renderer.render(scene, camera);
        await sleep(time)
    }

    return insideArea
}


await canvasStarsSquence()


//jobList1 -------------------------------------------------------------------------

let ongoingJob = false


const jobsListedElement = document.querySelector("#jobsListed")
const jobSearchElement = document.querySelector("#jobSearch")
const jobUploadElement = document.querySelector("#jobUpload")
const jobUploadNoteElement = document.querySelector("#jobUploadNote")

// Text "Nothings here yet" je v HTML jako holy text. Uklada se hned na
// zacatku, aby se po smazani posledniho jobu mel kam vratit.
const jobsListedEmptyText = jobsListedElement.textContent.trim()


// Hlaska pod tlacitkem nahravani. Prazdny text ji schova.
function showUploadNote(text) {
    jobUploadNoteElement.textContent = text
    jobUploadNoteElement.hidden = !text
}

// Stejne pripony jako hlida backend. Nahrava se jenom gerber, G-kod se
// k nemu vyrobi az pri tisku.
const gerberEndings = [
    ".gbr", ".ger", ".gbrjob",
    ".gtl", ".gbl",
    ".gts", ".gbs",
    ".gto", ".gbo",
    ".gtp", ".gbp",
    ".gm1", ".gko",
    ".drl", ".xln"
]


function fileEnding(name) {
    const dot = name.lastIndexOf(".")
    return dot === -1 ? "" : name.slice(dot).toLowerCase()
}


// Bajty na neco, co jde precist. Soubory jsou radove kB az stovky kB.
function formatSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`
    }

    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} kB`
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}


function sendPrint(subCmd, name) {
    if (webSocket.readyState === 1) {
        webSocket.send(JSON.stringify({
            cmd: 5,
            subCmd: subCmd,
            value: name
        }))
    }
}


// Jeden radek seznamu. Jmeno je klic: druhy upload stejneho souboru prijde
// jako novy cmdBE 1 a ma stary radek prepsat, ne pridat vedle nej.
// Hledani snese jen casti nazvu a nezalezi na poradi: dotaz se rozseka na
// slova a job projde, kdyz jsou v jeho jmenu vsechna, kdekoliv. Prazdny
// dotaz nema zadne slovo, takze projde vsechno.
function jobMatches(name, query) {
    const lower = name.toLowerCase()

    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(part => part)
        .every(part => lower.includes(part))
}


// Schova joby, ktere dotazu neodpovidaji. Ten hledany tim zustane jediny
// videt, takze je rovnou nahore.
function filterJobs() {
    for (const row of jobsListedElement.querySelectorAll(".jobRow")) {
        row.hidden = !jobMatches(row.dataset.name, jobSearchElement.value)
    }
}


jobSearchElement.addEventListener("input", filterJobs)


// Jeden radek seznamu: vlevo jmeno a pod nim tlacitka, vpravo cas, datum
// a velikost. Jmeno je klic - druhy upload stejneho souboru prijde jako novy
// cmdBE 1 a ma stary radek prepsat, ne pridat vedle nej.
//
// Ikony: kazdy .jobRowIcon je prazdny obal, do ktereho patri SVG. Dokud je
// prazdny, CSS ho schova, takze rozlozeni sedi i bez nich.
function loadAddJob(name, date, size, duration) {
    if (!name) {
        console.warn("[FE] A job without a name arrived, it was not added to the list.")
        return
    }

    // Hlaska "Nothings here yet" je v HTML jako holy text, ne jako element,
    // takze se musi smazat pri prvnim jobu.
    if (!jobsListedElement.querySelector(".jobRow")) {
        jobsListedElement.textContent = ""
    }

    const old = jobsListedElement.querySelector(`.jobRow[data-name="${CSS.escape(name)}"]`)

    if (old) {
        old.remove()
    }

    const row = document.createElement("div")
    row.className = "jobRow"
    row.dataset.name = name

    const head = document.createElement("div")
    head.className = "jobRowHead"

    const label = document.createElement("h3")
    label.className = "jobRowName"
    head.append(label)

    const labelIcon = document.createElement("span")
    labelIcon.className = "jobRowNameIcon"
    labelIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-notepad-text preview-icon"><path d="M8 2v4"/><path d="M12 2v4"/><path d="M16 2v4"/><rect width="16" height="18" x="4" y="4" rx="2"/><path d="M8 10h6"/><path d="M8 14h8"/><path d="M8 18h5"/></svg>'
    label.append(labelIcon)

    const labelText = document.createElement("span")
    labelText.className = "jobRowNameText"
    labelText.textContent = name
    label.append(labelText)

    const facts = document.createElement("ul")
    facts.className = "jobRowFacts"
    const printed = Number.isFinite(duration)

    facts.append(
        makeFact("time", printed ? formatDuration(duration) : "—", printed ? "" : "Not printed yet"),
        makeFact("date", new Date(date).toLocaleDateString()),
        makeFact("size", formatSize(size))
    )

    const printButton = document.createElement("button")
    printButton.type = "button"
    printButton.className = "jobRowPrint"
    printButton.append(makeIcon("print"), document.createTextNode("Print"))
    printButton.addEventListener("click", () => {
        sendPrint(1, name)
        print(name)
    })

    const deleteButton = document.createElement("button")
    deleteButton.type = "button"
    deleteButton.className = "jobRowDelete"
    deleteButton.append(makeIcon("delete"), document.createTextNode("Delete"))
    deleteButton.addEventListener("click", () => {
        sendPrint(2, name)
        row.remove()

        if (!jobsListedElement.querySelector(".jobRow")) {
            jobsListedElement.textContent = jobsListedEmptyText
        }
    })

    row.append(head, facts, printButton, deleteButton)
    jobsListedElement.prepend(row)

    // Kdyz zrovna neco hledas, novy job se ma chovat stejne jako ostatni.
    filterJobs()
}


// Ikony do radku seznamu. Sirku, vysku i silu cary jim dava CSS pres
// [class*="lucide"], takze tady zadne width ani stroke-width nejsou - jinak
// by byly jine nez zbytek stranky.
const jobIcons = {
    print: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-printer" aria-hidden="true"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>`,

    delete: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash" aria-hidden="true"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,

    time: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-hourglass" aria-hidden="true"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>`,

    date: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-days" aria-hidden="true"><path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M8 13h.01"/><path d="M12 13h.01"/><path d="M16 13h.01"/><path d="M8 17h.01"/><path d="M12 17h.01"/><path d="M16 17h.01"/></svg>`,

    size: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ruler-dimension-line" aria-hidden="true"><path d="M10 15v-3"/><path d="M14 15v-3"/><path d="M18 15v-3"/><path d="M2 8V4"/><path d="M22 6H2"/><path d="M22 8V4"/><path d="M6 15v-3"/><rect x="2" y="12" width="20" height="8" rx="2"/></svg>`
}


// Misto na ikonu. Klic, ktery v jobIcons neni, necha obal prazdny a CSS ho
// schova - proto se "name" da doplnit pozdeji, aniz by se ted nekde delala
// mezera.
function makeIcon(which) {
    const icon = document.createElement("span")
    icon.className = "jobRowIcon"
    icon.dataset.icon = which
    icon.innerHTML = jobIcons[which] ?? ""
    return icon
}


function makeFact(which, text, hint = "") {
    const item = document.createElement("li")
    item.className = "jobRowFact"

    if (hint) {
        item.title = hint
    }

    item.append(makeIcon(which), document.createTextNode(text))
    return item
}


// Nahrava se pres obycejny multipart POST, ne pres websocket - ten by musel
// soubor posilat po kouscich a multer na druhe strane uz hotovy je.
async function uploadJob(file) {
    if (!file) {
        return
    }

    if (!gerberEndings.includes(fileEnding(file.name))) {
        console.warn(`[FE] ${file.name} is not a gerber, nothing was sent.`)
        showUploadNote(`"${file.name}" is not a gerber file.`)
        return
    }

    const body = new FormData()
    body.append("gerber", file)

    try {
        const answer = await fetch("/uploadGerber", { method: "POST", body: body })
        const text = await answer.json()

        if (!answer.ok) {
            console.warn(`[FE] Upload of ${file.name} was refused: ${text.answer}`)
            showUploadNote(text.answer)
            return
        }

        // Radek do seznamu nepridava tohle, ale zprava cmdBE 1, kterou
        // backend posle po ulozeni - at je seznam stejny pro vsechny,
        // kdo se zrovna divaji.
        console.log(`[FE] ${file.name} uploaded: ${text.answer}`)
        showUploadNote("")
    }

    catch (error) {
        console.warn(`[FE] Upload of ${file.name} did not go through: ${error.message}`)
        showUploadNote(`${file.name} could not be uploaded, the backend did not answer.`)
    }
}


jobUploadElement.addEventListener("change", () => {
    uploadJob(jobUploadElement.files[0])

    // Bez tohohle by vybrani stejneho souboru podruhe neudelalo zadnou
    // udalost change a nahrat by uz nesel.
    jobUploadElement.value = ""
})



//report handlerers -----------------------------------------------------------------


// Poradi bitu je z documentation/commProtocol.txt: front (min) a pak end (max),
// osy X -> Y -> Z. Tabulka je psana podle toho, co je na policku videt, takze
// "X+" je maximum stroje. Id rikaji neco jineho - F jako Front je ve firmwaru
// minimum, tedy "X-" - ale rozhoduje popisek, ten uzivatel cte.
const endstopFields = [
    { element: document.querySelector("#eXB"), bit: 1, name: "X min" },
    { element: document.querySelector("#eXF"), bit: 2, name: "X max" },
    { element: document.querySelector("#eYB"), bit: 4, name: "Y min" },
    { element: document.querySelector("#eYF"), bit: 8, name: "Y max" },
    { element: document.querySelector("#eZB"), bit: 16, name: "Z min" },
    { element: document.querySelector("#eZF"), bit: 32, name: "Z max" }
]


for (const field of endstopFields) {
    if (!field.element) {
        console.warn(`[FE] Endstop field ${field.name} is not in the page, its colour will never change.`)
    }
}


// Maska je latchovana: rika, ktery koncak byl stisknuty kdykoliv behem
// posledniho prikazu, ne ktery je stisknuty ted. -1 nebo cokoliv jineho nez
// cele nezaporne cislo znamena "nevim" - backend to tak posila, dokud ze
// stroje nic nedorazilo. Radsi seda nez ukazovat stary stav jako aktualni.
function handleEndstops(endstops) {
    const unknown = !Number.isInteger(endstops) || endstops < 0

    for (const field of endstopFields) {
        if (!field.element) {
            continue
        }

        field.element.classList.remove("endstopUndecided", "endstopPressed", "endstopRealeased")

        if (unknown) {
            field.element.classList.add("endstopUndecided")
        }

        else if (endstops & field.bit) {
            field.element.classList.add("endstopPressed")
        }

        else {
            field.element.classList.add("endstopRealeased")
        }
    }

    if (unknown) {
        console.warn(`[FE] Endstop mask came as ${endstops}, the machine state is unknown. All fields went grey.`)
        return
    }

    if (endstops !== 0) {
        const pressed = endstopFields.filter(field => endstops & field.bit).map(field => field.name).join(", ")
        console.warn(`[FE] Endstops hit during the last command: ${pressed}. The reported position may not be trustworthy.`)
    }
}


const telemetryX = document.querySelector("#telemetryX")
const telemetryY = document.querySelector("#telemetryY")
const telemetryZ = document.querySelector("#telemetryZ")

const telemetrySpeed = document.querySelector("#telemetrySpeed")
const telemetrySpindleSpeed = document.querySelector("#telemetrySpindle")


//report nehybe modelem ani nedela obrazek na canvasu dole, protoze: bud to dela sam FE, nebo to dela preReportHandle, kdy kdyz se posila zprava pres TCP z nanoComm proparsovaneho cmd z gcodu, tak to posle jak do backendu pres TCP tak do nana pres UART
function handleReport(report) {
    setErrorPanel(report.error)
    setStatusPanel(report.status)
    telemetryX.value = report.x
    telemetryY.value = report.y
    telemetryZ.value = report.z

    telemetrySpeed.value = report.speed
    telemetrySpindleSpeed.value = report.spindlSpeed
    handleEndstops(report.endstops)
}


//tohle hybe
function preReportHandle(report) {
    if (ongoingJob) {
        //kresleni do canvasu, jeste neimplementovane
    }
    updatePosition(report.x, report.y, report.z, report.speed)
}



//response handeler --------------------------


// Cim se backend ozval, na to odpovida. Cisla prikazu jsou z
// documentation/commProtocol.txt, 255 dela totez co 7.
const commandNames = {
    0: "ping",
    1: "move",
    2: "spindle speed",
    3: "homing to the minimum",
    4: "homing to the maximum",
    5: "lift Z and continue the job",
    6: "spindle off",
    7: "end of job",
    8: "relative move",
    12: "no command",
    25: "command could not be parsed",
    255: "end of job"
}


function responseHandle(cmd) {
    const name = commandNames[cmd]

    if (!name) {
        console.warn(`[FE] Backend answered command ${cmd}, which is not in commProtocol.txt.`)
        return
    }

    console.log(`[FE] Backend confirmed: ${name}.`)

    // 25 neni potvrzeni, ale hlaska, ze zprava k Nanu dorazila poskozena.
    if (cmd === 25) {
        console.warn("[FE] The last command did not reach the Nano in one piece, it has to be sent again.")
    }

    // Konec jobu. Prepnout to musi uz potvrzeni, ne az report: stop tlacitko
    // dostane odpoved driv, nez prijde dalsi report ze stroje.
    if (cmd === 7 || cmd === 255) {
        ongoingJob = false
    }
}

//ETA -----------------------------------------------------------------------------


const etaValueElement = document.querySelector("#etaValue")
const jobNameElement = document.querySelector("#jobName")

// Tri casy, ktere jdou poskladat z jednoho cisla od stroje. Vsechny v
// sekundach a syrove - formatuje se az to, co jde na obrazovku.
const jobTimes = {
    finishInSec: -1,
    runningSec: -1,
    etaSec: -1
}

// Kdy job zacal, unixovy cas v sekundach. -1 dokud zadny nebezi.
let jobStartedAtSec = -1


function nowInSec() {
    return Math.floor(Date.now() / 1000)
}


// Sekundy na h:mm:ss, pod hodinu jen m:ss.
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const rest = seconds % 60

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    }

    return `${minutes}:${String(rest).padStart(2, "0")}`
}


// Unixovy cas na hodiny a minuty podle hodin v prohlizeci.
function formatClock(seconds) {
    return new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}


// Ram pro spusteni jobu. Odeslani na backend je tvoje, mereni casu potrebuje
// jen tyhle dva radky - bez nich nema runningSec od ceho pocitat.
function print(name) {
    // Dokud nic nebezelo, je v policku vychozi text z atributu default.
    jobNameElement.textContent = name

    jobStartedAtSec = nowInSec()
    ongoingJob = true
    jobTimes.finishInSec = -1
    jobTimes.runningSec = -1
    jobTimes.etaSec = -1
}


function determineTime(finishInSec) {
    const seconds = Math.round(Number(finishInSec))

    if (!Number.isFinite(seconds) || seconds < 0) {
        console.warn(`[FE] Time estimate came as ${finishInSec}, which is not a usable number of seconds.`)
        return
    }

    jobTimes.finishInSec = seconds
    jobTimes.etaSec = nowInSec() + seconds - jobStartedAtSec

    // Bez zacatku jobu se doba behu nema od ceho odvodit, takze zustane -1
    // misto toho, aby se pocitala od nuly unixoveho casu.
    jobTimes.runningSec = jobStartedAtSec < 0 ? -1 : nowInSec() - jobStartedAtSec

    etaValueElement.textContent = formatClock(jobTimes.etaSec)
    console.log(`[FE] Job should finish at ${formatClock(jobTimes.etaSec)}, that is in ${formatDuration(seconds)}. Running for ${jobTimes.runningSec < 0 ? "unknown time" : formatDuration(jobTimes.runningSec)}.`)
}



//web socket ----------------------------------------------------------------------

function evaluateMessage(messageData) {
    if (messageData.cmdBE === 1) {
        if (!messageData.job) {
            console.log("[FE] Invalid job load")
            return
        }

        loadAddJob(messageData.job.name, messageData.job.date, messageData.job.size, messageData.job.duration)
    }

    else if (messageData.cmdBE === 2) {

        if (!messageData.nanoReport) {
            console.log("[FE] Invalid report")
            return
        }

        handleReport(messageData.nanoReport)
    }

    else if (messageData.cmdBE === 3) {

        if (!messageData.nanoReport) {
            console.log("[FE] Invalid prereport")
            return
        }

        preReportHandle(messageData.nanoReport)
    }

    else if (messageData.cmdBE === 4) {
        if (!messageData.subCMD) {
            console.log("[FE] Invalid message response")
            return
        }
        
        responseHandle(messageData.subCMD)
    }

    else if (messageData.cmdBE === 5) {
        if (!messageData.nanoReport) {
            console.log("[FE] Invalid message response")
            return
        }
        
        determineTime(messageData.nanoReport.z)
    }
}


const connectedURL = '192.168.0.103:3300'
const webSocket = new WebSocket(connectedURL)


// Status 3 si hlasi frontend sam za sebe. Zadny report neprisel a ani neprijde,
// takze cisla na strance jsou od tehle chvile posledni znamy stav, ne aktualni
// - proto jdou koncaky rovnou do sedive.
function showBackendDisconnected(errorNum) {
    setStatusPanel(3)
    setErrorPanel(errorNum, 3)
    handleEndstops(-1)
}


// Nez se spojeni navaze, neni pripojene. Rovnou to tak napsat je poctivejsi
// nez nechat panely na vychozim "nevim" z HTML.
showBackendDisconnected(0)


// Rozlisuje "spadlo to" od "nikdy se to nechytlo". Tomu druhemu se da poradit
// adresou v connectedURL, tomu prvnimu ne.
let backendWasConnected = false


webSocket.onopen = () => {
    backendWasConnected = true
    // Backend uz slysi, ale ze stroje jeste nic neprislo - to je presne to,
    // co znamena status 2 s errorem 0.
    setStatusPanel(2)
    setErrorPanel(0, 2)
}


// onerror panely neprepisuje. Po nem vzdycky prijde jeste onclose a ten by
// hlasku stejne prepsal - takhle zustane viset ta spravna.
webSocket.onerror = () => {
    console.warn(`[FE] WebSocket to ${connectedURL} reported an error.`)
}


webSocket.onclose = (e) => {
    showBackendDisconnected(backendWasConnected ? 1 : 2)
    backendWasConnected = false
}


// e.data je retezec, ne objekt. Bez tohohle parsovani je messageData.cmdBE
// vzdycky undefined a zprava tise propadne vsemi vetvemi evaluateMessage.
webSocket.onmessage = (e) => {
    let messageData

    try {
        messageData = JSON.parse(e.data)
    }

    catch {
        console.warn("[FE] Backend sent something that is not JSON, it was dropped.")
        return
    }

    evaluateMessage(messageData)
}



function sendJog(subCmd) {
    if (webSocket.readyState === 1) {
        webSocket.send(JSON.stringify({
            cmd: 1,
            subCmd: subCmd,
            value: returnNormalizeNum(speedSizeElement.value, "speedSize"),
            value2: returnNormalizeNum(spindleSizeElement.value, "spindleSize"),
            value3: returnNormalizeNum(stepSizeElement.value, "stepSize")
        }))
    }
}



function sendHome() {
    if (webSocket.readyState === 1) {
        webSocket.send(JSON.stringify({
            cmd: 2
        }))
    }
}


function sendJob(subCmd) {
    if (webSocket.readyState === 1) {
        webSocket.send(JSON.stringify({
            cmd: 3,
            subCmd: subCmd,
        }))
    }
}


function sendSettingss(subCmd, value) {
    if (webSocket.readyState === 1) {
        webSocket.send(JSON.stringify({
            cmd: 4,
            subCmd: subCmd,
            value: value
        }))
    }
}


//jog buttons consts ----------------------------------------------------------------------------------------

const Xup = document.querySelector("#XUp")
const Xdown = document.querySelector("#XDown")

const Yup = document.querySelector("#YUp")
const Ydown = document.querySelector("#YDown")

const Zup = document.querySelector("#ZUp")
const Zdown = document.querySelector("#ZDown")

const homeMax = document.querySelector("#HomeMax")


Xup.addEventListener("click", () => {
    sendJog(1)
    jogPosition(-returnNormalizeNum(stepSizeElement.value, "stepSize"), 0, 0, returnNormalizeNum(speedSizeElement.value, "speedSize"))
    sleep(100)
})


Xdown.addEventListener("click", () => {
    sendJog(4)
    jogPosition(returnNormalizeNum(stepSizeElement.value, "stepSize"), 0, 0, returnNormalizeNum(speedSizeElement.value, "speedSize"))
    sleep(100)
})


Yup.addEventListener("click", () => {
    sendJog(2)
    jogPosition(0, returnNormalizeNum(stepSizeElement.value, "stepSize"), 0, returnNormalizeNum(speedSizeElement.value, "speedSize"))
    sleep(100)
})


Ydown.addEventListener("click", () => {
    sendJog(5)
    jogPosition(0, -returnNormalizeNum(stepSizeElement.value, "stepSize"), 0, returnNormalizeNum(speedSizeElement.value, "speedSize"))
    sleep(100)
})


Zup.addEventListener("click", () => {
    sendJog(3)
    jogPosition(0, 0, returnNormalizeNum(stepSizeElement.value, "stepSize"), returnNormalizeNum(speedSizeElement.value, "speedSize"))
    sleep(100)
})


Zdown.addEventListener("click", () => {
    sendJog(6)
    jogPosition(0, 0, -returnNormalizeNum(stepSizeElement.value, "stepSize"), returnNormalizeNum(speedSizeElement.value, "speedSize"))
    sleep(100)
})


homeMax.addEventListener("click", () => {
    sendHome()
    updatePosition(60, 80, 10, 80)
    sleep(100)
})


//job buttons -----------------------------------------------------


const pauseOrContinueButton = document.querySelector("#pauseOrContinueButton")
const stopButton = document.querySelector("#stopButton")

stopButton.addEventListener("click", () => {
    sendJob(1)
})


pauseOrContinueButton.addEventListener("click", () => {
    if (ongoingJob) {
        sendJob(2)
    }

    else if (!ongoingJob) {
        sendJob(3)
    }
})


//nav buttons ----------------------------------------------------------------------------------------

const jobListToggle = document.querySelector("#jobListToggle")
const settingsButton = document.querySelector("#settings")
const settingsDialog = document.querySelector("#settingsDialog")

// Stejna hranice jako v CSS. Na uzke obrazovce prekryva seznam celou stranku,
// takze zacina zavreny; na siroke je to sloupec vedle a muze byt videt hned.
const narrowScreen = matchMedia("(max-width: 800px)")


// Stav drzi atribut na body, protoze zbytek uz je napsany v CSS:
// body[data-joblist="closed"] seznam schova, na mobilu naopak "open" schova
// main. Nastavuje se vzdycky, at neexistuje stav "atribut chybi".
function setJobList(open) {
    document.body.dataset.joblist = open ? "open" : "closed"
    jobListToggle.setAttribute("aria-expanded", String(open))
}


setJobList(!narrowScreen.matches)


jobListToggle.addEventListener("click", () => {
    setJobList(document.body.dataset.joblist !== "open")
})


settingsButton.addEventListener("click", () => {
    settingsDialog.showModal()
})


//machine settings ----------------------------------------------------------------------------------------

const safeZElement = document.querySelector("#safeZ")
const workZElement = document.querySelector("#workZ")

// Posledni odeslane hodnoty. Zacinaji na tom, co je v policku, takze dokud
// uzivatel nic nezmeni, neodejde nic - stroj si ma nechat svoje.
const sentSettings = {
    safeZ: returnNormalizeNum(safeZElement.value, "safeZ"),
    workZ: returnNormalizeNum(workZElement.value, "workZ")
}


// subCmd je z documentation/FE-BE-protocol.txt: 1 = safe Z, 2 = Z work.
function sendSetting(element, subCmd, fromWhere) {
    const value = returnNormalizeNum(element.value, fromWhere)
    element.value = value

    if (sentSettings[fromWhere] === value) {
        return
    }

    sentSettings[fromWhere] = value
    sendSettingss(subCmd, value)
    console.log(`[FE] Setting ${fromWhere} sent to the machine as ${value}.`)
}


// change, ne input: pri psani "1.1" by jinak odesla jeste mezihodnota 1.
safeZElement.addEventListener("change", () => sendSetting(safeZElement, 1, "safeZ"))
workZElement.addEventListener("change", () => sendSetting(workZElement, 2, "workZ"))


// Sipky hodnotu meni bez udalosti change, a posilat po kazdem tiknuti pri
// drzeni by zaplavilo socket. Proto se pri zavreni popupu jeste jednou
// zkontroluje, jestli neco nezustalo neodeslane.
settingsDialog.addEventListener("close", () => {
    sendSetting(safeZElement, 1, "safeZ")
    sendSetting(workZElement, 2, "workZ")
})
