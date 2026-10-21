// Included only by the _WIN32 branch of native_fs.cc.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <algorithm>
#include <climits>
#include <cstddef>
#include <array>
#include <cstring>
#include <limits>
#include <sstream>
#pragma comment(lib, "advapi32.lib")

#ifndef ERROR_STOPPED_ON_SYMLINK
#define ERROR_STOPPED_ON_SYMLINK 681
#endif
#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef FILE_CREATE
#define FILE_CREATE 0x00000002
#endif
#ifndef FILE_OPEN_IF
#define FILE_OPEN_IF 0x00000003
#endif
#ifndef FILE_SUPERSEDE
#define FILE_SUPERSEDE 0x00000000
#endif
#ifndef FILE_RENAME_FLAG_REPLACE_IF_EXISTS
#define FILE_RENAME_FLAG_REPLACE_IF_EXISTS 0x00000001
#endif
#ifndef FILE_RENAME_FLAG_POSIX_SEMANTICS
#define FILE_RENAME_FLAG_POSIX_SEMANTICS 0x00000002
#endif

namespace {
using NtCreateFileFn = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
    PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtSetInformationFileFn = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, int);
using NtSetSecurityObjectFn = NTSTATUS (NTAPI*)(HANDLE, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR);
using RtlNtStatusToDosErrorFn = ULONG (NTAPI*)(NTSTATUS);
using BCryptGenRandomFn = NTSTATUS (WINAPI*)(void*, unsigned char*, ULONG, ULONG);
constexpr ULONG kBcryptUseSystemPreferredRng = 0x00000002;
constexpr int kFileRenameInformationEx = 65;
constexpr NTSTATUS kStatusSuccess = 0;
constexpr NTSTATUS kStatusPending = 0x00000103;

NtCreateFileFn nt_create = nullptr;
NtSetInformationFileFn nt_set_info = nullptr;
NtSetSecurityObjectFn nt_set_security = nullptr;
RtlNtStatusToDosErrorFn nt_to_dos = nullptr;
BCryptGenRandomFn bcrypt_random = nullptr;

bool NativeReady() {
  if (nt_create && nt_set_info && nt_to_dos && bcrypt_random) return true;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  HMODULE bcrypt = LoadLibraryW(L"bcrypt.dll");
  if (!ntdll || !bcrypt) return false;
  nt_create = reinterpret_cast<NtCreateFileFn>(GetProcAddress(ntdll, "NtCreateFile"));
  nt_set_info = reinterpret_cast<NtSetInformationFileFn>(GetProcAddress(ntdll, "NtSetInformationFile"));
  nt_set_security = reinterpret_cast<NtSetSecurityObjectFn>(GetProcAddress(ntdll, "NtSetSecurityObject"));
  nt_to_dos = reinterpret_cast<RtlNtStatusToDosErrorFn>(GetProcAddress(ntdll, "RtlNtStatusToDosError"));
  bcrypt_random = reinterpret_cast<BCryptGenRandomFn>(GetProcAddress(bcrypt, "BCryptGenRandom"));
  return nt_create && nt_set_info && nt_to_dos && bcrypt_random;
}

struct Handle {
  HANDLE h = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE value) : h(value) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : h(other.h) { other.h = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { reset(); h = other.h; other.h = INVALID_HANDLE_VALUE; }
    return *this;
  }
  ~Handle() { reset(); }
  void reset(HANDLE value = INVALID_HANDLE_VALUE) {
    if (h != INVALID_HANDLE_VALUE && h != nullptr) CloseHandle(h);
    h = value;
  }
  explicit operator bool() const { return h != INVALID_HANDLE_VALUE && h != nullptr; }
};

struct Identity {
  FILE_ID_INFO file_id{};
  uint64_t size = 0;
  FILETIME modified{};
  FILETIME changed{};
  DWORD attributes = 0;
};
struct Ancestor { Handle handle; Handle writable; Identity identity; };
struct Root {
  Handle handle; Handle write_handle; std::wstring canonical; Identity identity;
  std::vector<Ancestor> ancestors;
};
struct Source { Handle handle; Identity initial; };
struct Stage {
  Handle handle; std::wstring canonical; Identity identity;
  std::vector<Ancestor> ancestors;
};
struct Quarantine {
  Handle source;
  Handle original_parent;
  std::wstring original_name;
  std::shared_ptr<Stage> private_stage;
  std::mutex mutex;
  bool finished = false;
  bool restored = false;
};
std::mutex state_mutex;
uint64_t next_id = 1;
std::map<uint64_t, std::shared_ptr<Root>> roots;
std::map<uint64_t, std::shared_ptr<Source>> sources;
std::map<uint64_t, std::shared_ptr<Quarantine>> quarantines;
std::shared_ptr<Stage> stage;
std::vector<std::shared_ptr<Stage>> stages;
std::mutex stage_creation_mutex;

const char* WinCode(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_ALREADY_EXISTS: case ERROR_FILE_EXISTS: return "EEXIST";
    case ERROR_ACCESS_DENIED: case ERROR_SHARING_VIOLATION: case ERROR_PRIVILEGE_NOT_HELD: return "EACCES";
    case ERROR_INVALID_NAME: case ERROR_INVALID_PARAMETER: case ERROR_BAD_PATHNAME: return "EINVAL";
    case ERROR_DIRECTORY: return "ENOTDIR";
    case ERROR_NOT_SAME_DEVICE: return "EXDEV";
    case ERROR_DISK_FULL: case ERROR_HANDLE_DISK_FULL: return "ENOSPC";
    case ERROR_NOT_SUPPORTED: case ERROR_INVALID_FUNCTION: return "ENOTSUP";
    case ERROR_CANT_ACCESS_FILE: case ERROR_STOPPED_ON_SYMLINK: return "ELOOP";
    case ERROR_DIR_NOT_EMPTY: return "ENOTEMPTY";
    default: return "EIO";
  }
}

napi_value Throw(napi_env env, const char* code, const std::string& message) {
  napi_value msg, error, code_value;
  napi_create_string_utf8(env, message.c_str(), message.size(), &msg);
  napi_create_error(env, nullptr, msg, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_throw(env, error);
  return nullptr;
}
napi_value ThrowWin(napi_env env, const char* action, DWORD error = GetLastError()) {
  return Throw(env, WinCode(error), std::string(action) + ": Windows error " + std::to_string(error));
}
DWORD DosError(NTSTATUS status) { return nt_to_dos ? nt_to_dos(status) : ERROR_GEN_FAILURE; }

bool GetString(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> bytes(length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &copied) != napi_ok) return false;
  out->assign(bytes.data(), copied);
  return true;
}
bool GetId(napi_env env, napi_value value, uint64_t* out) {
  bool lossless = false;
  return napi_get_value_bigint_uint64(env, value, out, &lossless) == napi_ok && lossless;
}
bool GetBool(napi_env env, napi_value value, bool* out) {
  return napi_get_value_bool(env, value, out) == napi_ok;
}
bool GetUint8(napi_env env, napi_value value, uint8_t** data, size_t* length) {
  bool is_buffer = false;
  napi_is_buffer(env, value, &is_buffer);
  if (is_buffer) return napi_get_buffer_info(env, value, reinterpret_cast<void**>(data), length) == napi_ok;
  bool is_typed = false;
  napi_is_typedarray(env, value, &is_typed);
  if (!is_typed) return false;
  napi_typedarray_type type; size_t elements = 0; void* raw = nullptr;
  napi_value array_buffer; size_t offset = 0;
  if (napi_get_typedarray_info(env, value, &type, &elements, &raw, &array_buffer, &offset) != napi_ok ||
      type != napi_uint8_array) return false;
  *data = static_cast<uint8_t*>(raw); *length = elements; return true;
}
bool Utf8ToWide(const std::string& in, std::wstring* out) {
  if (in.size() > static_cast<size_t>(INT_MAX)) return false;
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, in.data(), static_cast<int>(in.size()), nullptr, 0);
  if (!count && !in.empty()) return false;
  out->resize(count);
  return !count || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, in.data(), static_cast<int>(in.size()), out->data(), count) == count;
}
bool WideToUtf8(const std::wstring& in, std::string* out) {
  if (in.size() > static_cast<size_t>(INT_MAX)) return false;
  int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, in.data(), static_cast<int>(in.size()), nullptr, 0, nullptr, nullptr);
  if (!count && !in.empty()) return false;
  out->resize(count);
  return !count || WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, in.data(), static_cast<int>(in.size()), out->data(), count, nullptr, nullptr) == count;
}

