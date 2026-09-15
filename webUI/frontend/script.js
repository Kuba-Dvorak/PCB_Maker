import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';


//background
const main = document.querySelector('main')
//main.style.backgroundImage = "url('./backgrounds-default/ComplexGraph.png')"



//error graphical conversions
const statusPage = document.querySelector("#statusPage")
const errorPage = document.querySelector("#errorPage")


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


//speeds icons GUI
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
    stepSizeIcon.style.setProperty("--colorRuler", stepSizeGradiant.exportColorOnLevel(Number(stepSizeElement.value)))
}


function operateTachometer() {
    const value = Number(speedSizeElement.value)
    speedSizeIcon.style.setProperty("--colorGauge", speedSizeGradiant.exportColorOnLevel(value))

    const angle = gaugeAngle(value, Number(speedSizeElement.min), Number(speedSizeElement.max))
    gaugeNeedle.setAttribute("transform", `rotate(${angle} ${gaugeCenterX} ${gaugeCenterY})`)
}


function operateSpindleArrow() {
    spindleSizeIcon.style.setProperty("--colorSpindle", spindleSizeGradiant.exportColorOnLevel(Number(spindleSizeElement.value)))
}


stepSizeElement.addEventListener("input", operateRuler)
speedSizeElement.addEventListener("input", operateTachometer)
spindleSizeElement.addEventListener("input", operateSpindleArrow)


//3D jog model

const canvas = document.querySelector("#jogModelCanvass")
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });

const scene = new THREE.Scene()

const distance = 240
const camera = new THREE.OrthographicCamera(-distance, distance, distance, -distance, 1, 2000);

const views = {
    isometric: [-400, 400, 300],
    up: [0, 0, 400],
    left: [500, 0, 0]
}

camera.up.set(0, 0, 1);
camera.position.set(-200, 200, 150)
camera.lookAt(0, 0, 0)
renderer.setSize(1920, 1080, false)
renderer.setClearColor(0x141726)



scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const mainLight = new THREE.DirectionalLight(0xffffff, 0.8)
mainLight.position.set(1, 1, 0.5)
scene.add(mainLight)


const loader = new STLLoader()
const mat = new THREE.MeshLambertMaterial({ color: 0x5472E4 })


const modelPaths = ['./models/', 'staticPart.stl', 'cartY.stl', 'cartX.stl', 'cartZ.stl']
const meshes = []


function loadSTL(path) {
    return new Promise((resolve, reject) => {
        loader.load(
            path,
            geo => resolve(geo),
            undefined,
            error => reject(error)
        );
    });
}


async function loadingSequance(paths, meshes) {
    for (let i = 1; i < paths.length; i++) {

        const geo = await loadSTL(paths[0] + paths[i]);

        const mesh = new THREE.Mesh(geo, mat);

        mesh.scale.set(10, 10, 10);

        if (i >= 3) {
            mesh.position.set(-240, 0, 0);
        }

        mesh.position.z = -120;
        mesh.position.y = -90;

        meshes.push(mesh);

        scene.add(mesh);

        renderer.render(scene, camera);
    }
}


await loadingSequance(modelPaths, meshes)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const moventQuality = 100


async function updatePosition(x, y, z, speed) {
    const translatedX = -x - 240
    const translatedY = -y - 90
    const translatedZ = -z - 120
    const distanceY = (translatedY - meshes[1].position.y)
    const distanceX = (translatedX - meshes[2].position.x)
    const distanceZ = (translatedZ - meshes[3].position.z)
    const time = (Math.max(Math.abs(distanceX), Math.abs(distanceY), Math.abs(distanceZ)) / speed) / moventQuality
    for (let i = 0; i < moventQuality; i++) {
        meshes[1].position.y += distanceY / moventQuality
        meshes[2].position.x += distanceX / moventQuality
        meshes[3].position.z += distanceZ / moventQuality
        meshes[3].position.x += distanceX / moventQuality
        renderer.render(scene, camera);
        await sleep(time)
    }
}



await updatePosition(1, -40, 10, 1)