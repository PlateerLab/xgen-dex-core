import type { RootedResolvedPath } from './rooted-fs';
import type { NativeFileIdentity } from '@dex/native-fs';

/**
 * Commit bytes through the pinned target-directory handle.
 *
 * The native boundary stages outside every user grant, verifies the held stage
 * object, then consumes its name with renameat (overwrite) or linkat
 * (create-if-absent). Unsupported platforms/filesystems and cross-volume moves
 * fail closed; there is no pathname or JavaScript fallback.
 *
 * `expected` is an immediate native identity recheck before the commit. POSIX
 * and Windows do not provide a portable compare-and-rename primitive, so this
 * is an editor conflict check rather than a kernel CAS against an unrestricted
 * same-user process racing between that check and the rename.
 */
export async function atomicWorkspaceWrite(
  target: RootedResolvedPath,
  bytes: Uint8Array,
  options: { overwrite: boolean; signal?: AbortSignal; expected?: NativeFileIdentity; creationMode?: number },
): Promise<void> {
  options.signal?.throwIfAborted();
  target.grant.atomicWrite(target.relativePath, bytes, options.overwrite, options.expected, options.creationMode);
  options.signal?.throwIfAborted();
}
