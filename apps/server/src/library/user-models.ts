import { and, eq, isNull, sql, TransactionRollbackError } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems } from '../db/schema.js'
import { releaseRoomSetObject } from '../room-scan/sets.js'
import { createStorage } from '../storage/index.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A deleted model's stored file, released once the deleting transaction has committed. */
export interface ModelFile { storageKey: string; cdnUrl: string | null }

/**
 * When an account is deleted (LIV-132): its private 3D Models go with it, in the same transaction as the user row
 * (their scene-library links cascade), except one another account's scene still has (it was shared once). Public ones stay, ownerless (uploaded_by is ON DELETE SET NULL), so other
 * scenes that use them keep working. Catalog models have no uploader and are never touched. Returns the files to
 * release with releaseModelFiles after commit.
 */
export async function deletePrivateModels(tx: Tx, userId: string): Promise<ModelFile[]> {
  // A model that was shared and is still in another account's scene library stays for that scene, ownerless (LIV-20)
  await tx
    .update(assetLibraryItems)
    .set({ uploadedBy: null })
    .where(and(
      eq(assetLibraryItems.uploadedBy, userId),
      eq(assetLibraryItems.isPublic, false),
      sql`EXISTS (SELECT 1 FROM scene_library l JOIN scenes s ON s.id = l.scene_id WHERE l.asset_item_id = asset_library_items.id AND s.owner_id <> ${userId})`,
    ))
  return tx
    .delete(assetLibraryItems)
    .where(and(eq(assetLibraryItems.uploadedBy, userId), eq(assetLibraryItems.isPublic, false), isNull(assetLibraryItems.packId)))
    .returning({ storageKey: assetLibraryItems.storageKey, cdnUrl: assetLibraryItems.cdnUrl })
}

/**
 * Best effort, after commit: delete the files of deleted models, except one something still uses (an element placed by
 * URL in a scene that outlived the account, or another library row with the same URL). Never throws.
 */
export async function releaseModelFiles(files: ModelFile[]): Promise<void> {
  const storage = createStorage()
  for (const f of files) {
    if (f.cdnUrl) {
      await releaseRoomSetObject({ storageKey: f.storageKey, glbUrl: f.cdnUrl })
    } else {
      // An unfinished upload: nothing can point at it yet
      await storage.delete(f.storageKey).catch((err) => console.error('[user-models] failed to delete', f.storageKey, err))
    }
  }
}

/** Delete a user and their private models in one transaction (see deletePrivateModels); returns the files to release. */
export async function deleteUserWithModels(userId: string, deleteUser: (tx: Tx) => Promise<boolean>): Promise<ModelFile[] | null> {
  return db.transaction(async (tx) => {
    const files = await deletePrivateModels(tx, userId)
    if (!(await deleteUser(tx))) {
      tx.rollback() // the user wasn't deleted after all: keep their models
    }
    return files
  }).catch((err) => {
    if (err instanceof TransactionRollbackError) return null
    throw err
  })
}
