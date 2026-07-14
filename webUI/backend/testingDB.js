
const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("../database/gcodes.db");

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS gcodeList (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            date INTEGER NOT NULL,
            gsize INTEGER NOT NULL
        )
    `);

    console.log("DB inicializována");
});

db.close();