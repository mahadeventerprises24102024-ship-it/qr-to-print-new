"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const { checkR2Connectivity }=require("../r2-connectivity");

const env={
  ENABLE_TEST_UPLOADS:"true", ENABLE_GUEST_TEST_UPLOADS:"true",
  FILE_STORAGE_ENDPOINT:"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
  FILE_STORAGE_BUCKET:"test-bucket",
  FILE_STORAGE_ACCESS_KEY_ID:"not-real-access-key",
  FILE_STORAGE_SECRET_ACCESS_KEY:"not-real-secret"
};

test("does not touch R2 if sample storage configuration is absent",async()=>{
  const result=await checkR2Connectivity({}, {client:{send:()=>{throw Error("must not call storage")}}});
  assert.equal(result.configured,false);
  assert.equal(result.connectionVerified,false);
  assert.equal(result.error.code,"storage_not_configured");
});

test("checks write/read/delete using a synthetic object and redacts all secrets",async()=>{
  const calls=[];
  const mock={send:async cmd=>{
    calls.push(cmd.constructor.name);
    if(cmd.constructor.name==="PutObjectCommand"){
      assert.equal(cmd.input.Bucket,env.FILE_STORAGE_BUCKET);
      assert.match(cmd.input.Key,/^test-uploads\/connectivity-check\/[a-f0-9-]+\.txt$/);
      assert.equal(cmd.input.ContentType,"text/plain");
      return {};
    }
    if(cmd.constructor.name==="GetObjectCommand"){
      return {Body:{transformToByteArray:async()=>Buffer.from("QR-To-Print sample storage connectivity check")}};
    }
    if(cmd.constructor.name==="DeleteObjectCommand")return {};
    throw Error("unexpected command");
  }};
  const result=await checkR2Connectivity(env,{client:mock});
  assert.equal(result.connectionVerified,true);
  assert.equal(result.guestSampleUploadsEnabled,true);
  assert.deepEqual(calls,["PutObjectCommand","GetObjectCommand","DeleteObjectCommand"]);
  const text=JSON.stringify(result);
  assert.equal(text.includes(env.FILE_STORAGE_SECRET_ACCESS_KEY),false);
  assert.equal(text.includes(env.FILE_STORAGE_ACCESS_KEY_ID),false);
  assert.equal(text.includes(env.FILE_STORAGE_BUCKET),false);
});

test("failed R2 read still triggers cleanup and does not claim verified",async()=>{
  const calls=[];
  const mock={send:async cmd=>{
    calls.push(cmd.constructor.name);
    if(cmd.constructor.name==="GetObjectCommand"){
      const e=new Error("No permission");
      e.name="AccessDenied";
      e.$metadata={httpStatusCode:403};
      throw e;
    }
    return {};
  }};
  const result=await checkR2Connectivity(env,{client:mock});
  assert.equal(result.writeOk,true);
  assert.equal(result.readOk,false);
  assert.equal(result.deleteOk,true);
  assert.equal(result.connectionVerified,false);
  assert.equal(result.error.code,"AccessDenied");
  assert.equal(result.error.httpStatus,403);
  assert.deepEqual(calls,["PutObjectCommand","GetObjectCommand","DeleteObjectCommand"]);
});
