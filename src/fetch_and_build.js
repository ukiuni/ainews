// Minimal fetch-and-build script (placeholder)
const fs = require('fs');
const path = require('path');
const itemsPath = path.join(__dirname,'..','data','items.json');
fs.mkdirSync(path.join(__dirname,'..','data'),{recursive:true});
fs.writeFileSync(itemsPath, JSON.stringify([],null,2));
console.log('init items.json');
