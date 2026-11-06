// Public surface of @vault/crypto.
//
// Everything the rest of the product uses to encrypt, decrypt, derive, or
// generate is exported here. Nothing in this package depends on a third-party
// module, and no algorithm is implemented by hand — the primitives come from
// Web Crypto, which resolves to the browser's implementation in a page and to
// Node's in the API and in tests.
//
// Design: decisions/0001-cryptography-and-key-hierarchy.md

export {
  fromBase32Secret,
  fromBase64Url,
  fromHex,
  fromRecoveryString,
  timingSafeEqual,
  toBase32Secret,
  toBase64Url,
  toHex,
  toRecoveryString,
  utf8Decode,
  utf8Encode,
  wipe,
} from './encoding.js'

export { randomBytes } from './random.js'

export {
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  type HashName,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  hmac,
  hmacSha256,
  pbkdf2Sha256,
} from './primitives.js'

export {
  SEALED_VERSION,
  UnsealError,
  seal,
  sealJson,
  sealString,
  unseal,
  unsealJson,
  unsealString,
} from './aead.js'

export {
  KEY_BYTES,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  type ChangedPassword,
  type KdfParams,
  type LoginKeys,
  type NewAccount,
  type Unlocked,
  changePassword,
  createAccount,
  deriveAuthKey,
  deriveKek,
  deriveLoginKeys,
  deriveMasterKey,
  deriveRecoveryAuthKey,
  deriveRecoveryKek,
  deriveRecoveryProof,
  formatRecoveryKey,
  generateRecoveryKey,
  generateSalt,
  generateVaultKey,
  normalizeEmail,
  parseRecoveryKey,
  rotateRecoveryKey,
  unlock,
  unlockWithRecoveryKey,
  unwrapVaultKey,
  wrapVaultKey,
} from './keys.js'

export {
  MAX_BLOB_BYTES,
  type CustomField,
  type EntryContent,
  type EntryType,
  type FolderContent,
  type SealedEntry,
  type SealedFolder,
  isWithinSizeLimit,
  openEntry,
  openFolder,
  openHistory,
  sealEntry,
  sealFolder,
  sealHistory,
} from './entry.js'

export {
  IDENTITY_VERSION,
  PUBLIC_KEY_BYTES,
  type IdentityKeyPair,
  generateIdentityKeyPair,
  identityFingerprint,
  isValidPublicKey,
  openFromSender,
  sealForRecipient,
  unwrapIdentityPrivateKey,
  wrapIdentityPrivateKey,
} from './identity.js'

export {
  TOTP_DEFAULTS,
  type ParsedOtpauth,
  type TotpAlgorithm,
  type TotpCode,
  type TotpConfig,
  generateTotp,
  parseOtpauthUri,
  totpFromBytes,
} from './totp.js'