bool SameObject(const Identity& a, const Identity& b) {
  return a.file_id.VolumeSerialNumber == b.file_id.VolumeSerialNumber &&
    std::memcmp(a.file_id.FileId.Identifier, b.file_id.FileId.Identifier, 16) == 0;
}
bool SameSource(const Identity& a, const Identity& b) {
  return SameObject(a, b) && a.size == b.size &&
    CompareFileTime(&a.modified, &b.modified) == 0 && CompareFileTime(&a.changed, &b.changed) == 0;
}
bool QueryIdentity(HANDLE handle, Identity* out) {
  FILE_STANDARD_INFO standard{}; FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &out->file_id, sizeof(out->file_id)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))) return false;
  out->size = static_cast<uint64_t>(standard.EndOfFile.QuadPart);
  out->modified.dwLowDateTime = basic.LastWriteTime.LowPart;
  out->modified.dwHighDateTime = basic.LastWriteTime.HighPart;
  out->changed.dwLowDateTime = basic.ChangeTime.LowPart;
  out->changed.dwHighDateTime = basic.ChangeTime.HighPart;
  out->attributes = basic.FileAttributes;
  return true;
}
bool IsDirectory(const Identity& id) { return (id.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0; }
bool IsReparse(const Identity& id) { return (id.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0; }
bool IsRegular(const Identity& id) { return !IsDirectory(id) && !IsReparse(id) && (id.attributes & FILE_ATTRIBUTE_DEVICE) == 0; }
bool IsStage(const Identity& id) {
  std::lock_guard<std::mutex> lock(state_mutex);
  for (const auto& item : stages) if (SameObject(item->identity, id)) return true;
  return false;
}
uint64_t FileTimeTicks(const FILETIME& time) {
  return (static_cast<uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}
std::string PublicDev(const Identity& id) {
  // Node/libuv exposes the 32-bit volume serial in fs.Stat.dev on Windows.
  return std::to_string(static_cast<uint32_t>(id.file_id.VolumeSerialNumber));
}
std::string PublicIno(const Identity& id) {
  // FileIdInfo retains all 128 bits for native equality. Node/libuv's ino is
  // the 64-bit file index, which is the low half of this ID on NTFS.
  uint64_t low = 0;
  std::memcpy(&low, id.file_id.FileId.Identifier, sizeof(low));
  return std::to_string(low);
}
void SetString(napi_env env, napi_value object, const char* key, const std::string& value) {
  napi_value item; napi_create_string_utf8(env, value.c_str(), value.size(), &item); napi_set_named_property(env, object, key, item);
}
void SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value item; napi_create_double(env, value, &item); napi_set_named_property(env, object, key, item);
}
napi_value StatObject(napi_env env, const Identity& id) {
  napi_value result; napi_create_object(env, &result);
  SetString(env, result, "type", IsReparse(id) ? "symlink" : IsDirectory(id) ? "directory" : IsRegular(id) ? "file" : "other");
  SetNumber(env, result, "size", static_cast<double>(id.size));
  // FILETIME is in 100 ns intervals since 1601-01-01.
  constexpr uint64_t epoch = 116444736000000000ULL;
  uint64_t modified = FileTimeTicks(id.modified);
  uint64_t changed = FileTimeTicks(id.changed);
  uint64_t mtime_ns = modified >= epoch ? (modified - epoch) * 100 : 0;
  uint64_t ctime_ns = changed >= epoch ? (changed - epoch) * 100 : 0;
  SetNumber(env, result, "mtimeMs", static_cast<double>(mtime_ns) / 1000000.0);
  SetString(env, result, "mtimeNs", std::to_string(mtime_ns));
  SetString(env, result, "ctimeNs", std::to_string(ctime_ns));
  SetString(env, result, "dev", PublicDev(id));
  SetString(env, result, "ino", PublicIno(id));
  SetNumber(env, result, "mode", IsDirectory(id) ? 0777 : 0666);
  return result;
}

bool Args(napi_env env, napi_callback_info info, size_t expected, std::vector<napi_value>* args) {
  size_t count = expected; args->resize(expected);
  if (napi_get_cb_info(env, info, &count, args->data(), nullptr, nullptr) != napi_ok || count < expected) {
    Throw(env, "EINVAL", "native-fs argument missing"); return false;
  }
  return true;
}
std::shared_ptr<Root> FindRoot(uint64_t id) {
  std::lock_guard<std::mutex> lock(state_mutex);
  auto it = roots.find(id); return it == roots.end() ? nullptr : it->second;
}
std::shared_ptr<Source> FindSource(uint64_t id) {
  std::lock_guard<std::mutex> lock(state_mutex);
  auto it = sources.find(id); return it == sources.end() ? nullptr : it->second;
}
std::shared_ptr<Quarantine> FindQuarantine(uint64_t id) {
  std::lock_guard<std::mutex> lock(state_mutex);
  auto it = quarantines.find(id); return it == quarantines.end() ? nullptr : it->second;
}

bool SplitRelative(const std::string& path, bool allow_empty, std::vector<std::wstring>* parts) {
  if (path.empty()) return allow_empty;
  if (path[0] == '/' || path[0] == '\\') return false;
  size_t start = 0;
  for (;;) {
    size_t end = path.find('/', start);
    if (end == std::string::npos) end = path.size();
    std::string bytes = path.substr(start, end - start);
    if (bytes.empty() || bytes == "." || bytes == ".." || bytes.back() == ' ' || bytes.back() == '.') return false;
    for (unsigned char byte : bytes) if (byte < 32 || byte == '\\' || byte == ':' || byte == '*' || byte == '?' || byte == '"' || byte == '<' || byte == '>' || byte == '|') return false;
    std::wstring part;
    if (!Utf8ToWide(bytes, &part) || part.empty() || part.size() > 255) return false;
    parts->push_back(std::move(part));
    if (end == path.size()) break;
    start = end + 1;
  }
  return true;
}
bool RootAndPath(napi_env env, const std::vector<napi_value>& args, bool empty,
                 std::shared_ptr<Root>* root, std::vector<std::wstring>* parts) {
  uint64_t id = 0; std::string path;
  if (!GetId(env, args[0], &id) || !GetString(env, args[1], &path)) {
    Throw(env, "EINVAL", "invalid root or relative path"); return false;
  }
  *root = FindRoot(id);
  if (!*root) { Throw(env, "NATIVE_ROOT_CLOSED", "root grant is closed"); return false; }
  if (!SplitRelative(path, empty, parts)) { Throw(env, "PATH_DOMAIN_MISMATCH", "relative path contains an invalid component"); return false; }
  return true;
}

// A child is always opened relative to a retained directory HANDLE. The final
// reparse object is opened itself and then rejected for traversal or mutation.
Handle OpenAt(HANDLE parent, const std::wstring& name, ACCESS_MASK access,
              ULONG disposition, ULONG options, DWORD* error,
              ULONG share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
              PSECURITY_DESCRIPTOR security = nullptr, ULONG file_attributes = FILE_ATTRIBUTE_NORMAL) {
  if (name.size() > USHRT_MAX / sizeof(wchar_t)) { *error = ERROR_FILENAME_EXCED_RANGE; return {}; }
  UNICODE_STRING unicode{};
  unicode.Buffer = const_cast<PWSTR>(name.c_str());
  unicode.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &unicode;
  attributes.Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;
  attributes.SecurityDescriptor = security;
  IO_STATUS_BLOCK ios{}; HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = nt_create(&opened, access, &attributes, &ios, nullptr, file_attributes,
      share, disposition, options | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  if (status < 0) { *error = DosError(status); return {}; }
  *error = ERROR_SUCCESS;
  return Handle(opened);
}
Handle OpenDirAt(HANDLE parent, const std::wstring& name, DWORD* error, ACCESS_MASK extra_access = 0) {
  Handle opened = OpenAt(parent, name, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | extra_access,
                         FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, error);
  if (!opened) return {};
  Identity id{};
  if (!QueryIdentity(opened.h, &id)) { *error = GetLastError(); return {}; }
  if (!IsDirectory(id)) { *error = ERROR_DIRECTORY; return {}; }
  if (IsReparse(id)) { *error = ERROR_CANT_ACCESS_FILE; return {}; }
  if (IsStage(id)) { *error = ERROR_ACCESS_DENIED; return {}; }
  return opened;
}
Handle Duplicate(HANDLE handle, DWORD* error) {
  HANDLE copy = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    *error = GetLastError(); return {};
  }
  return Handle(copy);
}
Handle OpenDirectory(const Root& root, const std::vector<std::wstring>& parts, size_t count, DWORD* error, bool writable = false) {
  if (writable && count == 0 && !root.write_handle) { *error = ERROR_ACCESS_DENIED; return {}; }
  Handle current = Duplicate(writable && count == 0 ? root.write_handle.h : root.handle.h, error);
  if (!current) return {};
  for (size_t i = 0; i < count; ++i) {
    Handle next = OpenDirAt(current.h, parts[i], error,
      writable && i + 1 == count ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY : 0);
    if (!next) return {};
    current = std::move(next);
  }
  return current;
}
Handle OpenLeaf(const Root& root, const std::vector<std::wstring>& parts,
                ACCESS_MASK access, ULONG disposition, ULONG options, DWORD* error,
                ULONG share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                bool writable_parent = false) {
  Handle parent = OpenDirectory(root, parts, parts.size() - 1, error, writable_parent);
  if (!parent) return {};
  return OpenAt(parent.h, parts.back(), access, disposition, options, error, share);
}

bool CanonicalRoot(const std::wstring& input, Handle* rooted, std::wstring* canonical, Identity* identity,
                   DWORD* error, bool stage_access = false, Handle* write_handle = nullptr,
                   bool share_delete = true, bool allow_stage_final = false,
                   std::vector<Ancestor>* root_ancestors = nullptr,
                   std::vector<Ancestor>* stage_ancestors = nullptr) {
  // The one approved absolute path may resolve aliases. Reopen its canonical
  // target from a volume/share anchor and verify the object identity.
  Handle original(CreateFileW(input.c_str(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | SYNCHRONIZE | (stage_access ? WRITE_DAC | WRITE_OWNER | READ_CONTROL : 0),
      FILE_SHARE_READ | FILE_SHARE_WRITE | (share_delete ? FILE_SHARE_DELETE : 0), nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!original) { *error = GetLastError(); return false; }
  Identity before{};
  if (!QueryIdentity(original.h, &before)) { *error = GetLastError(); return false; }
  if (!IsDirectory(before) || IsReparse(before)) { *error = ERROR_DIRECTORY; return false; }
  DWORD needed = GetFinalPathNameByHandleW(original.h, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!needed) { *error = GetLastError(); return false; }
  std::vector<wchar_t> path(needed + 1);
  DWORD got = GetFinalPathNameByHandleW(original.h, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!got || got >= path.size()) { *error = GetLastError(); return false; }
  *canonical = std::wstring(path.data(), got);
  size_t anchor_end = 0;
  if (canonical->size() >= 7 && canonical->compare(0, 4, L"\\\\?\\") == 0 &&
      (*canonical)[5] == L':' && (*canonical)[6] == L'\\') {
    anchor_end = 7;
  } else if (canonical->compare(0, 8, L"\\\\?\\UNC\\") == 0) {
    size_t server = canonical->find(L'\\', 8);
    if (server != std::wstring::npos) {
      size_t share = canonical->find(L'\\', server + 1);
      anchor_end = share == std::wstring::npos ? canonical->size() : share + 1;
    }
  }
  if (!anchor_end) { *error = ERROR_NOT_SUPPORTED; return false; }
  std::wstring anchor = canonical->substr(0, anchor_end);
  Handle current(CreateFileW(anchor.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!current) { *error = GetLastError(); return false; }
  Identity anchor_id{};
  if (!QueryIdentity(current.h, &anchor_id) || !IsDirectory(anchor_id) || IsReparse(anchor_id)) {
    *error = ERROR_ACCESS_DENIED; return false;
  }
  Handle current_writable;
  if (root_ancestors) {
    Handle candidate(CreateFileW(anchor.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES |
        FILE_ADD_SUBDIRECTORY | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Identity writable_id{};
    if (candidate && QueryIdentity(candidate.h, &writable_id) && SameObject(anchor_id, writable_id) &&
        IsDirectory(writable_id) && !IsReparse(writable_id)) current_writable = std::move(candidate);
  }
  size_t position = anchor_end;
  while (position < canonical->size()) {
    size_t end = canonical->find(L'\\', position);
    if (end == std::wstring::npos) end = canonical->size();
    if (end == position) { *error = ERROR_INVALID_NAME; return false; }
    std::wstring component = canonical->substr(position, end - position);
    Handle next;
    if (stage_access && end == canonical->size()) {
      next = OpenAt(current.h, component,
          FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | WRITE_DAC | WRITE_OWNER | READ_CONTROL |
            FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY,
          FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, error,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
      Identity check{};
      if (next && (!QueryIdentity(next.h, &check) || !IsDirectory(check) || IsReparse(check))) {
        *error = ERROR_ACCESS_DENIED; return false;
      }
    } else {
      if ((!share_delete || allow_stage_final) && end == canonical->size()) {
        next = OpenAt(current.h, component, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, error,
            FILE_SHARE_READ | FILE_SHARE_WRITE | (share_delete ? FILE_SHARE_DELETE : 0));
        Identity check{};
        if (next && (!QueryIdentity(next.h, &check) || !IsDirectory(check) || IsReparse(check))) {
          *error = ERROR_ACCESS_DENIED; return false;
        }
      } else next = OpenDirAt(current.h, component, error);
      if (next && write_handle && end == canonical->size()) {
        DWORD write_error = 0;
        Handle candidate = OpenDirAt(current.h, component, &write_error,
                                    FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY);
        Identity writable_id{};
        if (candidate && QueryIdentity(candidate.h, &writable_id) && SameObject(before, writable_id))
          *write_handle = std::move(candidate);
      }
    }
    if (!next) return false;
    Handle next_writable;
    if (root_ancestors && end != canonical->size()) {
      DWORD write_error = 0;
      Handle candidate = OpenDirAt(current.h, component, &write_error, FILE_ADD_SUBDIRECTORY);
      Identity next_id{}, writable_id{};
      if (candidate && QueryIdentity(next.h, &next_id) &&
          QueryIdentity(candidate.h, &writable_id) && SameObject(next_id, writable_id))
        next_writable = std::move(candidate);
    }
    if (root_ancestors || stage_ancestors) {
      Identity ancestor_id{};
      if (!QueryIdentity(current.h, &ancestor_id)) { *error = GetLastError(); return false; }
      Ancestor ancestor;
      ancestor.handle = std::move(current);
      ancestor.writable = std::move(current_writable);
      ancestor.identity = ancestor_id;
      if (root_ancestors) root_ancestors->push_back(std::move(ancestor));
      else stage_ancestors->push_back(std::move(ancestor));
    }
    current = std::move(next);
    current_writable = std::move(next_writable);
    position = end + 1;
  }
  if (!QueryIdentity(current.h, identity)) { *error = GetLastError(); return false; }
  if (!SameObject(before, *identity) || !IsDirectory(*identity) || IsReparse(*identity)) {
    *error = ERROR_ACCESS_DENIED; return false;
  }
  if (write_handle && position == anchor_end) {
    Handle candidate(CreateFileW(anchor.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES |
        SYNCHRONIZE | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Identity writable_id{};
    if (candidate && QueryIdentity(candidate.h, &writable_id) && SameObject(before, writable_id))
      *write_handle = std::move(candidate);
  }
  *rooted = std::move(current);
  return true;
}

std::wstring JsPath(const std::wstring& canonical) {
  if (canonical.compare(0, 8, L"\\\\?\\UNC\\") == 0)
    return L"\\\\" + canonical.substr(8);
  if (canonical.compare(0, 4, L"\\\\?\\") == 0)
    return canonical.substr(4);
  return canonical;
}
bool PathContains(const std::wstring& ancestor, const std::wstring& child) {
  if (child.size() < ancestor.size()) return false;
  if (CompareStringOrdinal(ancestor.c_str(), static_cast<int>(ancestor.size()), child.c_str(),
                           static_cast<int>(ancestor.size()), TRUE) != CSTR_EQUAL) return false;
  return child.size() == ancestor.size() || ancestor.back() == L'\\' || child[ancestor.size()] == L'\\';
}
bool CurrentCanonical(HANDLE handle, std::wstring* path) {
  DWORD needed = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!needed) return false;
  std::vector<wchar_t> buffer(needed + 1);
  DWORD got = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()),
                                        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!got || got >= buffer.size()) return false;
  path->assign(buffer.data(), got);
  return true;
}
bool ConflictsStage(const Root& root, const Stage& value) {
  if (SameObject(root.identity, value.identity)) return true;
  for (const auto& ancestor : root.ancestors)
    if (SameObject(ancestor.identity, value.identity)) return true;
  for (const auto& ancestor : value.ancestors)
    if (SameObject(ancestor.identity, root.identity)) return true;
  return false;
}

bool CurrentUserSid(std::vector<uint8_t>* sid) {
  Handle token;
  HANDLE raw = INVALID_HANDLE_VALUE;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return false;
  token.reset(raw);
  DWORD needed = 0;
  GetTokenInformation(token.h, TokenUser, nullptr, 0, &needed);
  if (!needed) return false;
  std::vector<uint8_t> info(needed);
  if (!GetTokenInformation(token.h, TokenUser, info.data(), needed, &needed)) return false;
  auto user = reinterpret_cast<TOKEN_USER*>(info.data());
  DWORD length = GetLengthSid(user->User.Sid);
  sid->resize(length);
  return CopySid(length, sid->data(), user->User.Sid) != 0;
}
// Lock down the configured stage itself. Inherited user-group access from a
// temp directory is deliberately removed before this directory can be used.
bool PrivatizeStage(HANDLE handle, DWORD* error) {
  std::vector<uint8_t> sid;
  if (!CurrentUserSid(&sid)) { *error = GetLastError(); return false; }
  PSID owner = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                                 &owner, nullptr, nullptr, nullptr, &descriptor);
  if (result != ERROR_SUCCESS) { *error = result; return false; }
  bool own = EqualSid(owner, sid.data()) != 0;
  LocalFree(descriptor);
  if (!own) {
    // Elevated tokens can create directories with Administrators as their
    // default owner. Make the trusted stage's owner the actual process user
    // before removing inherited grants; otherwise another administrator
    // could change its DACL later.
    result = SetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                             sid.data(), nullptr, nullptr, nullptr);
    if (result != ERROR_SUCCESS) { *error = result; return false; }
    owner = nullptr; descriptor = nullptr;
    result = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                             &owner, nullptr, nullptr, nullptr, &descriptor);
    if (result != ERROR_SUCCESS) { *error = result; return false; }
    own = owner && EqualSid(owner, sid.data());
    LocalFree(descriptor);
    if (!own) { *error = ERROR_ACCESS_DENIED; return false; }
  }
  SID_IDENTIFIER_AUTHORITY nt_authority = SECURITY_NT_AUTHORITY;
  PSID system = nullptr;
  if (!AllocateAndInitializeSid(&nt_authority, 1, SECURITY_LOCAL_SYSTEM_RID, 0, 0, 0, 0, 0, 0, 0, &system)) {
    *error = GetLastError(); return false;
  }
  DWORD acl_bytes = sizeof(ACL) + 2 * (sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) +
                    GetLengthSid(sid.data()) + GetLengthSid(system);
  std::vector<uint8_t> memory(acl_bytes);
  PACL acl = reinterpret_cast<PACL>(memory.data());
  bool ok = InitializeAcl(acl, acl_bytes, ACL_REVISION) &&
    AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                          FILE_ALL_ACCESS, sid.data()) &&
    AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                          FILE_ALL_ACCESS, system);
  FreeSid(system);
  if (!ok) { *error = GetLastError(); return false; }
  result = SetSecurityInfo(handle, SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr);
  if (result != ERROR_SUCCESS) { *error = result; return false; }
  return true;
}

bool RandomName(std::wstring* name) {
  unsigned char bytes[16];
  if (!bcrypt_random || bcrypt_random(nullptr, bytes, sizeof(bytes), kBcryptUseSystemPreferredRng) < 0) return false;
  static const wchar_t hex[] = L"0123456789abcdef";
  *name = L".xgen-stage-";
  for (unsigned char byte : bytes) { name->push_back(hex[byte >> 4]); name->push_back(hex[byte & 15]); }
  return true;
}

bool WriteAll(HANDLE handle, uint8_t* data, size_t length, DWORD* error) {
  size_t written = 0;
  while (written < length) {
    DWORD count = 0;
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(length - written, 0x40000000));
    if (!WriteFile(handle, data + written, chunk, &count, nullptr)) { *error = GetLastError(); return false; }
    if (!count) { *error = ERROR_WRITE_FAULT; return false; }
    written += count;
  }
  return true;
}
// The NT rename structure uses the source file HANDLE and a target parent
// HANDLE. No source or target absolute pathname is re-resolved at commit.
bool RenameHeld(HANDLE source, HANDLE target_parent, const std::wstring& target,
                bool overwrite, DWORD* error) {
  struct RenameInfo {
    ULONG flags;
    HANDLE root;
    ULONG name_bytes;
    WCHAR name[1];
  };
  size_t bytes = std::max<size_t>(sizeof(RenameInfo),
      offsetof(RenameInfo, name) + target.size() * sizeof(wchar_t));
  std::vector<uint8_t> storage(bytes);
  auto info = reinterpret_cast<RenameInfo*>(storage.data());
  info->flags = overwrite ? FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS : 0;
  info->root = target_parent;
  info->name_bytes = static_cast<ULONG>(target.size() * sizeof(wchar_t));
  std::memcpy(info->name, target.data(), info->name_bytes);
  IO_STATUS_BLOCK ios{};
  NTSTATUS status = nt_set_info(source, &ios, info, static_cast<ULONG>(bytes), kFileRenameInformationEx);
  if (status < 0) { *error = DosError(status); return false; }
  return true;
}

napi_value Undefined(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }

napi_value OpenRoot(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  std::string input; std::wstring path;
  if (!GetString(env, args[0], &input) || !Utf8ToWide(input, &path)) return Throw(env, "EINVAL", "root path must be UTF-8");
  if (!NativeReady()) return Throw(env, "NATIVE_ROOTED_FS_UNAVAILABLE", "Windows native APIs are unavailable");
  auto root = std::make_shared<Root>(); DWORD error = 0;
  if (!CanonicalRoot(path, &root->handle, &root->canonical, &root->identity, &error,
                     false, &root->write_handle, true, false, &root->ancestors))
    return ThrowWin(env, "open root", error);
  std::string canonical;
  if (!WideToUtf8(JsPath(root->canonical), &canonical)) return Throw(env, "EINVAL", "root path conversion failed");
  uint64_t id = 0;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    for (const auto& item : stages) {
      if (ConflictsStage(*root, *item))
        return Throw(env, "EACCES", "root grant intersects private stage");
    }
    id = next_id++; roots[id] = root;
  }
  napi_value result, js_id;
  napi_create_object(env, &result);
  napi_create_bigint_uint64(env, id, &js_id);
  napi_set_named_property(env, result, "id", js_id);
  SetString(env, result, "canonicalPath", canonical);
  SetString(env, result, "dev", PublicDev(root->identity));
  SetString(env, result, "ino", PublicIno(root->identity));
  return result;
}
napi_value CloseRoot(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id = 0;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid root id");
  std::lock_guard<std::mutex> lock(state_mutex); roots.erase(id); return Undefined(env);
}
napi_value Stat(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, true, &root, &parts)) return nullptr;
  DWORD error = 0; Handle opened;
  if (parts.empty()) opened = Duplicate(root->handle.h, &error);
  else opened = OpenLeaf(*root, parts, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                         FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
  if (!opened) return ThrowWin(env, "rooted stat", error);
  Identity id{};
  if (!QueryIdentity(opened.h, &id)) return ThrowWin(env, "rooted stat");
  if (IsStage(id)) return Throw(env, "EACCES", "private stage is inaccessible");
  return StatObject(env, id);
}
napi_value List(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, true, &root, &parts)) return nullptr;
  DWORD error = 0;
  Handle directory = OpenDirectory(*root, parts, parts.size(), &error);
  if (!directory) return ThrowWin(env, "open rooted directory", error);
  napi_value result; napi_create_array(env, &result); uint32_t index = 0;
  std::vector<uint8_t> buffer(64 * 1024);
  FILE_INFO_BY_HANDLE_CLASS query = FileIdBothDirectoryRestartInfo;
  for (;;) {
    if (!GetFileInformationByHandleEx(directory.h, query, buffer.data(), static_cast<DWORD>(buffer.size()))) {
      error = GetLastError();
      if (error == ERROR_NO_MORE_FILES) break;
      return ThrowWin(env, "list rooted directory", error);
    }
    query = FileIdBothDirectoryInfo;
    size_t offset = 0;
    for (;;) {
      if (offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) > buffer.size())
        return Throw(env, "EIO", "invalid directory entry");
      auto item = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      if (item->FileNameLength % sizeof(wchar_t) != 0 ||
          offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + item->FileNameLength > buffer.size())
        return Throw(env, "EIO", "invalid directory name");
      std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L"..") {
        Handle child = OpenAt(directory.h, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                              FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
        if (child) {
          Identity id{};
          if (QueryIdentity(child.h, &id) && !IsStage(id)) {
            std::string utf8;
            if (WideToUtf8(name, &utf8)) {
              napi_value entry = StatObject(env, id);
              SetString(env, entry, "name", utf8);
              napi_set_element(env, result, index++, entry);
            }
          }
        }
      }
      if (!item->NextEntryOffset) break;
      if (item->NextEntryOffset > buffer.size() - offset) return Throw(env, "EIO", "invalid directory offset");
      offset += item->NextEntryOffset;
    }
  }
  return result;
}
napi_value Mkdirs(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, true, &root, &parts)) return nullptr;
  DWORD error = 0;
  if (parts.empty()) return Undefined(env);
  if (!root->write_handle) return Throw(env, "EACCES", "root is not writable");
  Handle current = Duplicate(root->write_handle.h, &error);
  if (!current) return ThrowWin(env, "duplicate root", error);
  for (const auto& part : parts) {
    Handle next = OpenAt(current.h, part, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE |
                         FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY,
                         FILE_OPEN_IF, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, &error);
    if (!next) return ThrowWin(env, "create rooted directory", error);
    Identity id{};
    if (!QueryIdentity(next.h, &id)) return ThrowWin(env, "stat rooted directory");
    if (!IsDirectory(id)) return Throw(env, "ENOTDIR", "rooted component is not a directory");
    if (IsReparse(id)) return Throw(env, "ELOOP", "rooted component is a reparse point");
    if (IsStage(id)) return Throw(env, "EACCES", "private stage is inaccessible");
    current = std::move(next);
  }
  return Undefined(env);
}
napi_value Write(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 4, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  uint8_t* data = nullptr; size_t length = 0; bool append = false;
  if (!GetUint8(env, args[2], &data, &length) || !GetBool(env, args[3], &append))
    return Throw(env, "EINVAL", "invalid write data");
  DWORD error = 0;
  Handle file = OpenLeaf(*root, parts, FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                         FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, &error,
                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, true);
  if (!file) return ThrowWin(env, "open rooted file", error);
  Identity id{};
  if (!QueryIdentity(file.h, &id)) return ThrowWin(env, "stat rooted file");
  if (!IsRegular(id)) return Throw(env, IsReparse(id) ? "ELOOP" : "EINVAL", "rooted file is not regular");
  if (IsStage(id)) return Throw(env, "EACCES", "private stage is inaccessible");
  LARGE_INTEGER position{};
  if (append) {
    position.QuadPart = 0;
    if (!SetFilePointerEx(file.h, position, nullptr, FILE_END)) return ThrowWin(env, "seek rooted file");
  } else {
    if (!SetFilePointerEx(file.h, position, nullptr, FILE_BEGIN) || !SetEndOfFile(file.h))
      return ThrowWin(env, "truncate rooted file");
  }
  if (!WriteAll(file.h, data, length, &error)) return ThrowWin(env, "write rooted file", error);
  return Undefined(env);
}
napi_value OpenSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  DWORD error = 0;
  Handle file = OpenLeaf(*root, parts, FILE_READ_DATA | FILE_READ_ATTRIBUTES,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE, &error, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  if (!file) return ThrowWin(env, "open rooted source", error);
  Identity id{};
  if (!QueryIdentity(file.h, &id)) return ThrowWin(env, "stat rooted source");
  if (!IsRegular(id)) return Throw(env, IsReparse(id) ? "ELOOP" : "EINVAL", "source is not regular");
  if (IsStage(id)) return Throw(env, "EACCES", "private stage is inaccessible");
  auto source = std::make_shared<Source>();
  source->handle = std::move(file); source->initial = id;
  uint64_t source_id = 0;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    source_id = next_id++; sources[source_id] = source;
  }
  napi_value result = StatObject(env, id), js_id;
  napi_create_bigint_uint64(env, source_id, &js_id);
  napi_set_named_property(env, result, "id", js_id);
  return result;
}
napi_value ReadSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 3, &args)) return nullptr;
  uint64_t id = 0; int64_t offset = 0; int64_t requested = 0;
  if (!GetId(env, args[0], &id) || napi_get_value_int64(env, args[1], &offset) != napi_ok ||
      napi_get_value_int64(env, args[2], &requested) != napi_ok || offset < 0 || requested < 0)
    return Throw(env, "EINVAL", "invalid source read range");
  auto source = FindSource(id);
  if (!source) return Throw(env, "NATIVE_SOURCE_CLOSED", "source handle is closed");
  Identity before{};
  if (!QueryIdentity(source->handle.h, &before) || !SameSource(before, source->initial))
    return Throw(env, "FILE_SOURCE_CHANGED", "source identity changed before read");
  uint64_t available = static_cast<uint64_t>(offset) >= source->initial.size ? 0 : source->initial.size - static_cast<uint64_t>(offset);
  size_t length = static_cast<size_t>(std::min<uint64_t>(available, static_cast<uint64_t>(requested)));
  void* raw = nullptr; napi_value buffer;
  if (napi_create_buffer(env, length, &raw, &buffer) != napi_ok) return Throw(env, "ENOMEM", "allocate read buffer");
  size_t done = 0;
  while (done < length) {
    uint64_t at = static_cast<uint64_t>(offset) + done;
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(length - done, 0x40000000));
    OVERLAPPED overlapped{};
    overlapped.Offset = static_cast<DWORD>(at);
    overlapped.OffsetHigh = static_cast<DWORD>(at >> 32);
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event) return ThrowWin(env, "create source read event");
    overlapped.hEvent = event.h;
    DWORD got = 0;
    BOOL success = ReadFile(source->handle.h, static_cast<uint8_t*>(raw) + done, chunk, nullptr, &overlapped);
    if (!success && GetLastError() != ERROR_IO_PENDING) return ThrowWin(env, "read source");
    if (!GetOverlappedResult(source->handle.h, &overlapped, &got, TRUE)) return ThrowWin(env, "complete source read");
    if (!got) break;
    done += got;
  }
  Identity after{};
  if (!QueryIdentity(source->handle.h, &after) || !SameSource(after, source->initial) || done != length)
    return Throw(env, "FILE_SOURCE_CHANGED", "source identity changed during read");
  return buffer;
}
napi_value StatSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id = 0;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid source id");
  auto source = FindSource(id);
  if (!source) return Throw(env, "NATIVE_SOURCE_CLOSED", "source handle is closed");
  Identity current{};
  if (!QueryIdentity(source->handle.h, &current) || !SameSource(current, source->initial))
    return Throw(env, "FILE_SOURCE_CHANGED", "source identity changed");
  return StatObject(env, current);
}
napi_value CloseSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id = 0;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid source id");
  std::lock_guard<std::mutex> lock(state_mutex); sources.erase(id); return Undefined(env);
}
napi_value ConfigureStage(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 1, &args)) return nullptr;
  std::string input; std::wstring path;
  if (!GetString(env, args[0], &input) || !Utf8ToWide(input, &path)) return Throw(env, "EINVAL", "stage path must be UTF-8");
  if (!NativeReady()) return Throw(env, "NATIVE_ROOTED_FS_UNAVAILABLE", "Windows native APIs are unavailable");
  auto value = std::make_shared<Stage>(); DWORD error = 0;
  if (!CanonicalRoot(path, &value->handle, &value->canonical, &value->identity, &error,
                     true, nullptr, true, false, nullptr, &value->ancestors))
    return ThrowWin(env, "open stage", error);
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    for (const auto& item : roots) {
      if (ConflictsStage(*item.second, *value))
        return Throw(env, "EACCES", "private stage intersects an existing grant");
    }
  }
  if (!PrivatizeStage(value->handle.h, &error)) return ThrowWin(env, "make stage private", error);
  // The pinned name and handle must still identify the same object after ACL updates.
  Identity after{};
  if (!QueryIdentity(value->handle.h, &after) || !SameObject(after, value->identity))
    return Throw(env, "EIO", "private stage identity changed");
  std::string canonical;
  if (!WideToUtf8(JsPath(value->canonical), &canonical)) return Throw(env, "EINVAL", "stage path conversion failed");
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    for (const auto& item : roots) {
      if (ConflictsStage(*item.second, *value))
        return Throw(env, "EACCES", "private stage intersects an existing grant");
    }
    stage = value;
    stages.push_back(value);
  }
  napi_value result;
  napi_create_string_utf8(env, canonical.c_str(), canonical.size(), &result);
  return result;
}

