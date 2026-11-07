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

/** The service desk (routes/desk.ts): one partition of tickets, one per
 *  ticket for its messages, and a pointer from each requester's own
 *  partition so "my tickets" is one query. */
export const DESK_PK = 'DESK'
export const DESK_SEQ_SK = 'SEQ'
export const ticketSk = (id: string) => `TICKET#${id}`
export const TICKET_PREFIX = 'TICKET#'
export const ticketPk = (id: string) => `DESKT#${id}`
/** Numbered per ticket, so a conversation reads in order even when two
 *  messages land in the same millisecond. */
export const messageSk = (seq: number) => `MSG#${String(seq).padStart(8, '0')}`
export const MESSAGE_SEQ_SK = 'SEQ'
export const MESSAGE_PREFIX = 'MSG#'

/** Organizations (routes/orgs.ts, decisions/0015). One partition per
 *  organization for its members, pending invitations and collections; one
 *  per collection for its items; and pointers so a user's organizations and
 *  an address's invitations are each one query. */
export const orgPk = (orgId: string) => `ORG#${orgId}`
export const ORG_META_SK = 'META'
export const orgMemberSk = (userId: string) => `MEMBER#${userId}`
export const ORG_MEMBER_PREFIX = 'MEMBER#'
export const orgPendingSk = (digest: string) => `PENDING#${digest}`
export const ORG_PENDING_PREFIX = 'PENDING#'
export const collectionSk = (collectionId: string) => `COLL#${collectionId}`
export const COLLECTION_PREFIX = 'COLL#'
export const accessSk = (collectionId: string, userId: string) => `ACCESS#${collectionId}#${userId}`
export const accessPrefix = (collectionId: string) => `ACCESS#${collectionId}#`
export const ACCESS_PREFIX = 'ACCESS#'
export const collectionItemsPk = (collectionId: string) => `COLLI#${collectionId}`
export const itemSk = (itemId: string) => `ITEM#${itemId}`
export const ITEM_PREFIX = 'ITEM#'
export const userOrgSk = (orgId: string) => `ORG#${orgId}`
export const USER_ORG_PREFIX = 'ORG#'
export const orgInviteSk = (orgId: string) => `ORGINVITE#${orgId}`
export const ORG_INVITE_PREFIX = 'ORGINVITE#'
export const groupSk = (groupId: string) => `GROUP#${groupId}`
export const GROUP_PREFIX = 'GROUP#'
export const groupAccessSk = (collectionId: string, groupId: string) => `GACCESS#${collectionId}#${groupId}`
export const GROUP_ACCESS_PREFIX = 'GACCESS#'
