// Key construction for the single table. Every partition and sort key in the
// system is built here, so the layout in vault/decisions/0002 has exactly one
// implementation.

export const userPk = (userId: string) => `USER#${userId}`
export const emailPk = (emailDigest: string) => `EMAIL#${emailDigest}`
export const ratePk = (bucket: string) => `RATE#${bucket}`

/** One partition for everything the operator manages rather than a user owns:
 *  settings, the account registry, invitations, the admin audit log, and the
 *  last backup. It is the only partition the admin routes read across users,
 *  which is what lets them avoid scanning the table. */
export const SYSTEM_PK = 'SYSTEM'
export const SETTINGS_SK = 'SETTINGS'
export const BACKUP_SK = 'BACKUP'
export const registrySk = (userId: string) => `USER#${userId}`
export const inviteSk = (codeHash: string) => `INVITE#${codeHash}`
export const inviteUsedSk = (codeHash: string) => `INVITEUSED#${codeHash}`
export const auditSk = (at: string, nonce: string) => `AUDIT#${at}#${nonce}`
export const REGISTRY_PREFIX = 'USER#'
export const INVITE_PREFIX = 'INVITE#'
export const AUDIT_PREFIX = 'AUDIT#'

export const PROFILE_SK = 'PROFILE'
export const EMAIL_SK = 'EMAIL'

export const entrySk = (entryId: string) => `ENTRY#${entryId}`
export const folderSk = (folderId: string) => `FOLDER#${folderId}`
export const sessionSk = (tokenId: string) => `SESSION#${tokenId}`
export const historySk = (entryId: string, at: string) => `HIST#${entryId}#${at}`
export const activitySk = (at: string, nonce: string) => `ACT#${at}#${nonce}`

export const ENTRY_PREFIX = 'ENTRY#'
export const FOLDER_PREFIX = 'FOLDER#'
export const SESSION_PREFIX = 'SESSION#'
export const HISTORY_PREFIX = 'HIST#'
export const ACTIVITY_PREFIX = 'ACT#'

export const historyPrefix = (entryId: string) => `HIST#${entryId}#`

/** Identifiers appear in sort keys, so a value containing '#' would let a
 *  caller address a different item type. Restricted to what a UUID needs. */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}