bool ParseExpected(napi_env env, napi_value value, bool* present, std::string* dev,
                   std::string* ino, std::string* size, std::string* mtime, std::string* ctime) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_undefined || type == napi_null) { *present = false; return true; }
  if (type != napi_object) return false;
  auto read_string = [&](const char* name, std::string* out) {
    napi_value property;
    return napi_get_named_property(env, value, name, &property) == napi_ok && GetString(env, property, out);
  };
  *present = true;
  return read_string("dev", dev) && read_string("ino", ino) &&
    read_string("size", size) && read_string("mtimeNs", mtime) &&
    read_string("ctimeNs", ctime);
}
bool ExpectedMatches(const Identity& id, const std::string& dev, const std::string& ino,
                     const std::string& size, const std::string& mtime, const std::string& ctime) {
  constexpr uint64_t epoch = 116444736000000000ULL;
  uint64_t modified = FileTimeTicks(id.modified);
  uint64_t changed = FileTimeTicks(id.changed);
  return IsRegular(id) && dev == PublicDev(id) &&
    ino == PublicIno(id) && size == std::to_string(id.size) &&
    mtime == std::to_string(modified >= epoch ? (modified - epoch) * 100 : 0) &&
    ctime == std::to_string(changed >= epoch ? (changed - epoch) * 100 : 0);
}
napi_value WriteExpected(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 4, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  uint8_t* data = nullptr; size_t length = 0;
  if (!GetUint8(env, args[2], &data, &length)) return Throw(env, "EINVAL", "invalid expected write data");
  bool expected_present = false; std::string dev, ino, size, mtime, ctime;
  if (!ParseExpected(env, args[3], &expected_present, &dev, &ino, &size, &mtime, &ctime) ||
      !expected_present) return Throw(env, "EINVAL", "expected write requires a file identity");
  DWORD error = 0;
  Handle file = OpenLeaf(*root, parts,
      FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, &error);
  if (!file) return ThrowWin(env, "open expected write target", error);
  Identity before{};
  if (!QueryIdentity(file.h, &before)) return ThrowWin(env, "stat expected write target");
  if (IsStage(before) || !ExpectedMatches(before, dev, ino, size, mtime, ctime))
    return Throw(env, "FILE_SOURCE_CHANGED", "expected write target identity changed");
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(file.h, start, nullptr, FILE_BEGIN) || !SetEndOfFile(file.h))
    return ThrowWin(env, "truncate expected write target");
  if (!WriteAll(file.h, data, length, &error)) return ThrowWin(env, "write expected target", error);
  if (!FlushFileBuffers(file.h)) return ThrowWin(env, "flush expected target");
  return Undefined(env);
}
napi_value SetMode(napi_env env, napi_callback_info) {
  return Throw(env, "ENOTSUP", "POSIX file mode is unsupported on Windows");
}
std::string AceSummary(const ACE_HEADER* ace) {
  if (!ace) return "absent";
  std::ostringstream out;
  out << "type=" << static_cast<unsigned>(ace->AceType)
      << ",flags=" << static_cast<unsigned>(ace->AceFlags)
      << ",bytes=" << ace->AceSize;
  if (ace->AceSize >= sizeof(ACE_HEADER) + sizeof(ACCESS_MASK)) {
    ACCESS_MASK mask = 0;
    std::memcpy(&mask, reinterpret_cast<const uint8_t*>(ace) + sizeof(ACE_HEADER), sizeof(mask));
    out << ",mask=" << std::hex << mask;
  }
  return out.str();
}
PSID SimpleAceSid(const ACE_HEADER* ace) {
  if (!ace || ace->AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + sizeof(DWORD)) return nullptr;
  if (ace->AceType != ACCESS_ALLOWED_ACE_TYPE && ace->AceType != ACCESS_DENIED_ACE_TYPE &&
      ace->AceType != SYSTEM_AUDIT_ACE_TYPE && ace->AceType != SYSTEM_ALARM_ACE_TYPE)
    return nullptr;
  PSID sid = const_cast<DWORD*>(&reinterpret_cast<const ACCESS_ALLOWED_ACE*>(ace)->SidStart);
  size_t sid_bytes = ace->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart);
  if (sid_bytes < 8) return nullptr;
  auto sid_header = reinterpret_cast<const uint8_t*>(sid);
  if (8 + static_cast<size_t>(sid_header[1]) * sizeof(DWORD) > sid_bytes) return nullptr;
  return IsValidSid(sid) ? sid : nullptr;
}
bool SameAclEntries(PACL left, PACL right, std::string* difference) {
  if (!left || !right) {
    if (left == right) return true;
    *difference = "one DACL is null"; return false;
  }
  if (!IsValidAcl(left) || !IsValidAcl(right)) {
    *difference = "invalid DACL"; return false;
  }
  std::ostringstream report;
  report << "target ACE count=" << left->AceCount << ", staged ACE count=" << right->AceCount;
  bool equal = left->AceCount == right->AceCount;
  DWORD common = std::min<DWORD>(left->AceCount, right->AceCount);
  for (DWORD index = 0; index < common; ++index) {
    void* left_ace = nullptr;
    void* right_ace = nullptr;
    if (!GetAce(left, index, &left_ace) || !GetAce(right, index, &right_ace)) {
      *difference = report.str() + ", ACE lookup failed"; return false;
    }
    auto left_header = static_cast<const ACE_HEADER*>(left_ace);
    auto right_header = static_cast<const ACE_HEADER*>(right_ace);
    if (left_header->AceSize != right_header->AceSize ||
        std::memcmp(left_ace, right_ace, left_header->AceSize) != 0) {
      PSID left_sid = SimpleAceSid(left_header);
      PSID right_sid = SimpleAceSid(right_header);
      report << ", first difference at ACE " << index << ": target{" << AceSummary(left_header)
             << "}, staged{" << AceSummary(right_header) << "}, SID equal="
             << (left_sid && right_sid && EqualSid(left_sid, right_sid) ? "true" : "false/unknown");
      *difference = report.str(); return false;
    }
  }
  if (!equal) {
    void* extra = nullptr;
    PACL longer = left->AceCount > right->AceCount ? left : right;
    if (GetAce(longer, common, &extra))
      report << ", first extra " << (longer == left ? "target" : "staged")
             << " ACE{" << AceSummary(static_cast<const ACE_HEADER*>(extra)) << "}";
    *difference = report.str();
  }
  return equal;
}
// Preserve the target file's owner, DACL, and inheritance controls before the
// staged file becomes visible. A same-volume rename keeps its descriptor.
bool CopyTargetSecurity(HANDLE target, HANDLE staged, DWORD* error, std::string* difference) {
  PSID target_owner = nullptr;
  PACL target_dacl = nullptr;
  PSECURITY_DESCRIPTOR target_descriptor = nullptr;
  DWORD result = GetSecurityInfo(target, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &target_owner, nullptr, &target_dacl, nullptr, &target_descriptor);
  if (result != ERROR_SUCCESS) { *error = result; return false; }
  SECURITY_DESCRIPTOR_CONTROL target_control{};
  DWORD target_revision = 0;
  if (!GetSecurityDescriptorControl(target_descriptor, &target_control, &target_revision)) {
    *error = GetLastError(); LocalFree(target_descriptor); return false;
  }
  PSID stage_owner = nullptr;
  PSECURITY_DESCRIPTOR stage_descriptor = nullptr;
  result = GetSecurityInfo(staged, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                           &stage_owner, nullptr, nullptr, nullptr, &stage_descriptor);
  if (result != ERROR_SUCCESS) {
    LocalFree(target_descriptor); *error = result; return false;
  }
  bool same_owner = target_owner && stage_owner && EqualSid(target_owner, stage_owner);
  LocalFree(stage_descriptor);
  if (!target_owner) {
    LocalFree(target_descriptor); *error = ERROR_INVALID_OWNER; return false;
  }
  if (!same_owner) {
    result = SetSecurityInfo(staged, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                             target_owner, nullptr, nullptr, nullptr);
    if (result != ERROR_SUCCESS) {
      LocalFree(target_descriptor); *error = result; return false;
    }
  }
  // SetSecurityInfo on an unprotected stage file retains/recomputes ACEs
  // inherited from the private stage directory. First protect that temporary
  // DACL, then apply the complete target descriptor with NtSetSecurityObject.
  // For a protected current DACL and an unprotected input DACL, Windows'
  // SeSetSecurityDescriptorInfoEx rules copy the input inherited ACEs as-is.
  // The exact readback below is mandatory before the staged file is visible.
  PACL stage_dacl = nullptr;
  PSECURITY_DESCRIPTOR stage_dacl_descriptor = nullptr;
  result = GetSecurityInfo(staged, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                           nullptr, nullptr, &stage_dacl, nullptr, &stage_dacl_descriptor);
  if (result != ERROR_SUCCESS) {
    LocalFree(target_descriptor); *error = result; return false;
  }
  result = SetSecurityInfo(staged, SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, stage_dacl, nullptr);
  LocalFree(stage_dacl_descriptor);
  if (result != ERROR_SUCCESS) {
    LocalFree(target_descriptor); *error = result; return false;
  }
  if (!nt_set_security) {
    LocalFree(target_descriptor); *error = ERROR_NOT_SUPPORTED; return false;
  }
  NTSTATUS status = nt_set_security(staged, DACL_SECURITY_INFORMATION, target_descriptor);
  if (status != kStatusSuccess) {
    LocalFree(target_descriptor); *error = DosError(status); return false;
  }
  PSID final_owner = nullptr;
  PACL final_dacl = nullptr;
  PSECURITY_DESCRIPTOR final_descriptor = nullptr;
  result = GetSecurityInfo(staged, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &final_owner, nullptr, &final_dacl, nullptr, &final_descriptor);
  if (result != ERROR_SUCCESS) {
    LocalFree(target_descriptor); *error = result; return false;
  }
  SECURITY_DESCRIPTOR_CONTROL final_control{};
  DWORD final_revision = 0;
  bool control_ok = GetSecurityDescriptorControl(final_descriptor, &final_control, &final_revision);
  constexpr SECURITY_DESCRIPTOR_CONTROL relevant_control =
      SE_DACL_PRESENT | SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED;
  bool dacl_equal = SameAclEntries(target_dacl, final_dacl, difference);
  bool owner_equal = final_owner && EqualSid(target_owner, final_owner);
  bool inheritance_equal = (target_control & relevant_control) ==
      (final_control & relevant_control);
  bool same = control_ok && owner_equal && dacl_equal && inheritance_equal;
  if (!control_ok) *error = GetLastError();
  LocalFree(final_descriptor);
  LocalFree(target_descriptor);
  if (!same) {
    if (control_ok) *error = !owner_equal ? ERROR_INVALID_OWNER :
        !dacl_equal ? ERROR_INVALID_ACL : ERROR_NOT_SUPPORTED;
    return false;
  }
  return true;
}
bool VerifyStageName(const Stage& value, const std::wstring& name, const Identity& expected, DWORD* error) {
  Handle visible = OpenAt(value.handle.h, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                          FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, error);
  if (!visible) return false;
  Identity current{};
  if (!QueryIdentity(visible.h, &current)) { *error = GetLastError(); return false; }
  if (!SameObject(current, expected) || !IsRegular(current)) { *error = ERROR_ACCESS_DENIED; return false; }
  return true;
}
bool VerifyPinnedStagePath(const Stage& value, DWORD* error) {
  Handle visible; std::wstring canonical; Identity id{};
  if (!CanonicalRoot(value.canonical, &visible, &canonical, &id, error, false, nullptr, true, true)) return false;
  if (!SameObject(id, value.identity)) { *error = ERROR_ACCESS_DENIED; return false; }
  return true;
}
napi_value OpenStageSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 1, &args)) return nullptr;
  std::string relative;
  std::vector<std::wstring> parts;
  if (!GetString(env, args[0], &relative) || !SplitRelative(relative, false, &parts))
    return Throw(env, "PATH_DOMAIN_MISMATCH", "invalid private stage relative path");
  std::shared_ptr<Stage> private_stage;
  { std::lock_guard<std::mutex> lock(state_mutex); private_stage = stage; }
  if (!private_stage)
    return Throw(env, "WORKSPACE_ATOMIC_STAGE_UNCONFIGURED", "private stage is not configured");
  DWORD error = 0;
  if (!VerifyPinnedStagePath(*private_stage, &error))
    return ThrowWin(env, "verify private stage directory", error);
  Handle parent = Duplicate(private_stage->handle.h, &error);
  if (!parent) return ThrowWin(env, "duplicate private stage", error);
  for (size_t i = 0; i + 1 < parts.size(); ++i) {
    Handle next = OpenDirAt(parent.h, parts[i], &error);
    if (!next) return ThrowWin(env, "open private stage source parent", error);
    parent = std::move(next);
  }
  Handle file = OpenAt(parent.h, parts.back(), FILE_READ_DATA | FILE_READ_ATTRIBUTES,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE, &error);
  if (!file) return ThrowWin(env, "open private stage source", error);
  Identity id{};
  if (!QueryIdentity(file.h, &id)) return ThrowWin(env, "stat private stage source");
  if (!IsRegular(id) || IsStage(id))
    return Throw(env, IsReparse(id) ? "ELOOP" : "EINVAL", "private stage source is not regular");
  auto source = std::make_shared<Source>();
  source->handle = std::move(file);
  source->initial = id;
  uint64_t source_id = 0;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    source_id = next_id++;
    sources[source_id] = source;
  }
  napi_value result = StatObject(env, id), js_id;
  napi_create_bigint_uint64(env, source_id, &js_id);
  napi_set_named_property(env, result, "id", js_id);
  return result;
}
void DeleteEmptyStage(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition));
}
std::shared_ptr<Stage> CreatePrivateStageAt(HANDLE parent, DWORD* error) {
  std::vector<uint8_t> user;
  if (!CurrentUserSid(&user)) { *error = GetLastError(); return nullptr; }
  SID_IDENTIFIER_AUTHORITY nt_authority = SECURITY_NT_AUTHORITY;
  PSID system = nullptr;
  if (!AllocateAndInitializeSid(&nt_authority, 1, SECURITY_LOCAL_SYSTEM_RID,
      0, 0, 0, 0, 0, 0, 0, &system)) { *error = GetLastError(); return nullptr; }
  DWORD acl_bytes = sizeof(ACL) + 2 * (sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) +
      GetLengthSid(user.data()) + GetLengthSid(system);
  std::vector<uint8_t> acl_memory(acl_bytes);
  PACL acl = reinterpret_cast<PACL>(acl_memory.data());
  SECURITY_DESCRIPTOR descriptor{};
  bool security_ok = InitializeAcl(acl, acl_bytes, ACL_REVISION) &&
      AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                            FILE_ALL_ACCESS, user.data()) &&
      AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                            FILE_ALL_ACCESS, system) &&
      InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
      SetSecurityDescriptorOwner(&descriptor, user.data(), FALSE) &&
      SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) &&
      SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED);
  if (!security_ok) { *error = GetLastError(); FreeSid(system); return nullptr; }
  std::wstring name; Handle directory;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) { *error = ERROR_GEN_FAILURE; break; }
    directory = OpenAt(parent, name,
      DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | WRITE_OWNER |
        FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | SYNCHRONIZE,
      FILE_CREATE, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, error,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      &descriptor, FILE_ATTRIBUTE_DIRECTORY);
    if (directory || *error != ERROR_ALREADY_EXISTS && *error != ERROR_FILE_EXISTS) break;
  }
  FreeSid(system);
  if (!directory) return nullptr;
  auto value = std::make_shared<Stage>();
  value->handle = std::move(directory);
  if (!QueryIdentity(value->handle.h, &value->identity)) {
    *error = GetLastError(); DeleteEmptyStage(value->handle.h); return nullptr;
  }
  if (!IsDirectory(value->identity) || IsReparse(value->identity)) {
    *error = ERROR_ACCESS_DENIED; DeleteEmptyStage(value->handle.h); return nullptr;
  }
  if (!CurrentCanonical(value->handle.h, &value->canonical)) {
    *error = GetLastError(); DeleteEmptyStage(value->handle.h); return nullptr;
  }
  if (!PrivatizeStage(value->handle.h, error)) {
    DeleteEmptyStage(value->handle.h);
    return nullptr;
  }
  Identity after{};
  if (!QueryIdentity(value->handle.h, &after) || !SameObject(after, value->identity) ||
      !VerifyPinnedStagePath(*value, error)) {
    if (!*error) *error = ERROR_ACCESS_DENIED;
    DeleteEmptyStage(value->handle.h);
    return nullptr;
  }
  return value;
}
std::shared_ptr<Stage> StageForVolume(const Root& root, const Identity& target_id, DWORD* error) {
  // Serializes provisioning; grants still race safely with the final registry
  // insertion because both additions verify disjointness under state_mutex.
  std::lock_guard<std::mutex> create_lock(stage_creation_mutex);
  std::vector<std::shared_ptr<Stage>> existing;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    existing = stages;
  }
  // Prefer the latest configured stage and never reuse a deleted or replaced
  // directory. The pathname verifier takes state_mutex while traversing, so
  // it must run outside the registry lock.
  for (auto item = existing.rbegin(); item != existing.rend(); ++item) {
    DWORD verify_error = 0;
    if ((*item)->identity.file_id.VolumeSerialNumber == target_id.file_id.VolumeSerialNumber &&
        VerifyPinnedStagePath(**item, &verify_error)) return *item;
  }
  if (root.identity.file_id.VolumeSerialNumber != target_id.file_id.VolumeSerialNumber) {
    *error = ERROR_NOT_SAME_DEVICE; return nullptr;
  }
  // These ancestor handles were pinned while the approved root was opened
  // from its volume anchor. No parent pathname is resolved during staging.
  for (size_t depth = root.ancestors.size(); depth > 0; --depth) {
    size_t index = depth - 1;
    const Ancestor& candidate_parent = root.ancestors[index];
    if (candidate_parent.identity.file_id.VolumeSerialNumber != target_id.file_id.VolumeSerialNumber)
      continue;
    std::vector<std::shared_ptr<Root>> active_roots;
    {
      std::lock_guard<std::mutex> lock(state_mutex);
      for (const auto& item : roots) active_roots.push_back(item.second);
    }
    bool inside_grant = false;
    for (const auto& grant : active_roots) {
      if (SameObject(grant->identity, candidate_parent.identity)) {
        inside_grant = true; break;
      }
      for (size_t earlier = 0; earlier < index; ++earlier) {
        if (SameObject(grant->identity, root.ancestors[earlier].identity)) {
          inside_grant = true; break;
        }
      }
      if (inside_grant) break;
    }
    if (!inside_grant && candidate_parent.writable) {
      Identity pinned{};
      if (!QueryIdentity(candidate_parent.writable.h, &pinned) ||
          !SameObject(pinned, candidate_parent.identity) || !IsDirectory(pinned) || IsReparse(pinned)) {
        *error = ERROR_ACCESS_DENIED; return nullptr;
      }
      auto candidate = CreatePrivateStageAt(candidate_parent.writable.h, error);
      if (candidate) {
        for (size_t earlier = 0; earlier <= index; ++earlier) {
          Ancestor retained;
          retained.handle = Duplicate(root.ancestors[earlier].handle.h, error);
          if (!retained.handle) { DeleteEmptyStage(candidate->handle.h); return nullptr; }
          retained.identity = root.ancestors[earlier].identity;
          candidate->ancestors.push_back(std::move(retained));
        }
        std::lock_guard<std::mutex> lock(state_mutex);
        bool conflicts = false;
        for (const auto& item : roots) {
          if (ConflictsStage(*item.second, *candidate)) { conflicts = true; break; }
        }
        if (!conflicts) {
          stages.push_back(candidate);
          return candidate;
        }
        DeleteEmptyStage(candidate->handle.h);
        *error = ERROR_ACCESS_DENIED;
        return nullptr;
      }
      if (*error != ERROR_ACCESS_DENIED && *error != ERROR_PRIVILEGE_NOT_HELD)
        return nullptr;
    }
  }
  *error = ERROR_NOT_SUPPORTED;
  return nullptr;
}
void DeleteStaged(HANDLE stage_handle, const std::wstring& name) {
  DWORD error = 0;
  Handle file = OpenAt(stage_handle, name, DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                       FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, &error);
  if (!file) return;
  FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
  SetFileInformationByHandle(file.h, FileDispositionInfo, &disposition, sizeof(disposition));
}
napi_value AtomicWrite(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 4, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  uint8_t* data = nullptr; size_t length = 0; bool overwrite = false;
  if (!GetUint8(env, args[2], &data, &length) || !GetBool(env, args[3], &overwrite))
    return Throw(env, "EINVAL", "invalid atomic write data");
  bool expected_present = false; std::string dev, ino, size, mtime, ctime;
  size_t count = 5; napi_value full[5]{};
  if (napi_get_cb_info(env, info, &count, full, nullptr, nullptr) != napi_ok)
    return Throw(env, "EINVAL", "invalid expected target");
  if (count >= 5) {
    napi_value expected = full[4];
    if (!ParseExpected(env, expected, &expected_present, &dev, &ino, &size, &mtime, &ctime))
      return Throw(env, "EINVAL", "invalid expected target");
  }
  { std::lock_guard<std::mutex> lock(state_mutex);
    if (!stage) return Throw(env, "WORKSPACE_ATOMIC_STAGE_UNCONFIGURED", "private stage is not configured"); }
  DWORD error = 0;
  Handle parent = OpenDirectory(*root, parts, parts.size() - 1, &error, true);
  if (!parent) return ThrowWin(env, "open atomic target parent", error);
  Identity parent_id{};
  if (!QueryIdentity(parent.h, &parent_id)) return ThrowWin(env, "stat atomic target parent");
  if (expected_present) {
    Handle initial_target = OpenAt(parent.h, parts.back(), FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
    Identity initial_id{};
    if (!initial_target || !QueryIdentity(initial_target.h, &initial_id) ||
        !IsRegular(initial_id) || !ExpectedMatches(initial_id, dev, ino, size, mtime, ctime))
      return Throw(env, "FILE_SOURCE_CHANGED", "atomic target identity changed");
  }
  std::shared_ptr<Stage> private_stage = StageForVolume(*root, parent_id, &error);
  if (!private_stage) return ThrowWin(env, "select private stage for target volume", error);
  std::wstring name; Handle source;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) return Throw(env, "EIO", "generate private stage name");
    source = OpenAt(private_stage->handle.h, name,
      DELETE | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | WRITE_OWNER | SYNCHRONIZE,
      FILE_CREATE, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, &error,
      FILE_SHARE_READ | FILE_SHARE_WRITE);
    if (source || error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) break;
  }
  if (!source) return ThrowWin(env, "create private stage file", error);
  bool staged = true;
  auto cleanup = [&]() {
    if (!staged) return;
    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    bool delete_on_close = source &&
        SetFileInformationByHandle(source.h, FileDispositionInfo, &disposition, sizeof(disposition));
    source.reset();
    if (!delete_on_close) DeleteStaged(private_stage->handle.h, name);
  };
  if (!WriteAll(source.h, data, length, &error)) { cleanup(); return ThrowWin(env, "write private stage", error); }
  if (!FlushFileBuffers(source.h)) { error = GetLastError(); cleanup(); return ThrowWin(env, "flush private stage", error); }
  Identity source_id{};
  if (!QueryIdentity(source.h, &source_id) || !IsRegular(source_id) ||
      !VerifyStageName(*private_stage, name, source_id, &error)) {
    if (!error) error = GetLastError();
    cleanup(); return ThrowWin(env, "verify private stage file", error);
  }
  if (!VerifyPinnedStagePath(*private_stage, &error)) {
    cleanup(); return ThrowWin(env, "verify private stage directory", error);
  }
  if (overwrite || expected_present) {
    Handle target = OpenAt(parent.h, parts.back(),
        READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
    if (!target) {
      if (expected_present) {
        cleanup(); return Throw(env, "FILE_SOURCE_CHANGED", "atomic target identity changed");
      }
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) {
        cleanup(); return ThrowWin(env, "open atomic target security", error);
      }
    } else {
      Identity target_id{};
      if (!QueryIdentity(target.h, &target_id)) {
        error = GetLastError(); cleanup(); return ThrowWin(env, "stat atomic target security", error);
      }
      if (expected_present && (!IsRegular(target_id) ||
          !ExpectedMatches(target_id, dev, ino, size, mtime, ctime))) {
        cleanup(); return Throw(env, "FILE_SOURCE_CHANGED", "atomic target identity changed");
      }
      std::string security_difference;
      if (overwrite && IsRegular(target_id) &&
          !CopyTargetSecurity(target.h, source.h, &error, &security_difference)) {
        cleanup();
        return Throw(env, WinCode(error), "preserve atomic target security: Windows error " +
            std::to_string(error) + (security_difference.empty() ? "" : ": " + security_difference));
      }
    }
  }
  if (!RenameHeld(source.h, parent.h, parts.back(), overwrite, &error)) {
    cleanup(); return ThrowWin(env, "commit rooted file", error);
  }
  staged = false;
  return Undefined(env);
}

