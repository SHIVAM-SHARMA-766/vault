# 0026: Organization recovery key

Status: Accepted (design)
Date: 2026-11-08
Implements: [0023](0023-crypto-hardening.md) §4; settles the open question in 0016

## Design

**Created with the organization.** When an organization is created, the owner's app generates
a 32-byte **organization recovery key**. It shows it once in the same grouped format as personal
recovery keys, and asks the owner to keep it offline.

**Escrow:** the org key is sealed to a key derived from it:

```
recoveryKek = HKDF-SHA256(recoveryKey, info "vault.org-recovery.v1:<orgId>")
escrow      = AES-256-GCM(recoveryKek, orgKey, aad "vault.org-recovery|<orgId>")
```

The server stores `escrow`. It holds no key that opens it.

**Recovery:** someone who holds the recovery key and is a confirmed member opens
**Organization → Recover with the recovery key**:

1. Their app opens `escrow` and gets the org key.
2. It re-seals the org key to their own public key.
3. The server accepts this and promotes them to owner only when the request carries a proof
   `HMAC(recoveryKek, "vault.org-recovery.proof|<orgId>|<userId>")`. The server checks it
   against a verifier stored at creation (`HMAC(recoveryKek, "vault.org-recovery.verifier|<orgId>")`).
4. The action is audited, and every remaining owner and admin is notified.

Collection keys come back through the org key's existing role. Collections whose keys were sealed
only to people who are gone must be re-granted by the recovered owner, from the escrowed org key
plus the collection keys it can open. Where neither is possible, the collection is lost, and the
UI says so before recovery starts.

**Existing organizations** get **Create a recovery key** in their settings (owner only).

**Rotation:** creating a new recovery key replaces the escrow and the verifier.

## Tests

- known-answer tests for the HKDF, the escrow and the verifier
- recovery by a member with the right key
- refusal: the wrong key, a non-member, a replayed proof for another user id
- audit and notifications fire
