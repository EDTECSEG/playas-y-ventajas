// Shim de crypto para o bundle do worker.
//
// Os handlers sao CJS e fazem require('crypto'). Com o bundle em format:esm,
// o esbuild troca require de um external por um stub que lanca
// ("Dynamic require of \"crypto\" is not supported") - em Workers nao existe
// require de verdade. O alias no bundle script aponta 'crypto' para este
// arquivo, que reexporta node:crypto por import ESTATICO (suportado pelo
// nodejs_compat) em vez de require.
//
// Superficie realmente usada pelos handlers:
//   upload-image.js / validate-coupon.js  -> createHmac, timingSafeEqual
//   _otp.js                               -> randomUUID
// Buffer vem do nodejs_compat como global.

import * as nodeCrypto from 'node:crypto';

export const randomUUID = nodeCrypto.randomUUID;
export const createHmac = nodeCrypto.createHmac;
export const timingSafeEqual = nodeCrypto.timingSafeEqual;
export const webcrypto = nodeCrypto.webcrypto;
export const subtle = nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle;
export const createHash = nodeCrypto.createHash;
export const randomBytes = nodeCrypto.randomBytes;

export default nodeCrypto;
