// Public surface of @vault/core: logic every Vault client shares, with no UI
// and no third-party dependencies. See ROADMAP.md, phase 1.

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
  type TypeSpec,
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
export { ISSUES, type HealthInput, type HealthReport, type Issue, type Strength, analyse, passwordStrength } from './health.js'
