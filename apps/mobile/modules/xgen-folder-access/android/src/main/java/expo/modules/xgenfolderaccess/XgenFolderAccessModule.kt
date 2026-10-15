package expo.modules.xgenfolderaccess

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

private const val PICK_TREE_CODE = 5171
private const val READ_CHUNK = 64 * 1024

internal class FolderAccessException(message: String) : CodedException(message)

/** One document inside a folder the user granted (Storage Access Framework). */
private data class Doc(
  val id: String,
  val name: String,
  val mime: String,
  val size: Long,
  val modified: Long,
) {
  val isDir: Boolean get() = mime == Document.MIME_TYPE_DIR

  fun toMap(): Map<String, Any?> = mapOf(
    "name" to name,
    "isDir" to isDir,
    "size" to size.toDouble(),
    "modified" to modified.toDouble(),
  )
}

/**
 * Folders the user connects to a conversation, on Android.
 *
 * The user picks a folder with the system picker (ACTION_OPEN_DOCUMENT_TREE) and
 * the grant is persisted, so it survives restarts. Every operation takes the
 * granted tree URI plus a path relative to it and walks the tree by display
 * name — nothing outside the granted tree is reachable, and it works for any
 * documents provider (device storage, SD card, Downloads, cloud providers).
 */
class XgenFolderAccessModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var pendingPick: Promise? = null

  private val projection = arrayOf(
    Document.COLUMN_DOCUMENT_ID,
    Document.COLUMN_DISPLAY_NAME,
    Document.COLUMN_MIME_TYPE,
    Document.COLUMN_SIZE,
    Document.COLUMN_LAST_MODIFIED,
  )

  override fun definition() = ModuleDefinition {
    Name("XgenFolderAccess")

    AsyncFunction("pickFolders") { promise: Promise ->
      if (pendingPick != null) {
        throw FolderAccessException("이미 폴더를 고르는 중입니다.")
      }
      pendingPick = promise
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
      }
      try {
        appContext.throwingActivity.startActivityForResult(intent, PICK_TREE_CODE)
      } catch (e: Exception) {
        pendingPick = null
        throw FolderAccessException("폴더 선택 창을 열지 못했습니다: ${e.message}")
      }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != PICK_TREE_CODE) {
        return@OnActivityResult
      }
      val promise = pendingPick ?: return@OnActivityResult
      pendingPick = null
      val tree = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || tree == null) {
        promise.resolve(emptyList<Map<String, Any?>>())
        return@OnActivityResult
      }
      try {
        context.contentResolver.takePersistableUriPermission(
          tree,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        val root = query(tree, DocumentsContract.getTreeDocumentId(tree))
        val name = root?.name?.takeIf { it.isNotEmpty() } ?: (tree.lastPathSegment ?: "folder")
        promise.resolve(listOf(mapOf("uri" to tree.toString(), "name" to name)))
      } catch (e: Exception) {
        promise.reject(FolderAccessException("폴더 권한을 받지 못했습니다: ${e.message}"))
      }
    }

    /** Whether the persisted grant for this folder is still there. */
    AsyncFunction("hasAccess") { treeUri: String ->
      val uri = Uri.parse(treeUri)
      context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
    }

    /** Gives the grant back when the user disconnects the folder. */
    AsyncFunction("release") { treeUri: String ->
      try {
        context.contentResolver.releasePersistableUriPermission(
          Uri.parse(treeUri),
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
      } catch (_: SecurityException) {
        // Already gone (the user revoked it in system settings).
      }
    }

    AsyncFunction("list") { treeUri: String, relPath: String ->
      val tree = Uri.parse(treeUri)
      val dir = resolve(tree, relPath) ?: throw FolderAccessException("폴더를 찾을 수 없습니다: $relPath")
      if (!dir.isDir) {
        throw FolderAccessException("폴더가 아닙니다: $relPath")
      }
      children(tree, dir.id).map { it.toMap() }
    }

    AsyncFunction("stat") { treeUri: String, relPath: String ->
      val doc = resolve(Uri.parse(treeUri), relPath)
      if (doc == null) {
        mapOf("exists" to false, "isDir" to false, "size" to 0.0)
      } else {
        mapOf("exists" to true, "isDir" to doc.isDir, "size" to doc.size.toDouble())
      }
    }

    AsyncFunction("readText") { treeUri: String, relPath: String, maxBytes: Int ->
      val tree = Uri.parse(treeUri)
      val doc = resolve(tree, relPath) ?: throw FolderAccessException("파일이 없습니다: $relPath")
      if (doc.isDir) {
        throw FolderAccessException("폴더는 읽을 수 없습니다: $relPath")
      }
      val cap = maxBytes.coerceAtLeast(1)
      val out = ByteArrayOutputStream()
      var read = 0L
      open(tree, doc, relPath).use { input ->
        val buffer = ByteArray(READ_CHUNK)
        while (read <= cap) {
          val n = input.read(buffer)
          if (n < 0) break
          val keep = minOf(n.toLong(), cap - out.size().toLong()).toInt()
          if (keep > 0) out.write(buffer, 0, keep)
          read += n
        }
      }
      val size = maxOf(doc.size, read)
      mapOf(
        "text" to String(out.toByteArray(), Charsets.UTF_8),
        "size" to size.toDouble(),
        "truncated" to (size > cap),
      )
    }

    AsyncFunction("writeText") { treeUri: String, relPath: String, content: String, append: Boolean ->
      val tree = Uri.parse(treeUri)
      val target = ensureFile(tree, relPath)
      val bytes = content.toByteArray(Charsets.UTF_8)
      val uri = docUri(tree, target.id)
      if (append) {
        // "wa" is not supported by every provider — fall back to rewriting.
        val appended = try {
          context.contentResolver.openOutputStream(uri, "wa")?.use { it.write(bytes) } != null
        } catch (_: Exception) {
          false
        }
        if (!appended) {
          val previous = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
          write(uri, previous + bytes, relPath)
        }
      } else {
        write(uri, bytes, relPath)
      }
    }

    /** Copies a local file (a camera capture) into the folder. */
    AsyncFunction("importFile") { treeUri: String, relPath: String, sourceUri: String ->
      val tree = Uri.parse(treeUri)
      val target = ensureFile(tree, relPath)
      val source = Uri.parse(sourceUri)
      val input: InputStream = if (source.scheme == null || source.scheme == "file") {
        FileInputStream(File(source.path ?: sourceUri))
      } else {
        context.contentResolver.openInputStream(source)
          ?: throw FolderAccessException("원본 파일을 열 수 없습니다.")
      }
      input.use { i ->
        val output = context.contentResolver.openOutputStream(docUri(tree, target.id), "wt")
          ?: throw FolderAccessException("파일에 쓸 수 없습니다: $relPath")
        output.use { o -> i.copyTo(o) }
      }
      Unit
    }

    AsyncFunction("remove") { treeUri: String, relPath: String ->
      val tree = Uri.parse(treeUri)
      if (segments(relPath).isEmpty()) {
        throw FolderAccessException("연결한 폴더 자체는 지울 수 없습니다.")
      }
      val doc = resolve(tree, relPath) ?: throw FolderAccessException("파일이 없습니다: $relPath")
      if (!DocumentsContract.deleteDocument(context.contentResolver, docUri(tree, doc.id))) {
        throw FolderAccessException("지우지 못했습니다: $relPath")
      }
    }

    /** Copies a file to the app cache so another app can open or share it. */
    AsyncFunction("exportFile") { treeUri: String, relPath: String ->
      val tree = Uri.parse(treeUri)
      val doc = resolve(tree, relPath) ?: throw FolderAccessException("파일이 없습니다: $relPath")
      if (doc.isDir) {
        throw FolderAccessException("폴더는 열 수 없습니다: $relPath")
      }
      val dir = File(context.cacheDir, "xgen-open").apply { mkdirs() }
      val out = File(dir, doc.name.replace('/', '_').ifEmpty { "file" })
      open(tree, doc, relPath).use { input -> out.outputStream().use { output -> input.copyTo(output) } }
      Uri.fromFile(out).toString()
    }
  }

  private fun segments(relPath: String): List<String> {
    val parts = relPath.replace('\\', '/').split('/').filter { it.isNotEmpty() }
    if (parts.any { it == "." || it == ".." }) {
      throw FolderAccessException("허용되지 않는 경로입니다: $relPath")
    }
    return parts
  }

  private fun docUri(tree: Uri, docId: String): Uri =
    DocumentsContract.buildDocumentUriUsingTree(tree, docId)

  private fun readDoc(cursor: Cursor): Doc = Doc(
    id = cursor.getString(0),
    name = cursor.getString(1) ?: "",
    mime = cursor.getString(2) ?: "",
    size = if (cursor.isNull(3)) 0L else cursor.getLong(3),
    modified = if (cursor.isNull(4)) 0L else cursor.getLong(4),
  )

  private fun query(tree: Uri, docId: String): Doc? =
    context.contentResolver.query(docUri(tree, docId), projection, null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) readDoc(cursor) else null
    }

  private fun children(tree: Uri, parentId: String): List<Doc> {
    val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
    val out = mutableListOf<Doc>()
    context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) out.add(readDoc(cursor))
    }
    return out
  }

  private fun root(tree: Uri): Doc {
    val doc: Doc? = try {
      query(tree, DocumentsContract.getTreeDocumentId(tree))
    } catch (_: SecurityException) {
      null
    }
    return doc ?: throw FolderAccessException("연결한 폴더에 접근할 수 없습니다. 폴더를 다시 연결하세요.")
  }

  /** Walks the granted tree by display name. `null` when a segment is missing. */
  private fun resolve(tree: Uri, relPath: String): Doc? {
    var current = root(tree)
    for (part in segments(relPath)) {
      if (!current.isDir) return null
      current = children(tree, current.id).firstOrNull { it.name == part } ?: return null
    }
    return current
  }

  private fun create(tree: Uri, parentId: String, mime: String, name: String): Doc {
    val created = DocumentsContract.createDocument(context.contentResolver, docUri(tree, parentId), mime, name)
      ?: throw FolderAccessException("만들지 못했습니다: $name")
    val id = DocumentsContract.getDocumentId(created)
    return query(tree, id) ?: Doc(id, name, mime, 0L, 0L)
  }

  private fun ensureDir(tree: Uri, parts: List<String>): Doc {
    var current = root(tree)
    for (part in parts) {
      val next = children(tree, current.id).firstOrNull { it.name == part }
      current = when {
        next == null -> create(tree, current.id, Document.MIME_TYPE_DIR, part)
        next.isDir -> next
        else -> throw FolderAccessException("같은 이름의 파일이 있어 폴더를 만들 수 없습니다: $part")
      }
    }
    return current
  }

  private fun ensureFile(tree: Uri, relPath: String): Doc {
    val parts = segments(relPath)
    if (parts.isEmpty()) {
      throw FolderAccessException("파일 경로가 필요합니다.")
    }
    val parent = ensureDir(tree, parts.dropLast(1))
    val name = parts.last()
    val existing = children(tree, parent.id).firstOrNull { it.name == name }
    if (existing != null) {
      if (existing.isDir) throw FolderAccessException("폴더에는 쓸 수 없습니다: $relPath")
      return existing
    }
    // octet-stream keeps the name as given — a text MIME type makes some
    // providers append ".txt" to names like "notes.md".
    return create(tree, parent.id, "application/octet-stream", name)
  }

  private fun open(tree: Uri, doc: Doc, relPath: String): InputStream =
    context.contentResolver.openInputStream(docUri(tree, doc.id))
      ?: throw FolderAccessException("파일을 열 수 없습니다: $relPath")

  private fun write(uri: Uri, bytes: ByteArray, relPath: String) {
    val output = context.contentResolver.openOutputStream(uri, "wt")
      ?: throw FolderAccessException("파일에 쓸 수 없습니다: $relPath")
    output.use { it.write(bytes) }
  }
}
