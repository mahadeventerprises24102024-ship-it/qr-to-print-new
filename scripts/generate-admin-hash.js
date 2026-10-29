"use strict";
// Run locally after npm install: node scripts/generate-admin-hash.js
// Never pass the password as a command-line argument or commit the output.
const bcrypt = require("bcryptjs");
const input=process.stdin;
const output=process.stdout;
if(!input.isTTY || typeof input.setRawMode!=="function"){
  console.error("Run this in an interactive terminal (PowerShell or Command Prompt).");
  process.exit(1);
}
output.write("Enter new Super Admin password (hidden, minimum 12 characters): ");
let password="";
input.setRawMode(true);
input.resume();
input.setEncoding("utf8");
function exit(code){
  input.setRawMode(false);input.pause();output.write("\n");
  process.exit(code);
}
input.on("data",async(chunk)=>{
  for(const c of chunk){
    if(c==="\u0003"){password="";exit(130);}
    if(c==="\b"||c==="\u007f"){password=password.slice(0,-1);continue;}
    if(c==="\r"||c==="\n"){
      input.setRawMode(false);input.pause();output.write("\n");
      if(password.length<12 || Buffer.byteLength(password,"utf8")>72){
        console.error("Password must be at least 12 characters, up to 72 UTF-8 bytes.");
        password="";process.exitCode=1;return;
      }
      const hash=await bcrypt.hash(password,12);
      password="";
      output.write("Paste ONLY this hash into Render PLATFORM_ADMIN_PASSWORD_HASH:\n"+hash+"\n");
      output.write("Do not share the hash or password in screenshots or chat.\n");
      return;
    }
    if(c>=" "&&password.length<100)password+=c;
  }
});
