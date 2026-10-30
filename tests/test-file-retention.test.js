"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {purgeExpiredTestFiles}=require("../private-test-uploads");

const env={
  ENABLE_TEST_UPLOADS:"true",
  FILE_STORAGE_ENDPOINT:"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
  FILE_STORAGE_BUCKET:"private-test-files",
  FILE_STORAGE_ACCESS_KEY_ID:"test-key",
  FILE_STORAGE_SECRET_ACCESS_KEY:"test-secret"
};

test("no test retention cleanup runs without confirmed private storage config",async()=>{
  let queryCalled=false;
  const result=await purgeExpiredTestFiles({
    query:async()=>{queryCalled=true;return {rows:[]};}
  },{},{client:{send:async()=>{throw Error("must never call R2");}}});
  assert.deepEqual(result,{storageEnabled:false,purged:0,failed:0});
  assert.equal(queryCalled,false);
});

test("sample objects older than 24 hours are deleted from R2 while audit rows remain",async()=>{
  const commands=[],queries=[];
  const mockClient={send:async command=>{
    commands.push(command);
    assert.equal(command.constructor.name,"DeleteObjectCommand");
    assert.equal(command.input.Bucket,env.FILE_STORAGE_BUCKET);
    assert.ok(command.input.Key.startsWith("test-uploads/"));
    return {};
  }};
  const pool={query:async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes("SELECT id,storage_key"))return {rows:[
      {id:8,storage_key:"test-uploads/1/old.pdf"},
      {id:9,storage_key:"test-uploads/1/older.png"}
    ]};
    assert.match(sql,/SET file_deleted_at=NOW\(\)/);
    assert.match(sql,/file_deleted_at IS NULL/);
    assert.match(sql,/created_at < NOW\(\) - INTERVAL '24 hours'/);
    return {rowCount:1};
  }};
  const result=await purgeExpiredTestFiles(pool,env,{client:mockClient});
  assert.deepEqual(result,{storageEnabled:true,purged:2,failed:0});
  assert.equal(commands.length,2);
  assert.equal(queries.length,3);
  assert.deepEqual(queries[1].args,[8,"test-uploads/1/old.pdf"]);
  assert.deepEqual(queries[2].args,[9,"test-uploads/1/older.png"]);
  assert.doesNotMatch(queries.map(q=>q.sql).join(" " ),/DELETE FROM test_file_orders/);
});

test("a failed deletion cannot be marked deleted and remaining files are retried",async()=>{
  const records=[{id:6,storage_key:"test-uploads/1/a.pdf"},{id:7,storage_key:"test-uploads/1/b.png"}];
  const updates=[];
  const pool={query:async(sql,args)=>{
    if(sql.includes("SELECT"))return {rows:records};
    updates.push(args);
    return {rowCount:1};
  }};
  const realError=console.error;
  console.error=()=>{};
  try{
    const result=await purgeExpiredTestFiles(pool,env,{client:{send:async command=>{
      if(command.input.Key.endsWith("/a.pdf"))throw Error("Temporary R2 outage");
    }}});
    assert.deepEqual(result,{storageEnabled:true,purged:1,failed:1});
    assert.deepEqual(updates,[[7,"test-uploads/1/b.png"]]);
  }finally{
    console.error=realError;
  }
});

test("read/download endpoint excludes expired or deleted test files",()=>{
  const js=fs.readFileSync(path.join(__dirname,"..","private-test-uploads.js"),"utf8");
  const server=fs.readFileSync(path.join(__dirname,"..","server.js"),"utf8");
  assert.match(js,/ADD COLUMN IF NOT EXISTS file_deleted_at TIMESTAMPTZ/);
  assert.match(js,/AND o\.file_deleted_at IS NULL/);
  assert.match(server,/setInterval\(cleanupExpiredSampleFiles,15\*60\*1000\)\.unref\(\)/);
  assert.match(server,/setTimeout\(cleanupExpiredSampleFiles,5000\)\.unref\(\)/);
});
