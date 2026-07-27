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

const gcodeStorage = multer.diskStorage({
    destination: "../gcodes",
    filename: (req, file, cb) => {
        currentGcodeName = file.originalname
        cb(null, file.originalname);
    }
})


const gcodeUpload = multer({storage: gcodeStorage})


let currentReport = {
    status: 2,
    error: 0,
    x: -1,
    y: -1,
    z: -1,
    speed: -1,
    spindlSpeed: -1
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

        } catch {
            console.log('[JS] Sent message from C++ is not a JSON')
            currentReport.status = 2
            currentReport.error = 33
        }
        return
    }

    else {
        console.log('[JS] Sent message from C++ did not contain correct starting symbol')
        currentReport.status = 2
        currentReport.error = 34
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


app.post("/currentPrinterInfo", async (req, res) => {
    res.json(currentReport)
})


app.get("/gcodeListUpload", (req, res) => {
    db.all(`SELECT name, date, gsize FROM gcodeList`, [], (err, rows) => {
        if (err) {
            console.error("[JS DB] Error when loading DB:", err);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});


app.post("/uploadGcode", gcodeUpload.single("gcode"), async (req, res) => {
    console.log(`[JS] Gcode: ${currentGcodeName}, was uploaded`)
    res.json({
        answer: "Gcode upload was succefull"
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
app.post("/printGcode", async (req, res) => {
    if (req.body.aprove === 1) {
        const name = req.body.gcodeName
        console.log("[JS] Frontend made a gcode print request named: " + name)
        sendCMD({
            cmd: 3,
            path: `../../gcodes/${name}`
        })
        res.json({
            answer: "Print comming ahead"
        }) 
    }

    else {
        console.log("[JS] Frontend made wrong gcode print request")
        res.json({
            answer: "Wrong gcode print request json"
        })
    }
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
        fs.unlink(`../gcodes/${name}`, (err) => {
        if (err) {
            console.error(err)
            return
        }

        console.log("[JS] gcode file deleted")
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
                speed: -1,
                spindleSpeed: -1
            })
        }
        else if (req.body.cmd === "y") {
            sendCMD({
                cmd: 1,
                x: -1,
                y: req.body.size,
                z: -1,
                speed: -1,
                spindleSpeed: -1
            })
        }
        else if (req.body.cmd === "z") {
            sendCMD({
                cmd: 1,
                x: -1,
                y: -1,
                z: req.body.size,
                speed: -1,
                spindleSpeed: -1
            })
        }
        else if (req.body.cmd === "speed") {
            sendCMD({
                cmd: 1,
                x: -1,
                y: -1,
                z: -1,
                speed: req.body.size,
                spindleSpeed: -1
            })
        }
        else if (req.body.cmd === "spindleSpeed") {
            sendCMD({
                cmd: 1,
                x: -1,
                y: -1,
                z: -1,
                speed: -1,
                spindleSpeed: req.body.size
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
