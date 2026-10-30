"use strict";

// A synthetic, non-customer R2 check. No real document is used, and no R2
// credentials, bucket names, object contents or object keys are logged.
const { randomUUID } = require("node:crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
  require("@aws-sdk/client-s3");
const { storageSettings, guestTestUploadsEnabled } = require("./private-test-uploads");

function errorCode(error) {
  const name = typeof error?.name === "string" ? error.name : "unknown_error";
  const status = Number(error?.$metadata?.httpStatusCode) || null;
  return { code: name.slice(0, 64), httpStatus: status };
}

async function checkR2Connectivity(env=process.env, dependencies={}) {
  const cfg=storageSettings(env);
  const result={
    configured:cfg.enabled,
    guestSampleUploadsEnabled:guestTestUploadsEnabled(env),
    writeOk:false,readOk:false,deleteOk:false,
    connectionVerified:false, error:null
  };
  if(!cfg.enabled) {
    result.error={code:"storage_not_configured",httpStatus:null};
    return result;
  }

  const s3=dependencies.client||new S3Client({
    endpoint:cfg.endpoint,
    region:"auto",forcePathStyle:true,
    requestChecksumCalculation:"WHEN_REQUIRED",
    credentials:{
      accessKeyId:cfg.accessKeyId,
      secretAccessKey:cfg.secretAccessKey
    }
  });
  const key="test-uploads/connectivity-check/"+randomUUID()+".txt";
  const body=Buffer.from("QR-To-Print sample storage connectivity check");
  const send=(cmd)=>s3.send(cmd,{abortSignal:AbortSignal.timeout(12000)});
  try {
    await send(new PutObjectCommand({
      Bucket:cfg.bucket,Key:key,Body:body,ContentType:"text/plain"
    }));
    result.writeOk=true;
    const object=await send(new GetObjectCommand({Bucket:cfg.bucket,Key:key}));
    const bytes=Buffer.from(await object.Body.transformToByteArray());
    if(!bytes.equals(body)) throw Object.assign(new Error("Test data mismatch"),{name:"IntegrityCheckFailed"});
    result.readOk=true;
  }catch(error){
    result.error=errorCode(error);
  }finally{
    // Even if reading fails, attempt removal after an attempted write. Deletion
    // failures are reported rather than pretending the object is gone.
    try{
      await send(new DeleteObjectCommand({Bucket:cfg.bucket,Key:key}));
      result.deleteOk=true;
    }catch(error){
      if(!result.error)result.error=errorCode(error);
    }
  }
  result.connectionVerified=result.writeOk&&result.readOk&&result.deleteOk;
  return result;
}

module.exports={checkR2Connectivity};
