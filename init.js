const fs = require("fs")
const path = require("path")
const generateKey = require("./src/scripts/keygen.js")

const adminKey = generateKey()
process.env.adminKey = adminKey
console.log(`Use this key to become admin: ${adminKey}`)

const scriptsDir = path.join(__dirname, "./src/routines");

const scriptFiles = fs.readdirSync(scriptsDir).filter(f => f.endsWith(".js"));

for (const file of scriptFiles) {
    require(path.join(scriptsDir, file))
}