napi_value RenameNoReplace(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 3, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> source_parts, target_parts;
  if (!RootAndPath(env, args, false, &root, &source_parts)) return nullptr;
  std::string target_text;
  if (!GetString(env, args[2], &target_text) || !SplitRelative(target_text, false, &target_parts))
    return Throw(env, "PATH_DOMAIN_MISMATCH", "invalid target path");
  DWORD error = 0;
  Handle source = OpenLeaf(*root, source_parts, DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
  if (!source) return ThrowWin(env, "open rooted move source", error);
  Identity source_id{};
  if (!QueryIdentity(source.h, &source_id)) return ThrowWin(env, "stat rooted move source");
  if (IsReparse(source_id) || IsStage(source_id))
    return Throw(env, "ELOOP", "move source is a reparse point or private stage");
  Handle parent = OpenDirectory(*root, target_parts, target_parts.size() - 1, &error, true);
  if (!parent) return ThrowWin(env, "open rooted move target", error);
  Identity parent_id{};
  if (!QueryIdentity(parent.h, &parent_id)) return ThrowWin(env, "stat rooted move target");
  if (parent_id.file_id.VolumeSerialNumber != source_id.file_id.VolumeSerialNumber)
    return Throw(env, "EXDEV", "move crosses volumes");
  if (!RenameHeld(source.h, parent.h, target_parts.back(), false, &error))
    return ThrowWin(env, "move rooted entry", error);
  return Undefined(env);
}
napi_value MoveToStage(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> source_parts;
  if (!RootAndPath(env, args, false, &root, &source_parts)) return nullptr;
  { std::lock_guard<std::mutex> lock(state_mutex);
    if (!stage) return Throw(env, "WORKSPACE_ATOMIC_STAGE_UNCONFIGURED", "private stage is not configured"); }
  DWORD error = 0;
  Handle source_parent = OpenDirectory(*root, source_parts, source_parts.size() - 1, &error);
  if (!source_parent) return ThrowWin(env, "open rooted stage source parent", error);
  Handle source = OpenAt(source_parent.h, source_parts.back(),
      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN,
      FILE_SYNCHRONOUS_IO_NONALERT, &error);
  if (!source) return ThrowWin(env, "open rooted stage source", error);
  Identity source_id{};
  if (!QueryIdentity(source.h, &source_id)) return ThrowWin(env, "stat rooted stage source");
  if (IsReparse(source_id) || IsStage(source_id))
    return Throw(env, "ELOOP", "stage source is a reparse point or private stage");
  std::shared_ptr<Stage> private_stage = StageForVolume(*root, source_id, &error);
  if (!private_stage) return ThrowWin(env, "select private stage for source volume", error);
  if (!VerifyPinnedStagePath(*private_stage, &error)) return ThrowWin(env, "verify private stage directory", error);
  std::wstring name;
  bool moved = false;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) return Throw(env, "EIO", "generate private stage name");
    if (RenameHeld(source.h, private_stage->handle.h, name, false, &error)) { moved = true; break; }
    if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) break;
  }
  if (!moved) return ThrowWin(env, "move entry to private stage", error);
  // A failed post-rename verification is reported and the entry remains under
  // the private stage; the caller never receives an untrusted pathname.
  Handle visible = OpenAt(private_stage->handle.h, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
  Identity visible_id{};
  if (!visible || !QueryIdentity(visible.h, &visible_id) || !SameObject(visible_id, source_id) ||
      !VerifyPinnedStagePath(*private_stage, &error))
    return Throw(env, "EIO", "private stage identity changed after move");
  std::wstring full = private_stage->canonical;
  if (full.empty() || full.back() != L'\\') full.push_back(L'\\');
  full += name;
  std::string utf8;
  if (!WideToUtf8(JsPath(full), &utf8)) return Throw(env, "EIO", "stage path conversion failed");
  napi_value result; napi_create_string_utf8(env, utf8.c_str(), utf8.size(), &result); return result;
}

