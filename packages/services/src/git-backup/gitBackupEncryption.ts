import { randomBytes, createCipheriv, publicEncrypt, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { constants } from "node:crypto";

const KEY_DIR_NAME = "git-backup-keys";

function getKeyDir(dataDir: string): string {
  return join(dataDir, KEY_DIR_NAME);
}

export interface EncryptionKeyPair {
  publicKey: string;
  privateKey: string;
}

export async function ensureKeyPair(dataDir: string): Promise<EncryptionKeyPair> {
  const keyDir = getKeyDir(dataDir);
  const pubPath = join(keyDir, "backup.pub");
  const privPath = join(keyDir, "backup.pem");

  if (existsSync(pubPath) && existsSync(privPath)) {
    const [publicKey, privateKey] = await Promise.all([
      readFile(pubPath, "utf-8"),
      readFile(privPath, "utf-8"),
    ]);
    return { publicKey, privateKey };
  }

  await mkdir(keyDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  await Promise.all([
    writeFile(pubPath, publicKey, "utf-8"),
    writeFile(privPath, privateKey, { encoding: "utf-8", mode: 0o600 }),
  ]);

  return { publicKey, privateKey };
}

export interface EncryptedPayload {
  encryptedData: Buffer;
  encryptedKey: Buffer;
  iv: Buffer;
}

export function encryptBuffer(data: Buffer, publicKeyPem: string): EncryptedPayload {
  const symmetricKey = randomBytes(32);
  const iv = randomBytes(16);

  const cipher = createCipheriv("aes-256-ctr", symmetricKey, iv);
  const encryptedData = Buffer.concat([cipher.update(data), cipher.final()]);

  const encryptedKey = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    symmetricKey,
  );

  return { encryptedData, encryptedKey, iv };
}

export async function readPublicKey(dataDir: string): Promise<string> {
  const pubPath = join(getKeyDir(dataDir), "backup.pub");
  return readFile(pubPath, "utf-8");
}

export async function readPrivateKey(dataDir: string): Promise<string> {
  const privPath = join(getKeyDir(dataDir), "backup.pem");
  return readFile(privPath, "utf-8");
}
