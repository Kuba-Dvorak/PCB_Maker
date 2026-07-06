import fs from "fs/promises"
import { Interface } from "readline";
import path from "path";



const express = require("express");
const cors = require("cors");
const app = express();

//finalni lokace se vzdy ziska stylem: queue + inicialized, pro rychlou zmenu pozice backendu nebo jinou zmenu, tak aby stacilo zmenit queue
const taskQueue = {
    queue: "../taskQueue",
    inicialized: "/inicilized",
    answer: "/answered",
    emergency: "/emergency"
}


app.use(cors());
app.use(express.json());

let currentReportID = 0
let currentReport = {
    status: "Not connected",
    error: "None",
    x: -1,
    y: -1,
    z: -1,
    speed: -1
}


async function createTask(task) {
    const fileName = `${task.id}.json`;
    const tmpPath = path.join(path.join(taskQueue.queue, taskQueue.inicialized), `task${task.id}.tmp`);
    const finalPath = path.join(path.join(taskQueue.queue, taskQueue.inicialized), fileName);

    const jsonText = JSON.stringify(task, null, 2);

    await fs.writeFile(tmpPath, jsonText, "utf8");
    await fs.rename(tmpPath, finalPath);
}


async function createEmergency(task) {
    const fileName = `${task.id}.json`;
    const tmpPath = path.join(path.join(taskQueue.queue, taskQueue.emergency), `emergency${task.id}.tmp`);
    const finalPath = path.join(path.join(taskQueue.queue, taskQueue.emergency), fileName);

    const jsonText = JSON.stringify(task, null, 2);

    await fs.writeFile(tmpPath, jsonText, "utf8");
    await fs.rename(tmpPath, finalPath);
}


async function readReport(currentID) {
    const pathToReport = path.join(path.join(taskQueue.queue, taskQueue.answer), `report${currentID}.json`)
    if (fs.existsSync(pathToReport)) {
        const text = await fs.readFile(pathToReport, "utf8");
        fs.unlink(pathToReport)
        return JSON.parse(text);
    } 

    else {
        return null;
    }
}


function sendMistake(code, returnMessage, res) {
    res.status(code).json({
      message: returnMessage
    })
}


app.post("/currentPrinterInfo", async (req, res) => {

    const curReport = await readReport(currentReportID)
    if (curReport !== null) {
        currentReportID += 1;
        currentReport = curReport
    }
    res.json(currentReport)
})


app.post("/uploadGcode", async (req, res) => {

})


app.post("/printGcode", async (req, res) => {

})


app.post("/operate", async (req, res) => {

})


app.post("/home", async (req, res) => {

})


app.post("/emergency", async (req, res) => {
    
})




app.listen(3300, () => {
  console.log("Backend bezi na http://localhost:3300");
});