napi_value BeginQuarantine(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  { std::lock_guard<std::mutex> lock(state_mutex);
    if (!stage) return Throw(env, "WORKSPACE_ATOMIC_STAGE_UNCONFIGURED", "private stage is not configured"); }
  DWORD error = 0;
  Handle parent = OpenDirectory(*root, parts, parts.size() - 1, &error, true);
  if (!parent) return ThrowWin(env, "open quarantine source parent", error);
  Handle source = OpenAt(parent.h, parts.back(), DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
  if (!source) return ThrowWin(env, "open quarantine source", error);
  Identity source_id{};
  if (!QueryIdentity(source.h, &source_id)) return ThrowWin(env, "stat quarantine source");
  if (IsReparse(source_id) || IsStage(source_id))
    return Throw(env, "ELOOP", "quarantine source is a reparse point or private stage");
  auto private_stage = StageForVolume(*root, source_id, &error);
  if (!private_stage) return ThrowWin(env, "select private quarantine stage", error);
  if (!VerifyPinnedStagePath(*private_stage, &error))
    return ThrowWin(env, "verify private quarantine stage", error);
  std::wstring name;
  bool moved = false;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) return Throw(env, "EIO", "generate quarantine name");
    if (RenameHeld(source.h, private_stage->handle.h, name, false, &error)) { moved = true; break; }
    if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) break;
  }
  if (!moved) return ThrowWin(env, "move entry to quarantine", error);
  Handle visible = OpenAt(private_stage->handle.h, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, &error);
  Identity visible_id{};
  bool valid = visible && QueryIdentity(visible.h, &visible_id) &&
      SameObject(visible_id, source_id) && VerifyPinnedStagePath(*private_stage, &error);
  std::wstring full = private_stage->canonical;
  if (full.empty() || full.back() != L'\\') full.push_back(L'\\');
  full += name;
  std::string utf8;
  valid = valid && WideToUtf8(JsPath(full), &utf8);
  if (!valid) {
    DWORD rollback_error = 0;
    RenameHeld(source.h, parent.h, parts.back(), false, &rollback_error);
    return Throw(env, "EIO", "quarantine identity changed after move");
  }
  auto item = std::make_shared<Quarantine>();
  item->source = std::move(source);
  item->original_parent = std::move(parent);
  item->original_name = parts.back();
  item->private_stage = private_stage;
  uint64_t token = 0;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    token = next_id++;
    quarantines[token] = item;
  }
  napi_value result, js_token, js_path;
  napi_create_object(env, &result);
  napi_create_bigint_uint64(env, token, &js_token);
  napi_create_string_utf8(env, utf8.c_str(), utf8.size(), &js_path);
  napi_set_named_property(env, result, "token", js_token);
  napi_set_named_property(env, result, "path", js_path);
  return result;
}
napi_value RollbackQuarantine(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t token = 0;
  if (!GetId(env, args[0], &token)) return Throw(env, "EINVAL", "invalid quarantine token");
  auto item = FindQuarantine(token);
  if (!item) return Throw(env, "NATIVE_QUARANTINE_CLOSED", "quarantine token is closed");
  std::lock_guard<std::mutex> item_lock(item->mutex);
  if (item->finished || item->restored)
    return Throw(env, "NATIVE_QUARANTINE_CLOSED", "quarantine token is closed");
  DWORD error = 0;
  if (!RenameHeld(item->source.h, item->original_parent.h, item->original_name, false, &error))
    return ThrowWin(env, "restore quarantined entry", error);
  item->restored = true;
  return Undefined(env);
}
napi_value FinishQuarantine(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t token = 0;
  if (!GetId(env, args[0], &token)) return Throw(env, "EINVAL", "invalid quarantine token");
  auto item = FindQuarantine(token);
  if (!item) return Throw(env, "NATIVE_QUARANTINE_CLOSED", "quarantine token is closed");
  std::lock_guard<std::mutex> item_lock(item->mutex);
  if (item->finished) return Throw(env, "NATIVE_QUARANTINE_CLOSED", "quarantine token is closed");
  item->finished = true;
  { std::lock_guard<std::mutex> lock(state_mutex); quarantines.erase(token); }
  return Undefined(env);
}


