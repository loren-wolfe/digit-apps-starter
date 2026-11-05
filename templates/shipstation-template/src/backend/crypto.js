/**
 * AES-256-GCM matching digit-api appConfigVars:
 * stored as v1.{ivB64}.{authTagB64}.{ciphertextB64}
 */

import { AppErrorCode } from '@heysutton/sdk';
import { HandlerError } from '@heysutton/sdk-server';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function bytesToB64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateEncryptionKeyB64() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export function parseEncryptionKey({ raw }) {
  let key;
  try {
    key = b64ToBytes(raw);
  } catch {
    throw new HandlerError({
      code: AppErrorCode.MISSING_CONFIG,
      message: 'The app encryption key is invalid. Save configuration again.',
      status: 500,
    });
  }
  if (key.length !== KEY_BYTES) {
    throw new HandlerError({
      code: AppErrorCode.MISSING_CONFIG,
      message: 'The app encryption key is invalid. Save configuration again.',
      status: 500,
    });
  }
  return key;
}

async function importAesKey({ keyBytes, usage }) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, usage);
}

export async function encryptSecret({ plaintext, keyBytes }) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importAesKey({ keyBytes, usage: ['encrypt'] });
  const packed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const ciphertext = packed.slice(0, packed.length - TAG_BYTES);
  const authTag = packed.slice(packed.length - TAG_BYTES);
  return `${VERSION}.${bytesToB64(iv)}.${bytesToB64(authTag)}.${bytesToB64(ciphertext)}`;
}

export async function decryptSecret({ stored, keyBytes }) {
  const [version, ivB64, authTagB64, ciphertextB64] = String(stored).split('.');
  if (version !== VERSION || !ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted secret');
  }
  const iv = b64ToBytes(ivB64);
  const authTag = b64ToBytes(authTagB64);
  const ciphertext = b64ToBytes(ciphertextB64);
  const packed = new Uint8Array(ciphertext.length + authTag.length);
  packed.set(ciphertext, 0);
  packed.set(authTag, ciphertext.length);
  const key = await importAesKey({ keyBytes, usage: ['decrypt'] });
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, packed);
  return new TextDecoder().decode(plain);
}
