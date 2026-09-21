import { createHmac } from "node:crypto";
import type { GitBackupOssConfig } from "./gitBackup.js";

function buildOssEndpoint(region: string): string {
  return `https://${region}.aliyuncs.com`;
}

function getDateString(): string {
  return new Date().toUTCString();
}

function signRequest(
  method: string,
  path: string,
  date: string,
  contentType: string,
  accessKeySecret: string,
): string {
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${path}`;
  return createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
}

export interface OssUploadResult {
  ok: boolean;
  statusCode: number;
  objectKey: string;
  error?: string;
}

export async function uploadToOss(
  config: GitBackupOssConfig,
  objectKey: string,
  data: Buffer,
  contentType = "application/octet-stream",
): Promise<OssUploadResult> {
  const endpoint = buildOssEndpoint(config.region);
  const fullPath = `/${config.bucket}/${objectKey}`;
  const url = `${endpoint}/${objectKey}`;
  const date = getDateString();

  const signature = signRequest("PUT", fullPath, date, contentType, config.accessKeySecret);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      Date: date,
      Authorization: `OSS ${config.accessKeyId}:${signature}`,
      Host: `${config.bucket}.${config.region}.aliyuncs.com`,
    },
    body: data,
  });

  if (response.ok) {
    return { ok: true, statusCode: response.status, objectKey };
  }

  const errorText = await response.text().catch(() => "unknown error");
  return { ok: false, statusCode: response.status, objectKey, error: errorText };
}

export async function testOssConnection(config: GitBackupOssConfig): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const testKey = `${config.pathPrefix ?? ""}/.zcode-backup-test`;
    const result = await uploadToOss(config, testKey, Buffer.from("connectivity-test"), "text/plain");
    return { ok: result.ok, error: result.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