napi_value CopyFileNoReplace(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; if (!Args(env, info, 3, &args)) return nullptr;
  std::shared_ptr<Root> root; std::vector<std::wstring> source_parts, target_parts;
  if (!RootAndPath(env, args, false, &root, &source_parts)) return nullptr;
  std::string target_text;
  if (!GetString(env, args[2], &target_text) || !SplitRelative(target_text, false, &target_parts))
    return Throw(env, "PATH_DOMAIN_MISMATCH", "invalid target path");
  { std::lock_guard<std::mutex> lock(state_mutex);
    if (!stage) return Throw(env, "WORKSPACE_ATOMIC_STAGE_UNCONFIGURED", "private stage is not configured"); }
  DWORD error = 0;
  Handle source = OpenLeaf(*root, source_parts,
      FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, &error,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  if (!source) return ThrowWin(env, "open rooted copy source", error);
  Identity original{};
  if (!QueryIdentity(source.h, &original)) return ThrowWin(env, "stat rooted copy source");
  if (!IsRegular(original) || IsStage(original))
    return Throw(env, "EINVAL", "copy source is not a regular file");
  Handle parent = OpenDirectory(*root, target_parts, target_parts.size() - 1, &error, true);
  if (!parent) return ThrowWin(env, "open rooted copy target", error);
  Identity parent_id{};
  if (!QueryIdentity(parent.h, &parent_id)) return ThrowWin(env, "stat rooted copy target", error);
  std::shared_ptr<Stage> private_stage = StageForVolume(*root, parent_id, &error);
  if (!private_stage) return ThrowWin(env, "select private stage for target volume", error);
  if (!VerifyPinnedStagePath(*private_stage, &error)) return ThrowWin(env, "verify private stage directory", error);
  std::wstring name; Handle temporary;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) return Throw(env, "EIO", "generate private stage name");
    temporary = OpenAt(private_stage->handle.h, name,
      DELETE | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | WRITE_OWNER | SYNCHRONIZE,
      FILE_CREATE, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT, &error,
      FILE_SHARE_READ | FILE_SHARE_WRITE);
    if (temporary || error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) break;
  }
  if (!temporary) return ThrowWin(env, "create private stage file", error);
  bool staged = true;
  auto cleanup = [&]() { if (staged) { temporary.reset(); DeleteStaged(private_stage->handle.h, name); } };
  std::array<uint8_t, 65536> bytes{};
  uint64_t copied = 0;
  while (copied < original.size) {
    DWORD wanted = static_cast<DWORD>(std::min<uint64_t>(bytes.size(), original.size - copied));
    DWORD got = 0;
    if (!ReadFile(source.h, bytes.data(), wanted, &got, nullptr)) {
      error = GetLastError(); cleanup(); return ThrowWin(env, "read rooted copy source", error);
    }
    if (!got) { cleanup(); return Throw(env, "FILE_SOURCE_CHANGED", "short copy source read"); }
    if (!WriteAll(temporary.h, bytes.data(), got, &error)) {
      cleanup(); return ThrowWin(env, "write private stage", error);
    }
    copied += got;
  }
  Identity after{}, staged_id{};
  if (!QueryIdentity(source.h, &after) || !SameSource(original, after)) {
    cleanup(); return Throw(env, "FILE_SOURCE_CHANGED", "copy source identity changed");
  }
  if (!FlushFileBuffers(temporary.h)) { error = GetLastError(); cleanup(); return ThrowWin(env, "flush private stage", error); }
  if (!QueryIdentity(temporary.h, &staged_id) || !IsRegular(staged_id) ||
      !VerifyStageName(*private_stage, name, staged_id, &error)) {
    if (!error) error = GetLastError();
    cleanup(); return ThrowWin(env, "verify private stage file", error);
  }
  if (!VerifyPinnedStagePath(*private_stage, &error)) {
    cleanup(); return ThrowWin(env, "verify private stage directory", error);
  }
  if (!RenameHeld(temporary.h, parent.h, target_parts.back(), false, &error)) {
    cleanup(); return ThrowWin(env, "commit copied file", error);
  }
  staged = false;
  return Undefined(env);
}

