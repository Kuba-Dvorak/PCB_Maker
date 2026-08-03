
const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("../database/gcodes.db");

db.serialize(() => {
    db.exec(`
        ALTER TABLE gcodeList ADD COLUMN printed INTEGER
    `);

    console.log("DB inicializována");
});

db.close();