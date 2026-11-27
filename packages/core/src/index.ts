// Public surface of @vault/core: logic every Vault client shares, with no UI
// and no third-party dependencies. See docs/ROADMAP.md.

export { type Ecc, type QrCode, encodeQr, qrPath } from './qr.js'
export {
  MAX_FOLDER_DEPTH,
  TYPE_SPECS,
  type EntryLike,
  type EntryType,
  type FieldKind,
  type FieldSpec,
  type FolderLike,
  type FolderNode,
  type TypeGroup,
  type TypeSpec,
  TYPE_GROUPS,
  formatDate,
  isPast,
  typesByGroup,
  cardBrand,
  depthOf,
  descendants,
  flattenTree,
  folderPath,
  folderTree,
  formatCardNumber,
  hostOf,
  matches,
  readField,
  subtitle,
  typeSpec,
  writeField,
} from './items.js'
export {
  type ImportResult,
  type ImportedItem,
  ImportError,
  duplicateKey,
  parseCsv,
  readImport,
  totpKey,
} from './import.js'
export { type ExportEntry, toCsv } from './export.js'
export { EXPIRING_DAYS, ISSUES, PASSWORD_ISSUES, breachCount, expiryOf, type HealthInput, type HealthReport, type Issue, type Strength, STRENGTH_LABELS, analyse, belowMinimum, passwordStrength, twoFactorAvailable } from './health.js'
export {
  CLIPBOARD_CHOICES,
  AUTO_HIDE_CHOICES,
  LANGUAGES,
  type Language,
  CLOCKS,
  DATE_STYLES,
  MASK_LENGTHS,
  type Clock,
  type DateStyle,
  type MaskLength,
  formatWhen,
  DENSITIES,
  LIST_SORTS,
  type Density,
  type ListSort,
  DEFAULT_PREFS,
  GENERATOR_MAX,
  GENERATOR_MIN,
  LOCK_CHOICES,
  SEPARATORS,
  THEMES,
  type GeneratorPrefs,
  type GeneratedPassword,
  GENERATOR_HISTORY_MAX,
  type Prefs,
  type Theme,
  describeMinutes,
  describeSeconds,
  effectiveLockMinutes,
  normalizePrefs,
  rememberGenerated,
} from './prefs.js'
export { type Failure, friendlyError } from './errors.js'
export {
  BITS_PER_WORD,
  PASSPHRASE_MAX_WORDS,
  PASSPHRASE_MIN_WORDS,
  type PassphraseOptions,
  generatePassphrase,
  passphraseBits,
} from './passphrase.js'
export { type SiteMatch, matchSite, rankForPage, registrableDomain } from './sitematch.js'
export { generateFromPrefs, generatePassword } from './generate.js'
export { type AssertionJSON, type AttestationJSON, FLAGS as PASSKEY_FLAGS, type StoredPasskey, assertPasskey, attestationObject, authenticatorData, cbor, clientDataJSON, coseEs256, createPasskey, p1363ToDer, rpIdAllowed } from './passkey.js'
export { type Block, type Inline, type ListItem, looksLikeMarkdown, parseInline, parseMarkdown } from './markdown.js'
export { RELATED_MAX, type Relatable, cleanRelated, relatedItems } from './related.js'