void Cleanup(void*) {
  std::lock_guard<std::mutex> lock(state_mutex);
  sources.clear(); roots.clear(); quarantines.clear(); stage.reset(); stages.clear();
}
napi_value Init(napi_env env, napi_value exports) {
  struct Method { const char* name; napi_callback callback; } methods[] = {
    {"openRoot", OpenRoot}, {"closeRoot", CloseRoot}, {"stat", Stat}, {"list", List},
    {"mkdirs", Mkdirs}, {"write", Write}, {"openSource", OpenSource},
    {"openStageSource", OpenStageSource},
    {"readSource", ReadSource}, {"statSource", StatSource}, {"closeSource", CloseSource},
    {"configureStage", ConfigureStage}, {"atomicWrite", AtomicWrite},
    {"writeExpected", WriteExpected}, {"setMode", SetMode},
    {"renameNoReplace", RenameNoReplace}, {"moveToStage", MoveToStage},
    {"beginQuarantine", BeginQuarantine}, {"rollbackQuarantine", RollbackQuarantine},
    {"finishQuarantine", FinishQuarantine},
    {"copyFileNoReplace", CopyFileNoReplace},
  };
  for (const auto& method : methods) {
    napi_value fn;
    napi_create_function(env, method.name, NAPI_AUTO_LENGTH, method.callback, nullptr, &fn);
    napi_set_named_property(env, exports, method.name, fn);
  }
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
